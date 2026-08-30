// Bridge to src/uia.ps1. One powershell.exe process per call (measured ~260ms
// startup incl. UIA assembly load — acceptable for a Tool call). No resident
// process, no Node-side element cache: UIA element handles can't cross
// process boundaries, so every element is addressed by a re-resolvable
// path-based `ref` string that uia.ps1 walks fresh each call.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "uia.ps1");
const DEFAULT_TIMEOUT_MS = 10000;

// A hung UIA cross-process call must never hang the whole MCP server —
// this is the single most likely real failure mode (a target app that
// stopped responding). Always kill on timeout.
export function callUia(request, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
      { windowsHide: true }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`uia.ps1 timed out after ${timeoutMs}ms (action: ${request.action})`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(new Error(`uia.ps1 produced non-JSON output: ${stdout.slice(0, 500)} | stderr: ${stderr.slice(0, 500)}`));
        return;
      }
      if (parsed.ok) resolve(parsed.data);
      else reject(new Error(parsed.error || "uia.ps1 reported an error with no message"));
    });

    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  });
}
