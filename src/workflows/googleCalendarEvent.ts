import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright";
import {
  browserChannel,
  clearConfirmationFile,
  googleProfileDir,
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

export interface GoogleCalendarEvent {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timeZone?: string;
  details?: string;
  location?: string;
  guests: string[];
}

interface WorkflowArgs {
  eventFile: string;
  browser: BrowserChoice;
  headless: boolean;
  timeoutMs: number;
  loginTimeoutMs: number;
  statusFile: string;
  screenshotFile: string;
  createAfterConfirm: boolean;
  confirmFile: string;
}

const DEFAULT_STATUS_FILE = "work/google-calendar-event-status.json";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const event = normalizeGoogleCalendarEvent(JSON.parse(await readFile(args.eventFile, "utf8")));
  const templateUrl = buildGoogleCalendarTemplateUrl(event);
  const started = Date.now();

  await updateStatus(args.statusFile, "starting", "Launching Google Calendar event workflow.", {
    event,
    templateUrl
  });

  const context = await chromium.launchPersistentContext(googleProfileDir("calendar", args.browser), {
    channel: browserChannel(args.browser),
    headless: args.headless,
    chromiumSandbox: true,
    locale: "ko-KR",
    viewport: { width: 1360, height: 920 }
  });
  context.setDefaultTimeout(args.timeoutMs);
  context.setDefaultNavigationTimeout(Math.max(args.timeoutMs, 90000));

  const page = context.pages()[0] || (await context.newPage());
  try {
    await runProviderPreflight(page, {
      provider: "google",
      targetUrl: templateUrl,
      statusFile: args.statusFile,
      timeoutMs: args.timeoutMs,
      loginTimeoutMs: args.loginTimeoutMs,
      headless: args.headless
    });
    await page.waitForLoadState("networkidle", { timeout: Math.min(args.timeoutMs, 30000) }).catch(() => undefined);
    await page.screenshot({ path: args.screenshotFile, fullPage: true }).catch(() => undefined);

    if (!args.createAfterConfirm) {
      await updateStatus(args.statusFile, "prepared", "Calendar event form was prepared; Save was not clicked.", {
        event,
        url: page.url(),
        screenshotFile: args.screenshotFile,
        elapsedMs: Date.now() - started
      });
      return;
    }

    const resolvedConfirmFile = await clearConfirmationFile(args.confirmFile);
    await updateStatus(args.statusFile, "waiting_for_creation_confirmation", "Calendar event is ready. Waiting for explicit approval before Save.", {
      event,
      url: page.url(),
      confirmFile: resolvedConfirmFile,
      screenshotFile: args.screenshotFile,
      elapsedMs: Date.now() - started
    });

    const approved = await waitForFileConfirmation(args.confirmFile, "create this calendar event");
    if (!approved) {
      await updateStatus(args.statusFile, "canceled", "Calendar event creation was canceled; Save was not clicked.", {
        event,
        url: page.url(),
        screenshotFile: args.screenshotFile,
        elapsedMs: Date.now() - started
      });
      return;
    }

    await clickCalendarSave(page, args.timeoutMs);
    await verifyCalendarSave(page, args.timeoutMs);
    await page.screenshot({ path: args.screenshotFile, fullPage: true }).catch(() => undefined);
    await updateStatus(args.statusFile, "created", "Google Calendar event was created after approval.", {
      event,
      url: page.url(),
      screenshotFile: args.screenshotFile,
      elapsedMs: Date.now() - started
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await page.screenshot({ path: args.screenshotFile, fullPage: true }).catch(() => undefined);
    await updateStatus(args.statusFile, "failed", message, {
      event,
      url: page.url(),
      screenshotFile: args.screenshotFile,
      elapsedMs: Date.now() - started
    });
    throw error;
  } finally {
    await context.close().catch(() => undefined);
  }
}

export function normalizeGoogleCalendarEvent(value: unknown): GoogleCalendarEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Calendar event JSON must be an object.");
  }

  const input = value as Record<string, unknown>;
  const title = requiredString(input.title, "title");
  const start = requiredString(input.start, "start");
  const allDay = input.allDay === true;
  let end = optionalString(input.end);

  if (allDay) {
    assertIsoDate(start, "start");
    if (end) {
      assertIsoDate(end, "end");
    } else {
      end = addUtcDays(start, 1);
    }
    if (end <= start) {
      throw new Error("All-day event end must be after start. Google Calendar uses an exclusive end date.");
    }
  } else {
    if (!end) {
      throw new Error("Timed calendar events require end.");
    }
    assertZonedIsoDateTime(start, "start");
    assertZonedIsoDateTime(end, "end");
    if (Date.parse(end) <= Date.parse(start)) {
      throw new Error("Calendar event end must be after start.");
    }
  }

  const timeZone = optionalString(input.timeZone);
  if (timeZone) {
    assertTimeZone(timeZone);
  }

  const guests = normalizeGuests(input.guests);
  return {
    title,
    start,
    end,
    allDay,
    timeZone,
    details: optionalString(input.details),
    location: optionalString(input.location),
    guests
  };
}

export function buildGoogleCalendarTemplateUrl(event: GoogleCalendarEvent): string {
  const url = new URL("https://calendar.google.com/calendar/render");
  url.searchParams.set("action", "TEMPLATE");
  url.searchParams.set("text", event.title);
  url.searchParams.set("dates", formatCalendarDates(event));
  if (event.details) {
    url.searchParams.set("details", event.details);
  }
  if (event.location) {
    url.searchParams.set("location", event.location);
  }
  if (event.timeZone) {
    url.searchParams.set("ctz", event.timeZone);
  }
  for (const guest of event.guests) {
    url.searchParams.append("add", guest);
  }
  return url.toString();
}

function formatCalendarDates(event: GoogleCalendarEvent): string {
  if (event.allDay) {
    return `${event.start.replaceAll("-", "")}/${event.end.replaceAll("-", "")}`;
  }
  return `${formatUtcDateTime(event.start)}/${formatUtcDateTime(event.end)}`;
}

function formatUtcDateTime(value: string): string {
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function assertIsoDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid YYYY-MM-DD date for an all-day event.`);
  }
}

function assertZonedIsoDateTime(value: string, field: string): void {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be an ISO date-time with Z or an explicit UTC offset.`);
  }
}

function assertTimeZone(value: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
  } catch {
    throw new Error(`Invalid IANA time zone: ${value}`);
  }
}

function addUtcDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeGuests(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("guests must be an array of email addresses.");
  }
  return value.map((guest, index) => {
    const email = requiredString(guest, `guests[${index}]`).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(`guests[${index}] must be a valid email address.`);
    }
    return email;
  });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function clickCalendarSave(page: Page, timeoutMs: number): Promise<void> {
  const candidates: Locator[] = [
    page.getByRole("button", { name: /^(Save|저장)$/i }),
    page.locator('[role="button"]').filter({ hasText: /^(Save|저장)$/i }),
    page.locator("button").filter({ hasText: /^(Save|저장)$/i })
  ];

  for (const locator of candidates) {
    const target = locator.first();
    if (!(await target.isVisible({ timeout: 1500 }).catch(() => false))) {
      continue;
    }
    await target.click({ timeout: timeoutMs });
    return;
  }
  throw new Error("Could not find the Google Calendar Save button.");
}

async function verifyCalendarSave(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.min(timeoutMs, 15000);
  while (Date.now() < deadline) {
    const savedMessage = await page
      .getByText(/Event saved|일정.{0,12}저장|저장되었습니다/i)
      .first()
      .isVisible({ timeout: 250 })
      .catch(() => false);
    if (savedMessage || !/[?&]action=TEMPLATE(?:&|$)/i.test(page.url())) {
      return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error("Calendar Save was clicked, but event creation could not be verified.");
}

function parseArgs(argv: string[]): WorkflowArgs {
  const values = parseFlagArgs(argv);
  const eventFile = stringValue(values, "event-file");
  if (!eventFile) {
    throw new Error("Usage: npm run workflow:google-calendar-event-create -- --event-file work/google-calendar-event.json --create-after-confirm --confirm-file work/google-calendar-confirm.txt");
  }

  const statusFile = stringValue(values, "status-file") || DEFAULT_STATUS_FILE;
  return {
    eventFile,
    browser: parseBrowser(stringValue(values, "browser")),
    headless: values.get("headless") === true && values.get("headful") !== true,
    timeoutMs: numberValue(values, "timeout-ms", 30000),
    loginTimeoutMs: numberValue(values, "login-timeout-ms", 600000),
    statusFile,
    screenshotFile: stringValue(values, "screenshot-file") || siblingOutputFile(statusFile, "-screenshot.png"),
    createAfterConfirm: values.get("create-after-confirm") === true,
    confirmFile: stringValue(values, "confirm-file") || "work/google-calendar-confirm.txt"
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
