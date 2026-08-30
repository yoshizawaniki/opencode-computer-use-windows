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
// need an IDENTIFIER-TOKEN boundary, not a plain \b: \b treats "_" as a word
// character and doesn't exist at all between camelCase humps, so \bkey\b
// matched "key" alone but missed session_key/sessionKey/pinCode entirely
// (found via independent audit, twice: first the unbounded version
// false-positived on "keyboard"/"Author", then the naive \b fix silently
// dropped real snake_case/camelCase field names). Callers MUST run
// splitIdentifierWords() on the candidate string before testing it against
// this pattern — the (^|[^a-z])...([^a-z]|$) boundary here is written
// against the SPLIT form, not the raw name.
export const SENSITIVE_NAME_PATTERN =
  "password|passwd|secret|token|csrf|cvv|api[-_]?key|access[-_]?key|private[-_]?key|(^|[^a-z])(key|auth|pin)([^a-z]|$)";

// "sessionKey" -> "session Key", "pinCode" -> "pin Code" — turns camelCase
// humps into separators so the identifier-token boundary above can see
// them. uia.ps1 keeps an equivalent [regex]::Replace() in ConvertTo-ElementJson.
export function splitIdentifierWords(name) {
  return String(name ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}
