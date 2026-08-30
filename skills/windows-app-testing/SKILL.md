---
name: windows-app-testing
description: Drive and test native Windows applications via UI Automation (windows_* tools) with raw-coordinate desktop_* tools as a last-resort fallback, through the opencode-computer-use MCP server — element addressing, focus caveats, and the process allowlist.
metadata:
  provider: opencode-computer-use
---

# Windows App Testing

Read `computer-use` first — this Skill assumes its observe→act→re-observe→verify rule.

## Prefer UI Automation over raw coordinates

`windows_*` tools address elements semantically (automationId/name/controlType), which
survives window moves/resizes/DPI changes — always try these first:

1. `windows_list` / `windows_active` — find the target window.
2. `windows_tree` (ref-tagged element tree, capped) or `windows_find`
   (automationId/name/controlType search) to get an element ref.
3. Act: `windows_set_value`, `windows_invoke` (click-equivalent), `windows_toggle`,
   `windows_select`, `windows_focus`. Each is gated by the window allowlist (refuses if the
   target process isn't allowlisted) and returns the ACTUAL re-resolved element state — read
   it, don't assume success from the absence of an error.
4. `windows_get_value` to re-confirm, or `windows_wait_for` to poll for an expected element
   to appear.

Only fall back to `desktop_*` (raw SendInput coordinates) when a control genuinely isn't
addressable via UIA (rare, but some custom-drawn controls have no automation tree).
`desktop_click`/`desktop_drag`/`desktop_scroll` refuse if the window under the point isn't
allowlisted.

## Refs are re-resolved every call, but can go stale

A ref encodes `hwnd|pid|path`. If the hwnd gets reused by an unrelated process (real Windows
behavior on a busy desktop) the pid check catches it and the call is refused as stale — don't
retry blindly, re-fetch via `windows_list`/`windows_tree` first.

## The OS-focus gap (read before using desktop_type_text/desktop_key)

`windows_focus` sets UIA logical focus, which does NOT guarantee the app becomes the OS-level
foreground window that `desktop_type_text`/`desktop_key` (real SendInput) actually targets.
If you need raw keyboard input, call `desktop_click` on the target field FIRST — that
reliably establishes real OS focus — rather than `windows_focus` alone. Prefer
`windows_set_value` when the target supports it; it doesn't depend on OS focus at all.

## Secrets

`desktop_secret_type` resolves a registered secret by name and types it via SendInput to
whatever has focus — never type a literal password with `desktop_key`/`desktop_type_text`,
and never put a literal secret value in `windows_set_value` either. See `computer-use`.

## Launching, closing, killing (all require explicit user approval)

`desktop_launch_app`, `desktop_close_window`, `desktop_kill_process` each require the user's
approval on every call. `desktop_kill_process` refuses to target this server's own/parent
process or reserved pids regardless of approval. Some Windows 11 packaged apps
(observed with notepad.exe) share ONE host process across all their windows — killing it
closes every window of that app, not just one; prefer `desktop_close_window` for a single
window when that might be the case, and the launched pid may be a short-lived launcher stub,
not the pid that ends up owning the window — use `windows_list` afterward to find it.
