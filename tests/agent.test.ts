import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { executeAction } from "../src/executor.js";
import { observePage, ObservationCache } from "../src/observe.js";
import { assessActionSafety } from "../src/safety.js";
import { verifyExpectedResult } from "../src/verifier.js";

describe("web agent core", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  });

  beforeEach(async () => {
    page = await browser.newPage();
    const sampleUrl = pathToFileURL(path.resolve("examples/sample.html")).toString();
    await page.goto(sampleUrl);
  });

  afterAll(async () => {
    await browser.close();
  });

  it("observes interactive elements with rendered boxes", async () => {
    const observation = await observePage(page, { cache: new ObservationCache() });
    const helloButton = observation.elements.find((element) => element.text === "Say Hello");

    expect(observation.title).toBe("Web Agent Sample");
    expect(helloButton?.selector).toBe("#hello-button");
    expect(helloButton?.box?.width).toBeGreaterThan(0);
  });

  it("clicks a button and verifies the resulting text", async () => {
    const action = {
      type: "click" as const,
      reason: "Click sample button.",
      target: "Say Hello",
      expectedResult: "Hello clicked",
      riskLevel: "low" as const
    };

    const result = await executeAction(page, action, { timeoutMs: 3000 });
    const observation = await observePage(page);
    const verification = verifyExpectedResult(action, observation);

    expect(result.ok).toBe(true);
    expect(verification.status).toBe("passed");
  });

  it("fills a labeled input and submits the search form", async () => {
    const fillResult = await executeAction(
      page,
      {
        type: "fill",
        reason: "Fill search query.",
        target: "Search query",
        text: "pricing",
        expectedResult: "pricing",
        riskLevel: "low"
      },
      { timeoutMs: 3000 }
    );
    const clickResult = await executeAction(
      page,
      {
        type: "click",
        reason: "Submit search form.",
        target: "Search",
        expectedResult: "Search result for pricing",
        riskLevel: "low"
      },
      { timeoutMs: 3000 }
    );
    const observation = await observePage(page);
    const verification = verifyExpectedResult(
      {
        type: "click",
        reason: "Submit search form.",
        target: "Search",
        expectedResult: "Search result for pricing",
        riskLevel: "low"
      },
      observation
    );

    expect(fillResult.ok).toBe(true);
    expect(clickResult.ok).toBe(true);
    expect(verification.status).toBe("passed");
  });

  it("falls back to selector hints when semantic matching is not enough", async () => {
    const result = await executeAction(
      page,
      {
        type: "click",
        reason: "Use selector fallback.",
        target: "not visible in task",
        selectorHint: "#hello-button",
        expectedResult: "Hello clicked",
        riskLevel: "low"
      },
      { timeoutMs: 3000 }
    );

    expect(result.ok).toBe(true);
  });

  it("accepts URL navigation when a clicked link label disappears", () => {
    const action = {
      type: "click" as const,
      reason: "Open documentation link.",
      target: "Learn more",
      expectedResult: "Learn more",
      riskLevel: "low" as const
    };
    const previous = observationAt("https://example.com/", "Example Domain", "Learn more");
    const current = observationAt("https://www.iana.org/help/example-domains", "Example Domains", "IANA-managed reserved domains");

    expect(verifyExpectedResult(action, current, previous)).toEqual({
      status: "passed",
      message: "Navigation was observed after click: https://www.iana.org/help/example-domains"
    });
  });

  it("requires approval for dangerous actions", () => {
    const safety = assessActionSafety({
      type: "click",
      reason: "Delete the account.",
      target: "Delete account",
      expectedResult: "Account deleted",
      riskLevel: "low"
    });

    expect(safety.riskLevel).toBe("high");
    expect(safety.requiresApproval).toBe(true);
  });
});

function observationAt(url: string, title: string, visibleText: string) {
  return {
    url,
    title,
    visibleText,
    accessibilitySnapshot: visibleText,
    elements: [],
    observedAt: new Date(0).toISOString(),
    elapsedMs: 0,
    pageKey: url
  };
}
