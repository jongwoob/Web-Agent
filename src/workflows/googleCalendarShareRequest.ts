import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import {
  browserChannel,
  clearConfirmationFile,
  googleProfileDir,
  installPageEvaluateRuntime,
  numberValue,
  parseBrowser,
  parseFlagArgs,
  siblingOutputFile,
  stringValue,
  updateStatus,
  waitForFileConfirmation,
  type BrowserChoice
} from "./shared.js";
import { runProviderPreflight } from "./providerPreflight.js";

interface WorkflowArgs {
  shareLinkSourceFile: string;
  requesterName: string;
  browser: BrowserChoice;
  headless: boolean;
  timeoutMs: number;
  loginTimeoutMs: number;
  statusFile: string;
  inspectFile: string;
  shareAfterConfirm: boolean;
  confirmFile: string;
}

export interface GoogleCalendarShareTarget {
  url: URL;
  recipient: string;
}

export interface GoogleCalendarShareInspection {
  requesterName: string;
  recipientVerified: boolean;
  selectedPermission: string | null;
  availablePermissions: string[];
  visibleActionLabels: string[];
  finalActionLabel: string | null;
  finalActionCount: number;
  pageTitle: string;
}

const DEFAULT_STATUS_FILE = "work/google-calendar-share-request-status.json";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const source = JSON.parse(await readFile(args.shareLinkSourceFile, "utf8")) as unknown;
  const target = extractGoogleCalendarShareTarget(source);
  const started = Date.now();

  await updateStatus(args.statusFile, "starting", "Preparing Google Calendar sharing request.", {
    requesterName: args.requesterName,
    sourceFile: args.shareLinkSourceFile,
    targetHost: target.url.hostname,
    inspectFile: args.inspectFile
  });

  const context = await chromium.launchPersistentContext(googleProfileDir("calendar", args.browser), {
    channel: browserChannel(args.browser),
    headless: args.headless,
    chromiumSandbox: true,
    locale: "ko-KR",
    viewport: { width: 1360, height: 920 }
  });
  await installPageEvaluateRuntime(context);
  context.setDefaultTimeout(args.timeoutMs);
  context.setDefaultNavigationTimeout(Math.max(args.timeoutMs, 90000));

  const page = context.pages()[0] || (await context.newPage());
  try {
    await runProviderPreflight(page, {
      provider: "google",
      targetUrl: target.url.toString(),
      statusFile: args.statusFile,
      redactTargetUrl: true,
      timeoutMs: args.timeoutMs,
      loginTimeoutMs: args.loginTimeoutMs,
      headless: args.headless
    });
    await page.waitForLoadState("networkidle", { timeout: Math.min(args.timeoutMs, 30000) }).catch(() => undefined);

    const inspection = await inspectGoogleCalendarShareScreen(page, target.recipient, args.requesterName);
    await writeJson(args.inspectFile, inspection);
    if (!inspection.recipientVerified) {
      throw new Error("Google Calendar did not show the expected sharing recipient.");
    }
    if (!inspection.selectedPermission) {
      throw new Error("Google Calendar did not expose a selected sharing permission.");
    }
    if (!inspection.finalActionLabel || inspection.finalActionCount !== 1) {
      throw new Error("Google Calendar did not expose exactly one final share action.");
    }

    if (!args.shareAfterConfirm) {
      await updateStatus(args.statusFile, "prepared", "Calendar sharing is prepared; the final action was not clicked.", {
        requesterName: args.requesterName,
        recipientVerified: inspection.recipientVerified,
        selectedPermission: inspection.selectedPermission,
        availablePermissions: inspection.availablePermissions,
        finalActionLabel: inspection.finalActionLabel,
        inspectFile: args.inspectFile,
        elapsedMs: Date.now() - started
      });
      return;
    }

    const confirmFile = await clearConfirmationFile(args.confirmFile);
    await updateStatus(args.statusFile, "waiting_for_share_confirmation", "The final calendar sharing action is ready. Waiting for explicit approval.", {
      requesterName: args.requesterName,
      recipientVerified: inspection.recipientVerified,
      selectedPermission: inspection.selectedPermission,
      finalActionLabel: inspection.finalActionLabel,
      confirmFile,
      inspectFile: args.inspectFile,
      elapsedMs: Date.now() - started
    });

    const approved = await waitForFileConfirmation(args.confirmFile, "share this Google Calendar access");
    if (!approved) {
      await updateStatus(args.statusFile, "canceled", "Calendar sharing was canceled; the final action was not clicked.", {
        requesterName: args.requesterName,
        selectedPermission: inspection.selectedPermission,
        inspectFile: args.inspectFile,
        elapsedMs: Date.now() - started
      });
      return;
    }

    await clickFinalShareAction(page);
    await verifyCalendarShare(page, target.recipient, args.timeoutMs);
    await updateStatus(args.statusFile, "shared", "Google Calendar sharing was completed after approval.", {
      requesterName: args.requesterName,
      selectedPermission: inspection.selectedPermission,
      inspectFile: args.inspectFile,
      elapsedMs: Date.now() - started
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateStatus(args.statusFile, "failed", message, {
      requesterName: args.requesterName,
      inspectFile: args.inspectFile,
      elapsedMs: Date.now() - started
    });
    throw error;
  } finally {
    await context.close().catch(() => undefined);
  }
}

export function extractGoogleCalendarShareTarget(value: unknown): GoogleCalendarShareTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Calendar share link source must be an object.");
  }
  const links = (value as { links?: unknown }).links;
  if (!Array.isArray(links)) {
    throw new Error("Calendar share link source must contain a links array.");
  }

  const matches: GoogleCalendarShareTarget[] = [];
  for (const entry of links) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const href = (entry as { href?: unknown }).href;
    if (typeof href !== "string") continue;
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    const recipient = url.searchParams.get("share") || "";
    if (
      url.protocol === "https:" &&
      url.hostname === "calendar.google.com" &&
      url.pathname === "/calendar/render" &&
      isEmailAddress(recipient)
    ) {
      matches.push({ url, recipient: recipient.toLowerCase() });
    }
  }

  if (matches.length !== 1) {
    throw new Error("Expected exactly one verified Google Calendar sharing link.");
  }
  return matches[0];
}

async function inspectGoogleCalendarShareScreen(
  page: Page,
  recipient: string,
  requesterName: string
): Promise<GoogleCalendarShareInspection> {
  return page.evaluate(
    ({ expectedRecipient, safeRequesterName }) => {
      const clean = (value: string): string => value.replace(/\s+/g, " ").trim();
      const visible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const canonicalPermission = (value: string): string | null => {
        if (/\uD55C\uAC00\uD568.*\uBC14\uC068|free.?busy/i.test(value)) return "한가함/바쁨만 보기";
        if (/\uC77C\uC815.*\uC138\uBD80|event details/i.test(value)) return "일정 세부정보 보기";
        if (/\uBCC0\uACBD.*\uACF5\uC720|manage sharing/i.test(value)) return "변경 및 공유 관리";
        if (/\uC77C\uC815.*\uBCC0\uACBD|make changes/i.test(value)) return "일정 변경";
        return null;
      };
      const isFinalAction = (value: string): boolean => /^(\uACF5\uC720|\uBCF4\uB0B4\uAE30|\uC800\uC7A5|\uC644\uB8CC|Share|Send|Save|Done)$/i.test(value);
      const bodyText = document.body.innerText || "";
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(visible);
      const actionRoot = dialogs.at(-1) || document.body;
      const visibleActionLabels = Array.from(actionRoot.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"]'))
        .filter(visible)
        .map((element) => clean(element.getAttribute("aria-label") || element.innerText || (element as HTMLInputElement).value || ""))
        .filter((label) => /^(\uACF5\uC720|\uBCF4\uB0B4\uAE30|\uC800\uC7A5|\uC644\uB8CC|\uD655\uC778|\uCDE8\uC18C|\uB2EB\uAE30|Share|Send|Save|Done|Confirm|Cancel|Close)$/i.test(label));
      const actions = visibleActionLabels.filter(isFinalAction);
      const permissionTexts = Array.from(
        actionRoot.querySelectorAll<HTMLElement>('select, [role="combobox"], [role="radio"][aria-checked="true"], [aria-label]')
      )
        .filter(visible)
        .flatMap((element) => {
          const values = [
            element.getAttribute("aria-label") || "",
            element.innerText || "",
            element.textContent || "",
            element instanceof HTMLSelectElement ? element.selectedOptions[0]?.textContent || "" : ""
          ];
          return values.map(clean).map(canonicalPermission).filter((value): value is string => Boolean(value));
        });
      const uniquePermissions = [...new Set(permissionTexts)];
      const selected = uniquePermissions[0] || null;

      return {
        requesterName: safeRequesterName,
        recipientVerified: bodyText.toLowerCase().includes(expectedRecipient.toLowerCase()),
        selectedPermission: selected,
        availablePermissions: uniquePermissions,
        visibleActionLabels,
        finalActionLabel: actions.length === 1 ? actions[0] : null,
        finalActionCount: actions.length,
        pageTitle: document.title || ""
      };
    },
    { expectedRecipient: recipient, safeRequesterName: requesterName }
  );
}

async function clickFinalShareAction(page: Page): Promise<void> {
  const selector = await page.evaluate(() => {
    const clean = (value: string): string => value.replace(/\s+/g, " ").trim();
    const isFinalAction = (value: string): boolean => /^(\uACF5\uC720|\uBCF4\uB0B4\uAE30|\uC800\uC7A5|\uC644\uB8CC|Share|Send|Save|Done)$/i.test(value);
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(visible);
    const root = dialogs.at(-1) || document.body;
    const matches = Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"]')).filter((element) => {
      if (!visible(element)) return false;
      const label = clean(element.getAttribute("aria-label") || element.innerText || (element as HTMLInputElement).value || "");
      return isFinalAction(label);
    });
    if (matches.length !== 1) return null;
    matches[0].setAttribute("data-agent-final-calendar-share", "true");
    return '[data-agent-final-calendar-share="true"]';
  });
  if (!selector) {
    throw new Error("Google Calendar final share action changed before approval.");
  }
  await page.locator(selector).click();
}

async function verifyCalendarShare(page: Page, recipient: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.min(timeoutMs, 15000);
  while (Date.now() < deadline) {
    const verified = await page.evaluate((expectedRecipient) => {
      const clean = (value: string): string => value.replace(/\s+/g, " ").trim();
      const isFinalAction = (value: string): boolean => /^(\uACF5\uC720|\uBCF4\uB0B4\uAE30|\uC800\uC7A5|\uC644\uB8CC|Share|Send|Save|Done)$/i.test(value);
      const visible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const bodyText = document.body.innerText || "";
      const successMessage = /\uACF5\uC720\uB428|\uACF5\uC720\uB418\uC5C8|\uBCF4\uB0C8\uC2B5\uB2C8\uB2E4|Shared|Invitation sent/i.test(bodyText);
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(visible);
      const root = dialogs.at(-1) || document.body;
      const finalActionExists = Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"]')).some((element) => {
        if (!visible(element)) return false;
        const label = clean(element.getAttribute("aria-label") || element.innerText || (element as HTMLInputElement).value || "");
        return isFinalAction(label);
      });
      return successMessage || (!finalActionExists && bodyText.toLowerCase().includes(expectedRecipient.toLowerCase()));
    }, recipient);
    if (verified) return;
    await page.waitForTimeout(250);
  }
  throw new Error("Google Calendar share action was clicked, but completion could not be verified.");
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function isFinalCalendarShareActionLabel(value: string): boolean {
  return /^(\uACF5\uC720|\uBCF4\uB0B4\uAE30|\uC800\uC7A5|\uC644\uB8CC|Share|Send|Save|Done)$/i.test(value.trim());
}

function parseArgs(argv: string[]): WorkflowArgs {
  const values = parseFlagArgs(argv);
  const shareLinkSourceFile = stringValue(values, "share-link-source-file");
  const requesterName = stringValue(values, "requester-name");
  if (!shareLinkSourceFile || !requesterName) {
    throw new Error("Usage: --share-link-source-file <web-extract-json> --requester-name <name> [--share-after-confirm]");
  }

  const statusFile = stringValue(values, "status-file") || DEFAULT_STATUS_FILE;
  return {
    shareLinkSourceFile,
    requesterName,
    browser: parseBrowser(stringValue(values, "browser")),
    headless: values.get("headless") === true && values.get("headful") !== true,
    timeoutMs: numberValue(values, "timeout-ms", 30000),
    loginTimeoutMs: numberValue(values, "login-timeout-ms", 600000),
    statusFile,
    inspectFile: stringValue(values, "inspect-file") || siblingOutputFile(statusFile, "-inspect.json"),
    shareAfterConfirm: values.get("share-after-confirm") === true,
    confirmFile: stringValue(values, "confirm-file") || "work/google-calendar-share-request-confirm.txt"
  };
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
