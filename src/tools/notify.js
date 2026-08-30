import { z } from "zod";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "notify.ps1");

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

export function registerNotifyTools(server) {
  server.registerTool(
    "desktop_notify",
    {
      title: "Show a Windows notification",
      description:
        "Shows a real Windows balloon notification (title + message). Use for long-running task outcomes: " +
        "completion, failure, approval-needed, interrupted, needs-attention. Fire-and-forget — this tool " +
        "returns immediately, it does not wait for the notification to be dismissed or for its display " +
        "duration to elapse.",
      inputSchema: {
        title: z.string(),
        message: z.string(),
        level: z.enum(["info", "warning", "error"]).default("info"),
        durationMs: z.number().default(5000),
      },
    },
    async ({ title, message, level, durationMs }) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT,
          "-Title", title, "-Message", message, "-Icon", level, "-DurationMs", String(durationMs),
        ],
        { windowsHide: true, detached: true, stdio: "ignore" }
      );
      child.unref();
      return text({ shown: true, title, message, level });
    }
  );
}
