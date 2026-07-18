import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseFlagArgs, stringValue, updateStatus } from "../workflows/shared.js";
import { extractNpmScript } from "./checkRecipes.js";

export interface CapturedRecipeStep {
  order: number;
  action: string;
  url?: string;
}

export interface CapturedRecipe {
  id?: string;
  name?: string;
  description?: string;
  provider?: string;
  triggers: string[];
  steps: CapturedRecipeStep[];
  notes: string[];
  tests: Array<Record<string, unknown>>;
  approvalGates: string[];
  command?: string;
  risk?: string;
  profile?: string;
}

export interface RecipeInputState {
  schemaVersion: 1;
  captureId: string;
  status: "collecting" | "completed";
  startedAt: string;
  updatedAt?: string;
  recipe: CapturedRecipe;
}

export interface RecipeInputPaths {
  directory: string;
  activeFile: string;
  completedDirectory: string;
  statusFile: string;
}

export interface RecipeInputOptions {
  rootDir?: string;
  name?: string;
  description?: string;
  provider?: string;
  trigger?: string;
  step?: string;
  action?: string;
  url?: string;
  note?: string;
  test?: string;
  approval?: string;
  command?: string;
  risk?: string;
  profile?: string;
  id?: string;
}

export interface RecipeInputFinishOptions extends RecipeInputOptions {
  output?: string;
  publish?: boolean;
  overwrite?: boolean;
}

export interface RecipeInputFinishResult {
  outputFile: string;
  archiveFile: string;
  recipeId: string;
  recipeStatus: "active" | "draft";
  command: string;
  published: boolean;
}

type RecipeInputAction = "start" | "add" | "finish" | "status";

const DEFAULT_STATUS_FILE = "work/recipe-input/status.json";

async function main(): Promise<void> {
  const values = parseFlagArgs(process.argv.slice(2));
  if (values.get("help") === true) {
    printUsage();
    return;
  }

  const action = parseAction(stringValue(values, "action"));
  const options = parseOptions(values);
  const paths = recipeInputPaths();

  if (action === "start") {
    const state = await startRecipeInput(options, values.get("reset") === true);
    await updateStatus(paths.statusFile, "collecting", "레시피 입력을 시작했습니다.", summaryOf(state));
    return;
  }
  if (action === "add") {
    const state = await addRecipeInput(options);
    await updateStatus(paths.statusFile, "collecting", "레시피 입력 내용을 추가했습니다.", summaryOf(state));
    return;
  }
  if (action === "finish") {
    const result = await finishRecipeInput({
      ...options,
      output: stringValue(values, "output"),
      publish: values.get("publish") === true,
      overwrite: values.get("overwrite") === true
    });
    await updateStatus(paths.statusFile, "completed", "레시피 입력을 저장했습니다.", { ...result });
    return;
  }

  const state = await readRecipeInputState(paths.activeFile);
  await updateStatus(paths.statusFile, state ? "collecting" : "idle", state ? "진행 중인 레시피 입력이 있습니다." : "진행 중인 레시피 입력이 없습니다.", {
    ...(state ? summaryOf(state) : {})
  });
}

export function recipeInputPaths(rootDir = process.cwd()): RecipeInputPaths {
  const directory = path.resolve(rootDir, "work", "recipe-input");
  return {
    directory,
    activeFile: path.join(directory, "active.json"),
    completedDirectory: path.join(directory, "completed"),
    statusFile: path.resolve(rootDir, DEFAULT_STATUS_FILE)
  };
}

export async function startRecipeInput(
  options: RecipeInputOptions = {},
  reset = false
): Promise<RecipeInputState> {
  const rootDir = options.rootDir || process.cwd();
  const paths = recipeInputPaths(rootDir);
  const existing = await readRecipeInputState(paths.activeFile);
  if (existing && !reset) {
    throw new Error("이미 진행 중인 레시피 입력이 있습니다. 내용을 추가하거나 종료한 뒤 새 입력을 시작하세요.");
  }

  const now = new Date().toISOString();
  const state: RecipeInputState = {
    schemaVersion: 1,
    captureId: `recipe-input-${randomUUID()}`,
    status: "collecting",
    startedAt: now,
    updatedAt: now,
    recipe: emptyCapturedRecipe()
  };
  applyRecipeInputOptions(state, options);
  await writeRecipeInputState(paths.activeFile, state);
  return state;
}

export async function addRecipeInput(options: RecipeInputOptions = {}): Promise<RecipeInputState> {
  const paths = recipeInputPaths(options.rootDir || process.cwd());
  const state = await requireRecipeInputState(paths.activeFile);
  if (!hasRecipeInputContent(options)) {
    throw new Error("추가할 레시피 이름, 설명, 호출 문구, 단계, URL, 메모 또는 실행 명령을 지정하세요.");
  }
  applyRecipeInputOptions(state, options);
  state.updatedAt = new Date().toISOString();
  await writeRecipeInputState(paths.activeFile, state);
  return state;
}

export async function finishRecipeInput(options: RecipeInputFinishOptions = {}): Promise<RecipeInputFinishResult> {
  const rootDir = options.rootDir || process.cwd();
  const paths = recipeInputPaths(rootDir);
  const state = await requireRecipeInputState(paths.activeFile);
  if (hasRecipeInputContent(options)) {
    applyRecipeInputOptions(state, options);
  }
  if (!state.recipe.name?.trim()) {
    throw new Error("레시피 입력을 저장하려면 이름을 먼저 지정하세요.");
  }

  state.recipe.description ||= "사용자가 직접 기록한 레시피입니다.";
  state.recipe.provider = normalizeProvider(state.recipe.provider);
  state.recipe.command ||= inferRecipeCommand(state.recipe);
  state.recipe.id = normalizeRecipeId(state.recipe.id || state.recipe.name);
  state.updatedAt = new Date().toISOString();

  const command = state.recipe.command || "manual";
  const packageScripts = await readPackageScripts(rootDir);
  const commandScript = extractNpmScript(command);
  const recipeStatus: "active" | "draft" = commandScript && packageScripts.has(commandScript) ? "active" : "draft";
  const outputFile = resolveRecipeOutput(rootDir, state.recipe, options);
  const existing = await readFile(outputFile, "utf8").catch(() => "");
  if (existing && !options.overwrite) {
    throw new Error(`이미 같은 위치에 레시피가 있습니다: ${outputFile}`);
  }

  const source = renderCapturedRecipe(state, { recipeStatus, command, outputFile, rootDir });
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, source, "utf8");

  state.status = "completed";
  const archiveFile = path.join(paths.completedDirectory, `${state.captureId}.json`);
  await writeRecipeInputState(archiveFile, state);
  await rm(paths.activeFile, { force: true });

  return {
    outputFile,
    archiveFile,
    recipeId: state.recipe.id,
    recipeStatus,
    command,
    published: !isLocalRecipeOutput(rootDir, outputFile)
  };
}

export async function readRecipeInputState(file: string): Promise<RecipeInputState | null> {
  const source = await readFile(file, "utf8").catch(() => "");
  if (!source) {
    return null;
  }
  try {
    return normalizeRecipeInputState(JSON.parse(source) as unknown);
  } catch {
    throw new Error("레시피 입력 상태 파일 형식이 올바르지 않습니다.");
  }
}

export function inferRecipeCommand(recipe: CapturedRecipe): string | undefined {
  if (normalizeProvider(recipe.provider) !== "youtube") {
    return undefined;
  }
  const playlistUrl = recipe.steps.map((step) => step.url).find((url) => isYoutubePlaylistUrl(url));
  if (!playlistUrl) {
    return undefined;
  }
  const normalized = new URL(playlistUrl);
  const playlistId = normalized.searchParams.get("list");
  if (!playlistId) {
    return undefined;
  }
  return `npm run workflow:youtube-playlist-play -- --playlist-url "https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}" --browser chrome`;
}

export function renderCapturedRecipe(
  state: RecipeInputState,
  options: { recipeStatus: "active" | "draft"; command: string; outputFile: string; rootDir: string }
): string {
  const recipe = state.recipe;
  const approvalGates = recipe.approvalGates.length
    ? recipe.approvalGates
    : ["전송, 제출, 공유, 구매, 삭제, 계정 변경, 게시, 민감 정보 입력은 최종 화면에서 명시적으로 승인받는다."];
  const relativeOutput = path.relative(options.rootDir, options.outputFile).replace(/\\/g, "/");
  const provider = normalizeProvider(recipe.provider);
  const profile = recipe.profile || "regular-user";
  const risk = recipe.risk || "low";
  const automationLevel = options.recipeStatus === "active" ? "workflow" : "manual-capture";
  const triggers = recipe.triggers.length ? recipe.triggers : [recipe.name || "레시피 실행"];

  const frontMatter = [
    "---",
    `id: ${yamlScalar(recipe.id || normalizeRecipeId(recipe.name || "recipe"))}`,
    `provider: ${yamlScalar(provider)}`,
    `status: ${options.recipeStatus}`,
    `automationLevel: ${automationLevel}`,
    `risk: ${yamlScalar(risk)}`,
    `profile: ${yamlScalar(profile)}`,
    `command: ${yamlScalar(options.command)}`,
    "approvalGates:",
    ...approvalGates.map((item) => `  - ${yamlScalar(item)}`),
    "outputs:",
    `  - ${yamlScalar(`work/recipe-input/${recipe.id || "recipe"}-status.json`)}`,
    "---"
  ].join("\n");

  const steps = recipe.steps.length
    ? recipe.steps.map((step) => `${step.order}. ${step.action}${step.url ? `\n   - URL: ${step.url}` : ""}`).join("\n")
    : "1. 사용자가 기록한 작업 순서를 확인한 뒤 실행한다.";
  const notes = recipe.notes.length ? recipe.notes.map((note) => `- ${note}`).join("\n") : "- 추가 메모가 없습니다.";
  const tests = recipe.tests.length ? recipe.tests.map(formatTestRecord).join("\n") : "- 아직 실행 검증 기록이 없습니다.";
  const execution =
    options.recipeStatus === "active"
      ? `\`\`\`powershell\n${options.command}\n\`\`\``
      : "자동 실행 workflow가 아직 연결되지 않은 초안입니다. 사용자가 기록한 순서를 수동으로 검증하거나 `--command`로 등록된 workflow를 지정한 뒤 다시 저장합니다.";

  return `${frontMatter}\n\n# ${recipe.name}\n\n## 호출 문구\n\n${triggers.map((trigger) => `- ${trigger}`).join("\n")}\n\n## 설명\n\n${recipe.description}\n\n## 기록된 순서\n\n${steps}\n\n## 실행\n\n${execution}\n\n## 메모\n\n${notes}\n\n## 테스트 기록\n\n${tests}\n\n## 저장 위치\n\n- ${relativeOutput}\n`;
}

function parseAction(value?: string): RecipeInputAction {
  if (value === "start" || value === "add" || value === "finish" || value === "status") {
    return value;
  }
  throw new Error("--action must be start, add, finish, or status.");
}

function parseOptions(values: Map<string, string | boolean>): RecipeInputOptions {
  return {
    name: stringValue(values, "name"),
    description: stringValue(values, "description"),
    provider: stringValue(values, "provider"),
    trigger: stringValue(values, "trigger"),
    step: stringValue(values, "step"),
    action: stringValue(values, "step-action"),
    url: stringValue(values, "url"),
    note: stringValue(values, "note"),
    test: stringValue(values, "test"),
    approval: stringValue(values, "approval"),
    command: stringValue(values, "command"),
    risk: stringValue(values, "risk"),
    profile: stringValue(values, "profile"),
    id: stringValue(values, "id")
  };
}

function applyRecipeInputOptions(state: RecipeInputState, options: RecipeInputOptions): void {
  const recipe = state.recipe;
  if (options.name?.trim()) {
    recipe.name = options.name.trim();
  }
  if (options.description?.trim()) {
    recipe.description = options.description.trim();
  }
  if (options.provider?.trim()) {
    recipe.provider = normalizeProvider(options.provider);
  }
  if (options.command?.trim()) {
    recipe.command = options.command.trim();
  }
  if (options.risk?.trim()) {
    recipe.risk = options.risk.trim();
  }
  if (options.profile?.trim()) {
    recipe.profile = options.profile.trim();
  }
  if (options.id?.trim()) {
    recipe.id = normalizeRecipeId(options.id);
  }
  appendUnique(recipe.triggers, splitList(options.trigger));
  appendUnique(recipe.notes, splitList(options.note));
  appendUnique(recipe.approvalGates, splitList(options.approval));
  if (options.step?.trim() || options.action?.trim() || options.url?.trim()) {
    const url = options.url?.trim() ? normalizeHttpUrl(options.url) : undefined;
    recipe.steps.push({
      order: recipe.steps.length + 1,
      action: options.step?.trim() || options.action?.trim() || "연결한 페이지를 확인한다.",
      ...(url ? { url } : {})
    });
  }
  if (options.test?.trim()) {
    recipe.tests.push({ performedAt: new Date().toISOString(), result: options.test.trim() });
  }
}

function hasRecipeInputContent(options: RecipeInputOptions): boolean {
  return Boolean(
    options.name ||
      options.description ||
      options.provider ||
      options.trigger ||
      options.step ||
      options.action ||
      options.url ||
      options.note ||
      options.test ||
      options.approval ||
      options.command ||
      options.risk ||
      options.profile ||
      options.id
  );
}

function resolveRecipeOutput(rootDir: string, recipe: CapturedRecipe, options: RecipeInputFinishOptions): string {
  const provider = normalizeProvider(recipe.provider);
  const slug = recipe.id || normalizeRecipeId(recipe.name || "recipe");
  const defaultRelative = options.publish ? path.join("recipes", provider, `${slug}.md`) : path.join("recipes", "local", provider, `${slug}.md`);
  const candidate = path.resolve(rootDir, options.output || defaultRelative);
  const recipesRoot = `${path.resolve(rootDir, "recipes")}${path.sep}`;
  if (!candidate.startsWith(recipesRoot) || path.extname(candidate).toLowerCase() !== ".md") {
    throw new Error("레시피 저장 위치는 이 저장소의 recipes/ 아래 Markdown 파일이어야 합니다.");
  }
  return candidate;
}

function isLocalRecipeOutput(rootDir: string, outputFile: string): boolean {
  const localRoot = `${path.resolve(rootDir, "recipes", "local")}${path.sep}`;
  return outputFile.startsWith(localRoot);
}

function normalizeRecipeInputState(value: unknown): RecipeInputState {
  if (!value || typeof value !== "object") {
    throw new Error("invalid state");
  }
  const raw = value as Partial<RecipeInputState>;
  if (raw.schemaVersion !== 1 || !raw.recipe || typeof raw.recipe !== "object") {
    throw new Error("invalid state");
  }
  const rawRecipe = raw.recipe as Partial<CapturedRecipe>;
  const startedAt = typeof raw.startedAt === "string" ? raw.startedAt : new Date().toISOString();
  return {
    schemaVersion: 1,
    captureId: typeof raw.captureId === "string" ? raw.captureId : `recipe-input-${randomUUID()}`,
    status: raw.status === "completed" ? "completed" : "collecting",
    startedAt,
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
    recipe: {
      ...(typeof rawRecipe.id === "string" ? { id: rawRecipe.id } : {}),
      ...(typeof rawRecipe.name === "string" ? { name: rawRecipe.name } : {}),
      ...(typeof rawRecipe.description === "string" ? { description: rawRecipe.description } : {}),
      ...(typeof rawRecipe.provider === "string" ? { provider: rawRecipe.provider } : {}),
      triggers: stringArray(rawRecipe.triggers),
      steps: stepArray(rawRecipe.steps),
      notes: stringArray(rawRecipe.notes),
      tests: recordArray(rawRecipe.tests),
      approvalGates: stringArray(rawRecipe.approvalGates),
      ...(typeof rawRecipe.command === "string" ? { command: rawRecipe.command } : {}),
      ...(typeof rawRecipe.risk === "string" ? { risk: rawRecipe.risk } : {}),
      ...(typeof rawRecipe.profile === "string" ? { profile: rawRecipe.profile } : {})
    }
  };
}

function emptyCapturedRecipe(): CapturedRecipe {
  return {
    triggers: [],
    steps: [],
    notes: [],
    tests: [],
    approvalGates: []
  };
}

function stepArray(value: unknown): CapturedRecipeStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const step = item as Partial<CapturedRecipeStep>;
      if (typeof step.action !== "string") {
        return null;
      }
      return {
        order: typeof step.order === "number" ? step.order : index + 1,
        action: step.action,
        ...(typeof step.url === "string" ? { url: step.url } : {})
      };
    })
    .filter((item): item is CapturedRecipeStep => item !== null);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

async function requireRecipeInputState(file: string): Promise<RecipeInputState> {
  const state = await readRecipeInputState(file);
  if (!state || state.status !== "collecting") {
    throw new Error("진행 중인 레시피 입력이 없습니다. 먼저 recipes:input:start를 실행하세요.");
  }
  return state;
}

async function writeRecipeInputState(file: string, state: RecipeInputState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2), "utf8");
}

async function readPackageScripts(rootDir: string): Promise<Set<string>> {
  const source = await readFile(path.resolve(rootDir, "package.json"), "utf8");
  const packageJson = JSON.parse(source) as { scripts?: Record<string, string> };
  return new Set(Object.keys(packageJson.scripts || {}));
}

function normalizeProvider(value?: string): string {
  const normalized = value?.trim().toLowerCase() || "custom";
  if (["youtube", "you tube", "유튜브"].includes(normalized)) {
    return "youtube";
  }
  if (["google", "구글"].includes(normalized)) {
    return "google";
  }
  if (["naver", "네이버"].includes(normalized)) {
    return "naver";
  }
  const safe = normalized.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "custom";
}

function normalizeRecipeId(value: string): string {
  const source = value.trim().toLowerCase();
  const ascii = source.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (ascii) {
    return ascii.slice(0, 80);
  }
  return `recipe-${createHash("sha256").update(value).digest("hex").slice(0, 10)}`;
}

function normalizeHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("레시피 URL은 http 또는 https 주소여야 합니다.");
  }
  return url.toString();
}

function isYoutubePlaylistUrl(value?: string): boolean {
  if (!value) {
    return false;
  }
  try {
    const url = new URL(value);
    return ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname.toLowerCase()) && url.pathname === "/playlist" && Boolean(url.searchParams.get("list"));
  } catch {
    return false;
  }
}

function splitList(value?: string): string[] {
  return value
    ? value
        .split("|")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function appendUnique(target: string[], values: string[]): void {
  for (const value of values) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function summaryOf(state: RecipeInputState): Record<string, unknown> {
  return {
    captureId: state.captureId,
    name: state.recipe.name,
    provider: state.recipe.provider,
    triggerCount: state.recipe.triggers.length,
    stepCount: state.recipe.steps.length,
    noteCount: state.recipe.notes.length,
    testCount: state.recipe.tests.length
  };
}

function formatTestRecord(test: Record<string, unknown>, index: number): string {
  const result = typeof test.result === "string" ? test.result : "기록됨";
  const performedAt = typeof test.performedAt === "string" ? test.performedAt : "시간 미기록";
  const lines = [`${index + 1}. ${performedAt}: ${result}`];
  appendTestValue(lines, "브라우저", test.browser);
  appendTestValue(lines, "확인", test.verified);
  appendTestValue(lines, "미확인", test.notVerified);
  appendTestValue(lines, "상태 파일", test.statusFile);
  appendTestValue(lines, "스크린샷", test.screenshotFile);
  appendTestValue(lines, "실행 로그", test.runLog);
  appendTestValue(lines, "소요 시간", typeof test.elapsedSeconds === "number" ? `${Math.floor(test.elapsedSeconds)}초` : undefined);
  return lines.join("\n");
}

function appendTestValue(lines: string[], label: string, value: unknown): void {
  if (typeof value === "string" && value) {
    lines.push(`   - ${label}: ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    const values = value.filter((item): item is string => typeof item === "string");
    if (values.length) {
      lines.push(`   - ${label}: ${values.join(", ")}`);
    }
  }
}

function printUsage(): void {
  console.log(`레시피 입력 명령\n\n` +
    `npm run recipes:input:start -- --name "레시피 이름" --description "설명"\n` +
    `npm run recipes:input:add -- --trigger "호출 문구" --step "수행 순서" --url "https://..."\n` +
    `npm run recipes:input:finish\n` +
    `npm run recipes:input:finish -- --publish --id "public-recipe-id"\n` +
    `npm run recipes:input:status\n\n` +
    `기본 저장 위치는 Git에서 제외되는 recipes/local/입니다.`);
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
