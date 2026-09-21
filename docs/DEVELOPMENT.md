# Development and release verification

## Test tiers

| Command | Scope | Real external/OS side effects |
|---|---|---|
| `npm test` | unit/security/installer + isolated browser smoke | no Task Scheduler, no Chrome attach, no physical desktop input intended |
| `npm run test:windows` | real Windows UIA/Desktop fixture | drives a visible test window and real input |
| `npm run test:attach` | scratch Chrome attach profile | launches a dedicated local Chrome profile/debug port |
| `npm run test:scheduler` | checkpoints + Task Scheduler | creates/deletes namespaced test task |
| `npm run test:all` | all above | yes |

Hosted CI runs what can be made deterministic there. Real interactive Windows UIA/Desktop remains a local/manual release gate rather than being marked green from a non-interactive runner.

## Pre-release gate

Run syntax checks, `npm audit --omit=dev`, dependency-license metadata review, tracked-file secret scan, package-content check, `npm pack`, inspect the tarball listing, then run all explicit Windows integration suites. Verify the OpenCode MCP can enumerate and call a harmless tool after an OpenCode restart. Test install -> uninstall -> reinstall against a sandbox config before touching a real config.

Do not publish merely because a command returned exit code 0. Re-read config/task/files and inspect actual GUI/browser state for stateful tests.
