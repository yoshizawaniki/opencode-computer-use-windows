// Real DPAPI round-trip test for the Secret Broker: register (via the CLI
// script, non-interactively) -> resolve with matching scope succeeds and the
// value is registered for output scrubbing -> resolve with a mismatched
// scope is refused -> the resolved value never appears verbatim in a
// scrubbed MCP tool result. Windows-only (DPAPI); skips elsewhere.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { resolveSecret } from "../src/secret-broker.js";
import { scrubKnownSecrets } from "../src/redaction.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

if (process.platform !== "win32") {
  console.log("SKIP secret-broker.test.mjs (Windows-only, DPAPI)");
  process.exit(0);
}

let passed = 0;
function must(cond, msg) {
  assert.ok(cond, msg);
  passed++;
  console.log(`PASS ${msg}`);
}

function runCli(args, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "scripts", "secret-cli.ps1"), ...args],
      { cwd: ROOT }
    );
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(err || out))));
    if (stdinText !== undefined) child.stdin.write(stdinText + "\n");
    child.stdin.end();
  });
}

const SECRET_VALUE = "AutomatedTestSecretValue789";

await runCli(["-Action", "register", "-Name", "oc-test-secret", "-Scope", "https://example.com"], SECRET_VALUE);
await runCli(["-Action", "register", "-Name", "oc-test-secret-desktop", "-Scope", "notepad.exe"], SECRET_VALUE);

try {
  // matching scope resolves
  const value = await resolveSecret("oc-test-secret", "https://example.com");
  must(value === SECRET_VALUE, "resolveSecret returns the exact registered value when scope matches");

  // mismatched scope is refused
  let threw = false;
  try {
    await resolveSecret("oc-test-secret", "https://evil.example.com");
  } catch (e) {
    threw = true;
    must(/refusing|scope/.test(e.message), "scope-mismatch error message explains the refusal");
  }
  must(threw, "resolveSecret refuses when the current scope doesn't match the registered scope");

  // unknown name is refused
  let threw2 = false;
  try {
    await resolveSecret("oc-test-secret-does-not-exist", "https://example.com");
  } catch {
    threw2 = true;
  }
  must(threw2, "resolveSecret refuses an unregistered name");

  // value-based scrubbing: after resolution, the value is scrubbed from ANY
  // tool result text, even one that never called secret-broker.js itself —
  // this is the exact class of leak the independent Phase 0-5 audit found
  // in snapshot.js, now covered generically at the server.js choke point.
  const fakeToolResult = { content: [{ type: "text", text: `some unrelated tool happened to echo: ${SECRET_VALUE}` }] };
  const scrubbed = scrubKnownSecrets(fakeToolResult);
  must(!JSON.stringify(scrubbed).includes(SECRET_VALUE), "scrubKnownSecrets removes a resolved secret value from arbitrary tool output");
  must(JSON.stringify(scrubbed).includes("<redacted-secret>"), "scrubKnownSecrets leaves a visible redaction marker in its place");
} finally {
  await runCli(["-Action", "remove", "-Name", "oc-test-secret"]);
  await runCli(["-Action", "remove", "-Name", "oc-test-secret-desktop"]);
}

console.log(`\n${passed} secret-broker assertions passed`);
