#!/usr/bin/env node
// MCP stdio server entrypoint. Registers browser tools with OpenCode.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerBrowserTools } from "./tools/browser.js";

const server = new McpServer({ name: "opencode-computer-use", version: "0.1.0" });

registerBrowserTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
