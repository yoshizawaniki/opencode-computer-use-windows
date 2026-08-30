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
export const SENSITIVE_NAME_PATTERN = "password|secret|token|pin|cvv|csrf|auth|key";

export function redact(value) {
  return `<redacted, length=${String(value ?? "").length}>`;
}
