import type { AgentAction, AgentHistoryItem, Observation } from "./types.js";
import { compactWhitespace, truncate } from "./strings.js";

export interface PlannerInput {
  task: string;
  observation: Observation;
  history: AgentHistoryItem[];
}

export interface Planner {
  nextAction(input: PlannerInput): Promise<AgentAction>;
}

export interface PlannerOptions {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export function createPlanner(options: PlannerOptions): Planner {
  if (options.model === "heuristic") {
    return new HeuristicPlanner();
  }

  return new OpenAICompatiblePlanner({
    model: options.model || process.env.OPENAI_MODEL || "gpt-4.1-mini",
    baseUrl: options.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    apiKey: options.apiKey || process.env.OPENAI_API_KEY
  });
}

class OpenAICompatiblePlanner implements Planner {
  constructor(private readonly options: Required<Pick<PlannerOptions, "model" | "baseUrl">> & { apiKey?: string }) {}

  async nextAction(input: PlannerInput): Promise<AgentAction> {
    if (!this.options.apiKey) {
      throw new Error("OPENAI_API_KEY is required unless --model heuristic is used.");
    }

    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.apiKey}`
      },
      body: JSON.stringify({
        model: this.options.model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: buildPlannerPrompt(input) }
        ],
        temperature: 0.1
      })
    });

    if (!response.ok) {
      throw new Error(`Planner request failed with ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Planner response did not include message content.");
    }

    return parsePlannerAction(content);
  }
}

class HeuristicPlanner implements Planner {
  async nextAction(input: PlannerInput): Promise<AgentAction> {
    const task = input.task.toLowerCase();
    const lastResult = input.history.at(-1);

    if (lastResult?.verification?.status === "passed") {
      return {
        type: "done",
        reason: "The expected result was observed.",
        riskLevel: "low"
      };
    }

    if (/extract|수집|가져|읽|text|텍스트/.test(task)) {
      return {
        type: "extract",
        reason: "The task asks to extract or read page text.",
        expectedResult: input.observation.title || undefined,
        riskLevel: "low"
      };
    }

    const fillMatch = input.task.match(/(?:fill|type|enter|입력)\s+["“]?([^"”]+)["”]?\s+(?:in|into|to|에|필드)/i);
    if (fillMatch) {
      const target = findLikelyInput(input.observation);
      return {
        type: "fill",
        reason: "Heuristic fill action based on task wording.",
        target: target?.label || target?.placeholder || target?.text || target?.selector || "input",
        selectorHint: target?.selector,
        text: fillMatch[1].trim(),
        expectedResult: fillMatch[1].trim(),
        riskLevel: "low"
      };
    }

    const clickTarget = findTaskTarget(input.task, input.observation);
    if (clickTarget) {
      return {
        type: "click",
        reason: "Heuristic click action based on matching visible element text.",
        target: clickTarget.text || clickTarget.label || clickTarget.placeholder || clickTarget.selector,
        selectorHint: clickTarget.selector,
        expectedResult: clickTarget.text || clickTarget.label || undefined,
        riskLevel: "low"
      };
    }

    return {
      type: "ask_user",
      reason: "The heuristic planner could not infer a safe next action.",
      text: "Please provide a more specific target, such as the button text or field label.",
      riskLevel: "low"
    };
  }
}

const systemPrompt = `
You are a fast and accurate web operation planner.

Return exactly one JSON object for the next atomic action. No markdown.

Allowed action types:
navigate, click, fill, press, select, wait, extract, ask_user, done.

Required fields:
type, reason, riskLevel.

Optional fields:
target, selectorHint, text, expectedResult.

Rules:
- Prefer role, label, placeholder, visible text, or stable selector hints from the observation.
- Choose only one action at a time.
- After every click/fill/select/press, include an expectedResult when possible.
- Mark high risk for payment, purchase, deletion, sending/posting messages, account changes, credentials, OTP, payment, identity, or private data.
- Use ask_user if credentials, CAPTCHA, 2FA, payment details, private info, or missing context is required.
- Use done only when the task is complete according to the current observation.
`.trim();

function buildPlannerPrompt(input: PlannerInput): string {
  return JSON.stringify(
    {
      task: input.task,
      currentPage: {
        url: input.observation.url,
        title: input.observation.title,
        visibleText: truncate(input.observation.visibleText, 1800),
        accessibilitySnapshot: truncate(input.observation.accessibilitySnapshot, 1800),
        elements: input.observation.elements.slice(0, 50).map((element) => ({
          index: element.index,
          tag: element.tag,
          role: element.role,
          text: element.text,
          label: element.label,
          placeholder: element.placeholder,
          name: element.name,
          type: element.type,
          selector: element.selector,
          disabled: element.disabled,
          box: element.box
        }))
      },
      recentHistory: input.history.slice(-6)
    },
    null,
    2
  );
}

function parsePlannerAction(content: string): AgentAction {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned) as Partial<AgentAction>;

  if (!parsed.type || !parsed.reason) {
    throw new Error(`Planner action must include type and reason: ${content}`);
  }

  return {
    type: parsed.type,
    reason: parsed.reason,
    target: parsed.target,
    selectorHint: parsed.selectorHint,
    text: parsed.text,
    expectedResult: parsed.expectedResult,
    riskLevel: parsed.riskLevel ?? "low"
  };
}

function findTaskTarget(task: string, observation: Observation) {
  const normalizedTask = task.toLowerCase();
  return observation.elements.find((element) => {
    const visibleName = compactWhitespace([element.text, element.label, element.placeholder, element.name].filter(Boolean).join(" ")).toLowerCase();
    return visibleName && normalizedTask.includes(visibleName);
  });
}

function findLikelyInput(observation: Observation) {
  return observation.elements.find((element) =>
    ["input", "textarea", "select"].includes(element.tag) || ["textbox", "combobox", "searchbox"].includes(element.role ?? "")
  );
}
