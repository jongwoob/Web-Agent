import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import {
  browserChannel,
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
  sheetUrl: string;
  browser: BrowserChoice;
  headless: boolean;
  timeoutMs: number;
  loginTimeoutMs: number;
  statusFile: string;
  screenshotFile: string;
  outputFile?: string;
}

export interface GoogleSheetReference {
  spreadsheetId: string;
  gid?: string;
}

const DEFAULT_STATUS_FILE = "work/google-sheets-export-csv-status.json";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ref = parseGoogleSheetUrl(args.sheetUrl);
  const exportUrl = buildCsvExportUrl(ref);
  const outputFile =
    args.outputFile || path.join("work", "downloads", `google-sheet-${safePathSegment(ref.spreadsheetId)}-${safePathSegment(ref.gid || "default")}.csv`);
  const started = Date.now();

  await mkdir(path.dirname(path.resolve(outputFile)), { recursive: true });
  await updateStatus(args.statusFile, "starting", "Launching Google Sheets CSV export workflow.", {
    sheetUrl: args.sheetUrl,
    spreadsheetId: ref.spreadsheetId,
    gid: ref.gid,
    exportUrl,
    outputFile
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
      targetUrl: args.sheetUrl,
      statusFile: args.statusFile,
      timeoutMs: args.timeoutMs,
      loginTimeoutMs: args.loginTimeoutMs,
      headless: args.headless
    });
    await page.waitForLoadState("networkidle", { timeout: Math.min(args.timeoutMs, 30000) }).catch(() => undefined);

    await updateStatus(args.statusFile, "downloading", "Starting CSV download from Google Sheets.", {
      url: page.url(),
      exportUrl,
      outputFile
    });

    const download = await startDownload(page, exportUrl, args.timeoutMs);
    await download.saveAs(outputFile);
    await page.screenshot({ path: args.screenshotFile, fullPage: true }).catch(() => undefined);

    await updateStatus(args.statusFile, "completed", "Google Sheet CSV was downloaded.", {
      spreadsheetId: ref.spreadsheetId,
      gid: ref.gid,
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
      outputFile,
      screenshotFile: args.screenshotFile,
      elapsedMs: Date.now() - started
    });
    throw error;
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function startDownload(page: Page, url: string, timeoutMs: number) {
  const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/download|ERR_ABORTED/i.test(message)) {
      throw error;
    }
  });
  return downloadPromise;
}

export function parseGoogleSheetUrl(value: string): GoogleSheetReference {
  const url = new URL(value);
  const pathMatch = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/i);
  const spreadsheetId = pathMatch?.[1] || url.searchParams.get("id") || undefined;
  if (!spreadsheetId) {
    throw new Error(`Could not find a Google Sheets spreadsheet id in URL: ${value}`);
  }

  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  const gid = url.searchParams.get("gid") || hashParams.get("gid") || undefined;
  return { spreadsheetId, gid };
}

export function buildCsvExportUrl(ref: GoogleSheetReference): string {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(ref.spreadsheetId)}/export`);
  url.searchParams.set("format", "csv");
  if (ref.gid) {
    url.searchParams.set("gid", ref.gid);
  }
  return url.toString();
}

function parseArgs(argv: string[]): WorkflowArgs {
  const values = parseFlagArgs(argv);
  const sheetUrl = stringValue(values, "sheet-url") || stringValue(values, "url");
  if (!sheetUrl) {
    throw new Error("Usage: npm run workflow:google-sheets-export-csv -- --sheet-url <google-sheet-url> [--output-file work/downloads/file.csv]");
  }

  const statusFile = stringValue(values, "status-file") || DEFAULT_STATUS_FILE;
  return {
    sheetUrl,
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
