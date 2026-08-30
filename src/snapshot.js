// Simplified ref-tagged accessibility snapshot: "[3] button \"Save\"" style,
// so tools never need to dump full HTML to the LLM. Refs are re-assigned on
// every snapshot() call; stale refs from a prior snapshot are rejected.
import { SENSITIVE_NAME_PATTERN, SPLIT_PATTERN_SOURCE } from "./redaction.js";

let currentRefs = new Set();
let lastElementInfo = new Map(); // ref -> {role, name}, for Record & Replay target descriptors
let generation = 0;

const INTERACTIVE_SELECTOR =
  "button, a[href], input, textarea, select, summary, [role], [onclick], [tabindex]";
const MAX_ELEMENTS = 150; // never dump an unbounded tree at the LLM

export async function snapshot(page) {
  generation += 1;
  const gen = generation;
  const { elements, truncated } = await page.evaluate(
    ({ selector, gen, max, sensitivePattern, splitPattern }) => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
      };
      const sensitiveRe = new RegExp(sensitivePattern, "i");
      // Splits camelCase humps ("sessionKey" -> "session Key") so the
      // identifier-token boundary in sensitivePattern can see them —
      // snake_case already has "_" as a non-letter separator. Pattern comes
      // from redaction.js via args, not a hand-copied literal.
      const splitRe = new RegExp(splitPattern, "g");
      const splitWords = (s) => String(s || "").replace(splitRe, "$1 $2");
      const isSensitiveInput = (el) =>
        el.tagName === "INPUT" &&
        (el.type === "password" ||
          sensitiveRe.test(splitWords(el.name)) ||
          sensitiveRe.test(splitWords(el.id)) ||
          sensitiveRe.test(splitWords(el.getAttribute("aria-label"))));
      const inputValue = (el) => {
        if (el.tagName !== "INPUT") return "";
        if (isSensitiveInput(el)) return el.value ? `<redacted, length=${el.value.length}>` : "";
        return el.value || "";
      };
      const accessibleName = (el) =>
        el.getAttribute("aria-label") ||
        el.getAttribute("alt") ||
        el.getAttribute("placeholder") ||
        inputValue(el) ||
        el.innerText?.trim().slice(0, 80) ||
        el.getAttribute("title") ||
        "";
      const roleOf = (el) => el.getAttribute("role") || el.tagName.toLowerCase();

      const all = Array.from(document.querySelectorAll(selector)).filter(isVisible);
      const nodes = all.slice(0, max);
      const elements = nodes.map((el, i) => {
        const ref = `${gen}-${i}`;
        el.setAttribute("data-oc-ref", ref);
        return { ref, role: roleOf(el), name: accessibleName(el), sensitive: isSensitiveInput(el) };
      });
      return { elements, truncated: all.length > max };
    },
    { selector: INTERACTIVE_SELECTOR, gen, max: MAX_ELEMENTS, sensitivePattern: SENSITIVE_NAME_PATTERN, splitPattern: SPLIT_PATTERN_SOURCE }
  );

  currentRefs = new Set(elements.map((e) => e.ref));
  lastElementInfo = new Map(elements.map((e) => [e.ref, { role: e.role, name: e.name, sensitive: e.sensitive }]));
  const url = page.url();
  const title = await page.title();
  let text = elements.map((e) => `[${e.ref}] ${e.role} "${e.name}"`).join("\n");
  if (truncated) text += `\n… truncated at ${MAX_ELEMENTS} elements, page has more`;
  return { url, title, elements, text, truncated };
}

export function assertFreshRef(ref) {
  if (!currentRefs.has(ref)) {
    throw new Error(
      `stale or unknown ref "${ref}" — call browser_snapshot again before acting on this page`
    );
  }
}

export function locatorFor(page, ref) {
  assertFreshRef(ref);
  return page.locator(`[data-oc-ref="${ref}"]`);
}

// role+name descriptor for the given ref, as of the most recent snapshot() —
// used by workflow.js to record a semantic (not raw-ref) target, since refs
// are regenerated every snapshot and can't be replayed later as-is.
export function elementInfoFor(ref) {
  return lastElementInfo.get(ref) ?? null;
}

// Finds the ref (from the CURRENT tracked snapshot) whose role+name best
// matches a recorded descriptor — the resolution step Record & Replay needs
// at replay time, when the original ref no longer exists. Exact match first,
// falling back to name-only (role can drift, e.g. a generic [onclick] div
// picked up as a different role after a page redesign) — an ambiguous match
// (>1 candidate) is refused rather than silently picking one.
export function resolveRefByDescriptor({ role, name }) {
  const exact = [...lastElementInfo.entries()].filter(([, v]) => v.role === role && v.name === name);
  if (exact.length === 1) return exact[0][0];
  if (exact.length > 1) throw new Error(`ambiguous target: ${exact.length} elements match role="${role}" name="${name}"`);
  const byName = [...lastElementInfo.entries()].filter(([, v]) => v.name === name);
  if (byName.length === 1) return byName[0][0];
  if (byName.length > 1) throw new Error(`ambiguous target: ${byName.length} elements match name="${name}" (role changed from "${role}")`);
  throw new Error(`no element on the current page matches recorded target role="${role}" name="${name}" — call browser_snapshot to see what's there now`);
}
