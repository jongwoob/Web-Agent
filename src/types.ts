export type ActionType =
  | "navigate"
  | "click"
  | "fill"
  | "press"
  | "select"
  | "wait"
  | "extract"
  | "ask_user"
  | "done";

export type RiskLevel = "low" | "medium" | "high";

export interface AgentAction {
  type: ActionType;
  reason: string;
  target?: string;
  selectorHint?: string;
  text?: string;
  expectedResult?: string;
  riskLevel?: RiskLevel;
}

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface InteractiveElement {
  index: number;
  tag: string;
  role: string | null;
  text: string;
  label: string;
  placeholder: string;
  name: string;
  type: string;
  selector: string;
  disabled: boolean;
  box: ElementBox | null;
}

export interface Observation {
  url: string;
  title: string;
  visibleText: string;
  accessibilitySnapshot: string;
  elements: InteractiveElement[];
  screenshotPath?: string;
  observedAt: string;
  elapsedMs: number;
  pageKey: string;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  data?: unknown;
  elapsedMs: number;
}

export interface VerificationResult {
  status: "passed" | "failed" | "skipped";
  message: string;
}

export interface StepLog {
  step: number;
  observation: Pick<Observation, "url" | "title" | "pageKey"> & {
    textSample: string;
    elementCount: number;
  };
  action: AgentAction;
  execution?: ActionResult;
  verification?: VerificationResult;
  elapsedMs: number;
}

export interface AgentHistoryItem {
  action: AgentAction;
  result?: ActionResult;
  verification?: VerificationResult;
}
