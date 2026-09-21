// Task Persistence/Resume. Deliberately thin: this MCP server has no
// concept of "session" (that lives in OpenCode itself) and no automatic
// resume engine — it's a structured save/load of the fields the design doc
// lists (task ID, phase, last CONFIRMED state, pending items, resource
// identifiers, artifact refs, verification state), so an agent that gets
// interrupted can reconstruct context by reading one file instead of
// re-deriving everything from scratch.
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubKnownSecrets } from "./redaction.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Separate from artifacts/tasks/ (scheduled-tasks.js's directory) — found
// Keep checkpoints separate from scheduled-task metadata so listCheckpoints'
// ".json" filter also matched scheduled-tasks.js's <name>.meta.json files,
// producing ghost entries with no real checkpoint fields.
const CHECKPOINTS_DIR = path.join(ROOT, "..", "artifacts", "checkpoints");
const MAX_SERIALIZED_CHARS = 50_000; // fail loud rather than silently accept a dumped transcript

function checkpointFile(taskId) {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error("taskId must match [A-Za-z0-9_-]+");
  return path.join(CHECKPOINTS_DIR, `${taskId}.json`);
}

// Required fields enforce the design doc's list structurally — this is not
// a free-form blob a caller can stuff a chat transcript or secret into.
const REQUIRED_FIELDS = ["phase", "lastVerifiedState", "pending", "resources", "artifacts", "verification"];

export function saveCheckpoint(taskId, fields) {
  for (const f of REQUIRED_FIELDS) {
    // Check the VALUE, not just key presence: zod's z.any() (used for the
    // free-form fields) accepts a missing key as parsed-undefined, so an
    // omitted field can still show up as an own key with value undefined.
    if (fields[f] === undefined) throw new Error(`checkpoint missing required field "${f}"`);
  }
  const scrubbed = scrubKnownSecrets(fields);
  const record = { taskId, savedAt: new Date().toISOString(), ...scrubbed };
  const serialized = JSON.stringify(record, null, 2);
  if (serialized.length > MAX_SERIALIZED_CHARS) {
    throw new Error(
      `checkpoint for "${taskId}" is ${serialized.length} chars, over the ${MAX_SERIALIZED_CHARS}-char cap — ` +
        "this is a checkpoint of STATE (phase/pending/refs), not a transcript; trim it rather than raising the cap"
    );
  }
  mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  writeFileSync(checkpointFile(taskId), serialized, "utf8");
  return { taskId, savedAt: record.savedAt, sizeChars: serialized.length };
}

export function loadCheckpoint(taskId) {
  const file = checkpointFile(taskId);
  if (!existsSync(file)) throw new Error(`no checkpoint for task "${taskId}" (looked in ${CHECKPOINTS_DIR})`);
  const record = JSON.parse(readFileSync(file, "utf8"));
  // Structural warning, not just prose: a window handle/pid/tab id saved
  // here can be reused by an unrelated process/tab by the time this loads
  // (same class of staleness snapshot.js/uia.ps1 already guard against
  // live) — the resource identifiers are hints for WHERE to look, not
  // live refs. Every consumer of this checkpoint must re-verify (a fresh
  // browser_snapshot/windows_list/windows_find) before acting on them.
  return { ...record, resourcesVerified: false, resourcesNote: "resource identifiers are UNVERIFIED — re-observe before acting on any of them" };
}

export function listCheckpoints() {
  mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  const results = [];
  for (const f of readdirSync(CHECKPOINTS_DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const record = JSON.parse(readFileSync(path.join(CHECKPOINTS_DIR, f), "utf8"));
      results.push({ taskId: record.taskId, phase: record.phase, savedAt: record.savedAt, pendingCount: record.pending?.length ?? 0 });
    } catch {
      // one corrupt file must not take down the whole listing
    }
  }
  return results;
}
