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
  const r = await client.callTool({ name: "windows_get_value", arguments: { ref: "999999|0" } });
  staleRejected = r.isError === true;
} catch {
  staleRejected = true;
}
must(staleRejected, "windows_get_value on a nonexistent hwnd is reported as a real failure");

// desktop_* (Phase 4) tools are covered by tests/desktop-smoke.mjs once
// uia.ps1's Phase 4 actions exist.

await client.close();
await killAllNotepad();

console.log("\nALL UIA SMOKE TESTS PASSED");
