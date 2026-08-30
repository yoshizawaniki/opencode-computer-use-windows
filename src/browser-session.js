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
const tabs = new Map(); // id -> Page (instrumented: has listeners, operable by tools)
let activeTabId = null;
let mode = "launch"; // "launch" (owned Chromium profile) | "attach" (external real Chrome via CDP)
let externalBrowser = null; // Playwright Browser from connectOverCDP, attach mode only
const discovered = new Map(); // id -> Page, attach mode only: known but not yet selected/instrumented
const discoveredIds = new WeakMap(); // Page -> id, keeps ids stable across repeated listTabs() calls
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
  // A download's suggested filename comes from the (untrusted) server —
  // basename it so a Content-Disposition of "../../evil" can't write
  // outside artifacts/downloads/.
  return path.join(DOWNLOAD_DIR, ...parts.map((p) => path.basename(p)));
}

// Upload sources are restricted to artifacts/uploads/ so a page's content
// (read via snapshot, fed to the LLM) can never trick a tool call into
// exfiltrating an arbitrary local file the agent happens to have read access
// to. Callers who need to upload something first copy/write it in here.
export function uploadPath(...parts) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  return path.join(UPLOAD_DIR, ...parts);
}

// browser_navigate accepts any URL by design (that's the point of a browser
// tool) — but a file:// URL bypasses the upload path restriction entirely:
// the page IS the local file, readable via snapshot/dom_query. Scope file://
// to this project's own tree (fixtures, artifacts) so it can't be used to
// read arbitrary files (e.g. credentials, SSH keys) elsewhere on disk.
const ATTACH_BLOCKED_SCHEMES = new Set(["chrome:", "devtools:", "chrome-extension:", "edge:"]);

export function assertNavigateAllowed(urlStr) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    return; // not a well-formed URL; let page.goto surface its own error
  }
  // Attached to the user's REAL Chrome: chrome://settings/passwords,
  // devtools:// (arbitrary CDP), chrome-extension:// backgrounds are all
  // reachable by URL and none of them go through the redaction this
  // server relies on elsewhere. Block only in attach mode — the owned
  // Chromium profile has no real passwords/extensions to expose.
  if (mode === "attach" && ATTACH_BLOCKED_SCHEMES.has(url.protocol)) {
    throw new Error(`navigation to "${url.protocol}" URLs is blocked while attached to an external Chrome`);
  }
  if (url.protocol !== "file:") return;
  const filePath = decodeURIComponent(url.pathname).replace(/^\/([a-zA-Z]:)/, "$1");
  const resolved = path.resolve(filePath);
  const base = path.resolve(ROOT) + path.sep;
  if (!resolved.startsWith(base)) {
    throw new Error(
      `file:// navigation to "${filePath}" is outside this project's directory (${ROOT}); ` +
        "only local files under the project are allowed to prevent arbitrary local file disclosure"
    );
  }
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

function trackPage(playwrightPage, presetId = null) {
  const id = presetId ?? String(nextTabId++);
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
  // In attach mode, tabs the agent hasn't explicitly selected must stay
  // un-instrumented (no listeners, not operable) — so never auto-create a
  // page here the way launch mode does.
  if (mode === "launch" && tabs.size === 0) adoptPage(await context.newPage());
  return context;
}

export async function getContext() {
  return ensureContext();
}

export function getMode() {
  return mode;
}

// Explicit attach only — this must never be reachable from any other tool's
// code path. Discovers existing tabs WITHOUT instrumenting them (no
// listeners, no dialog auto-accept, not operable) until browser_tab_select
// explicitly promotes one — the user's own unrelated tabs stay untouched.
export async function attachToChrome(port) {
  if (contextPromise) {
    throw new Error(`a browser session (${mode}) is already active; call browser_detach or browser_session_close first`);
  }
  const endpoint = `http://127.0.0.1:${port}`;
  mode = "attach";
  contextPromise = (async () => {
    let browser;
    try {
      browser = await chromium.connectOverCDP(endpoint);
    } catch (e) {
      mode = "launch";
      contextPromise = null;
      throw new Error(
        `could not attach to Chrome at ${endpoint}: ${e.message}. Launch a dedicated Chrome window first, e.g.: ` +
          `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="<some folder>" --remote-debugging-port=${port}`
      );
    }
    externalBrowser = browser;
    const context = browser.contexts()[0] ?? (await browser.newContext());
    // A page that appears AFTER attach must NOT be auto-instrumented — it
    // could be the user opening a new tab in their own window and logging
    // into something (this is exactly the (c) usage pattern the design
    // recommends). It goes to `discovered` like a pre-existing tab, same
    // URL redaction, same "must be explicitly selected" rule. A popup the
    // AGENT's own click opened is still tracked immediately, but that path
    // goes through withPopupTracking() below, not this generic listener.
    context.on("page", (p) => {
      if (mode === "attach") {
        if (![...tabs.values()].includes(p) && !discoveredIds.has(p)) {
          const id = String(nextTabId++);
          discoveredIds.set(p, id);
          discovered.set(id, p);
        }
        return;
      }
      if (![...tabs.values()].includes(p)) trackPage(p);
    });
    for (const p of context.pages()) {
      const id = String(nextTabId++);
      discoveredIds.set(p, id);
      discovered.set(id, p);
    }
    return context;
  })();
  await contextPromise; // surface a bad port immediately, not on first tool call
}

export async function detachFromChrome() {
  if (mode !== "attach") throw new Error("not currently attached to an external Chrome");
  if (externalBrowser) {
    // Confirmed by direct test: Browser.close() on a CDP-connected browser
    // disconnects the DevTools session only — the real Chrome process (and
    // all its windows/tabs) keeps running untouched.
    await externalBrowser.close().catch(() => {});
  }
  externalBrowser = null;
  contextPromise = null;
  tabs.clear();
  discovered.clear();
  activeTabId = null;
  lastDialog = null;
  consoleLogs.clear();
  networkLogs.clear();
  mode = "launch";
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

// Query params/fragments routinely carry tokens (?access_token=...); an
// unselected discovered tab is shown by origin+path only — enough to pick
// the right tab without leaking a credential into the tool result just for
// appearing in a list.
function redactedUrl(page) {
  try {
    const u = new URL(page.url());
    return u.origin + u.pathname;
  } catch {
    return page.url();
  }
}

export async function listTabs() {
  await ensureContext();
  const result = [];
  for (const [id, p] of tabs) {
    if (p.isClosed()) continue;
    result.push({ id, url: p.url(), title: await p.title().catch(() => ""), active: id === activeTabId, selected: true });
  }
  for (const [id, p] of discovered) {
    if (p.isClosed()) {
      discovered.delete(id);
      continue;
    }
    result.push({ id, url: redactedUrl(p), title: await p.title().catch(() => ""), active: false, selected: false });
  }
  return result;
}

// Shared by newTab() and withPopupTracking(): a Page that just appeared may
// already have been claimed by the generic context.on("page") listener
// above (launch mode: tracked immediately; attach mode: parked in
// `discovered`) BEFORE the caller's own await resolves — context.newPage()
// and a click-triggered popup both fire that listener synchronously ahead
// of their promise settling. Re-tracking blindly here double-registers
// listeners (double-logged console/network, double dialog handlers).
// adoptPage() checks both places first so a page is instrumented exactly once.
function adoptPage(page) {
  const trackedId = [...tabs.entries()].find(([, p]) => p === page)?.[0];
  if (trackedId) {
    activeTabId = trackedId;
    return trackedId;
  }
  const discoveredId = [...discovered.entries()].find(([, p]) => p === page)?.[0];
  if (discoveredId) {
    discovered.delete(discoveredId);
    return trackPage(page, discoveredId); // instrument now, first time
  }
  return trackPage(page); // genuinely new to us
}

export async function newTab() {
  const context = await ensureContext();
  const p = await context.newPage();
  return adoptPage(p);
}

export async function selectTab(id) {
  if (tabs.has(id)) {
    if (tabs.get(id).isClosed()) throw new Error(`unknown or closed tab id "${id}"`);
    activeTabId = id;
    return;
  }
  const discoveredPage = discovered.get(id);
  if (discoveredPage) {
    if (discoveredPage.isClosed()) {
      discovered.delete(id);
      throw new Error(`unknown or closed tab id "${id}"`);
    }
    discovered.delete(id);
    trackPage(discoveredPage, id); // instrument NOW, only because it was explicitly selected
    activeTabId = id;
    return;
  }
  throw new Error(`unknown or closed tab id "${id}"`);
}

export async function closeTab(id) {
  // Attach mode: refuse to close a tab the agent never selected/opened —
  // an agent must not be able to close the user's unrelated real tabs.
  if (mode === "attach" && discovered.has(id)) {
    throw new Error(`tab "${id}" was never selected by this session — refusing to close a tab the agent didn't open/select`);
  }
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
  if (popup) adoptPage(popup);
}

export function getLastDialog() {
  return lastDialog;
}

export async function closeSession() {
  if (!contextPromise) return;
  if (mode === "attach") {
    // MUST NOT call context.close() here — on a CDP-attached context that
    // would close the user's real browser windows/tabs, not just disconnect.
    await detachFromChrome();
    return;
  }
  const context = await contextPromise;
  await context.close();
  contextPromise = null;
  tabs.clear();
  discovered.clear();
  activeTabId = null;
  lastDialog = null;
  consoleLogs.clear();
  networkLogs.clear();
}

process.on("SIGINT", () => closeSession().finally(() => process.exit(0)));
process.on("SIGTERM", () => closeSession().finally(() => process.exit(0)));
