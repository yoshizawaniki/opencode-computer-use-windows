// Secret Broker: resolves a secret registered via scripts/secret-cli.ps1 by
// name, checks it's bound to the caller's current scope (browser origin or
// desktop process name), and hands the value directly to the fill/type
// tool — never back to the LLM. The value is also registered with
// redaction.js so any later tool output that happens to echo it back
// (a read-back through snapshot/dom_query/OCR) gets scrubbed regardless of
// which tool produced it.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerSecretValue } from "./redaction.js";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "secret-resolve.ps1");

function secretResolveTimeoutMs() {
  const configured = Number(process.env.OPENCODE_CU_SECRET_RESOLVE_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured >= 1000 && configured <= 120000) return configured;
  // This is a process-health deadline, not a synchronization sleep. A warm
  // local resolve normally returns much faster, but hosted Windows runners
  // can spend >10s starting a nested Windows PowerShell process and loading
  // DPAPI assemblies under endpoint protection.
  return 30000;
}

function callSecretResolve(request, timeoutMs = secretResolveTimeoutMs()) {
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
      reject(new Error("secret-resolve.ps1 timed out"));
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
        reject(new Error(`secret-resolve.ps1 produced non-JSON output (stderr: ${stderr.slice(0, 300)})`));
        return;
      }
      resolve(parsed);
    });
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  });
}

export async function resolveSecret(name, currentScope) {
  const res = await callSecretResolve({ name });
  if (!res.ok) throw new Error(`secret "${name}": ${res.error}`);
  const { value, scope } = res.data;
  if (scope !== currentScope) {
    throw new Error(
      `secret "${name}" is registered for scope "${scope}", but the current target is "${currentScope}" — refusing`
    );
  }
  registerSecretValue(value);
  return value;
}
