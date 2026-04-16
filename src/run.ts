import { chromium, type BrowserContext, type Worker } from "playwright";
import { readFileSync, rmSync, existsSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import "dotenv/config";

const SETTLE_TIME = 5000; // ms after page load for extension detection + sync
const QUERY_DELAY = 5000; // ms between queries to avoid Google rate limiting
const AUTH_POLL_INTERVAL = 2000; // ms between auth status checks
const EXTENSION_READY_TIMEOUT = 10000; // ms to wait for extension settings/auth visibility
const EXTENSION_READY_POLL_INTERVAL = 250;

const extensionPath = resolve(
  process.env.EXTENSION_PATH || "../AI-Overview-Tracker"
);
const queryFile = resolve(process.argv[2] || "./queries_in.txt");

type SearchModePreference = "all" | "random" | "ai" | "no_ai";

function loadQueries(filePath: string): string[] {
  const raw = readFileSync(filePath, "utf-8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

async function getServiceWorker(
  context: BrowserContext
): Promise<Worker> {
  const existing = context.serviceWorkers();
  if (existing.length > 0) return existing[0];
  return context.waitForEvent("serviceworker");
}

async function isAuthenticated(worker: Worker): Promise<boolean> {
  const result = await worker.evaluate(() => {
    return new Promise<{ userId?: string; userEmail?: string }>((resolve) => {
      chrome.storage.local.get(["userId", "userEmail"], (data) =>
        resolve(data)
      );
    });
  });
  return Boolean(result.userId && result.userEmail);
}

async function waitForAuth(
  context: BrowserContext,
  worker: Worker
): Promise<void> {
  if (await isAuthenticated(worker)) {
    console.log("[auth] Already authenticated.");
    return;
  }

  // Open the extension's options page for the user to log in
  const extensionId = worker.url().split("/")[2];
  const optionsUrl = `chrome-extension://${extensionId}/options.html`;
  const optionsPage = await context.newPage();
  await optionsPage.goto(optionsUrl);

  console.log(
    "[auth] Not logged in. Please sign in on the options page that just opened..."
  );

  while (!(await isAuthenticated(worker))) {
    await new Promise((r) => setTimeout(r, AUTH_POLL_INTERVAL));
  }

  console.log("[auth] Authenticated. Closing options page.");
  await optionsPage.close();
}

async function isCaptcha(page: import("playwright").Page): Promise<boolean> {
  const url = page.url();
  if (url.includes("/sorry/") || url.includes("sorry/index")) return true;

  const captchaForm = await page.$("#captcha-form").catch(() => null);
  return captchaForm !== null;
}

async function waitForCaptchaResolution(
  page: import("playwright").Page
): Promise<void> {
  console.log("[captcha] CAPTCHA detected. Please solve it in the browser...");

  while (await isCaptcha(page)) {
    await new Promise((r) => setTimeout(r, AUTH_POLL_INTERVAL));
  }

  console.log("[captcha] Resolved. Continuing.");
}

function normalizeSearchModePreference(value: unknown): SearchModePreference {
  if (value === "ai" || value === "no_ai" || value === "random") {
    return value;
  }

  return "all";
}

function buildSearchUrl(query: string, preference: SearchModePreference): string {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", query);

  if (preference === "ai") {
    url.searchParams.set("udm", "50");
  } else if (preference === "no_ai") {
    url.searchParams.set("udm", "14");
  } else if (preference === "random") {
    const randomUdm = Math.random() < 0.5 ? "50" : "14";
    url.searchParams.set("udm", randomUdm);
  }

  return url.toString();
}

async function getSearchModePreference(worker: Worker): Promise<SearchModePreference> {
  const result = await worker.evaluate(() => {
    return new Promise<{ settings?: { search_mode_preference?: string } }>((resolve) => {
      chrome.storage.local.get(["settings"], (data) => resolve(data));
    });
  });

  return normalizeSearchModePreference(
    result.settings?.search_mode_preference
  );
}

async function waitForExtensionReadiness(worker: Worker): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < EXTENSION_READY_TIMEOUT) {
    const state = await worker.evaluate(() => {
      return new Promise<{
        userId?: string;
        userEmail?: string;
        hasSettings: boolean;
      }>((resolve) => {
        chrome.storage.local.get(["userId", "userEmail", "settings"], (data) => {
          resolve({
            userId: typeof data.userId === "string" ? data.userId : undefined,
            userEmail:
              typeof data.userEmail === "string" ? data.userEmail : undefined,
            hasSettings: Boolean(data.settings && typeof data.settings === "object"),
          });
        });
      });
    });

    if (state.userId && state.userEmail && state.hasSettings) {
      return;
    }

    await new Promise((r) => setTimeout(r, EXTENSION_READY_POLL_INTERVAL));
  }

  console.warn(
    `[init] Extension readiness wait timed out after ${EXTENSION_READY_TIMEOUT}ms; continuing with fallback behavior.`
  );
}

async function main() {
  const queries = loadQueries(queryFile);
  console.log(`Loaded ${queries.length} queries from ${queryFile}`);
  console.log(`Extension path: ${extensionPath}`);

  // Use a fresh profile each run so Chrome doesn't serve a cached service worker
  // instead of the latest extension source files.
  const profileDir = resolve(tmpdir(), `ai-overview-runner-${Date.now()}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  const worker = await getServiceWorker(context);
  console.log(`Extension service worker ready: ${worker.url()}`);

  await waitForAuth(context, worker);
  await waitForExtensionReadiness(worker);

  const searchModePreference = await getSearchModePreference(worker);
  console.log(`[mode] Active search mode: ${searchModePreference}`);

  const langMatch = queryFile.match(/queries_([a-z]{2,3})\.txt$/i);
  const queryLanguage = langMatch ? langMatch[1].toLowerCase() : "unknown";

  await worker.evaluate((lang: string) => {
    return new Promise<void>((resolve) => {
      chrome.storage.local.set({ query_language: lang }, () => resolve());
    });
  }, queryLanguage);

  console.log(`[lang] Storing events under collection: "${queryLanguage}"`);

  const page = context.pages()[0] || (await context.newPage());

  let aiOverviewCount = 0;
  let noOverviewCount = 0;

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    console.log(`\n[${i + 1}/${queries.length}] Searching: "${query}"`);

    const searchUrl = buildSearchUrl(query, searchModePreference);

    await page.goto(searchUrl, { waitUntil: "load" });

    // Check for CAPTCHA before waiting for the extension
    if (await isCaptcha(page)) {
      await waitForCaptchaResolution(page);
      // Re-navigate after CAPTCHA resolution since Google may have redirected
      await waitForExtensionReadiness(worker);
      await page.goto(searchUrl, { waitUntil: "load" });
    }

    // Wait for the extension's detection cycle (2s timer + buffer for classification/sync)
    await page.waitForTimeout(SETTLE_TIME);

    // Check if the extension marked an AI Overview container
    const hasOverview = await page
      .locator("[data-ai-overview-container]")
      .count();

    if (hasOverview > 0) {
      aiOverviewCount++;
      console.log(`  -> AI Overview detected`);
    } else {
      noOverviewCount++;
      console.log(`  -> No AI Overview`);
    }

    // Delay before next query
    if (i < queries.length - 1) {
      await page.waitForTimeout(QUERY_DELAY);
    }
  }

  console.log("\n========== Summary ==========");
  console.log(`Total queries:      ${queries.length}`);
  console.log(`AI Overview found:  ${aiOverviewCount}`);
  console.log(`No AI Overview:     ${noOverviewCount}`);
  console.log("=============================");

  await context.close();

  rmSync(profileDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
