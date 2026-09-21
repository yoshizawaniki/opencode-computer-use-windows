import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function parseOriginList(name) {
  const raw = process.env[name]?.trim();
  if (!raw) return new Set();
  const result = new Set();
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    let url;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`${name} contains an invalid origin: ${entry}`);
    }
    if (!/^https?:$/.test(url.protocol) || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`${name} entries must be exact http(s) origins such as https://example.com (got ${entry})`);
    }
    result.add(url.origin);
  }
  return result;
}

function isProjectFile(url) {
  if (url.protocol !== "file:") return false;
  const filePath = decodeURIComponent(url.pathname).replace(/^\/([a-zA-Z]:)/, "$1");
  const resolved = path.resolve(filePath);
  const root = path.resolve(ROOT);
  return resolved === root || resolved.startsWith(root + path.sep);
}

export function describeBrowserMutationPolicy(mode = "launch") {
  return {
    mode,
    safeDefaults: mode === "launch" ? ["loopback http(s), any port", "file:// under project root"] : [],
    configuredOrigins: [...parseOriginList(mode === "attach" ? "OPENCODE_CU_ATTACH_ORIGINS" : "OPENCODE_CU_BROWSER_ORIGINS")],
  };
}

export function assertBrowserMutationAllowed(urlString, { mode = "launch" } = {}) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`browser mutation refused: active page has an invalid URL (${urlString})`);
  }

  if (mode === "launch") {
    if ((url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname)) return;
    if (isProjectFile(url)) return;
    const allowed = parseOriginList("OPENCODE_CU_BROWSER_ORIGINS");
    if (allowed.has(url.origin)) return;
    throw new Error(
      `browser mutation refused for origin ${url.origin}. ` +
        "By default only loopback http(s) and project-local file:// pages are mutable. " +
        "Add the exact external origin to OPENCODE_CU_BROWSER_ORIGINS to opt in."
    );
  }

  // Attach mode intentionally has no implicit localhost/file allowance. A
  // user-owned Chrome session is a higher-trust boundary, so every origin
  // must be named separately even if launch mode would allow it by default.
  const attachAllowed = parseOriginList("OPENCODE_CU_ATTACH_ORIGINS");
  if ((url.protocol === "http:" || url.protocol === "https:") && attachAllowed.has(url.origin)) return;
  throw new Error(
    `browser mutation refused while attached to Chrome for origin ${url.origin}. ` +
      "Add the exact origin to OPENCODE_CU_ATTACH_ORIGINS to opt in for attach-mode mutation."
  );
}
