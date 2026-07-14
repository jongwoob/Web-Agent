import { describe, expect, it } from "vitest";
import { buildDriveDownloadUrl, parseGoogleDriveFileUrl } from "../src/workflows/googleDriveDownload.js";
import { buildCsvExportUrl, parseGoogleSheetUrl } from "../src/workflows/googleSheetsExportCsv.js";
import { buildExtractOutput } from "../src/workflows/webExtract.js";

describe("Google starter workflow helpers", () => {
  it("parses Google Sheets spreadsheet id and gid", () => {
    const parsed = parseGoogleSheetUrl("https://docs.google.com/spreadsheets/d/abc_123-XYZ/edit#gid=456");

    expect(parsed).toEqual({ spreadsheetId: "abc_123-XYZ", gid: "456" });
    expect(buildCsvExportUrl(parsed)).toBe("https://docs.google.com/spreadsheets/d/abc_123-XYZ/export?format=csv&gid=456");
  });

  it("parses Google Drive file ids from common URLs", () => {
    const parsed = parseGoogleDriveFileUrl("https://drive.google.com/file/d/1AbCdEF_234/view?usp=sharing");

    expect(parsed).toEqual({ fileId: "1AbCdEF_234" });
    expect(buildDriveDownloadUrl(parsed)).toBe("https://drive.google.com/uc?export=download&id=1AbCdEF_234");
  });

  it("builds a stable web-extract output shape", () => {
    const output = buildExtractOutput({
      url: "https://example.com/",
      title: "Example",
      visibleText: "Hello world",
      headings: [{ level: 1, text: "Example" }],
      links: [{ text: "Docs", href: "https://example.com/docs" }]
    });

    expect(output.schemaVersion).toBe(1);
    expect(output.url).toBe("https://example.com/");
    expect(output.title).toBe("Example");
    expect(output.visibleText).toBe("Hello world");
    expect(output.headings).toHaveLength(1);
    expect(output.links).toHaveLength(1);
    expect(output.extractedAt).toEqual(expect.any(String));
  });
});
