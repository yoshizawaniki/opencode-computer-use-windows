// Single source of truth for "does this field name look sensitive" across
// every DOM/UIA reader in this codebase (snapshot.js, dom_query,
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
// them. Exported as a source string (not just the function below) because
// page.evaluate() callbacks run in the BROWSER context and can't `import`
// this module — they must reconstruct the same RegExp from this string via
// their own args, rather than each hand-copying the literal (that hand-copy
// is exactly how round 1's oversight happened). uia.ps1 keeps an equivalent
// [regex]::Replace() in ConvertTo-ElementJson — separate process/language,
// kept in sync by hand.
export const SPLIT_PATTERN_SOURCE = "([a-z0-9])([A-Z])";

export function splitIdentifierWords(name) {
  return String(name ?? "").replace(new RegExp(SPLIT_PATTERN_SOURCE, "g"), "$1 $2");
}

// Value-based scrubbing, separate from the name-based redaction above: this
// catches a secret AFTER secret-broker.js resolves it (e.g. via
// browser_secret_fill), regardless of which tool's output would otherwise
// echo it back — a read-back through browser_snapshot, browser_dom_query,
// visual OCR, or any future reader. Name-based redaction alone can't cover
// this because those readers don't know a given field was just filled from
// a secret. Every MCP tool result is scrubbed at the server.js choke point
// before it leaves the process, so new tools inherit this for free.
const knownSecretValues = new Set();

export function registerSecretValue(value) {
  if (typeof value === "string" && value.length >= 4) knownSecretValues.add(value);
}

export function scrubKnownSecrets(x) {
  if (knownSecretValues.size === 0) return x;
  if (typeof x === "string") {
    let out = x;
    for (const secret of knownSecretValues) out = out.split(secret).join("<redacted-secret>");
    return out;
  }
  if (Array.isArray(x)) return x.map(scrubKnownSecrets);
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, scrubKnownSecrets(v)]));
  return x;
}
