import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { launchVisibleBrowser, parseUserBrowser, resolveUserBrowserExecutable, type UserBrowserChoice } from "./openUserBrowser.js";
import { createUserBrowserBridgeConfig, userBrowserBridgeEndpoint, userBrowserBridgePaths } from "./userBrowserBridge.js";
import { parseFlagArgs, stringValue, updateStatus } from "./shared.js";

interface SetupArgs {
  browser: UserBrowserChoice;
  reset: boolean;
  openBrowser: boolean;
  statusFile: string;
}

export interface UserBrowserBridgeSetupPlan {
  browser: UserBrowserChoice;
  extensionDirectory: string;
  extensionPageUrl: string;
  statusFile: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildUserBrowserBridgeSetupPlan(args.browser, args.statusFile);
  const config = await createUserBrowserBridgeConfig(args.browser, { reset: args.reset });
  const paths = userBrowserBridgePaths(args.browser);

  await updateStatus(args.statusFile, "ready_for_extension_install", "일반 사용자 브라우저 연결 확장 설치 정보를 준비했습니다.", {
    browser: args.browser,
    extensionDirectory: plan.extensionDirectory,
    extensionPageUrl: plan.extensionPageUrl,
    endpoint: userBrowserBridgeEndpoint(config),
    pairingKey: config.token,
    configurationFile: paths.configFile,
    extensionId: config.extensionId
  });

  if (args.openBrowser) {
    await launchVisibleBrowser(resolveUserBrowserExecutable(args.browser), [plan.extensionPageUrl]);
  }
}

export function buildUserBrowserBridgeSetupPlan(
  browser: UserBrowserChoice,
  statusFile = "work/user-browser-bridge-setup.json",
  rootDir = process.cwd()
): UserBrowserBridgeSetupPlan {
  return {
    browser,
    extensionDirectory: path.resolve(rootDir, "extensions", "user-browser-bridge"),
    extensionPageUrl: browser === "chrome" ? "chrome://extensions/" : "edge://extensions/",
    statusFile
  };
}

function parseArgs(argv: string[]): SetupArgs {
  const values = parseFlagArgs(argv);
  const browser = parseUserBrowser(stringValue(values, "browser"));
  return {
    browser,
    reset: values.get("reset") === true,
    openBrowser: values.get("no-open-browser") !== true,
    statusFile: stringValue(values, "status-file") || userBrowserBridgePaths(browser).setupFile
  };
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
}
