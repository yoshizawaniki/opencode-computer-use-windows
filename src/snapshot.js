// Simplified ref-tagged accessibility snapshot: "[3] button \"Save\"" style,
// so tools never need to dump full HTML to the LLM. Refs are re-assigned on
// every snapshot() call; stale refs from a prior snapshot are rejected.

let currentRefs = new Set();
let generation = 0;

const INTERACTIVE_SELECTOR =
  "button, a[href], input, textarea, select, summary, [role], [onclick], [tabindex]";

export async function snapshot(page) {
  generation += 1;
  const gen = generation;
  const elements = await page.evaluate(
    ({ selector, gen }) => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
      };
      const accessibleName = (el) =>
        el.getAttribute("aria-label") ||
        el.getAttribute("alt") ||
        el.getAttribute("placeholder") ||
        (el.tagName === "INPUT" ? el.value : "") ||
        el.innerText?.trim().slice(0, 80) ||
        el.getAttribute("title") ||
        "";
      const roleOf = (el) => el.getAttribute("role") || el.tagName.toLowerCase();

      const nodes = Array.from(document.querySelectorAll(selector)).filter(isVisible);
      return nodes.map((el, i) => {
        const ref = `${gen}-${i}`;
        el.setAttribute("data-oc-ref", ref);
        return { ref, role: roleOf(el), name: accessibleName(el) };
      });
    },
    { selector: INTERACTIVE_SELECTOR, gen }
  );

  currentRefs = new Set(elements.map((e) => e.ref));
  const url = page.url();
  const title = await page.title();
  const text = elements.map((e) => `[${e.ref}] ${e.role} "${e.name}"`).join("\n");
  return { url, title, elements, text };
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
