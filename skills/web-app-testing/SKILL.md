---
name: web-app-testing
description: End-to-end functional and visual testing of a web app through the opencode-computer-use MCP server — composes browser-use, visual-verification, and record-and-replay into a repeatable test procedure with real pass/fail evidence, not claimed success.
metadata:
  provider: opencode-computer-use
---

# Web App Testing

Composes `browser-use`, `visual-verification`, and (for regression suites) `record-and-replay`.
Read those first. This Skill is the testing-specific discipline on top of them.

## A test is not "done" until it's verified against REAL state

Never report a test as passing because a click didn't throw. Every test step follows
観測 → 操作 → 再観測 → 検証 from `computer-use`, and the 検証 (verify) step must use one of:

- `browser_assert_text` / `browser_assert_visible` for functional assertions (a real DOM
  query result, not a guess from the snapshot text alone).
- `browser_screenshot` + `browser_screenshot_diff` for visual assertions — see
  `visual-verification`.
- `browser_performance` for timing regressions (TTFB/domContentLoaded/load).
- `browser_network_log` to confirm a request actually fired/succeeded (metadata only — status,
  ok, resourceType — never headers or bodies).
- `browser_console_log` to catch a JS error the UI didn't visibly surface.

If none of these actually confirm the intended behavior, say so explicitly rather than
reporting "looks correct."

## Structuring a test session

1. `browser_navigate` to the target page; `browser_snapshot` to see what's there.
2. Drive the flow via `browser-use`'s ref-based tools, checking `browser_last_dialog` if the
   app can show alert/confirm/prompt (auto-accepted so the page never hangs).
3. Assert the resulting state, not the absence of an exception.
4. For a flow you'll re-run repeatedly (regression, smoke test), record it once with
   `record-and-replay` and replay with different parameters instead of re-driving it by hand
   every time.

## Test data and secrets

Never type a real credential into a test — use `browser_secret_fill` with a registered test
account's secret name (see `computer-use`). Use `browser_upload` only with files placed under
`artifacts/uploads/` — this is enforced, not a convention.

## Reporting

State what you actually observed (the real assertion result, the real diff ratio, the real
console error text) rather than a bare pass/fail. If a step's tool call was refused by a
permission gate or the process/origin allowlist, that's a real result to report, not a
blocker to silently route around.
