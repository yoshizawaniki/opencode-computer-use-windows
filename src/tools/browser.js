import { z } from "zod";
import { getPage, artifactPath } from "../browser-session.js";
import { snapshot, locatorFor } from "../snapshot.js";

// Contract: every mutating tool (navigate/click/type) re-observes the page
// after acting and returns the *actual resulting state*, never a bare
// {success:true}. This is the core acceptance requirement, not an add-on.
async function observedState(page, label) {
  const snap = await snapshot(page);
  return { action: label, url: snap.url, title: snap.title, snapshot: snap.text };
}

export function registerBrowserTools(server) {
  server.registerTool(
    "browser_snapshot",
    {
      title: "Snapshot current page",
      description:
        "Returns the current URL, title, and a ref-tagged list of visible interactive elements " +
        '(e.g. `[2-4] button "Save"`). Call this before click/type to get valid refs.',
      inputSchema: {},
    },
    async () => {
      const page = await getPage();
      const snap = await snapshot(page);
      return {
        content: [
          { type: "text", text: `url: ${snap.url}\ntitle: ${snap.title}\n\n${snap.text}` },
        ],
      };
    }
  );

  server.registerTool(
    "browser_navigate",
    {
      title: "Navigate to a URL",
      description:
        "Loads the given URL, waits for load, then returns the resulting page state " +
        "(actual URL/title/snapshot after navigation, not just success).",
      inputSchema: { url: z.string().describe("URL to navigate to") },
    },
    async ({ url }) => {
      const page = await getPage();
      await page.goto(url, { waitUntil: "load" });
      const result = await observedState(page, `navigate:${url}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "browser_click",
    {
      title: "Click an element",
      description:
        "Clicks the element with the given ref (from browser_snapshot), then re-snapshots " +
        "and returns the actual resulting page state. Throws if the ref is stale/unknown or " +
        "the element cannot be clicked — this is a real failure, not a soft {success:false}.",
      inputSchema: { ref: z.string().describe('Element ref from browser_snapshot, e.g. "2-4"') },
    },
    async ({ ref }) => {
      const page = await getPage();
      const locator = locatorFor(page, ref);
      await locator.click({ timeout: 5000 });
      const result = await observedState(page, `click:${ref}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "browser_type",
    {
      title: "Type text into an element",
      description:
        "Fills the element with the given ref with text, then re-snapshots and returns the " +
        "actual resulting page state, including the element's post-fill value where readable.",
      inputSchema: {
        ref: z.string().describe('Element ref from browser_snapshot, e.g. "2-4"'),
        text: z.string(),
      },
    },
    async ({ ref, text }) => {
      const page = await getPage();
      const locator = locatorFor(page, ref);
      await locator.fill(text, { timeout: 5000 });
      const actualValue = await locator.inputValue().catch(() => null);
      const result = await observedState(page, `type:${ref}`);
      return {
        content: [{ type: "text", text: JSON.stringify({ ...result, actualValue }, null, 2) }],
      };
    }
  );

  server.registerTool(
    "browser_screenshot",
    {
      title: "Screenshot the current page",
      description: "Saves a PNG screenshot to the artifacts directory and returns its path.",
      inputSchema: {},
    },
    async () => {
      const page = await getPage();
      const file = artifactPath(`${Date.now()}.png`);
      await page.screenshot({ path: file });
      return { content: [{ type: "text", text: file }] };
    }
  );
}
