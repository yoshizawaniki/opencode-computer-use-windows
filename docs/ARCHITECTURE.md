# Architecture

`opencode-computer-use` is a local stdio MCP server. OpenCode starts `src/server.js`, which registers the 83 tools and wraps every handler for common result redaction and workflow recording.

## Major components

| Component | Responsibility |
|---|---|
| `src/server.js` | MCP entrypoint and common wrapper |
| `src/browser-session.js` | Sole Playwright browser/context/tab owner, attach lifecycle, browser mutation choke point |
| `src/browser-origin-policy.js` | Deterministic origin policy for page-side mutation |
| `src/snapshot.js` | Ref-tagged browser observation and semantic ref lookup |
| `src/tools/browser.js` | Browser actions and download/upload management |
| `src/tools/devtools.js` | Console/network/DOM/style/storage/performance inspection and gated evaluate |
| `src/uia.js` + `src/uia.ps1` | One-shot Windows UI Automation and SendInput bridge |
| `src/allowlist.js` | Deny-by-default Windows process mutation policy |
| `src/tools/windows.js` | Semantic UIA tools plus stale-path re-resolution within original HWND/PID |
| `src/tools/desktop.js` | Coordinate/keyboard fallback with process and foreground verification |
| `src/secret-broker.js` | Scope-bound DPAPI secret resolution and redaction registration |
| `src/workflow.js` | Record/replay and fail-closed replay dispatch |
| `src/checkpoint.js` | Redacted task checkpoints |
| `src/scheduled-tasks.js` | Namespaced Task Scheduler registration |

## Verification contract

Mutating tools should return observed post-action state, not `success: true`. Browser tools snapshot after actions; Windows semantic tools re-read UIA state; raw Desktop input verifies process/foreground assumptions and callers then re-observe state.

## Resource ownership

Launch-mode Chromium uses an owned persistent profile under `artifacts/browser-profile`. Attach mode connects only after an explicit tool call and does not own the external Chrome process. UIA is intentionally one PowerShell process per call; UIA element objects are not cached across processes, only semantic descriptors are cached in the Node MCP process.

## Distribution

The repository ships six Skills from `skills/`. `scripts/install.mjs` copies them to OpenCode's global Skill location and merges the MCP entry/permissions into the user's JSONC config. `scripts/uninstall.mjs` uses the install manifest to restore only installer-owned state.
