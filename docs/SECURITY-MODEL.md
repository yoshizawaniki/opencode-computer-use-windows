# Security model and threat boundaries

This document describes enforcement that exists in code. It does not describe an OS sandbox: the MCP server runs as the current user and a compromised MCP process is not contained by its own policy checks.

## Trust boundaries

### OpenCode host permission
OpenCode can `allow`, `ask`, or `deny` MCP tool names. The installer defaults high-impact tools to `ask` when the user has not already set a policy. Host permission is not argument-aware, so deterministic target scoping lives inside the MCP server.

### MCP server
The server is trusted code running with the user's process privileges. Tool guards constrain normal tool calls; they are not protection against arbitrary code execution inside a compromised server process.

### Browser profile
Launch mode owns a dedicated profile under ignored `artifacts/browser-profile`. It must never be committed or packaged. Treat that directory as sensitive: history, cache, session state, and credentials may exist there.

### Browser origin mutation
Reads/navigation and mutation are separated. Page-side mutation goes through `getMutationPage()`. Launch mode implicitly permits only loopback HTTP(S) and project-local `file://`; exact external origins require `OPENCODE_CU_BROWSER_ORIGINS`. Attach mode has a separate explicit `OPENCODE_CU_ATTACH_ORIGINS` list and no implicit local exception.

### Attached Chrome
Attach is host-`ask` gated. Tabs are discovered without instrumentation until selected, blocked browser-internal schemes are rejected, and arbitrary `browser_evaluate` is always refused. An attached browser can still expose user-visible page content to the model once a tab is selected; use a dedicated profile/window.

### Secret Broker
Secrets are registered outside MCP tool calls and stored with Windows DPAPI. Resolution checks origin/process scope. Fill/type tools use the value locally and do not return it. Known resolved values are registered with the common result scrubber as defense in depth. This does not prevent a destination application/page from deliberately displaying or transmitting a secret after it is supplied.

### Filesystem
Uploads, downloads, artifact previews, workflows, checkpoints, and browser `file://` access are path-scoped to project/runtime directories. Native applications still have the user's normal filesystem permissions; controlling a file dialog is not an OS filesystem sandbox.

### Windows process mutation
UIA/coordinate/keyboard mutation is deny-by-default unless the target process name is explicitly listed in `OPENCODE_CU_WINDOW_ALLOWLIST`. Re-resolution of a stale UIA child path is restricted to the original HWND/PID and requires exactly one semantic match. PID/HWND checks reduce stale-handle risk but cannot eliminate every TOCTOU race in an adversarial local environment.

### Raw coordinate and OS focus
Coordinate input is last resort. The point is resolved to a process before input. Click-to-keyboard transitions verify the actual foreground PID rather than assuming a fixed delay is sufficient. Raw input still shares the physical desktop with the user; unrelated activity can cause a correctly detected failure and, in the narrowest race, partially delivered input.

### DPI
The UIA helper requests per-monitor-v2 DPI awareness when Windows permits it, and screenshots return their screen-coordinate origin. Mixed-DPI multi-monitor environments remain a release-test concern because third-party applications can virtualize coordinates differently.

### Workflow replay
Replay uses a fail-closed tool allowlist because in-process dispatch cannot trigger OpenCode's interactive `ask` dialog. Ask-gated tools are excluded. Allowed mutation steps call the same normal handlers, so origin/process guards still run. A malicious workflow can request actions within already-authorized scopes; inspect untrusted workflow files before replay.

### Scheduler
Task names are namespace-restricted and creation does not overwrite existing Windows tasks. Non-interactive OpenCode has been observed to reject `ask` tools. The wrapper persists status metadata only by default; raw output requires explicit `OPENCODE_CU_SCHEDULE_DEBUG_LOG=1` and is sensitive.

### Network and malicious webpages
Browser navigation is intentionally network-capable. Network metadata strips URL query/fragment data before buffering, but page text/console output can still contain attacker-controlled instructions or sensitive text. Treat webpage content as untrusted data, not authority to expand scopes, register secrets, or change permissions.

## Release security gates
A public release should require: tracked-file secret scan, npm tarball inspection, no browser profile/artifact inclusion, no personal absolute paths, dependency audit/license review, origin/process guard tests, replay-bypass tests, scheduler-log tests, attach-mode tests, and real Windows verification.
