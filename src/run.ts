import { chromium, type BrowserContext, type Worker } from "playwright";
import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  signInWithEmailAndPassword,
  type Auth,
  type User,
} from "firebase/auth";
import {
  collection,
  doc,
  getDocs,
  getFirestore,
  limit,
  query,
  where,
  writeBatch,
  type Firestore,
} from "firebase/firestore";
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
  pairId?: string;
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
  pairId: string;
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

function splitCsvLine(line: string): string[] {
  return line.split(",").map((cell) => cell.trim());
}

function loadQueryPairs(filePath: string): QueryPair[] {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length === 0) return [];

  const headerCells = splitCsvLine(lines[0]);
  const headerIndex = new Map<string, number>();
  headerCells.forEach((name, index) => headerIndex.set(name, index));
  const hasHeader = headerIndex.has("en") && headerIndex.has("id");
  const dataLines = hasHeader ? lines.slice(1) : lines;
  const enIndex = hasHeader ? headerIndex.get("en") ?? 0 : 0;
  const idIndex = hasHeader ? headerIndex.get("id") ?? 1 : 1;
  const pairIdIndex = hasHeader ? headerIndex.get("pair_id") ?? -1 : -1;

  const fileStem = basename(filePath).replace(/\.(csv|txt)$/i, "");
  const pairs: QueryPair[] = [];
  const seenIds = new Set<string>();
  let generatedCount = 0;

  for (let i = 0; i < dataLines.length; i++) {
    const cells = splitCsvLine(dataLines[i]);
    const en = cells[enIndex] ?? "";
    const id = cells[idIndex] ?? "";
    const pairIdRaw = pairIdIndex >= 0 ? cells[pairIdIndex] ?? "" : "";
    const pairId = pairIdRaw.trim() || `${fileStem}-${String(i + 1).padStart(3, "0")}`;
    if (!pairIdRaw.trim()) generatedCount += 1;

    if (seenIds.has(pairId)) {
      throw new Error(`[pairs] Duplicate pair_id "${pairId}" in ${filePath}`);
    }
    seenIds.add(pairId);

    pairs.push({ pairId, en: en.trim(), id: id.trim() });
  }

  if (generatedCount > 0) {
    console.warn(
      `[pairs] ${generatedCount} row(s) missing pair_id; generated IDs like ${fileStem}-001.`
    );
  }

  return pairs;
}

let firebaseApp: FirebaseApp | null = null;
let firestoreDb: Firestore | null = null;
let firebaseAuth: Auth | null = null;
let authReady: Promise<void> | null = null;
const queryExecutionCache = new Map<string, boolean>();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[firebase] Missing ${name} environment variable.`);
  }
  return value;
}

function getFirebaseConfig() {
  return {
    apiKey: requireEnv("REACT_APP_FIREBASE_API_KEY"),
    authDomain: requireEnv("REACT_APP_FIREBASE_AUTH_DOMAIN"),
    projectId: requireEnv("REACT_APP_FIREBASE_PROJECT_ID"),
    storageBucket: requireEnv("REACT_APP_FIREBASE_STORAGE_BUCKET"),
    messagingSenderId: requireEnv("REACT_APP_FIREBASE_MESSAGING_SENDER_ID"),
    appId: requireEnv("REACT_APP_FIREBASE_APP_ID"),
  };
}

function getFirebaseApp(): FirebaseApp {
  if (firebaseApp) return firebaseApp;
  firebaseApp = getApps().length > 0 ? getApp() : initializeApp(getFirebaseConfig());
  return firebaseApp;
}

function getFirestoreDb(): Firestore {
  if (firestoreDb) return firestoreDb;
  firestoreDb = getFirestore(getFirebaseApp());
  return firestoreDb;
}

function getAuthClient(): Auth {
  if (firebaseAuth) return firebaseAuth;
  firebaseAuth = getAuth(getFirebaseApp());
  return firebaseAuth;
}

async function ensureSignedIn(): Promise<void> {
  if (authReady) return authReady;

  authReady = (async () => {
    const auth = getAuthClient();
    if (auth.currentUser) return;

    const email = requireEnv("FIREBASE_AUTH_EMAIL");
    const password = requireEnv("FIREBASE_AUTH_PASSWORD");
    await signInWithEmailAndPassword(auth, email, password);

    const signedInUser = auth.currentUser as User | null;
    if (!signedInUser) {
      throw new Error("[firebase] Sign-in failed: no current user after auth.");
    }

    const expectedUserId = process.env.FIREBASE_USER_ID;
    if (expectedUserId && signedInUser.uid !== expectedUserId) {
      console.warn(
        `[firebase] Authenticated user ${signedInUser.uid} does not match FIREBASE_USER_ID ${expectedUserId}.`
      );
    }
  })();

  try {
    await authReady;
  } catch (error) {
    authReady = null;
    throw error;
  }
}

function normalizeQueryText(value: string): string {
  return value.trim().toLowerCase();
}

function buildQueryCandidates(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();
  if (trimmed === lower) return [trimmed];
  return [trimmed, lower];
}

function getLanguageCollection(language: string): "en" | "id" {
  if (language === "en") return "en";
  if (language === "id") return "id";
  throw new Error(
    `[firebase] Unsupported language "${language}". Expected "en" or "id".`
  );
}

async function syncQueryPairs(pairs: QueryPair[]): Promise<void> {
  if (pairs.length === 0) return;

  await ensureSignedIn();

  const userId = requireEnv("FIREBASE_USER_ID").trim();
  if (!userId) {
    throw new Error("[firebase] FIREBASE_USER_ID must not be empty.");
  }

  const batch = writeBatch(getFirestoreDb());
  const pairCollection = collection(getFirestoreDb(), "users", userId, "query_pairs");
  const now = new Date().toISOString();

  for (const pair of pairs) {
    if (!pair.pairId) {
      throw new Error(`[pairs] Missing pair_id for "${pair.en}" / "${pair.id}".`);
    }
    if (pair.pairId.includes("/")) {
      throw new Error(`[pairs] pair_id "${pair.pairId}" must not include "/".`);
    }

    const docRef = doc(pairCollection, pair.pairId);
    batch.set(
      docRef,
      {
        pairId: pair.pairId,
        en: pair.en,
        id: pair.id,
        queryFile,
        updatedAt: now,
      },
      { merge: true }
    );
  }

  await batch.commit();
  console.log(
    `[pairs] Synced ${pairs.length} query pairs to Firestore at users/${userId}/query_pairs`
  );
}

async function isQueryAlreadyExecuted(
  queryText: string,
  language: string
): Promise<boolean> {
  const candidates = buildQueryCandidates(queryText);
  if (candidates.length === 0) return false;

  await ensureSignedIn();

  const collectionName = getLanguageCollection(language);
  const cacheKey = `${collectionName}:${normalizeQueryText(queryText)}`;
  const cached = queryExecutionCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const userId = requireEnv("FIREBASE_USER_ID").trim();
  if (!userId) {
    throw new Error("[firebase] FIREBASE_USER_ID must not be empty.");
  }

  const userCollection = collection(
    getFirestoreDb(),
    "users",
    userId,
    collectionName
  );
  const q =
    candidates.length === 1
      ? query(userCollection, where("query", "==", candidates[0]), limit(1))
      : query(userCollection, where("query", "in", candidates), limit(1));
  const snapshot = await getDocs(q);
  const exists = !snapshot.empty;
  queryExecutionCache.set(cacheKey, exists);
  return exists;
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
  await syncQueryPairs(pairs);

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
    console.log(
      `\n[${i + 1}/${pairs.length}] (${pair.pairId}) "${pair.en}" / "${pair.id}"  (${elapsed}${eta})`
    );

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

      results.push({
        pairId: pair.pairId,
        query,
        language,
        aiOverview,
        timestamp: new Date().toISOString(),
      });
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
