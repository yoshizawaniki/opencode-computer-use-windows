import { z } from "zod";
import { callUia } from "../uia.js";
import { assertProcessAllowed } from "../allowlist.js";
import { artifactPath } from "../browser-session.js";
import { resolveSecret } from "../secret-broker.js";

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

// Coordinate/keyboard input has no `ref` to check up front — it lands on
// whatever window is under the cursor (click/drag) or focused (type/key).
// Resolve that target FIRST and check the allowlist before dispatching,
// same "check before the side effect" rule as windows.js.
async function assertPointAllowed(x, y) {
  const win = await callUia({ action: "window_at_point", x, y });
  assertProcessAllowed(win?.processName);
  return win;
}
async function assertFocusAllowed() {
  const win = await callUia({ action: "active_window" });
  assertProcessAllowed(win?.processName);
  return win;
}

// kill_process is gated by config permission (ask), not the window
// allowlist, by design — but "ask" alone doesn't stop an LLM-chosen pid from
// being this server's own process, its parent (OpenCode), or a reserved
// system pid. Those are refused unconditionally, before ask is even relevant.
function assertKillablePid(pid) {
  const reserved = new Set([0, 4, process.pid, process.ppid]);
  if (reserved.has(pid)) {
    throw new Error(`refusing to kill pid ${pid}: it is a reserved/self/parent process, not a target app`);
  }
}

export function registerDesktopTools(server) {
  server.registerTool(
    "desktop_screenshot",
    {
      title: "Screenshot the full screen or a window",
      description:
        "Saves a PNG to the artifacts directory and returns its path, PLUS the capture's (x, y) origin in " +
        "SCREEN coordinates and its (width, height). On a multi-monitor system the origin is virtually never " +
        "(0, 0) — a pixel at (px, py) in the saved image is screen coordinate (x + px, y + py); ADD the " +
        "returned origin before passing a pixel from this image to desktop_click/desktop_annotate_point/etc. " +
        "Pass a window ref to capture just that window, or omit for full screen.",
      inputSchema: { ref: z.string().optional() },
    },
    async ({ ref }) => {
      const savePath = artifactPath(`desktop-${Date.now()}.png`);
      const action = ref ? "screenshot_window" : "screenshot_fullscreen";
      const data = await callUia({ action, ref, savePath });
      return text(data);
    }
  );

  server.registerTool(
    "desktop_screenshot_region",
    {
      title: "Screenshot a screen region",
      description:
        "Saves a PNG of the given SCREEN-coordinate region (x, y, width, height, not image-pixel-relative) to " +
        "the artifacts directory and returns its path plus the same (x, y, width, height) for confirmation.",
      inputSchema: { x: z.number(), y: z.number(), width: z.number(), height: z.number() },
    },
    async ({ x, y, width, height }) => {
      const savePath = artifactPath(`desktop-region-${Date.now()}.png`);
      return text(await callUia({ action: "screenshot_region", x, y, width, height, savePath }));
    }
  );

  server.registerTool(
    "desktop_app_context",
    {
      title: "Get a one-shot snapshot of the active app",
      description: "Returns active window info + a screenshot path in one call: app name, window title, bounds, process info, screenshot path.",
      inputSchema: {},
    },
    async () => {
      const savePath = artifactPath(`context-${Date.now()}.png`);
      return text(await callUia({ action: "app_context", savePath }));
    }
  );

  server.registerTool(
    "desktop_click",
    {
      title: "Click at screen coordinates",
      description:
        "Last-resort fallback for when UI Automation can't address a control — clicks at raw (x, y) in SCREEN " +
        "coordinates (same coordinate system desktop_screenshot's returned origin uses — NOT relative to a " +
        "saved image's top-left unless that image's origin was (0,0)). Refuses if the window under the point " +
        "isn't in the allowlist. Returns the resulting active window state.",
      inputSchema: { x: z.number(), y: z.number(), button: z.enum(["left", "right", "double"]).default("left") },
    },
    async ({ x, y, button }) => {
      const target = await assertPointAllowed(x, y);
      await callUia({ action: "click", x, y, button, expectedPid: target.processId });
      return text(await callUia({ action: "active_window" }));
    }
  );

  server.registerTool(
    "desktop_annotate_point",
    {
      title: "Resolve a screen point to a real, actionable UI element (Browser Annotation)",
      description:
        "Given a SCREEN coordinate the user pointed at (e.g. from a desktop_screenshot they annotated — ADD " +
        "that screenshot's returned origin to the image pixel first, don't pass raw image pixels here), " +
        "returns the actual UI Automation element under that point as a real ref usable by windows_get_value/ " +
        "windows_invoke/etc. — not just the containing window (see desktop_click for that). Refuses if the " +
        "window under the point isn't in the process allowlist. May return null if the element's tree " +
        "position couldn't be resolved to a stable path (rare, e.g. certain virtualized/owner-drawn controls) " +
        "— that means genuinely no re-usable ref exists here, not a bug to retry past.",
      inputSchema: { x: z.number(), y: z.number() },
    },
    async ({ x, y }) => {
      await assertPointAllowed(x, y);
      return text(await callUia({ action: "element_at_point", x, y }));
    }
  );

  server.registerTool(
    "desktop_move",
    { title: "Move the mouse cursor", description: "Moves the cursor to (x, y) without clicking.", inputSchema: { x: z.number(), y: z.number() } },
    async ({ x, y }) => text(await callUia({ action: "move", x, y }))
  );

  server.registerTool(
    "desktop_drag",
    {
      title: "Drag from one point to another",
      description: "Presses at (fromX, fromY), moves to (toX, toY), releases. Refuses if the source window isn't allowlisted.",
      inputSchema: { fromX: z.number(), fromY: z.number(), toX: z.number(), toY: z.number() },
    },
    async ({ fromX, fromY, toX, toY }) => {
      const source = await assertPointAllowed(fromX, fromY);
      const destination = await assertPointAllowed(toX, toY);
      if (source.processId !== destination.processId) {
        throw new Error(
          `desktop_drag refused: source pid ${source.processId} and destination pid ${destination.processId} differ; cross-process drag/drop is not permitted`
        );
      }
      return text(await callUia({ action: "drag", fromX, fromY, toX, toY }));
    }
  );

  server.registerTool(
    "desktop_scroll",
    {
      title: "Scroll at a point",
      description: "Sends a mouse wheel scroll at (x, y). Refuses if the window under the point isn't allowlisted.",
      inputSchema: { x: z.number(), y: z.number(), deltaY: z.number() },
    },
    async ({ x, y, deltaY }) => {
      await assertPointAllowed(x, y);
      return text(await callUia({ action: "scroll", x, y, deltaY }));
    }
  );

  server.registerTool(
    "desktop_type_text",
    {
      title: "Type text via keyboard input",
      description:
        "Sends the given text as real keyboard input (SendInput, not window-message injection) to whatever " +
        "currently has OS-level focus. Refuses if that window isn't allowlisted. NOTE: windows_focus (UIA " +
        "SetFocus) sets logical focus within an app but does not guarantee that app becomes the OS foreground " +
        "window SendInput targets — if another window is genuinely focused at the OS level, this call is " +
        "correctly refused rather than typing into the wrong place. Prefer windows_set_value when the target " +
        "supports it; it doesn't depend on OS-level focus at all.",
      inputSchema: { text: z.string() },
    },
    async ({ text: value }) => {
      const win = await assertFocusAllowed();
      return text(await callUia({ action: "type_text", text: value, expectedPid: win.processId }));
    }
  );

  server.registerTool(
    "desktop_secret_type",
    {
      title: "Type a registered secret via keyboard input (Secret Broker)",
      description:
        "Resolves a secret by NAME from the local Secret Broker and sends it as real keyboard input " +
        "(SendInput) to whatever currently has OS-level focus — the actual value is never returned to you. " +
        "Secrets must be pre-registered via `scripts/secret-cli.ps1 -Action register`, bound to a process " +
        "name (e.g. \"notepad.exe\"). Refuses if the focused window's process doesn't match that scope, or " +
        "isn't in the window allowlist. Same OS-focus caveat as desktop_type_text: click the target field " +
        "first with desktop_click.",
      inputSchema: { name: z.string().describe("registered secret name") },
    },
    async ({ name }) => {
      const win = await assertFocusAllowed();
      const value = await resolveSecret(name, win?.processName);
      const result = await callUia({ action: "type_text", text: value, expectedPid: win.processId });
      return text({ ...result, secretName: name });
    }
  );

  server.registerTool(
    "desktop_key",
    {
      title: "Press a key or key combination",
      description: 'Sends a key press (e.g. "Enter", "Escape") or hotkey combo (e.g. "Ctrl+S") via SendInput to whatever has focus. Refuses if the focused window isn\'t allowlisted.',
      inputSchema: { key: z.string() },
    },
    async ({ key }) => {
      const win = await assertFocusAllowed();
      return text(await callUia({ action: "key_press", key, expectedPid: win.processId }));
    }
  );

  server.registerTool(
    "desktop_wait",
    { title: "Wait", description: "Waits the given number of milliseconds.", inputSchema: { ms: z.number().default(1000) } },
    async ({ ms }) => text(await callUia({ action: "wait", ms }))
  );

  server.registerTool(
    "desktop_launch_app",
    {
      title: "Launch an application",
      description:
        "Starts a new process (Start-Process). Destructive/expands attack surface — gated by config permission " +
        "(ask), not the window allowlist. NOTE: the returned pid may be a short-lived launcher stub for " +
        "packaged Windows apps (observed with notepad.exe on Windows 11) — it is NOT guaranteed to be the pid " +
        "that ends up owning the window. Use windows_list afterward to find the real window/pid.",
      inputSchema: { path: z.string(), args: z.array(z.string()).optional() },
    },
    async ({ path, args }) => text(await callUia({ action: "launch_app", path, args }))
  );

  server.registerTool(
    "desktop_close_window",
    {
      title: "Close a window",
      description: "Closes the window with the given ref (WM_CLOSE via WindowPattern). Gated by config permission (ask).",
      inputSchema: { ref: z.string() },
    },
    async ({ ref }) => text(await callUia({ action: "close_window", ref }))
  );

  server.registerTool(
    "desktop_kill_process",
    {
      title: "Kill a process",
      description:
        "Force-terminates the process with the given pid. Gated by config permission (ask) — irreversible. " +
        "CAUTION: some Windows 11 apps (observed with notepad.exe) run as a single shared host process " +
        "across ALL open windows of that app — killing it closes every window, not just one. Prefer " +
        "desktop_close_window for a single window when the target might be one of these.",
      inputSchema: { pid: z.number() },
    },
    async ({ pid }) => {
      assertKillablePid(pid);
      return text(await callUia({ action: "kill_process", pid }));
    }
  );
}
