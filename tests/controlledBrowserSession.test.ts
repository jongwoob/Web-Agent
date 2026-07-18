import { describe, expect, it } from "vitest";
import {
  buildControlledBrowserLaunchArgs,
  canReuseControlledSession,
  controlledSessionKey,
  controlledSessionPaths,
  selectReusablePageIndex
} from "../src/workflows/controlledBrowserSession.js";

describe("controlled browser session", () => {
  it("keeps one local-only debugging endpoint without disabling the browser sandbox", () => {
    const args = buildControlledBrowserLaunchArgs("C:\\profiles\\youtube", 9317);

    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--remote-debugging-port=9317");
    expect(args).toContain("--user-data-dir=C:\\profiles\\youtube");
    expect(args.join(" ")).not.toContain(["--no", "sandbox"].join("-"));
    expect(args.join(" ")).not.toContain("--mute-audio");
  });

  it("uses a stable per-site session and keeps its runtime record under work", () => {
    const target = "https://www.youtube.com/playlist?list=PL123";
    const paths = controlledSessionPaths("chrome", target, "C:\\web-agent");

    expect(controlledSessionKey("chrome", target)).toBe("www.youtube.com-chrome");
    expect(paths.profileDir).toBe("C:\\web-agent\\.browser-profiles\\controlled-www.youtube.com-chrome");
    expect(paths.descriptorFile).toBe("C:\\web-agent\\work\\browser-sessions\\www.youtube.com-chrome.json");
  });

  it("reuses a matching provider tab, then a blank tab, without replacing another site's page", () => {
    const target = "https://www.youtube.com/playlist?list=PL123";

    expect(selectReusablePageIndex(["https://example.com/", "https://www.youtube.com/watch?v=abc"], target)).toBe(1);
    expect(selectReusablePageIndex(["https://example.com/", "about:blank"], target)).toBe(1);
    expect(selectReusablePageIndex(["https://example.com/"], target)).toBe(-1);
    expect(
      selectReusablePageIndex(
        ["https://www.youtube.com/watch?v=playing", "about:blank"],
        target,
        "https://www.youtube.com/watch?v=playing"
      )
    ).toBe(1);
  });

  it("does not reuse a session while another task owns it", () => {
    const base = {
      schemaVersion: 1 as const,
      key: "www.youtube.com-chrome",
      browser: "chrome" as const,
      profileDir: "C:\\profiles\\youtube",
      port: 9317,
      updatedAt: new Date(0).toISOString()
    };

    expect(canReuseControlledSession({ ...base, status: "idle" })).toBe(true);
    expect(canReuseControlledSession({ ...base, status: "busy" })).toBe(false);
  });
});
