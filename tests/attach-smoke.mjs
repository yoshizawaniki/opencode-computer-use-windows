// Phase 5 (Chrome Bridge) smoke test — launches a SCRATCH Chrome instance
// (dedicated user-data-dir, never the user's real profile) with a debug
// port, attaches our MCP server to it, and verifies the explicit-attach
// contract end to end. Never touches the user's actual Chrome.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const PORT = 9422;
const SCRATCH_PROFILE = path.join(root, "artifacts", "attach-test-profile");
const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const chromePath = CHROME_CANDIDATES.find(existsSync);

if (!chromePath) {
  console.log("SKIP: attach-smoke.mjs — Chrome not found at a known install path");
  process.exit(0);
}

function must(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("PASS:", msg);
}

rmSync(SCRATCH_PROFILE, { recursive: true, force: true });
mkdirSync(SCRATCH_PROFILE, { recursive: true });

// Local fixture, not an external site — matches the project's existing
// "no external network dependency in tests" rule (Phase 1). Content isn't
// asserted; this just needs to be a real pre-existing tab.
const fixtureUrl = pathToFileURL(path.join(root, "tests", "fixtures", "basic.html")).href;
const chromeProc = spawn(
  chromePath,
  [`--user-data-dir=${SCRATCH_PROFILE}`, `--remote-debugging-port=${PORT}`, "--no-first-run", "--no-default-browser-check", fixtureUrl],
  { detached: true, stdio: "ignore" }
);
chromeProc.unref();
await new Promise((r) => setTimeout(r, 2500));

const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "src", "server.js")] });
const client = new Client({ name: "attach-smoke-test", version: "0.1.0" });
await client.connect(transport);

const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

try {
  const attached = await call("browser_attach", { port: PORT });
  must(attached.attached === true, "browser_attach connects to the scratch Chrome");
  must(attached.tabs.length >= 1, "browser_attach discovers the pre-existing tab");
  must(attached.tabs[0].selected === false, "a pre-existing tab is discovered but NOT auto-selected/instrumented");

  const tabsBefore = await call("browser_tabs_list");
  const preexisting = tabsBefore[0];
  must(!preexisting.url.includes("?") && !preexisting.url.includes("#"), "an unselected tab's URL is redacted (no query/fragment)");

  // Negative test: acting on a discovered-but-unselected tab must fail.
  let unselectedRejected = false;
  try {
    const r = await client.callTool({ name: "browser_tab_close", arguments: { id: preexisting.id } });
    unselectedRejected = r.isError === true;
  } catch {
    unselectedRejected = true;
  }
  must(unselectedRejected, "closing a discovered-but-unselected tab is refused");

  // Select it — now it should be fully operable, same as any Phase1-4 tab.
  const selected = await call("browser_tab_select", { id: preexisting.id });
  must(typeof selected.url === "string" && selected.url.length > 0, "browser_tab_select promotes a discovered tab to fully operable");

  const tabsAfter = await call("browser_tabs_list");
  must(tabsAfter.find((t) => t.id === preexisting.id)?.selected === true, "the selected tab now shows selected:true");

  // Negative test: a tab opened by something OTHER than the agent (simulating
  // the user opening a new tab in the attached window — the (c) usage
  // pattern's actual login step) must NOT be auto-instrumented. Opened via
  // Chrome's own CDP HTTP endpoint directly, bypassing our MCP tools
  // entirely, so this is genuinely "not caused by an agent click".
  const newTabUrl = fixtureUrl + "?should_not_appear_in_logs=secret123";
  await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(newTabUrl)}`, { method: "PUT" });
  await new Promise((r) => setTimeout(r, 500));
  const tabsWithUserTab = await call("browser_tabs_list");
  const userOpenedTab = tabsWithUserTab.find((t) => t.id !== preexisting.id);
  must(Boolean(userOpenedTab), "a tab opened outside the agent's control is still discoverable");
  must(userOpenedTab.selected === false, "a user-opened tab is NOT auto-selected/instrumented");
  must(!userOpenedTab.url.includes("secret123"), "a user-opened tab's URL is redacted (query stripped) even before any selection");
  const netLogsForUserTab = await call("browser_network_log", {}); // active tab is still `preexisting`, not the new one
  must(
    !JSON.stringify(netLogsForUserTab).includes("secret123"),
    "no network activity was captured for the un-instrumented user-opened tab"
  );

  // browser_tab_new while attached must add exactly one NEW, already-selected
  // tab — not a ghost duplicate left behind in `discovered` (the generic
  // page-listener parks new pages there in attach mode; newTab() must adopt
  // that same page/id rather than tracking it a second time under a new id).
  const beforeNewTab = await call("browser_tabs_list");
  await call("browser_tab_new", {});
  const afterNewTab = await call("browser_tabs_list");
  must(afterNewTab.length === beforeNewTab.length + 1, `browser_tab_new (attach mode) adds exactly one tab, got ${beforeNewTab.length} -> ${afterNewTab.length}`);
  const createdTab = afterNewTab.find((t) => !beforeNewTab.some((b) => b.id === t.id));
  must(Boolean(createdTab) && createdTab.selected === true, "the tab browser_tab_new created is immediately selected/instrumented, not left as a discovered ghost");
  await call("browser_tab_close", { id: createdTab.id });

  // Negative test: browser_evaluate must be refused unconditionally while attached.
  let evalRejected = false;
  try {
    const r = await client.callTool({ name: "browser_evaluate", arguments: { expression: "1+1" } });
    evalRejected = r.isError === true;
  } catch {
    evalRejected = true;
  }
  must(evalRejected, "browser_evaluate is refused while attached, regardless of OPENCODE_CU_ALLOW_EVAL");

  // Negative test: chrome:// navigation must be blocked while attached.
  let chromeUrlRejected = false;
  try {
    const r = await client.callTool({ name: "browser_navigate", arguments: { url: "chrome://settings/passwords" } });
    chromeUrlRejected = r.isError === true;
  } catch {
    chromeUrlRejected = true;
  }
  must(chromeUrlRejected, "chrome:// navigation is blocked while attached");

  // Negative test: browser_back must be blocked when the resulting URL is a
  // blocked scheme, even though browser_navigate's guard never saw it — the
  // tab's own history can already contain chrome:// from before we selected
  // it. Set that history up via a SEPARATE Playwright connection (not our
  // server), simulating "the real tab already visited chrome:// on its own".
  const tabsBeforeHistorySetup = await call("browser_tabs_list");
  const setupBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const setupContext = setupBrowser.contexts()[0];
  const setupPage = await setupContext.newPage();
  await setupPage.goto("chrome://version/");
  await setupPage.goto(fixtureUrl);
  await setupBrowser.close(); // disconnect only — leaves the real tab open, per the same safety property being tested elsewhere

  await new Promise((r) => setTimeout(r, 500));
  const tabsWithHistory = await call("browser_tabs_list");
  const historyTab = tabsWithHistory.find((t) => !tabsBeforeHistorySetup.some((b) => b.id === t.id));
  must(Boolean(historyTab), "the tab with chrome:// in its history is discoverable and currently on a safe URL");
  await call("browser_tab_select", { id: historyTab.id });

  let backBlocked = false;
  try {
    const r = await client.callTool({ name: "browser_back", arguments: {} });
    backBlocked = r.isError === true;
  } catch {
    backBlocked = true;
  }
  must(backBlocked, "browser_back is refused when it would land on a blocked scheme, even though the tab's CURRENT url was safe at selection time");

  // The failed browser_back call above was a real Playwright navigation —
  // the active tab is now GENUINELY sitting on chrome://version/ (only the
  // tool result was blocked, not the browser action itself). This is the
  // scenario the choke point (getActivePage()) must cover: every OTHER read
  // tool must also refuse while stuck here, and only browser_navigate must
  // be able to escape it.
  let snapshotBlockedWhileStuck = false;
  try {
    const r = await client.callTool({ name: "browser_snapshot", arguments: {} });
    snapshotBlockedWhileStuck = r.isError === true;
  } catch {
    snapshotBlockedWhileStuck = true;
  }
  must(snapshotBlockedWhileStuck, "browser_snapshot is refused while the active tab is genuinely stuck on a blocked scheme (not just the tool that caused it)");

  let domQueryBlockedWhileStuck = false;
  try {
    const r = await client.callTool({ name: "browser_dom_query", arguments: { selector: "body" } });
    domQueryBlockedWhileStuck = r.isError === true;
  } catch {
    domQueryBlockedWhileStuck = true;
  }
  must(domQueryBlockedWhileStuck, "browser_dom_query is also refused while stuck on a blocked scheme — the choke point covers other tools, not just the one that landed there");

  const escaped = await call("browser_navigate", { url: fixtureUrl });
  must(escaped.url === fixtureUrl, "browser_navigate is the one tool that CAN escape a tab stuck on a blocked scheme");

  await call("browser_tab_close", { id: historyTab.id });

  // Negative test: browser_tab_select itself must refuse to instrument a
  // discovered tab that is CURRENTLY sitting on a blocked scheme (opened via
  // Chrome's own CDP endpoint, bypassing our tools entirely).
  const tabsBeforeChromeTab = await call("browser_tabs_list");
  await fetch(`http://127.0.0.1:${PORT}/json/new?chrome://version/`, { method: "PUT" });
  await new Promise((r) => setTimeout(r, 500));
  const tabsWithChromeTab = await call("browser_tabs_list");
  const chromeTab = tabsWithChromeTab.find((t) => !tabsBeforeChromeTab.some((b) => b.id === t.id));
  must(Boolean(chromeTab), "a tab already on a chrome:// URL is discoverable");
  let selectBlocked = false;
  try {
    const r = await client.callTool({ name: "browser_tab_select", arguments: { id: chromeTab.id } });
    selectBlocked = r.isError === true;
  } catch {
    selectBlocked = true;
  }
  must(selectBlocked, "browser_tab_select refuses to instrument a tab currently on a blocked scheme");

  const detached = await call("browser_detach", {});
  must(detached.detached === true && detached.mode === "launch", "browser_detach disconnects and returns to launch mode");
} finally {
  await client.close();
}

// The critical safety property: the real Chrome process is STILL RUNNING
// after detach — detach must never kill the user's browser.
await new Promise((r) => setTimeout(r, 500));
const stillAlive = await new Promise((resolve) => {
  const check = spawn("powershell.exe", [
    "-NoProfile",
    "-Command",
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${chromeProc.pid}").ProcessId`,
  ]);
  let out = "";
  check.stdout.on("data", (d) => (out += d));
  check.on("exit", () => resolve(out.trim() === String(chromeProc.pid)));
});
must(stillAlive, "detach does NOT kill the real Chrome process — it is still running afterward");

// Cleanup: this is OUR scratch Chrome (never the user's), safe to kill directly.
await new Promise((resolve) => {
  const kill = spawn("powershell.exe", ["-NoProfile", "-Command", `Stop-Process -Id ${chromeProc.pid} -Force -ErrorAction SilentlyContinue`]);
  kill.on("exit", resolve);
});
await new Promise((r) => setTimeout(r, 2000)); // Chrome releases its profile dir lock asynchronously after the process exits
try {
  rmSync(SCRATCH_PROFILE, { recursive: true, force: true });
} catch (e) {
  console.log(`  (non-fatal: could not remove scratch profile dir, Chrome may still hold a lock: ${e.message})`);
}

console.log("\nALL ATTACH SMOKE TESTS PASSED");
