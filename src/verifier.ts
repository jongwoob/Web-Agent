import type { AgentAction, Observation, VerificationResult } from "./types.js";

export function verifyExpectedResult(
  action: AgentAction,
  observation: Observation,
  previousObservation?: Observation
): VerificationResult {
  if (!action.expectedResult) {
    return {
      status: "skipped",
      message: "No expectedResult was provided for this action."
    };
  }

  const expected = action.expectedResult.toLowerCase();
  const haystack = [
    observation.url,
    observation.title,
    observation.visibleText,
    observation.accessibilitySnapshot,
    ...observation.elements.flatMap((element) => [
      element.text,
      element.label,
      element.placeholder,
      element.name,
      element.selector
    ])
  ]
    .join(" ")
    .toLowerCase();

  if (haystack.includes(expected)) {
    return {
      status: "passed",
      message: `Observed expected result: ${action.expectedResult}`
    };
  }

  if (
    previousObservation &&
    ["click", "navigate", "press"].includes(action.type) &&
    previousObservation.url !== observation.url
  ) {
    return {
      status: "passed",
      message: `Navigation was observed after ${action.type}: ${observation.url}`
    };
  }

  return {
    status: "failed",
    message: `Expected result was not observed yet: ${action.expectedResult}`
  };
}
