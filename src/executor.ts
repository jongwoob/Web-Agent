import type { Locator, Page } from "playwright";
import type { ActionResult, AgentAction } from "./types.js";
import { escapeRegex } from "./strings.js";
import { elapsedSince, nowMs } from "./time.js";

export interface ExecuteOptions {
  timeoutMs: number;
}

type LocatorCandidate = {
  label: string;
  locator: Locator;
};

export async function executeAction(page: Page, action: AgentAction, options: ExecuteOptions): Promise<ActionResult> {
  const started = nowMs();

  try {
    switch (action.type) {
      case "navigate": {
        const url = action.target || action.text;
        if (!url) {
          return failed("navigate action requires target or text.", started);
        }

        await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
        return succeeded(`Navigated to ${url}.`, started);
      }

      case "click": {
        const locator = await resolveLocator(page, action, ["button", "link", "menuitem", "tab"], options.timeoutMs);
        if (!locator) {
          return failed(`Could not resolve click target: ${describeTarget(action)}.`, started);
        }

        await clickWithFallback(page, locator, options.timeoutMs);
        return succeeded(`Clicked ${describeTarget(action)}.`, started);
      }

      case "fill": {
        const value = action.text ?? "";
        const locator = await resolveLocator(page, action, ["textbox", "combobox", "searchbox"], options.timeoutMs);
        if (!locator) {
          return failed(`Could not resolve fill target: ${describeTarget(action)}.`, started);
        }

        await locator.fill(value, { timeout: options.timeoutMs });
        return succeeded(`Filled ${describeTarget(action)}.`, started);
      }

      case "press": {
        const key = action.text || action.target;
        if (!key) {
          return failed("press action requires text or target key.", started);
        }

        if (action.selectorHint || action.target) {
          const locator = await resolveLocator(page, action, ["textbox", "button", "link"], options.timeoutMs);
          if (locator) {
            await locator.press(key, { timeout: options.timeoutMs });
            return succeeded(`Pressed ${key} on ${describeTarget(action)}.`, started);
          }
        }

        await page.keyboard.press(key);
        return succeeded(`Pressed ${key}.`, started);
      }

      case "select": {
        const value = action.text;
        if (!value) {
          return failed("select action requires text as option value or label.", started);
        }

        const locator = await resolveLocator(page, action, ["combobox"], options.timeoutMs);
        if (!locator) {
          return failed(`Could not resolve select target: ${describeTarget(action)}.`, started);
        }

        await locator.selectOption({ label: value }, { timeout: options.timeoutMs }).catch(async () => {
          await locator.selectOption(value, { timeout: options.timeoutMs });
        });
        return succeeded(`Selected ${value} in ${describeTarget(action)}.`, started);
      }

      case "wait": {
        const waitMs = parseWaitMs(action.text || action.target) ?? Math.min(options.timeoutMs, 3000);
        if (action.selectorHint) {
          await page.locator(action.selectorHint).first().waitFor({ state: "visible", timeout: waitMs });
          return succeeded(`Waited for ${action.selectorHint}.`, started);
        }

        await page.waitForTimeout(waitMs);
        return succeeded(`Waited ${waitMs}ms.`, started);
      }

      case "extract": {
        const text = await page.locator("body").innerText({ timeout: options.timeoutMs });
        return succeeded("Extracted visible page text.", started, text);
      }

      case "ask_user":
        return succeeded(action.text || action.reason || "Planner requested user input.", started);

      case "done":
        return succeeded(action.reason || "Task completed.", started);

      default:
        return failed(`Unsupported action type: ${(action as { type: string }).type}`, started);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failed(message, started);
  }
}

async function resolveLocator(
  page: Page,
  action: AgentAction,
  preferredRoles: string[],
  timeoutMs: number
): Promise<Locator | null> {
  const candidates = buildLocatorCandidates(page, action, preferredRoles);

  for (const candidate of candidates) {
    const locator = candidate.locator.first();
    if (await isUsable(locator, timeoutMs)) {
      return locator;
    }
  }

  return null;
}

function buildLocatorCandidates(page: Page, action: AgentAction, preferredRoles: string[]): LocatorCandidate[] {
  const candidates: LocatorCandidate[] = [];
  const target = action.target?.trim();
  const selectorHint = action.selectorHint?.trim();

  if (selectorHint) {
    candidates.push({ label: `selector ${selectorHint}`, locator: page.locator(selectorHint) });
  }

  if (!target) {
    return candidates;
  }

  const exactName = new RegExp(`^${escapeRegex(target)}$`, "i");
  const looseName = new RegExp(escapeRegex(target), "i");

  for (const role of preferredRoles) {
    candidates.push({ label: `${role} exact`, locator: page.getByRole(role as never, { name: exactName }) });
    candidates.push({ label: `${role} loose`, locator: page.getByRole(role as never, { name: looseName }) });
  }

  candidates.push({ label: "label exact", locator: page.getByLabel(exactName) });
  candidates.push({ label: "label loose", locator: page.getByLabel(looseName) });
  candidates.push({ label: "placeholder exact", locator: page.getByPlaceholder(exactName) });
  candidates.push({ label: "placeholder loose", locator: page.getByPlaceholder(looseName) });
  candidates.push({ label: "text exact", locator: page.getByText(exactName) });
  candidates.push({ label: "text loose", locator: page.getByText(looseName) });

  if (looksLikeCssSelector(target)) {
    candidates.push({ label: `css target ${target}`, locator: page.locator(target) });
  }

  return candidates;
}

async function isUsable(locator: Locator, timeoutMs: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 1200) });
    const count = await locator.count();
    if (count < 1) {
      return false;
    }

    const disabled = await locator.isDisabled({ timeout: 500 }).catch(() => false);
    return !disabled;
  } catch {
    return false;
  }
}

async function clickWithFallback(page: Page, locator: Locator, timeoutMs: number): Promise<void> {
  try {
    await locator.click({ timeout: timeoutMs });
    return;
  } catch (error) {
    const box = await locator.boundingBox();
    if (!box) {
      throw error;
    }

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
}

function parseWaitMs(value?: string): number | null {
  if (!value) {
    return null;
  }

  const match = value.match(/(\d+(?:\.\d+)?)\s*(ms|millisecond|milliseconds|s|sec|second|seconds)?/i);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  return unit && ["s", "sec", "second", "seconds"].includes(unit) ? Math.round(amount * 1000) : Math.round(amount);
}

function looksLikeCssSelector(value: string): boolean {
  return /^[#.[]|[:>~+ ]/.test(value) || /^[a-z][a-z0-9-]*(\[|#|\.|:)/i.test(value);
}

function describeTarget(action: AgentAction): string {
  return action.selectorHint || action.target || action.text || action.type;
}

function succeeded(message: string, started: number, data?: unknown): ActionResult {
  return {
    ok: true,
    message,
    data,
    elapsedMs: elapsedSince(started)
  };
}

function failed(message: string, started: number): ActionResult {
  return {
    ok: false,
    message,
    elapsedMs: elapsedSince(started)
  };
}
