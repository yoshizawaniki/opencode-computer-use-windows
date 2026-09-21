# Migration from the private `OpenCode-Upgrade` build

The product name is now `opencode-computer-use`; the physical checkout directory may remain `OpenCode-Upgrade`.

## Process allowlist change

Earlier private builds implicitly allowed mutation of `notepad.exe`, `opencode.exe`, and `systemsettings.exe`. The public-ready policy is deny-by-default. Configure only what you need via the installer (`--allow-process`) or `OPENCODE_CU_WINDOW_ALLOWLIST` in the MCP environment.

## Browser mutation scope

Earlier builds could generically click/type/select on any active website. Mutation now defaults to loopback/project-local pages. External sites require exact `OPENCODE_CU_BROWSER_ORIGINS` entries. Attached Chrome uses a separate `OPENCODE_CU_ATTACH_ORIGINS` list.

## Scheduled logs

Earlier scheduled tasks appended raw `opencode run --print-logs` output to `artifacts/tasks/<name>.log`. New runs persist metadata-only `<name>.status.json`. Raw debug logging is opt-in through `OPENCODE_CU_SCHEDULE_DEBUG_LOG=1` and writes `<name>.debug.log`.

## OpenCode config

Use `node scripts/install.mjs --dry-run` before applying. The installer backs up and merges the config, preserves explicit permission choices, installs the six Skills, and records enough state for conservative uninstall.
