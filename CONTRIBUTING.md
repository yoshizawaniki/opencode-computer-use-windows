# Contributing

Thanks for helping improve `opencode-computer-use`.

## Development setup

1. Use Node.js 20 or newer on Windows.
2. Run `npm ci`.
3. Run `npm test` for the contributor-safe unit/browser suite.
4. Run `npm run test:windows`, `npm run test:attach`, and `npm run test:scheduler` only when you intentionally want the corresponding real-machine integration checks.

`npm test` must remain safe for ordinary contributors: it must not create Windows scheduled tasks, attach to a real browser profile, or send raw input to the physical desktop.

## Pull requests

Keep changes focused. For any new mutating MCP tool, update `src/PERMISSION_COVERAGE.md` and add a regression test showing that the relevant origin/process/host-permission boundary cannot be bypassed, including through workflow replay where applicable.

Do not commit runtime artifacts, browser profiles, credentials, user data, local absolute paths, or raw scheduled-task logs. Run `npm run check:secrets` and `npm run check:package` before proposing a release.

## Verification philosophy

The project distinguishes operation success from task success. Tests and implementations should follow **observe -> act -> re-observe -> verify** and assert externally observable state whenever practical.
