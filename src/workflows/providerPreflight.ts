import path from "node:path";
import type { Locator, Page } from "playwright";
import { safePathSegment, updateStatus, type BrowserChoice } from "./shared.js";

export type WebProvider = "google" | "naver" | "generic";
export type ProviderLoginStatus = "already_authenticated" | "completed" | "not_required";

export interface ProviderPreflightOptions {
  provider: WebProvider;
  targetUrl: string;
  statusFile?: string;
  redactTargetUrl?: boolean;
  timeoutMs: number;
  loginTimeoutMs: number;
  headless: boolean;
}

export interface ProviderPreflightResult {
  provider: WebProvider;
  homeUrl: string;
  targetUrl: string;
  loginStatus: ProviderLoginStatus;
}

type KnownProvider = Exclude<WebProvider, "generic">;
type ProviderHomeLoginState = "authenticated" | "anonymous";

const GOOGLE_HOME = "https://www.google.com/?hl=ko";
const NAVER_HOME = "https://www.naver.com/";

const GOOGLE_ACCOUNT_TARGETS = [
  'a[aria-label*="Google 계정"]',
  'a[aria-label*="Google Account"]',
  'button[aria-label*="Google 계정"]',
  'button[aria-label*="Google Account"]',
  'a[href*="SignOutOptions"]'
].join(", ");

const NAVER_ACCOUNT_TARGETS = [
  'a[href*="nidlogin.logout"]',
  'a[class*="link_logout"]',
  '[class*="link_profile"]',
  '[class*="my_info"]'
].join(", ");

export async function runProviderPreflight(page: Page, options: ProviderPreflightOptions): Promise<ProviderPreflightResult> {
  const targetUrl = validateHttpUrl(options.targetUrl);
  const statusTargetUrl = targetUrlForStatus(options, targetUrl);
  const homeUrl = providerHomeUrl(options.provider, targetUrl);

  await writePreflightStatus(options, "provider_home_preflight", "Visiting the provider home before opening the target service.", {
    provider: options.provider,
    homeUrl,
    targetUrl: statusTargetUrl
  });
  await navigate(page, homeUrl, options.timeoutMs);

  let loginStatus: ProviderLoginStatus = "not_required";
  if (options.provider !== "generic") {
    const provider = options.provider;
    const state = await inspectProviderHomeLoginState(page, provider);
    if (state === "authenticated") {
      loginStatus = "already_authenticated";
    }
  }

  await writePreflightStatus(options, "provider_home_ready", "Provider home preflight completed; opening the target before requesting login.", {
    provider: options.provider,
    homeUrl,
    targetUrl: statusTargetUrl,
    loginStatus
  });
  await navigate(page, targetUrl, options.timeoutMs);

  if (options.provider !== "generic") {
    const provider = options.provider;
    if (isProviderLoginUrl(page.url(), provider)) {
      await waitForLoginFromCurrentPage(page, options, provider);
      loginStatus = "completed";
      await navigate(page, targetUrl, options.timeoutMs);
    }
  }

  const targetMessage =
    loginStatus === "completed"
      ? "Target opened after provider login completed."
      : loginStatus === "already_authenticated"
        ? "Target opened with the existing provider session."
        : "Target opened without requiring provider login.";
  await writePreflightStatus(options, "provider_target_ready", targetMessage, {
    provider: options.provider,
    homeUrl,
    targetUrl: statusTargetUrl,
    loginStatus
  });

  return {
    provider: options.provider,
    homeUrl,
    targetUrl,
    loginStatus
  };
}

export function inferWebProvider(value: string): WebProvider {
  const url = new URL(validateHttpUrl(value));
  const hostname = url.hostname.toLowerCase();
  if (hostname === "forms.new" || hostname === "google.com" || hostname.endsWith(".google.com")) {
    return "google";
  }
  if (hostname === "naver.com" || hostname.endsWith(".naver.com") || hostname === "naver.me" || hostname.endsWith(".naver.me")) {
    return "naver";
  }
  return "generic";
}

export function providerHomeUrl(provider: WebProvider, targetUrl: string): string {
  if (provider === "google") {
    return GOOGLE_HOME;
  }
  if (provider === "naver") {
    return NAVER_HOME;
  }
  const target = new URL(validateHttpUrl(targetUrl));
  return `${target.protocol}//${target.host}/`;
}

export function providerAgentProfileDir(provider: WebProvider, browser: BrowserChoice, targetUrl: string): string {
  const suffix = browser === "edge" ? "edge" : browser === "chromium" ? "chromium" : "chrome";
  if (provider === "google") {
    return path.resolve(`.browser-profiles/google-generic-${suffix}`);
  }
  if (provider === "naver") {
    return path.resolve(`.browser-profiles/naver-generic-${suffix}`);
  }
  const hostname = new URL(validateHttpUrl(targetUrl)).hostname.toLowerCase();
  return path.resolve(`.browser-profiles/generic-${safePathSegment(hostname)}-${suffix}`);
}

export function isProviderLoginUrl(value: string, provider: KnownProvider): boolean {
  let hostname: string;
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (provider === "google") {
    return hostname === "accounts.google.com" || hostname.endsWith(".accounts.google.com");
  }
  return hostname === "nid.naver.com" || hostname.endsWith(".nid.naver.com") || hostname === "login.naver.com";
}

async function inspectProviderHomeLoginState(page: Page, provider: KnownProvider): Promise<ProviderHomeLoginState> {
  const accountTargets = provider === "google" ? GOOGLE_ACCOUNT_TARGETS : NAVER_ACCOUNT_TARGETS;
  if (await hasVisible(page.locator(accountTargets))) {
    return "authenticated";
  }

  return "anonymous";
}

async function waitForLoginFromCurrentPage(
  page: Page,
  options: ProviderPreflightOptions,
  provider: KnownProvider
): Promise<void> {
  if (options.headless) {
    await writePreflightStatus(options, "blocked_provider_login", "The target service requires login in a headful browser.", {
      provider,
      targetUrl: targetUrlForStatus(options),
      url: page.url()
    });
    throw new Error(`${provider} login is required. Rerun with --headful and log in directly in the browser window.`);
  }

  await writePreflightStatus(options, waitingStatus(provider), "The target service requires login. Complete it in the opened browser window.", {
      provider,
      targetUrl: targetUrlForStatus(options),
    url: page.url()
  });
  console.log(`${provider} login is required. Complete login in the opened browser window.`);
  console.log("Do not paste passwords, OTPs, or recovery codes into chat or the terminal.");
  await waitUntilProviderLoginLeaves(page, provider, options.loginTimeoutMs);
}

async function waitUntilProviderLoginLeaves(page: Page, provider: KnownProvider, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (providerName) => {
      const hostname = location.hostname.toLowerCase();
      if (providerName === "google") {
        return hostname !== "accounts.google.com" && !hostname.endsWith(".accounts.google.com");
      }
      return hostname !== "nid.naver.com" && !hostname.endsWith(".nid.naver.com") && hostname !== "login.naver.com";
    },
    provider,
    { timeout: timeoutMs }
  );
}

async function navigate(page: Page, url: string, timeoutMs: number): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(timeoutMs, 90000) });
  await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 10000) }).catch(() => undefined);
}

async function hasVisible(locator: Locator): Promise<boolean> {
  const count = Math.min(await locator.count().catch(() => 0), 12);
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible({ timeout: 500 }).catch(() => false)) {
      return true;
    }
  }
  return false;
}

function waitingStatus(provider: KnownProvider): string {
  return provider === "google" ? "waiting_for_google_login" : "waiting_for_naver_login";
}

function targetUrlForStatus(options: ProviderPreflightOptions, value = options.targetUrl): string {
  const target = new URL(validateHttpUrl(value));
  return options.redactTargetUrl ? `${target.origin}${target.pathname}` : target.toString();
}

async function writePreflightStatus(
  options: ProviderPreflightOptions,
  status: string,
  message: string,
  extra: Record<string, unknown>
): Promise<void> {
  if (!options.statusFile) {
    return;
  }
  await updateStatus(options.statusFile, status, message, extra);
}

function validateHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Provider preflight supports only http and https URLs.");
  }
  return url.toString();
}
