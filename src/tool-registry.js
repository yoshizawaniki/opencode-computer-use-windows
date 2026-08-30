// Records the (post-scrub) handler function for every registered MCP tool,
// keyed by name. Two consumers: workflow.js's replay dispatcher (calls a
// tool by name without a real MCP round-trip) and, indirectly, the
// recording hook in server.js (which wraps the SAME handlers). This avoids
// refactoring every tools/*.js file to export standalone functions — the
// registerTool wrapper in server.js already sees every handler once.
const handlers = new Map();

export function registerHandler(name, handler) {
  handlers.set(name, handler);
}

export function getHandler(name) {
  const h = handlers.get(name);
  if (!h) throw new Error(`no such tool "${name}"`);
  return h;
}

export function hasHandler(name) {
  return handlers.has(name);
}
