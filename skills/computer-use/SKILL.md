---
name: computer-use
description: Entry point for operating real browsers and native Windows apps through the opencode-computer-use MCP server — when to use browser vs. windows/desktop tools, the mandatory observe-act-reobserve-verify loop, and how secrets are handled without ever exposing their plaintext.
metadata:
  provider: opencode-computer-use
---

# Computer Use

This is the top-level Skill for the `opencode-computer-use` MCP server. Load one of the
more specific Skills for the actual work — `browser-use`, `windows-app-testing`,
`web-app-testing`, `visual-verification`, `record-and-replay` — this one is for deciding
which applies and for the rules that apply to ALL of them.

## The mandatory rule: 観測 → 操作 → 再観測 → 検証

Every tool call in this server that mutates state already returns the REAL resulting state,
not a bare success flag (`browser_click` returns the post-click snapshot; `windows_invoke`
returns the re-resolved element; `desktop_click` returns the active window). This is not
optional plumbing you can ignore — it is the verification step, and skipping it is the most
common way an agent reports a task "done" when it silently failed or did something else.

For every action:
1. **観測 (observe)** — snapshot/read the current real state before acting (`browser_snapshot`,
   `windows_tree`/`windows_find`, `desktop_app_context`) so you're acting on a ref that
   actually exists right now.
2. **操作 (act)** — call the mutating tool.
3. **再観測 (re-observe)** — read the tool's own return value; it already contains the
   post-action state. Do not assume the action worked from its absence of an error alone.
4. **検証 (verify)** — check the re-observed state actually matches what you intended
   (`browser_assert_text`/`browser_assert_visible`, a value comparison, a screenshot diff via
   `visual-verification`). "The tool didn't throw" is not verification.

Skip step 4 only for pure reads. Any tool that changes page/window/OS state needs it.

## Which Skill to load

- Acting inside a real or agent-owned Chrome tab (clicking, typing, navigating, reading the
  DOM) → `browser-use`.
- Driving a native Windows application (Notepad, Settings, any desktop app) via UI
  Automation or, as a fallback, raw coordinates → `windows-app-testing`.
- Testing/verifying a web app end-to-end (functional + visual) → `web-app-testing` (composes
  `browser-use` + `visual-verification`).
- Comparing screenshots or detecting a visual regression specifically → `visual-verification`.
- Recording a sequence of actions once and replaying it later, parameterized →
  `record-and-replay`.

## Secrets: never touch the plaintext

Never ask the user to paste a password/token/API key into chat, and never type a literal
secret value via `browser_type`/`windows_set_value`. Two dedicated tools exist —
`browser_secret_fill` and `desktop_secret_type` — that resolve a NAMED secret from the local
Secret Broker (registered out-of-band by the user via `scripts/secret-cli.ps1`, DPAPI-
encrypted, bound to an origin or process name) and inject it directly. The value never comes
back to you. If a secret isn't registered yet, tell the user to run
`scripts/secret-cli.ps1 -Action register -Name <name> -Scope <origin-or-process>` themselves
— there is no tool that can write a secret value, by design.

If you ever see what looks like a real secret value in a tool result, that's a bug in this
server, not something to work around — stop and report it rather than using the value.

## Permission boundaries you don't control

Some tools require the user's explicit approval on every call (`browser_evaluate`,
`browser_attach`, `desktop_launch_app`, `desktop_close_window`, `desktop_kill_process`) and
some site/process actions are refused outright (chrome:// navigation while attached, a
process outside the window allowlist, killing this server's own/parent process). These
aren't obstacles to route around — if refused, explain why to the user rather than retrying
with a workaround.

There is deliberately NO origin-level gate on `browser_click`/`browser_type`/etc. themselves
(see `src/PERMISSION_COVERAGE.md` in this repo for why) — which means YOU are the gate for
actions that send a message, post content, or spend money. Ask the user in chat before
clicking Send/Submit/Buy/Post, exactly as the general orchestration rules already require.
