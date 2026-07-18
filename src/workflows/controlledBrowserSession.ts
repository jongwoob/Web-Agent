import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { browserExecutableCandidates } from "./openUserBrowser.js";
import { safePathSegment } from "./shared.js";

export type ControlledBrowserChoice = "chrome" | "edge";

export interface ControlledBrowserSessionDescriptor {
  schemaVersion: 1;
  key: string;
  browser: ControlledBrowserChoice;
  profileDir: string;
  port: number;
  status: "idle" | "busy";
  activeTargetUrl?: string;
  lastPageUrl?: string;
  reservedPageUrl?: string;
  updatedAt: string;
}

export interface ControlledBrowserSessionPaths {
  key: string;
  profileDir: string;
  descriptorFile: string;
}

export interface AcquireControlledBrowserSessionOptions {
  browser: ControlledBrowserChoice;
  targetUrl: string;
  timeoutMs: number;
  rootDir?: string;
}

export interface ControlledBrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  descriptor: ControlledBrowserSessionDescriptor;
  reusedSession: boolean;
  reusedPage: boolean;
  release: (options?: { reserveCurrentPage?: boolean }) => Promise<void>;
}

export function canReuseControlledSession(descriptor: ControlledBrowserSessionDescriptor): boolean {
  return descriptor.status === "idle";
}

export function controlledSessionKey(browser: ControlledBrowserChoice, targetUrl: string): string {
  const hostname = new URL(targetUrl).hostname.toLowerCase();
  return `${safePathSegment(hostname)}-${browser}`;
}

export function controlledSessionPaths(
  browser: ControlledBrowserChoice,
  targetUrl: string,
  rootDir = process.cwd()
): ControlledBrowserSessionPaths {
  const key = controlledSessionKey(browser, targetUrl);
  return {
    key,
    profileDir: path.resolve(rootDir, ".browser-profiles", `controlled-${key}`),
    descriptorFile: path.resolve(rootDir, "work", "browser-sessions", `${key}.json`)
  };
}

export function buildControlledBrowserLaunchArgs(profileDir: string, port: number): string[] {
  return [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ];
}

export function selectReusablePageIndex(pageUrls: string[], targetUrl: string, reservedPageUrl?: string): number {
  const targetOrigin = new URL(targetUrl).origin;
  const matchingOrigin = pageUrls.findIndex((value) => value !== reservedPageUrl && originOf(value) === targetOrigin);
  if (matchingOrigin >= 0) {
    return matchingOrigin;
  }

  return pageUrls.findIndex((value) => value !== reservedPageUrl && value === "about:blank");
}

export async function acquireControlledBrowserSession(
  options: AcquireControlledBrowserSessionOptions
): Promise<ControlledBrowserSession> {
  const paths = controlledSessionPaths(options.browser, options.targetUrl, options.rootDir);
  let descriptor = await readDescriptor(paths.descriptorFile);
  let browser: Browser;
  let reusedSession = false;

  if (descriptor && descriptor.browser === options.browser && (await cdpIsAvailable(descriptor.port))) {
    if (!canReuseControlledSession(descriptor)) {
      throw new Error("같은 사이트의 전용 제어 세션에서 다른 작업이 진행 중입니다.");
    }
    browser = await chromium.connectOverCDP(cdpEndpoint(descriptor.port));
    reusedSession = true;
  } else {
    const port = await findAvailablePort();
    await mkdir(paths.profileDir, { recursive: true });
    await launchDetachedBrowser(options.browser, paths.profileDir, port);
    await waitForCdp(port, options.timeoutMs);
    browser = await chromium.connectOverCDP(cdpEndpoint(port));
    descriptor = {
      schemaVersion: 1,
      key: paths.key,
      browser: options.browser,
      profileDir: paths.profileDir,
      port,
      status: "idle",
      updatedAt: new Date().toISOString()
    };
  }

  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("전용 제어 브라우저 컨텍스트를 찾지 못했습니다.");
  }

  const selected = await selectReusablePage(context, options.targetUrl, descriptor.reservedPageUrl);
  const busyDescriptor: ControlledBrowserSessionDescriptor = {
    ...descriptor,
    status: "busy",
    activeTargetUrl: options.targetUrl,
    updatedAt: new Date().toISOString()
  };
  await writeDescriptor(paths.descriptorFile, busyDescriptor);

  return {
    browser,
    context,
    page: selected.page,
    descriptor: busyDescriptor,
    reusedSession,
    reusedPage: selected.reusedPage,
    release: async (releaseOptions = {}) => {
      const lastPageUrl = selected.page.isClosed() ? undefined : selected.page.url();
      await writeDescriptor(paths.descriptorFile, {
        ...busyDescriptor,
        status: "idle",
        activeTargetUrl: undefined,
        lastPageUrl,
        reservedPageUrl: releaseOptions.reserveCurrentPage ? lastPageUrl : busyDescriptor.reservedPageUrl,
        updatedAt: new Date().toISOString()
      });
    }
  };
}

async function selectReusablePage(
  context: BrowserContext,
  targetUrl: string,
  reservedPageUrl?: string
): Promise<{ page: Page; reusedPage: boolean }> {
  const pages = context.pages().filter((page) => !page.isClosed());
  const index = selectReusablePageIndex(
    pages.map((page) => page.url()),
    targetUrl,
    reservedPageUrl
  );
  if (index >= 0) {
    return { page: pages[index], reusedPage: true };
  }

  return { page: await context.newPage(), reusedPage: false };
}

async function launchDetachedBrowser(browser: ControlledBrowserChoice, profileDir: string, port: number): Promise<void> {
  const executable = browserExecutableCandidates(browser).find(existsSync);
  if (!executable) {
    throw new Error(`전용 제어용 ${browser === "chrome" ? "Chrome" : "Edge"} 실행 파일을 찾지 못했습니다.`);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, buildControlledBrowserLaunchArgs(profileDir, port), {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdpIsAvailable(port)) {
      return;
    }
    await delay(100);
  }
  throw new Error("전용 제어 브라우저에 연결하지 못했습니다.");
}

async function cdpIsAvailable(port: number): Promise<boolean> {
  try {
    const response = await fetch(`${cdpEndpoint(port)}/json/version`, {
      signal: AbortSignal.timeout(750)
    });
    if (!response.ok) {
      return false;
    }
    const payload = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    return typeof payload.webSocketDebuggerUrl === "string";
  } catch {
    return false;
  }
}

async function readDescriptor(file: string): Promise<ControlledBrowserSessionDescriptor | null> {
  const source = await readFile(file, "utf8").catch(() => "");
  if (!source) {
    return null;
  }

  try {
    const value = JSON.parse(source) as Partial<ControlledBrowserSessionDescriptor>;
    if (
      value.schemaVersion !== 1 ||
      (value.browser !== "chrome" && value.browser !== "edge") ||
      typeof value.port !== "number" ||
      typeof value.profileDir !== "string" ||
      typeof value.key !== "string" ||
      (value.status !== "idle" && value.status !== "busy")
    ) {
      return null;
    }
    return value as ControlledBrowserSessionDescriptor;
  } catch {
    return null;
  }
}

async function writeDescriptor(file: string, descriptor: ControlledBrowserSessionDescriptor): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(descriptor, null, 2), "utf8");
}

function cdpEndpoint(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("전용 제어 브라우저 포트를 할당하지 못했습니다.")));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
