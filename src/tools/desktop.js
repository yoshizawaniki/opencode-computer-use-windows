import { z } from "zod";
import { callUia } from "../uia.js";
import { assertProcessAllowed } from "../allowlist.js";
import { artifactPath } from "../browser-session.js";

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

export function registerDesktopTools(server) {
  server.registerTool(
    "desktop_screenshot",
    {
      title: "Screenshot the full screen or a window",
      description: "Saves a PNG to the artifacts directory and returns its path. Pass a window ref to capture just that window, or omit for full screen.",
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
      description: "Saves a PNG of the given screen-pixel region (x, y, width, height) to the artifacts directory and returns its path.",
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
        "Last-resort fallback for when UI Automation can't address a control — clicks at raw (x, y). " +
        "Refuses if the window under the point isn't in the allowlist. Returns the resulting active window state.",
      inputSchema: { x: z.number(), y: z.number(), button: z.enum(["left", "right", "double"]).default("left") },
    },
    async ({ x, y, button }) => {
      await assertPointAllowed(x, y);
      await callUia({ action: "click", x, y, button });
      return text(await callUia({ action: "active_window" }));
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
      await assertPointAllowed(fromX, fromY);
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
      description: "Sends the given text as real keyboard input (SendInput, not window-message injection) to whatever currently has focus. Refuses if the focused window isn't allowlisted.",
      inputSchema: { text: z.string() },
    },
    async ({ text: value }) => {
      await assertFocusAllowed();
      return text(await callUia({ action: "type_text", text: value }));
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
      await assertFocusAllowed();
      return text(await callUia({ action: "key_press", key }));
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
      description: "Starts a new process (Start-Process). Destructive/expands attack surface — gated by config permission (ask), not the window allowlist.",
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
      description: "Force-terminates the process with the given pid. Gated by config permission (ask) — irreversible.",
      inputSchema: { pid: z.number() },
    },
    async ({ pid }) => text(await callUia({ action: "kill_process", pid }))
  );
}
