import { describe, expect, it } from "vitest";
import {
  extractGoogleCalendarShareTarget,
  isFinalCalendarShareActionLabel
} from "../src/workflows/googleCalendarShareRequest.js";

describe("Google Calendar share request links", () => {
  it("accepts one verified Google Calendar share target", () => {
    const target = extractGoogleCalendarShareTarget({
      links: [
        {
          text: "공유",
          href: "https://calendar.google.com/calendar/render?share=person%40example.com&ctok=opaque-test-token"
        }
      ]
    });

    expect(target.url.hostname).toBe("calendar.google.com");
    expect(target.url.pathname).toBe("/calendar/render");
    expect(target.recipient).toBe("person@example.com");
  });

  it("rejects unverified or ambiguous sharing links", () => {
    expect(() =>
      extractGoogleCalendarShareTarget({
        links: [{ text: "공유", href: "https://example.com/calendar/render?share=person%40example.com" }]
      })
    ).toThrow(/exactly one verified/);
    expect(() =>
      extractGoogleCalendarShareTarget({
        links: [
          { href: "https://calendar.google.com/calendar/render?share=one%40example.com" },
          { href: "https://calendar.google.com/calendar/render?share=two%40example.com" }
        ]
      })
    ).toThrow(/exactly one verified/);
  });

  it("recognizes only final sharing actions", () => {
    expect(isFinalCalendarShareActionLabel("공유")).toBe(true);
    expect(isFinalCalendarShareActionLabel("저장")).toBe(true);
    expect(isFinalCalendarShareActionLabel("취소")).toBe(false);
  });
});
