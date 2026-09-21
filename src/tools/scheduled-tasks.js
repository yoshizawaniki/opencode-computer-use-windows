import { z } from "zod";
import { registerScheduledTask, listScheduledTasks, deleteScheduledTask } from "../scheduled-tasks.js";

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

export function registerScheduledTaskTools(server) {
  server.registerTool(
    "scheduled_task_register",
    {
      title: "Register a Windows scheduled task that runs an opencode prompt",
      description:
        "Registers a Windows Task Scheduler entry (schtasks) that runs `opencode run <prompt>` " +
        "non-interactively at the given schedule. The task name MUST start with \"OpenCodeComputerUse-\" — this " +
        "tool can only create/list/delete tasks it namespaced itself, never touch an existing unrelated " +
        "scheduled task. Confirmed by measurement: a non-interactive opencode run auto-REJECTS any " +
        "ask-gated tool call (desktop_kill_process, browser_attach, etc.) — the same permission rules apply " +
        "as an interactive run, just fail-closed instead of prompting. Gated by config permission (ask). " +
        "CAUTION: this task will move the real mouse/keyboard and control real windows at the scheduled time, " +
        "even while the user is actively using the PC — schedule it for a time the user won't be at the " +
        "keyboard, not just \"whenever is convenient.\"",
      inputSchema: {
        name: z.string().describe('must start with "OpenCodeComputerUse-"'),
        prompt: z.string().describe("the instruction opencode run will execute, max 20000 chars"),
        model: z.string().describe("e.g. opencode/nemotron-3.5-lightning-free — required, the default provider may not be reachable unattended"),
        schedule: z.object({
          type: z.enum(["DAILY", "HOURLY", "ONCE"]),
          time: z.string().optional().describe('HH:MM, required for DAILY/ONCE'),
          intervalHours: z.number().optional().describe("for HOURLY, default 1"),
          date: z
            .string()
            .optional()
            .describe(
              "optional for ONCE (defaults to today) — format follows the Windows system locale; " +
                "omit the date unless the local schtasks date format is known"
            ),
        }),
      },
    },
    async ({ name, prompt, model, schedule }) => text(await registerScheduledTask({ name, prompt, model, schedule }))
  );

  server.registerTool(
    "scheduled_task_list",
    { title: "List opencode-computer-use scheduled tasks", description: "Lists current OpenCodeComputerUse-* tasks plus legacy OpenCodeUpgrade-* tasks from pre-OSS builds, never unrelated tasks.", inputSchema: {} },
    async () => text(await listScheduledTasks())
  );

  server.registerTool(
    "scheduled_task_delete",
    {
      title: "Delete a scheduled task",
      description: "Deletes an OpenCodeComputerUse-* task (or a legacy OpenCodeUpgrade-* task from this project's private builds) and its saved runtime files. Gated by config permission (ask).",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => text(await deleteScheduledTask(name))
  );
}
