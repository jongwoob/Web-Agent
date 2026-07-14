import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright";
import { compactWhitespace } from "../strings.js";
import { runProviderPreflight } from "./providerPreflight.js";
import { installPageEvaluateRuntime } from "./shared.js";

export interface NaverMailDraft {
  to: string;
  subject: string;
  body: string;
}

interface WorkflowArgs extends NaverMailDraft {
  command?: string;
  draftFile?: string;
  browser: "chromium" | "chrome" | "edge";
  useEdgeDefaultProfile: boolean;
  headless: boolean;
  timeoutMs: number;
  loginTimeoutMs: number;
  autoLoginSaved: boolean;
  autoLoginWaitMs: number;
  sendAfterConfirm: boolean;
  smokeOnly: boolean;
  confirmFile?: string;
  statusFile?: string;
}

interface WorkflowStatus {
  status:
    | "starting"
    | "trying_saved_login"
    | "waiting_for_login"
    | "logged_in"
    | "smoke_test_completed"
    | "compose_opened"
    | "draft_filled"
    | "waiting_for_send_confirmation"
    | "sent"
    | "stopped"
    | "failed";
  message: string;
  draft: NaverMailDraft;
  url?: string;
  screenshotPath?: string;
  updatedAt: string;
}

const mailUrl = "https://mail.naver.com/";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runDir = await createRunDir();
  const statusFile = args.statusFile || path.join(runDir, "naver-mail-status.json");
  const screenshotPath = path.join(runDir, "draft.png");
  const profileDir = resolveProfileDir(args);

  await mkdir(profileDir, { recursive: true });
  await updateStatus(statusFile, "starting", "Launching browser.", args);

  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null;
  let page: Page | null = null;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: browserChannel(args.browser),
      args: args.useEdgeDefaultProfile ? ["--profile-directory=Default"] : [],
      headless: args.headless,
      chromiumSandbox: true,
      locale: "ko-KR",
      viewport: { width: 1360, height: 920 },
      ignoreHTTPSErrors: true
    });
    await installPageEvaluateRuntime(context);
    context.setDefaultTimeout(args.timeoutMs);
    context.setDefaultNavigationTimeout(Math.max(args.timeoutMs, 20000));
    page = context.pages()[0] || (await context.newPage());

    await runProviderPreflight(page, {
      provider: "naver",
      targetUrl: mailUrl,
      statusFile,
      timeoutMs: args.timeoutMs,
      loginTimeoutMs: args.loginTimeoutMs,
      headless: args.headless
    });
    await ensureLoggedIn(page, args, statusFile);
    await updateStatus(statusFile, "logged_in", "Naver Mail is open.", args, { url: page.url() });

    if (args.smokeOnly) {
      const activePage = page;
      const composeTarget = await firstUsableLocator(activePage, args.timeoutMs, [
        () => activePage.getByRole("link", { name: /\uBA54\uC77C\s*\uC4F0\uAE30|\uC4F0\uAE30|Write|Compose/i }),
        () => activePage.getByRole("button", { name: /\uBA54\uC77C\s*\uC4F0\uAE30|\uC4F0\uAE30|Write|Compose/i }),
        () => activePage.locator('a[href*="write" i], button[class*="write" i], a[class*="write" i]')
      ]);
      if (!composeTarget) {
        throw new Error("Naver Mail opened, but no compose target was visible for the smoke test.");
      }
      await activePage.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      await updateStatus(statusFile, "smoke_test_completed", "Naver Mail login and compose availability were verified without opening a draft.", args, {
        url: activePage.url(),
        screenshotPath
      });
      return;
    }

    const composePage = await openCompose(page, args.timeoutMs);
    await updateStatus(statusFile, "compose_opened", "Compose window is open.", args, { url: composePage.url() });

    await fillDraft(composePage, args);
    await composePage.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    await updateStatus(statusFile, "draft_filled", "Draft fields were filled. Review the visible browser before sending.", args, {
      url: composePage.url(),
      screenshotPath
    });

    console.log("Draft is ready for review. Explicit user approval is required before sending.");
    console.log(`To: ${args.to}`);
    console.log(`Subject: ${args.subject}`);
    console.log(`Body: ${args.body}`);
    console.log(`Status file: ${statusFile}`);

    if (!args.sendAfterConfirm) {
      await updateStatus(statusFile, "stopped", "Stopped after filling draft because --send-after-confirm was not set.", args, {
        url: composePage.url(),
        screenshotPath
      });
      console.log("Stopped before sending. Add --send-after-confirm to enable confirmation-gated sending.");
      return;
    }

    await updateStatus(statusFile, "waiting_for_send_confirmation", "Waiting for explicit user approval before sending.", args, {
      url: composePage.url(),
      screenshotPath
    });

    const approved = await waitForSendApproval(args.confirmFile);
    if (!approved) {
      await updateStatus(statusFile, "stopped", "Send was not approved.", args, { url: composePage.url(), screenshotPath });
      console.log("Send was not approved. Leaving draft open.");
      return;
    }

    await clickSend(composePage, args.timeoutMs);
    await updateStatus(statusFile, "sent", "Send button was clicked after explicit confirmation.", args, {
      url: composePage.url(),
      screenshotPath
    });
    console.log("Send button clicked after confirmation.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateStatus(statusFile, "failed", message, args, { url: page?.url() }).catch(() => undefined);
    throw error;
  } finally {
    if (!context) {
      return;
    }

    if (args.headless) {
      await context.close().catch(() => undefined);
    } else {
      console.log("Browser is left open for review. Close it manually when finished.");
    }
  }
}

export function parseNaverMailCommand(command: string): Partial<NaverMailDraft> {
  const cleaned = compactWhitespace(command);
  const emailMatch = cleaned.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const to = emailMatch?.[0];
  let subject: string | undefined;

  if (to) {
    const afterRecipient = compactWhitespace(cleaned.slice(cleaned.indexOf(to) + to.length)).replace(/^(에게|한테|로|께)\s*/, "");
    const subjectMatch = afterRecipient.match(/(.+?)\s*(?:메일\s*(?:보내기|쓰기|작성)|이메일\s*(?:보내기|쓰기|작성))/i);
    subject = compactWhitespace(subjectMatch?.[1] || "");
  }

  return {
    to,
    subject: subject || undefined
  };
}

function parseArgs(argv: string[]): WorkflowArgs {
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

  const draftFile = stringValue(values, "draft-file");
  const draftFromFile = draftFile ? readDraftFile(draftFile) : {};
  const command = stringValue(values, "command") || draftFromFile.command;
  const parsed = command ? parseNaverMailCommand(command) : {};
  const to = stringValue(values, "to") || draftFromFile.to || parsed.to;
  const subject = stringValue(values, "subject") || draftFromFile.subject || parsed.subject;
  const body = stringValue(values, "body") || draftFromFile.body;

  const smokeOnly = values.get("smoke-only") === true;
  if (!smokeOnly && (!to || !subject || !body)) {
    throw new Error(
      'Usage: npm run workflow:naver-mail -- --command "recipient@example.com 에게 주문 건 메일 보내기" --body "본문" [--send-after-confirm]'
    );
  }

  return {
    command,
    draftFile,
    to: to || "",
    subject: subject || "",
    body: body || "",
    browser: parseBrowser(stringValue(values, "browser")),
    useEdgeDefaultProfile: values.get("use-edge-default-profile") === true,
    headless: values.get("headless") === true,
    timeoutMs: numberValue(values, "timeout-ms", 10000),
    loginTimeoutMs: numberValue(values, "login-timeout-ms", 180000),
    autoLoginSaved: values.get("no-auto-login-saved") !== true,
    autoLoginWaitMs: numberValue(values, "auto-login-wait-ms", 5000),
    sendAfterConfirm: values.get("send-after-confirm") === true,
    smokeOnly,
    confirmFile: stringValue(values, "confirm-file"),
    statusFile: stringValue(values, "status-file")
  };
}

function resolveProfileDir(args: WorkflowArgs): string {
  if (args.useEdgeDefaultProfile) {
    if (args.browser !== "edge") {
      throw new Error("--use-edge-default-profile requires --browser edge.");
    }

    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error("LOCALAPPDATA is not set, so the Edge default profile cannot be resolved.");
    }

    return path.join(localAppData, "Microsoft", "Edge", "User Data");
  }

  if (args.browser === "edge") {
    return path.resolve(".browser-profiles/naver-edge");
  }

  if (args.browser === "chrome") {
    return path.resolve(".browser-profiles/naver-chrome");
  }

  return path.resolve(".browser-profiles/naver");
}

function parseBrowser(value?: string): WorkflowArgs["browser"] {
  if (!value) {
    return "chromium";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "edge" || normalized === "msedge" || normalized === "microsoft-edge") {
    return "edge";
  }

  if (normalized === "chrome" || normalized === "google-chrome") {
    return "chrome";
  }

  if (normalized === "chromium") {
    return "chromium";
  }

  throw new Error("--browser must be chromium, chrome, or edge.");
}

function browserChannel(browser: WorkflowArgs["browser"]): "chrome" | "msedge" | undefined {
  if (browser === "chrome") {
    return "chrome";
  }

  if (browser === "edge") {
    return "msedge";
  }

  return undefined;
}

function readDraftFile(file: string): Partial<NaverMailDraft> & { command?: string } {
  const resolved = path.resolve(file);
  const parsed = JSON.parse(readFileSync(resolved, "utf8")) as Partial<NaverMailDraft> & { command?: string };
  return {
    command: typeof parsed.command === "string" ? parsed.command : undefined,
    to: typeof parsed.to === "string" ? parsed.to : undefined,
    subject: typeof parsed.subject === "string" ? parsed.subject : undefined,
    body: typeof parsed.body === "string" ? parsed.body : undefined
  };
}

async function ensureLoggedIn(page: Page, args: WorkflowArgs, statusFile: string): Promise<void> {
  const needsLogin = await detectNaverLoginPage(page, Math.min(args.timeoutMs, 8000));
  if (!needsLogin) {
    await waitForMailApp(page, args.timeoutMs);
    return;
  }

  if (args.autoLoginSaved) {
    await updateStatus(statusFile, "trying_saved_login", "Trying browser-saved login if the form is autofilled.", args, {
      url: page.url()
    });
    const loggedInWithSavedCredentials = await trySavedCredentialLogin(page, args);
    if (loggedInWithSavedCredentials) {
      await waitForMailApp(page, args.timeoutMs);
      return;
    }
  }

  await updateStatus(statusFile, "waiting_for_login", "Please log in manually in the opened Naver browser window.", args, {
    url: page.url()
  });
  console.log("Naver login page is open. Log in manually in the browser window.");
  console.log("Do not paste passwords into this chat or terminal.");

  await waitForNaverMailHost(page, args.loginTimeoutMs);
  await waitForMailApp(page, args.timeoutMs);
}

async function detectNaverLoginPage(page: Page, timeoutMs: number): Promise<boolean> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (/nid\.naver\.com/i.test(page.url())) {
      return true;
    }

    const hasLoginFields = await page
      .locator('#id, #pw, input[name="id"], input[name="pw"], input[type="password"]')
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (hasLoginFields) {
      return true;
    }

    const hasMailComposeTarget = await page
      .locator("a,button")
      .filter({ hasText: /메일|쓰기|Write|Compose/i })
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (/mail\.naver\.com/i.test(page.url()) && hasMailComposeTarget) {
      return false;
    }

    await page.waitForTimeout(500);
  }

  return /nid\.naver\.com/i.test(page.url());
}

async function trySavedCredentialLogin(page: Page, args: WorkflowArgs): Promise<boolean> {
  console.log("Checking whether the login form was autofilled by the browser profile.");
  console.log("Credential values are not printed or stored.");

  const idField = page.locator('#id, input[name="id"], input[type="text"]').first();
  const passwordField = page.locator('#pw, input[name="pw"], input[type="password"]').first();
  await idField.waitFor({ state: "visible", timeout: Math.min(args.timeoutMs, 5000) }).catch(() => undefined);
  await passwordField.waitFor({ state: "visible", timeout: Math.min(args.timeoutMs, 5000) }).catch(() => undefined);

  await idField.click({ timeout: 1000 }).catch(() => undefined);
  await page.waitForTimeout(250);
  await passwordField.click({ timeout: 1000 }).catch(() => undefined);

  const hasAutofilledCredentials = await page
    .waitForFunction(
      () => {
        const idInput = document.querySelector<HTMLInputElement>('#id, input[name="id"], input[type="text"]');
        const passwordInput = document.querySelector<HTMLInputElement>('#pw, input[name="pw"], input[type="password"]');
        return Boolean(idInput?.value && passwordInput?.value);
      },
      undefined,
      { timeout: args.autoLoginWaitMs }
    )
    .then(() => true)
    .catch(() => false);

  if (!hasAutofilledCredentials) {
    console.log("No browser-autofilled login fields were detected. Falling back to manual login.");
    return false;
  }

  console.log("Autofilled login fields detected. Clicking login.");
  await clickFirst(page, args.timeoutMs, [
    () => page.locator("#log\\.login"),
    () => page.getByRole("button", { name: /로그인|Log in|Sign in/i }),
    () => page.locator('button[type="submit"], input[type="submit"]')
  ]);

  const reachedMail = await waitForNaverMailHost(page, args.timeoutMs).then(() => true).catch(() => false);
  if (!reachedMail) {
    console.log("Saved-login attempt did not reach Naver Mail. Manual login is required.");
    return false;
  }

  console.log("Logged in with browser-saved credentials or an existing authenticated session.");
  return true;
}

async function waitForMailApp(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 8000) }).catch(() => undefined);
}

async function waitForNaverMailHost(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () => location.hostname === "mail.naver.com" || location.hostname.endsWith(".mail.naver.com"),
    undefined,
    { timeout: timeoutMs }
  );
}

async function openCompose(page: Page, timeoutMs: number): Promise<Page> {
  const newPagePromise = page.context().waitForEvent("page", { timeout: 3000 }).catch(() => null);
  await clickFirst(page, timeoutMs, [
    () => page.getByRole("link", { name: /메일\s*쓰기|메일쓰기|편지\s*쓰기|쓰기/i }),
    () => page.getByRole("button", { name: /메일\s*쓰기|메일쓰기|편지\s*쓰기|쓰기/i }),
    () => page.locator("a,button").filter({ hasText: /메일\s*쓰기|메일쓰기|편지\s*쓰기/i })
  ]);

  const maybePage = await newPagePromise;
  const composePage = maybePage || page;
  await waitForMailApp(composePage, timeoutMs);
  return composePage;
}

async function fillDraft(page: Page, draft: NaverMailDraft & { timeoutMs: number }): Promise<void> {
  await fillRecipient(page, draft.to, draft.timeoutMs);
  await fillSubject(page, draft.subject, draft.timeoutMs);
  await fillBody(page, draft.body, draft.timeoutMs);
  await fillSubject(page, draft.subject, draft.timeoutMs);
}

async function fillRecipient(page: Page, value: string, timeoutMs: number): Promise<void> {
  const locator =
    (await firstUsableLocator(page, timeoutMs, [
      () => page.getByLabel(/받는\s*사람|받는사람|수신자|To/i),
      () => page.getByPlaceholder(/받는\s*사람|받는사람|수신자|메일\s*주소|이메일|To/i),
      () => page.locator('input[name*="to" i], textarea[name*="to" i], input[id*="to" i], textarea[id*="to" i]'),
      () => page.locator('input[aria-label*="받는" i], textarea[aria-label*="받는" i]')
    ])) || (await markHeuristicField(page, "recipient"));

  if (!locator) {
    throw new Error("Could not find recipient field.");
  }

  await locator.click({ timeout: timeoutMs });
  await locator.fill(value, { timeout: timeoutMs }).catch(async () => {
    await page.keyboard.insertText(value);
  });
  await page.keyboard.press("Enter").catch(() => undefined);
}

async function fillSubject(page: Page, value: string, timeoutMs: number): Promise<void> {
  const locator =
    (await firstUsableLocator(page, timeoutMs, [
      () => page.getByLabel(/제목|Subject/i),
      () => page.getByPlaceholder(/제목|Subject/i),
      () => page.locator('input[name*="subject" i], input[id*="subject" i], input[title*="제목" i], input[aria-label*="제목" i]')
    ])) || (await markHeuristicField(page, "subject"));

  if (!locator) {
    throw new Error("Could not find subject field.");
  }

  await locator.click({ timeout: timeoutMs });
  await locator.fill(value, { timeout: timeoutMs }).catch(async () => {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.insertText(value);
  });
}

async function fillBody(page: Page, value: string, timeoutMs: number): Promise<void> {
  const mainLocator =
    (await firstUsableLocator(page, timeoutMs, [
      () => page.getByLabel(/본문|내용|Body|Message/i),
      () => page.getByPlaceholder(/본문|내용|Body|Message/i),
      () => page.locator('[contenteditable="true"]').last(),
      () => page.locator("textarea").last()
    ])) || (await markHeuristicField(page, "body"));

  if (mainLocator) {
    await typeIntoLocator(page, mainLocator, value, timeoutMs);
    if (await bodyEditorContains(page, value)) {
      return;
    }
  }

  for (const frame of page.frames()) {
    const frameLocator = frame.locator('body[contenteditable="true"], [contenteditable="true"], body').first();
    if (await isUsable(frameLocator, 1200)) {
      await typeIntoLocator(page, frameLocator, value, timeoutMs);
      if (await bodyEditorContains(page, value)) {
        return;
      }
    }
  }

  await fillBodyByCoordinateFallback(page, value);
  if (await bodyEditorContains(page, value) || await activeElementContains(page, value)) {
    return;
  }

  throw new Error("Could not fill body editor.");
}

async function typeIntoLocator(page: Page, locator: Locator, value: string, timeoutMs: number): Promise<void> {
  await locator.click({ timeout: timeoutMs });
  await locator.fill(value, { timeout: timeoutMs }).catch(async () => {
    await locator.evaluate((element) => {
      if (element instanceof HTMLElement) {
        element.focus();
      }
    }).catch(() => undefined);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
    await page.keyboard.insertText(value);
  });
  await page.waitForTimeout(500);

  if (await locatorContains(locator, value) || await bodyEditorContains(page, value)) {
    return;
  }

  await locator.click({ timeout: timeoutMs }).catch(() => undefined);
  await locator.evaluate((element) => {
    if (element instanceof HTMLElement) {
      element.focus();
    }
  }).catch(() => undefined);
  await page.keyboard.insertText(value);
  await page.waitForTimeout(500);
}

async function bodyEditorContains(page: Page, value: string): Promise<boolean> {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) {
      continue;
    }

    const frameText = await frame.locator("body").innerText({ timeout: 800 }).catch(() => "");
    if (frameText.includes(value)) {
      return true;
    }
  }

  return page.evaluate((expected) => {
    return Array.from(document.querySelectorAll("textarea, [contenteditable='true'], [role='textbox']"))
      .some((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        if (rect.width < 120 || rect.height < 80 || style.display === "none" || style.visibility === "hidden") {
          return false;
        }

        const htmlElement = element as HTMLInputElement | HTMLTextAreaElement;
        const text = htmlElement.value || element.textContent || "";
        return text.includes(expected);
      });
  }, value);
}

async function locatorContains(locator: Locator, value: string): Promise<boolean> {
  return locator.evaluate((element, expected) => {
    const htmlElement = element as HTMLInputElement | HTMLTextAreaElement;
    return Boolean((htmlElement.value || element.textContent || "").includes(expected));
  }, value).catch(() => false);
}

async function activeElementContains(page: Page, value: string): Promise<boolean> {
  const mainActive = await page.evaluate((expected) => {
    const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    return Boolean(active && ((active.value || active.textContent || "").includes(expected)));
  }, value).catch(() => false);
  if (mainActive) {
    return true;
  }

  for (const frame of page.frames()) {
    const frameActive = await frame.evaluate((expected) => {
      const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      return Boolean(active && ((active.value || active.textContent || "").includes(expected)));
    }, value).catch(() => false);
    if (frameActive) {
      return true;
    }
  }

  return false;
}

async function fillBodyByCoordinateFallback(page: Page, value: string): Promise<void> {
  const point = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("iframe, textarea, [contenteditable='true'], [role='textbox']"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const visible = rect.width > 80 && rect.height > 40 && style.display !== "none" && style.visibility !== "hidden";
        const score = visible ? rect.width * rect.height + rect.top : 0;
        return {
          x: rect.left + Math.min(rect.width * 0.35, 240),
          y: rect.top + Math.min(rect.height * 0.35, 180),
          score
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score);

    const selected = candidates[0];
    if (selected) {
      return selected;
    }

    return {
      x: Math.round(window.innerWidth * 0.45),
      y: Math.round(window.innerHeight * 0.62),
      score: 1
    };
  });

  await page.mouse.click(point.x, point.y);
  await page.keyboard.insertText(value);
  await page.waitForTimeout(700);
}

async function clickSend(page: Page, timeoutMs: number): Promise<void> {
  await clickFirst(page, timeoutMs, [
    () => page.getByRole("button", { name: /^보내기$|^Send$/i }),
    () => page.getByRole("link", { name: /^보내기$|^Send$/i }),
    () => page.locator("button,a").filter({ hasText: /^보내기$|^Send$/i })
  ]);
}

async function firstUsableLocator(page: Page, timeoutMs: number, candidates: Array<() => Locator>): Promise<Locator | null> {
  for (const makeLocator of candidates) {
    const locator = makeLocator().first();
    if (await isUsable(locator, Math.min(timeoutMs, 2000))) {
      return locator;
    }
  }

  return null;
}

async function clickFirst(page: Page, timeoutMs: number, candidates: Array<() => Locator>): Promise<void> {
  const locator = await firstUsableLocator(page, timeoutMs, candidates);
  if (!locator) {
    throw new Error("Could not find a clickable target.");
  }

  await locator.click({ timeout: timeoutMs });
}

async function isUsable(locator: Locator, timeoutMs: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    return (await locator.count()) > 0;
  } catch {
    return false;
  }
}

async function markHeuristicField(page: Page, kind: "recipient" | "subject" | "body"): Promise<Locator | null> {
  const selector = await page.evaluate((fieldKind) => {
    const candidates = Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 20 && rect.height > 10 && style.display !== "none" && style.visibility !== "hidden";
      })
      .map((element, index) => {
        const html = element as HTMLInputElement | HTMLTextAreaElement;
        const text = [
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.getAttribute("name"),
          element.getAttribute("id"),
          element.getAttribute("class"),
          html.placeholder,
          element.closest("label")?.textContent,
          element.parentElement?.textContent
        ]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ");
        const rect = element.getBoundingClientRect();
        let score = 0;
        if (fieldKind === "recipient" && /받는|수신|recipient|receiver|\bto\b/i.test(text)) score += 50;
        if (fieldKind === "subject" && /제목|subject|title/i.test(text)) score += 50;
        if (fieldKind === "body" && /본문|내용|body|message|editor|content/i.test(text)) score += 40;
        if (fieldKind === "body") score += Math.min(30, Math.round((rect.width * rect.height) / 10000));
        if (fieldKind !== "body" && element.tagName.toLowerCase() === "input") score += 10;
        return { element, index, score };
      })
      .sort((a, b) => b.score - a.score);

    const selected = candidates.find((candidate) => candidate.score > 0);
    if (!selected) {
      return null;
    }

    const attr = `agent-${fieldKind}-${Date.now()}`;
    selected.element.setAttribute("data-agent-target", attr);
    return `[data-agent-target="${attr}"]`;
  }, kind);

  return selector ? page.locator(selector).first() : null;
}

async function waitForSendApproval(confirmFile?: string): Promise<boolean> {
  if (confirmFile) {
    const resolved = path.resolve(confirmFile);
    console.log(`Waiting for confirmation file: ${resolved}`);
    console.log('Write "yes" to send, or "no" to stop.');
    await rm(resolved, { force: true }).catch(() => undefined);

    while (true) {
      const value = await readFile(resolved, "utf8").catch(() => "");
      const normalized = value.trim().toLowerCase();
      if (["yes", "y", "send", "보내기", "승인"].includes(normalized)) return true;
      if (["no", "n", "stop", "취소", "중단"].includes(normalized)) return false;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  if (!process.stdin.isTTY) {
    console.log("Non-interactive shell detected. Send confirmation cannot be collected here.");
    return false;
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question('Type "yes" to send this email: ');
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function updateStatus(
  file: string,
  status: WorkflowStatus["status"],
  message: string,
  draft: NaverMailDraft,
  extra: Partial<Pick<WorkflowStatus, "url" | "screenshotPath">> = {}
): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const payload: WorkflowStatus = {
    status,
    message,
    draft: {
      to: draft.to,
      subject: draft.subject,
      body: draft.body
    },
    ...extra,
    updatedAt: new Date().toISOString()
  };
  await writeFile(file, JSON.stringify(payload, null, 2), "utf8");
}

async function createRunDir(): Promise<string> {
  const dir = path.join(process.cwd(), ".agent-runs", `naver-mail-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function stringValue(values: Map<string, string | boolean>, key: string): string | undefined {
  const value = values.get(key);
  return typeof value === "string" ? value : undefined;
}

function numberValue(values: Map<string, string | boolean>, key: string, defaultValue: number): number {
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

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
}
