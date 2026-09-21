#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const r =
  process.platform === "win32"
    ? spawnSync(
        process.env.ComSpec || "cmd.exe",
        ["/d", "/s", "/c", "npm pack --dry-run --json --ignore-scripts"],
        { cwd: root, encoding: "utf8" }
      )
    : spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: root,
        encoding: "utf8",
      });
if (r.status !== 0) throw new Error(r.stderr || r.stdout || "npm pack --dry-run failed");
const data = JSON.parse(r.stdout);
const files = data[0]?.files?.map((f) => f.path) || [];
const forbidden = files.filter((p) => /^(?:artifacts|node_modules|tests|docs\/history|\.git)(?:\/|$)/i.test(p) || /browser-profile/i.test(p));
const required = ["package.json", "README.md", "LICENSE", "src/server.js", "scripts/install.mjs", "scripts/uninstall.mjs"];
const missing = required.filter((p) => !files.includes(p));
if (forbidden.length || missing.length) {
  if (forbidden.length) console.error("forbidden package entries:\n" + forbidden.join("\n"));
  if (missing.length) console.error("missing required package entries:\n" + missing.join("\n"));
  process.exit(1);
}
console.log(`package content check passed: ${files.length} files; no artifacts/browser profiles/tests/history included`);
