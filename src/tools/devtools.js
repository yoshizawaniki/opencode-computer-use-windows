import { z } from "zod";
import {
  getActivePage,
  getContext,
  getActiveTabId,
  getConsoleLogs,
  getNetworkLogs,
  clearConsoleLogs,
  clearNetworkLogs,
  getMode,
} from "../browser-session.js";
import { SENSITIVE_NAME_PATTERN } from "../redaction.js";

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

// Secret non-exposure: cookies/localStorage/sessionStorage are returned as
// metadata ONLY (name/domain/expiry/flags, or key/length) — never the value.
// This is a whitelist, not a delete-list, so a future Playwright field never
// leaks by accident.
const COOKIE_FIELDS = ["name", "domain", "path", "expires", "httpOnly", "secure", "sameSite"];

export function registerDevtoolsTools(server) {
  server.registerTool(
    "browser_console_log",
    {
      title: "Read console log",
      description: "Returns buffered console messages (type/text/timestamp, capped) for the active tab.",
      inputSchema: { clear: z.boolean().default(false).describe("clear the buffer after reading") },
    },
    async ({ clear }) => {
      const id = getActiveTabId();
      const logs = getConsoleLogs(id);
      if (clear) clearConsoleLogs(id);
      return text(logs);
    }
  );

  server.registerTool(
    "browser_network_log",
    {
      title: "Read network log",
      description:
        "Returns buffered network requests for the active tab: url/method/resourceType/status/ok/failure/timestamp " +
        "(capped, metadata only — no headers or bodies, which routinely carry auth tokens).",
      inputSchema: { clear: z.boolean().default(false).describe("clear the buffer after reading") },
    },
    async ({ clear }) => {
      const id = getActiveTabId();
      const logs = getNetworkLogs(id);
      if (clear) clearNetworkLogs(id);
      return text(logs);
    }
  );

  server.registerTool(
    "browser_dom_query",
    {
      title: "Query the DOM",
      description:
        "Runs a fixed, safe query (not arbitrary code) against the active page: returns matching elements' " +
        "tagName/id/className/text (truncated)/attributes for the given CSS selector.",
      inputSchema: { selector: z.string(), limit: z.number().default(50) },
    },
    async ({ selector, limit }) => {
      const page = await getActivePage();
      const result = await page.evaluate(
        ({ selector, limit, sensitivePattern }) => {
          const nodes = Array.from(document.querySelectorAll(selector)).slice(0, limit);
          const sensitiveRe = new RegExp(sensitivePattern, "i");
          return nodes.map((el) => {
            // `value` on an <input> and `content` on a csrf/token/auth/secret/key
            // <meta> tag are exactly the kind of secret the cookie/storage
            // tools redact — dom_query must not become the bypass route for it.
            const isSecretMeta =
              el.tagName === "META" && sensitiveRe.test(el.getAttribute("name") || el.getAttribute("property") || "");
            const attributes = Object.fromEntries(
              Array.from(el.attributes).map((a) => {
                const redact = (a.name === "value" && el.tagName === "INPUT") || (a.name === "content" && isSecretMeta);
                return redact ? [a.name, `<redacted, length=${a.value.length}>`] : [a.name, a.value];
              })
            );
            return {
              tagName: el.tagName.toLowerCase(),
              id: el.id || null,
              className: el.className || null,
              text: (el.textContent || "").trim().slice(0, 200),
              attributes,
            };
          });
        },
        { selector, limit, sensitivePattern: SENSITIVE_NAME_PATTERN }
      );
      return text({ selector, count: result.length, elements: result });
    }
  );

  server.registerTool(
    "browser_computed_style",
    {
      title: "Get computed style",
      description: "Returns the computed CSS values for the given property names on the element with the given ref.",
      inputSchema: { ref: z.string(), properties: z.array(z.string()) },
    },
    async ({ ref, properties }) => {
      const page = await getActivePage();
      const result = await page.evaluate(
        ({ ref, properties }) => {
          const el = document.querySelector(`[data-oc-ref="${ref}"]`);
          if (!el) return null;
          const style = getComputedStyle(el);
          return Object.fromEntries(properties.map((p) => [p, style.getPropertyValue(p)]));
        },
        { ref, properties }
      );
      if (!result) throw new Error(`ref "${ref}" not found on the current page — call browser_snapshot again`);
      return text(result);
    }
  );

  server.registerTool(
    "browser_performance",
    {
      title: "Get basic page performance metrics",
      description: "Returns navigation timing (TTFB, domContentLoaded, load) in ms for the active page.",
      inputSchema: {},
    },
    async () => {
      const page = await getActivePage();
      const timing = await page.evaluate(() => {
        const [nav] = performance.getEntriesByType("navigation");
        if (!nav) return null;
        return {
          ttfbMs: Math.round(nav.responseStart - nav.requestStart),
          domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
          loadMs: Math.round(nav.loadEventEnd),
          transferSizeBytes: nav.transferSize ?? null,
        };
      });
      return text(timing ?? { message: "no navigation timing entry available yet" });
    }
  );

  server.registerTool(
    "browser_cookies",
    {
      title: "List cookies (metadata only)",
      description:
        "Returns cookie metadata for the active tab's context — name/domain/path/expires/httpOnly/secure/sameSite, " +
        "plus hasValue and valueLength. The actual cookie VALUE is never returned (secret non-exposure).",
      inputSchema: {},
    },
    async () => {
      const context = await getContext();
      const cookies = await context.cookies();
      const scrubbed = cookies.map((c) => {
        const out = Object.fromEntries(COOKIE_FIELDS.map((f) => [f, c[f] ?? null]));
        out.hasValue = Boolean(c.value);
        out.valueLength = c.value?.length ?? 0;
        return out;
      });
      return text(scrubbed);
    }
  );

  server.registerTool(
    "browser_storage",
    {
      title: "List localStorage/sessionStorage keys (metadata only)",
      description:
        "Returns localStorage/sessionStorage KEY names and value lengths for the active page's origin. " +
        "Values themselves are never returned (secret non-exposure).",
      inputSchema: {},
    },
    async () => {
      const page = await getActivePage();
      const result = await page.evaluate(() => {
        const scrub = (store) =>
          Object.keys(store).map((key) => ({ key, valueLength: (store.getItem(key) || "").length }));
        return { localStorage: scrub(window.localStorage), sessionStorage: scrub(window.sessionStorage) };
      });
      return text(result);
    }
  );

  server.registerTool(
    "browser_assert_visible",
    {
      title: "Assert an element is visible",
      description:
        "Checks whether at least one element matching the CSS selector is currently visible on the active " +
        "page, and returns the real count found (0 means not present/not visible) — never a bare true/false claim.",
      inputSchema: { selector: z.string() },
    },
    async ({ selector }) => {
      const page = await getActivePage();
      const count = await page.evaluate((selector) => {
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
        };
        return Array.from(document.querySelectorAll(selector)).filter(isVisible).length;
      }, selector);
      return text({ selector, visibleCount: count, present: count > 0 });
    }
  );

  server.registerTool(
    "browser_assert_text",
    {
      title: "Assert text is present",
      description: "Checks whether the given text currently appears in the active page's visible text content.",
      inputSchema: { text: z.string() },
    },
    async ({ text: needle }) => {
      const page = await getActivePage();
      const found = await page.evaluate((needle) => document.body.innerText.includes(needle), needle);
      return text({ needle, present: found });
    }
  );

  const EVAL_ENABLED = process.env.OPENCODE_CU_ALLOW_EVAL === "1";
  server.registerTool(
    "browser_evaluate",
    {
      title: "Evaluate arbitrary JavaScript in the page",
      description:
        "DANGEROUS: runs arbitrary JS in the page context, which has this session's real cookies and can call " +
        "fetch() with them. Disabled by default; requires OPENCODE_CU_ALLOW_EVAL=1 in the server's environment " +
        "AND config permission set to ask/allow. Return value is JSON-stringified and truncated to 2000 chars. " +
        "ALWAYS refused when attached to an external Chrome (browser_attach) regardless of the env var — that " +
        "would let arbitrary JS read the user's real, logged-in session directly.",
      inputSchema: { expression: z.string().describe("JS expression to evaluate") },
    },
    async ({ expression }) => {
      if (getMode() === "attach") {
        throw new Error("browser_evaluate is always refused while attached to an external Chrome (browser_attach session)");
      }
      if (!EVAL_ENABLED) {
        throw new Error(
          "browser_evaluate is disabled (set OPENCODE_CU_ALLOW_EVAL=1 in the MCP server's environment to enable it)"
        );
      }
      const page = await getActivePage();
      const result = await page.evaluate(expression);
      const serialized = JSON.stringify(result ?? null);
      return text(serialized.length > 2000 ? serialized.slice(0, 2000) + "…truncated" : serialized);
    }
  );
}
