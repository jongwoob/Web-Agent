import { describe, expect, it } from "vitest";
import {
  buildGmailSearchQuery,
  buildMailSearchOutput,
  buildNaverInboxQuery,
  buildNaverSearchQuery,
  koreaDateString,
  matchesNaverReceivedDate,
  normalizeMailFilter,
  requiresMailOpenApproval
} from "../src/workflows/mailSearchRead.js";
import { selectNaverBatchItems } from "../src/workflows/naverMailReadBatch.js";

describe("mail search and read helpers", () => {
  it("builds a structured Gmail search query", () => {
    const filter = normalizeMailFilter({
      query: "project update",
      from: "person@example.com",
      subject: "weekly report",
      after: "2026-07-01",
      before: "2026-08-01",
      unread: true,
      hasAttachment: true,
      labels: ["inbox"]
    });

    expect(buildGmailSearchQuery(filter)).toBe(
      'project update from:"person@example.com" subject:"weekly report" after:2026/07/01 before:2026/08/01 is:unread has:attachment label:"inbox"'
    );
  });

  it("validates dates and Naver preview filter scope", () => {
    expect(() => buildGmailSearchQuery({ after: "2026-02-30" })).toThrow(/valid YYYY-MM-DD/);
    expect(buildNaverSearchQuery({ query: "invoice" })).toBe("invoice");
    expect(() => buildNaverSearchQuery({ query: "invoice", from: "person@example.com" })).toThrow(/keyword query only/);
  });

  it("recognizes Naver inbox dates for a Korea-local day", () => {
    const referenceDate = new Date("2026-07-12T15:30:00.000Z");

    expect(koreaDateString(referenceDate)).toBe("2026-07-13");
    expect(buildNaverInboxQuery("2026-07-13")).toBe("inbox:2026-07-13");
    expect(matchesNaverReceivedDate("오전 10:15", "2026-07-13", referenceDate)).toBe(true);
    expect(matchesNaverReceivedDate("2026. 7. 13.", "2026-07-13", referenceDate)).toBe(true);
    expect(matchesNaverReceivedDate("7. 12.", "2026-07-13", referenceDate)).toBe(false);
  });

  it("requires approval when opening unread or Naver results", () => {
    const readItem = { index: 0, sender: "a", subject: "b", date: "c", snippet: "d", unread: false };
    const unreadItem = { ...readItem, unread: true };

    expect(requiresMailOpenApproval("gmail", readItem)).toBe(false);
    expect(requiresMailOpenApproval("gmail", unreadItem)).toBe(true);
    expect(requiresMailOpenApproval("naver", readItem)).toBe(true);
  });

  it("keeps body content out of list-only output", () => {
    const list = [{ index: 0, sender: "person@example.com", subject: "Report", date: "Today", snippet: "Preview" }];
    const output = buildMailSearchOutput("gmail", "subject:Report", list);

    expect(output.schemaVersion).toBe(1);
    expect(output.list).toEqual(list);
    expect(output.message).toBeUndefined();
    expect(output.extractedAt).toEqual(expect.any(String));
  });

  it("selects only validated Naver popup message URLs for batch reads", () => {
    const selected = selectNaverBatchItems(
      {
        provider: "naver",
        list: [
          {
            index: 0,
            sender: "Naver Pay",
            subject: "Payment",
            date: "07.01",
            snippet: "",
            unread: false,
            url: "https://mail.naver.com/v2/popup/read/7/123"
          }
        ]
      },
      1
    );

    expect(selected).toHaveLength(1);
    expect(() =>
      selectNaverBatchItems(
        {
          provider: "naver",
          list: [{ sender: "x", subject: "y", date: "z", url: "https://example.com/" }]
        },
        1
      )
    ).toThrow(/unsupported URL/);
  });
});
