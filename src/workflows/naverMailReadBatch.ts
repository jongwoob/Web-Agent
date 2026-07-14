import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import {
  browserChannel,
  clearConfirmationFile,
  installPageEvaluateRuntime,
  naverReadOnlyProfileDir,
  numberValue,
  parseBrowser,
  parseFlagArgs,
  stringValue,
  updateStatus,
  waitForFileConfirmation,
  type BrowserChoice
} from "./shared.js";
import { runProviderPreflight } from "./providerPreflight.js";
import {
  extractNaverMessage,
  type MailListItem,
  type MailMessageDetail
} from "./mailSearchRead.js";

interface WorkflowArgs {
  listFile: string;
  count: number;
  browser: BrowserChoice;
  headless: boolean;
  timeoutMs: number;
  loginTimeoutMs: number;
  bodyLimit: number;
  confirmFile: string;
  statusFile: string;
  outputFile: string;
}

export interface NaverMailBatchItem {
  listItem: MailListItem;
  message: MailMessageDetail;
}

export interface NaverMailBatchOutput {
  schemaVersion: 1;
  provider: "naver";
  sourceListFile: string;
  messages: NaverMailBatchItem[];
  extractedAt: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const source = JSON.parse(await readFile(args.listFile, "utf8")) as unknown;
  const selected = selectNaverBatchItems(source, args.count);
  const started = Date.now();

  await updateStatus(args.statusFile, "starting", "Launching Naver Mail batch read workflow.", {
    sourceListFile: args.listFile,
    count: selected.length,
    items: selected.map(safeListSummary),
    outputFile: args.outputFile
  });

  const context = await chromium.launchPersistentContext(naverReadOnlyProfileDir(args.browser), {
    channel: browserChannel(args.browser),
    headless: args.headless,
    chromiumSandbox: true,
    locale: "ko-KR",
    viewport: { width: 1440, height: 960 }
  });
  await installPageEvaluateRuntime(context);
  context.setDefaultTimeout(args.timeoutMs);
  context.setDefaultNavigationTimeout(Math.max(args.timeoutMs, 90000));

  try {
    const preflightPage = context.pages()[0] || (await context.newPage());
    await runProviderPreflight(preflightPage, {
      provider: "naver",
      targetUrl: "https://mail.naver.com/",
      statusFile: args.statusFile,
      timeoutMs: args.timeoutMs,
      loginTimeoutMs: args.loginTimeoutMs,
      headless: args.headless
    });

    const confirmFile = await clearConfirmationFile(args.confirmFile);
    await updateStatus(args.statusFile, "waiting_for_batch_read_confirmation", "Waiting for approval to open the selected Naver Mail messages.", {
      sourceListFile: args.listFile,
      count: selected.length,
      items: selected.map(safeListSummary),
      confirmFile,
      outputFile: args.outputFile,
      elapsedMs: Date.now() - started
    });

    const approved = await waitForFileConfirmation(args.confirmFile, `open ${selected.length} selected Naver Mail messages`);
    if (!approved) {
      await updateStatus(args.statusFile, "canceled", "Naver Mail batch read was canceled; no message body was opened.", {
        count: selected.length,
        outputFile: args.outputFile,
        elapsedMs: Date.now() - started
      });
      return;
    }

    const messages: NaverMailBatchItem[] = [];
    for (const item of selected) {
      await updateStatus(args.statusFile, "reading", `Reading Naver Mail result ${messages.length + 1} of ${selected.length}.`, {
        current: safeListSummary(item),
        completedCount: messages.length,
        totalCount: selected.length,
        outputFile: args.outputFile
      });
      const page = await context.newPage();
      try {
        await page.goto(item.url!, { waitUntil: "domcontentloaded", timeout: Math.max(args.timeoutMs, 90000) });
        await ensureNaverLogin(page, args);
        const detail = await extractNaverMessage(page, args.bodyLimit);
        messages.push({
          listItem: item,
          message: {
            ...detail,
            sender: detail.sender || item.sender,
            subject: detail.subject || item.subject,
            date: detail.date || item.date
          }
        });
        await writeBatchOutput(args.outputFile, args.listFile, messages);
      } finally {
        await page.close().catch(() => undefined);
      }
    }

    await updateStatus(args.statusFile, "completed", "Selected Naver Mail message bodies were extracted.", {
      count: selected.length,
      outputFile: args.outputFile,
      elapsedMs: Date.now() - started
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateStatus(args.statusFile, "failed", message, {
      count: selected.length,
      outputFile: args.outputFile,
      elapsedMs: Date.now() - started
    });
    throw error;
  } finally {
    await context.close().catch(() => undefined);
  }
}

export function selectNaverBatchItems(value: unknown, count: number): MailListItem[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Naver Mail list JSON must be an object.");
  }
  const input = value as { provider?: unknown; list?: unknown };
  if (input.provider !== "naver" || !Array.isArray(input.list)) {
    throw new Error("Naver Mail list JSON must have provider=naver and a list array.");
  }
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw new Error("Batch read count must be between 1 and 10.");
  }

  const selected = input.list.slice(0, count).map((item, index) => validateListItem(item, index));
  if (selected.length === 0) {
    throw new Error("Naver Mail list contains no messages to read.");
  }
  return selected;
}

function validateListItem(value: unknown, index: number): MailListItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Naver Mail list item ${index} must be an object.`);
  }
  const item = value as Partial<MailListItem>;
  if (typeof item.url !== "string") {
    throw new Error(`Naver Mail list item ${index} is missing a URL.`);
  }
  const url = new URL(item.url);
  if (url.hostname !== "mail.naver.com" || !/\/v2\/popup\/read\//.test(url.pathname)) {
    throw new Error(`Naver Mail list item ${index} has an unsupported URL.`);
  }
  if (typeof item.sender !== "string" || typeof item.subject !== "string" || typeof item.date !== "string") {
    throw new Error(`Naver Mail list item ${index} is missing sender, subject, or date.`);
  }
  return {
    index: typeof item.index === "number" ? item.index : index,
    sender: item.sender,
    subject: item.subject,
    date: item.date,
    snippet: typeof item.snippet === "string" ? item.snippet : "",
    unread: typeof item.unread === "boolean" ? item.unread : undefined,
    url: item.url
  };
}

async function ensureNaverLogin(page: Page, args: WorkflowArgs): Promise<void> {
  const needsLogin =
    /nid\.naver\.com/i.test(page.url()) ||
    (await page.locator('input[type="password"], #pw, input[name="pw"]').first().isVisible({ timeout: 1500 }).catch(() => false));
  if (needsLogin) {
    await updateStatus(args.statusFile, "waiting_for_naver_login", "Please log in directly in the opened Naver browser window.", {
      url: page.url(),
      outputFile: args.outputFile
    });
    await page.waitForFunction(
      () => location.hostname === "mail.naver.com" || location.hostname.endsWith(".mail.naver.com"),
      undefined,
      { timeout: args.loginTimeoutMs }
    );
  }
  await page.waitForLoadState("networkidle", { timeout: Math.min(args.timeoutMs, 8000) }).catch(() => undefined);
}

async function writeBatchOutput(file: string, sourceListFile: string, messages: NaverMailBatchItem[]): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const output: NaverMailBatchOutput = {
    schemaVersion: 1,
    provider: "naver",
    sourceListFile,
    messages,
    extractedAt: new Date().toISOString()
  };
  await writeFile(file, JSON.stringify(output, null, 2), "utf8");
}

function safeListSummary(item: MailListItem): Pick<MailListItem, "sender" | "subject" | "date" | "unread"> {
  return { sender: item.sender, subject: item.subject, date: item.date, unread: item.unread };
}

function parseArgs(argv: string[]): WorkflowArgs {
  const values = parseFlagArgs(argv);
  const listFile = stringValue(values, "list-file");
  if (!listFile) {
    throw new Error("Usage: npm run workflow:naver-mail-read-batch -- --list-file <naver-mail-list.json> --count 5 --confirm-file <file>");
  }
  return {
    listFile,
    count: Math.min(numberValue(values, "count", 5), 10),
    browser: parseBrowser(stringValue(values, "browser")),
    headless: values.get("headless") === true && values.get("headful") !== true,
    timeoutMs: numberValue(values, "timeout-ms", 30000),
    loginTimeoutMs: numberValue(values, "login-timeout-ms", 600000),
    bodyLimit: Math.min(numberValue(values, "body-limit", 50000), 200000),
    confirmFile: stringValue(values, "confirm-file") || "work/naver-mail-batch-read-confirm.txt",
    statusFile: stringValue(values, "status-file") || "work/naver-mail-batch-read-status.json",
    outputFile: stringValue(values, "output-file") || "work/mail/naver-mail-batch-read.json"
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
