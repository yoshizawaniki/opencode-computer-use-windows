#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const git = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" });
if (git.status !== 0) throw new Error(git.stderr || "git ls-files failed");
const files = git.stdout.split("\0").filter(Boolean);
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["OpenAI-style secret key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["GitHub token", /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["JWT-like credential", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
];
const findings = [];
for (const rel of files) {
  const full = path.join(root, rel);
  // git ls-files --cached also reports tracked paths deleted/moved in the
  // working tree. They are not part of the candidate publish tree and cannot
  // be stat'ed, so skip them rather than failing the scanner itself.
  if (!existsSync(full)) continue;
  if (statSync(full).size > 2_000_000) continue;
  let text;
  try { text = readFileSync(full, "utf8"); } catch { continue; }
  for (const [label, re] of patterns) if (re.test(text)) findings.push(`${rel}: ${label}`);
  if (/[A-Za-z]:\\Users\\[^\\\r\n]+\\/i.test(text)) findings.push(`${rel}: machine-specific user path`);
}
if (findings.length) {
  console.error("security scan failed:\n" + findings.join("\n"));
  process.exit(1);
}
console.log(`tracked-file security scan passed: ${files.length} files`);
