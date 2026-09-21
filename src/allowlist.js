// Single choke point for "which process may this session's mutating
// Windows/Desktop tools touch". Design-doc requirement: mutation must not
// have a path around the permission boundary. Config-level `ask`/`deny`
// covers launch/close/kill (destructive); this covers everything else
// (invoke/set-value/click/type/etc.), which config permission is too coarse
// to scope to individual target apps.
const DEFAULT_ALLOWLIST = [];

export function currentAllowlist() {
  const env = process.env.OPENCODE_CU_WINDOW_ALLOWLIST;
  const list = env ? env.split(",").map((s) => s.trim()) : DEFAULT_ALLOWLIST;
  return list.map((s) => s.toLowerCase()).filter(Boolean);
}

export function assertProcessAllowed(processName) {
  const name = (processName || "").toLowerCase();
  const allowlist = currentAllowlist();
  if (!allowlist.includes(name)) {
    throw new Error(
      `process "${processName}" is not in the window/desktop tool allowlist (${allowlist.join(", ") || "none; deny-by-default"}). ` +
        "Add it to OPENCODE_CU_WINDOW_ALLOWLIST in the MCP server's environment to allow mutating it."
    );
  }
}
