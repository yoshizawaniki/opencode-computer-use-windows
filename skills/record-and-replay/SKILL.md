---
name: record-and-replay
description: Record a sequence of browser/windows actions once as a named Workflow and replay it later with different parameters, through the opencode-computer-use MCP server's workflow_* tools — semantic targets (not raw refs), parameterization, and mandatory per-step verification.
metadata:
  provider: opencode-computer-use
---

# Record & Replay

## Scope: this records actions performed THROUGH this MCP server's tools

Not raw OS-level mouse/keyboard input hooking of a human working independently — every
`browser_click`/`windows_invoke`/etc. call you make while a recording is active gets captured
automatically, translated into a SEMANTIC target (browser: role+name; windows:
automationId/name/controlType), not a raw ref or screen coordinates. This is what makes
replay work later even though refs are regenerated every snapshot and windows can move.

## Record

1. `workflow_record_start` with a name (`[A-Za-z0-9_-]+`).
2. Perform the flow normally via `browser-use`/`windows-app-testing` tools — 観測 → 操作 →
   再観測 still applies while recording; recording doesn't change how you should act.
3. `workflow_record_stop` — saves to `artifacts/workflows/<name>.json` and reports the step
   count and whether any step `requiresManualEdit`.

A value typed into a password-typed or sensitively-named field (checked the same way
`browser_snapshot`/`windows_get_value` already redact secrets) is NEVER saved in plaintext —
that step's value is replaced with a placeholder and flagged `requiresManualEdit: true`.
Replay refuses to run past such a step until you fix it (see Secrets below). Use
`workflow_record_discard` instead of `_stop` if you don't want to keep a bad take.

## Preview and edit

`workflow_preview` returns a numbered, human-readable listing AND the raw `steps` JSON array.
`workflow_edit` overwrites the saved steps with an edited JSON array — this is also how you
**parameterize**: replace a literal arg value with `"${paramName}"`, then pass
`params: {paramName: "..."}` to `workflow_replay`.

## Secrets in a workflow

Fix a `requiresManualEdit` step by replacing the offending `browser_type`/`windows_set_value`
step with a `browser_secret_fill`/`desktop_secret_type` step referencing a registered secret
NAME (see `computer-use`) — never fill in the real value via `workflow_edit`. A
`browser_secret_fill`/`desktop_secret_type` step recorded normally already stores only the
secret's name, never its value, so it never needs manual editing in the first place.

## Replay

`workflow_replay` with the workflow name and `params`. Each step:
- Re-resolves its target against CURRENT state (fresh snapshot for browser role+name match;
  `windows_find` under the recorded window for windows) — never reuses a stale ref.
- Substitutes any `${param}` placeholders.
- Dispatches through the real tool handler, so you get the REAL post-action result for every
  step, not a bare "ran N steps" — check it, same as any other action.
- If a step declares `expect.textContains` (add this via `workflow_edit`), replay verifies it
  and throws immediately, naming the failed step, if it doesn't match.

**Known failure modes, both by design (fail loudly, not silently):**
- Browser target ambiguous or gone (role+name matches 0 or >1 elements on the current page) →
  replay throws naming the step; re-record or hand-edit the target.
- Windows target's recorded window handle (hwnd) is stale (the app restarted since
  recording) → `windows_find` reports it clearly; re-record rather than assuming replay
  auto-recovers, it doesn't.

## Housekeeping

`workflow_list` / `workflow_delete`. `workflow_record_status` to check whether a recording is
currently active before starting another (only one at a time).
