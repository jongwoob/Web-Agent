import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { BrowserController } from "./browser.js";
import { executeAction } from "./executor.js";
import { ObservationCache, observePage } from "./observe.js";
import { createPlanner } from "./planner.js";
import { assessActionSafety } from "./safety.js";
import { truncate } from "./strings.js";
import type { AgentHistoryItem, StepLog } from "./types.js";
import { verifyExpectedResult } from "./verifier.js";
import {
  inferWebProvider,
  providerAgentProfileDir,
  runProviderPreflight
} from "./workflows/providerPreflight.js";
import { parseBrowser, type BrowserChoice } from "./workflows/shared.js";

interface CliArgs {
  url: string;
  task: string;
  headful: boolean;
  maxSteps: number;
  timeoutMs: number;
  loginTimeoutMs: number;
  browser: BrowserChoice;
  model?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runDir = await createRunDir();
  const provider = inferWebProvider(args.url);
  const controller = await BrowserController.launch({
    headful: args.headful,
    timeoutMs: args.timeoutMs,
    browser: args.browser,
    userDataDir: providerAgentProfileDir(provider, args.browser, args.url)
  });
  const planner = createPlanner({ model: args.model });
  const cache = new ObservationCache();
  const history: AgentHistoryItem[] = [];
  const logs: StepLog[] = [];
  const started = Date.now();

  try {
    await runProviderPreflight(controller.page, {
      provider,
      targetUrl: args.url,
      statusFile: path.join(runDir, "preflight-status.json"),
      timeoutMs: args.timeoutMs,
      loginTimeoutMs: args.loginTimeoutMs,
      headless: !args.headful
    });

    for (let step = 1; step <= args.maxSteps; step += 1) {
      const stepStart = Date.now();
      const observation = await observePage(controller.page, { cache });
      printObservation(step, observation.url, observation.title, observation.visibleText, observation.elements.length);

      const action = await planner.nextAction({ task: args.task, observation, history });
      console.log(`action: ${action.type} - ${action.reason}`);

      const safety = assessActionSafety(action);
      if (safety.requiresApproval) {
        const approved = await confirmRiskyAction(action.type, safety.reason);
        if (!approved) {
          console.log("stopped: risky action was not approved.");
          break;
        }
      }

      if (action.type === "done") {
        logs.push({
          step,
          observation: summarizeObservation(observation),
          action,
          elapsedMs: Date.now() - stepStart
        });
        console.log(`done: ${action.reason}`);
        break;
      }

      if (action.type === "ask_user") {
        const answer = await askUser(action.text || action.reason);
        history.push({
          action: {
            type: "ask_user",
            reason: action.reason,
            text: answer,
            riskLevel: "low"
          }
        });
        continue;
      }

      const execution = await executeAction(controller.page, action, { timeoutMs: args.timeoutMs });
      const afterObservation = await observePage(controller.page, { cache });
      const verification = verifyExpectedResult(action, afterObservation, observation);
      history.push({ action, result: execution, verification });

      logs.push({
        step,
        observation: summarizeObservation(observation),
        action,
        execution,
        verification,
        elapsedMs: Date.now() - stepStart
      });

      console.log(`result: ${execution.ok ? "ok" : "failed"} - ${execution.message}`);
      console.log(`verify: ${verification.status} - ${verification.message}`);

      if (!execution.ok) {
        const screenshotPath = path.join(runDir, `failure-step-${step}.png`);
        await observePage(controller.page, { includeScreenshot: true, screenshotPath });
        console.log(`screenshot: ${screenshotPath}`);
      }
    }
  } finally {
    await writeFile(path.join(runDir, "steps.json"), JSON.stringify(logs, null, 2), "utf8");
    await controller.close();
    console.log(`log: ${path.join(runDir, "steps.json")}`);
    console.log(`elapsed: ${Date.now() - started}ms`);
  }
}

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const parts: string[] = [];

    while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      parts.push(argv[i + 1]);
      i += 1;
    }

    if (parts.length === 0) {
      values.set(key, true);
    } else {
      values.set(key, parts.join(" "));
    }
  }

  const url = stringValue(values, "url");
  const task = stringValue(values, "task");
  if (!url || !task) {
    throw new Error('Usage: npm run agent -- --url <url> --task "<task>" [--browser chrome] [--headful] [--max-steps 12] [--timeout-ms 8000] [--login-timeout-ms 600000] [--model model]');
  }

  return {
    url,
    task,
    headful: values.get("headful") === true,
    maxSteps: numberValue(values, "max-steps", 12),
    timeoutMs: numberValue(values, "timeout-ms", 8000),
    loginTimeoutMs: numberValue(values, "login-timeout-ms", 600000),
    browser: parseBrowser(stringValue(values, "browser")),
    model: stringValue(values, "model")
  };
}

function stringValue(values: Map<string, string | boolean>, key: string): string | undefined {
  const value = values.get(key);
  return typeof value === "string" ? value : undefined;
}

function numberValue(values: Map<string, string | boolean>, key: string, defaultValue: number): number {
  const value = stringValue(values, key);
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${key} must be a positive number.`);
  }

  return parsed;
}

async function createRunDir(): Promise<string> {
  const dir = path.join(process.cwd(), ".agent-runs", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(dir, { recursive: true });
  return dir;
}

async function confirmRiskyAction(actionType: string, reason: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log(`Risky ${actionType}: ${reason}`);
    console.log("stopped: interactive confirmation is required.");
    return false;
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`Risky ${actionType}: ${reason}\nType "yes" to continue: `);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function askUser(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(`Planner requested user input in a non-interactive shell: ${question}`);
  }

  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question(`${question}\n> `);
  } finally {
    rl.close();
  }
}

function printObservation(step: number, url: string, title: string, visibleText: string, elementCount: number): void {
  console.log(`\nstep ${step}`);
  console.log(`url: ${url}`);
  console.log(`title: ${title || "(untitled)"}`);
  console.log(`text: ${truncate(visibleText, 220)}`);
  console.log(`interactive elements: ${elementCount}`);
}

function summarizeObservation(observation: Awaited<ReturnType<typeof observePage>>) {
  return {
    url: observation.url,
    title: observation.title,
    pageKey: observation.pageKey,
    textSample: truncate(observation.visibleText, 300),
    elementCount: observation.elements.length
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
