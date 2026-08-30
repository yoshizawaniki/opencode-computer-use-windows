// Record & Replay. Scope decision (documented, not a silent substitution):
// this records ACTIONS PERFORMED THROUGH THIS MCP SERVER'S TOOLS — every
// mutating tool call already carries semantic target info (a browser ref
// resolves to role+name via snapshot.js; a windows ref resolves to
// automationId/name/controlType/processName via UIA) precisely BECAUSE it
// went through observedState()/mutatingCall(). Raw OS-level input-hook
// recording of a human independently driving the mouse/keyboard (outside
// any tool call) is NOT implemented: for Windows that means a resident,
// global-hook process for the life of a recording session — exactly the
// class of long-lived subprocess whose lifecycle bugs Phase 0-5 spent
// several audit rounds eliminating for the FAR simpler per-call uia.ps1
// model. Recording at the tool-call layer gets the same practical result
// (a replayable, parameterizable workflow) without reintroducing that risk,
// and is inherently "semantic" rather than coordinate-based — refs are
// translated to role/name (browser) or automationId/name/controlType
// (windows) at record time specifically so replay doesn't depend on a
// stale ref. This tradeoff was flagged to commander rather than assumed.
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getHandler } from "./tool-registry.js";
import { elementInfoFor, resolveRefByDescriptor } from "./snapshot.js";
import { callUia } from "./uia.js";
import { SENSITIVE_NAME_PATTERN, SPLIT_PATTERN_SOURCE, splitIdentifierWords } from "./redaction.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.join(ROOT, "..", "artifacts", "workflows");
const SENSITIVE_RE = new RegExp(SENSITIVE_NAME_PATTERN, "i");

// Tools it's never useful to replay (pure reads, or the workflow_* tools
// themselves — recording a workflow while recording it is nonsensical).
const EXCLUDE_FROM_RECORDING = new Set([
  "browser_snapshot",
  "browser_tabs_list",
  "browser_last_dialog",
  "browser_screenshot",
  "browser_screenshot_region",
  "windows_list",
  "windows_active",
  "windows_tree",
  "windows_find",
  "windows_wait_for",
  "windows_get_value",
  "desktop_app_context",
  "desktop_screenshot",
  "desktop_screenshot_region",
]);

// ref-bearing args, per tool, that need translating to a semantic
// descriptor at record time (browser: role+name; windows: UIA descriptor).
const BROWSER_REF_TOOLS = new Set([
  "browser_click", "browser_type", "browser_secret_fill", "browser_select",
  "browser_hover", "browser_upload", "browser_click_and_wait_for_download",
]);
const WINDOWS_REF_TOOLS = new Set([
  "windows_set_value", "windows_invoke", "windows_toggle", "windows_select", "windows_focus",
]);

let recording = null; // { name, steps: [] } | null

export function isRecording() {
  return recording !== null;
}

export function startRecording(name) {
  if (recording) throw new Error(`already recording "${recording.name}" — call workflow_record_stop first`);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("workflow name must match [A-Za-z0-9_-]+");
  recording = { name, steps: [] };
}

function isSensitiveTarget(role, name) {
  return SENSITIVE_RE.test(splitIdentifierWords(name)) || SENSITIVE_RE.test(splitIdentifierWords(role));
}

// Captures the CURRENT (pre-mutation) semantic info for a browser ref, if
// relevant — must be called BEFORE the tool handler runs, because the
// handler's own re-snapshot (observedState()) overwrites snapshot.js's
// role/name cache with POST-action state, and a click can change the very
// name (e.g. "Go" -> "Clicked!") this lookup needs. Cheap/sync, so the
// wrapper in server.js can call it unconditionally without extra latency.
export function captureBrowserTarget(toolName, args) {
  if (!recording || !BROWSER_REF_TOOLS.has(toolName) || !args?.ref) return null;
  return elementInfoFor(args.ref);
}

// Called from server.js's tool wrapper for every non-excluded tool call
// while a recording is active, with the pre-captured browser target (or
// null for a non-browser/non-ref tool) from captureBrowserTarget() above.
// Never throws — a recording hiccup must not break the underlying tool
// call it's observing.
export async function recordStep(toolName, args, preCapturedBrowserInfo) {
  if (!recording || EXCLUDE_FROM_RECORDING.has(toolName) || toolName.startsWith("workflow_")) return;
  try {
    const step = { tool: toolName, args: { ...args } };

    if (BROWSER_REF_TOOLS.has(toolName) && args.ref) {
      const info = preCapturedBrowserInfo;
      if (info) {
        step.target = { kind: "browser", role: info.role, name: info.name };
        delete step.args.ref;
      }
      // design doc: secret input values must never be saved in plaintext.
      // browser_secret_fill already stores a secret NAME, never a value —
      // nothing to redact there. browser_type on a sensitive-named/typed
      // field is the risk: force it out at record time, not at review time.
      if (toolName === "browser_type" && info?.sensitive) {
        step.args.text = "<omitted: sensitive field — replace with a browser_secret_fill step before replay>";
        step.requiresManualEdit = true;
      }
    }

    if (WINDOWS_REF_TOOLS.has(toolName) && args.ref) {
      const el = await callUia({ action: "get_value", ref: args.ref }).catch(() => null);
      if (el) {
        // windows_find (used at replay time) needs a top-level WINDOW ref to
        // search under, not the element's own ref — derived from the same
        // hwnd|pid, empty path (see uia.ps1 Make-Ref/Resolve-Ref). If the
        // app has restarted by replay time this hwnd is stale; Resolve-Ref
        // reports that clearly rather than silently resolving to the wrong
        // window, so replay just fails loudly on that step (re-record or
        // hand-edit windowRef, no auto-recovery attempted here).
        const [hwnd, pid] = args.ref.split("|");
        step.target = {
          kind: "windows",
          windowRef: `${hwnd}|${pid}|`,
          automationId: el.automationId || null,
          name: el.name || null,
          controlType: el.controlType || null,
          processName: el.processName || null,
        };
        delete step.args.ref;
        if (toolName === "windows_set_value" && (el.isPassword || isSensitiveTarget(el.controlType, el.name))) {
          step.args.value = "<omitted: sensitive field — replace with a desktop_secret_type step before replay>";
          step.requiresManualEdit = true;
        }
      }
    }

    recording.steps.push(step);
  } catch {
    // best-effort; recording must never break the tool call it's observing
  }
}

export function stopRecording() {
  if (!recording) throw new Error("not currently recording");
  const { name, steps } = recording;
  recording = null;
  saveWorkflow(name, steps);
  return { name, stepCount: steps.length, requiresManualEdit: steps.some((s) => s.requiresManualEdit) };
}

export function discardRecording() {
  if (!recording) throw new Error("not currently recording");
  const { name, steps } = recording;
  recording = null;
  return { name, stepCount: steps.length, saved: false };
}

function workflowFile(name) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("workflow name must match [A-Za-z0-9_-]+");
  return path.join(WORKFLOW_DIR, `${name}.json`);
}

export function saveWorkflow(name, steps) {
  mkdirSync(WORKFLOW_DIR, { recursive: true });
  writeFileSync(workflowFile(name), JSON.stringify({ name, steps }, null, 2), "utf8");
}

export function loadWorkflow(name) {
  const file = workflowFile(name);
  if (!existsSync(file)) throw new Error(`no workflow named "${name}" (looked in ${WORKFLOW_DIR})`);
  return JSON.parse(readFileSync(file, "utf8"));
}

export function listWorkflows() {
  mkdirSync(WORKFLOW_DIR, { recursive: true });
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const wf = JSON.parse(readFileSync(path.join(WORKFLOW_DIR, f), "utf8"));
      return { name: wf.name, stepCount: wf.steps.length };
    });
}

export function deleteWorkflow(name) {
  const file = workflowFile(name);
  if (existsSync(file)) unlinkSync(file);
}

export function previewWorkflow(name) {
  const wf = loadWorkflow(name);
  const lines = wf.steps.map((s, i) => {
    const t = s.target ? ` on ${s.target.kind}[${s.target.role || s.target.controlType || ""} "${s.target.name || ""}"]` : "";
    const flag = s.requiresManualEdit ? "  ⚠ requires manual edit before replay" : "";
    return `${i + 1}. ${s.tool}${t} ${JSON.stringify(s.args)}${flag}`;
  });
  return { name: wf.name, stepCount: wf.steps.length, text: lines.join("\n"), steps: wf.steps };
}

// Overwrites a workflow's saved JSON after validation — the "edit" and
// "parameterize" step: parameterizing is just replacing a literal arg value
// with "${paramName}" via this same edit path, no dedicated tool needed.
export function editWorkflow(name, stepsJson) {
  let steps;
  try {
    steps = JSON.parse(stepsJson);
  } catch (e) {
    throw new Error(`invalid JSON: ${e.message}`);
  }
  if (!Array.isArray(steps)) throw new Error("steps must be a JSON array");
  for (const s of steps) {
    if (!s.tool || typeof s.tool !== "string") throw new Error(`each step needs a "tool" string: ${JSON.stringify(s)}`);
  }
  saveWorkflow(name, steps);
  return { name, stepCount: steps.length };
}

function substituteParams(value, params) {
  if (typeof value === "string") {
    const m = value.match(/^\$\{(\w+)\}$/);
    if (m) {
      if (!(m[1] in params)) throw new Error(`workflow requires parameter "${m[1]}" (not provided)`);
      return params[m[1]];
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => substituteParams(v, params));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteParams(v, params)]));
  return value;
}

// Replays a saved workflow step by step, re-resolving each target
// descriptor against CURRENT page/window state (never reusing an old ref),
// substituting ${param} placeholders, and dispatching through the same
// handler the real MCP tool call would use (tool-registry.js). Each step's
// actual result is collected — replay reports what really happened, not
// just "ran all N steps".
export async function replayWorkflow(name, params = {}) {
  const wf = loadWorkflow(name);
  const results = [];
  for (const [i, step] of wf.steps.entries()) {
    if (step.requiresManualEdit) {
      throw new Error(`step ${i + 1} (${step.tool}) still needs manual edit (sensitive value was omitted at record time) — edit the workflow before replay`);
    }
    const args = substituteParams({ ...step.args }, params);

    if (step.target?.kind === "browser") {
      args.ref = resolveRefByDescriptor({ role: step.target.role, name: step.target.name });
    } else if (step.target?.kind === "windows") {
      const found = await getHandler("windows_find").call(null, {
        ref: step.target.windowRef,
        automationId: step.target.automationId || undefined,
        name: step.target.name || undefined,
        controlType: step.target.controlType || undefined,
        limit: 5,
      });
      // windows_find returns an MCP {content:[{text}]} result; unwrap it —
      // replay dispatches through the same handler map real tool calls use.
      const parsed = JSON.parse(found.content[0].text);
      const matches = parsed.elements || parsed;
      if (!Array.isArray(matches) || matches.length !== 1) {
        throw new Error(`step ${i + 1}: expected exactly 1 window match for target, got ${Array.isArray(matches) ? matches.length : "?"}`);
      }
      args.ref = matches[0].ref;
    }

    const handler = getHandler(step.tool);
    const raw = await handler(args);
    let parsed;
    try {
      parsed = JSON.parse(raw.content[0].text);
    } catch {
      parsed = raw.content[0].text;
    }
    results.push({ step: i + 1, tool: step.tool, result: parsed });

    if (step.expect?.textContains) {
      const hay = JSON.stringify(parsed);
      if (!hay.includes(step.expect.textContains)) {
        throw new Error(`step ${i + 1} (${step.tool}) verification failed: expected result to contain "${step.expect.textContains}"`);
      }
    }
  }
  return { name, steps: results };
}
