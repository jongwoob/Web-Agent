const POLL_ALARM = "web-agent-user-browser-poll";
const POLL_TIMEOUT_MS = 30_000;

let polling = false;
let retryTimer;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
  void pollForWork();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
  void pollForWork();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    void pollForWork();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "web-agent-wake") {
    void pollForWork();
  }
});

async function pollForWork() {
  if (polling) {
    return;
  }
  const settings = await getSettings();
  if (!settings) {
    return;
  }

  polling = true;
  try {
    await saveStatus("연결 대기 중", undefined);
    const response = await fetch(`${settings.endpoint}/v1/poll`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-web-agent-token": settings.token
      },
      body: JSON.stringify({
        extensionId: chrome.runtime.id,
        browser: detectBrowser(),
        version: chrome.runtime.getManifest().version
      }),
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS)
    });
    if (!response.ok) {
      throw new Error(`연결 응답 ${response.status}`);
    }
    const envelope = await response.json();
    await saveStatus("연결됨", undefined);
    if (!envelope.command) {
      schedulePoll(250);
      return;
    }

    let result;
    try {
      result = await executeCommand(envelope.command);
    } catch (error) {
      result = {
        id: envelope.command.id,
        ok: false,
        error: error instanceof Error ? error.message : "일반 브라우저 작업에 실패했습니다."
      };
    }
    await postResult(settings, result);
  } catch (error) {
    await saveStatus("연결 대기 중", error instanceof Error ? error.message : "연결할 수 없습니다.");
    schedulePoll(5_000);
  } finally {
    polling = false;
  }
}

function schedulePoll(delayMs) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void pollForWork(), delayMs);
}

async function executeCommand(command) {
  if (command?.type !== "youtube-playlist-play") {
    throw new Error("허용되지 않은 일반 브라우저 작업입니다.");
  }
  const data = await playYoutubePlaylist(command.payload);
  return { id: command.id, ok: true, data };
}

async function playYoutubePlaylist(payload) {
  validateYoutubePayload(payload);
  await ensureYoutubePermission(payload.playlistUrl);

  const selection = await findOrCreateYoutubeTab(payload.playlistUrl);
  let tab = selection.tab;
  tab = await chrome.tabs.update(tab.id, { active: true, muted: false });
  await navigateTab(tab.id, payload.preflightHomeUrl, payload.timeoutMs);
  await navigateTab(tab.id, payload.playlistUrl, payload.timeoutMs);

  const clicked = await runPageFunction(tab.id, clickYoutubePlayAllInPage);
  if (!clicked) {
    throw new Error("YouTube의 모두 재생 버튼을 찾지 못했습니다.");
  }

  await waitForTabUrl(
    tab.id,
    (url) => url.hostname.endsWith("youtube.com") && url.pathname === "/watch",
    payload.timeoutMs
  );
  const playback = await waitForAudibleYoutubePlayback(tab.id, payload.timeoutMs);
  const finalTab = await chrome.tabs.get(tab.id);
  const screenshotDataUrl = payload.captureScreenshot
    ? await chrome.tabs.captureVisibleTab(finalTab.windowId, { format: "png" }).catch(() => undefined)
    : undefined;

  return {
    preflightHomeUrl: payload.preflightHomeUrl,
    currentUrl: finalTab.url || payload.playlistUrl,
    tabId: tab.id,
    reusedTab: selection.reusedTab,
    playback: { ...playback, tabMuted: Boolean(finalTab.mutedInfo?.muted) },
    screenshotDataUrl
  };
}

async function findOrCreateYoutubeTab(targetUrl) {
  const target = new URL(targetUrl);
  const tabs = await chrome.tabs.query({});
  const exact = tabs.find((tab) => tab.id && isExactYoutubePlaylist(tab.url, targetUrl) && !isWatchPage(tab.url));
  if (exact) {
    return { tab: exact, reusedTab: true };
  }

  const blank = tabs.find((tab) => tab.id && tab.url === "about:blank" && !tab.active);
  if (blank) {
    return { tab: blank, reusedTab: true };
  }

  const created = await chrome.tabs.create({ url: "about:blank", active: true });
  return { tab: created, reusedTab: false };
}

async function navigateTab(tabId, url, timeoutMs) {
  await chrome.tabs.update(tabId, { url, active: true });
  return waitForTabUrl(tabId, (currentUrl) => currentUrl.href === new URL(url).href, timeoutMs);
}

async function waitForTabUrl(tabId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) {
      const url = new URL(tab.url);
      if (predicate(url)) {
        return tab;
      }
    }
    await delay(150);
  }
  throw new Error("일반 브라우저 탭이 예상한 페이지로 이동하지 않았습니다.");
}

async function waitForAudibleYoutubePlayback(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let initialCurrentTime;
  let adFreeSince;

  while (Date.now() < deadline) {
    const state = await runPageFunction(tabId, advanceYoutubePlaybackInPage);
    if (state.adShowing) {
      initialCurrentTime = undefined;
      adFreeSince = undefined;
      await delay(500);
      continue;
    }

    adFreeSince ??= Date.now();
    initialCurrentTime ??= state.currentTime;
    if (
      Date.now() - adFreeSince >= 1000 &&
      state.exists &&
      !state.paused &&
      !state.muted &&
      state.volume > 0 &&
      state.readyState >= 2 &&
      state.currentTime >= initialCurrentTime + 1
    ) {
      return state;
    }
    await delay(250);
  }
  throw new Error("YouTube 재생 목록의 실제 소리 재생 상태를 확인하지 못했습니다.");
}

async function runPageFunction(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });
  if (!results.length) {
    throw new Error("일반 브라우저 탭에서 작업 결과를 받지 못했습니다.");
  }
  return results[0].result;
}

function clickYoutubePlayAllInPage() {
  const normalize = (value) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const candidates = Array.from(document.querySelectorAll("button, a, ytd-button-renderer, yt-button-shape button"));
  const target = candidates.find((element) => {
    const label = normalize(`${element.getAttribute("aria-label") || ""} ${element.textContent || ""}`);
    return isVisible(element) && (label === "모두 재생" || label.includes("play all") || label.includes("모두 재생"));
  });
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  target.click();
  return true;
}

async function advanceYoutubePlaybackInPage() {
  const player = document.querySelector("#movie_player");
  const adShowing = Boolean(player?.classList.contains("ad-showing"));
  if (adShowing) {
    const skip = document.querySelector(".ytp-ad-skip-button, .ytp-ad-skip-button-modern, button[aria-label*='Skip']");
    if (skip instanceof HTMLElement) {
      skip.click();
    }
  }

  const video = document.querySelector("video");
  if (!(video instanceof HTMLVideoElement)) {
    return {
      adShowing,
      exists: false,
      paused: true,
      muted: true,
      volume: 0,
      currentTime: 0,
      readyState: 0
    };
  }
  video.muted = false;
  if (video.volume <= 0) {
    video.volume = 1;
  }
  try {
    await video.play();
  } catch {
    // 재생 상태 검증에서 autoplay 또는 플레이어 차단을 판별한다.
  }
  return {
    adShowing,
    exists: true,
    paused: video.paused,
    muted: video.muted,
    volume: video.volume,
    currentTime: video.currentTime,
    readyState: video.readyState
  };
}

function isExactYoutubePlaylist(value, targetUrl) {
  try {
    const current = new URL(value || "");
    const target = new URL(targetUrl);
    return current.hostname === target.hostname && current.pathname === target.pathname && current.searchParams.get("list") === target.searchParams.get("list");
  } catch {
    return false;
  }
}

function isWatchPage(value) {
  try {
    return new URL(value || "").pathname === "/watch";
  } catch {
    return false;
  }
}

async function ensureYoutubePermission(url) {
  const granted = await chrome.permissions.contains({ origins: ["https://*.youtube.com/*"] });
  if (!granted) {
    const hostname = new URL(url).hostname;
    throw new Error(`${hostname} 권한이 없습니다. 확장 팝업에서 YouTube 권한을 먼저 허용하세요.`);
  }
}

function validateYoutubePayload(payload) {
  if (!payload || typeof payload.playlistUrl !== "string" || typeof payload.preflightHomeUrl !== "string") {
    throw new Error("YouTube 작업 정보가 올바르지 않습니다.");
  }
}

async function postResult(settings, result) {
  const response = await fetch(`${settings.endpoint}/v1/result`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-web-agent-token": settings.token
    },
    body: JSON.stringify(result),
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`결과 전송 응답 ${response.status}`);
  }
}

async function getSettings() {
  const values = await chrome.storage.local.get(["endpoint", "token"]);
  if (!isLocalEndpoint(values.endpoint) || typeof values.token !== "string" || values.token.length < 32) {
    return null;
  }
  return { endpoint: values.endpoint.replace(/\/$/, ""), token: values.token };
}

function isLocalEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && Boolean(url.port);
  } catch {
    return false;
  }
}

function detectBrowser() {
  return navigator.userAgent.includes("Edg/") ? "edge" : "chrome";
}

async function saveStatus(state, error) {
  await chrome.storage.local.set({
    lastState: state,
    lastError: error || "",
    lastUpdatedAt: new Date().toISOString()
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
