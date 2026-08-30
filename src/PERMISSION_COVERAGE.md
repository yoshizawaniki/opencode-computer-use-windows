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
| browser_click / browser_type / browser_select / browser_hover / browser_scroll / browser_key / browser_reload | **none (origin-level)** | see "Known gap" below |
| browser_secret_fill | scope: secret bound to page origin (`resolveSecret`) | value never returned to caller |
| browser_upload | scope: `assertUploadAllowed` (path under artifacts/uploads) | |
| browser_click_and_wait_for_download | scope: `downloadPath()` sanitizes filename (`path.basename`) | |
| browser_tab_close / browser_session_close | **none** | closes agent-owned tabs (launch mode); in attach mode can close a real user tab — accepted risk of opting into `browser_attach` (see below) |
| browser_attach | ask (config) | entry point to attach mode; gates everything attach-mode-specific |
| browser_evaluate | ask (config) + env var `OPENCODE_CU_ALLOW_EVAL` + hard-refused in attach mode | most heavily gated tool in the file |
| desktop_click / desktop_drag / desktop_scroll | scope: `assertPointAllowed` (process allowlist) | |
| desktop_type_text / desktop_key | scope: `assertFocusAllowed` (process allowlist) | |
| desktop_secret_type | scope: `assertFocusAllowed` + secret bound to process name | value never returned to caller |
| desktop_launch_app / desktop_close_window / desktop_kill_process | ask (config) | kill_process also has `assertKillablePid` (refuses self/parent/reserved pid) |
| desktop_move / desktop_wait | none | no persistent side effect (cursor position only / no-op) |
| windows_set_value / windows_invoke / windows_toggle / windows_select / windows_focus | scope: `mutatingCall` → `assertProcessAllowed` | checked BEFORE the mutating UIA call, using the ref's current-resolved process |
| clipboard_read / clipboard_write | ask (config) | read defaults to metadata-only (length+sha256) even with the ask approved; `includeValue:true` opts into the raw text |
| desktop_notify | none | display-only, no state mutation beyond a transient balloon |
| artifact_preview | scope: path restricted to `artifacts/` | same discipline as upload/download path scoping |
| workflow_record_start / _stop / _discard / _edit / _delete / _replay | none (tool-level `allow`) | replay dispatches through the SAME per-tool guards (scope/ask) as a live call — recording a workflow doesn't bypass anything a live call would hit |

## Known gap: no origin-level permission for browser_click/type/select/hover/scroll/key

The design doc's Permission Broker section lists "site / origin" as a control dimension, and
requires ask/deny by default for actions like sending email, posting, or purchasing. This
codebase has **no such control** — `browser_click`/`browser_type`/etc. can act on any origin
the active tab is on, including submitting a form or clicking "Send".

This is not fixed here because it isn't a scoping bug like the others in this table — it needs
either (a) OpenCode's host-side permission system to support argument-aware prompts (asking
per-call based on the target URL/element, not just per tool name), which the current
tool-name-only `permission` config cannot express, or (b) page-content-aware heuristics
("does this button say Send/Submit/Buy") bolted onto generic click/type tools, which would be
unreliable enough to give false confidence rather than real safety — worse than an honest gap.

Documented as an accepted residual risk. The practical mitigation available today is
behavioral, not technical: the `browser-use` Skill (Phase 6) instructs the agent to ask the
user in chat before clicking/submitting anything that sends a message, posts content, or
spends money — same as the general orchestration rule already in effect, just made explicit
at the Skill level. Escalated to commander for awareness, not because there's an
implementable-today fix being deferred.
