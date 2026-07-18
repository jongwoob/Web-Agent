import { describe, expect, it } from "vitest";
import {
  browserExecutableCandidates,
  buildUserBrowserLaunchPlan,
  parseUserBrowser,
  resolveUserBrowserExecutable
} from "../src/workflows/openUserBrowser.js";

describe("regular user browser workflow", () => {
  const env = {
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local"
  };

  it("opens the provider home before the target without a profile argument", () => {
    const plan = buildUserBrowserLaunchPlan("https://forms.google.com", "chrome");

    expect(plan.provider).toBe("google");
    expect(plan.reuseExistingBrowser).toBe(true);
    expect(plan.homeArgs).toEqual(["https://www.google.com/?hl=ko"]);
    expect(plan.targetArgs).toEqual(["https://forms.google.com/"]);
    expect(plan.homeArgs.join(" ")).not.toContain("new-window");
    expect(plan.homeArgs.join(" ")).not.toContain("user-data-dir");
    expect(plan.targetArgs.join(" ")).not.toContain("user-data-dir");
  });

  it("supports the ordinary Chrome and Edge executables only", () => {
    expect(parseUserBrowser()).toBe("chrome");
    expect(parseUserBrowser("edge")).toBe("edge");
    expect(() => parseUserBrowser("chromium")).toThrow("chrome 또는 edge");

    expect(browserExecutableCandidates("chrome", env)[0]).toBe(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    );
    expect(browserExecutableCandidates("edge", env)[0]).toBe(
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
    );
  });

  it("selects an installed executable without touching profile paths", () => {
    const executable = resolveUserBrowserExecutable("edge", env, (candidate) => candidate.includes("Program Files (x86)"));

    expect(executable).toBe("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
  });
});
