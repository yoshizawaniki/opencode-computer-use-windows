// Bridge to src/clipboard.ps1. Same per-call spawn pattern as uia.js/
// secret-broker.js (no resident process, no cross-call state).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "clipboard.ps1");

export function callClipboard(request, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
      { windowsHide: true }
    );
    let stdout = "", stderr = "", settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("clipboard.ps1 timed out"));
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
        reject(new Error(`clipboard.ps1 produced non-JSON output: ${stdout.slice(0, 300)} | stderr: ${stderr.slice(0, 300)}`));
        return;
      }
      if (parsed.ok) resolve(parsed.data);
      else reject(new Error(parsed.error || "clipboard.ps1 reported an error with no message"));
    });
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  });
}
