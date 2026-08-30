import { z } from "zod";
import { saveCheckpoint, loadCheckpoint, listCheckpoints } from "../checkpoint.js";

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

export function registerCheckpointTools(server) {
  server.registerTool(
    "task_checkpoint_save",
    {
      title: "Save a task checkpoint",
      description:
        "Saves structured progress state to artifacts/tasks/<taskId>.json so an interrupted task can be " +
        "resumed later — NOT a transcript dump. All fields are required: phase (short string), " +
        "lastVerifiedState (the last REAL observed state, e.g. an observedState()-shaped object — not what you " +
        "assumed happened), pending (array of remaining step descriptions), resources (identifiers only: " +
        "browser mode/tab list, window refs — NOT live handles you can act on later without re-verifying), " +
        "artifacts (array of file paths already produced), verification (what's been confirmed so far). " +
        "Refuses if the serialized size exceeds 50000 chars (this is a state summary, not a log) or if any " +
        "known secret value appears in it (auto-scrubbed).",
      inputSchema: {
        taskId: z.string().describe("[A-Za-z0-9_-]+"),
        phase: z.string(),
        lastVerifiedState: z.any(),
        pending: z.array(z.string()),
        resources: z.any(),
        artifacts: z.array(z.string()),
        verification: z.any(),
      },
    },
    async ({ taskId, ...fields }) => text(saveCheckpoint(taskId, fields))
  );

  server.registerTool(
    "task_checkpoint_load",
    {
      title: "Load a task checkpoint",
      description:
        "Loads a saved checkpoint. The returned `resources` are UNVERIFIED identifiers (a window/tab may have " +
        "closed or been reused since saving) — always re-observe (browser_snapshot / windows_list / " +
        "windows_find) before acting on anything from a loaded checkpoint. The response's " +
        "`resourcesVerified: false` reflects this structurally, not just in the description.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => text(loadCheckpoint(taskId))
  );

  server.registerTool(
    "task_checkpoint_list",
    { title: "List saved task checkpoints", description: "Returns taskId/phase/savedAt/pendingCount for every saved checkpoint.", inputSchema: {} },
    async () => text(listCheckpoints())
  );
}
