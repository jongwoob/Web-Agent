import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type ElementHandle, type Page } from "playwright";
import { runProviderPreflight } from "./providerPreflight.js";
import { installPageEvaluateRuntime } from "./shared.js";

type BrowserChoice = "chromium" | "chrome" | "edge";
type QuestionType = "객관식 질문" | "체크박스" | "드롭다운" | "선형 배율" | "단답형" | "장문형";

interface WorkflowArgs {
  browser: BrowserChoice;
  formFile?: string;
  editUrl?: string;
  headless: boolean;
  timeoutMs: number;
  loginTimeoutMs: number;
  statusFile: string;
  screenshotFile: string;
  inspectFile: string;
  verifyOnly: boolean;
}

interface FormSpec {
  title: string;
  description: string;
  questions: QuestionSpec[];
}

interface QuestionSpec {
  title: string;
  type: QuestionType;
  options?: string[];
  lowLabel?: string;
  highLabel?: string;
}

interface InputSnapshot {
  aria: string;
  placeholder: string;
  value: string;
}

interface QuestionSnapshot {
  title: string;
  inferredType: QuestionType | "unknown";
  optionValues: string[];
  inputValues: InputSnapshot[];
  text: string;
}

interface FormInspection {
  editUrl: string;
  title: string;
  description: string;
  questions: QuestionSnapshot[];
  updatedAt: string;
}

interface VerificationResult {
  ok: boolean;
  missing: string[];
  questionCount: number;
  expectedQuestionCount: number;
}

const DEFAULT_STATUS_FILE = "work/google-forms-jarvis-status.json";
const DEFAULT_SCREENSHOT_FILE = "work/google-forms-jarvis-verified.png";
const DEFAULT_INSPECT_FILE = "work/google-forms-jarvis-inspect.json";

const questionTypeAliases = new Map<string, QuestionType>([
  ["multiple_choice", "객관식 질문"],
  ["multiple choice", "객관식 질문"],
  ["radio", "객관식 질문"],
  ["객관식", "객관식 질문"],
  ["객관식 질문", "객관식 질문"],
  ["checkbox", "체크박스"],
  ["checkboxes", "체크박스"],
  ["체크박스", "체크박스"],
  ["dropdown", "드롭다운"],
  ["드롭다운", "드롭다운"],
  ["linear_scale", "선형 배율"],
  ["linear scale", "선형 배율"],
  ["scale", "선형 배율"],
  ["선형 배율", "선형 배율"],
  ["short_answer", "단답형"],
  ["short answer", "단답형"],
  ["단답형", "단답형"],
  ["paragraph", "장문형"],
  ["long_answer", "장문형"],
  ["장문형", "장문형"]
]);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(path.dirname(path.resolve(args.statusFile)), { recursive: true });

  if (!args.formFile) {
    await updateStatus(args.statusFile, "blocked", "Missing --form-file. Create a UTF-8 approved form JSON first, then rerun the workflow.", {
      requiredShape: {
        title: "설문 제목",
        description: "설문 설명",
        questions: [
          {
            title: "질문",
            type: "객관식 질문",
            options: ["선택지 1", "선택지 2"]
          }
        ]
      }
    });
    return;
  }

  const spec = await loadFormSpec(args.formFile);
  const started = Date.now();
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  try {
    await updateStatus(args.statusFile, "starting", "Launching Google Forms creation workflow.", {
      formFile: args.formFile,
      targetUrl: args.editUrl || "https://forms.new"
    });

    context = await chromium.launchPersistentContext(profileDirFor(args.browser), {
      channel: browserChannel(args.browser),
      headless: args.headless,
      chromiumSandbox: true,
      locale: "ko-KR",
      viewport: { width: 1360, height: 920 },
      acceptDownloads: true
    });
    await installPageEvaluateRuntime(context);
    context.setDefaultTimeout(args.timeoutMs);
    context.setDefaultNavigationTimeout(Math.max(args.timeoutMs, 90000));

    page = context.pages()[0] || (await context.newPage());
    await page.bringToFront();
    await openFormsEditor(page, args);
    if (!args.verifyOnly) {
      await createOrUpdateForm(page, spec);
      await waitForSaved(page);
    }

    const inspection = await inspectFormEditor(page);
    const verification = verifyInspectedForm(spec, inspection);
    await mkdir(path.dirname(path.resolve(args.inspectFile)), { recursive: true });
    await writeFile(args.inspectFile, JSON.stringify(inspection, null, 2), "utf8");
    await page.screenshot({ path: args.screenshotFile, fullPage: true });

    if (!verification.ok) {
      await updateStatus(args.statusFile, "failed", `Verification found missing items: ${verification.missing.join(", ")}`, {
        editUrl: inspection.editUrl,
        publishStatus: "not_published",
        shareStatus: "not_shared",
        screenshotFile: args.screenshotFile,
        inspectFile: args.inspectFile,
        verification,
        elapsedMs: Date.now() - started
      });
      process.exitCode = 1;
      return;
    }

    await updateStatus(args.statusFile, "completed", args.verifyOnly ? "Google Form was verified in the editor." : "Google Form was created and verified in the editor.", {
      editUrl: inspection.editUrl,
      publishStatus: "not_published",
      shareStatus: "not_shared",
      screenshotFile: args.screenshotFile,
      inspectFile: args.inspectFile,
      verification,
      elapsedMs: Date.now() - started
    });

    if (!args.headless) {
      console.log("Form is ready in the editor. Publish/share was not clicked.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (page) {
      await page.screenshot({ path: args.screenshotFile, fullPage: true }).catch(() => undefined);
    }
    await updateStatus(args.statusFile, "failed", message, {
      editUrl: page?.url(),
      publishStatus: "not_published",
      shareStatus: "not_shared",
      screenshotFile: args.screenshotFile,
      elapsedMs: Date.now() - started
    });
    throw error;
  } finally {
    await context?.close().catch(() => undefined);
  }
}

async function openFormsEditor(page: Page, args: WorkflowArgs): Promise<void> {
  const targetUrl = args.editUrl || "https://forms.new";
  await runProviderPreflight(page, {
    provider: "google",
    targetUrl,
    statusFile: args.statusFile,
    timeoutMs: args.timeoutMs,
    loginTimeoutMs: args.loginTimeoutMs,
    headless: args.headless
  });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(3000);

  await page.waitForURL(/docs\.google\.com\/forms\/d\/.+\/edit/i, { timeout: 90000 }).catch(() => undefined);
  await page.locator('input[aria-label="문서 제목"], [contenteditable="true"][aria-label="설문지 제목"]').first().waitFor({
    state: "visible",
    timeout: 90000
  });
}

async function createOrUpdateForm(page: Page, spec: FormSpec): Promise<void> {
  const docTitle = page.locator('input[aria-label="문서 제목"]').first();
  if (await docTitle.isVisible({ timeout: 5000 }).catch(() => false)) {
    await docTitle.fill(spec.title);
  }

  await setEditable(page, "설문지 제목", spec.title);
  await setEditable(page, "설문지 설명", spec.description);

  for (let index = 0; index < spec.questions.length; index += 1) {
    if (index > 0) {
      await addQuestion(page);
    }
    await fillQuestion(page, spec.questions[index]);
  }
}

async function fillQuestion(page: Page, question: QuestionSpec): Promise<void> {
  await setEditable(page, "질문", question.title, "last");
  await setQuestionType(page, question.type);

  if (question.options?.length) {
    await fillOptions(page, question.options);
  }

  if (question.type === "선형 배율") {
    await fillScaleLabels(page, question.lowLabel, question.highLabel);
  }

  await page.waitForTimeout(700);
}

async function addQuestion(page: Page): Promise<void> {
  await page.getByRole("button", { name: "질문 추가" }).first().click({ timeout: 15000, force: true });
  await page.waitForTimeout(1200);
}

async function setEditable(page: Page, label: string, text: string, nth: number | "last" = 0): Promise<void> {
  const loc = page.locator(`[contenteditable="true"][aria-label="${label}"]`);
  const target = nth === "last" ? loc.last() : loc.nth(nth);
  await target.scrollIntoViewIfNeeded();
  await target.click({ timeout: 15000, force: true });
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text, { delay: 1 });
  await page.waitForTimeout(300);
}

async function setQuestionType(page: Page, type: QuestionType): Promise<void> {
  const picker = page.locator('[role="listbox"][aria-label="질문 유형"]').last();
  await picker.click({ timeout: 15000, force: true });
  await page.waitForTimeout(300);
  await page.getByRole("option", { name: type, exact: true }).last().click({ timeout: 15000, force: true });
  await page.waitForTimeout(700);
}

async function fillOptions(page: Page, options: string[]): Promise<void> {
  const firstOption = page.locator('input[aria-label="옵션 값"]').last();
  await firstOption.click({ timeout: 15000, force: true });
  await firstOption.fill("");
  await pasteText(page, options.join("\n"));
  await page.waitForTimeout(1400);
  await normalizeCurrentOptions(page, options);
}

async function pasteText(page: Page, text: string): Promise<void> {
  const copied = await page
    .evaluate(async (value) => {
      await navigator.clipboard.writeText(value);
      return true;
    }, text)
    .catch(() => false);

  if (copied) {
    await page.keyboard.press("Control+V");
    return;
  }

  await page.keyboard.insertText(text);
}

async function normalizeCurrentOptions(page: Page, expected: string[]): Promise<void> {
  let card = await currentQuestionCard(page);
  let inputs = await visibleInputs(card, 'input[aria-label="옵션 값"]');

  for (let index = 0; index < expected.length; index += 1) {
    if (!inputs[index]) {
      const addInput = (await visibleInputs(card, 'input[aria-label="옵션 추가"]'))[0];
      if (!addInput) {
        throw new Error(`Missing option input ${index + 1} for "${expected[index]}".`);
      }
      await addInput.fill(expected[index]);
      await page.waitForTimeout(400);
      card = await currentQuestionCard(page);
      inputs = await visibleInputs(card, 'input[aria-label="옵션 값"]');
      continue;
    }

    const actual = await inputs[index].inputValue();
    if (actual !== expected[index]) {
      await inputs[index].fill(expected[index]);
      await page.waitForTimeout(250);
    }
  }

  inputs = await visibleInputs(await currentQuestionCard(page), 'input[aria-label="옵션 값"]');
  const actual = [];
  for (let index = 0; index < expected.length; index += 1) {
    actual.push(await inputs[index].inputValue());
  }

  if (actual.join("\n") !== expected.join("\n")) {
    throw new Error(`Option normalization failed. Expected ${expected.join(" / ")}, got ${actual.join(" / ")}`);
  }
}

async function fillScaleLabels(page: Page, lowLabel?: string, highLabel?: string): Promise<void> {
  const card = await currentQuestionCard(page);
  const inputs = await visibleInputs(card, "input");
  const labelInputs = [];

  for (const input of inputs) {
    const aria = (await input.getAttribute("aria-label")) || "";
    const placeholder = (await input.getAttribute("placeholder")) || "";
    if (/라벨|label/i.test(`${aria} ${placeholder}`)) {
      labelInputs.push(input);
    }
  }

  if (labelInputs[0] && lowLabel) {
    await labelInputs[0].fill(lowLabel);
  }

  if (labelInputs[1] && highLabel) {
    await labelInputs[1].fill(highLabel);
  }
}

async function currentQuestionCard(page: Page): Promise<ElementHandle<Element>> {
  const questionBox = await page.locator('[contenteditable="true"][aria-label="질문"]').last().elementHandle();
  if (!questionBox) {
    throw new Error("Could not find the current question box.");
  }

  const cardHandle = await questionBox.evaluateHandle((element) => {
    let current: Element | null = element;
    while (current?.parentElement) {
      const rect = current.getBoundingClientRect();
      if (
        rect.width > 600 &&
        rect.height > 80 &&
        current.querySelector('[role="listbox"][aria-label="질문 유형"]')
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return element.parentElement;
  });

  const card = cardHandle.asElement();
  if (!card) {
    throw new Error("Could not resolve the current question card.");
  }
  return card;
}

async function visibleInputs(root: ElementHandle<Element>, selector: string): Promise<ElementHandle<HTMLInputElement>[]> {
  const handles = await root.$$(selector);
  const visible: ElementHandle<HTMLInputElement>[] = [];
  for (const handle of handles) {
    const isVisible = await handle.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    if (isVisible) {
      visible.push(handle as ElementHandle<HTMLInputElement>);
    }
  }
  return visible;
}

async function waitForSaved(page: Page): Promise<void> {
  await page.waitForTimeout(3000);
  await page.waitForFunction(
    () =>
      document.body.innerText.includes("드라이브에 저장됨") ||
      document.body.innerText.includes("모든 변경사항이 Drive에 저장됨") ||
      document.body.innerText.includes("All changes saved in Drive"),
    undefined,
    { timeout: 45000 }
  ).catch(() => undefined);
}

async function inspectFormEditor(page: Page): Promise<FormInspection> {
  await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(4000);
  await scrollEditorTo(page, 0);
  await page.waitForTimeout(500);

  const formMeta = await page.evaluate(() => ({
    title: (document.querySelector('[contenteditable="true"][aria-label="설문지 제목"]')?.textContent || "").replace(/\s+/g, " ").trim(),
    description: (document.querySelector('[contenteditable="true"][aria-label="설문지 설명"]')?.textContent || "").replace(/\s+/g, " ").trim()
  }));

  const byTitle = new Map<string, QuestionSnapshot>();
  for (let step = 0; step < 36; step += 1) {
    const cards = await extractVisibleQuestionCards(page);
    for (const card of cards) {
      if (card.title && !byTitle.has(card.title)) {
        byTitle.set(card.title, card);
      }
    }

    const moved = await page.evaluate(() => {
      const scroller = Array.from(document.querySelectorAll("div")).find((element) => {
        const style = window.getComputedStyle(element);
        return style.overflowY === "auto" && element.scrollHeight > element.clientHeight + 100;
      });
      if (!scroller) {
        return false;
      }
      const before = scroller.scrollTop;
      scroller.scrollTop += Math.floor(scroller.clientHeight * 0.65);
      return scroller.scrollTop !== before;
    });
    await page.waitForTimeout(300);
    if (!moved) {
      break;
    }
  }

  return {
    editUrl: page.url(),
    title: formMeta.title,
    description: formMeta.description,
    questions: Array.from(byTitle.values()),
    updatedAt: new Date().toISOString()
  };
}

async function scrollEditorTo(page: Page, top: number): Promise<void> {
  await page.evaluate((targetTop) => {
    const scroller = Array.from(document.querySelectorAll("div")).find((element) => {
      const style = window.getComputedStyle(element);
      return style.overflowY === "auto" && element.scrollHeight > element.clientHeight + 100;
    });
    if (scroller) {
      scroller.scrollTop = targetTop;
    }
  }, top);
}

async function extractVisibleQuestionCards(page: Page): Promise<QuestionSnapshot[]> {
  const snapshots = await page.evaluate(() => {
    const compactText = (value: string): string => value.replace(/\s+/g, " ").trim();

    const isVisible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 90 &&
        rect.top < window.innerHeight - 30 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };

    const cardFor = (element: Element): Element | null => {
      let current: Element | null = element;
      while (current?.parentElement) {
        const rect = current.getBoundingClientRect();
        if (
          rect.width > 600 &&
          rect.width < 1200 &&
          rect.height > 70 &&
          current.querySelector('[role="listbox"][aria-label="질문 유형"]') &&
          current.querySelector('[contenteditable="true"][aria-label="질문"]')
        ) {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    };

    const cards = Array.from(document.querySelectorAll('[contenteditable="true"][aria-label="질문"]'))
      .map(cardFor)
      .filter((card): card is Element => Boolean(card))
      .filter((card, index, array) => array.indexOf(card) === index)
      .filter(isVisible);

    return cards.map((card) => {
      const title = compactText(card.querySelector('[contenteditable="true"][aria-label="질문"]')?.textContent || "");
      const optionValues = Array.from(card.querySelectorAll<HTMLInputElement>('input[aria-label="옵션 값"]'))
        .map((input) => input.value)
        .filter(Boolean);
      const inputValues = Array.from(card.querySelectorAll<HTMLInputElement>("input"))
        .map((input) => ({
          aria: input.getAttribute("aria-label") || "",
          placeholder: input.getAttribute("placeholder") || "",
          value: input.value || ""
        }))
        .filter((item) => item.value || item.placeholder || item.aria);
      const text = compactText(card.textContent || "");
      const inferredType = (() => {
        if (inputValues.some((input) => input.aria === "장문형 텍스트")) {
          return "장문형";
        }
        if (inputValues.some((input) => input.aria === "단답형 텍스트")) {
          return "단답형";
        }
        if (
          inputValues.some((input) => /스케일 .*라벨|scale .*label/i.test(input.aria)) ||
          /012345678910|12345/.test(text)
        ) {
          return "선형 배율";
        }
        if (optionValues.length > 0 && text.includes("최소 선택 개수")) {
          return "체크박스";
        }
        if (optionValues.length > 0) {
          return "객관식 질문";
        }
        return "unknown";
      })();
      return {
        title,
        inferredType,
        optionValues,
        inputValues,
        text
      };
    });
  });
  return snapshots as QuestionSnapshot[];
}

export function verifyInspectedForm(spec: FormSpec, inspection: FormInspection): VerificationResult {
  const missing: string[] = [];
  if (inspection.title !== spec.title) {
    missing.push(`title "${spec.title}"`);
  }
  if (inspection.description !== spec.description) {
    missing.push(`description "${spec.description}"`);
  }

  for (const expected of spec.questions) {
    const card = inspection.questions.find((question) => question.title === expected.title);
    if (!card) {
      missing.push(`question "${expected.title}"`);
      continue;
    }

    if (card.inferredType !== expected.type) {
      missing.push(`type "${expected.type}" in "${expected.title}"`);
    }

    const expectedOptions = expected.options || [];
    if (expectedOptions.length > 0) {
      const actualOptions = card.optionValues.slice(0, expectedOptions.length);
      if (actualOptions.join("\n") !== expectedOptions.join("\n")) {
        missing.push(`options in "${expected.title}"`);
      }
    }

    if (expected.type === "선형 배율") {
      for (const label of [expected.lowLabel, expected.highLabel].filter((value): value is string => Boolean(value))) {
        const hasLabel =
          card.text.includes(label) ||
          card.inputValues.some((input) => input.value === label || input.aria.includes(label));
        if (!hasLabel) {
          missing.push(`scale label "${label}" in "${expected.title}"`);
        }
      }
    }
  }

  return {
    ok: missing.length === 0 && inspection.questions.length === spec.questions.length,
    missing:
      inspection.questions.length === spec.questions.length
        ? missing
        : [...missing, `question count ${inspection.questions.length}/${spec.questions.length}`],
    questionCount: inspection.questions.length,
    expectedQuestionCount: spec.questions.length
  };
}

function inferQuestionTypeFromCard(card: Pick<QuestionSnapshot, "optionValues" | "inputValues" | "text">): QuestionType | "unknown" {
  if (card.inputValues.some((input) => input.aria === "장문형 텍스트")) {
    return "장문형";
  }
  if (card.inputValues.some((input) => input.aria === "단답형 텍스트")) {
    return "단답형";
  }
  if (
    card.inputValues.some((input) => /스케일 .*라벨|scale .*label/i.test(input.aria)) ||
    /012345678910|12345/.test(card.text)
  ) {
    return "선형 배율";
  }
  if (card.optionValues.length > 0 && card.text.includes("최소 선택 개수")) {
    return "체크박스";
  }
  if (card.optionValues.length > 0) {
    return "객관식 질문";
  }
  return "unknown";
}

export async function loadFormSpec(file: string): Promise<FormSpec> {
  const resolved = path.resolve(file);
  if (!existsSync(resolved)) {
    throw new Error(`Form file does not exist: ${resolved}`);
  }

  const raw = JSON.parse(await readFile(resolved, "utf8")) as unknown;
  return validateFormSpec(raw);
}

export function validateFormSpec(value: unknown): FormSpec {
  if (!isRecord(value)) {
    throw new Error("Form spec must be a JSON object.");
  }

  const title = requiredString(value.title, "title");
  const description = requiredString(value.description, "description");
  if (!Array.isArray(value.questions) || value.questions.length === 0) {
    throw new Error("Form spec must include a non-empty questions array.");
  }

  const questions = value.questions.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Question ${index + 1} must be an object.`);
    }
    const type = normalizeQuestionType(requiredString(item.type, `questions[${index}].type`));
    const question: QuestionSpec = {
      title: requiredString(item.title, `questions[${index}].title`),
      type
    };

    if (Array.isArray(item.options)) {
      question.options = item.options.map((option, optionIndex) =>
        requiredString(option, `questions[${index}].options[${optionIndex}]`)
      );
    }

    if (typeof item.lowLabel === "string") {
      question.lowLabel = item.lowLabel;
    }
    if (typeof item.highLabel === "string") {
      question.highLabel = item.highLabel;
    }

    if ((type === "객관식 질문" || type === "체크박스" || type === "드롭다운") && (!question.options || question.options.length === 0)) {
      throw new Error(`Question "${question.title}" of type ${type} must include options.`);
    }
    if (type === "선형 배율" && (!question.lowLabel || !question.highLabel)) {
      throw new Error(`Question "${question.title}" of type 선형 배율 must include lowLabel and highLabel.`);
    }

    return question;
  });

  return { title, description, questions };
}

function normalizeQuestionType(value: string): QuestionType {
  const normalized = value.trim().toLowerCase();
  const type = questionTypeAliases.get(normalized);
  if (!type) {
    throw new Error(`Unsupported question type: ${value}`);
  }
  return type;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  const statusFile = stringValue(values, "status-file") || DEFAULT_STATUS_FILE;
  return {
    browser: parseBrowser(stringValue(values, "browser")),
    formFile: stringValue(values, "form-file") || stringValue(values, "approved-form-file"),
    editUrl: stringValue(values, "edit-url"),
    headless: values.get("headless") === true && values.get("headful") !== true,
    timeoutMs: numberValue(values, "timeout-ms", 30000),
    loginTimeoutMs: numberValue(values, "login-timeout-ms", 600000),
    statusFile,
    screenshotFile: stringValue(values, "screenshot-file") || siblingOutputFile(statusFile, DEFAULT_SCREENSHOT_FILE),
    inspectFile: stringValue(values, "inspect-file") || siblingOutputFile(statusFile, DEFAULT_INSPECT_FILE),
    verifyOnly: values.get("verify-only") === true
  };
}

function siblingOutputFile(statusFile: string, fallback: string): string {
  if (!statusFile) {
    return fallback;
  }
  const parsed = path.parse(statusFile);
  const base = parsed.name.replace(/-status$/, "");
  return path.join(parsed.dir || "work", `${base}${fallback.endsWith(".png") ? "-verified.png" : "-inspect.json"}`);
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

function parseBrowser(value?: string): BrowserChoice {
  if (!value) {
    return "chrome";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "chrome" || normalized === "google-chrome") {
    return "chrome";
  }
  if (normalized === "edge" || normalized === "msedge" || normalized === "microsoft-edge") {
    return "edge";
  }
  if (normalized === "chromium") {
    return "chromium";
  }
  throw new Error("--browser must be chromium, chrome, or edge.");
}

function browserChannel(browser: BrowserChoice): "chrome" | "msedge" | undefined {
  if (browser === "chrome") {
    return "chrome";
  }
  if (browser === "edge") {
    return "msedge";
  }
  return undefined;
}

function profileDirFor(browser: BrowserChoice): string {
  if (browser === "chrome") {
    return path.resolve(".browser-profiles/google-forms-chrome");
  }
  if (browser === "edge") {
    return path.resolve(".browser-profiles/google-forms-edge");
  }
  return path.resolve(".browser-profiles/google-forms-chromium");
}

async function updateStatus(file: string, status: string, message: string, extra: Record<string, unknown> = {}): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const payload = {
    status,
    message,
    updatedAt: new Date().toISOString(),
    ...extra
  };
  await writeFile(file, JSON.stringify(payload, null, 2), "utf8");
  console.log(`${status}: ${message}`);
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
