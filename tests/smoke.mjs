// Standalone MCP client smoke test — exercises the server directly (no OpenCode)
// so bugs are caught before wiring into the real CLI.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const fixtureUrl = pathToFileURL(path.join(root, "tests", "fixtures", "basic.html")).href;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src", "server.js")],
});
const client = new Client({ name: "smoke-test", version: "0.1.0" });
await client.connect(transport);

function must(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("PASS:", msg);
}

const tools = await client.listTools();
must(tools.tools.some((t) => t.name === "browser_navigate"), "browser_navigate is registered");
must(tools.tools.some((t) => t.name === "browser_click"), "browser_click is registered");

const nav = await client.callTool({ name: "browser_navigate", arguments: { url: fixtureUrl } });
const navState = JSON.parse(nav.content[0].text);
must(navState.title === "OC Fixture", "navigate returns real post-nav title, got: " + navState.title);
must(navState.snapshot.includes('button "Go"'), "navigate snapshot lists the Go button");

const snap = await client.callTool({ name: "browser_snapshot", arguments: {} });
const snapText = snap.content[0].text;
const m = snapText.match(/\[([\d-]+)\] button "Go"/);
must(m, "snapshot exposes a ref for the Go button");
const goRef = m[1];

const click = await client.callTool({ name: "browser_click", arguments: { ref: goRef } });
const clickState = JSON.parse(click.content[0].text);
must(
  clickState.snapshot.includes('button "Clicked!"'),
  "click return value reflects the ACTUAL post-click DOM state, not just success"
);

// Negative test 1: acting on a nonexistent ref must fail loudly, not silently succeed.
let threw = false;
try {
  await client.callTool({ name: "browser_click", arguments: { ref: "999-999" } });
} catch (e) {
  threw = true;
}
if (!threw) {
  const badResult = await client.callTool({ name: "browser_click", arguments: { ref: "999-999" } });
  threw = badResult.isError === true;
}
must(threw, "clicking a nonexistent ref is reported as a real failure");

// Negative test 2: a stale ref (from before a navigation) must be rejected, not silently reused.
await client.callTool({ name: "browser_navigate", arguments: { url: fixtureUrl } });
let staleRejected = false;
try {
  const r = await client.callTool({ name: "browser_click", arguments: { ref: goRef } });
  staleRejected = r.isError === true;
} catch {
  staleRejected = true;
}
must(staleRejected, "reusing a ref from a prior snapshot generation is rejected as stale");

await client.close();
console.log("\nALL SMOKE TESTS PASSED");
process.exit(0);
