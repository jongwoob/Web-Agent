import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export interface RecipeMetadata {
  id: string;
  provider: string;
  status: string;
  automationLevel: string;
  risk: string;
  profile: string;
  command: string;
  approvalGates: string;
  outputs: string;
}

export interface RecipeCheckResult {
  ok: boolean;
  files: string[];
  errors: string[];
}

const requiredFields = [
  "id",
  "provider",
  "status",
  "automationLevel",
  "risk",
  "profile",
  "command",
  "approvalGates",
  "outputs"
] as const;

const reviewedActiveNaverRecipes = new Set([
  "naver.mail.draft-send",
  "naver.mail.search-read",
  "naver.search-shopping.extract"
]);

async function main(): Promise<void> {
  const result = await checkRecipes();
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(error);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`recipes: ${result.files.length} checked`);
}

export async function checkRecipes(
  recipesRoot = path.resolve("recipes"),
  packageJsonPath = path.resolve("package.json")
): Promise<RecipeCheckResult> {
  const files = await findRecipeFiles(recipesRoot);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
  const scripts = new Set(Object.keys(packageJson.scripts || {}));
  const errors: string[] = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const metadata = parseRecipeFrontMatter(source, file);
    for (const field of requiredFields) {
      if (!metadata[field]) {
        errors.push(`${file}: missing front matter field "${field}"`);
      }
    }

    const commandScript = extractNpmScript(metadata.command);
    if (metadata.status === "active" && commandScript && !scripts.has(commandScript)) {
      errors.push(`${file}: command references missing package script "${commandScript}"`);
    }

    if (metadata.provider === "naver" && !reviewedActiveNaverRecipes.has(metadata.id) && metadata.status === "active") {
      errors.push(`${file}: new Naver automation recipes must not be active before operating guidelines review`);
    }
  }

  return {
    ok: errors.length === 0,
    files,
    errors
  };
}

export async function findRecipeFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findRecipeFiles(fullPath)));
      continue;
    }
    if (!entry.name.endsWith(".md") || entry.name === "README.md" || entry.name === "_template.md") {
      continue;
    }
    files.push(fullPath);
  }
  return files.sort();
}

export function parseRecipeFrontMatter(source: string, file = "recipe"): RecipeMetadata {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error(`${file}: missing YAML front matter`);
  }

  const metadata: Record<string, string> = {};
  let currentKey: string | undefined;
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (field) {
      currentKey = field[1];
      metadata[currentKey] = stripQuotes(field[2].trim());
      continue;
    }

    const listItem = line.match(/^\s*-\s*(.*)$/);
    if (listItem && currentKey) {
      metadata[currentKey] = [metadata[currentKey], stripQuotes(listItem[1].trim())].filter(Boolean).join(" | ");
    }
  }

  return metadata as unknown as RecipeMetadata;
}

export function extractNpmScript(command: string): string | null {
  const match = command.match(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/);
  return match?.[1] || null;
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
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
