import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright";
import {
  browserChannel,
  clearConfirmationFile,
  installPageEvaluateRuntime,
  googleReadOnlyProfileDir,
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

export type MailProvider = "gmail" | "naver";

export interface MailFilter {
  query?: string;
  from?: string;
  to?: string;
  subject?: string;
  after?: string;
  before?: string;
  unread?: boolean;
  hasAttachment?: boolean;
  labels?: string[];
}

export interface MailListItem {
  index: number;
  sender: string;
  subject: string;
  date: string;
  snippet: string;
  unread?: boolean;
  url?: string;
}

export interface MailMessageDetail {
  sender: string;
  subject: string;
  date: string;
  body: string;
  attachments: string[];
  url: string;
}

export interface MailSearchOutput {
  schemaVersion: 1;
  provider: MailProvider;
  query: string;
  list: MailListItem[];
  message?: MailMessageDetail;
  extractedAt: string;
}

interface WorkflowArgs {
  provider: MailProvider;
  query?: string;
  filterFile?: string;
  inbox: boolean;
  receivedOn?: string;
  readFirst: boolean;
  visibleMatchOnly: boolean;
  naverMailbox?: string;
  maxResults: number;
  bodyLimit: number;
  browser: BrowserChoice;
  headless: boolean;
  timeoutMs: number;
  loginTimeoutMs: number;
  outputFile: string;
  statusFile: string;
  screenshotFile?: string;
  inspectFile?: string;
  confirmReadFile: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const filter = await resolveFilter(args);
  const query = args.inbox ? buildNaverInboxQuery(args.receivedOn) : args.provider === "gmail" ? buildGmailSearchQuery(filter) : buildNaverSearchQuery(filter);
  const started = Date.now();

  await updateStatus(args.statusFile, "starting", `Launching ${args.provider} mail search workflow.`, {
    provider: args.provider,
    query,
    mode: args.readFirst ? "read-first" : args.inbox ? "inbox-list" : "list",
    receivedOn: args.receivedOn,
    outputFile: args.outputFile
  });

  const context = await chromium.launchPersistentContext(profileDir(args.provider, args.browser), {
    channel: browserChannel(args.browser),
    headless: args.headless,
    chromiumSandbox: true,
    locale: "ko-KR",
    viewport: { width: 1440, height: 960 }
  });
  await installPageEvaluateRuntime(context);
  context.setDefaultTimeout(args.timeoutMs);
  context.setDefaultNavigationTimeout(Math.max(args.timeoutMs, 90000));

  let page = context.pages()[0] || (await context.newPage());
  try {
    await runProviderPreflight(page, {
      provider: args.provider === "gmail" ? "google" : "naver",
      targetUrl: mailHome(args.provider),
      statusFile: args.statusFile,
      timeoutMs: args.timeoutMs,
      loginTimeoutMs: args.loginTimeoutMs,
      headless: args.headless
    });
    await waitForMailApp(page, args.timeoutMs);

    const rawList =
      args.provider === "gmail"
        ? await searchGmail(page, query, args.maxResults, args.timeoutMs)
        : args.inbox
          ? await listNaverInbox(page, args.maxResults, args.timeoutMs)
          : await searchNaverMail(page, query, args.maxResults, args.timeoutMs, args.visibleMatchOnly, args.naverMailbox);
    const list =
      args.provider === "naver" && args.receivedOn
        ? rawList.filter((item) => matchesNaverReceivedDate(item.date, args.receivedOn!))
        : rawList;

    if (args.provider === "naver" && args.inspectFile) {
      await writeJsonFile(args.inspectFile, await inspectNaverMailRows(page, Math.max(args.maxResults, 10)));
    }

    let output = buildMailSearchOutput(args.provider, query, list);
    await writeMailOutput(args.outputFile, output);
    await captureScreenshot(page, args.screenshotFile);

    if (args.readFirst && list.length > 0) {
      const first = list[0];
      const canChangeReadState = requiresMailOpenApproval(args.provider, first);
      if (canChangeReadState) {
        const confirmFile = await clearConfirmationFile(args.confirmReadFile);
        await updateStatus(
          args.statusFile,
          "waiting_for_unread_open_confirmation",
          "Opening the first result may mark it as read. Waiting for explicit approval.",
          {
            provider: args.provider,
            query,
            firstResult: safeListSummary(first),
            outputFile: args.outputFile,
            confirmReadFile: confirmFile,
            screenshotFile: args.screenshotFile,
            elapsedMs: Date.now() - started
          }
        );

        const approved = await waitForFileConfirmation(args.confirmReadFile, "open the first mail result");
        if (!approved) {
          await updateStatus(args.statusFile, "canceled", "Mail body was not opened; list results remain available.", {
            provider: args.provider,
            query,
            resultCount: list.length,
            outputFile: args.outputFile,
            screenshotFile: args.screenshotFile,
            elapsedMs: Date.now() - started
          });
          return;
        }
      }

      page =
        args.provider === "gmail"
          ? await openFirstGmailResult(page, args.timeoutMs)
          : await openFirstNaverResult(page, args.timeoutMs);
      const message =
        args.provider === "gmail"
          ? await extractGmailMessage(page, args.bodyLimit)
          : await extractNaverMessage(page, args.bodyLimit);
      output = buildMailSearchOutput(args.provider, query, list, message);
      await writeMailOutput(args.outputFile, output);
      await captureScreenshot(page, args.screenshotFile);
    }

    await updateStatus(args.statusFile, "completed", `${args.provider} mail search completed.`, {
      provider: args.provider,
      query,
      mode: args.readFirst ? "read-first" : args.inbox ? "inbox-list" : "list",
      receivedOn: args.receivedOn,
      resultCount: list.length,
      messageExtracted: Boolean(output.message),
      outputFile: args.outputFile,
      screenshotFile: args.screenshotFile,
      elapsedMs: Date.now() - started
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await captureScreenshot(page, args.screenshotFile);
    await updateStatus(args.statusFile, "failed", message, {
      provider: args.provider,
      query,
      outputFile: args.outputFile,
      screenshotFile: args.screenshotFile,
      url: page.url(),
      elapsedMs: Date.now() - started
    });
    throw error;
  } finally {
    await context.close().catch(() => undefined);
  }
}

export function normalizeMailFilter(value: unknown): MailFilter {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mail filter must be a JSON object.");
  }

  const input = value as Record<string, unknown>;
  const filter: MailFilter = {
    query: optionalFilterString(input.query, "query"),
    from: optionalFilterString(input.from, "from"),
    to: optionalFilterString(input.to, "to"),
    subject: optionalFilterString(input.subject, "subject"),
    after: optionalFilterString(input.after, "after"),
    before: optionalFilterString(input.before, "before")
  };

  if (input.unread !== undefined) {
    if (typeof input.unread !== "boolean") throw new Error("unread must be boolean.");
    filter.unread = input.unread;
  }
  if (input.hasAttachment !== undefined) {
    if (typeof input.hasAttachment !== "boolean") throw new Error("hasAttachment must be boolean.");
    filter.hasAttachment = input.hasAttachment;
  }
  if (input.labels !== undefined) {
    if (!Array.isArray(input.labels) || input.labels.some((label) => typeof label !== "string" || !label.trim())) {
      throw new Error("labels must be an array of non-empty strings.");
    }
    filter.labels = input.labels.map((label) => (label as string).trim());
  }
  return filter;
}

export function buildGmailSearchQuery(filter: MailFilter): string {
  const parts: string[] = [];
  if (filter.query) parts.push(filter.query.trim());
  if (filter.from) parts.push(`from:${quoteGmailValue(filter.from)}`);
  if (filter.to) parts.push(`to:${quoteGmailValue(filter.to)}`);
  if (filter.subject) parts.push(`subject:${quoteGmailValue(filter.subject)}`);
  if (filter.after) parts.push(`after:${formatGmailDate(filter.after, "after")}`);
  if (filter.before) parts.push(`before:${formatGmailDate(filter.before, "before")}`);
  if (filter.unread === true) parts.push("is:unread");
  if (filter.hasAttachment === true) parts.push("has:attachment");
  for (const label of filter.labels || []) parts.push(`label:${quoteGmailValue(label)}`);

  const query = parts.join(" ").trim();
  if (!query) {
    throw new Error("Gmail search requires at least one filter field or query.");
  }
  return query;
}

export function buildNaverSearchQuery(filter: MailFilter): string {
  const unsupported = ["from", "to", "subject", "after", "before", "unread", "hasAttachment", "labels"].filter(
    (field) => filter[field as keyof MailFilter] !== undefined
  );
  if (unsupported.length > 0) {
    throw new Error(`Naver Mail preview currently supports keyword query only. Unsupported fields: ${unsupported.join(", ")}.`);
  }
  const query = filter.query?.trim();
  if (!query) {
    throw new Error("Naver Mail search requires query.");
  }
  return query;
}

export function buildNaverInboxQuery(receivedOn?: string): string {
  return receivedOn ? `inbox:${receivedOn}` : "inbox";
}

export function koreaDateString(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function matchesNaverReceivedDate(value: string, targetDate: string, referenceDate = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error("targetDate must be a valid YYYY-MM-DD date.");
  }

  const compact = value.replace(/\s+/g, "");
  if (!compact) return false;
  if (/^(?:\uC624\uC804|\uC624\uD6C4)?\d{1,2}:\d{2}$/.test(compact)) {
    return koreaDateString(referenceDate) === targetDate;
  }

  const match = compact.match(/^(?:(\d{4})[.\-/\uB144])?(\d{1,2})[.\-/\uC6D4](\d{1,2})(?:[.\-/\uC77C])?$/);
  if (!match) return false;
  const [year, month, day] = targetDate.split("-").map(Number);
  return Number(match[1] || year) === year && Number(match[2]) === month && Number(match[3]) === day;
}

export function buildMailSearchOutput(
  provider: MailProvider,
  query: string,
  list: MailListItem[],
  message?: MailMessageDetail
): MailSearchOutput {
  return {
    schemaVersion: 1,
    provider,
    query,
    list,
    message,
    extractedAt: new Date().toISOString()
  };
}

export function requiresMailOpenApproval(provider: MailProvider, item: MailListItem): boolean {
  return provider === "naver" || item.unread !== false;
}

async function resolveFilter(args: WorkflowArgs): Promise<MailFilter> {
  let source: Record<string, unknown> = {};
  if (args.filterFile) {
    const parsed = JSON.parse(await readFile(args.filterFile, "utf8")) as unknown;
    source = normalizeMailFilter(parsed) as Record<string, unknown>;
  }
  if (args.query) {
    const existing = typeof source.query === "string" ? source.query : "";
    source.query = [existing, args.query].filter(Boolean).join(" ");
  }
  return normalizeMailFilter(source);
}

function quoteGmailValue(value: string): string {
  return `"${value.trim().replace(/(["\\])/g, "\\$1")}"`;
}

function formatGmailDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid YYYY-MM-DD date.`);
  }
  return value.replaceAll("-", "/");
}

function optionalFilterString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

async function searchGmail(page: Page, query: string, maxResults: number, timeoutMs: number): Promise<MailListItem[]> {
  const searchUrl = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: Math.max(timeoutMs, 90000) });
  await page.locator("tr.zA").first().waitFor({ state: "visible", timeout: Math.min(timeoutMs, 6000) }).catch(() => undefined);

  return page.evaluate((limit) => {
    const isVisible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const text = (element: Element | null): string => (element?.textContent || "").replace(/\s+/g, " ").trim();
    const rows = Array.from(document.querySelectorAll<HTMLElement>("tr.zA, [role='main'] tr"))
      .filter((row) => isVisible(row) && Boolean(row.querySelector(".bog")))
      .slice(0, limit);

    return rows.map((row, index) => {
      const senderElement = row.querySelector<HTMLElement>(".yW span[email], .zF, .yP");
      const sender = senderElement?.getAttribute("email") || senderElement?.getAttribute("name") || text(senderElement);
      const subject = text(row.querySelector(".bog"));
      const dateElement = row.querySelector<HTMLElement>(".xW span[title], .xW");
      const date = dateElement?.getAttribute("title") || text(dateElement);
      const snippet = text(row.querySelector(".y2"));
      const threadId = row.getAttribute("data-legacy-thread-id") || undefined;
      const url = threadId ? `${location.href.split("#")[0]}#inbox/${threadId}` : undefined;
      return { index, sender, subject, date, snippet, unread: row.classList.contains("zE"), url };
    });
  }, maxResults);
}

async function openFirstGmailResult(page: Page, timeoutMs: number): Promise<Page> {
  const row = page.locator("tr.zA").first();
  if (!(await row.isVisible({ timeout: 2000 }).catch(() => false))) {
    throw new Error("No visible Gmail result was available to open.");
  }
  const subject = row.locator(".bog").first();
  await (await subject.isVisible({ timeout: 1000 }).catch(() => false) ? subject : row).click({ timeout: timeoutMs });
  await page.locator("h2.hP, .a3s").first().waitFor({ state: "visible", timeout: timeoutMs }).catch(() => undefined);
  return page;
}

async function extractGmailMessage(page: Page, bodyLimit: number): Promise<MailMessageDetail> {
  const detail = await page.evaluate((limit) => {
    const isVisible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const clean = (value: string): string => value.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))];
    const visibleText = (selector: string): string[] =>
      Array.from(document.querySelectorAll<HTMLElement>(selector))
        .filter(isVisible)
        .map((element) => clean(element.innerText || element.textContent || ""))
        .filter(Boolean);

    const senderElements = Array.from(document.querySelectorAll<HTMLElement>(".gD[email], .gD")).filter(isVisible);
    const senders = unique(
      senderElements.map((element) => element.getAttribute("email") || element.getAttribute("name") || clean(element.innerText || ""))
    );
    const dates = unique(
      Array.from(document.querySelectorAll<HTMLElement>(".g3[title], .g3"))
        .filter(isVisible)
        .map((element) => element.getAttribute("title") || clean(element.innerText || ""))
    );
    const attachments = unique(visibleText(".aV3, [download_url]"));
    const bodies = unique(visibleText(".a3s.aiL, .a3s"));

    return {
      sender: senders.join(", "),
      subject: visibleText("h2.hP, [role='main'] h2")[0] || "",
      date: dates.join(", "),
      body: bodies.join("\n\n---\n\n").slice(0, limit),
      attachments,
      url: location.href
    };
  }, bodyLimit);

  if (!detail.body) {
    throw new Error("Gmail message opened, but its body could not be extracted.");
  }
  return detail;
}

async function searchNaverMail(
  page: Page,
  query: string,
  maxResults: number,
  timeoutMs: number,
  visibleMatchOnly: boolean,
  naverMailbox?: string
): Promise<MailListItem[]> {
  const input = await findNaverSearchInput(page);
  await input.fill(query);
  await input.press("Enter");
  await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 8000) }).catch(() => undefined);
  await page.waitForTimeout(1500);
  return extractNaverList(page, maxResults, query, visibleMatchOnly, naverMailbox);
}

async function listNaverInbox(page: Page, maxResults: number, timeoutMs: number): Promise<MailListItem[]> {
  await page.locator('a[href*="/popup/read/"]').first().waitFor({ state: "visible", timeout: Math.min(timeoutMs, 8000) }).catch(() => undefined);
  await page.waitForTimeout(1000);
  return extractNaverList(page, maxResults, "", false);
}

async function findNaverSearchInput(page: Page): Promise<Locator> {
  const candidates = [
    page.locator('input[type="search"]'),
    page.locator('input[name*="search" i], input[id*="search" i], input[aria-label*="search" i]'),
    page.getByRole("searchbox")
  ];
  for (const locator of candidates) {
    const target = locator.first();
    if (await target.isVisible({ timeout: 1200 }).catch(() => false)) return target;
  }

  const selector = await page.evaluate(() => {
    const pattern = /search|\uAC80\uC0C9|\uBA54\uC77C/i;
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"))
      .map((input) => {
        const rect = input.getBoundingClientRect();
        const style = getComputedStyle(input);
        const visible = rect.width > 80 && rect.height > 15 && style.display !== "none" && style.visibility !== "hidden";
        const descriptor = [input.type, input.name, input.id, input.placeholder, input.getAttribute("aria-label")]
          .filter(Boolean)
          .join(" ");
        let score = visible ? 1 : -1000;
        if (input.type === "search") score += 100;
        if (pattern.test(descriptor)) score += 80;
        if (rect.top < 300) score += 20;
        if (rect.width > 180) score += 10;
        return { input, score };
      })
      .sort((a, b) => b.score - a.score);
    const selected = inputs[0];
    if (!selected || selected.score < 20) return null;
    const marker = `mail-search-${Date.now()}`;
    selected.input.setAttribute("data-agent-target", marker);
    return `[data-agent-target="${marker}"]`;
  });
  if (!selector) throw new Error("Could not find the Naver Mail search input.");
  return page.locator(selector).first();
}

async function extractNaverList(
  page: Page,
  maxResults: number,
  query: string,
  visibleMatchOnly: boolean,
  naverMailbox?: string
): Promise<MailListItem[]> {
  return page.evaluate(({ limit, searchQuery, requireVisibleMatch, mailboxName }) => {
    const clean = (value: string): string => value.replace(/\s+/g, " ").trim();
    const visible = (element: HTMLElement): boolean => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 280 && rect.height >= 20 && rect.height < 320 && style.display !== "none" && style.visibility !== "hidden";
    };
    const findRow = (link: HTMLAnchorElement): HTMLElement => {
      let current: HTMLElement | null = link;
      let fallback: HTMLElement | null = null;
      for (let depth = 0; current && depth < 10; depth += 1) {
        const raw = current.innerText || current.textContent || "";
        if (/\uBCF4\uB0B8\s*\uC0AC\uB78C/.test(raw) && /\uBA54\uC77C\s*\uC81C\uBAA9/.test(raw)) return current;
        if (!fallback && current.matches("tr, [role='row'], li[class*='mail' i], [class*='mail_item' i], [class*='mailItem']")) {
          fallback = current;
        }
        current = current.parentElement;
      }
      return fallback || link.parentElement || link;
    };

    const normalizedQuery = clean(searchQuery).toLocaleLowerCase("ko-KR");
    const normalizedMailbox = clean(mailboxName || "").toLocaleLowerCase("ko-KR");
    const candidates = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/popup/read/"]'))
      .map((link) => {
        const element = findRow(link);
        const raw = element.innerText || element.textContent || "";
        const mailbox = clean(element.querySelector<HTMLElement>(".mailbox_title")?.innerText || "");
        return { element, raw, text: clean(raw), href: link.href, mailbox };
      })
      .filter((candidate) => visible(candidate.element) && candidate.text.length >= 3 && candidate.text.length < 1600)
      .filter((candidate) => !requireVisibleMatch || candidate.text.toLocaleLowerCase("ko-KR").includes(normalizedQuery))
      .filter((candidate) => !normalizedMailbox || candidate.mailbox.toLocaleLowerCase("ko-KR").includes(normalizedMailbox))
      .filter((candidate, index, all) => all.findIndex((other) => other.href === candidate.href) === index)
      .slice(0, limit);

    return candidates.map((candidate, index) => {
      const { element, raw, href } = candidate;
      const lines = raw
        .split(/\n+/)
        .map(clean)
        .filter(Boolean);
      const fieldText = (selector: string): string => clean(element.querySelector<HTMLElement>(selector)?.innerText || "");
      const senderLine = fieldText(".mail_sender") || lines.find((line) => line.startsWith("\uBCF4\uB0B8 \uC0AC\uB78C")) || "";
      const titleLine = lines.find((line) => line.startsWith("\uBA54\uC77C \uC81C\uBAA9")) || "";
      const cleanSender = senderLine.replace(/^\uBCF4\uB0B8\s*\uC0AC\uB78C\s*/, "");
      const cleanTitle = titleLine.replace(/^\uBA54\uC77C\s*\uC81C\uBAA9\s*/, "");
      const accessibleSubject = element.querySelector<HTMLLabelElement>('label[aria-label]:not([title])')?.getAttribute("aria-label") || "";
      const subject = clean(accessibleSubject) || cleanTitle || fieldText(".mail_title_link") || lines[1] || lines[0] || "";
      const sender = cleanSender || fieldText('[class*="sender" i], [class*="from" i]') || lines[0] || "";
      const date = fieldText(".mail_date_wrap .mail_date") || fieldText('[class*="date" i], [class*="time" i]') || lines.find((line) => /\d{1,4}[./:-]\d{1,2}/.test(line)) || "";
      const snippetCandidate = fieldText('[class*="preview" i], [class*="snippet" i], [class*="summary" i]');
      const snippet = /\uBBF8\uB9AC\uBCF4\uAE30\s*\uC5F4\uAE30/.test(snippetCandidate) ? "" : snippetCandidate;
      const stateLabels = Array.from(element.querySelectorAll<HTMLElement>("label[aria-label]"))
        .map((label) => label.getAttribute("aria-label") || "")
        .join(" ");
      element.setAttribute("data-agent-mail-result", String(index));
      return {
        index,
        sender,
        subject,
        date,
        snippet,
        unread: /unread|not.?read|\uC77D\uC9C0\s*\uC54A/i.test(stateLabels),
        url: href || undefined
      };
    });
  }, { limit: maxResults, searchQuery: query, requireVisibleMatch: visibleMatchOnly, mailboxName: naverMailbox });
}

async function inspectNaverMailRows(page: Page, limit: number): Promise<unknown[]> {
  return page.evaluate((maxRows) => {
    const clean = (value: string): string => value.replace(/\s+/g, " ").trim();
    const findRow = (link: HTMLAnchorElement): HTMLElement => {
      let current: HTMLElement | null = link;
      let fallback: HTMLElement | null = null;
      for (let depth = 0; current && depth < 10; depth += 1) {
        const raw = current.innerText || current.textContent || "";
        if (/\uBCF4\uB0B8\s*\uC0AC\uB78C/.test(raw) && /\uBA54\uC77C\s*\uC81C\uBAA9/.test(raw)) return current;
        if (!fallback && current.matches("tr, [role='row'], li[class*='mail' i], [class*='mail_item' i], [class*='mailItem']")) {
          fallback = current;
        }
        current = current.parentElement;
      }
      return fallback || link.parentElement || link;
    };

    const seen = new Set<string>();
    const rows: unknown[] = [];
    for (const link of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/popup/read/"]'))) {
      if (seen.has(link.href)) continue;
      seen.add(link.href);
      const row = findRow(link);
      const descendants = Array.from(row.querySelectorAll<HTMLElement>("[aria-label], [title], [class]"))
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === "string" ? element.className : "",
          ariaLabel: element.getAttribute("aria-label") || "",
          title: element.getAttribute("title") || "",
          text: clean(element.innerText || element.textContent || "").slice(0, 300)
        }))
        .filter((element) => element.ariaLabel || element.title || element.text)
        .slice(0, 80);
      rows.push({
        href: link.href,
        rowTag: row.tagName.toLowerCase(),
        rowClass: typeof row.className === "string" ? row.className : "",
        rowText: (row.innerText || row.textContent || "").trim().slice(0, 2000),
        descendants
      });
      if (rows.length >= maxRows) break;
    }
    return rows;
  }, limit);
}

async function openFirstNaverResult(page: Page, timeoutMs: number): Promise<Page> {
  const row = page.locator('[data-agent-mail-result="0"]').first();
  if (!(await row.isVisible({ timeout: 2000 }).catch(() => false))) {
    throw new Error("No verified Naver Mail result row was available to open.");
  }
  const popupPromise = page.context().waitForEvent("page", { timeout: 2500 }).catch(() => null);
  const target = row.locator("a[href], button").first();
  await (await target.isVisible({ timeout: 800 }).catch(() => false) ? target : row).click({ timeout: timeoutMs });
  const detailPage = (await popupPromise) || page;
  await waitForMailApp(detailPage, timeoutMs);
  return detailPage;
}

export async function extractNaverMessage(page: Page, bodyLimit: number): Promise<MailMessageDetail> {
  const detail = await page.evaluate((limit) => {
    const clean = (value: string): string => value.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    const isVisible = (element: HTMLElement): boolean => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const firstText = (selector: string): string => {
      const element = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(isVisible);
      return clean(element?.innerText || element?.textContent || "");
    };
    const bodyCandidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[class*="mail_body" i], [class*="mailBody"], [class*="message_body" i], [class*="read_body" i], [class*="viewer_content" i]'
      )
    )
      .filter(isVisible)
      .map((element) => clean(element.innerText || element.textContent || ""))
      .filter((text) => text.length > 0)
      .sort((a, b) => b.length - a.length);
    const attachments = Array.from(
      document.querySelectorAll<HTMLElement>('[class*="attach" i] a, [download], a[href*="download" i]')
    )
      .filter(isVisible)
      .map((element) => clean(element.innerText || element.textContent || ""))
      .filter(Boolean);

    return {
      sender: firstText('[class*="sender" i], [class*="from" i]'),
      subject: firstText('[class*="subject" i], h1, h2'),
      date: firstText('[class*="date" i], [class*="time" i]'),
      body: (bodyCandidates[0] || "").slice(0, limit),
      attachments: [...new Set(attachments)],
      url: location.href
    };
  }, bodyLimit);

  if (!detail.body) {
    for (const frame of page.frames().slice(1)) {
      const frameBody = await frame.locator("body").innerText({ timeout: 1500 }).catch(() => "");
      if (frameBody.trim().length > 0) {
        detail.body = frameBody.trim().slice(0, bodyLimit);
        break;
      }
    }
  }
  if (!detail.body) {
    await page.waitForTimeout(1000);
    const pageText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    if (pageText.trim().length >= 100) {
      detail.body = pageText.trim().slice(0, bodyLimit);
    }
  }
  if (!detail.body) {
    throw new Error("Naver Mail message opened, but its body could not be extracted.");
  }
  return detail;
}

function safeListSummary(item: MailListItem): Pick<MailListItem, "sender" | "subject" | "date" | "unread"> {
  return { sender: item.sender, subject: item.subject, date: item.date, unread: item.unread };
}

async function writeMailOutput(file: string, output: MailSearchOutput): Promise<void> {
  await writeJsonFile(file, output);
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

async function captureScreenshot(page: Page, file?: string): Promise<void> {
  if (!file) return;
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
}

async function waitForMailApp(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 8000) }).catch(() => undefined);
}

function profileDir(provider: MailProvider, browser: BrowserChoice): string {
  return provider === "gmail" ? googleReadOnlyProfileDir(browser) : naverReadOnlyProfileDir(browser);
}

function mailHome(provider: MailProvider): string {
  return provider === "gmail" ? "https://mail.google.com/mail/u/0/" : "https://mail.naver.com/";
}

function parseProvider(value?: string): MailProvider {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "gmail" || normalized === "naver") return normalized;
  throw new Error("--provider must be gmail or naver.");
}

function parseArgs(argv: string[]): WorkflowArgs {
  const values = parseFlagArgs(argv);
  const provider = parseProvider(stringValue(values, "provider"));
  const query = stringValue(values, "query");
  const filterFile = stringValue(values, "filter-file");
  const inbox = values.get("inbox") === true;
  const today = values.get("today") === true;
  const readFirst = values.get("read-first") === true;
  if (inbox && provider !== "naver") {
    throw new Error("--inbox is available only for Naver Mail.");
  }
  if (today && !inbox) {
    throw new Error("--today requires --inbox.");
  }
  if (inbox && (query || filterFile)) {
    throw new Error("Use either --inbox or a keyword query/filter file, not both.");
  }
  if (inbox && readFirst) {
    throw new Error("--read-first is not supported with --inbox.");
  }
  if (!inbox && !query && !filterFile) {
    throw new Error(`Usage: --provider ${provider} --query <mail-query> [--read-first]`);
  }

  return {
    provider,
    query,
    filterFile,
    inbox,
    receivedOn: today ? koreaDateString() : undefined,
    readFirst,
    visibleMatchOnly: values.get("visible-match-only") === true,
    naverMailbox: stringValue(values, "naver-mailbox"),
    maxResults: Math.min(numberValue(values, "max-results", 20), 100),
    bodyLimit: Math.min(numberValue(values, "body-limit", 50000), 200000),
    browser: parseBrowser(stringValue(values, "browser")),
    headless: values.get("headless") === true && values.get("headful") !== true,
    timeoutMs: numberValue(values, "timeout-ms", 30000),
    loginTimeoutMs: numberValue(values, "login-timeout-ms", 600000),
    outputFile: stringValue(values, "output-file") || `work/mail/${provider}-search-results.json`,
    statusFile:
      stringValue(values, "status-file") ||
      (provider === "gmail" ? "work/gmail-search-read-status.json" : "work/naver-mail-search-read-status.json"),
    screenshotFile: stringValue(values, "screenshot-file"),
    inspectFile: stringValue(values, "inspect-file"),
    confirmReadFile:
      stringValue(values, "confirm-read-file") ||
      (provider === "gmail" ? "work/gmail-read-confirm.txt" : "work/naver-mail-read-confirm.txt")
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
