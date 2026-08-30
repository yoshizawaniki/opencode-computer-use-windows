// Standalone MCP client smoke test — exercises the server directly (no OpenCode)
// so bugs are caught before wiring into the real CLI.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const fixtureUrl = pathToFileURL(path.join(root, "tests", "fixtures", "basic.html")).href;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src", "server.js")],
});
const client = new Client({ name: "smoke-test", version: "0.1.0" });
await client.connect(transport);

function must(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("PASS:", msg);
}

const tools = await client.listTools();
must(tools.tools.some((t) => t.name === "browser_navigate"), "browser_navigate is registered");
must(tools.tools.some((t) => t.name === "browser_click"), "browser_click is registered");

const nav = await client.callTool({ name: "browser_navigate", arguments: { url: fixtureUrl } });
const navState = JSON.parse(nav.content[0].text);
must(navState.title === "OC Fixture", "navigate returns real post-nav title, got: " + navState.title);
must(navState.snapshot.includes('button "Go"'), "navigate snapshot lists the Go button");

const snap = await client.callTool({ name: "browser_snapshot", arguments: {} });
const snapText = JSON.parse(snap.content[0].text).snapshot;
const m = snapText.match(/\[([\d-]+)\] button "Go"/);
must(m, "snapshot exposes a ref for the Go button");
const goRef = m[1];

const click = await client.callTool({ name: "browser_click", arguments: { ref: goRef } });
const clickState = JSON.parse(click.content[0].text);
must(
  clickState.snapshot.includes('button "Clicked!"'),
  "click return value reflects the ACTUAL post-click DOM state, not just success"
);

// Negative test 1: acting on a nonexistent ref must fail loudly, not silently succeed.
let threw = false;
try {
  await client.callTool({ name: "browser_click", arguments: { ref: "999-999" } });
} catch (e) {
  threw = true;
}
if (!threw) {
  const badResult = await client.callTool({ name: "browser_click", arguments: { ref: "999-999" } });
  threw = badResult.isError === true;
}
must(threw, "clicking a nonexistent ref is reported as a real failure");

// Negative test 2: a stale ref (from before a navigation) must be rejected, not silently reused.
await client.callTool({ name: "browser_navigate", arguments: { url: fixtureUrl } });
let staleRejected = false;
try {
  const r = await client.callTool({ name: "browser_click", arguments: { ref: goRef } });
  staleRejected = r.isError === true;
} catch {
  staleRejected = true;
}
must(staleRejected, "reusing a ref from a prior snapshot generation is rejected as stale");

// Tab tracking: clicking a target=_blank link must switch the active tab to
// the popup, not silently keep reporting the abandoned original tab.
const tabsBefore = JSON.parse((await client.callTool({ name: "browser_tabs_list", arguments: {} })).content[0].text);
must(tabsBefore.length === 1, "starts with exactly one tab");
const originalTabId = tabsBefore[0].id;

// Re-establish a known "already clicked" marker on this tab (the stale-ref
// test above re-navigated and reset the button), so the later tab-switch
// assertion is checking real per-tab state, not a stale expectation.
const freshGoRef = JSON.parse((await client.callTool({ name: "browser_snapshot", arguments: {} })).content[0].text).snapshot.match(
  /\[([\d-]+)\] button "Go"/
)[1];
await client.callTool({ name: "browser_click", arguments: { ref: freshGoRef } });

const snap2 = await client.callTool({ name: "browser_snapshot", arguments: {} });
const popupRef = JSON.parse(snap2.content[0].text).snapshot.match(/\[([\d-]+)\] a "Open Tab"/)[1];
const afterPopupClick = JSON.parse((await client.callTool({ name: "browser_click", arguments: { ref: popupRef } })).content[0].text);
const tabsAfter = JSON.parse((await client.callTool({ name: "browser_tabs_list", arguments: {} })).content[0].text);
must(tabsAfter.length === 2, "clicking a target=_blank link opens a real second tab");
must(
  tabsAfter.find((t) => t.active)?.id !== originalTabId,
  "active tab switches to the popup after the click that spawned it, not the abandoned original"
);
must(afterPopupClick.snapshot.includes('button "Go"'), "click return value reflects the NEW tab's content, not the old tab's");

const newTabId = tabsAfter.find((t) => t.active).id;
const selected = JSON.parse((await client.callTool({ name: "browser_tab_select", arguments: { id: originalTabId } })).content[0].text);
must(selected.snapshot.includes('button "Clicked!"'), "switching back to original tab shows ITS actual (already-clicked) state");

const afterClose = JSON.parse((await client.callTool({ name: "browser_tab_close", arguments: { id: newTabId } })).content[0].text);
must(afterClose.length === 1, "closing a tab actually removes it from the real tab list");

// Negative test 3: acting on a closed tab id must fail, not silently no-op.
let closedTabRejected = false;
try {
  const r = await client.callTool({ name: "browser_tab_select", arguments: { id: newTabId } });
  closedTabRejected = r.isError === true;
} catch {
  closedTabRejected = true;
}
must(closedTabRejected, "selecting an already-closed tab id is reported as a real failure");

// Dialogs: alert() must not hang the page, and its content must be observable.
const alertRef = JSON.parse(
  (await client.callTool({ name: "browser_snapshot", arguments: {} })).content[0].text
).snapshot.match(/\[([\d-]+)\] button "Alert"/)[1];
await client.callTool({ name: "browser_click", arguments: { ref: alertRef } });
const dialog = JSON.parse((await client.callTool({ name: "browser_last_dialog", arguments: {} })).content[0].text);
must(dialog.message === "hello from fixture", "browser_last_dialog reports the ACTUAL alert() text, got: " + dialog.message);

// Navigation history: back/forward/reload must return the real resulting page.
await client.callTool({ name: "browser_navigate", arguments: { url: fixtureUrl + "#next" } });
const back = JSON.parse((await client.callTool({ name: "browser_back", arguments: {} })).content[0].text);
must(!back.url.endsWith("#next"), "browser_back returns the ACTUAL prior URL, got: " + back.url);
const fwd = JSON.parse((await client.callTool({ name: "browser_forward", arguments: {} })).content[0].text);
must(fwd.url.endsWith("#next"), "browser_forward returns the ACTUAL forward URL, got: " + fwd.url);
const reload = JSON.parse((await client.callTool({ name: "browser_reload", arguments: {} })).content[0].text);
must(reload.title === "OC Fixture", "browser_reload returns the real reloaded page state");

// Negative test: browser_upload must refuse a path outside artifacts/uploads,
// even for an existing, readable local file — this is the guard against page
// content (fed to the LLM via snapshot) tricking an upload into exfiltrating
// an arbitrary file the agent process can read.
await client.callTool({ name: "browser_navigate", arguments: { url: fixtureUrl } });
const anyRef = JSON.parse((await client.callTool({ name: "browser_snapshot", arguments: {} })).content[0].text).snapshot.match(
  /\[([\d-]+)\]/
)[1];
let uploadRejected = false;
try {
  const r = await client.callTool({
    name: "browser_upload",
    arguments: { ref: anyRef, paths: [path.join(root, "tests", "fixtures", "basic.html")] },
  });
  uploadRejected = r.isError === true;
} catch {
  uploadRejected = true;
}
must(uploadRejected, "browser_upload refuses a path outside artifacts/uploads");

// Element cap: a page with far more interactive elements than the cap must
// not dump an unbounded tree at the LLM.
const stressUrl = pathToFileURL(path.join(root, "tests", "fixtures", "stress.html")).href;
const stress = JSON.parse((await client.callTool({ name: "browser_navigate", arguments: { url: stressUrl } })).content[0].text);
const btnCount = (stress.snapshot.match(/button "btn/g) || []).length;
must(btnCount <= 150, `snapshot caps element count on a large page, got ${btnCount} elements`);
must(stress.snapshot.includes("truncated"), "snapshot flags truncation instead of silently dropping elements");

await client.close();
console.log("\nALL SMOKE TESTS PASSED");
process.exit(0);
