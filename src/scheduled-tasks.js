// Windows Task Scheduler integration (schtasks). Registers a task that
// launches scripts/run-scheduled-task.ps1 -TaskId <name>, which itself
// invokes `opencode run` non-interactively. Confirmed by measurement (see
// PERMISSION_COVERAGE.md): a non-interactive `opencode run` auto-REJECTS
// any ask-gated tool call, so the existing config permission already
// enforces "same rules as normal execution" for the one risk that matters
// here — no separate unattended-mode guard was needed.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TASKS_DIR = path.join(ROOT, "artifacts", "tasks");
const WRAPPER = path.join(ROOT, "scripts", "run-scheduled-task.ps1");

// Namespaced so this tool can only ever touch tasks IT created — schtasks
// /Create is called without /F (never overwrites), and delete/list are
// hard-scoped to this prefix so a crafted name can't target an unrelated
// scheduled task already on the system.
const NAME_PREFIX = "OpenCodeComputerUse-";
const LEGACY_NAME_PREFIX = "OpenCodeUpgrade-";

function assertValidName(name, { allowLegacy = false } = {}) {
  const validPrefix = name.startsWith(NAME_PREFIX) || (allowLegacy && name.startsWith(LEGACY_NAME_PREFIX));
  if (!validPrefix || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(
      `scheduled task name must start with "${NAME_PREFIX}"` +
        (allowLegacy ? ` (legacy "${LEGACY_NAME_PREFIX}" is accepted for cleanup only)` : "") +
        ` and match [A-Za-z0-9_-]+, got "${name}"`
    );
  }
}

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout || `exit ${code}`))));
  });
}

export async function registerScheduledTask({ name, prompt, model, schedule }) {
  assertValidName(name);
  if (prompt.length > 20_000) throw new Error("prompt too long (20000 char cap) — a scheduled task's prompt should be a concise instruction, not a document");

  mkdirSync(TASKS_DIR, { recursive: true });
  const promptFile = path.join(TASKS_DIR, `${name}.prompt.txt`);
  const metaFile = path.join(TASKS_DIR, `${name}.meta.json`);
  // Writing these before /Create would mean a
  // same-named EXISTING task's prompt got silently overwritten even when
  // /Create then failed (no /F, so the task itself wasn't touched, but its
  // scheduled behavior was — the caller only sees the /Create error and
  // has no idea the prompt file changed underneath it). Refuse up front
  // instead, and if /Create still fails for some other reason, remove what
  // we just wrote rather than leaving it orphaned.
  if (existsSync(promptFile) || existsSync(metaFile)) {
    throw new Error(`"${name}" already has saved prompt/meta files — delete it first (scheduled_task_delete) or choose a different name`);
  }
  writeFileSync(promptFile, prompt, "utf8");
  writeFileSync(metaFile, JSON.stringify({ model }, null, 2), "utf8");

  const scArgs = ["/Create", "/TN", name, "/TR", `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${WRAPPER}" -TaskId "${name}"`];
  if (schedule.type === "DAILY") {
    scArgs.push("/SC", "DAILY", "/ST", schedule.time);
  } else if (schedule.type === "HOURLY") {
    scArgs.push("/SC", "HOURLY", "/MO", String(schedule.intervalHours ?? 1));
  } else if (schedule.type === "ONCE") {
    scArgs.push("/SC", "ONCE", "/ST", schedule.time);
    if (schedule.date) scArgs.push("/SD", schedule.date);
  } else {
    unlinkSync(promptFile);
    unlinkSync(metaFile);
    throw new Error(`unknown schedule.type "${schedule.type}" (expected DAILY, HOURLY, or ONCE)`);
  }

  let output;
  try {
    output = await runCommand("schtasks.exe", scArgs);
  } catch (e) {
    unlinkSync(promptFile);
    unlinkSync(metaFile);
    throw e;
  }
  return { name, registered: true, schedule, schtasksOutput: output.trim() };
}

export async function listScheduledTasks() {
  let output;
  try {
    output = await runCommand("schtasks.exe", ["/Query", "/FO", "CSV", "/NH"]);
  } catch {
    return [];
  }
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.startsWith(`"\\${NAME_PREFIX}`) ||
        line.startsWith(`"${NAME_PREFIX}`) ||
        line.startsWith(`"\\${LEGACY_NAME_PREFIX}`) ||
        line.startsWith(`"${LEGACY_NAME_PREFIX}`)
    )
    .map((line) => {
      const cols = line.split('","').map((c) => c.replace(/^"|"$/g, ""));
      return { name: cols[0]?.replace(/^\\/, ""), nextRunTime: cols[1], status: cols[2] };
    });
}

export async function deleteScheduledTask(name) {
  // Cleanup compatibility only: tasks created by the pre-OSS private build
  // used OpenCodeUpgrade-. New registrations can never use that prefix.
  assertValidName(name, { allowLegacy: true });
  try {
    await runCommand("schtasks.exe", ["/Delete", "/TN", name, "/F"]);
  } finally {
    // Clean up the prompt/meta files regardless of whether the schtasks
    // entry itself existed — a failed prior /Create (bad schedule args,
    // etc.) can leave these orphaned with no scheduled task to delete.
    for (const suffix of [".prompt.txt", ".meta.json", ".status.json", ".debug.log", ".log"]) {
      const f = path.join(TASKS_DIR, `${name}${suffix}`);
      if (existsSync(f)) unlinkSync(f);
    }
  }
  return { name, deleted: true };
}
