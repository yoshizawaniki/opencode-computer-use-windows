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

let contextPromise = null;
let nextTabId = 1;
const tabs = new Map(); // id -> Page
let activeTabId = null;
let lastDialog = null; // {type, message, defaultValue, at}

export function artifactPath(...parts) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  return path.join(SCREENSHOT_DIR, ...parts);
}

export function downloadPath(...parts) {
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  return path.join(DOWNLOAD_DIR, ...parts);
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
  });

  return id;
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
  }
}

process.on("SIGINT", () => closeSession().finally(() => process.exit(0)));
process.on("SIGTERM", () => closeSession().finally(() => process.exit(0)));
