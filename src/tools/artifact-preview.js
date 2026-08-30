import { z } from "zod";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const ARTIFACTS_ROOT = path.join(ROOT, "artifacts");

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

// Same discipline as assertUploadAllowed/assertNavigateAllowed: scope to a
// known directory so a crafted path can't read arbitrary local files.
function assertPreviewAllowed(filePath) {
  const resolved = path.resolve(filePath);
  const base = path.resolve(ARTIFACTS_ROOT) + path.sep;
  if (!resolved.startsWith(base)) {
    throw new Error(`preview path "${filePath}" is outside ${ARTIFACTS_ROOT} — only files this server itself produced can be previewed`);
  }
  return resolved;
}

const TEXT_EXTENSIONS = new Set([".html", ".htm", ".md", ".markdown", ".txt", ".csv", ".json"]);
const TEXT_PREVIEW_MAX_CHARS = 5000;

// Minimal PNG dimension read (IHDR chunk, bytes 16-24) — avoids adding an
// image-parsing dependency for what's otherwise just a size confirmation.
function pngDimensions(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function registerArtifactPreviewTools(server) {
  server.registerTool(
    "artifact_preview",
    {
      title: "Preview an artifact file",
      description:
        "Confirms an artifact this server produced (under artifacts/) actually exists and shows what it " +
        "contains: HTML/Markdown/CSV/JSON/plain text are returned inline (truncated at " +
        `${TEXT_PREVIEW_MAX_CHARS} chars, with the real total length reported); PNG images additionally get ` +
        "real pixel dimensions read from the file header. Other binary formats (PDF, spreadsheets, other " +
        "images) return path/size/hash only — this server has no renderer for them, open the path directly " +
        "to view. Refuses any path outside artifacts/.",
      inputSchema: { filePath: z.string() },
    },
    async ({ filePath }) => {
      const resolved = assertPreviewAllowed(filePath);
      const stat = statSync(resolved);
      const ext = path.extname(resolved).toLowerCase();
      const result = { path: resolved, sizeBytes: stat.size, extension: ext };

      if (TEXT_EXTENSIONS.has(ext)) {
        const content = readFileSync(resolved, "utf8");
        result.kind = "text";
        result.totalChars = content.length;
        result.truncated = content.length > TEXT_PREVIEW_MAX_CHARS;
        result.preview = content.slice(0, TEXT_PREVIEW_MAX_CHARS);
      } else if (ext === ".png") {
        const buf = readFileSync(resolved);
        result.kind = "image";
        result.dimensions = pngDimensions(buf);
      } else {
        result.kind = "binary";
        result.note = "no in-server renderer for this format — open the path directly to view";
      }
      return text(result);
    }
  );
}
