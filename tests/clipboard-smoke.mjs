// Real Windows clipboard E2E. Hosted CI runners do not provide a reliable
// interactive clipboard station, so this is an explicit local/manual release
// gate rather than part of the isolated browser suite.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

if (process.platform !== "win32") {
  console.log("SKIP: clipboard-smoke.mjs only runs on Windows");
  process.exit(0);
}

const root = path.resolve(import.meta.dirname, "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src", "server.js")],
});
const client = new Client({ name: "clipboard-smoke-test", version: "0.1.0" });
await client.connect(transport);

function must(condition, message) {
  if (!condition) throw new Error("FAIL: " + message);
  console.log("PASS:", message);
}

try {
  const originalResult = await client.callTool({
    name: "clipboard_read",
    arguments: { includeValue: true },
  });
  const original = JSON.parse(originalResult.content[0].text).value ?? "";
  const marker = "opencode-clipboard-smoke-test-98765";

  try {
    await client.callTool({ name: "clipboard_write", arguments: { text: marker } });
    const readDefault = JSON.parse(
      (await client.callTool({ name: "clipboard_read", arguments: {} })).content[0].text
    );
    must(
      readDefault.length === marker.length,
      `clipboard_read reports the real length by default, got ${readDefault.length}`
    );
    must(!("value" in readDefault), "clipboard_read omits the raw value by default");

    const readValue = JSON.parse(
      (
        await client.callTool({
          name: "clipboard_read",
          arguments: { includeValue: true },
        })
      ).content[0].text
    );
    must(
      readValue.value === marker,
      "clipboard_read with includeValue:true returns the real value that was written"
    );
  } finally {
    await client.callTool({ name: "clipboard_write", arguments: { text: original } });
  }
} finally {
  await client.close();
}

console.log("\nALL CLIPBOARD E2E TESTS PASSED");
