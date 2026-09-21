import { z } from "zod";
import { callUia } from "../uia.js";
import { assertProcessAllowed } from "../allowlist.js";

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

// UIA refs deliberately include hwnd+pid so HWND reuse fails closed, but
// their final ControlView child-index path can legitimately change when an
// app reflows/reparents controls. Cache only descriptors we actually
// observed, and use them to re-resolve inside the SAME hwnd+pid if a later
// read says the path is stale. We never jump to another window/process.
const refHints = new Map();

function rememberElement(el) {
  if (!el?.ref || typeof el.ref !== "string") return;
  const [hwnd, pid] = el.ref.split("|");
  if (!hwnd || !pid) return;
  refHints.set(el.ref, {
    windowRef: `${hwnd}|${pid}|`,
    automationId: el.automationId || undefined,
    name: el.name || undefined,
    controlType: el.controlType || undefined,
    className: el.className || undefined,
    processName: el.processName || undefined,
  });
}

function rememberResult(result) {
  if (Array.isArray(result)) result.forEach(rememberElement);
  else if (Array.isArray(result?.elements)) result.elements.forEach(rememberElement);
  else rememberElement(result);
  return result;
}

function matchesHint(element, hint) {
  if (!hint || !element) return true;
  if (hint.processName && element.processName !== hint.processName) return false;
  if (hint.automationId && element.automationId !== hint.automationId) return false;
  if (hint.name && element.name !== hint.name) return false;
  if (hint.controlType && element.controlType !== hint.controlType) return false;
  if (hint.className && element.className !== hint.className) return false;
  return true;
}

async function readRemembered(request) {
  return rememberResult(await callUia(request));
}

async function resolveStableRef(ref) {
  const hint = refHints.get(ref);
  try {
    const current = await callUia({ action: "get_value", ref });
    if (hint && !matchesHint(current, hint)) {
      throw new Error("ref path still exists but now resolves to a different semantic element");
    }
    return rememberResult(current);
  } catch (originalError) {
    if (!hint || (!hint.automationId && !hint.name && !hint.controlType && !hint.className)) throw originalError;
    const findCandidates = async (includeAutomationId) => {
      const found = await callUia({
        action: "find",
        ref: hint.windowRef,
        automationId: includeAutomationId ? hint.automationId : undefined,
        name: hint.name,
        controlType: hint.controlType,
        className: hint.className,
        limit: 10,
      });
      return (found.elements || []).filter((el) => !hint.processName || el.processName === hint.processName);
    };
    let candidates = await findCandidates(true);
    // Some UI frameworks recreate a child HWND while preserving the logical
    // control. In that case AutomationId may change even though stable
    // Name/ClassName metadata does not. Relax AutomationId only inside the
    // original HWND/PID and still require exactly one semantic match.
    if (candidates.length === 0 && hint.automationId && (hint.name || hint.className)) {
      candidates = await findCandidates(false);
    }
    if (candidates.length !== 1) {
      throw new Error(
        `${originalError.message}; semantic re-resolve inside the original window found ${candidates.length} candidates`
      );
    }
    const fresh = candidates[0];
    refHints.set(ref, { ...hint });
    rememberElement(fresh);
    return fresh;
  }
}

async function mutatingCall(action, args) {
  // Fetch current state first so we know which process we're about to touch
  // BEFORE performing the mutation — the allowlist check must happen before
  // the side effect, not after.
  const current = await resolveStableRef(args.ref);
  assertProcessAllowed(current.processName);
  return rememberResult(await callUia({ action, ...args, ref: current.ref }));
}

async function setValueAndVerify(ref, value) {
  const current = await resolveStableRef(ref);
  assertProcessAllowed(current.processName);

  const written = rememberResult(
    await callUia({ action: "set_value", ref: current.ref, value })
  );
  if (written?.isPassword) {
    // Password values are deliberately never returned. Re-resolve once in a
    // separate bridge process to verify the element still exists, but do not
    // weaken the redaction boundary just to compare plaintext.
    return await resolveStableRef(current.ref);
  }

  // The UIA provider can report the new ValuePattern value to the process
  // that performed SetValue slightly before a fresh UIA client sees it.
  // Verify through independent bridge processes so the MCP result reflects
  // what the next observer can actually read, not only the writer's cache.
  const deadline = Date.now() + 2500;
  let observed = written;
  while (true) {
    observed = await resolveStableRef(current.ref);
    if (observed?.value === value) return observed;
    if (Date.now() >= deadline) {
      throw new Error(
        "windows_set_value returned from UIA, but an independent re-observation did not confirm the requested value before the verification deadline " +
          `(expectedLength=${value.length}, observedLength=${observed?.valueLength ?? "unknown"}, ref=${observed?.ref ?? "unknown"}, automationId=${observed?.automationId ?? ""})`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function registerWindowsTools(server) {
  server.registerTool(
    "windows_list",
    { title: "List top-level windows", description: "Returns all top-level windows: hwnd, ref, name, className, bounds, processName/processId.", inputSchema: {} },
    async () => text(await readRemembered({ action: "list_windows" }))
  );

  server.registerTool(
    "windows_active",
    { title: "Get the active window", description: "Returns the currently focused/foreground top-level window, or null.", inputSchema: {} },
    async () => text(await readRemembered({ action: "active_window" }))
  );

  server.registerTool(
    "windows_tree",
    {
      title: "Get a window's UI Automation tree",
      description:
        "Returns a flat, ref-tagged list of UI elements under the given window/element ref (each with a depth " +
        "field), capped at maxNodes. Password field values are never included (see windows_get_value).",
      inputSchema: { ref: z.string().describe('Window ref from windows_list/windows_active, e.g. "12345|"'), maxDepth: z.number().default(4), maxNodes: z.number().default(200) },
    },
    async ({ ref, maxDepth, maxNodes }) => text(await readRemembered({ action: "tree", ref, maxDepth, maxNodes }))
  );

  server.registerTool(
    "windows_find",
    {
      title: "Find elements in a window",
      description: "Searches descendants of the given ref by automationId/name/controlType/className (any combination), capped at limit.",
      inputSchema: {
        ref: z.string(),
        automationId: z.string().optional(),
        name: z.string().optional(),
        controlType: z.string().optional(),
        className: z.string().optional(),
        limit: z.number().default(50),
      },
    },
    async (args) => text(await readRemembered({ action: "find", ...args }))
  );

  server.registerTool(
    "windows_wait_for",
    {
      title: "Wait for an element to appear",
      description: "Polls under the given window ref until an element matching automationId/name/controlType/className appears, or timeoutMs elapses (returns {found:false}, not an error, on timeout).",
      inputSchema: {
        ref: z.string(),
        automationId: z.string().optional(),
        name: z.string().optional(),
        controlType: z.string().optional(),
        className: z.string().optional(),
        timeoutMs: z.number().default(5000),
      },
    },
    async (args) => text(await readRemembered({ action: "wait_for", ...args }))
  );

  server.registerTool(
    "windows_get_value",
    {
      title: "Get an element's current value/state",
      description: "Returns the re-resolved element (value/toggleState/bounds/etc.). Password fields return value:null, isPassword:true — never the real value.",
      inputSchema: { ref: z.string() },
    },
    async ({ ref }) => text(await resolveStableRef(ref))
  );

  server.registerTool(
    "windows_set_value",
    {
      title: "Set a text element's value",
      description:
        "Sets the value of the element with the given ref (ValuePattern), then returns the ACTUAL re-resolved " +
        "element state — not a bare success. Refuses if the target process isn't in the window allowlist.",
      inputSchema: { ref: z.string(), value: z.string() },
    },
    async ({ ref, value }) => text(await setValueAndVerify(ref, value))
  );

  server.registerTool(
    "windows_invoke",
    {
      title: "Invoke a control (e.g. click a button)",
      description:
        "Invokes the element with the given ref (InvokePattern — the semantic equivalent of clicking a button), " +
        "then returns the ACTUAL re-resolved element state. Refuses if the target process isn't allowlisted.",
      inputSchema: { ref: z.string() },
    },
    async ({ ref }) => text(await mutatingCall("invoke", { ref }))
  );

  server.registerTool(
    "windows_toggle",
    {
      title: "Toggle a checkbox/toggle control",
      description: "Toggles the element with the given ref (TogglePattern), then returns the actual resulting toggleState. Refuses if the target process isn't allowlisted.",
      inputSchema: { ref: z.string() },
    },
    async ({ ref }) => text(await mutatingCall("toggle", { ref }))
  );

  server.registerTool(
    "windows_select",
    {
      title: "Select an item (e.g. combobox/list item)",
      description: "Selects the element with the given ref (SelectionItemPattern), then returns the actual resulting state. Refuses if the target process isn't allowlisted.",
      inputSchema: { ref: z.string() },
    },
    async ({ ref }) => text(await mutatingCall("select", { ref }))
  );

  server.registerTool(
    "windows_focus",
    {
      title: "Focus an element",
      description: "Sets keyboard focus to the element with the given ref, then returns the actual resulting focus state. Refuses if the target process isn't allowlisted.",
      inputSchema: { ref: z.string() },
    },
    async ({ ref }) => text(await mutatingCall("focus", { ref }))
  );
}
