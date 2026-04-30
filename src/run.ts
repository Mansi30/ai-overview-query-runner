import { chromium, type BrowserContext, type Worker } from "playwright";
import {
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  unlinkSync,
} from "fs";
import { resolve, basename } from "path";
import { tmpdir } from "os";
import "dotenv/config";

// Timing constants — all overridable via environment variables
const SETTLE_TIME = Number(process.env.SETTLE_TIME) || 5000;
const QUERY_DELAY = Number(process.env.QUERY_DELAY) || 5000;
const AUTH_POLL_INTERVAL = Number(process.env.AUTH_POLL_INTERVAL) || 2000;
const EXTENSION_READY_TIMEOUT = Number(process.env.EXTENSION_READY_TIMEOUT) || 10000;
const EXTENSION_READY_POLL_INTERVAL = 250;

const cliArgs = process.argv.slice(2);
const freshRun = cliArgs.includes("--fresh");
const queryFileArg = cliArgs.find((a) => !a.startsWith("--"));

const extensionPath = resolve(process.env.EXTENSION_PATH || "../AI-Overview-Tracker");
const queryFile = resolve(
  queryFileArg && queryFileArg.includes("/")
    ? queryFileArg
    : `./queries/${queryFileArg || "queries.csv"}`
);
const stem = queryFile.endsWith(".csv") || queryFile.endsWith(".txt")
  ? queryFile.slice(0, -4)
  : queryFile;
const resultsFile = `query_results/${basename(stem)}.results.json`;
const checkpointFile = `${stem}.checkpoint.json`;

type SearchModePreference = "all" | "random" | "ai" | "no_ai";

type QueryResult = {
  query: string;
  language: string;
  aiOverview: boolean;
  timestamp: string;
};

type Checkpoint = {
  startedAt: string;
  completedCount: number;
  results: QueryResult[];
};

type QueryPair = {
  en: string;
  id: string;
};

// Module-level refs so signal handlers can clean up mid-run
let activeContext: BrowserContext | null = null;
let activeProfileDir: string | null = null;
let cleanupDone = false;

async function shutdown(exitCode = 0): Promise<never> {
  if (!cleanupDone) {
    cleanupDone = true;
    if (activeContext) {
      try { await activeContext.close(); } catch {}
    }
    if (activeProfileDir) {
      try { rmSync(activeProfileDir, { recursive: true, force: true }); } catch {}
    }
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => { void shutdown(130); });
process.on("SIGTERM", () => { void shutdown(143); });

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function loadQueryPairs(filePath: string): QueryPair[] {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const dataLines = lines[0] === "en,id" ? lines.slice(1) : lines;
  return dataLines.map((line) => {
    const commaIndex = line.indexOf(",");
    if (commaIndex === -1) {
      return { en: line, id: "" };
    }
    return {
      en: line.slice(0, commaIndex).trim(),
      id: line.slice(commaIndex + 1).trim(),
    };
  });
}

// TODO: Replace with a real Firebase/Firestore check once the runner has
// direct DB access. Should return true if a result for this (query, language)
// pair has already been recorded, so the query is not executed again.
async function isQueryAlreadyExecuted(
  _query: string,
  _language: string
): Promise<boolean> {
  return false;
}

function loadCheckpoint(): Checkpoint | null {
  if (freshRun || !existsSync(checkpointFile)) return null;
  try {
    return JSON.parse(readFileSync(checkpointFile, "utf-8")) as Checkpoint;
  } catch {
    return null;
  }
}

function saveCheckpoint(checkpoint: Checkpoint): void {
  writeFileSync(checkpointFile, JSON.stringify(checkpoint, null, 2));
}

function writeResultsFile(
  searchMode: SearchModePreference,
  startedAt: string,
  results: QueryResult[]
): void {
  const aiOverviewCount = results.filter((r) => r.aiOverview).length;
  writeFileSync(
    resultsFile,
    JSON.stringify(
      {
        queryFile,
        searchMode,
        startedAt,
        completedAt: new Date().toISOString(),
        summary: {
          total: results.length,
          aiOverview: aiOverviewCount,
          noOverview: results.length - aiOverviewCount,
        },
        results,
      },
      null,
      2
    )
  );
  console.log(`[results] Saved to ${resultsFile}`);
}

async function getServiceWorker(context: BrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers();
  if (existing.length > 0) return existing[0];
  return context.waitForEvent("serviceworker");
}

async function isAuthenticated(worker: Worker): Promise<boolean> {
  const result = await worker.evaluate(() => {
    return new Promise<{ userId?: string; userEmail?: string }>((resolve) => {
      chrome.storage.local.get(["userId", "userEmail"], (data) => resolve(data));
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

  const extensionId = worker.url().split("/")[2];
  const optionsUrl = `chrome-extension://${extensionId}/options.html`;

  // Wait up to 1s for the extension to auto-open its own options page before we open one.
  const extensionPagePrefix = `chrome-extension://${extensionId}`;
  const deadline = Date.now() + 1000;
  while (!context.pages().find((p) => p.url().startsWith(extensionPagePrefix)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  let optionsPage = context.pages().find((p) => p.url().startsWith(extensionPagePrefix));
  if (!optionsPage) {
    optionsPage = await context.newPage();
    await optionsPage.goto(optionsUrl);
  }

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
  if (value === "ai" || value === "no_ai" || value === "random") return value;
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
    url.searchParams.set("udm", Math.random() < 0.5 ? "50" : "14");
  }

  return url.toString();
}

async function getSearchModePreference(worker: Worker): Promise<SearchModePreference> {
  const result = await worker.evaluate(() => {
    return new Promise<{ settings?: { search_mode_preference?: string } }>((resolve) => {
      chrome.storage.local.get(["settings"], (data) => resolve(data));
    });
  });
  return normalizeSearchModePreference(result.settings?.search_mode_preference);
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

    if (state.userId && state.userEmail && state.hasSettings) return;
    await new Promise((r) => setTimeout(r, EXTENSION_READY_POLL_INTERVAL));
  }

  console.warn(
    `[init] Extension readiness wait timed out after ${EXTENSION_READY_TIMEOUT}ms; continuing with fallback behavior.`
  );
}

async function main() {
  const pairs = loadQueryPairs(queryFile);
  console.log(`Loaded ${pairs.length} query pairs from ${queryFile}`);
  console.log(`Extension path: ${extensionPath}`);

  const checkpoint = loadCheckpoint();
  const startedAt = checkpoint?.startedAt ?? new Date().toISOString();
  const results: QueryResult[] = checkpoint?.results ?? [];
  const startIndex = checkpoint?.completedCount ?? 0;

  if (checkpoint) {
    console.log(
      `[resume] Resuming from pair ${startIndex + 1}/${pairs.length} — pass --fresh to start over`
    );
  }

  // Use a fresh profile each run so Chrome doesn't serve a cached service worker
  // instead of the latest extension source files.
  const profileDir = resolve(tmpdir(), `ai-overview-runner-${Date.now()}`);
  activeProfileDir = profileDir;

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  activeContext = context;

  const worker = await getServiceWorker(context);
  console.log(`Extension service worker ready: ${worker.url()}`);

  await waitForAuth(context, worker);
  await waitForExtensionReadiness(worker);

  const searchModePreference = await getSearchModePreference(worker);
  console.log(`[mode] Active search mode: ${searchModePreference}`);

  const page = context.pages()[0] || (await context.newPage());
  const runStartTime = Date.now();

  for (let i = startIndex; i < pairs.length; i++) {
    const pair = pairs[i];
    const pairsDone = i - startIndex;
    const elapsed = formatDuration(Date.now() - runStartTime);
    const eta =
      pairsDone > 0
        ? `, ~${formatDuration(((Date.now() - runStartTime) / pairsDone) * (pairs.length - i))} remaining`
        : "";
    console.log(`\n[${i + 1}/${pairs.length}] "${pair.en}" / "${pair.id}"  (${elapsed}${eta})`);

    const variants = [
      { query: pair.en, language: "en" },
      { query: pair.id, language: "id" },
    ].filter((v) => v.query !== "");

    for (const { query, language } of variants) {
      if (await isQueryAlreadyExecuted(query, language)) {
        console.log(`  [skip] "${query}" (${language}) — already in Firebase`);
        continue;
      }

      await worker.evaluate((lang: string) => {
        return new Promise<void>((resolve) => {
          chrome.storage.local.set({ query_language: lang }, () => resolve());
        });
      }, language);

      const searchUrl = buildSearchUrl(query, searchModePreference);
      await page.goto(searchUrl, { waitUntil: "load" });

      if (await isCaptcha(page)) {
        await waitForCaptchaResolution(page);
        await waitForExtensionReadiness(worker);
        await page.goto(searchUrl, { waitUntil: "load" });
      }

      await page.waitForTimeout(SETTLE_TIME);

      const hasOverview = await page.locator("[data-ai-overview-container]").count();
      const aiOverview = hasOverview > 0;

      results.push({ query, language, aiOverview, timestamp: new Date().toISOString() });
      console.log(`  [${language}] ${aiOverview ? "AI Overview detected" : "No AI Overview"}`);

      await page.waitForTimeout(QUERY_DELAY);
    }

    saveCheckpoint({ startedAt, completedCount: i + 1, results });
  }

  const aiOverviewCount = results.filter((r) => r.aiOverview).length;

  console.log("\n========== Summary ==========");
  console.log(`Total queries:      ${results.length}`);
  console.log(`AI Overview found:  ${aiOverviewCount}`);
  console.log(`No AI Overview:     ${results.length - aiOverviewCount}`);
  console.log("=============================\n");

  writeResultsFile(searchModePreference, startedAt, results);

  if (existsSync(checkpointFile)) unlinkSync(checkpointFile);

  await context.close();
  activeContext = null;

  rmSync(profileDir, { recursive: true, force: true });
  activeProfileDir = null;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  void shutdown(1);
});
