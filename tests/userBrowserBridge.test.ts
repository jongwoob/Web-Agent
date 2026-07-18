import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildUserBrowserBridgeSetupPlan } from "../src/workflows/userBrowserBridgeSetup.js";
import {
  createUserBrowserBridgeConfig,
  loadUserBrowserBridgeConfig,
  startUserBrowserBridge,
  userBrowserBridgeEndpoint,
  userBrowserBridgePaths
} from "../src/workflows/userBrowserBridge.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("regular user browser bridge", () => {
  it("stores a per-browser local endpoint and pairing key only under work", async () => {
    const root = await createTemporaryRoot();
    const config = await createUserBrowserBridgeConfig("chrome", { rootDir: root });
    const paths = userBrowserBridgePaths("chrome", root);

    expect(paths.configFile).toBe(path.join(root, "work", "user-browser-bridge", "chrome.json"));
    expect(userBrowserBridgeEndpoint(config)).toBe(`http://127.0.0.1:${config.port}`);
    expect(config.token).toHaveLength(43);
    expect(await loadUserBrowserBridgeConfig("chrome", root)).toEqual(config);
  });

  it("delivers only a paired extension command over the localhost bridge", async () => {
    const root = await createTemporaryRoot();
    const config = await createUserBrowserBridgeConfig("chrome", { rootDir: root });
    const bridge = await startUserBrowserBridge({ config, rootDir: root });
    const endpoint = userBrowserBridgeEndpoint(config);

    try {
      const poll = fetch(`${endpoint}/v1/poll`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-web-agent-token": config.token },
        body: JSON.stringify({ extensionId: "abcdefghijklmnopabcdefghijklmnop", browser: "chrome", version: "0.1.0" })
      });
      await bridge.waitForExtension(2_000);

      const playbackPromise = bridge.playYoutubePlaylist({
        playlistUrl: "https://www.youtube.com/playlist?list=PL123",
        preflightHomeUrl: "https://www.youtube.com/",
        timeoutMs: 2_000
      });
      const pollResponse = await poll;
      const envelope = (await pollResponse.json()) as { command: { id: string; type: string } };
      expect(envelope.command.type).toBe("youtube-playlist-play");

      const resultResponse = await fetch(`${endpoint}/v1/result`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-web-agent-token": config.token },
        body: JSON.stringify({
          id: envelope.command.id,
          ok: true,
          data: {
            preflightHomeUrl: "https://www.youtube.com/",
            currentUrl: "https://www.youtube.com/watch?v=abc&list=PL123",
            tabId: 12,
            reusedTab: true,
            playback: {
              exists: true,
              paused: false,
              muted: false,
              tabMuted: false,
              volume: 1,
              currentTime: 2,
              readyState: 4
            }
          }
        })
      });

      expect(resultResponse.status).toBe(200);
      await expect(playbackPromise).resolves.toMatchObject({ tabId: 12, reusedTab: true });
      const persisted = JSON.parse(await readFile(userBrowserBridgePaths("chrome", root).configFile, "utf8")) as {
        extensionId?: string;
      };
      expect(persisted.extensionId).toBe("abcdefghijklmnopabcdefghijklmnop");
    } finally {
      await bridge.close();
    }
  });

  it("rejects an unpaired local request before it can queue a browser command", async () => {
    const root = await createTemporaryRoot();
    const config = await createUserBrowserBridgeConfig("chrome", { rootDir: root });
    const bridge = await startUserBrowserBridge({ config, rootDir: root });

    try {
      const response = await fetch(`${userBrowserBridgeEndpoint(config)}/v1/poll`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-web-agent-token": "not-the-pairing-key" },
        body: JSON.stringify({ extensionId: "another-extension", browser: "chrome" })
      });
      expect(response.status).toBe(401);
    } finally {
      await bridge.close();
    }
  });

  it("keeps site access optional and opens the matching browser extensions page", async () => {
    const manifest = JSON.parse(
      await readFile(path.resolve(process.cwd(), "extensions", "user-browser-bridge", "manifest.json"), "utf8")
    ) as { manifest_version: number; host_permissions: string[]; optional_host_permissions: string[] };
    const chromePlan = buildUserBrowserBridgeSetupPlan("chrome", "work/setup.json", "C:\\web-agent");
    const edgePlan = buildUserBrowserBridgeSetupPlan("edge", "work/setup.json", "C:\\web-agent");

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*"]);
    expect(manifest.optional_host_permissions).toEqual(["https://*/*", "http://*/*"]);
    expect(chromePlan.extensionPageUrl).toBe("chrome://extensions/");
    expect(edgePlan.extensionPageUrl).toBe("edge://extensions/");
  });
});

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "web-agent-user-browser-"));
  temporaryRoots.push(root);
  return root;
}
