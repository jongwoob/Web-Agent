import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { acquireControlledBrowserSession } from "./workflows/controlledBrowserSession.js";
import { browserChannel, type BrowserChoice } from "./workflows/shared.js";

export interface BrowserControllerOptions {
  headful: boolean;
  timeoutMs: number;
  browser?: BrowserChoice;
  userDataDir?: string;
  controlledSessionTargetUrl?: string;
}

export class BrowserController {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  private readonly releaseControlledSession?: () => Promise<void>;

  private constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    releaseControlledSession?: () => Promise<void>
  ) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.releaseControlledSession = releaseControlledSession;
  }

  static async launch(options: BrowserControllerOptions): Promise<BrowserController> {
    if (options.headful && options.controlledSessionTargetUrl && options.browser !== "chromium") {
      const session = await acquireControlledBrowserSession({
        browser: options.browser || "chrome",
        targetUrl: options.controlledSessionTargetUrl,
        timeoutMs: options.timeoutMs
      });
      return new BrowserController(session.browser, session.context, session.page, session.release);
    }

    if (options.userDataDir) {
      const context = await chromium.launchPersistentContext(options.userDataDir, {
        channel: browserChannel(options.browser || "chrome"),
        headless: !options.headful,
        chromiumSandbox: true,
        viewport: { width: 1280, height: 900 },
        ignoreHTTPSErrors: true
      });
      context.setDefaultTimeout(options.timeoutMs);
      context.setDefaultNavigationTimeout(Math.max(options.timeoutMs, 15000));
      const page = context.pages()[0] || (await context.newPage());
      const browser = context.browser();
      if (!browser) {
        await context.close().catch(() => undefined);
        throw new Error("Persistent browser context did not expose its browser instance.");
      }
      return new BrowserController(browser, context, page);
    }

    const browser = await chromium.launch({
      headless: !options.headful,
      chromiumSandbox: true
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ignoreHTTPSErrors: true
    });
    context.setDefaultTimeout(options.timeoutMs);
    context.setDefaultNavigationTimeout(Math.max(options.timeoutMs, 15000));
    const page = await context.newPage();
    return new BrowserController(browser, context, page);
  }

  async close(): Promise<void> {
    if (this.releaseControlledSession) {
      await this.releaseControlledSession();
      return;
    }
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }
}
