// Windows UI Automation smoke test — drives real Notepad via the actual MCP
// server, same pattern as tests/smoke.mjs. Skips itself (exit 0) on non-Windows.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { spawn } from "node:child_process";

if (process.platform !== "win32") {
  console.log("SKIP: uia-smoke.mjs only runs on Windows");
  process.exit(0);
}

const root = path.resolve(import.meta.dirname, "..");

function must(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("PASS:", msg);
}

function launchNotepad() {
  return new Promise((resolve, reject) => {
    const p = spawn("notepad.exe", [], { detached: true, stdio: "ignore" });
    p.on("error", reject);
    p.unref();
    setTimeout(resolve, 1000);
  });
}

function killAllNotepad() {
  return new Promise((resolve) => {
    spawn("powershell.exe", ["-NoProfile", "-Command", "Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force"]).on(
      "exit",
      resolve
    );
  });
}

await killAllNotepad(); // clean slate
await launchNotepad();

const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "src", "server.js")] });
const client = new Client({ name: "uia-smoke-test", version: "0.1.0" });
await client.connect(transport);

const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const windows = await call("windows_list");
const notepad = windows.find((w) => w.processName.toLowerCase() === "notepad.exe");
must(Boolean(notepad), "windows_list finds the real running Notepad window");

const tree = await call("windows_tree", { ref: notepad.ref, maxDepth: 5 });
const editEl = tree.elements.find((e) => e.controlType === "Document" || e.controlType === "Edit");
must(Boolean(editEl), "windows_tree finds a real text-edit element in Notepad");

const setResult = await call("windows_set_value", { ref: editEl.ref, value: "uia smoke test 12345" });
must(setResult.value === "uia smoke test 12345", "windows_set_value returns the ACTUAL post-set value, got: " + setResult.value);

const getResult = await call("windows_get_value", { ref: editEl.ref });
must(getResult.value === "uia smoke test 12345", "windows_get_value re-confirms the real state, not a cached claim");

// Negative test: mutating a non-allowlisted process must be refused.
const explorer = windows.find((w) => w.processName.toLowerCase() === "explorer.exe");
must(Boolean(explorer), "a non-allowlisted window (explorer.exe) exists to test against");
let allowlistRejected = false;
try {
  const r = await client.callTool({ name: "windows_focus", arguments: { ref: explorer.ref } });
  allowlistRejected = r.isError === true;
} catch {
  allowlistRejected = true;
}
must(allowlistRejected, "windows_focus on a non-allowlisted process (explorer.exe) is refused, not silently performed");

// Negative test: a stale/nonexistent ref must fail, not silently succeed.
let staleRejected = false;
try {
  const r = await client.callTool({ name: "windows_get_value", arguments: { ref: "999999|1|0" } });
  staleRejected = r.isError === true;
} catch {
  staleRejected = true;
}
must(staleRejected, "windows_get_value on a nonexistent hwnd is reported as a real failure");

// --- Phase 4: desktop_* tools (screenshot / input / app lifecycle) -------

const desktopShot = await call("desktop_screenshot", { ref: notepad.ref });
must(typeof desktopShot.path === "string" && desktopShot.path.endsWith(".png"), "desktop_screenshot returns a real file path");

const ctx = await call("desktop_app_context");
must(typeof ctx.screenshotPath === "string", "desktop_app_context returns a real screenshot path alongside window info");

// Re-resolve fresh — a ref from many steps/seconds ago on a REAL, live
// desktop is not guaranteed to still be valid: HWNDs get reused once a
// window is destroyed, and this runs against the actual desktop (no
// sandboxed profile exists for native apps the way Playwright gives
// browsers one) with dozens of other real processes (observed: Firefox
// windows churning) causing hwnd reuse within fractions of a second. Retry
// the resolve step itself (not the focus-settle, which is now handled
// product-side in uia.ps1's 'focus' action, not by a test-side wait).
let candidate = null;
for (let attempt = 0; attempt < 3 && !candidate; attempt++) {
  const freshNotepad = (await call("windows_list")).find((w) => w.processName.toLowerCase() === "notepad.exe");
  if (!freshNotepad) continue;
  const freshTree = await call("windows_tree", { ref: freshNotepad.ref, maxDepth: 5 });
  const found = freshTree.elements.find((e) => e.controlType === "Document" || e.controlType === "Edit");
  if (!found) continue;
  const check = await call("windows_get_value", { ref: found.ref }).catch(() => null);
  if (check) candidate = found;
}
must(Boolean(candidate), "can resolve a live notepad edit-control ref (with retry for real-desktop hwnd churn)");

// IMPORTANT REAL FINDING: UIA's SetFocus() (windows_focus) does NOT reliably
// grant real OS-level foreground focus — Windows' foreground-lock security
// feature restricts background/non-interactive processes from stealing
// foreground via SetForegroundWindow-family APIs, which is what SetFocus
// uses under the hood. Observed directly: after windows_focus succeeded,
// desktop_type_text's own allowlist check found Firefox (unrelated, real
// user activity) still owned OS focus, and correctly refused rather than
// typing into the wrong window. desktop_click uses real SendInput mouse
// events, which Windows DOES treat as legitimate focus-changing input — so
// that is the reliable way to establish focus before raw keyboard input.
const cx = Math.round(candidate.bounds.x + candidate.bounds.width / 2);
const cy = Math.round(candidate.bounds.y + candidate.bounds.height / 2);
await call("desktop_click", { x: cx, y: cy });
// The focus-settle fix lives in uia.ps1's 'focus'/click paths (Start-Sleep
// after the focus-changing call). If that regresses, this immediate
// click-then-type sequence (no test-side wait) is what breaks.
await call("desktop_type_text", { text: " +typed via sendinput こんにちは" });
const afterType = await call("windows_get_value", { ref: candidate.ref });
must(
  afterType.value.includes("typed via sendinput こんにちは"),
  "desktop_type_text immediately after windows_focus (no test-side wait) lands correctly — proves the settle fix is in the product path, got: " +
    afterType.value
);

// Negative test: a ref whose hwnd is real but whose embedded pid doesn't
// match that window's CURRENT process must be rejected as stale, not
// silently resolved against whatever now owns that hwnd.
const [hwndPart] = notepad.ref.split("|");
const tamperedRef = `${hwndPart}|999999|`;
let staleRefRejected = false;
try {
  const r = await client.callTool({ name: "windows_get_value", arguments: { ref: tamperedRef } });
  staleRefRejected = r.isError === true;
} catch {
  staleRefRejected = true;
}
must(staleRefRejected, "a ref with a mismatched pid (simulating hwnd reuse) is rejected as stale, not silently resolved");

// Negative test: desktop_click on a non-allowlisted window's point must be refused.
const explorerBounds = explorer.bounds;
let clickRejected = false;
try {
  const r = await client.callTool({
    name: "desktop_click",
    arguments: { x: explorerBounds.x + 5, y: explorerBounds.y + 5 },
  });
  clickRejected = r.isError === true;
} catch {
  clickRejected = true;
}
must(clickRejected, "desktop_click on a non-allowlisted window's coordinates is refused");

// launch_app -> kill_process: full lifecycle with a REAL window, not a claim.
// KNOWN LIMITATION (found here, not assumed): on Windows 11, notepad.exe is
// a packaged-app redirector — Start-Process's returned pid is a short-lived
// stub, NOT the pid that actually owns the window. Worse: ALL Notepad
// windows in a session can share ONE host process, so kill_process on it
// closes every open Notepad window, not just the one you launched. We
// close out the earlier test window first so this sub-test is isolated and
// doesn't nuke unrelated windows; this same fact means callers should
// prefer desktop_close_window (a specific window) over desktop_kill_process
// for single-instance packaged apps in real use.
await killAllNotepad();
await new Promise((r) => setTimeout(r, 500));

const beforeLaunch = await call("windows_list");
const launched = await call("desktop_launch_app", { path: "notepad.exe" });
must(typeof launched.pid === "number", "desktop_launch_app returns a pid (may be a launcher stub for packaged apps — see comment above)");
await call("desktop_wait", { ms: 1500 });
const windowsAfterLaunch = await call("windows_list");
const newNotepadWindows = windowsAfterLaunch.filter(
  (w) => w.processName.toLowerCase() === "notepad.exe" && !beforeLaunch.some((b) => b.ref === w.ref)
);
must(newNotepadWindows.length > 0, "desktop_launch_app actually opens a new real Notepad window");
const realOwningPid = newNotepadWindows[0].processId;
await call("desktop_kill_process", { pid: realOwningPid });
await call("desktop_wait", { ms: 500 });
const windowsAfterKill = await call("windows_list");
must(
  !windowsAfterKill.some((w) => w.processName.toLowerCase() === "notepad.exe" && w.processId === realOwningPid),
  "desktop_kill_process actually terminates the process — its windows are gone, not just claimed dead"
);

await client.close();
await killAllNotepad();

console.log("\nALL UIA SMOKE TESTS PASSED");
