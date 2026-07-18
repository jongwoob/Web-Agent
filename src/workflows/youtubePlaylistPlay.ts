import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "playwright";
import { acquireControlledBrowserSession, type ControlledBrowserChoice } from "./controlledBrowserSession.js";
import { runProviderPreflight } from "./providerPreflight.js";
import { numberValue, parseBrowser, parseFlagArgs, stringValue, updateStatus } from "./shared.js";

interface WorkflowArgs {
  playlistUrl: string;
  browser: ControlledBrowserChoice;
  statusFile: string;
  screenshotFile: string;
  timeoutMs: number;
}

export interface YoutubePlaylist {
  playlistId: string;
  url: string;
}

export interface PlaybackState {
  exists: boolean;
  paused: boolean;
  muted: boolean;
  volume: number;
  currentTime: number;
  readyState: number;
}

const DEFAULT_STATUS_FILE = "work/youtube-playlist-play-status.json";
const DEFAULT_SCREENSHOT_FILE = "work/youtube-playlist-play-screenshot.png";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const playlist = parseYoutubePlaylistUrl(args.playlistUrl);
  const started = Date.now();
  let session: Awaited<ReturnType<typeof acquireControlledBrowserSession>> | undefined;
  let reservePlaybackTab = false;

  await updateStatus(args.statusFile, "starting", "YouTube 재생목록 재생을 준비합니다.", {
    browser: args.browser,
    playlistUrl: playlist.url,
    profile: "controlled-session"
  });

  try {
    session = await acquireControlledBrowserSession({
      browser: args.browser,
      targetUrl: playlist.url,
      timeoutMs: args.timeoutMs
    });
    const page = session.page;

    await runProviderPreflight(page, {
      provider: "generic",
      targetUrl: playlist.url,
      statusFile: args.statusFile,
      timeoutMs: args.timeoutMs,
      loginTimeoutMs: args.timeoutMs,
      headless: false
    });

    await page.bringToFront();
    await clickPlayAll(page, args.timeoutMs);
    await page.waitForURL((url) => /^https:\/\/(?:www\.)?youtube\.com\/watch/.test(url.toString()), {
      timeout: args.timeoutMs
    });

    await waitForPlaylistContent(page, args.timeoutMs);
    const playback = await ensureAudiblePlayback(page, args.timeoutMs);
    await page.screenshot({ path: args.screenshotFile, fullPage: false }).catch(() => undefined);

    await updateStatus(args.statusFile, "completed", "YouTube 재생목록이 음소거 없이 재생 중입니다.", {
      browser: args.browser,
      profile: "controlled-session",
      playlistUrl: playlist.url,
      currentUrl: page.url(),
      reusedSession: session.reusedSession,
      reusedPage: session.reusedPage,
      playback,
      screenshotFile: args.screenshotFile,
      elapsedMs: Date.now() - started
    });
    reservePlaybackTab = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateStatus(args.statusFile, "failed", "YouTube 재생 상태를 확인하지 못했습니다.", {
      browser: args.browser,
      playlistUrl: playlist.url,
      error: message,
      elapsedMs: Date.now() - started
    });
    throw error;
  } finally {
    await session?.release({ reserveCurrentPage: reservePlaybackTab });
  }
}

export function parseYoutubePlaylistUrl(value: string): YoutubePlaylist {
  const input = new URL(value);
  const hostname = input.hostname.toLowerCase();
  if (!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(hostname) || input.pathname !== "/playlist") {
    throw new Error("YouTube 재생목록 URL만 사용할 수 있습니다.");
  }

  const playlistId = input.searchParams.get("list")?.trim();
  if (!playlistId) {
    throw new Error("YouTube 재생목록 URL에 list 값이 필요합니다.");
  }

  return {
    playlistId,
    url: `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`
  };
}

export function isAudiblyPlaying(state: PlaybackState): boolean {
  return state.exists && !state.paused && !state.muted && state.volume > 0 && state.currentTime > 0 && state.readyState >= 2;
}

export function isYoutubeAdPlayerClass(className: string): boolean {
  return className.split(/\s+/).includes("ad-showing");
}

async function clickPlayAll(page: Page, timeoutMs: number): Promise<void> {
  const candidates: Locator[] = [
    page.getByRole("button", { name: /^(모두 재생|Play all)$/i }),
    page.getByRole("button", { name: /(모두 재생|Play all)/i }),
    page.getByRole("link", { name: /(모두 재생|Play all)/i }),
    page.getByText(/^(모두 재생|Play all)$/i)
  ];

  for (const candidate of candidates) {
    const target = candidate.first();
    if (await target.isVisible({ timeout: Math.min(timeoutMs, 3000) }).catch(() => false)) {
      await target.click({ timeout: timeoutMs });
      return;
    }
  }

  throw new Error("YouTube의 모두 재생 버튼을 찾지 못했습니다.");
}

async function waitForPlaylistContent(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let adFreeSince: number | undefined;
  while (Date.now() < deadline) {
    if (!(await isAdvertisementPlaying(page))) {
      adFreeSince ??= Date.now();
      if (Date.now() - adFreeSince >= 1000) {
        return;
      }
      await page.waitForTimeout(250);
      continue;
    }

    adFreeSince = undefined;
    if (await clickSkipAdvertisement(page, Math.min(timeoutMs, 3000))) {
      await page.waitForTimeout(500);
      continue;
    }
    await page.waitForTimeout(1000);
  }

  throw new Error("YouTube 광고가 끝나지 않아 재생목록 곡의 재생을 확인하지 못했습니다.");
}

async function isAdvertisementPlaying(page: Page): Promise<boolean> {
  const className = await page.locator("#movie_player").getAttribute("class").catch(() => null);
  return isYoutubeAdPlayerClass(className || "");
}

async function clickSkipAdvertisement(page: Page, timeoutMs: number): Promise<boolean> {
  const candidates: Locator[] = [
    page.locator(".ytp-ad-skip-button"),
    page.getByRole("button", { name: /(광고 건너뛰기|Skip Ads|Skip ad)/i }),
    page.getByText(/^(광고 건너뛰기|Skip Ads|Skip ad)$/i)
  ];

  for (const candidate of candidates) {
    const target = candidate.first();
    if (await target.isVisible({ timeout: Math.min(timeoutMs, 1000) }).catch(() => false)) {
      await target.click({ timeout: timeoutMs });
      return true;
    }
  }
  return false;
}

async function ensureAudiblePlayback(page: Page, timeoutMs: number): Promise<PlaybackState> {
  const video = page.locator("video").first();
  await video.waitFor({ state: "attached", timeout: timeoutMs });
  const before = await inspectPlayback(page);

  await page.evaluate(async () => {
    const target = document.querySelector("video");
    if (!(target instanceof HTMLVideoElement)) {
      return;
    }
    target.muted = false;
    if (target.volume <= 0) {
      target.volume = 1;
    }
    try {
      await target.play();
    } catch {
      // The next state check reports an autoplay or player-level block.
    }
  });

  await page.waitForFunction(
    (minimumCurrentTime) => {
      const target = document.querySelector("video");
      return (
        target instanceof HTMLVideoElement &&
        !target.paused &&
        !target.muted &&
        target.volume > 0 &&
        target.readyState >= 2 &&
        target.currentTime >= minimumCurrentTime
      );
    },
    before.currentTime + 1,
    { timeout: timeoutMs }
  );

  const playback = await inspectPlayback(page);
  if (!isAudiblyPlaying(playback)) {
    throw new Error("YouTube 영상이 재생 중이며 음소거가 해제된 상태인지 확인하지 못했습니다.");
  }
  return playback;
}

async function inspectPlayback(page: Page): Promise<PlaybackState> {
  return page.evaluate(() => {
    const target = document.querySelector("video");
    if (!(target instanceof HTMLVideoElement)) {
      return {
        exists: false,
        paused: true,
        muted: true,
        volume: 0,
        currentTime: 0,
        readyState: 0
      };
    }
    return {
      exists: true,
      paused: target.paused,
      muted: target.muted,
      volume: target.volume,
      currentTime: target.currentTime,
      readyState: target.readyState
    };
  });
}

function parseArgs(argv: string[]): WorkflowArgs {
  const values = parseFlagArgs(argv);
  const playlistUrl = stringValue(values, "playlist-url") || stringValue(values, "url");
  if (!playlistUrl) {
    throw new Error("Usage: npm run workflow:youtube-playlist-play -- --playlist-url <youtube-playlist-url> [--browser chrome|edge]");
  }

  const browser = parseBrowser(stringValue(values, "browser"));
  if (browser === "chromium") {
    throw new Error("YouTube 재생은 소리가 나는 일반 Chrome 또는 Edge 제어 세션에서만 실행할 수 있습니다.");
  }

  return {
    playlistUrl,
    browser,
    statusFile: stringValue(values, "status-file") || DEFAULT_STATUS_FILE,
    screenshotFile: stringValue(values, "screenshot-file") || DEFAULT_SCREENSHOT_FILE,
    timeoutMs: numberValue(values, "timeout-ms", 30000)
  };
}

if (isDirectRun()) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  );
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
}
