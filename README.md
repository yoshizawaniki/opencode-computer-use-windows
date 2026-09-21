# opencode-computer-use

**Safe browser and Windows computer-use tools for OpenCode, exposed through MCP.**

opencode-computer-use gives OpenCode a reusable GUI verification layer: browser automation, Windows UI Automation, coordinate fallback, screenshots and visual diffing, workflow record/replay, a local Secret Broker, checkpoints, notifications, and scheduled execution.

The current server exposes **83 MCP tools** and ships **6 OpenCode Skills**.

> **Independent project:** This project is not built by or affiliated with the OpenCode team. OpenCode is a separate project. The OpenCode name is used only to describe compatibility and integration.

The core rule is:

**observe -> act -> re-observe -> verify**

A successful click, API call, UIA call, or SendInput dispatch is not considered task success until the resulting state is observed again.

## Why it exists

Coding agents can edit code and run tests, but many real failures only appear in a browser or native GUI. This project lets OpenCode inspect and exercise those surfaces while keeping three security properties central:

- mutation targets are deterministically scoped;
- resolved secrets are not returned to the model;
- high-risk capabilities remain controlled by OpenCode host permissions.

## Capabilities

- **Browser:** isolated Playwright profile, accessibility-oriented snapshots and refs, navigation, click/type/select/hover/scroll/key, tabs, upload/download, screenshots, assertions, console/network metadata, DOM/style/performance inspection, cookie/storage metadata, and explicit Chrome attach/detach.
- **Windows:** UI Automation tree/query/value/invoke/toggle/select/focus plus coordinate and SendInput fallback for controls UIA cannot address.
- **Visual verification:** full and region screenshots, screenshot diffing, visual-change waits, and artifact preview.
- **Workflow:** semantic record/replay with stale-ref re-resolution and fail-closed replay policy.
- **Secret Broker:** DPAPI-backed local storage with origin/process-bound resolution; resolved secret values are fill/type-injected without being returned in normal MCP results.
- **Operations:** checkpoints, notifications, Task Scheduler integration, clipboard tools, and download integrity metadata.

See docs/ARCHITECTURE.md for module boundaries and docs/SECURITY-MODEL.md for the threat model.

## Supported environment

Full computer-use support currently targets **Windows**.

Verified local baseline:

- Windows 11
- OpenCode 1.18.31
- Node.js 24.18.0

package.json requires Node.js 20 or newer. Windows UIA/Desktop features require an interactive signed-in desktop session. Chrome is optional and is only needed for explicit attach mode and its integration test.

The installer intentionally targets the currently verified OpenCode 1.x local-MCP configuration shape. A future incompatible OpenCode config schema must be independently validated before the installer changes.

## Naming and package status

The product and MCP provider name are **opencode-computer-use**.

The public npm name opencode-computer-use is already occupied by another package. This checkout therefore prepares the npm package name **opencode-computer-use-windows**. The exact opencode-computer-use GitHub repository name is also already used by another independent project, so the planned repository slug is opencode-computer-use-windows.

No npm package or GitHub repository has been published by this project yet.

## Installation from a source checkout

Install dependencies, preview the changes, then opt in only to the Windows processes and external browser origins you actually want to mutate:

    npm ci
    node .\scripts\install.mjs --dry-run
    node .\scripts\install.mjs --allow-process notepad.exe

The installer:

- backs up the current OpenCode config before the first write;
- merges an opencode-computer-use local MCP entry instead of replacing the whole config;
- preserves existing explicit permission choices;
- adds ask defaults for high-risk tools only when no explicit user policy exists;
- installs the six Skills into OpenCode's supported global Skills directory;
- writes an install manifest so uninstall can restore only installer-owned state;
- is dry-run capable and idempotent;
- refuses to overwrite an existing same-name provider that points elsewhere;
- refuses to overwrite Skills or provider state that changed after installation;
- never asks for or stores application credentials.

The generated local MCP entry uses the OpenCode 1.x fields type, command, enabled, and optional environment.

## Browser mutation allowlist

Navigation and read-only inspection are separate from mutation.

Launch mode automatically permits mutation only on:

- HTTP(S) loopback hosts such as localhost, 127.0.0.1 and ::1, on any port;
- file:// pages located inside this project checkout.

External website mutation requires an exact origin in OPENCODE_CU_BROWSER_ORIGINS.

Example:

    node .\scripts\install.mjs --allow-origin https://staging.example.com

Attached Chrome is deliberately stricter. It has **no implicit local exception** and uses a separate OPENCODE_CU_ATTACH_ORIGINS allowlist:

    node .\scripts\install.mjs --allow-attach-origin https://staging.example.com

All page-side mutation tools acquire the active page through one MCP-side mutation choke point. Workflow replay dispatches those same normal handlers, so replay does not bypass the origin guard.

Do not add wildcard-style broad external origins merely to make an automation pass. Scope only the origins you intend the agent to change.

## Windows process allowlist

Windows UIA/Desktop mutation is **deny-by-default**.

Allow only executables you intend the agent to modify:

    node .\scripts\install.mjs --allow-process notepad.exe --allow-process my-test-app.exe

The same policy can be configured directly with OPENCODE_CU_WINDOW_ALLOWLIST in the MCP server environment.

This differs from the early private build, which implicitly allowed notepad.exe, opencode.exe, and systemsettings.exe. See docs/MIGRATION.md.

## OpenCode host permissions

The installer defaults these high-impact MCP tools to ask when the user has not already configured them:

- browser_attach
- browser_evaluate
- desktop_launch_app
- desktop_close_window
- desktop_kill_process
- clipboard_read
- clipboard_write
- scheduled_task_register
- scheduled_task_delete

Existing explicit permission rules are preserved.

Host permission and MCP-side scope guards solve different problems: OpenCode decides whether a tool class may run; the MCP server deterministically constrains what origin/process that tool may affect.

## Secret Broker

Secrets are registered locally, outside MCP tool calls.

Example:

    .\scripts\secret-cli.ps1 -Action register -Name demo-password -Scope https://example.test

The registration command reads the value locally. Browser secrets are bound to an origin; desktop secrets are bound to a process name.

Use browser_secret_fill or desktop_secret_type so the model references a secret **name**, not its value. The resolved value is supplied locally to the destination and is additionally registered with the common result redactor as defense in depth.

Do not put real credentials in tests, prompts, workflow JSON, screenshots, issue reports, or sample config.

## Quick start

### Local web application

1. Start the application on localhost.
2. Load the web-app-testing or computer-use Skill in OpenCode.
3. Snapshot the page.
4. Identify the target by semantic ref.
5. Perform the action.
6. Re-snapshot or assert the resulting state.
7. Use console/network/visual checks when UI state alone is insufficient.

The default origin policy intentionally makes localhost development usable without opening arbitrary external websites to mutation.

A minimal static demo is available in examples/local-web-demo/.

### Windows application

1. Explicitly allow a safe test process, for example notepad.exe.
2. Use windows_list and windows_tree first.
3. Prefer semantic UIA tools such as windows_set_value and windows_invoke.
4. Use desktop coordinate/SendInput tools only when UIA cannot perform the task.
5. Re-observe the UI state after mutation.

## Chrome attach

Attach is explicit and is intended for a **dedicated Chrome profile/window**, not silent control of an everyday browser profile.

Pre-existing tabs are discovered but are not instrumented until selected. Browser-internal sensitive schemes are blocked. browser_evaluate is always refused in attach mode. Generic mutation additionally requires OPENCODE_CU_ATTACH_ORIGINS.

Attaching lets the agent use the visible authenticated session in the selected page; it does not make that session non-sensitive. Use a dedicated profile whenever possible.

## Scheduled tasks and logs

Scheduled runs store a small structured status file containing:

- task id;
- start/finish timestamps;
- state;
- exit code.

Raw opencode run output is **not persisted by default**.

For deliberate troubleshooting only, set:

    OPENCODE_CU_SCHEDULE_DEBUG_LOG=1

That opt-in writes a raw debug log. Raw output may contain prompts, tool results, external content, paths, or personal information and must be treated as sensitive.

## Testing

Contributor-safe default:

    npm test

Explicit integration gates:

    npm run test:windows
    npm run test:attach
    npm run test:scheduler
    npm run test:all

Release/security checks:

    npm run check:syntax
    npm run check:secrets
    npm run check:licenses
    npm run check:package
    npm audit --omit=dev

npm test contains unit/security/installer tests plus the isolated browser smoke suite. It is designed not to create Windows scheduled tasks, attach to a real Chrome profile, or drive the physical Windows desktop.

The explicit integration commands may launch local test applications, use real UI input, launch a scratch Chrome profile, or create a short-lived namespaced scheduled task. Read docs/DEVELOPMENT.md before running them on a busy desktop.

## Uninstall

Preview:

    node .\scripts\uninstall.mjs --dry-run

Apply:

    node .\scripts\uninstall.mjs

Uninstall uses the install manifest. It restores prior provider/permission/Skill state only where the currently installed value still matches what this installer wrote. If a managed value or Skill changed after installation, uninstall leaves that user-modified state untouched and reports it rather than deleting it.

## Troubleshooting

**Mutation refused on a website**

Add only the exact external origin you intend to mutate. Successful navigation or read-only inspection does not imply mutation permission.

**Windows mutation refused**

Explicitly add the target executable to OPENCODE_CU_WINDOW_ALLOWLIST or rerun the installer with --allow-process.

**Raw keyboard input fails**

Prefer UIA windows_set_value/windows_invoke. Coordinate/SendInput is intentionally last-resort and depends on the real OS foreground window. The implementation verifies foreground PID instead of assuming a fixed sleep is sufficient.

**A UIA ref became stale**

Re-observe the window. For controls that were previously observed, the server can re-resolve a changed child path only inside the same original HWND/PID and only when the semantic descriptor produces exactly one match.

**A Skill is not discovered**

Verify the global path under ~/.config/opencode/skills/<name>/SKILL.md, then restart/reload OpenCode. The OpenCode debug skill command can show discovered Skills.

## Limitations

This is a **tool-level safety system, not an OS sandbox**.

The MCP process and any native app it controls run with the user's Windows permissions. A malicious webpage can attempt prompt injection; an attached browser can contain sensitive session state; raw coordinate input shares the physical desktop and can race with real user activity; native file dialogs can reach files the native app itself is allowed to access; and a compromised MCP server process is outside the protection offered by its own allowlists.

Mixed-DPI, virtualized/owner-drawn controls, secure desktop/UAC surfaces, and applications with unusual UIA behavior may require additional compatibility work.

See docs/SECURITY-MODEL.md for the complete trust-boundary discussion.

## Contributing

See CONTRIBUTING.md and docs/DEVELOPMENT.md.

New mutating tools must document their permission/scope coverage and include a regression test proving that the relevant guard cannot be bypassed, including through workflow replay where applicable.

## Security reports

See SECURITY.md. Do not place real tokens, cookies, browser-profile data, passwords, or private user data in public issues.

## License

MIT. See LICENSE.
