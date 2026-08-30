#!/usr/bin/env node
// MCP stdio server entrypoint. Registers browser tools with OpenCode.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerBrowserTools } from "./tools/browser.js";
import { registerDevtoolsTools } from "./tools/devtools.js";
import { registerVisualTools } from "./tools/visual.js";
import { registerWindowsTools } from "./tools/windows.js";
import { registerDesktopTools } from "./tools/desktop.js";
import { registerWorkflowTools } from "./tools/workflow.js";
import { registerClipboardTools } from "./tools/clipboard.js";
import { registerNotifyTools } from "./tools/notify.js";
import { registerArtifactPreviewTools } from "./tools/artifact-preview.js";
import { closeSession } from "./browser-session.js";
import { scrubKnownSecrets } from "./redaction.js";
import { registerHandler } from "./tool-registry.js";
import { recordStep, captureBrowserTarget } from "./workflow.js";

const server = new McpServer({ name: "opencode-computer-use", version: "0.1.0" });

// Single choke point for (a) value-based secret scrubbing (see
// redaction.js) and (b) Record & Replay step capture (see workflow.js):
// wrap every tool's handler once here rather than touching each of the ~65
// tool call sites in tools/*.js. Also registers the (post-scrub) handler
// into tool-registry.js so workflow_replay can dispatch a tool call without
// a real MCP round-trip.
const registerTool = server.registerTool.bind(server);
server.registerTool = (name, meta, handler) => {
  const wrapped = async (...callArgs) => {
    // Must run BEFORE the handler: a click can change the very name
    // ("Go" -> "Clicked!") this needs, and the handler's own re-snapshot
    // would otherwise overwrite it first (see workflow.js).
    const preCapturedBrowserInfo = captureBrowserTarget(name, callArgs[0] ?? {});
    const result = await handler(...callArgs);
    const scrubbed = scrubKnownSecrets(result);
    await recordStep(name, callArgs[0] ?? {}, preCapturedBrowserInfo);
    return scrubbed;
  };
  registerHandler(name, wrapped);
  return registerTool(name, meta, wrapped);
};

registerBrowserTools(server);
registerDevtoolsTools(server);
registerVisualTools(server);
registerWindowsTools(server);
registerDesktopTools(server);
registerWorkflowTools(server);
registerClipboardTools(server);
registerNotifyTools(server);
registerArtifactPreviewTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

// SIGINT/SIGTERM aren't reliably delivered to child processes on Windows
// when the parent (OpenCode) tears down; the parent closing our stdin pipe
// is — usually. Without this, a persistent, headless:false Chromium keeps
// the event loop alive forever and the process (plus its browser) leaks.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await closeSession();
  process.exit(0);
}
process.stdin.on("close", shutdown);
process.stdin.on("end", shutdown);
process.stdin.on("error", shutdown);

// Observed in practice: a run where a tool call was denied by permission
// left the parent OpenCode process gone but this process's stdin never
// emitted close/end — an orphan that would otherwise run forever. Fall back
// to polling for parent liveness (ponytail: a 5s poll, not a proper process
// group / job object — fine because it only ever triggers a shutdown that
// was already going to happen).
const parentPid = process.ppid;
setInterval(() => {
  try {
    process.kill(parentPid, 0); // throws if the parent is gone
  } catch (e) {
    // ESRCH = no such process = parent is actually gone. Anything else
    // (e.g. EPERM, which Windows can throw for a live process this one
    // doesn't have rights to signal) must NOT be treated as "parent died" —
    // that would silently kill a live session's browser.
    if (e.code === "ESRCH") shutdown();
  }
}, 5000).unref();
