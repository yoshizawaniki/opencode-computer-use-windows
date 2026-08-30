---
name: browser-use
description: Operate a real Chromium browser (agent-owned or attached to the user's real Chrome) via the opencode-computer-use MCP server — navigation, clicking, typing, tabs, downloads, secrets, and the observe-act-reobserve-verify loop for every action.
metadata:
  provider: opencode-computer-use
---

# Browser Use

Read `computer-use` first if you haven't — this Skill assumes its observe→act→re-observe→
verify rule and secret-handling rule.

## Core loop, concretely

1. `browser_snapshot` — get current URL/title and ref-tagged interactive elements
   (`[2-4] button "Save"`). Refs are regenerated on EVERY snapshot; a ref from an earlier
   snapshot is rejected as stale — always snapshot right before acting, not once at the
   start of a multi-step flow.
2. Act on a ref: `browser_click`, `browser_type`, `browser_select`, `browser_hover`,
   `browser_upload`. Each already returns the post-action snapshot — that IS your
   re-observation, read it.
3. Verify the result matches intent: `browser_assert_text`/`browser_assert_visible` for a
   quick check, or hand off to `visual-verification` for a screenshot diff when the change is
   visual rather than textual (e.g. a canvas, a color change).

Non-ref actions: `browser_navigate`, `browser_back`/`forward`/`reload`, `browser_scroll`,
`browser_key`, `browser_wait`. All return real resulting state too.

## Secrets

Use `browser_secret_fill` (ref + registered secret name) for any password/API key/token
field — never `browser_type` with a literal value. It refuses if the secret's registered
scope doesn't match the current page's origin. See `computer-use` for registration.

## Tabs and popups

`browser_tabs_list` / `browser_tab_new` / `browser_tab_select` / `browser_tab_close`. A click
that opens a new tab automatically makes it active — `browser_click`'s returned state
reflects the NEW tab, not the one you clicked from. Check `browser_tabs_list` if you're
unsure which tab is active.

## Reading without exposing secrets

`browser_dom_query`, `browser_cookies` (metadata only — name/domain/expiry/flags, never the
value), `browser_storage` (key + length only), `browser_console_log`, `browser_network_log`
(metadata only, no headers/bodies). `browser_evaluate` runs arbitrary JS with real
cookies/fetch access — disabled by default, requires an env var AND config permission, and is
always refused when attached to the user's real Chrome (`browser_attach`).

## Downloads

`browser_click_and_wait_for_download` saves under `artifacts/downloads/`, and returns the
real saved path, byte size, and sha256 — that hash IS your integrity verification, use it
rather than assuming the download matched what you expected.

## Attaching to the user's real Chrome

`browser_attach` (requires explicit user approval) connects to an already-running Chrome
started with `--remote-debugging-port`. Recommended: a dedicated Chrome window the user logs
into once, not their everyday browser. Existing tabs are listed but NOT operable (no
console/network capture, no auto-accepted dialogs) until you `browser_tab_select` one —
don't select a tab you don't need to act on. `browser_detach` disconnects without closing
anything. While attached, `chrome://`/`devtools://`/`chrome-extension://` navigation and
`browser_evaluate` are always blocked.
