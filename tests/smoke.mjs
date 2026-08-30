// Standalone MCP client smoke test — exercises the server directly (no OpenCode)
// so bugs are caught before wiring into the real CLI.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { pathToFileURL } from "node:url";
import path from "node:path";
import http from "node:http";
import { readFile } from "node:fs/promises";

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

// --- Phase 2: DevTools / secret non-exposure -----------------------------

// Real HTTP server (stdlib only) so we can set a real Set-Cookie header —
// file:// URLs can't carry cookies reliably, and a structural-only test
// ("no 'value' key exists") would pass vacuously with zero cookies.
const fixtureHtml = await readFile(path.join(root, "tests", "fixtures", "basic.html"), "utf8");
const httpServer = http.createServer((req, res) => {
  res.setHeader("Set-Cookie", "secret_token=abcdef123456; HttpOnly; Path=/");
  res.setHeader("Authorization-Echo", "should-never-appear-in-network-log");
  res.end(fixtureHtml);
});
await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const httpUrl = `http://127.0.0.1:${httpServer.address().port}/`;

await client.callTool({ name: "browser_navigate", arguments: { url: httpUrl } });

const cookies = JSON.parse((await client.callTool({ name: "browser_cookies", arguments: {} })).content[0].text);
const secretCookie = cookies.find((c) => c.name === "secret_token");
must(Boolean(secretCookie), "browser_cookies sees the real cookie set by the server");
must(!("value" in secretCookie), "browser_cookies never includes the raw cookie 'value' field");
must(secretCookie.hasValue === true && secretCookie.valueLength === "abcdef123456".length, "browser_cookies reports hasValue/valueLength instead of the value");

const storage = JSON.parse((await client.callTool({ name: "browser_storage", arguments: {} })).content[0].text);
const lsEntry = storage.localStorage.find((e) => e.key === "secret_ls");
must(Boolean(lsEntry), "browser_storage sees the real localStorage key set by the fixture");
must(!("value" in lsEntry), "browser_storage never includes the raw localStorage value");
must(lsEntry.valueLength === "super-secret-value-12345".length, "browser_storage reports the real value length without the value");

const netLogRaw = (await client.callTool({ name: "browser_network_log", arguments: {} })).content[0].text;
must(!netLogRaw.includes("should-never-appear-in-network-log"), "browser_network_log never leaks response header VALUES");
must(!netLogRaw.toLowerCase().includes("authorization-echo"), "browser_network_log doesn't even include header NAMES (metadata-only by design)");
must(JSON.parse(netLogRaw).some((e) => e.url === httpUrl), "browser_network_log records the actual request that was made");

const consoleLog = JSON.parse((await client.callTool({ name: "browser_console_log", arguments: {} })).content[0].text);
must(consoleLog.some((e) => e.text === "fixture loaded"), "browser_console_log captures the ACTUAL console.log the page emitted");

const domQuery = JSON.parse((await client.callTool({ name: "browser_dom_query", arguments: { selector: "button" } })).content[0].text);
must(domQuery.count === 2, "browser_dom_query returns the real matching element count, got " + domQuery.count);

const csrfQuery = JSON.parse((await client.callTool({ name: "browser_dom_query", arguments: { selector: "#csrf" } })).content[0].text);
const csrfRaw = JSON.stringify(csrfQuery);
must(!csrfRaw.includes("hidden-secret-token-98765"), "browser_dom_query redacts a hidden input's value (doesn't become the secret-exposure bypass route)");
must(csrfQuery.elements[0].attributes.value.includes("length=25"), "browser_dom_query still reports the real value length, just not the value");

const metaQuery = JSON.parse((await client.callTool({ name: "browser_dom_query", arguments: { selector: 'meta[name="csrf-token"]' } })).content[0].text);
const metaRaw = JSON.stringify(metaQuery);
must(!metaRaw.includes("meta-secret-token-54321"), "browser_dom_query redacts a csrf-token <meta> tag's content, not just <input value>");
must(metaQuery.elements[0].attributes.content.includes("length=23"), "browser_dom_query still reports the real meta content length, just not the value");

const perf = JSON.parse((await client.callTool({ name: "browser_performance", arguments: {} })).content[0].text);
must(typeof perf.loadMs === "number", "browser_performance returns real navigation timing");

// Negative test: browser_evaluate must be disabled unless explicitly opted
// into via env var — it must NOT silently run just because config allows it.
let evalRejected = false;
try {
  const r = await client.callTool({ name: "browser_evaluate", arguments: { expression: "1+1" } });
  evalRejected = r.isError === true;
} catch {
  evalRejected = true;
}
must(evalRejected, "browser_evaluate is disabled by default (requires OPENCODE_CU_ALLOW_EVAL=1)");

const visible = JSON.parse((await client.callTool({ name: "browser_assert_visible", arguments: { selector: "#go" } })).content[0].text);
must(visible.present === true && visible.visibleCount === 1, "browser_assert_visible confirms the ACTUAL presence of a real element");
const notVisible = JSON.parse((await client.callTool({ name: "browser_assert_visible", arguments: { selector: "#does-not-exist" } })).content[0].text);
must(notVisible.present === false && notVisible.visibleCount === 0, "browser_assert_visible correctly reports absence, not a rigged true");

const textPresent = JSON.parse((await client.callTool({ name: "browser_assert_text", arguments: { text: "Go" } })).content[0].text);
must(textPresent.present === true, "browser_assert_text finds text that is actually on the page");
const textAbsent = JSON.parse((await client.callTool({ name: "browser_assert_text", arguments: { text: "definitely-not-on-this-page-xyz" } })).content[0].text);
must(textAbsent.present === false, "browser_assert_text correctly reports absence of text that isn't there");

// Visual verification: a real small UI change (button label) on a FULL-PAGE
// screenshot must still register as changed — this caught a real bug where
// the old flat 1% threshold missed small changes on large screenshots.
await client.callTool({ name: "browser_navigate", arguments: { url: fixtureUrl } });
const before = (await client.callTool({ name: "browser_screenshot", arguments: {} })).content[0].text;
const freshGoRef2 = JSON.parse((await client.callTool({ name: "browser_snapshot", arguments: {} })).content[0].text).snapshot.match(
  /\[([\d-]+)\] button "Go"/
)[1];
await client.callTool({ name: "browser_click", arguments: { ref: freshGoRef2 } });
const after = (await client.callTool({ name: "browser_screenshot", arguments: {} })).content[0].text;
const diff = JSON.parse((await client.callTool({ name: "browser_screenshot_diff", arguments: { beforePath: before, afterPath: after } })).content[0].text);
must(diff.changed === true, `browser_screenshot_diff detects a real small UI change on a full-page screenshot, got diffRatio=${diff.diffRatio}`);
const same = JSON.parse((await client.callTool({ name: "browser_screenshot_diff", arguments: { beforePath: after, afterPath: after } })).content[0].text);
must(same.changed === false, "browser_screenshot_diff reports no change when comparing identical screenshots");

httpServer.close();

await client.close();
console.log("\nALL SMOKE TESTS PASSED");
process.exit(0);
