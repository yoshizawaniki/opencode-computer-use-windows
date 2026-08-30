import { z } from "zod";
import { callClipboard } from "../clipboard.js";

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

export function registerClipboardTools(server) {
  server.registerTool(
    "clipboard_read",
    {
      title: "Read the clipboard (metadata by default)",
      description:
        "Reads the current text clipboard content. By DEFAULT returns metadata only — length and sha256 — " +
        "never the actual text, because the clipboard routinely carries pasted secrets. Pass includeValue:true " +
        "to also get the raw text; this tool is gated by config permission (ask) regardless, so the user " +
        "approves every read either way.",
      inputSchema: { includeValue: z.boolean().default(false) },
    },
    async ({ includeValue }) => {
      const data = await callClipboard({ action: "read" });
      const result = { length: data.length, sha256: data.sha256 };
      if (includeValue) result.value = data.value;
      return text(result);
    }
  );

  server.registerTool(
    "clipboard_write",
    {
      title: "Write text to the clipboard",
      description: "Sets the clipboard to the given text, then returns its length (not the text) for confirmation.",
      inputSchema: { text: z.string() },
    },
    async ({ text: value }) => text(await callClipboard({ action: "write", text: value }))
  );
}
