// BrowserSession: sole owner of the Playwright browser/context/page.
// No other module may create its own Playwright connection (design doc requirement).
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROFILE_DIR = path.join(ROOT, "artifacts", "browser-profile");
const SCREENSHOT_DIR = path.join(ROOT, "artifacts", "screenshots");

let contextPromise = null;
let page = null;

export function artifactPath(...parts) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  return path.join(SCREENSHOT_DIR, ...parts);
}

async function ensureContext() {
  if (!contextPromise) {
    mkdirSync(PROFILE_DIR, { recursive: true });
    contextPromise = chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
    });
  }
  const context = await contextPromise;
  if (!page || page.isClosed()) {
    page = context.pages()[0] ?? (await context.newPage());
  }
  return page;
}

export async function getPage() {
  return ensureContext();
}

export async function closeSession() {
  if (contextPromise) {
    const context = await contextPromise;
    await context.close();
    contextPromise = null;
    page = null;
  }
}
