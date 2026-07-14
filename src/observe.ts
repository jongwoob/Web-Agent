import type { Page } from "playwright";
import type { InteractiveElement, Observation } from "./types.js";
import { compactWhitespace, truncate } from "./strings.js";
import { elapsedSince, nowMs } from "./time.js";

export interface ObservationOptions {
  includeScreenshot?: boolean;
  screenshotPath?: string;
  maxElements?: number;
  maxTextLength?: number;
  cache?: ObservationCache;
}

interface CachedElements {
  pageKey: string;
  elements: InteractiveElement[];
  createdAt: number;
}

export class ObservationCache {
  private cached: CachedElements | null = null;

  constructor(private readonly ttlMs = 1500) {}

  get(pageKey: string): InteractiveElement[] | null {
    if (!this.cached || this.cached.pageKey !== pageKey) {
      return null;
    }

    if (Date.now() - this.cached.createdAt > this.ttlMs) {
      return null;
    }

    return this.cached.elements;
  }

  set(pageKey: string, elements: InteractiveElement[]): void {
    this.cached = {
      pageKey,
      elements,
      createdAt: Date.now()
    };
  }
}

export async function observePage(page: Page, options: ObservationOptions = {}): Promise<Observation> {
  const started = nowMs();
  const maxElements = options.maxElements ?? 80;
  const maxTextLength = options.maxTextLength ?? 3000;
  const [url, title, rawText, accessibilitySnapshot] = await Promise.all([
    Promise.resolve(page.url()),
    page.title().catch(() => ""),
    page.locator("body").innerText({ timeout: 1500 }).catch(() => ""),
    readAccessibilitySnapshot(page)
  ]);
  const visibleText = truncate(compactWhitespace(rawText), maxTextLength);
  const pageKey = makePageKey(url, title, visibleText);
  let elements = options.cache?.get(pageKey) ?? null;

  if (!elements) {
    elements = await collectInteractiveElements(page, maxElements);
    options.cache?.set(pageKey, elements);
  }

  let screenshotPath: string | undefined;
  if (options.includeScreenshot && options.screenshotPath) {
    await page.screenshot({ path: options.screenshotPath, fullPage: true });
    screenshotPath = options.screenshotPath;
  }

  return {
    url,
    title,
    visibleText,
    accessibilitySnapshot,
    elements,
    screenshotPath,
    observedAt: new Date().toISOString(),
    elapsedMs: elapsedSince(started),
    pageKey
  };
}

async function readAccessibilitySnapshot(page: Page): Promise<string> {
  try {
    const body = page.locator("body");
    const maybeAriaSnapshot = body as unknown as {
      ariaSnapshot?: (options?: { timeout?: number }) => Promise<string>;
    };

    if (typeof maybeAriaSnapshot.ariaSnapshot === "function") {
      return truncate(await maybeAriaSnapshot.ariaSnapshot({ timeout: 1500 }), 3000);
    }
  } catch {
    return "";
  }

  return "";
}

async function collectInteractiveElements(page: Page, maxElements: number): Promise<InteractiveElement[]> {
  return page.evaluate(
    String.raw`(() => {
      const limit = ${Math.max(1, Math.floor(maxElements))};
      const selector = [
        "a",
        "button",
        "input",
        "textarea",
        "select",
        "summary",
        "label",
        "[role]",
        "[contenteditable='true']",
        "[onclick]",
        "[tabindex]:not([tabindex='-1'])"
      ].join(",");

      function compact(value) {
        return (value || "").replace(/\s+/g, " ").trim().slice(0, 180);
      }

      function escapeAttr(value) {
        return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      }

      function isVisible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity) !== 0 &&
          rect.width > 0 &&
          rect.height > 0
        );
      }

      function textFor(element) {
        return compact(
          element.getAttribute("aria-label") ||
            element.getAttribute("alt") ||
            element.innerText ||
            element.value ||
            element.textContent ||
            ""
        );
      }

      function labelFor(element) {
        const id = element.getAttribute("id");
        if (id) {
          const label = document.querySelector('label[for="' + escapeAttr(id) + '"]');
          if (label) {
            return compact(label.textContent);
          }
        }

        const closestLabel = element.closest("label");
        return compact(closestLabel && closestLabel.textContent);
      }

      function stableSelector(element) {
        const tag = element.tagName.toLowerCase();
        const id = element.getAttribute("id");
        if (id) {
          return "#" + CSS.escape(id);
        }

        for (const attr of ["data-testid", "data-test", "name", "aria-label", "placeholder"]) {
          const value = element.getAttribute(attr);
          if (value) {
            return tag + "[" + attr + '="' + escapeAttr(value) + '"]';
          }
        }

        const parent = element.parentElement;
        if (!parent) {
          return tag;
        }

        const siblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
        const index = Math.max(1, siblings.indexOf(element) + 1);
        return stableSelector(parent) + " > " + tag + ":nth-of-type(" + index + ")";
      }

      const candidates = Array.from(document.querySelectorAll(selector))
        .filter(isVisible)
        .slice(0, limit);

      return candidates.map((element, index) => {
        const rect = element.getBoundingClientRect();
        const disabled = Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true";

        return {
          index,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role"),
          text: textFor(element),
          label: labelFor(element),
          placeholder: compact(element.placeholder),
          name: compact(element.name),
          type: compact(element.type),
          selector: stableSelector(element),
          disabled,
          box: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            centerX: Math.round(rect.x + rect.width / 2),
            centerY: Math.round(rect.y + rect.height / 2)
          }
        };
      });
    })()`
  ) as Promise<InteractiveElement[]>;
}

function makePageKey(url: string, title: string, visibleText: string): string {
  return `${url}::${title}::${visibleText.slice(0, 240)}`;
}
