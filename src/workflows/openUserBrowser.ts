import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  numberValue,
  parseBrowser,
  parseFlagArgs,
  stringValue,
  updateStatus,
  type BrowserChoice
} from "./shared.js";
import { inferWebProvider, providerHomeUrl, type WebProvider } from "./providerPreflight.js";

export type UserBrowserChoice = Exclude<BrowserChoice, "chromium">;

interface WorkflowArgs {
  url: string;
  browser: UserBrowserChoice;
  preflightWaitMs: number;
  statusFile: string;
}

export interface UserBrowserLaunchPlan {
  browser: UserBrowserChoice;
  provider: WebProvider;
  homeUrl: string;
  targetUrl: string;
  reuseExistingBrowser: boolean;
  homeArgs: string[];
  targetArgs: string[];
}

const DEFAULT_STATUS_FILE = "work/open-user-browser-status.json";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildUserBrowserLaunchPlan(args.url, args.browser);
  const executable = resolveUserBrowserExecutable(args.browser);
  const started = Date.now();

  await updateStatus(args.statusFile, "starting", "일반 사용자 브라우저에서 사전 진입을 시작합니다.", {
    browser: args.browser,
    profile: "regular-user",
    provider: plan.provider,
    homeUrl: plan.homeUrl,
    targetUrl: plan.targetUrl,
    reuseExistingBrowser: plan.reuseExistingBrowser
  });

  await launchVisibleBrowser(executable, plan.homeArgs);
  await delay(args.preflightWaitMs);
  await launchVisibleBrowser(executable, plan.targetArgs);

  await updateStatus(args.statusFile, "completed", "일반 사용자 브라우저에서 대상 페이지를 열었습니다.", {
    browser: args.browser,
    profile: "regular-user",
    provider: plan.provider,
    homeUrl: plan.homeUrl,
    targetUrl: plan.targetUrl,
    reuseExistingBrowser: plan.reuseExistingBrowser,
    elapsedMs: Date.now() - started
  });
}

export function parseUserBrowser(value?: string): UserBrowserChoice {
  const browser = parseBrowser(value);
  if (browser === "chromium") {
    throw new Error("일반 사용자 브라우저 열기에는 chrome 또는 edge만 사용할 수 있습니다.");
  }
  return browser;
}

export function buildUserBrowserLaunchPlan(url: string, browser: UserBrowserChoice): UserBrowserLaunchPlan {
  const targetUrl = validateHttpUrl(url);
  const provider = inferWebProvider(targetUrl);
  const homeUrl = providerHomeUrl(provider, targetUrl);
  return {
    browser,
    provider,
    homeUrl,
    targetUrl,
    reuseExistingBrowser: true,
    homeArgs: [homeUrl],
    targetArgs: [targetUrl]
  };
}

export function browserExecutableCandidates(
  browser: UserBrowserChoice,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = env.LOCALAPPDATA;
  const application = browser === "chrome" ? "Google\\Chrome\\Application\\chrome.exe" : "Microsoft\\Edge\\Application\\msedge.exe";

  return [programFiles, programFilesX86, localAppData]
    .filter((root): root is string => Boolean(root))
    .map((root) => path.join(root, application));
}

export function resolveUserBrowserExecutable(
  browser: UserBrowserChoice,
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = existsSync
): string {
  const executable = browserExecutableCandidates(browser, env).find(exists);
  if (!executable) {
    throw new Error(`일반 사용자 ${browser === "chrome" ? "Chrome" : "Edge"} 실행 파일을 찾지 못했습니다.`);
  }
  return executable;
}

export async function launchVisibleBrowser(executable: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
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

function parseArgs(argv: string[]): WorkflowArgs {
  const values = parseFlagArgs(argv);
  const url = stringValue(values, "url");
  if (!url) {
    throw new Error("Usage: npm run workflow:open-user-browser -- --url <url> [--browser chrome|edge]");
  }

  return {
    url,
    browser: parseUserBrowser(stringValue(values, "browser")),
    preflightWaitMs: numberValue(values, "preflight-wait-ms", 1500),
    statusFile: stringValue(values, "status-file") || DEFAULT_STATUS_FILE
  };
}

function validateHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("일반 사용자 브라우저는 http 또는 https URL만 열 수 있습니다.");
  }
  return url.toString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
