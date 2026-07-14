import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  googleProfileDir,
  googleReadOnlyProfileDir,
  naverReadOnlyProfileDir
} from "../src/workflows/shared.js";

describe("read-only authenticated profile routing", () => {
  it("uses the approved Google Forms session for Google read-only work", () => {
    expect(path.basename(googleReadOnlyProfileDir("chrome"))).toBe("google-forms-chrome");
    expect(path.basename(googleReadOnlyProfileDir("edge"))).toBe("google-forms-edge");
    expect(path.basename(googleReadOnlyProfileDir("chromium"))).toBe("google-forms-chromium");
  });

  it("uses the authenticated Naver session for Naver read-only work", () => {
    expect(path.basename(naverReadOnlyProfileDir("chrome"))).toBe("naver-chrome");
    expect(path.basename(naverReadOnlyProfileDir("edge"))).toBe("naver-edge");
    expect(path.basename(naverReadOnlyProfileDir("chromium"))).toBe("naver");
  });

  it("routes only read-only workflows through the shared sessions", async () => {
    const googleReadOnlyFiles = [
      "src/workflows/googleDriveDownload.ts",
      "src/workflows/googleSheetsExportCsv.ts",
      "src/workflows/googleWorkspaceExport.ts",
      "src/workflows/mailSearchRead.ts",
      "src/workflows/webExtract.ts"
    ];
    for (const file of googleReadOnlyFiles) {
      const source = await readFile(path.resolve(file), "utf8");
      expect(source, file).toContain("googleReadOnlyProfileDir(");
    }

    const naverReadOnlyFiles = [
      "src/workflows/mailSearchRead.ts",
      "src/workflows/naverMailReadBatch.ts",
      "src/workflows/webExtract.ts"
    ];
    for (const file of naverReadOnlyFiles) {
      const source = await readFile(path.resolve(file), "utf8");
      expect(source, file).toContain("naverReadOnlyProfileDir(");
    }
  });

  it("keeps Google Calendar creation on its service-specific profile", async () => {
    const source = await readFile(path.resolve("src/workflows/googleCalendarEvent.ts"), "utf8");

    expect(source).toContain('googleProfileDir("calendar", args.browser)');
    expect(source).not.toContain("googleReadOnlyProfileDir(");
    expect(path.basename(googleProfileDir("calendar", "chrome"))).toBe("google-calendar-chrome");
  });
});
