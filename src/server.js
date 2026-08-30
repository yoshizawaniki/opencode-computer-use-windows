#!/usr/bin/env node
// MCP stdio server entrypoint. Registers browser tools with OpenCode.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerBrowserTools } from "./tools/browser.js";
import { closeSession } from "./browser-session.js";

const server = new McpServer({ name: "opencode-computer-use", version: "0.1.0" });

registerBrowserTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

// SIGINT/SIGTERM aren't reliably delivered to child processes on Windows
// when the parent (OpenCode) tears down; the parent closing our stdin pipe
// is. Without this, a persistent, headless:false Chromium keeps the event
// loop alive forever and the process (plus its browser) leaks.
async function shutdown() {
  await closeSession();
  process.exit(0);
}
process.stdin.on("close", shutdown);
process.stdin.on("end", shutdown);
