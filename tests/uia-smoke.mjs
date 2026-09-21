// Real Windows UI Automation / Desktop E2E.
//
// This test owns its GUI fixture. It deliberately does NOT kill or reuse the
// user's Notepad processes: modern Notepad can redirect through a packaged
// host and share process/window lifecycle across instances, which made the old
// smoke test both flaky and unsafe for contributors. The owned WPF
// fixture still exercises real UIA, HWND/PID ownership, real SendInput,
// foreground focus, stale-path recovery, screenshots, launch/kill, and close.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { spawn } from "node:child_process";

if (process.platform !== "win32") {
  console.log("SKIP: uia-smoke.mjs only runs on Windows");
  process.exit(0);
}

const root = path.resolve(import.meta.dirname, "..");
const fixtureScript = path.join(root, "tests", "fixtures", "windows-uia-fixture.ps1");
const title = "OpenCodeCU-E2E-" + process.pid + "-" + Date.now();

function must(condition, message) {
  if (!condition) throw new Error("FAIL: " + message);
  console.log("PASS:", message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function callPowershellRaw(command) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (data) => (out += data));
    child.stderr.on("data", (data) => (err += data));
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(err || out))));
  });
}

async function processAlive(pid) {
  const out = await callPowershellRaw(
    "$p = Get-Process -Id " + Number(pid) + " -ErrorAction SilentlyContinue; if ($p) { 'yes' } else { 'no' }"
  );
  return out.trim() === "yes";
}

async function forceOwnedWindowTopmost(hwnd) {
  const numericHwnd = Number(hwnd);
  if (!Number.isFinite(numericHwnd) || numericHwnd <= 0) {
    throw new Error("invalid fixture hwnd: " + hwnd);
  }
  const script = [
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class FixtureWindowOrder {',
    '  [DllImport("user32.dll", SetLastError=true)]',
    '  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint flags);',
    '  [DllImport("user32.dll")]',
    '  public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '}',
    '"@',
    '$h = [IntPtr]' + numericHwnd,
    '$topmost = [IntPtr](-1)',
    '$SWP_NOSIZE = 0x0001',
    '$SWP_NOMOVE = 0x0002',
    '$SWP_SHOWWINDOW = 0x0040',
    'if (-not [FixtureWindowOrder]::SetWindowPos($h, $topmost, 0, 0, 0, 0, $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_SHOWWINDOW)) { throw "SetWindowPos failed" }',
    '[void][FixtureWindowOrder]::SetForegroundWindow($h)',
  ].join("\n");
  await callPowershellRaw(script);
}

async function waitUntil(fn, description, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error("timeout waiting for " + description + (lastError ? ": " + lastError.message : ""));
}

async function expectToolError(client, name, args) {
  try {
    const result = await client.callTool({ name, arguments: args });
    return result.isError === true;
  } catch {
    return true;
  }
}

const fixture = spawn(
  "powershell.exe",
  ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", fixtureScript, "-Title", title],
  { stdio: "ignore", windowsHide: false }
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src", "server.js")],
  env: { OPENCODE_CU_WINDOW_ALLOWLIST: "powershell.exe" },
});
const client = new Client({ name: "uia-smoke-test", version: "0.1.0" });
await client.connect(transport);
const call = async (name, args = {}) =>
  JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

try {
  const testWindow = await waitUntil(async () => {
    const windows = await call("windows_list");
    return windows.find((win) => win.name === title && win.processId === fixture.pid) || null;
  }, "owned WPF fixture window");
  must(testWindow.processName.toLowerCase() === "powershell.exe", "windows_list finds the owned fixture and real process owner");
  const hwnd = testWindow.ref.split("|")[0];

  const tree = await call("windows_tree", { ref: testWindow.ref, maxDepth: 6, maxNodes: 300 });
  const editor = tree.elements.find(
    (element) => element.name === "Main editor" || String(element.className).includes(".EDIT.")
  );
  const reparentButton = tree.elements.find(
    (element) => element.automationId === "ReparentButton" || element.name === "Reparent editor"
  );
  must(Boolean(editor), "windows_tree finds the real editable control");
  must(Boolean(reparentButton), "windows_tree finds the real reparent button");

  const setResult = await call("windows_set_value", { ref: editor.ref, value: "uia smoke test 12345" });
  must(
    setResult.value === "uia smoke test 12345",
    "windows_set_value waits for and returns the observable post-set value"
  );
  const getResult = await call("windows_get_value", { ref: editor.ref });
  must(getResult.value === "uia smoke test 12345", "windows_get_value independently re-confirms real UIA state");

  // Default policy is deny-all. Start a second MCP child with no process
  // allowlist and prove both semantic and coordinate mutation fail before a
  // side effect against this same real window.
  const denyTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "src", "server.js")],
  });
  const denyClient = new Client({ name: "uia-deny-default-test", version: "0.1.0" });
  await denyClient.connect(denyTransport);
  try {
    must(
      await expectToolError(denyClient, "windows_set_value", { ref: editor.ref, value: "must-not-land" }),
      "deny-by-default blocks semantic UIA mutation without an explicit process allowlist"
    );
    const ex = Math.round(editor.bounds.x + editor.bounds.width / 2);
    const ey = Math.round(editor.bounds.y + editor.bounds.height / 2);
    must(
      await expectToolError(denyClient, "desktop_click", { x: ex, y: ey }),
      "deny-by-default blocks coordinate mutation without an explicit process allowlist"
    );
    const unchanged = await call("windows_get_value", { ref: editor.ref });
    must(unchanged.value === "uia smoke test 12345", "denied mutations leave the real control unchanged");
  } finally {
    await denyClient.close();
  }

  // Force the editor to move to a different UIA tree path. The old ref should
  // not be blindly trusted and should not require a test retry: the server
  // re-resolves the previously observed semantic descriptor only inside the
  // same original HWND/PID.
  await call("windows_invoke", { ref: reparentButton.ref });
  const resolvedAfterReparent = await waitUntil(async () => {
    const current = await call("windows_get_value", { ref: editor.ref });
    const b = current?.bounds;
    const visibleBounds =
      b &&
      Number.isFinite(b.x) &&
      Number.isFinite(b.y) &&
      Number.isFinite(b.width) &&
      Number.isFinite(b.height) &&
      b.width > 1 &&
      b.height > 1;
    return current.ref !== editor.ref && visibleBounds ? current : null;
  }, "reparented editor to expose a new ref with stable visible bounds");
  must(
    resolvedAfterReparent.value === "uia smoke test 12345",
    "a stale UIA child path is semantically re-resolved within the original HWND/PID"
  );
  must(
    resolvedAfterReparent.ref !== editor.ref,
    "reparenting actually changed the UIA ref, so stale-path recovery was exercised rather than assumed"
  );

  const freshEditor = resolvedAfterReparent;
  const cx = Math.round(freshEditor.bounds.x + freshEditor.bounds.width / 2);
  const cy = Math.round(freshEditor.bounds.y + freshEditor.bounds.height / 2);
  await forceOwnedWindowTopmost(hwnd);
  const preClickTarget = await call("desktop_annotate_point", { x: cx, y: cy });
  must(
    preClickTarget.processId === fixture.pid,
    "raw-coordinate precondition confirms the owned fixture is actually visible at the target point"
  );
  const clickResult = await call("desktop_click", { x: cx, y: cy });
  must(
    clickResult.processId === fixture.pid,
    "desktop_click verifies the intended fixture process owns foreground focus after SendInput"
  );
  const focusResult = await call("windows_focus", { ref: freshEditor.ref });
  must(
    focusResult.hasKeyboardFocus === true,
    "windows_focus confirms the intended control owns keyboard focus inside the foreground process"
  );
  const typed = await call("desktop_type_text", { text: " typed-via-sendinput-こんにちは" });
  must(
    typed.foregroundPid === fixture.pid,
    "desktop_type_text verifies foreground process ownership before and after batched SendInput"
  );
  const afterType = await waitUntil(async () => {
    const current = await call("windows_get_value", { ref: freshEditor.ref });
    return current.value?.includes("typed-via-sendinput-こんにちは") ? current : null;
  }, "raw SendInput text to become observable through an independent UIA read");
  must(
    afterType.value.includes("typed-via-sendinput-こんにちは"),
    "raw keyboard fallback changes the real control and is verified through UIA"
  );

  const annotated = await call("desktop_annotate_point", { x: cx, y: cy });
  must(annotated.processId === fixture.pid, "desktop_annotate_point resolves the real element under the screen point");
  must(typeof annotated.ref === "string" && annotated.ref.length > 0, "desktop_annotate_point returns a reusable ref");

  const windowShot = await call("desktop_screenshot", { ref: testWindow.ref });
  must(typeof windowShot.path === "string" && windowShot.path.endsWith(".png"), "desktop_screenshot captures the real fixture window");

  const groundTruthOrigin = JSON.parse(
    (
      await callPowershellRaw(
        "Add-Type -AssemblyName System.Windows.Forms; $vs=[System.Windows.Forms.SystemInformation]::VirtualScreen; @{x=$vs.X;y=$vs.Y}|ConvertTo-Json -Compress"
      )
    ).trim()
  );
  const fullShot = await call("desktop_screenshot", {});
  must(
    fullShot.x === groundTruthOrigin.x && fullShot.y === groundTruthOrigin.y,
    "fullscreen screenshot reports the independently measured virtual-screen origin"
  );
  const imagePixelX = cx - fullShot.x;
  const imagePixelY = cy - fullShot.y;
  must(
    imagePixelX >= 0 && imagePixelX < fullShot.width && imagePixelY >= 0 && imagePixelY < fullShot.height,
    "UIA screen coordinates map inside the reported screenshot coordinate space"
  );

  const appContext = await call("desktop_app_context");
  must(
    Number.isInteger(appContext.processId) && appContext.processId > 0 && typeof appContext.processName === "string",
    "desktop_app_context observes a real foreground process rather than assuming the fixture still owns focus"
  );
  must(typeof appContext.screenshotPath === "string", "desktop_app_context includes an actual screenshot path");

  must(
    await expectToolError(client, "windows_get_value", { ref: hwnd + "|999999|" }),
    "a ref with a mismatched PID is rejected as stale instead of following HWND reuse"
  );
  must(
    await expectToolError(client, "desktop_kill_process", { pid: process.pid }),
    "desktop_kill_process refuses the MCP parent/self safety boundary"
  );

  const launched = await call("desktop_launch_app", {
    path: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60"],
  });
  must(typeof launched.pid === "number", "desktop_launch_app returns the real owned helper PID");
  must(await waitUntil(() => processAlive(launched.pid), "launched helper process"), "launched helper process really exists");
  await call("desktop_kill_process", { pid: launched.pid });
  await waitUntil(async () => !(await processAlive(launched.pid)), "helper process termination");
  must(!(await processAlive(launched.pid)), "desktop_kill_process is verified by actual process disappearance");

  await call("desktop_close_window", { ref: testWindow.ref });
  await waitUntil(async () => {
    const windows = await call("windows_list");
    return !windows.some((win) => win.name === title && win.processId === fixture.pid);
  }, "fixture window close");
  must(true, "desktop_close_window is verified by actual window disappearance");
} finally {
  await client.close().catch(() => {});
  if (await processAlive(fixture.pid).catch(() => false)) {
    await callPowershellRaw("Stop-Process -Id " + fixture.pid + " -Force -ErrorAction SilentlyContinue").catch(() => {});
  }
}

console.log("\nALL UIA/DESKTOP E2E TESTS PASSED");
