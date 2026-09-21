#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, readdirSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyEdits, modify, parse } from "jsonc-parser";

const PROVIDER = "opencode-computer-use";
const format = { insertSpaces: true, tabSize: 2, eol: "\n" };
const hash = (buf) => createHash("sha256").update(buf).digest("hex");
const defaultConfigPath = () => path.join(homedir(), ".config", "opencode", "opencode.jsonc");

function setJsonc(text, keys, value) {
  return applyEdits(text, modify(text, keys, value, { formattingOptions: format }));
}

function getAt(obj, keys) {
  let cur = obj;
  for (const key of keys) {
    if (cur == null || !Object.prototype.hasOwnProperty.call(cur, key)) return { exists: false, value: undefined };
    cur = cur[key];
  }
  return { exists: true, value: cur };
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") out.dryRun = true;
    else if (argv[i] === "--config") out.configPath = argv[++i];
    else if (argv[i] === "--manifest") out.manifestPath = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") out.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

export function uninstall(options = {}) {
  const configPath = path.resolve(options.configPath || defaultConfigPath());
  const manifestPath = path.resolve(options.manifestPath || path.join(path.dirname(configPath), ".opencode-computer-use-install.json"));
  if (!existsSync(manifestPath)) throw new Error(`install manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.provider !== PROVIDER || manifest.configPath !== configPath) throw new Error("manifest does not match this config/provider");
  const text = readFileSync(configPath, "utf8");
  const errors = [];
  const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error("cannot safely uninstall: current OpenCode config has JSONC parse errors");
  let nextText = text;
  const skipped = [];

  const currentProvider = getAt(parsed, ["mcp", PROVIDER]);
  if (currentProvider.exists && same(currentProvider.value, manifest.installedProvider)) {
    nextText = setJsonc(nextText, ["mcp", PROVIDER], manifest.previousProvider.exists ? manifest.previousProvider.value : undefined);
  } else if (currentProvider.exists) {
    skipped.push("MCP provider changed after install; left untouched");
  }

  for (const [key, previous] of Object.entries(manifest.previousPermissions || {})) {
    const current = getAt(parsed, ["permission", key]);
    const installedValue = previous.exists ? previous.value : "ask";
    if (current.exists && same(current.value, installedValue)) {
      nextText = setJsonc(nextText, ["permission", key], previous.exists ? previous.value : undefined);
    } else if (current.exists && !previous.exists) {
      skipped.push(`permission ${key} changed after install; left untouched`);
    }
  }

  if (!options.dryRun) {
    const backup = `${configPath}.opencode-computer-use.uninstall-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(configPath, backup);
    writeFileSync(configPath, nextText, "utf8");
    for (const record of manifest.skills || []) {
      if (!existsSync(record.destination)) continue;
      if (hash(readFileSync(record.destination)) !== record.installedSha256) {
        skipped.push(`skill ${record.skill} changed after install; left untouched`);
        continue;
      }
      if (record.previousBackup && existsSync(record.previousBackup)) {
        copyFileSync(record.previousBackup, record.destination);
        unlinkSync(record.previousBackup);
      } else if (record.existedBefore === false) {
        unlinkSync(record.destination);
        const dir = path.dirname(record.destination);
        if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
      } else {
        // Pre-existing identical file, or an older manifest that did not
        // record ownership. Leave it in place rather than risk deleting a
        // user-owned Skill.
      }
    }
    unlinkSync(manifestPath);

    const verifyErrors = [];
    parse(readFileSync(configPath, "utf8"), verifyErrors, { allowTrailingComma: true, disallowComments: false });
    if (verifyErrors.length) throw new Error("post-uninstall verification failed: config is not valid JSONC");
  }
  return { dryRun: Boolean(options.dryRun), configPath, manifestPath, skipped };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: node scripts/uninstall.mjs [--dry-run] [--config <path>] [--manifest <path>]");
      process.exit(0);
    }
    console.log(JSON.stringify(uninstall(options), null, 2));
  } catch (error) {
    console.error(`uninstall failed: ${error.message}`);
    process.exit(1);
  }
}
