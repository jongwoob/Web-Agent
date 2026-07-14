import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";

export type BrowserChoice = "chromium" | "chrome" | "edge";

export interface GoogleLoginOptions {
  statusFile: string;
  timeoutMs: number;
  loginTimeoutMs: number;
}

export function parseFlagArgs(argv: string[]): Map<string, string | boolean> {
  const values = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const parts: string[] = [];
    while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      parts.push(argv[i + 1]);
      i += 1;
    }
    values.set(key, parts.length ? parts.join(" ") : true);
  }

  return values;
}

export function stringValue(values: Map<string, string | boolean>, key: string): string | undefined {
  const value = values.get(key);
  return typeof value === "string" ? value : undefined;
}

export function numberValue(values: Map<string, string | boolean>, key: string, defaultValue: number): number {
  const value = stringValue(values, key);
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${key} must be a positive number.`);
  }
  return parsed;
}

export function parseBrowser(value?: string): BrowserChoice {
  if (!value) {
    return "chrome";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "chrome" || normalized === "google-chrome") {
    return "chrome";
  }
  if (normalized === "edge" || normalized === "msedge" || normalized === "microsoft-edge") {
    return "edge";
  }
  if (normalized === "chromium") {
    return "chromium";
  }
  throw new Error("--browser must be chromium, chrome, or edge.");
}

export function browserChannel(browser: BrowserChoice): "chrome" | "msedge" | undefined {
  if (browser === "chrome") {
    return "chrome";
  }
  if (browser === "edge") {
    return "msedge";
  }
  return undefined;
}

export function googleProfileDir(kind: string, browser: BrowserChoice): string {
  return path.resolve(`.browser-profiles/google-${kind}-${browserProfileSuffix(browser)}`);
}

// Reuse the user-approved Google Forms session for workflows that only read or download data.
// Account-changing Google workflows keep their service-specific profile selection.
export function googleReadOnlyProfileDir(browser: BrowserChoice): string {
  return googleProfileDir("forms", browser);
}

// Naver Mail is the authenticated Naver session approved for low-frequency read-only work.
export function naverReadOnlyProfileDir(browser: BrowserChoice): string {
  if (browser === "chromium") {
    return path.resolve(".browser-profiles/naver");
  }
  return path.resolve(`.browser-profiles/naver-${browserProfileSuffix(browser)}`);
}

export function siblingOutputFile(statusFile: string, suffix: string): string {
  const parsed = path.parse(statusFile);
  const base = parsed.name.replace(/-status$/, "");
  return path.join(parsed.dir || "work", `${base}${suffix}`);
}

export async function updateStatus(
  file: string,
  status: string,
  message: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const payload = {
    status,
    message,
    updatedAt: new Date().toISOString(),
    ...extra
  };
  await writeFile(file, JSON.stringify(payload, null, 2), "utf8");
  console.log(`${status}: ${message}`);
}

export async function ensureGoogleLogin(page: Page, options: GoogleLoginOptions): Promise<void> {
  if (!/accounts\.google\.com/i.test(page.url())) {
    return;
  }

  await updateStatus(options.statusFile, "waiting_for_google_login", "Google login is required. Please log in in the opened browser window.", {
    url: page.url()
  });
  console.log("Google login page is open. Log in manually in the browser window.");
  console.log("Do not paste passwords, OTPs, or recovery codes into chat or the terminal.");

  await page.waitForFunction(() => !location.hostname.includes("accounts.google.com"), undefined, {
    timeout: options.loginTimeoutMs
  });
  await page.waitForLoadState("domcontentloaded", { timeout: options.timeoutMs }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: Math.min(options.timeoutMs, 30000) }).catch(() => undefined);
}

export function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "download";
}

export async function clearConfirmationFile(file: string): Promise<string> {
  const resolved = path.resolve(file);
  await mkdir(path.dirname(resolved), { recursive: true });
  await rm(resolved, { force: true });
  return resolved;
}

export async function waitForFileConfirmation(file: string, actionLabel: string, pollMs = 1500): Promise<boolean> {
  const resolved = path.resolve(file);
  console.log(`Waiting for confirmation file: ${resolved}`);
  console.log(`Write "yes" to ${actionLabel}, or "no" to cancel.`);

  while (true) {
    const value = await readFile(resolved, "utf8").catch(() => "");
    const normalized = value.trim().toLowerCase();
    if (["yes", "y", "confirm", "approved"].includes(normalized)) {
      return true;
    }
    if (["no", "n", "cancel", "stop"].includes(normalized)) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function installPageEvaluateRuntime(context: BrowserContext): Promise<void> {
  await context.addInitScript({
    content: `
      if (typeof globalThis.__name !== "function") {
        Object.defineProperty(globalThis, "__name", {
          configurable: true,
          value: (target, value) => {
            try { Object.defineProperty(target, "name", { configurable: true, value }); } catch {}
            return target;
          }
        });
      }
    `
  });
}

function browserProfileSuffix(browser: BrowserChoice): "chrome" | "edge" | "chromium" {
  return browser === "edge" ? "edge" : browser === "chromium" ? "chromium" : "chrome";
}
