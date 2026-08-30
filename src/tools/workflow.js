import { z } from "zod";
import {
  startRecording,
  stopRecording,
  discardRecording,
  isRecording,
  listWorkflows,
  previewWorkflow,
  editWorkflow,
  deleteWorkflow,
  replayWorkflow,
} from "../workflow.js";

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

export function registerWorkflowTools(server) {
  server.registerTool(
    "workflow_record_start",
    {
      title: "Start recording a workflow",
      description:
        "Starts capturing subsequent tool calls (browser and windows actions, not pure reads) as a named, " +
        "replayable Workflow. Each captured step stores a SEMANTIC target (browser: role+name; windows: " +
        "automationId/name/controlType) resolved at record time, not a raw ref or coordinates, so replay works " +
        "even though refs are regenerated every snapshot. A value typed into a password/sensitive-named field " +
        "is never saved in plaintext — the step is flagged requiresManualEdit instead. Call " +
        "workflow_record_stop to save.",
      inputSchema: { name: z.string().describe("workflow name, [A-Za-z0-9_-]+") },
    },
    async ({ name }) => {
      startRecording(name);
      return text({ recording: true, name });
    }
  );

  server.registerTool(
    "workflow_record_stop",
    {
      title: "Stop recording and save the workflow",
      description: "Stops the active recording, saves it to artifacts/workflows/<name>.json, and returns the step count.",
      inputSchema: {},
    },
    async () => text(stopRecording())
  );

  server.registerTool(
    "workflow_record_discard",
    { title: "Stop recording without saving", description: "Stops the active recording and discards it (nothing written to disk).", inputSchema: {} },
    async () => text(discardRecording())
  );

  server.registerTool(
    "workflow_record_status",
    { title: "Check recording status", description: "Returns whether a recording is currently active.", inputSchema: {} },
    async () => text({ recording: isRecording() })
  );

  server.registerTool(
    "workflow_list",
    { title: "List saved workflows", description: "Returns name and step count for every saved workflow.", inputSchema: {} },
    async () => text(listWorkflows())
  );

  server.registerTool(
    "workflow_preview",
    {
      title: "Preview a workflow",
      description: "Returns a human-readable, numbered listing of a saved workflow's steps (tool, target, args, any manual-edit flags).",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => text(previewWorkflow(name))
  );

  server.registerTool(
    "workflow_edit",
    {
      title: "Edit (or parameterize) a workflow",
      description:
        "Overwrites a saved workflow's steps with the given JSON array (validated: each step needs a \"tool\" " +
        "string). To parameterize a step, replace a literal arg value with \"${paramName}\" — workflow_replay " +
        "substitutes it from its `params` argument. Use workflow_preview first to see the current steps in " +
        "editable form.",
      inputSchema: { name: z.string(), stepsJson: z.string().describe("JSON array of steps, e.g. from an edited workflow_preview") },
    },
    async ({ name, stepsJson }) => text(editWorkflow(name, stepsJson))
  );

  server.registerTool(
    "workflow_delete",
    { title: "Delete a workflow", description: "Deletes a saved workflow file. No-op if it doesn't exist.", inputSchema: { name: z.string() } },
    async ({ name }) => {
      deleteWorkflow(name);
      return text({ deleted: name });
    }
  );

  server.registerTool(
    "workflow_replay",
    {
      title: "Replay a saved workflow",
      description:
        "Runs a saved workflow step by step, re-resolving each target against CURRENT page/window state " +
        "(never a stale ref), substituting any ${param} placeholders from `params`, and verifying each step's " +
        "`expect.textContains` if present. Returns the ACTUAL result of every step, not just a success flag — " +
        "throws immediately (naming the failed step) on a resolution failure, a dispatch error, or a failed " +
        "verification.",
      inputSchema: { name: z.string(), params: z.record(z.string(), z.string()).default({}) },
    },
    async ({ name, params }) => text(await replayWorkflow(name, params))
  );
}
