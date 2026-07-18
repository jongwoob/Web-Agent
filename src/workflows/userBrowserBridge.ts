import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import process from "node:process";
import type { UserBrowserChoice } from "./openUserBrowser.js";

export interface UserBrowserBridgeConfig {
  schemaVersion: 1;
  browser: UserBrowserChoice;
  port: number;
  token: string;
  extensionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserBrowserBridgePaths {
  directory: string;
  configFile: string;
  setupFile: string;
}

export interface UserBrowserPlaybackState {
  exists: boolean;
  paused: boolean;
  muted: boolean;
  tabMuted: boolean;
  volume: number;
  currentTime: number;
  readyState: number;
}

export interface UserBrowserYoutubePlaylistResult {
  preflightHomeUrl: string;
  currentUrl: string;
  tabId: number;
  reusedTab: boolean;
  playback: UserBrowserPlaybackState;
  screenshotDataUrl?: string;
}

interface BridgeCommand {
  id: string;
  type: "youtube-playlist-play";
  payload: {
    playlistUrl: string;
    preflightHomeUrl: string;
    timeoutMs: number;
    captureScreenshot: boolean;
  };
}

interface BridgeCommandResult {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

interface ExtensionPollPayload {
  extensionId: string;
  browser: UserBrowserChoice;
  version?: string;
}

interface PendingCommand {
  command: BridgeCommand;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface StartUserBrowserBridgeOptions {
  config: UserBrowserBridgeConfig;
  rootDir?: string;
}

const MAX_REQUEST_BYTES = 15 * 1024 * 1024;
const POLL_WAIT_MS = 25_000;

export function userBrowserBridgePaths(
  browser: UserBrowserChoice,
  rootDir = process.cwd()
): UserBrowserBridgePaths {
  const directory = path.resolve(rootDir, "work", "user-browser-bridge");
  return {
    directory,
    configFile: path.join(directory, `${browser}.json`),
    setupFile: path.join(directory, `${browser}-setup.json`)
  };
}

export function userBrowserBridgeEndpoint(config: Pick<UserBrowserBridgeConfig, "port">): string {
  return `http://127.0.0.1:${config.port}`;
}

export async function loadUserBrowserBridgeConfig(
  browser: UserBrowserChoice,
  rootDir = process.cwd()
): Promise<UserBrowserBridgeConfig | null> {
  const file = userBrowserBridgePaths(browser, rootDir).configFile;
  const source = await readFile(file, "utf8").catch(() => "");
  if (!source) {
    return null;
  }

  try {
    const value = JSON.parse(source) as Partial<UserBrowserBridgeConfig>;
    if (!isUserBrowserBridgeConfig(value) || value.browser !== browser) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export async function createUserBrowserBridgeConfig(
  browser: UserBrowserChoice,
  options: { rootDir?: string; reset?: boolean } = {}
): Promise<UserBrowserBridgeConfig> {
  const rootDir = options.rootDir || process.cwd();
  if (!options.reset) {
    const existing = await loadUserBrowserBridgeConfig(browser, rootDir);
    if (existing) {
      return existing;
    }
  }

  const paths = userBrowserBridgePaths(browser, rootDir);
  const now = new Date().toISOString();
  const config: UserBrowserBridgeConfig = {
    schemaVersion: 1,
    browser,
    port: await findAvailablePort(),
    token: randomBytes(32).toString("base64url"),
    createdAt: now,
    updatedAt: now
  };
  await writeUserBrowserBridgeConfig(paths.configFile, config);
  return config;
}

export function isUserBrowserBridgeConfig(value: Partial<UserBrowserBridgeConfig>): value is UserBrowserBridgeConfig {
  return (
    value.schemaVersion === 1 &&
    (value.browser === "chrome" || value.browser === "edge") &&
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port > 0 &&
    value.port < 65_536 &&
    typeof value.token === "string" &&
    value.token.length >= 32 &&
    (value.extensionId === undefined || typeof value.extensionId === "string") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

export async function startUserBrowserBridge(options: StartUserBrowserBridgeOptions): Promise<UserBrowserBridge> {
  const bridge = new UserBrowserBridge(options.config, options.rootDir || process.cwd());
  await bridge.start();
  return bridge;
}

export class UserBrowserBridge {
  private readonly paths: UserBrowserBridgePaths;
  private readonly server: Server;
  private config: UserBrowserBridgeConfig;
  private pendingPoll?: ServerResponse;
  private pendingPollTimer?: NodeJS.Timeout;
  private pendingCommand?: PendingCommand;
  private extensionWaiters: Array<() => void> = [];
  private connectedExtensionId?: string;
  private closed = false;

  public constructor(config: UserBrowserBridgeConfig, rootDir: string) {
    this.config = config;
    this.paths = userBrowserBridgePaths(config.browser, rootDir);
    this.server = createHttpServer((request, response) => {
      void this.handleRequest(request, response);
    });
  }

  public async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  public async waitForExtension(timeoutMs: number): Promise<void> {
    if (this.connectedExtensionId) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.extensionWaiters = this.extensionWaiters.filter((waiter) => waiter !== onConnected);
        reject(new Error("일반 사용자 브라우저 연결 확장이 지정 시간 안에 연결되지 않았습니다."));
      }, timeoutMs);
      const onConnected = () => {
        clearTimeout(timer);
        resolve();
      };
      this.extensionWaiters.push(onConnected);
    });
  }

  public async playYoutubePlaylist(
    payload: Omit<BridgeCommand["payload"], "captureScreenshot">
  ): Promise<UserBrowserYoutubePlaylistResult> {
    const value = await this.dispatchCommand(
      {
        type: "youtube-playlist-play",
        payload: { ...payload, captureScreenshot: true }
      },
      payload.timeoutMs
    );
    return parseUserBrowserYoutubePlaylistResult(value);
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.abortPendingPoll();
    if (this.pendingCommand) {
      clearTimeout(this.pendingCommand.timeout);
      this.pendingCommand.reject(new Error("일반 사용자 브라우저 연결을 종료했습니다."));
      this.pendingCommand = undefined;
    }
    for (const resolve of this.extensionWaiters.splice(0)) {
      resolve();
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!sameToken(request.headers["x-web-agent-token"], this.config.token)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      if (request.url === "/v1/poll") {
        await this.handlePoll(request, response);
        return;
      }
      if (request.url === "/v1/result") {
        await this.handleResult(request, response);
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid_request" });
      }
    }
  }

  private async handlePoll(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const payload = await readJson<ExtensionPollPayload>(request);
    await this.acceptExtension(payload);

    if (this.pendingPoll) {
      sendJson(this.pendingPoll, 200, { command: null, retryAfterMs: 1000 });
      this.clearPendingPoll();
    }

    if (this.pendingCommand) {
      sendJson(response, 200, { command: this.pendingCommand.command });
      return;
    }

    this.pendingPoll = response;
    this.pendingPollTimer = setTimeout(() => {
      if (this.pendingPoll === response && !response.writableEnded) {
        sendJson(response, 200, { command: null, retryAfterMs: 1000 });
      }
      if (this.pendingPoll === response) {
        this.clearPendingPoll();
      }
    }, POLL_WAIT_MS);
    response.once("close", () => {
      if (this.pendingPoll === response) {
        this.clearPendingPoll();
      }
    });
  }

  private async handleResult(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const payload = await readJson<BridgeCommandResult>(request);
    if (!this.pendingCommand || payload.id !== this.pendingCommand.command.id) {
      sendJson(response, 409, { error: "unknown_command" });
      return;
    }

    const pending = this.pendingCommand;
    this.pendingCommand = undefined;
    clearTimeout(pending.timeout);
    if (payload.ok) {
      pending.resolve(payload.data);
      sendJson(response, 200, { accepted: true });
      return;
    }
    pending.reject(new Error(payload.error || "일반 사용자 브라우저가 작업을 완료하지 못했습니다."));
    sendJson(response, 200, { accepted: true });
  }

  private async acceptExtension(payload: ExtensionPollPayload): Promise<void> {
    if (!payload || typeof payload.extensionId !== "string" || !payload.extensionId) {
      throw new Error("확장 식별자가 없습니다.");
    }
    if (payload.browser !== this.config.browser) {
      throw new Error("선택한 일반 브라우저와 연결 확장의 브라우저가 다릅니다.");
    }
    if (this.config.extensionId && this.config.extensionId !== payload.extensionId) {
      throw new Error("다른 확장이 이미 이 일반 브라우저 연결에 등록되어 있습니다. 설정을 재초기화하세요.");
    }
    if (!this.config.extensionId) {
      this.config = {
        ...this.config,
        extensionId: payload.extensionId,
        updatedAt: new Date().toISOString()
      };
      await writeUserBrowserBridgeConfig(this.paths.configFile, this.config);
    }
    this.connectedExtensionId = payload.extensionId;
    for (const resolve of this.extensionWaiters.splice(0)) {
      resolve();
    }
  }

  private async dispatchCommand(
    input: Omit<BridgeCommand, "id">,
    timeoutMs: number
  ): Promise<unknown> {
    if (this.pendingCommand) {
      throw new Error("일반 사용자 브라우저에서 이미 다른 작업을 처리하고 있습니다.");
    }
    if (this.closed) {
      throw new Error("일반 사용자 브라우저 연결이 종료되었습니다.");
    }

    const command: BridgeCommand = { ...input, id: randomUUID() };
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingCommand?.command.id === command.id) {
          this.pendingCommand = undefined;
        }
        reject(new Error("일반 사용자 브라우저가 작업 결과를 지정 시간 안에 반환하지 않았습니다."));
      }, timeoutMs);
      this.pendingCommand = { command, resolve, reject, timeout };
      this.deliverPendingCommand();
    });
  }

  private deliverPendingCommand(): void {
    if (!this.pendingPoll || !this.pendingCommand) {
      return;
    }
    const response = this.pendingPoll;
    this.clearPendingPoll();
    sendJson(response, 200, { command: this.pendingCommand.command });
  }

  private clearPendingPoll(): void {
    if (this.pendingPollTimer) {
      clearTimeout(this.pendingPollTimer);
    }
    this.pendingPoll = undefined;
    this.pendingPollTimer = undefined;
  }

  private abortPendingPoll(): void {
    const response = this.pendingPoll;
    this.clearPendingPoll();
    response?.destroy();
  }
}

export function parseUserBrowserYoutubePlaylistResult(value: unknown): UserBrowserYoutubePlaylistResult {
  if (!value || typeof value !== "object") {
    throw new Error("일반 사용자 브라우저가 올바르지 않은 YouTube 결과를 반환했습니다.");
  }
  const result = value as Partial<UserBrowserYoutubePlaylistResult>;
  if (
    typeof result.preflightHomeUrl !== "string" ||
    typeof result.currentUrl !== "string" ||
    typeof result.tabId !== "number" ||
    typeof result.reusedTab !== "boolean" ||
    !isPlaybackState(result.playback)
  ) {
    throw new Error("일반 사용자 브라우저가 올바르지 않은 YouTube 재생 상태를 반환했습니다.");
  }
  if (result.screenshotDataUrl !== undefined && typeof result.screenshotDataUrl !== "string") {
    throw new Error("일반 사용자 브라우저가 올바르지 않은 screenshot 값을 반환했습니다.");
  }
  return result as UserBrowserYoutubePlaylistResult;
}

function isPlaybackState(value: unknown): value is UserBrowserPlaybackState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const state = value as Partial<UserBrowserPlaybackState>;
  return (
    typeof state.exists === "boolean" &&
    typeof state.paused === "boolean" &&
    typeof state.muted === "boolean" &&
    typeof state.tabMuted === "boolean" &&
    typeof state.volume === "number" &&
    typeof state.currentTime === "number" &&
    typeof state.readyState === "number"
  );
}

async function writeUserBrowserBridgeConfig(file: string, config: UserBrowserBridgeConfig): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2), "utf8");
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("요청 본문이 너무 큽니다.");
    }
    chunks.push(buffer);
  }
  const source = Buffer.concat(chunks).toString("utf8");
  if (!source) {
    throw new Error("요청 본문이 없습니다.");
  }
  return JSON.parse(source) as T;
}

function sameToken(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const actualBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.writableEnded) {
    return;
  }
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(value));
}

async function findAvailablePort(): Promise<number> {
  const server = createNetServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("일반 사용자 브라우저 연결 포트를 할당하지 못했습니다.")));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
