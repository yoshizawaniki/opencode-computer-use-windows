---
name: visual-verification
description: Confirm a UI change actually happened by comparing real screenshots (region capture, pixel diff, wait-for-visual-change) rather than trusting a tool call's success — through the opencode-computer-use MCP server, for both browser pages and native Windows windows.
metadata:
  provider: opencode-computer-use
---

# Visual Verification

Use this whenever the 検証 (verify) step from `computer-use` needs to confirm something
visual — a color change, a canvas render, a layout shift, an image that loaded — that DOM
assertions (`browser_assert_text`/`browser_assert_visible`) can't check.

## Browser

1. `browser_screenshot` (full page) or `browser_screenshot_region` (x/y/width/height) before
   acting, and again after.
2. `browser_screenshot_diff` — compares two saved PNGs, returns `changed` (bool) and the
   actual `diffRatio`, not just a claim. Default change threshold is 0.1% of pixels — small
   deliberate UI changes (e.g. one button's label) are detected even on a full-page
   screenshot; pass a custom threshold if you expect a very small or very large legitimate
   change region and the default is noisy either way.
3. `browser_wait_for_visual_change` when you need to wait for an animation/async render to
   settle before capturing the "after" state, rather than guessing a fixed delay.

Report the real `diffRatio`, not just "changed: true/false" — it's evidence, use it.

## Native Windows windows

`desktop_screenshot` (full screen or a specific window ref) and
`desktop_screenshot_region` (raw screen pixels) — there's no dedicated diff tool for desktop
screenshots yet; save both and compare descriptions, or use `browser_screenshot_diff` against
the two saved PNG paths (it works on any two same-format PNGs, not just browser ones).

## What this can't tell you

A pixel diff proves something changed and roughly how much — it does not tell you WHETHER the
change was the intended one. Pair it with a functional check (`browser_assert_text`, a
`windows_get_value` re-confirmation) when you can; use visual diff alone only when there's
genuinely no DOM/UIA signal for the thing you're checking.
