import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import {
  browserChannel,
  googleReadOnlyProfileDir,
  installPageEvaluateRuntime,
  naverReadOnlyProfileDir,
  numberValue,
  parseBrowser,
  parseFlagArgs,
  siblingOutputFile,
  stringValue,
  updateStatus,
  type BrowserChoice
} from "./shared.js";
import { runProviderPreflight } from "./providerPreflight.js";

interface WorkflowArgs {
  url: string;
  browser: BrowserChoice;
  headless: boolean;
  timeoutMs: number;
  loginTimeoutMs: number;
  statusFile: string;
  outputFile: string;
  screenshotFile: string;
  selector?: string;
  textLimit: number;
  linkLimit: number;
  profileProvider: "google" | "naver";
}

export interface WebExtractOutput {
  schemaVersion: 1;
  url: string;
  title: string;
  visibleText: string;
  headings: Array<{ level: number; text: string }>;
  links: Array<{ text: string; href: string }>;
  extractedAt: string;
}

const DEFAULT_STATUS_FILE = "work/web-extract-status.json";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();

  await updateStatus(args.statusFile, "starting", "Launching web extraction workflow.", {
    url: args.url,
    outputFile: args.outputFile
  });

  const context = await chromium.launchPersistentContext(extractionProfileDir(args.profileProvider, args.browser), {
    channel: browserChannel(args.browser),
    headless: args.headless,
    chromiumSandbox: true,
    locale: "ko-KR",
    viewport: { width: 1360, height: 920 },
    acceptDownloads: true
  });
  await installPageEvaluateRuntime(context);
  context.setDefaultTimeout(args.timeoutMs);
  context.setDefaultNavigationTimeout(Math.max(args.timeoutMs, 90000));

  const page = context.pages()[0] || (await context.newPage());
  try {
    await runProviderPreflight(page, {
      provider: args.profileProvider,
      targetUrl: args.url,
      statusFile: args.statusFile,
      timeoutMs: args.timeoutMs,
      loginTimeoutMs: args.loginTimeoutMs,
      headless: args.headless
    });
    await page.waitForLoadState("networkidle", { timeout: Math.min(args.timeoutMs, 30000) }).catch(() => undefined);

    const output = await extractPage(page, args);
    await mkdir(path.dirname(path.resolve(args.outputFile)), { recursive: true });
    await writeFile(args.outputFile, JSON.stringify(output, null, 2), "utf8");
    await page.screenshot({ path: args.screenshotFile, fullPage: true }).catch(() => undefined);

    await updateStatus(args.statusFile, "completed", "Web page content was extracted.", {
      url: output.url,
      title: output.title,
      outputFile: args.outputFile,
      screenshotFile: args.screenshotFile,
      linkCount: output.links.length,
      headingCount: output.headings.length,
      profileProvider: args.profileProvider,
      elapsedMs: Date.now() - started
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await page.screenshot({ path: args.screenshotFile, fullPage: true }).catch(() => undefined);
    await updateStatus(args.statusFile, "failed", message, {
      url: page.url(),
      outputFile: args.outputFile,
      screenshotFile: args.screenshotFile,
      elapsedMs: Date.now() - started
    });
    throw error;
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function extractPage(page: Page, args: WorkflowArgs): Promise<WebExtractOutput> {
  const raw = await page.evaluate(
    ({ selector, textLimit, linkLimit }) => {
      const compact = (value: string): string => value.replace(/\s+/g, " ").trim();
      const root = selector ? document.querySelector(selector) : document.body;
      const textRoot = root || document.body;
      const visibleText = compact((textRoot as HTMLElement).innerText || textRoot.textContent || "").slice(0, textLimit);
      const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
        .map((heading) => ({
          level: Number(heading.tagName.slice(1)),
          text: compact(heading.textContent || "")
        }))
        .filter((heading) => heading.text)
        .slice(0, 50);
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
        .map((anchor) => ({
          text: compact(anchor.innerText || anchor.textContent || ""),
          href: anchor.href
        }))
        .filter((link) => link.text || link.href)
        .slice(0, linkLimit);
      return {
        url: location.href,
        title: document.title || "",
        visibleText,
        headings,
        links
      };
    },
    { selector: args.selector, textLimit: args.textLimit, linkLimit: args.linkLimit }
  );

  return buildExtractOutput(raw);
}

export function buildExtractOutput(input: Omit<WebExtractOutput, "schemaVersion" | "extractedAt">): WebExtractOutput {
  return {
    schemaVersion: 1,
    url: input.url,
    title: input.title,
    visibleText: input.visibleText,
    headings: input.headings,
    links: input.links,
    extractedAt: new Date().toISOString()
  };
}

function parseArgs(argv: string[]): WorkflowArgs {
  const values = parseFlagArgs(argv);
  const url = stringValue(values, "url");
  if (!url) {
    throw new Error("Usage: npm run workflow:web-extract -- --url <url> [--selector main] [--output-file work/extract.json]");
  }

  const statusFile = stringValue(values, "status-file") || DEFAULT_STATUS_FILE;
  return {
    url,
    browser: parseBrowser(stringValue(values, "browser")),
    headless: values.get("headless") === true && values.get("headful") !== true,
    timeoutMs: numberValue(values, "timeout-ms", 30000),
    loginTimeoutMs: numberValue(values, "login-timeout-ms", 600000),
    statusFile,
    outputFile: stringValue(values, "output-file") || siblingOutputFile(statusFile, "-output.json"),
    screenshotFile: stringValue(values, "screenshot-file") || siblingOutputFile(statusFile, "-screenshot.png"),
    selector: stringValue(values, "selector"),
    textLimit: numberValue(values, "text-limit", 12000),
    linkLimit: numberValue(values, "link-limit", 100),
    profileProvider: parseProfileProvider(stringValue(values, "profile-provider"))
  };
}

function parseProfileProvider(value?: string): "google" | "naver" {
  const normalized = value?.trim().toLowerCase() || "google";
  if (normalized === "google" || normalized === "naver") return normalized;
  throw new Error("--profile-provider must be google or naver.");
}

function extractionProfileDir(provider: "google" | "naver", browser: BrowserChoice): string {
  return provider === "google" ? googleReadOnlyProfileDir(browser) : naverReadOnlyProfileDir(browser);
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
}
