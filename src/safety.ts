import type { AgentAction, RiskLevel } from "./types.js";

export interface SafetyAssessment {
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  reason: string;
}

const dangerousActionPatterns = [
  /결제|구매|주문|송금|이체|탈퇴|삭제|게시|전송|발행|구독\s*취소/i,
  /pay|purchase|buy|order|checkout|delete|remove|destroy|cancel subscription/i,
  /send message|post|publish|transfer money|wire transfer|change account|account settings/i
];

const sensitiveInputPatterns = [
  /비밀번호|암호|일회용|인증번호|주민등록|카드|계좌|개인정보/i,
  /password|passcode|otp|2fa|mfa|one-time|credit card|card number|cvv|ssn|social security|bank account/i
];

export function assessActionSafety(action: AgentAction): SafetyAssessment {
  const text = [action.type, action.reason, action.target, action.selectorHint, action.text, action.expectedResult]
    .filter(Boolean)
    .join(" ");

  const declaredRisk = action.riskLevel ?? "low";

  if (declaredRisk === "high") {
    return {
      riskLevel: "high",
      requiresApproval: true,
      reason: "Planner marked this action as high risk."
    };
  }

  if (dangerousActionPatterns.some((pattern) => pattern.test(text))) {
    return {
      riskLevel: "high",
      requiresApproval: true,
      reason: "Action appears to involve payment, deletion, sending, posting, purchase, or account changes."
    };
  }

  if ((action.type === "fill" || action.type === "press") && sensitiveInputPatterns.some((pattern) => pattern.test(text))) {
    return {
      riskLevel: "high",
      requiresApproval: true,
      reason: "Action appears to enter sensitive credentials, payment, identity, or private data."
    };
  }

  if (declaredRisk === "medium") {
    return {
      riskLevel: "medium",
      requiresApproval: false,
      reason: "Planner marked this action as medium risk."
    };
  }

  return {
    riskLevel: "low",
    requiresApproval: false,
    reason: "No risky pattern detected."
  };
}
