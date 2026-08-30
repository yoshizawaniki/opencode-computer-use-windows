// Simplified ref-tagged accessibility snapshot: "[3] button \"Save\"" style,
// so tools never need to dump full HTML to the LLM. Refs are re-assigned on
// every snapshot() call; stale refs from a prior snapshot are rejected.
import { SENSITIVE_NAME_PATTERN } from "./redaction.js";

let currentRefs = new Set();
let generation = 0;

const INTERACTIVE_SELECTOR =
  "button, a[href], input, textarea, select, summary, [role], [onclick], [tabindex]";
const MAX_ELEMENTS = 150; // never dump an unbounded tree at the LLM

export async function snapshot(page) {
  generation += 1;
  const gen = generation;
  const { elements, truncated } = await page.evaluate(
    ({ selector, gen, max, sensitivePattern }) => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
      };
      const sensitiveRe = new RegExp(sensitivePattern, "i");
      // Splits camelCase humps ("sessionKey" -> "session Key") so the
      // identifier-token boundary in sensitivePattern can see them —
      // snake_case already has "_" as a non-letter separator.
      const splitWords = (s) => String(s || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
      const inputValue = (el) => {
        if (el.tagName !== "INPUT") return "";
        const isSensitive =
          el.type === "password" ||
          sensitiveRe.test(splitWords(el.name)) ||
          sensitiveRe.test(splitWords(el.id)) ||
          sensitiveRe.test(splitWords(el.getAttribute("aria-label")));
        if (isSensitive) return el.value ? `<redacted, length=${el.value.length}>` : "";
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
        return { ref, role: roleOf(el), name: accessibleName(el) };
      });
      return { elements, truncated: all.length > max };
    },
    { selector: INTERACTIVE_SELECTOR, gen, max: MAX_ELEMENTS, sensitivePattern: SENSITIVE_NAME_PATTERN }
  );

  currentRefs = new Set(elements.map((e) => e.ref));
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
