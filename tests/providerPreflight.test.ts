import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { describe, expect, it } from "vitest";
import { BrowserController } from "../src/browser.js";
import {
  inferWebProvider,
  isProviderLoginUrl,
  providerAgentProfileDir,
  providerHomeUrl,
  runProviderPreflight
} from "../src/workflows/providerPreflight.js";

describe("provider home preflight", () => {
  it("maps known providers and generic site homes", () => {
    expect(inferWebProvider("https://mail.google.com/mail/u/0/")).toBe("google");
    expect(inferWebProvider("https://forms.new")).toBe("google");
    expect(inferWebProvider("https://mail.naver.com/")).toBe("naver");
    expect(inferWebProvider("https://example.com/path?q=1")).toBe("generic");

    expect(providerHomeUrl("google", "https://mail.google.com/mail/u/0/")).toBe("https://www.google.com/?hl=ko");
    expect(providerHomeUrl("naver", "https://mail.naver.com/")).toBe("https://www.naver.com/");
    expect(providerHomeUrl("generic", "https://example.com/path?q=1")).toBe("https://example.com/");
    expect(isProviderLoginUrl("https://accounts.google.com/ServiceLogin", "google")).toBe(true);
    expect(isProviderLoginUrl("https://nid.naver.com/nidlogin.login", "naver")).toBe(true);
    expect(providerAgentProfileDir("google", "edge", "https://mail.google.com/")).toContain("google-generic-edge");
    expect(providerAgentProfileDir("generic", "chrome", "https://example.com/path")).toContain("generic-example.com-chrome");
  });

  it("visits Google home before an already-authenticated target", async () => {
    await withPage(async (page) => {
      const documents: string[] = [];
      await routeDocuments(page, documents, (url) => {
        if (url.hostname === "www.google.com") {
          return '<a aria-label="Google Account: Test User" href="https://accounts.google.com/SignOutOptions">account</a>';
        }
        if (url.hostname === "mail.google.com") {
          return "<main>Gmail target</main>";
        }
        return "<main>unexpected</main>";
      });

      const result = await runProviderPreflight(page, {
        provider: "google",
        targetUrl: "https://mail.google.com/mail/u/0/",
        timeoutMs: 3000,
        loginTimeoutMs: 3000,
        headless: true
      });

      expect(result.loginStatus).toBe("already_authenticated");
      expect(documents[0]).toBe("https://www.google.com/?hl=ko");
      expect(documents.at(-1)).toBe("https://mail.google.com/mail/u/0/");
    });
  });

  it("visits Naver home before an already-authenticated target", async () => {
    await withPage(async (page) => {
      const documents: string[] = [];
      await routeDocuments(page, documents, (url) => {
        if (url.hostname === "www.naver.com") {
          return '<a href="https://nid.naver.com/nidlogin.logout">로그아웃</a>';
        }
        if (url.hostname === "mail.naver.com") {
          return "<main>Naver Mail target</main>";
        }
        return "<main>unexpected</main>";
      });

      const result = await runProviderPreflight(page, {
        provider: "naver",
        targetUrl: "https://mail.naver.com/",
        timeoutMs: 3000,
        loginTimeoutMs: 3000,
        headless: true
      });

      expect(result.loginStatus).toBe("already_authenticated");
      expect(documents).toEqual(["https://www.naver.com/", "https://mail.naver.com/"]);
    });
  });

  it("visits an ordinary site's origin before its target path", async () => {
    await withPage(async (page) => {
      const documents: string[] = [];
      await routeDocuments(page, documents, (url) => `<main>${url.pathname}</main>`);

      const result = await runProviderPreflight(page, {
        provider: "generic",
        targetUrl: "https://example.com/deep/path?q=1",
        timeoutMs: 3000,
        loginTimeoutMs: 3000,
        headless: true
      });

      expect(result.loginStatus).toBe("not_required");
      expect(documents).toEqual(["https://example.com/", "https://example.com/deep/path?q=1"]);
    });
  });

  it("opens Google public targets without logging in when the home shows a login link", async () => {
    await withPage(async (page) => {
      const documents: string[] = [];
      await routeDocuments(page, documents, (url) => {
        if (url.hostname === "www.google.com" && url.pathname === "/") {
          return '<a href="https://accounts.google.com/ServiceLogin">로그인</a>';
        }
        if (url.hostname === "www.google.com" && url.pathname === "/search") {
          return "<main>Public Google search results</main>";
        }
        return "<main>unexpected</main>";
      });

      const result = await runProviderPreflight(page, {
        provider: "google",
        targetUrl: "https://www.google.com/search?q=web-agent",
        timeoutMs: 3000,
        loginTimeoutMs: 3000,
        headless: true
      });

      expect(result.loginStatus).toBe("not_required");
      expect(documents).toEqual(["https://www.google.com/?hl=ko", "https://www.google.com/search?q=web-agent"]);
    });
  });

  it("opens Naver public targets without logging in when the home shows a login link", async () => {
    await withPage(async (page) => {
      const documents: string[] = [];
      await routeDocuments(page, documents, (url) => {
        if (url.hostname === "www.naver.com") {
          return '<a href="https://nid.naver.com/nidlogin.login">로그인</a>';
        }
        if (url.hostname === "search.naver.com") {
          return "<main>Public Naver search results</main>";
        }
        return "<main>unexpected</main>";
      });

      const result = await runProviderPreflight(page, {
        provider: "naver",
        targetUrl: "https://search.naver.com/search.naver?query=web-agent",
        timeoutMs: 3000,
        loginTimeoutMs: 3000,
        headless: true
      });

      expect(result.loginStatus).toBe("not_required");
      expect(documents).toEqual(["https://www.naver.com/", "https://search.naver.com/search.naver?query=web-agent"]);
    });
  });

  it("waits for Google login only after a protected target redirects to the login page", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "web-agent-preflight-login-"));
    const statusFile = path.join(directory, "status.json");
    try {
      await withPage(async (page) => {
        const documents: string[] = [];
        let authenticated = false;
        await page.route("**/*", async (route) => {
          if (route.request().resourceType() !== "document") {
            await route.abort();
            return;
          }

          const url = new URL(route.request().url());
          documents.push(url.toString());
          if (url.hostname === "www.google.com") {
            const html = authenticated
              ? '<a aria-label="Google 계정: 테스트" href="https://accounts.google.com/SignOutOptions">계정</a>'
              : '<a href="https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.google.com%2F%3Fhl%3Dko">로그인</a>';
            await route.fulfill({ status: 200, contentType: "text/html", body: html });
            return;
          }
          if (url.hostname === "accounts.google.com") {
            await route.fulfill({ status: 200, contentType: "text/html", body: "<main>Google login</main>" });
            return;
          }
          if (url.hostname === "mail.google.com") {
            if (!authenticated) {
              await route.fulfill({
                status: 302,
                headers: { location: "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F0%2F" },
                body: ""
              });
              return;
            }
            await route.fulfill({ status: 200, contentType: "text/html", body: "<main>Gmail target</main>" });
            return;
          }
          await route.fulfill({ status: 404, contentType: "text/html", body: "not found" });
        });

        const preflight = runProviderPreflight(page, {
          provider: "google",
          targetUrl: "https://mail.google.com/mail/u/0/",
          statusFile,
          timeoutMs: 3000,
          loginTimeoutMs: 3000,
          headless: false
        });

        await waitForPreflightStatus(statusFile, "waiting_for_google_login");
        authenticated = true;
        await page.goto("https://mail.google.com/mail/u/0/", { waitUntil: "domcontentloaded" });
        const result = await preflight;

        expect(result.loginStatus).toBe("completed");
        expect(documents.map((value) => new URL(value).hostname)).toEqual([
          "www.google.com",
          "mail.google.com",
          "accounts.google.com",
          "mail.google.com",
          "mail.google.com"
        ]);
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("blocks interactive login in headless mode only after the target redirects to login", async () => {
    await withPage(async (page) => {
      const documents: string[] = [];
      await page.route("**/*", async (route) => {
        if (route.request().resourceType() !== "document") {
          await route.abort();
          return;
        }
        const url = new URL(route.request().url());
        documents.push(url.toString());
        if (url.hostname === "www.google.com") {
          await route.fulfill({ status: 200, contentType: "text/html", body: '<a href="https://accounts.google.com/ServiceLogin">로그인</a>' });
          return;
        }
        if (url.hostname === "calendar.google.com") {
          await route.fulfill({
            status: 302,
            headers: { location: "https://accounts.google.com/ServiceLogin" },
            body: ""
          });
          return;
        }
        await route.fulfill({ status: 200, contentType: "text/html", body: "<main>login</main>" });
      });

      await expect(
        runProviderPreflight(page, {
          provider: "google",
          targetUrl: "https://calendar.google.com/calendar/u/0/r",
          timeoutMs: 3000,
          loginTimeoutMs: 3000,
          headless: true
        })
      ).rejects.toThrow("--headful");
      expect(documents.map((value) => new URL(value).hostname)).toEqual([
        "www.google.com",
        "calendar.google.com",
        "accounts.google.com"
      ]);
    });
  });

  it("redacts tokenized targets from preflight status when requested", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "web-agent-preflight-status-"));
    const statusFile = path.join(directory, "status.json");
    try {
      await withPage(async (page) => {
        await routeDocuments(page, [], () => "<main>ok</main>");
        await runProviderPreflight(page, {
          provider: "generic",
          targetUrl: "https://example.com/calendar/render?share=person%40example.com&ctok=opaque-token",
          statusFile,
          redactTargetUrl: true,
          timeoutMs: 3000,
          loginTimeoutMs: 3000,
          headless: true
        });
      });

      const status = await readFile(statusFile, "utf8");
      expect(status).toContain("https://example.com/calendar/render");
      expect(status).not.toContain("opaque-token");
      expect(status).not.toContain("person%40example.com");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("is connected to every browser task entry point", async () => {
    const files = [
      "src/cli.ts",
      "src/workflows/googleCalendarEvent.ts",
      "src/workflows/googleCalendarShareRequest.ts",
      "src/workflows/googleDriveDownload.ts",
      "src/workflows/googleFormsJarvis.ts",
      "src/workflows/googleSheetsExportCsv.ts",
      "src/workflows/googleWorkspaceExport.ts",
      "src/workflows/mailSearchRead.ts",
      "src/workflows/naverMail.ts",
      "src/workflows/naverMailReadBatch.ts",
      "src/workflows/webExtract.ts"
    ];

    for (const file of files) {
      const source = await readFile(path.resolve(file), "utf8");
      expect(source, file).toContain("runProviderPreflight(");
    }
  });

  it("launches the generic agent with a persistent Chromium profile", async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "web-agent-provider-profile-"));
    let controller: BrowserController | undefined;
    try {
      controller = await BrowserController.launch({
        headful: false,
        timeoutMs: 3000,
        browser: "chromium",
        userDataDir
      });
      expect(await controller.page.evaluate(() => navigator.userAgent)).toContain("Chrome");
    } finally {
      await controller?.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    const page = await browser.newPage();
    await run(page);
  } finally {
    await browser?.close();
  }
}

async function routeDocuments(
  page: Page,
  documents: string[],
  bodyFor: (url: URL) => string
): Promise<void> {
  await page.route("**/*", async (route: Route) => {
    if (route.request().resourceType() !== "document") {
      await route.abort();
      return;
    }
    const url = new URL(route.request().url());
    documents.push(url.toString());
    await route.fulfill({ status: 200, contentType: "text/html", body: bodyFor(url) });
  });
}

async function waitForPreflightStatus(file: string, expectedStatus: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const raw = await readFile(file, "utf8").catch(() => "");
    const status = raw ? (JSON.parse(raw) as { status?: unknown }).status : undefined;
    if (status === expectedStatus) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for preflight status: ${expectedStatus}`);
}
