// BrowserSession: sole owner of the Playwright browser/context/tabs.
// No other module may touch `context` or create its own Playwright connection
// (design doc requirement). Tools only ever get a Page via getActivePage()/
// getTab(id), or read tab/dialog/download state via the getters below.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROFILE_DIR = path.join(ROOT, "artifacts", "browser-profile");
const SCREENSHOT_DIR = path.join(ROOT, "artifacts", "screenshots");
const DOWNLOAD_DIR = path.join(ROOT, "artifacts", "downloads");
const UPLOAD_DIR = path.join(ROOT, "artifacts", "uploads");

let contextPromise = null;
let nextTabId = 1;
const tabs = new Map(); // id -> Page
let activeTabId = null;
let lastDialog = null; // {type, message, defaultValue, at}
const consoleLogs = new Map(); // tabId -> [{type, text, at}]
const networkLogs = new Map(); // tabId -> [{url, method, resourceType, status, ok, failure, durationMs, at}]
const LOG_CAP = 300; // never let an unbounded buffer grow forever or leak into a huge tool result

function pushCapped(map, id, entry) {
  const list = map.get(id) ?? [];
  list.push(entry);
  if (list.length > LOG_CAP) list.shift();
  map.set(id, list);
}

export function artifactPath(...parts) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  return path.join(SCREENSHOT_DIR, ...parts);
}

export function downloadPath(...parts) {
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  return path.join(DOWNLOAD_DIR, ...parts);
}

// Upload sources are restricted to artifacts/uploads/ so a page's content
// (read via snapshot, fed to the LLM) can never trick a tool call into
// exfiltrating an arbitrary local file the agent happens to have read access
// to. Callers who need to upload something first copy/write it in here.
export function uploadPath(...parts) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  return path.join(UPLOAD_DIR, ...parts);
}

export function assertUploadAllowed(filePath) {
  const resolved = path.resolve(filePath);
  const base = path.resolve(UPLOAD_DIR) + path.sep;
  if (!resolved.startsWith(base)) {
    throw new Error(
      `upload path "${filePath}" is outside the allowed uploads directory (${UPLOAD_DIR}); ` +
        "place the file there first"
    );
  }
  return resolved;
}

function trackPage(playwrightPage) {
  const id = String(nextTabId++);
  tabs.set(id, playwrightPage);
  activeTabId = id;

  playwrightPage.on("dialog", async (dialog) => {
    lastDialog = {
      type: dialog.type(),
      message: dialog.message(),
      defaultValue: dialog.defaultValue(),
      at: new Date().toISOString(),
    };
    // Auto-accept so the page never hangs waiting for a human. Callers can
    // inspect what happened via browser_last_dialog (re-observation, not a
    // blind assumption that a dialog didn't matter).
    await dialog.accept().catch(() => {});
  });

  playwrightPage.on("close", () => {
    if (tabs.get(id) === playwrightPage) tabs.delete(id);
    if (activeTabId === id) {
      const remaining = [...tabs.keys()];
      activeTabId = remaining[remaining.length - 1] ?? null;
    }
    clearLogs(id);
  });

  // Metadata only — no headers, no bodies. Headers/bodies routinely carry
  // Authorization/Cookie/Set-Cookie or token fields, and this buffer's whole
  // contents can end up in an LLM tool result, so those never get captured
  // even for a single tool call, let alone buffered across a session.
  playwrightPage.on("console", (msg) => {
    pushCapped(consoleLogs, id, { type: msg.type(), text: msg.text(), at: new Date().toISOString() });
  });
  playwrightPage.on("requestfinished", async (req) => {
    const res = await req.response().catch(() => null);
    pushCapped(networkLogs, id, {
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      status: res?.status() ?? null,
      ok: res?.ok() ?? null,
      failure: null,
      at: new Date().toISOString(),
    });
  });
  playwrightPage.on("requestfailed", (req) => {
    pushCapped(networkLogs, id, {
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      status: null,
      ok: false,
      failure: req.failure()?.errorText ?? "unknown failure",
      at: new Date().toISOString(),
    });
  });

  return id;
}

export function getConsoleLogs(tabId) {
  return consoleLogs.get(tabId) ?? [];
}

export function getNetworkLogs(tabId) {
  return networkLogs.get(tabId) ?? [];
}

export function clearConsoleLogs(tabId) {
  consoleLogs.delete(tabId);
}

export function clearNetworkLogs(tabId) {
  networkLogs.delete(tabId);
}

// Full clear (both buffers) — used when a tab closes, not exposed to tools
// individually so a `clear` on one log type can't silently wipe the other.
export function clearLogs(tabId) {
  clearConsoleLogs(tabId);
  clearNetworkLogs(tabId);
}

async function ensureContext() {
  if (!contextPromise) {
    mkdirSync(PROFILE_DIR, { recursive: true });
    contextPromise = chromium.launchPersistentContext(PROFILE_DIR, { headless: false });
    const context = await contextPromise;
    context.on("page", (p) => {
      if (![...tabs.values()].includes(p)) trackPage(p);
    });
    for (const p of context.pages()) trackPage(p);
  }
  const context = await contextPromise;
  if (tabs.size === 0) trackPage(await context.newPage());
  return context;
}

export async function getContext() {
  return ensureContext();
}

export function getActiveTabId() {
  return activeTabId;
}

export async function getActivePage() {
  await ensureContext();
  const page = tabs.get(activeTabId);
  if (!page || page.isClosed()) throw new Error("no active tab");
  return page;
}

export async function getTab(id) {
  await ensureContext();
  const page = tabs.get(id);
  if (!page || page.isClosed()) throw new Error(`unknown or closed tab id "${id}"`);
  return page;
}

export async function listTabs() {
  await ensureContext();
  const result = [];
  for (const [id, p] of tabs) {
    if (p.isClosed()) continue;
    result.push({ id, url: p.url(), title: await p.title().catch(() => ""), active: id === activeTabId });
  }
  return result;
}

export async function newTab() {
  const context = await ensureContext();
  const p = await context.newPage();
  const id = trackPage(p);
  activeTabId = id;
  return id;
}

export async function selectTab(id) {
  await getTab(id); // throws if unknown/closed
  activeTabId = id;
}

export async function closeTab(id) {
  const page = await getTab(id);
  await page.close();
}

// Races a click against a new tab/popup appearing so the caller can observe
// whichever page actually ended up receiving the interaction, instead of
// silently reporting stale state from a tab the click abandoned.
export async function withPopupTracking(context, action) {
  const popupPromise = context.waitForEvent("page", { timeout: 1000 }).catch(() => null);
  await action();
  const popup = await popupPromise;
  if (popup) {
    const id = [...tabs.entries()].find(([, p]) => p === popup)?.[0];
    if (id) activeTabId = id;
  }
}

export function getLastDialog() {
  return lastDialog;
}

export async function closeSession() {
  if (contextPromise) {
    const context = await contextPromise;
    await context.close();
    contextPromise = null;
    tabs.clear();
    activeTabId = null;
    lastDialog = null;
    consoleLogs.clear();
    networkLogs.clear();
  }
}

process.on("SIGINT", () => closeSession().finally(() => process.exit(0)));
process.on("SIGTERM", () => closeSession().finally(() => process.exit(0)));
