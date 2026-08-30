// Single source of truth for "does this field name look sensitive" across
// every DOM/UIA reader in this codebase (snapshot.js, dom_query, cookies,
// UIA's ConvertTo-ElementJson). Found via independent audit: snapshot.js
// was written before this pattern existed anywhere and never redacted
// input values at all — every mutating browser tool (observedState() calls
// snapshot()) was shipping password-field plaintext to the LLM. A single
// exported pattern, threaded into each page.evaluate() call via args (the
// browser-context functions below can't `import` this module directly),
// makes that class of oversight structurally harder to repeat.
// uia.ps1 is a separate process/language and keeps its own copy of this
// same pattern in ConvertTo-ElementJson — keep the two in sync by hand.
// Long/specific words match anywhere (substring) — they're unlikely to
// collide with unrelated names. Short/generic words ("key", "auth", "pin")
// are word-bounded — an unbounded match on those false-positived on
// ordinary UI text ("keyboard", "Author", "spinner") and started silently
// hiding real, harmless values (found via independent audit: this exact
// broadening had just been made without the boundary and regressed UIA
// element names). Keep it this way if adding more short words.
export const SENSITIVE_NAME_PATTERN = "password|passwd|secret|token|csrf|cvv|api[-_]?key|access[-_]?key|private[-_]?key|\\bkey\\b|\\bauth\\b|\\bpin\\b";
