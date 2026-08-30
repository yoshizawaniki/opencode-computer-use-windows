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
