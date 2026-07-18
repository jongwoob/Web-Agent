import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addRecipeInput,
  finishRecipeInput,
  recipeInputPaths,
  readRecipeInputState,
  startRecipeInput
} from "../src/recipes/recipeInput.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("recipe input workflow", () => {
  it("starts with no metadata and records later conversational details", async () => {
    const root = await createTemporaryRoot();
    const started = await startRecipeInput({ rootDir: root });

    expect(started.status).toBe("collecting");
    await addRecipeInput({
      rootDir: root,
      name: "기도 찬양",
      description: "기도할 때 재생할 찬양 재생목록입니다.",
      provider: "YouTube",
      trigger: "기도 찬양 틀어줘 | 기도할 때 찬양 틀어줘",
      step: "YouTube 홈을 먼저 연 뒤 재생목록을 연다.",
      url: "https://youtube.com/playlist?list=PL123&si=tracking",
      note: "로그인은 실제로 필요할 때만 직접 진행한다."
    });

    const state = await readRecipeInputState(recipeInputPaths(root).activeFile);
    expect(state?.recipe.name).toBe("기도 찬양");
    expect(state?.recipe.provider).toBe("youtube");
    expect(state?.recipe.triggers).toHaveLength(2);
    expect(state?.recipe.steps[0]).toMatchObject({ order: 1, url: "https://youtube.com/playlist?list=PL123&si=tracking" });
  });

  it("finishes a known YouTube capture as an active local recipe and archives the input", async () => {
    const root = await createTemporaryRoot({ "workflow:youtube-playlist-play": "tsx workflow.ts" });
    await startRecipeInput({
      rootDir: root,
      name: "기도 찬양",
      description: "기도할 때 재생할 찬양 재생목록입니다.",
      provider: "YouTube",
      id: "prayer-praise",
      trigger: "기도 찬양 틀어줘",
      step: "모두 재생을 누른다.",
      url: "https://youtube.com/playlist?list=PL123&si=tracking"
    });

    const result = await finishRecipeInput({ rootDir: root });
    const saved = await readFile(result.outputFile, "utf8");

    expect(result.recipeStatus).toBe("active");
    expect(result.published).toBe(false);
    expect(result.outputFile).toBe(path.join(root, "recipes", "local", "youtube", "prayer-praise.md"));
    expect(saved).toContain("status: active");
    expect(saved).toContain("workflow:youtube-playlist-play");
    expect(saved).toContain("# 기도 찬양");
    expect(await readRecipeInputState(recipeInputPaths(root).activeFile)).toBeNull();
    expect(await readFile(result.archiveFile, "utf8")).toContain("\"status\": \"completed\"");
  });

  it("keeps an unknown command as a draft and publishes only when explicitly requested", async () => {
    const root = await createTemporaryRoot();
    await startRecipeInput({
      rootDir: root,
      name: "수동 블로그 예약",
      description: "블로그 예약 발행 순서를 기록합니다.",
      provider: "naver",
      id: "blog-schedule",
      command: "npm run workflow:not-yet-implemented"
    });

    const result = await finishRecipeInput({ rootDir: root, publish: true });
    const saved = await readFile(result.outputFile, "utf8");

    expect(result.recipeStatus).toBe("draft");
    expect(result.published).toBe(true);
    expect(result.outputFile).toBe(path.join(root, "recipes", "naver", "blog-schedule.md"));
    expect(saved).toContain("status: draft");
  });

  it("preserves the earlier capture schema when adding and finishing later", async () => {
    const root = await createTemporaryRoot({ "workflow:youtube-playlist-play": "tsx workflow.ts" });
    const paths = recipeInputPaths(root);
    await mkdir(path.dirname(paths.activeFile), { recursive: true });
    await writeFile(
      paths.activeFile,
      JSON.stringify({
        schemaVersion: 1,
        captureId: "recipe-input-legacy",
        status: "collecting",
        startedAt: "2026-07-18T09:47:52.000Z",
        recipe: {
          name: "기도 찬양",
          description: "기존 기록입니다.",
          provider: "YouTube",
          triggers: ["기도 찬양 틀어줘"],
          steps: [{ order: 1, action: "재생목록을 연다.", url: "https://youtube.com/playlist?list=PL456" }],
          notes: ["기존 메모"],
          tests: [
            {
              performedAt: "2026-07-18T10:14:14Z",
              result: "성공",
              browser: "일반 사용자 Chrome",
              verified: ["재생 시작", "음소거 해제"],
              statusFile: "work/recipe-input/status.json",
              screenshotFile: "work/recipe-input/screenshot.png"
            }
          ],
          approvalGates: []
        }
      }),
      "utf8"
    );

    await addRecipeInput({ rootDir: root, note: "새 메모" });
    const result = await finishRecipeInput({ rootDir: root, output: "recipes/local/youtube/legacy-prayer.md" });
    const saved = await readFile(result.outputFile, "utf8");

    expect(saved).toContain("기존 메모");
    expect(saved).toContain("새 메모");
    expect(saved).toContain("2026-07-18T10:14:14Z: 성공");
    expect(saved).toContain("확인: 재생 시작, 음소거 해제");
    expect(saved).toContain("스크린샷: work/recipe-input/screenshot.png");
  });
});

async function createTemporaryRoot(scripts: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "web-agent-recipe-input-"));
  temporaryRoots.push(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts }, null, 2), "utf8");
  return root;
}
