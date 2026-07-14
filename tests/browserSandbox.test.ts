import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Chromium sandbox policy", () => {
  it("keeps every Chromium launch sandboxed", async () => {
    const files = [
      ...(await findTypeScriptFiles(path.resolve("src"))),
      ...(await findTypeScriptFiles(path.resolve("tests")))
    ];
    const forbidden: string[] = [];
    const missingSandbox: string[] = [];
    let launchCount = 0;
    const noSandboxFlag = ["--no", "sandbox"].join("-");
    const sandboxDisabled = new RegExp("chromiumSandbox\\s*:\\s*false");

    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (source.includes(noSandboxFlag) || sandboxDisabled.test(source)) {
        forbidden.push(path.relative(process.cwd(), file));
      }

      const launchPattern = /chromium\.launch(?:PersistentContext)?\s*\(/g;
      for (const match of source.matchAll(launchPattern)) {
        launchCount += 1;
        const snippet = source.slice(match.index, match.index + 700);
        if (!/chromiumSandbox\s*:\s*true/.test(snippet)) {
          missingSandbox.push(`${path.relative(process.cwd(), file)}:${lineNumber(source, match.index)}`);
        }
      }
    }

    expect(launchCount).toBeGreaterThan(0);
    expect(forbidden).toEqual([]);
    expect(missingSandbox).toEqual([]);
  });
});

async function findTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findTypeScriptFiles(fullPath)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split(/\r?\n/).length;
}
