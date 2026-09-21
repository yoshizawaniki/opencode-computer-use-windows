# Mutating-tool permission coverage

Every mutating tool must be covered by at least one of:
- **ask/deny** (config `permission` in opencode.jsonc, tool-name-scoped)
- **scope guard** (this codebase: origin/path/process assert, checked before the side effect)

New tools MUST add a row here before being merged — that's the rule, not a class hierarchy
(a "Permission Broker" class in this MCP server couldn't itself pop the user-facing ask
dialog anyway; only the OpenCode host can, and it does so by tool name only today).

| Tool | Guard | Notes |
|---|---|---|
| browser_navigate | scope: `assertNavigateAllowed` (blocks chrome/devtools/extension in attach mode; scopes file:// to project root) | |
| browser_back / browser_forward | scope: routed through `getActivePage()` choke point | catches history landing on a blocked scheme |
| browser_click / browser_type / browser_select / browser_hover / browser_scroll / browser_key / browser_reload | scope: `getMutationPage` -> `assertBrowserMutationAllowed` | launch: loopback/project-file safe defaults + exact external allowlist; attach: separate exact allowlist, no implicit safe origin |
| browser_secret_fill | scope: browser origin guard + secret bound to page origin (`resolveSecret`) | value never returned to caller |
| browser_upload | scope: browser origin guard + `assertUploadAllowed` (path under artifacts/uploads) | |
| browser_click_and_wait_for_download | scope: browser origin guard + `downloadPath()` sanitizes filename (`path.basename`) | |
| browser_tab_close / browser_session_close | **none** | closes agent-owned tabs (launch mode); in attach mode can close a real user tab — accepted risk of opting into `browser_attach` (see below) |
| browser_attach | ask (config) | entry point to attach mode; gates everything attach-mode-specific |
| browser_evaluate | ask (config) + env var `OPENCODE_CU_ALLOW_EVAL` + browser origin guard + hard-refused in attach mode | most heavily gated browser tool |
| desktop_click / desktop_drag / desktop_scroll | scope: `assertPointAllowed` (process allowlist) | |
| desktop_type_text / desktop_key | scope: `assertFocusAllowed` (process allowlist) | |
| desktop_secret_type | scope: `assertFocusAllowed` + secret bound to process name | value never returned to caller |
| desktop_launch_app / desktop_close_window / desktop_kill_process | ask (config) | kill_process also has `assertKillablePid` (refuses self/parent/reserved pid) |
| desktop_move / desktop_wait | none | no persistent side effect (cursor position only / no-op) |
| desktop_annotate_point | scope: `assertPointAllowed` (process allowlist) | read-only (resolves a point to a ref), but still checked since it touches an arbitrary window's UIA tree |
| browser_annotate_point | none (read-only) | scoped to the active tab like any other browser read |
| windows_set_value / windows_invoke / windows_toggle / windows_select / windows_focus | scope: `mutatingCall` → `assertProcessAllowed` | checked BEFORE the mutating UIA call, using the ref's current-resolved process |
| clipboard_read / clipboard_write | ask (config) | read defaults to metadata-only (length+sha256) even with the ask approved; `includeValue:true` opts into the raw text |
| desktop_notify | none | display-only, no state mutation beyond a transient balloon |
| artifact_preview | scope: path restricted to `artifacts/` | same discipline as upload/download path scoping |
| scheduled_task_register / scheduled_task_delete | ask (config) | new names use `OpenCodeComputerUse-`; delete also accepts legacy `OpenCodeUpgrade-` for migration cleanup. Creation never passes `/F`. Runtime persists metadata-only `*.status.json` by default; raw output exists only with explicit `OPENCODE_CU_SCHEDULE_DEBUG_LOG=1` as `*.debug.log`. |
| scheduled_task_list | none (read-only) | filtered to current `OpenCodeComputerUse-` and legacy `OpenCodeUpgrade-` namespaces only |
| task_checkpoint_save / _load / _list | none (tool-level `allow`) | writes/reads only under `artifacts/tasks/`; save scrubs known secret values and caps size at 50000 chars (fail loud, not silently truncated) |
| workflow_record_start / _stop / _discard / _edit / _delete / _replay | none (tool-level `allow`) | `workflow_replay` dispatches normal registered handlers in-process, so browser origin/process/path scope guards still execute. Because in-process dispatch cannot trigger OpenCode's host `ask` dialog, `REPLAY_ALLOWED` is fail-closed: ask-gated tools are excluded and every future tool defaults to blocked until explicitly reviewed. |

## Empirical finding: non-interactive `opencode run` auto-REJECTS ask permissions

Measured directly (not assumed) for the Scheduled Tasks design: running
`opencode run "<prompt that calls an ask-gated tool>"` with stdin closed and no TTY produces:

```
! permission requested: opencode-computer-use_clipboard_write (*); auto-rejecting
✗ opencode-computer-use_clipboard_write {"text":"..."} failed
Error: The user rejected permission to use this specific tool call.
```

Not a hang, not auto-allow — a clean auto-deny. This means a `schtasks`-launched, fully
unattended `opencode run` can never execute an ask-gated tool (`browser_evaluate`,
`browser_attach`, `desktop_launch_app`, `desktop_close_window`, `desktop_kill_process`,
`clipboard_read`, `clipboard_write`) — the existing config permission alone already satisfies
the design doc's "Scheduled Tasks からの起動でも Permission ルールは通常実行と同じ" requirement
for this specific risk. No additional unattended-mode guard was added because none was needed
— confirmed by measurement, not assumed by design.

## Browser mutation scope

OpenCode 1.x host permission is tool-name scoped, not argument/origin aware. The MCP server
therefore enforces the target origin itself at a single page-mutation choke point:
`getMutationPage()` calls `assertBrowserMutationAllowed()` before generic page-side mutation.
Launch mode is safe-by-default for loopback HTTP(S) and project-local `file://` fixtures;
external origins require exact entries in `OPENCODE_CU_BROWSER_ORIGINS`. Attached Chrome
uses the separate `OPENCODE_CU_ATTACH_ORIGINS` allowlist with no implicit local exception.
Workflow replay reaches the same handlers, so it does not bypass this scope.

This is intentionally not a UI-text heuristic. Labels such as Send, Buy, or Submit are not
security boundaries. Human approval for consequential actions remains an orchestration
requirement on top of deterministic origin scope.
