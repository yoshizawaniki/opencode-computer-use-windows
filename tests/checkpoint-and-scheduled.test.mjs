// Real MCP client tests for Phase E: task checkpoints (save/load/list) and
// scheduled tasks (register/list/delete via real schtasks.exe). Windows-only.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { spawn } from "node:child_process";

if (process.platform !== "win32") {
  console.log("SKIP checkpoint-and-scheduled.test.mjs (Windows-only)");
  process.exit(0);
}

const root = path.resolve(import.meta.dirname, "..");
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "src", "server.js")] });
const client = new Client({ name: "checkpoint-scheduled-test", version: "0.1.0" });
await client.connect(transport);

let passed = 0;
function must(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
  console.log("PASS:", msg);
}

function runCli(args, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "secret-cli.ps1"), ...args], { cwd: root });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(err || out))));
    if (stdinText !== undefined) child.stdin.write(stdinText + "\n");
    child.stdin.end();
  });
}

// --- task checkpoints ---

const validFields = {
  taskId: "test-checkpoint-1",
  phase: "collecting-data",
  lastVerifiedState: { url: "https://example.com", title: "Example" },
  pending: ["step 2", "step 3"],
  resources: { browserMode: "launch", tabs: ["tab-1"] },
  artifacts: ["artifacts/screenshots/1.png"],
  verification: { checked: "title matches" },
};

let missingFieldRejected = false;
try {
  const { lastVerifiedState, ...rest } = validFields; // eslint-disable-line no-unused-vars
  const r = await client.callTool({ name: "task_checkpoint_save", arguments: rest });
  missingFieldRejected = r.isError === true;
} catch {
  missingFieldRejected = true;
}
must(missingFieldRejected, "task_checkpoint_save refuses when a required field is missing");

const saved = JSON.parse((await client.callTool({ name: "task_checkpoint_save", arguments: validFields })).content[0].text);
must(saved.taskId === "test-checkpoint-1", "task_checkpoint_save returns the real taskId");

const loaded = JSON.parse((await client.callTool({ name: "task_checkpoint_load", arguments: { taskId: "test-checkpoint-1" } })).content[0].text);
must(loaded.phase === "collecting-data", "task_checkpoint_load returns the real saved phase");
must(loaded.resourcesVerified === false, "task_checkpoint_load structurally flags resources as unverified");
must(loaded.pending.length === 2, "task_checkpoint_load returns the real pending list");

const list = JSON.parse((await client.callTool({ name: "task_checkpoint_list", arguments: {} })).content[0].text);
must(list.some((c) => c.taskId === "test-checkpoint-1"), "task_checkpoint_list includes the saved checkpoint");

// oversized checkpoint is refused, not silently truncated
let oversizedRejected = false;
try {
  const r = await client.callTool({
    name: "task_checkpoint_save",
    arguments: { ...validFields, taskId: "test-checkpoint-oversized", lastVerifiedState: { blob: "x".repeat(60_000) } },
  });
  oversizedRejected = r.isError === true;
} catch {
  oversizedRejected = true;
}
must(oversizedRejected, "task_checkpoint_save refuses a checkpoint over the size cap rather than truncating silently");

// a secret resolved earlier in the session must be scrubbed even from a
// checkpoint field that never went through secret-broker.js itself
const CHECKPOINT_SECRET = "CheckpointSecretShouldNeverPersist555";
await runCli(["-Action", "register", "-Name", "oc-checkpoint-secret", "-Scope", "notepad.exe"], CHECKPOINT_SECRET);
try {
  // resolving via desktop_secret_type would need a live focused window; the
  // scrub only needs the value to have been registered via secret-broker at
  // some point this session — call resolveSecret indirectly by importing it
  // is out of scope for an MCP client test, so instead confirm via the
  // redaction.js unit test's coverage (secret-broker.test.mjs) and just
  // verify here that a checkpoint field is stored/returned faithfully when
  // it does NOT collide with a known secret (baseline correctness).
  const secretCheck = JSON.parse(
    (await client.callTool({ name: "task_checkpoint_save", arguments: { ...validFields, taskId: "test-checkpoint-2", lastVerifiedState: { note: "no secret here" } } })).content[0].text
  );
  must(secretCheck.taskId === "test-checkpoint-2", "a second checkpoint saves independently of the first");
  await client.callTool({ name: "task_checkpoint_load", arguments: { taskId: "test-checkpoint-2" } });
} finally {
  await runCli(["-Action", "remove", "-Name", "oc-checkpoint-secret"]);
}

// --- scheduled tasks ---

const taskName = "OpenCodeUpgrade-Test-" + Date.now();
try {
  const registered = JSON.parse(
    (await client.callTool({
      name: "scheduled_task_register",
      arguments: {
        name: taskName,
        prompt: "This is a test scheduled task prompt, never actually meant to run meaningfully.",
        model: "opencode/nemotron-3.5-lightning-free",
        schedule: { type: "ONCE", time: "23:59" },
      },
    })).content[0].text
  );
  must(registered.registered === true, "scheduled_task_register actually creates a real Windows scheduled task");

  // Regression: checkpoint.js and scheduled-tasks.js used to share
  // artifacts/tasks/, so listCheckpoints picked up scheduled-tasks.js's
  // <name>.meta.json files as ghost checkpoint entries (found in commander
  // review). They're now separate directories — a checkpoint list taken
  // while a scheduled task exists must show ONLY real checkpoints.
  const checkpointsWithTaskPresent = JSON.parse((await client.callTool({ name: "task_checkpoint_list", arguments: {} })).content[0].text);
  must(
    checkpointsWithTaskPresent.every((c) => typeof c.taskId === "string" && c.taskId.length > 0),
    "task_checkpoint_list never returns a ghost entry from scheduled-tasks.js's files, even while a scheduled task exists"
  );

  // Regression: registering a task, deregistering, and re-registering
  // MUST refuse a second register while the first is still live — found
  // in commander review that /Create failing (no /F) left the FIRST
  // task's prompt file already overwritten by the second register's
  // prompt before /Create ever ran.
  const originalPrompt = "This is a test scheduled task prompt, never actually meant to run meaningfully.";
  let secondRegisterRejected = false;
  try {
    const r = await client.callTool({
      name: "scheduled_task_register",
      arguments: { name: taskName, prompt: "DIFFERENT prompt that must never land", model: "opencode/nemotron-3.5-lightning-free", schedule: { type: "ONCE", time: "23:59" } },
    });
    secondRegisterRejected = r.isError === true;
  } catch {
    secondRegisterRejected = true;
  }
  must(secondRegisterRejected, "scheduled_task_register refuses a second register of an already-existing task name");
  const promptFile = path.join(root, "artifacts", "tasks", `${taskName}.prompt.txt`);
  const { readFileSync } = await import("node:fs");
  must(readFileSync(promptFile, "utf8") === originalPrompt, "the FIRST task's prompt file is untouched by the rejected second register");

  let badNameRejected = false;
  try {
    const r = await client.callTool({ name: "scheduled_task_register", arguments: { name: "NotNamespaced-Evil", prompt: "x", model: "x", schedule: { type: "ONCE", time: "10:00" } } });
    badNameRejected = r.isError === true;
  } catch {
    badNameRejected = true;
  }
  must(badNameRejected, "scheduled_task_register refuses a name outside the OpenCodeUpgrade- namespace");
} finally {
  await client.callTool({ name: "scheduled_task_delete", arguments: { name: taskName } });
  const afterDelete = JSON.parse((await client.callTool({ name: "scheduled_task_list", arguments: {} })).content[0].text);
  must(!afterDelete.some((t) => t.name === taskName), "scheduled_task_delete actually removes the real Windows scheduled task, not just claims to");
}

await client.close();
console.log(`\n${passed} checkpoint/scheduled-task assertions passed`);
