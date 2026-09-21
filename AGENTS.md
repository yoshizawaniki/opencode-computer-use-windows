# AGENTS.md

This file is the project-specific source of truth for AI-assisted maintenance of `opencode-computer-use`.

## Product boundaries

- Product name: `opencode-computer-use`.
- The physical checkout directory may still be named `OpenCode-Upgrade`; do not rename it without explicit user approval.
- This is an independent project for OpenCode. It is not built by, endorsed by, or affiliated with the OpenCode team.
- Do not publish to GitHub/npm, push commits, create releases, post externally, or submit Codex for Open Source applications without explicit user approval.

## Safety invariants

- Preserve the core loop: observe -> act -> re-observe -> verify. A successful API/input call is not task success.
- Never expose resolved Secret Broker values to an LLM result, ordinary log, workflow file, test fixture, or committed file.
- Every browser mutation must pass the shared origin-scope guard. Every Windows/Desktop mutation must pass the shared process-scope guard or an OpenCode host `ask` permission as documented in `src/PERMISSION_COVERAGE.md`.
- Workflow replay must not bypass either scope guards or host-approval boundaries.
- The owned browser profile and all runtime artifacts stay under ignored `artifacts/` and must never enter git or an npm tarball.
- Attached Chrome is a higher-trust mode: attachment is explicit, mutation has a separate allowlist, and arbitrary evaluate remains forbidden.
- The process allowlist is deny-by-default. Tests and examples must opt in to only the process they need.
- Scheduled tasks persist metadata by default, not raw `opencode run` output. Raw debug logging is explicit opt-in only.

## Development and verification

- Keep the MCP server modular; do not collapse browser, Windows, permission, secret, workflow, installer, and verification responsibilities into one file.
- Prefer semantic APIs (DOM/accessibility/UIA) over raw coordinates. Coordinate input is a last-resort fallback.
- Use fixture/sandbox config paths for installer tests. Never use the real OpenCode config in automated tests.
- `npm test` must remain contributor-safe and must not create real scheduled tasks, attach to a real Chrome profile, or drive the physical desktop.
- Real Windows UIA, Chrome attach, and Task Scheduler checks live behind explicit test scripts/release gates.
- Before claiming completion, re-read persisted config/state and verify behavior through the actual MCP/OpenCode path where possible.
- New mutating tools require an entry in `src/PERMISSION_COVERAGE.md` and tests proving the relevant guard cannot be bypassed.

## Compatibility

- The currently verified OpenCode baseline is `1.18.31` on Windows. Do not silently migrate installer/config syntax to a newer incompatible OpenCode schema.
- Skills are shipped from `skills/<name>/SKILL.md` and installed into OpenCode's supported skill directory.
