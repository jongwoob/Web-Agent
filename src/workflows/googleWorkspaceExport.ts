import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, type Download, type Page } from "playwright";
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

export type GoogleWorkspaceKind = "docs" | "slides" | "sheets";

export interface GoogleWorkspaceReference {
  kind: GoogleWorkspaceKind;
  fileId: string;
}

interface WorkflowArgs {
  sourceUrl: string;
  kind: GoogleWorkspaceKind;
  format: string;
  browser: BrowserChoice;
  headless: boolean;
  timeoutMs: number;
  loginTimeoutMs: number;
  statusFile: string;
  screenshotFile: string;
  outputFile?: string;
}

const DEFAULT_FORMATS: Record<GoogleWorkspaceKind, string> = {
  docs: "docx",
  slides: "pptx",
  sheets: "xlsx"
};

const ALLOWED_FORMATS: Record<GoogleWorkspaceKind, readonly string[]> = {
  docs: ["docx", "pdf", "odt", "rtf", "txt", "epub"],
  slides: ["pptx", "pdf"],
  sheets: ["xlsx", "pdf", "ods"]
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ref = parseGoogleWorkspaceUrl(args.sourceUrl, args.kind);
  const exportUrl = buildGoogleWorkspaceExportUrl(ref, args.format);
  const outputFile =
    args.outputFile || path.join("work", "downloads", `google-${ref.kind}-${safePathSegment(ref.fileId)}.${args.format}`);
  const started = Date.now();

  await mkdir(path.dirname(path.resolve(outputFile)), { recursive: true });
  await updateStatus(args.statusFile, "starting", `Launching Google ${ref.kind} export workflow.`, {
    sourceUrl: args.sourceUrl,
    fileId: ref.fileId,
    kind: ref.kind,
    format: args.format,
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
      targetUrl: args.sourceUrl,
      statusFile: args.statusFile,
      timeoutMs: args.timeoutMs,
      loginTimeoutMs: args.loginTimeoutMs,
      headless: args.headless
    });
    await page.waitForLoadState("networkidle", { timeout: Math.min(args.timeoutMs, 30000) }).catch(() => undefined);

    await updateStatus(args.statusFile, "downloading", `Starting Google ${ref.kind} ${args.format} export.`, {
      url: page.url(),
      fileId: ref.fileId,
      kind: ref.kind,
      format: args.format,
      exportUrl,
      outputFile
    });

    const download = await startDownload(page, exportUrl, args.timeoutMs);
    await download.saveAs(outputFile);
    await page.screenshot({ path: args.screenshotFile, fullPage: true }).catch(() => undefined);

    await updateStatus(args.statusFile, "completed", `Google ${ref.kind} file was exported.`, {
      fileId: ref.fileId,
      kind: ref.kind,
      format: args.format,
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
      kind: ref.kind,
      format: args.format,
      outputFile,
      screenshotFile: args.screenshotFile,
      elapsedMs: Date.now() - started
    });
    throw error;
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function startDownload(page: Page, exportUrl: string, timeoutMs: number): Promise<Download> {
  const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs }).catch(() => null);
  await page.goto(exportUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/download|ERR_ABORTED/i.test(message)) {
      throw error;
    }
  });

  const download = await downloadPromise;
  if (!download) {
    throw new Error(`Google ${exportUrl} did not start a download.`);
  }
  return download;
}

export function parseGoogleWorkspaceUrl(value: string, expectedKind?: GoogleWorkspaceKind): GoogleWorkspaceReference {
  const url = new URL(value);
  const match = url.pathname.match(/\/(document|presentation|spreadsheets)\/d\/([^/]+)/i);
  if (!match) {
    throw new Error(`Could not find a native Google Workspace file id in URL: ${value}`);
  }

  const kind = workspaceKindFromPath(match[1]);
  if (expectedKind && kind !== expectedKind) {
    throw new Error(`Expected a Google ${expectedKind} URL, but received a Google ${kind} URL.`);
  }
  return { kind, fileId: match[2] };
}

export function normalizeGoogleWorkspaceFormat(kind: GoogleWorkspaceKind, value?: string): string {
  const format = (value || DEFAULT_FORMATS[kind]).trim().toLowerCase().replace(/^\./, "");
  if (!ALLOWED_FORMATS[kind].includes(format)) {
    throw new Error(`Unsupported Google ${kind} export format "${format}". Allowed: ${ALLOWED_FORMATS[kind].join(", ")}.`);
  }
  return format;
}

export function buildGoogleWorkspaceExportUrl(ref: GoogleWorkspaceReference, requestedFormat?: string): string {
  const format = normalizeGoogleWorkspaceFormat(ref.kind, requestedFormat);
  const fileId = encodeURIComponent(ref.fileId);

  if (ref.kind === "slides") {
    return `https://docs.google.com/presentation/d/${fileId}/export/${format}`;
  }

  const namespace = ref.kind === "docs" ? "document" : "spreadsheets";
  const url = new URL(`https://docs.google.com/${namespace}/d/${fileId}/export`);
  url.searchParams.set("format", format);
  return url.toString();
}

function workspaceKindFromPath(value: string): GoogleWorkspaceKind {
  if (value.toLowerCase() === "document") {
    return "docs";
  }
  if (value.toLowerCase() === "presentation") {
    return "slides";
  }
  return "sheets";
}

function parseKind(value?: string): GoogleWorkspaceKind {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "docs" || normalized === "slides" || normalized === "sheets") {
    return normalized;
  }
  throw new Error("--kind must be docs, slides, or sheets.");
}

function parseArgs(argv: string[]): WorkflowArgs {
  const values = parseFlagArgs(argv);
  const kind = parseKind(stringValue(values, "kind"));
  const sourceUrl = stringValue(values, "url") || stringValue(values, `${kind.slice(0, -1)}-url`);
  if (!sourceUrl) {
    throw new Error(`Usage: --kind ${kind} --url <google-${kind}-url> [--format ${DEFAULT_FORMATS[kind]}]`);
  }

  const format = normalizeGoogleWorkspaceFormat(kind, stringValue(values, "format"));
  const statusFile = stringValue(values, "status-file") || `work/google-${kind}-export-status.json`;
  return {
    sourceUrl,
    kind,
    format,
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
