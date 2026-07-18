const endpointInput = document.querySelector("#endpoint");
const tokenInput = document.querySelector("#token");
const statusElement = document.querySelector("#status");

void load();
document.querySelector("#save").addEventListener("click", () => void save());
document.querySelector("#youtube").addEventListener("click", () => void requestYoutubePermission());
document.querySelector("#current-site").addEventListener("click", () => void requestCurrentSitePermission());

async function load() {
  const values = await chrome.storage.local.get(["endpoint", "token", "lastState", "lastError"]);
  endpointInput.value = values.endpoint || "";
  tokenInput.value = values.token || "";
  setStatus(values.lastError || values.lastState || "");
}

async function save() {
  const endpoint = endpointInput.value.trim().replace(/\/$/, "");
  const token = tokenInput.value.trim();
  if (!isLocalEndpoint(endpoint) || token.length < 32) {
    setStatus("로컬 주소 또는 연결 키를 확인하세요.");
    return;
  }
  await chrome.storage.local.set({ endpoint, token });
  chrome.runtime.sendMessage({ type: "web-agent-wake" });
  setStatus("저장됨");
}

async function requestYoutubePermission() {
  const granted = await chrome.permissions.request({ origins: ["https://*.youtube.com/*"] });
  setStatus(granted ? "YouTube 권한 허용됨" : "YouTube 권한이 허용되지 않았습니다.");
}

async function requestCurrentSitePermission() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) {
    setStatus("현재 사이트를 확인하지 못했습니다.");
    return;
  }
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    setStatus("http 또는 https 사이트에서만 권한을 허용할 수 있습니다.");
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    setStatus("http 또는 https 사이트에서만 권한을 허용할 수 있습니다.");
    return;
  }
  const origin = `${url.protocol}//${url.hostname}/*`;
  const granted = await chrome.permissions.request({ origins: [origin] });
  setStatus(granted ? `${url.hostname} 권한 허용됨` : `${url.hostname} 권한이 허용되지 않았습니다.`);
}

function isLocalEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && Boolean(url.port);
  } catch {
    return false;
  }
}

function setStatus(value) {
  statusElement.textContent = value;
}
