import { z } from "zod";
import {
  getContext,
  getActivePage,
  selectTab,
  listTabs,
  newTab,
  closeTab,
  withPopupTracking,
  getLastDialog,
  closeSession,
  artifactPath,
  downloadPath,
} from "../browser-session.js";
import { snapshot, locatorFor } from "../snapshot.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// Contract: every mutating tool (navigate/click/type/tab switch/etc.)
// re-observes the page after acting and returns the *actual resulting
// state*, never a bare {success:true}. This is the core acceptance
// requirement, not an add-on. Any new tool added to this file MUST follow
// this same pattern (call observedState() before returning).
async function observedState(page, label) {
  const snap = await snapshot(page);
  return { action: label, url: snap.url, title: snap.title, snapshot: snap.text };
}

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

export function registerBrowserTools(server) {
  server.registerTool(
    "browser_snapshot",
    {
      title: "Snapshot current page",
      description:
        "Returns the current URL, title, and a ref-tagged list of visible interactive elements " +
        '(e.g. `[2-4] button "Save"`) for the active tab. Call this before click/type to get valid refs.',
      inputSchema: {},
    },
    async () => text(await observedState(await getActivePage(), "snapshot"))
  );

  server.registerTool(
    "browser_navigate",
    {
      title: "Navigate to a URL",
      description:
        "Loads the given URL in the active tab, waits for load, then returns the resulting page " +
        "state (actual URL/title/snapshot after navigation, not just success).",
      inputSchema: { url: z.string().describe("URL to navigate to") },
    },
    async ({ url }) => {
      const page = await getActivePage();
      await page.goto(url, { waitUntil: "load" });
      return text(await observedState(page, `navigate:${url}`));
    }
  );

  server.registerTool(
    "browser_back",
    { title: "Go back", description: "Navigates back in the active tab's history and returns the resulting state.", inputSchema: {} },
    async () => {
      const page = await getActivePage();
      await page.goBack({ waitUntil: "load" });
      return text(await observedState(page, "back"));
    }
  );

  server.registerTool(
    "browser_forward",
    { title: "Go forward", description: "Navigates forward in the active tab's history and returns the resulting state.", inputSchema: {} },
    async () => {
      const page = await getActivePage();
      await page.goForward({ waitUntil: "load" });
      return text(await observedState(page, "forward"));
    }
  );

  server.registerTool(
    "browser_reload",
    { title: "Reload", description: "Reloads the active tab and returns the resulting state.", inputSchema: {} },
    async () => {
      const page = await getActivePage();
      await page.reload({ waitUntil: "load" });
      return text(await observedState(page, "reload"));
    }
  );

  server.registerTool(
    "browser_click",
    {
      title: "Click an element",
      description:
        "Clicks the element with the given ref (from browser_snapshot), then re-snapshots and " +
        "returns the actual resulting page state. If the click opens a new tab/popup, the active " +
        "tab switches to it and the returned state reflects the NEW tab, not the one the click " +
        "abandoned. Throws if the ref is stale/unknown or the element cannot be clicked.",
      inputSchema: { ref: z.string().describe('Element ref from browser_snapshot, e.g. "2-4"') },
    },
    async ({ ref }) => {
      const page = await getActivePage();
      const context = await getContext();
      const locator = locatorFor(page, ref);
      await withPopupTracking(context, () => locator.click({ timeout: 5000 }));
      const active = await getActivePage();
      return text(await observedState(active, `click:${ref}`));
    }
  );

  server.registerTool(
    "browser_type",
    {
      title: "Type text into an element",
      description:
        "Fills the element with the given ref with text, then re-snapshots and returns the " +
        "actual resulting page state, including the element's post-fill value where readable.",
      inputSchema: { ref: z.string().describe('Element ref from browser_snapshot, e.g. "2-4"'), text: z.string() },
    },
    async ({ ref, text: value }) => {
      const page = await getActivePage();
      const locator = locatorFor(page, ref);
      await locator.fill(value, { timeout: 5000 });
      const actualValue = await locator.inputValue().catch(() => null);
      const result = await observedState(page, `type:${ref}`);
      return text({ ...result, actualValue });
    }
  );

  server.registerTool(
    "browser_select",
    {
      title: "Select a dropdown option",
      description: "Selects an <select> option by value/label on the given ref, then returns the resulting page state.",
      inputSchema: { ref: z.string(), value: z.string().describe("option value or visible label") },
    },
    async ({ ref, value }) => {
      const page = await getActivePage();
      const locator = locatorFor(page, ref);
      await locator.selectOption(value, { timeout: 5000 }).catch(() => locator.selectOption({ label: value }, { timeout: 5000 }));
      return text(await observedState(page, `select:${ref}=${value}`));
    }
  );

  server.registerTool(
    "browser_hover",
    { title: "Hover an element", description: "Hovers the element with the given ref, then returns the resulting page state.", inputSchema: { ref: z.string() } },
    async ({ ref }) => {
      const page = await getActivePage();
      await locatorFor(page, ref).hover({ timeout: 5000 });
      return text(await observedState(page, `hover:${ref}`));
    }
  );

  server.registerTool(
    "browser_scroll",
    {
      title: "Scroll the page",
      description: "Scrolls the active tab by the given pixel deltas, then returns the resulting page state.",
      inputSchema: { deltaX: z.number().default(0), deltaY: z.number().default(0) },
    },
    async ({ deltaX, deltaY }) => {
      const page = await getActivePage();
      await page.mouse.wheel(deltaX, deltaY);
      return text(await observedState(page, `scroll:${deltaX},${deltaY}`));
    }
  );

  server.registerTool(
    "browser_key",
    {
      title: "Press a key",
      description: 'Presses a keyboard key (Playwright key names, e.g. "Enter", "Escape"), then returns the resulting page state.',
      inputSchema: { key: z.string() },
    },
    async ({ key }) => {
      const page = await getActivePage();
      await page.keyboard.press(key);
      return text(await observedState(page, `key:${key}`));
    }
  );

  server.registerTool(
    "browser_wait",
    {
      title: "Wait for a condition",
      description:
        "Waits for a ref to appear in the DOM, or for a fixed timeout in ms if no ref is given, then returns the resulting page state.",
      inputSchema: { ref: z.string().optional(), timeoutMs: z.number().default(3000) },
    },
    async ({ ref, timeoutMs }) => {
      const page = await getActivePage();
      if (ref) {
        await page.waitForSelector(`[data-oc-ref="${ref}"]`, { timeout: timeoutMs }).catch(() => {});
      } else {
        await page.waitForTimeout(timeoutMs);
      }
      return text(await observedState(page, `wait`));
    }
  );

  server.registerTool(
    "browser_upload",
    {
      title: "Upload file(s) to a file input",
      description: "Sets file(s) on the file input with the given ref, then returns the resulting page state.",
      inputSchema: { ref: z.string(), paths: z.array(z.string()).describe("absolute local file paths") },
    },
    async ({ ref, paths }) => {
      const page = await getActivePage();
      await locatorFor(page, ref).setInputFiles(paths);
      return text(await observedState(page, `upload:${ref}`));
    }
  );

  server.registerTool(
    "browser_click_and_wait_for_download",
    {
      title: "Click an element that triggers a download",
      description:
        "Clicks the given ref, waits for a download to start, saves it under artifacts/downloads, " +
        "and returns its actual saved path, byte size, and sha256 hash — not just that the click succeeded.",
      inputSchema: { ref: z.string(), timeoutMs: z.number().default(15000) },
    },
    async ({ ref, timeoutMs }) => {
      const page = await getActivePage();
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: timeoutMs }),
        locatorFor(page, ref).click({ timeout: 5000 }),
      ]);
      const file = downloadPath(download.suggestedFilename() || `download-${Date.now()}`);
      await download.saveAs(file);
      const buf = await readFile(file);
      return text({
        action: `download:${ref}`,
        path: file,
        sizeBytes: buf.length,
        sha256: createHash("sha256").update(buf).digest("hex"),
      });
    }
  );

  server.registerTool(
    "browser_last_dialog",
    {
      title: "Get the last JS dialog",
      description:
        "Returns metadata (type, message, defaultValue, timestamp) for the most recent alert/confirm/prompt " +
        "dialog. Dialogs are auto-accepted so the page never hangs; use this to observe what actually appeared.",
      inputSchema: {},
    },
    async () => text(getLastDialog() ?? { message: "no dialog observed yet" })
  );

  server.registerTool(
    "browser_screenshot",
    {
      title: "Screenshot the current page",
      description: "Saves a PNG screenshot of the active tab to the artifacts directory and returns its path.",
      inputSchema: {},
    },
    async () => {
      const page = await getActivePage();
      const file = artifactPath(`${Date.now()}.png`);
      await page.screenshot({ path: file });
      return text(file);
    }
  );

  server.registerTool(
    "browser_tabs_list",
    { title: "List tabs", description: "Lists all open tabs with id, url, title, and which one is active.", inputSchema: {} },
    async () => text(await listTabs())
  );

  server.registerTool(
    "browser_tab_new",
    { title: "Open a new tab", description: "Opens a new blank tab, makes it active, and returns tab list.", inputSchema: {} },
    async () => {
      await newTab();
      return text(await listTabs());
    }
  );

  server.registerTool(
    "browser_tab_select",
    { title: "Select a tab", description: "Makes the given tab id active, then returns the tab's observed state.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      await selectTab(id);
      return text(await observedState(await getActivePage(), `tab_select:${id}`));
    }
  );

  server.registerTool(
    "browser_tab_close",
    { title: "Close a tab", description: "Closes the given tab id, then returns the updated tab list.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      await closeTab(id);
      return text(await listTabs());
    }
  );

  server.registerTool(
    "browser_session_close",
    {
      title: "Close the browser session",
      description: "Closes the entire browser (all tabs) and releases the persistent profile lock.",
      inputSchema: {},
    },
    async () => {
      await closeSession();
      return text("browser session closed");
    }
  );
}
