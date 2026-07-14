import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, type Download, type Locator, type Page } from "playwright";
import {
  browserChannel,
  ensureGoogleLogin,
  googleReadOnlyProfileDir,
  numberValue,
  parseBrowser,
  parseFlagArgs,
  safePathSegment,
  siblingOutputFile,
  stringValue,
  updateStatus,
  type BrowserChoice
} from "./shared.js";
import { runProviderPreflight } from "./providerPreflight.js";

interface WorkflowArgs {
  fileUrl: string;
  browser: BrowserChoice;
  headless: boolean;
  timeoutMs: number;
  loginTimeoutMs: number;
  statusFile: string;
  screenshotFile: string;
  outputFile?: string;
}

export interface GoogleDriveFileReference {
  fileId: string;
}

const DEFAULT_STATUS_FILE = "work/google-drive-download-status.json";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ref = parseGoogleDriveFileUrl(args.fileUrl);
  const downloadUrl = buildDriveDownloadUrl(ref);
  const started = Date.now();

  await updateStatus(args.statusFile, "starting", "Launching Google Drive download workflow.", {
    fileUrl: args.fileUrl,
    fileId: ref.fileId,
    downloadUrl
  });

  const context = await chromium.launchPersistentContext(googleReadOnlyProfileDir(args.browser), {
    channel: browserChannel(args.browser),
    headless: args.headless,
    chromiumSandbox: true,
    locale: "ko-KR",
    viewport: { width: 1360, height: 920 },
    acceptDownloads: true
  });
  context.setDefaultTimeout(args.timeoutMs);
  context.setDefaultNavigationTimeout(Math.max(args.timeoutMs, 90000));

  const page = context.pages()[0] || (await context.newPage());
  try {
    await runProviderPreflight(page, {
      provider: "google",
      targetUrl: args.fileUrl,
      statusFile: args.statusFile,
      timeoutMs: args.timeoutMs,
      loginTimeoutMs: args.loginTimeoutMs,
      headless: args.headless
    });
    await updateStatus(args.statusFile, "checking_direct_download", "Trying the direct Google Drive download URL before login.", {
      downloadUrl
    });
    let download = await tryDownload(
      page,
      () => page.goto(downloadUrl, { waitUntil: "domcontentloaded", timeout: args.timeoutMs }),
      args.timeoutMs
    );

    if (!download) {
      await page.goto(args.fileUrl, { waitUntil: "domcontentloaded", timeout: Math.max(args.timeoutMs, 90000) });
      await ensureGoogleLogin(page, args);
      await page.waitForLoadState("networkidle", { timeout: Math.min(args.timeoutMs, 30000) }).catch(() => undefined);

      await updateStatus(args.statusFile, "downloading", "Starting authenticated Google Drive download.", {
        url: page.url(),
        downloadUrl
      });
      download = await startDriveDownload(page, downloadUrl, args.timeoutMs);
    }

    const outputFile = args.outputFile || path.join("work", "downloads", `${safePathSegment(ref.fileId)}-${safePathSegment(download.suggestedFilename())}`);
    await mkdir(path.dirname(path.resolve(outputFile)), { recursive: true });
    await download.saveAs(outputFile);
    await page.screenshot({ path: args.screenshotFile, fullPage: true }).catch(() => undefined);

    await updateStatus(args.statusFile, "completed", "Google Drive file was downloaded.", {
      fileId: ref.fileId,
      outputFile,
      suggestedFilename: download.suggestedFilename(),
      screenshotFile: args.screenshotFile,
      elapsedMs: Date.now() - started
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await page.screenshot({ path: args.screenshotFile, fullPage: true }).catch(() => undefined);
    await updateStatus(args.statusFile, "failed", message, {
      url: page.url(),
      fileId: ref.fileId,
      screenshotFile: args.screenshotFile,
      elapsedMs: Date.now() - started
    });
    throw error;
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function startDriveDownload(page: Page, downloadUrl: string, timeoutMs: number): Promise<Download> {
  const direct = await tryDownload(page, () => page.goto(downloadUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs }), timeoutMs);
  if (direct) {
    return direct;
  }

  const clicked = await clickFirst(page, [
    page.getByRole("button", { name: /download|download anyway/i }),
    page.getByRole("link", { name: /download|download anyway/i }),
    page.locator("button,a").filter({ hasText: /download|download anyway/i })
  ]);
  if (!clicked) {
    throw new Error("Drive download did not start and no visible download confirmation was found.");
  }

  const afterClick = await page.waitForEvent("download", { timeout: timeoutMs }).catch(() => null);
  if (!afterClick) {
    throw new Error("Drive download confirmation was clicked, but no download started.");
  }
  return afterClick;
}

async function tryDownload(page: Page, action: () => Promise<unknown>, timeoutMs: number): Promise<Download | null> {
  const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs }).catch(() => null);
  await action().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/download|ERR_ABORTED/i.test(message)) {
      throw error;
    }
  });
  return downloadPromise;
}

async function clickFirst(page: Page, candidates: Locator[]): Promise<boolean> {
  for (const locator of candidates) {
    const candidate = locator.first();
    const visible = await candidate.isVisible({ timeout: 1200 }).catch(() => false);
    if (!visible) {
      continue;
    }
    await candidate.click({ timeout: 3000 }).catch(() => undefined);
    return true;
  }
  return false;
}

export function parseGoogleDriveFileUrl(value: string): GoogleDriveFileReference {
  const url = new URL(value);
  const pathMatch = url.pathname.match(/\/(?:file|document|spreadsheets|presentation|drawings)\/d\/([^/]+)/i);
  const fileId = pathMatch?.[1] || url.searchParams.get("id") || undefined;
  if (!fileId) {
    throw new Error(`Could not find a Google Drive file id in URL: ${value}`);
  }
  return { fileId };
}

export function buildDriveDownloadUrl(ref: GoogleDriveFileReference): string {
  const url = new URL("https://drive.google.com/uc");
  url.searchParams.set("export", "download");
  url.searchParams.set("id", ref.fileId);
  return url.toString();
}

function parseArgs(argv: string[]): WorkflowArgs {
  const values = parseFlagArgs(argv);
  const fileUrl = stringValue(values, "file-url") || stringValue(values, "url");
  if (!fileUrl) {
    throw new Error("Usage: npm run workflow:google-drive-download -- --file-url <google-drive-file-url> [--output-file work/downloads/file]");
  }

  const statusFile = stringValue(values, "status-file") || DEFAULT_STATUS_FILE;
  return {
    fileUrl,
    browser: parseBrowser(stringValue(values, "browser")),
    headless: values.get("headless") === true && values.get("headful") !== true,
    timeoutMs: numberValue(values, "timeout-ms", 30000),
    loginTimeoutMs: numberValue(values, "login-timeout-ms", 600000),
    statusFile,
    screenshotFile: stringValue(values, "screenshot-file") || siblingOutputFile(statusFile, "-screenshot.png"),
    outputFile: stringValue(values, "output-file")
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
