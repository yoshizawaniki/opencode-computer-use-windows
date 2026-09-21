// Standalone MCP client smoke test — exercises the server directly (no OpenCode)
// so bugs are caught before wiring into the real CLI.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { pathToFileURL } from "node:url";
import path from "node:path";
import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn as spawnProc } from "node:child_process";

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

// Found by independent audit: snapshot.js predated the redaction rule
// dom_query already had, so every mutating tool (observedState() calls
// snapshot()) was shipping password-field plaintext to the LLM.
must(
  !navState.snapshot.includes("SuperSecretPassword123"),
  "browser_snapshot never includes a password input's raw value — this is the core secret-non-exposure guarantee, and it applies to EVERY mutating tool's return value, not just browser_snapshot itself"
);
must(/redacted, length=22/.test(navState.snapshot), "the password field's real length is still surfaced, just not the value");

// End-to-end wiring check for the identifier-token boundary fix: a
// non-password input whose NAME (not type) marks it sensitive, via a
// camelCase field name specifically (the case that broke twice before this
// was pinned in tests/redaction-pattern.test.mjs — that test covers the
// regex in isolation, this one covers redaction.js -> args -> snapshot.js
// actually being wired together end to end).
must(
  !navState.snapshot.includes("camelCaseSecretValue456"),
  "browser_snapshot redacts a camelCase-named sensitive field (name=\"sessionKey\"), not just type=password"
);
must(/redacted, length=23/.test(navState.snapshot), "the sessionKey field's real length is still surfaced, just not the value");

// Secret Broker e2e: register a secret bound to this fixture's origin,
// fill it via browser_secret_fill into a PLAIN (non-password, non
// sensitive-named) field, then confirm the value never surfaces through
// browser_snapshot even though name-based redaction alone would never catch
// "#box" — this is what proves the value-based scrub in server.js/
// redaction.js works, not just the name-based check already covered above.
// file:// pages all share origin "null" (WHATWG spec), which is what
// assertNavigateAllowed's file:// project-root scoping already relies on to
// keep this usable for local test fixtures.
if (process.platform === "win32") {
  function runSecretCli(args, stdinText) {
    return new Promise((resolve, reject) => {
      const child = spawnProc(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "secret-cli.ps1"), ...args],
        { cwd: root }
      );
      let out = "", err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(err || out))));
      if (stdinText !== undefined) child.stdin.write(stdinText + "\n");
      child.stdin.end();
    });
  }

  const SECRET = "SmokeTestSecretValueXYZ789";
  await runSecretCli(["-Action", "register", "-Name", "oc-smoke-secret", "-Scope", "null"], SECRET);
  try {
    const fillSnap = await client.callTool({ name: "browser_snapshot", arguments: {} });
    const boxRef = JSON.parse(fillSnap.content[0].text).snapshot.match(/\[([\d-]+)\] input "type here"/)?.[1];
    must(boxRef, "snapshot exposes a ref for the plain #box input");

    const fill = await client.callTool({ name: "browser_secret_fill", arguments: { ref: boxRef, name: "oc-smoke-secret" } });
    const fillResult = JSON.parse(fill.content[0].text);
    must(!JSON.stringify(fillResult).includes(SECRET), "browser_secret_fill's own return value never contains the secret value");
    must(fillResult.filledLength === SECRET.length, "browser_secret_fill reports the filled length, not the value");

    const afterFill = await client.callTool({ name: "browser_snapshot", arguments: {} });
    must(
      !JSON.stringify(afterFill).includes(SECRET),
      "browser_snapshot never echoes a secret-filled value back, even for a field with no sensitive name/type"
    );

    let scopeMismatchThrew = false;
    try {
      await client.callTool({ name: "browser_secret_fill", arguments: { ref: boxRef, name: "oc-smoke-secret-wrong-scope-does-not-exist" } });
    } catch {
      scopeMismatchThrew = true;
    }
    if (!scopeMismatchThrew) {
      const badFill = await client.callTool({ name: "browser_secret_fill", arguments: { ref: boxRef, name: "oc-smoke-secret-wrong-scope-does-not-exist" } });
      scopeMismatchThrew = badFill.isError === true;
    }
    must(scopeMismatchThrew, "browser_secret_fill refuses an unregistered secret name");
  } finally {
    await runSecretCli(["-Action", "remove", "-Name", "oc-smoke-secret"]);
  }
}

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

// browser_tab_new must add exactly one tab — a page appearing via
// context.newPage() can get claimed by the generic page-listener before
// newTab()'s own await resolves; double-tracking it would double-register
// console/network listeners and dialog handlers on the SAME page.
const beforeNewTab = JSON.parse((await client.callTool({ name: "browser_tabs_list", arguments: {} })).content[0].text);
await client.callTool({ name: "browser_tab_new", arguments: {} });
const afterNewTab = JSON.parse((await client.callTool({ name: "browser_tabs_list", arguments: {} })).content[0].text);
must(afterNewTab.length === beforeNewTab.length + 1, `browser_tab_new adds exactly one tab, got ${beforeNewTab.length} -> ${afterNewTab.length}`);
const createdTabId = afterNewTab.find((t) => t.active).id;
await client.callTool({ name: "browser_tab_close", arguments: { id: createdTabId } });

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

// Negative test: browser_navigate must refuse file:// outside this project —
// otherwise it's a bypass of the upload path restriction's whole intent
// (arbitrary local file content becomes readable via snapshot/dom_query).
let outsideFileRejected = false;
try {
  const r = await client.callTool({
    name: "browser_navigate",
    arguments: { url: pathToFileURL(path.join(root, "..", "package.json")).href },
  });
  outsideFileRejected = r.isError === true;
} catch {
  outsideFileRejected = true;
}
must(outsideFileRejected, "browser_navigate refuses a file:// URL outside the project directory");

// Element cap: a page with far more interactive elements than the cap must
// not dump an unbounded tree at the LLM.
const stressUrl = pathToFileURL(path.join(root, "tests", "fixtures", "stress.html")).href;
const stress = JSON.parse((await client.callTool({ name: "browser_navigate", arguments: { url: stressUrl } })).content[0].text);
const btnCount = (stress.snapshot.match(/button "btn/g) || []).length;
must(btnCount <= 150, `snapshot caps element count on a large page, got ${btnCount} elements`);
must(stress.snapshot.includes("truncated"), "snapshot flags truncation instead of silently dropping elements");

// --- DevTools / secret non-exposure --------------------------------------

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

// Record & Replay e2e: record click(Go) + type(#box), edit the typed value
// into a "${msg}" placeholder, replay against a freshly-reloaded page (so
// the ORIGINAL refs are gone) with a different value, and confirm the
// replayed result reflects the real post-action state — not just that
// replay "ran".
await client.callTool({ name: "browser_navigate", arguments: { url: fixtureUrl } });
await client.callTool({ name: "workflow_record_start", arguments: { name: "smoke-wf" } });

const wfSnap1 = JSON.parse((await client.callTool({ name: "browser_snapshot", arguments: {} })).content[0].text);
const wfGoRef = wfSnap1.snapshot.match(/\[([\d-]+)\] button "Go"/)[1];
await client.callTool({ name: "browser_click", arguments: { ref: wfGoRef } });

const wfSnap2 = JSON.parse((await client.callTool({ name: "browser_snapshot", arguments: {} })).content[0].text);
const wfBoxRef = wfSnap2.snapshot.match(/\[([\d-]+)\] input "type here"/)[1];
await client.callTool({ name: "browser_type", arguments: { ref: wfBoxRef, text: "literal-hello" } });

const stopped = JSON.parse((await client.callTool({ name: "workflow_record_stop", arguments: {} })).content[0].text);
must(stopped.stepCount === 2, `workflow_record_stop captured exactly 2 steps, got ${stopped.stepCount}`);

const preview = JSON.parse((await client.callTool({ name: "workflow_preview", arguments: { name: "smoke-wf" } })).content[0].text);
must(preview.steps[0].tool === "browser_click" && preview.steps[0].target?.role === "button" && preview.steps[0].target?.name === "Go", "recorded step 1 stores a semantic (role+name) target for the Go button, not a raw ref");
must(preview.steps[1].tool === "browser_type" && preview.steps[1].args.text === "literal-hello", "recorded step 2 stores the typed literal value");
must(!("ref" in preview.steps[1].args), "recorded step's args no longer carry the (now-stale-prone) raw ref");

const parameterized = JSON.parse(JSON.stringify(preview.steps));
parameterized[1].args.text = "${msg}";
const edited = JSON.parse((await client.callTool({ name: "workflow_edit", arguments: { name: "smoke-wf", stepsJson: JSON.stringify(parameterized) } })).content[0].text);
must(edited.stepCount === 2, "workflow_edit saves the parameterized steps");

// Reset the page so the ORIGINAL refs from recording are gone entirely —
// replay must resolve targets against THIS fresh state via role+name, not
// reuse anything from the recording.
await client.callTool({ name: "browser_navigate", arguments: { url: fixtureUrl } });
const replayed = JSON.parse((await client.callTool({ name: "workflow_replay", arguments: { name: "smoke-wf", params: { msg: "parameterized-value" } } })).content[0].text);
must(replayed.steps[0].result.snapshot.includes('button "Clicked!"'), "replayed click step produces the real post-click DOM state");
must(replayed.steps[1].result.actualValue === "parameterized-value", `replayed type step used the SUBSTITUTED param, got "${replayed.steps[1].result.actualValue}"`);

await client.callTool({ name: "workflow_delete", arguments: { name: "smoke-wf" } });
const afterDelete = JSON.parse((await client.callTool({ name: "workflow_list", arguments: {} })).content[0].text);
must(!afterDelete.some((w) => w.name === "smoke-wf"), "workflow_delete actually removes the saved workflow");

// Recording must never write a sensitive field's literal value to disk —
// typing into the fixture's password field gets flagged, not saved verbatim.
await client.callTool({ name: "browser_navigate", arguments: { url: fixtureUrl } });
await client.callTool({ name: "workflow_record_start", arguments: { name: "smoke-wf-secret" } });
const wfSnap3 = JSON.parse((await client.callTool({ name: "browser_snapshot", arguments: {} })).content[0].text);
const pwdRef = wfSnap3.snapshot.match(/\[([\d-]+)\] input "<redacted, length=22>"/)[1];
await client.callTool({ name: "browser_type", arguments: { ref: pwdRef, text: "PlaintextPasswordNeverSaved987" } });
const stoppedSecret = JSON.parse((await client.callTool({ name: "workflow_record_stop", arguments: {} })).content[0].text);
must(stoppedSecret.requiresManualEdit === true, "recording a type-into-password step is flagged requiresManualEdit");
const previewSecret = JSON.parse((await client.callTool({ name: "workflow_preview", arguments: { name: "smoke-wf-secret" } })).content[0].text);
must(!previewSecret.text.includes("PlaintextPasswordNeverSaved987"), "the recorded workflow file never contains the plaintext typed into a password field");
let replayThrew = false;
try {
  await client.callTool({ name: "workflow_replay", arguments: { name: "smoke-wf-secret", params: {} } });
} catch {
  replayThrew = true;
}
if (!replayThrew) {
  const r = await client.callTool({ name: "workflow_replay", arguments: { name: "smoke-wf-secret", params: {} } });
  replayThrew = r.isError === true;
}
must(replayThrew, "replaying a workflow with an unresolved requiresManualEdit step is refused, not silently skipped");
await client.callTool({ name: "workflow_delete", arguments: { name: "smoke-wf-secret" } });

// workflow_replay must never bypass the OpenCode host's ask-permission
// dialog: replay dispatches tool handlers
// IN-PROCESS, which never goes through the host's per-tool-call ask gate.
// A crafted workflow file naming an ask-gated tool (desktop_kill_process
// here — any pid works, the allowlist check must reject it before ever
// looking at args) must be refused at replay time, not silently executed.
await client.callTool({ name: "workflow_edit", arguments: { name: "smoke-wf-danger", stepsJson: JSON.stringify([{ tool: "desktop_kill_process", args: { pid: 999999 } }]) } });
let dangerousReplayRefused = false;
try {
  await client.callTool({ name: "workflow_replay", arguments: { name: "smoke-wf-danger", params: {} } });
} catch {
  dangerousReplayRefused = true;
}
if (!dangerousReplayRefused) {
  const r = await client.callTool({ name: "workflow_replay", arguments: { name: "smoke-wf-danger", params: {} } });
  dangerousReplayRefused = r.isError === true;
}
must(dangerousReplayRefused, "workflow_replay refuses an ask-gated tool (desktop_kill_process) rather than bypassing the host's approval dialog");
await client.callTool({ name: "workflow_delete", arguments: { name: "smoke-wf-danger" } });

// Origin-scope regression: navigation/read is allowed to an otherwise
// non-allowlisted scheme, but page-side mutation must fail at the shared
// mutation choke point. data: gives us a deterministic no-network page.
const untrustedDataUrl = "data:text/html,<title>origin-guard</title><button>do-not-mutate</button>";
const untrustedNav = JSON.parse(
  (await client.callTool({ name: "browser_navigate", arguments: { url: untrustedDataUrl } })).content[0].text
);
must(untrustedNav.title === "origin-guard", "read/navigation remains available without granting mutation scope");
let directOriginMutationRejected = false;
try {
  const r = await client.callTool({ name: "browser_key", arguments: { key: "Enter" } });
  directOriginMutationRejected = r.isError === true;
} catch {
  directOriginMutationRejected = true;
}
must(directOriginMutationRejected, "generic browser mutation is refused outside the configured origin scope");

await client.callTool({
  name: "workflow_edit",
  arguments: {
    name: "smoke-wf-origin-bypass",
    stepsJson: JSON.stringify([{ tool: "browser_key", args: { key: "Enter" } }]),
  },
});
let replayOriginMutationRejected = false;
try {
  const r = await client.callTool({ name: "workflow_replay", arguments: { name: "smoke-wf-origin-bypass", params: {} } });
  replayOriginMutationRejected = r.isError === true;
} catch {
  replayOriginMutationRejected = true;
}
must(replayOriginMutationRejected, "workflow_replay cannot bypass the browser origin mutation guard");
await client.callTool({ name: "workflow_delete", arguments: { name: "smoke-wf-origin-bypass" } });
await client.callTool({ name: "browser_navigate", arguments: { url: fixtureUrl } });

// Artifact preview: text content returned inline, path scoping enforced.
const previewDir = path.join(root, "artifacts", "screenshots");
await mkdir(previewDir, { recursive: true });
const previewFile = path.join(previewDir, "preview-smoke.html");
await writeFile(previewFile, "<html><body>artifact preview smoke test</body></html>", "utf8");
const artifactPreview = JSON.parse((await client.callTool({ name: "artifact_preview", arguments: { filePath: previewFile } })).content[0].text);
must(artifactPreview.kind === "text" && artifactPreview.preview.includes("artifact preview smoke test"), "artifact_preview returns real HTML content inline");
let previewRejected = false;
try {
  await client.callTool({ name: "artifact_preview", arguments: { filePath: path.join(root, "package.json") } });
} catch {
  previewRejected = true;
}
if (!previewRejected) {
  const r = await client.callTool({ name: "artifact_preview", arguments: { filePath: path.join(root, "package.json") } });
  previewRejected = r.isError === true;
}
must(previewRejected, "artifact_preview refuses a path outside artifacts/");

// Browser Annotation: a raw viewport point resolves to a real, immediately
// actionable ref (not just "here's what's near that pixel"). Get the Go
// button's actual on-screen center via its bounding box in the DOM query
// result (ground truth, not a guessed layout), then annotate that exact point.
await client.callTool({ name: "browser_navigate", arguments: { url: fixtureUrl } });
const goDomInfo = JSON.parse((await client.callTool({ name: "browser_dom_query", arguments: { selector: "#go", limit: 1 } })).content[0].text);
must(goDomInfo.count === 1, "sanity: #go exists for the annotation point test");

// #go is positioned absolutely at left:10px top:100px width:80px height:30px
// in the fixture specifically so this test has a deterministic point to
// annotate, instead of guessing default-flow layout.
const annotated = JSON.parse(
  (await client.callTool({ name: "browser_annotate_point", arguments: { x: 50, y: 115 } })).content[0].text
);
must(typeof annotated.found === "boolean", "browser_annotate_point returns a structured found:true/false answer, not a bare guess");
must(annotated.found && annotated.role === "button" && annotated.name === "Go", `browser_annotate_point resolves the point to the real Go button, got: ${JSON.stringify(annotated)}`);

const clickedViaAnnotation = JSON.parse((await client.callTool({ name: "browser_click", arguments: { ref: annotated.ref } })).content[0].text);
must(clickedViaAnnotation.snapshot.includes('button "Clicked!"'), "the ref returned by browser_annotate_point is immediately usable with browser_click");

const offPage = JSON.parse((await client.callTool({ name: "browser_annotate_point", arguments: { x: 9999, y: 9999 } })).content[0].text);
must(offPage.found === false, "browser_annotate_point correctly reports found:false for a point over nothing interactive");

httpServer.close();

await client.close();
console.log("\nALL SMOKE TESTS PASSED");
process.exit(0);
