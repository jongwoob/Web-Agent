import { describe, expect, it } from "vitest";
import {
  buildGoogleCalendarTemplateUrl,
  normalizeGoogleCalendarEvent
} from "../src/workflows/googleCalendarEvent.js";
import {
  buildGoogleWorkspaceExportUrl,
  normalizeGoogleWorkspaceFormat,
  parseGoogleWorkspaceUrl
} from "../src/workflows/googleWorkspaceExport.js";

describe("Google Workspace export workflow helpers", () => {
  it("builds Google Docs export URLs", () => {
    const ref = parseGoogleWorkspaceUrl("https://docs.google.com/document/d/doc_123/edit", "docs");

    expect(ref).toEqual({ kind: "docs", fileId: "doc_123" });
    expect(buildGoogleWorkspaceExportUrl(ref, "docx")).toBe(
      "https://docs.google.com/document/d/doc_123/export?format=docx"
    );
  });

  it("builds Google Slides and Sheets export URLs", () => {
    const slides = parseGoogleWorkspaceUrl("https://docs.google.com/presentation/d/slides_456/edit", "slides");
    const sheets = parseGoogleWorkspaceUrl("https://docs.google.com/spreadsheets/d/sheets_789/edit", "sheets");

    expect(buildGoogleWorkspaceExportUrl(slides, "pdf")).toBe(
      "https://docs.google.com/presentation/d/slides_456/export/pdf"
    );
    expect(buildGoogleWorkspaceExportUrl(sheets, "xlsx")).toBe(
      "https://docs.google.com/spreadsheets/d/sheets_789/export?format=xlsx"
    );
  });

  it("rejects mismatched kinds and unsupported formats", () => {
    expect(() => parseGoogleWorkspaceUrl("https://docs.google.com/presentation/d/abc/edit", "docs")).toThrow(
      /Expected a Google docs URL/
    );
    expect(() => normalizeGoogleWorkspaceFormat("slides", "docx")).toThrow(/Unsupported/);
  });
});

describe("Google Calendar event workflow helpers", () => {
  it("builds a timed event template with explicit UTC conversion", () => {
    const event = normalizeGoogleCalendarEvent({
      title: "Project review",
      start: "2026-07-13T10:00:00+09:00",
      end: "2026-07-13T11:30:00+09:00",
      timeZone: "Asia/Seoul",
      location: "Meeting room A",
      details: "Review the release checklist.",
      guests: ["PERSON@example.com"]
    });
    const url = new URL(buildGoogleCalendarTemplateUrl(event));

    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("text")).toBe("Project review");
    expect(url.searchParams.get("dates")).toBe("20260713T010000Z/20260713T023000Z");
    expect(url.searchParams.get("ctz")).toBe("Asia/Seoul");
    expect(url.searchParams.getAll("add")).toEqual(["person@example.com"]);
  });

  it("defaults a one-day all-day event to the next exclusive end date", () => {
    const event = normalizeGoogleCalendarEvent({
      title: "Company holiday",
      start: "2026-07-15",
      allDay: true
    });

    expect(event.end).toBe("2026-07-16");
    expect(new URL(buildGoogleCalendarTemplateUrl(event)).searchParams.get("dates")).toBe("20260715/20260716");
  });

  it("rejects ambiguous local date-times", () => {
    expect(() =>
      normalizeGoogleCalendarEvent({
        title: "Ambiguous event",
        start: "2026-07-13T10:00:00",
        end: "2026-07-13T11:00:00"
      })
    ).toThrow(/explicit UTC offset/);
  });
});
