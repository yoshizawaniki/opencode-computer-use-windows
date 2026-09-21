#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyEdits, modify, parse } from "jsonc-parser";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROVIDER = "opencode-computer-use";
const SKILLS = ["computer-use", "browser-use", "windows-app-testing", "web-app-testing", "visual-verification", "record-and-replay"];
const ASK_TOOLS = [
  "browser_attach",
  "browser_evaluate",
  "desktop_launch_app",
  "desktop_close_window",
  "desktop_kill_process",
  "clipboard_read",
  "clipboard_write",
  "scheduled_task_register",
  "scheduled_task_delete",
];

const format = { insertSpaces: true, tabSize: 2, eol: "\n" };
const hash = (buf) => createHash("sha256").update(buf).digest("hex");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const defaultConfigPath = () => path.join(homedir(), ".config", "opencode", "opencode.jsonc");
const defaultSkillsDir = () => path.join(homedir(), ".config", "opencode", "skills");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function getAt(obj, keys) {
  let cur = obj;
  for (const key of keys) {
    if (cur == null || !Object.prototype.hasOwnProperty.call(cur, key)) return { exists: false, value: undefined };
    cur = cur[key];
  }
  return { exists: true, value: cur };
}

function setJsonc(text, keys, value) {
  return applyEdits(text, modify(text, keys, value, { formattingOptions: format }));
}

function normalizeList(values = []) {
  return [...new Set(values.flatMap((v) => String(v).split(",")).map((v) => v.trim()).filter(Boolean))];
}

function parseArgs(argv) {
  const out = { processes: [], browserOrigins: [], attachOrigins: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--config") out.configPath = argv[++i];
    else if (arg === "--skills-dir") out.skillsDir = argv[++i];
    else if (arg === "--manifest") out.manifestPath = argv[++i];
    else if (arg === "--allow-process") out.processes.push(argv[++i]);
    else if (arg === "--allow-origin") out.browserOrigins.push(argv[++i]);
    else if (arg === "--allow-attach-origin") out.attachOrigins.push(argv[++i]);
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return `Usage: node scripts/install.mjs [options]\n\n` +
    `  --dry-run                       show planned changes only\n` +
    `  --config <path>                 OpenCode opencode.jsonc path\n` +
    `  --skills-dir <path>             OpenCode global skills directory\n` +
    `  --allow-process <exe[,exe...]>  explicitly allow Windows mutation targets\n` +
    `  --allow-origin <origin[,..]>    explicitly allow external browser mutation origins\n` +
    `  --allow-attach-origin <origin>  allow mutation in attached Chrome (separate stricter scope)\n`;
}

export function install(options = {}) {
  const configPath = path.resolve(options.configPath || defaultConfigPath());
  const skillsDir = path.resolve(options.skillsDir || defaultSkillsDir());
  const manifestPath = path.resolve(options.manifestPath || path.join(path.dirname(configPath), ".opencode-computer-use-install.json"));
  const dryRun = Boolean(options.dryRun);
  const processes = normalizeList(options.processes);
  const browserOrigins = normalizeList(options.browserOrigins);
  const attachOrigins = normalizeList(options.attachOrigins);
  let priorManifest = null;
  if (existsSync(manifestPath)) {
    priorManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      priorManifest.provider !== PROVIDER ||
      path.resolve(priorManifest.configPath) !== configPath ||
      path.resolve(priorManifest.projectRoot) !== path.resolve(ROOT)
    ) {
      throw new Error(`existing install manifest does not belong to this checkout/config: ${manifestPath}`);
    }
  }

  const existingText = existsSync(configPath)
    ? readFileSync(configPath, "utf8")
    : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  const errors = [];
  const parsed = parse(existingText, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error(`cannot safely edit ${configPath}: JSONC parse errors (${errors.length})`);

  const currentProvider = getAt(parsed, ["mcp", PROVIDER]);
  if (priorManifest && (!currentProvider.exists || !same(currentProvider.value, priorManifest.installedProvider))) {
    throw new Error(
      `the existing ${PROVIDER} MCP entry changed after installation; refusing to overwrite user changes. ` +
        "Uninstall/reconcile the current entry first."
    );
  }
  const previousProvider = priorManifest?.previousProvider ?? currentProvider;
  const serverPath = path.join(ROOT, "src", "server.js");
  if (!priorManifest && currentProvider.exists) {
    const cmd = currentProvider.value?.command;
    const existingServer = Array.isArray(cmd) ? cmd[1] : null;
    if (existingServer && path.resolve(existingServer) !== path.resolve(serverPath)) {
      throw new Error(`OpenCode already has an ${PROVIDER} MCP entry pointing elsewhere (${existingServer}); refusing to overwrite it`);
    }
  }

  const environment = { ...(currentProvider.value?.environment || {}) };
  if (processes.length) environment.OPENCODE_CU_WINDOW_ALLOWLIST = processes.join(",");
  if (browserOrigins.length) environment.OPENCODE_CU_BROWSER_ORIGINS = browserOrigins.join(",");
  if (attachOrigins.length) environment.OPENCODE_CU_ATTACH_ORIGINS = attachOrigins.join(",");

  const providerValue = {
    type: "local",
    command: [process.execPath, serverPath],
    enabled: true,
    ...(Object.keys(environment).length ? { environment } : {}),
  };

  const previousPermissions = priorManifest?.previousPermissions ?? {};
  let nextText = existingText;
  nextText = setJsonc(nextText, ["mcp", PROVIDER], providerValue);
  for (const tool of ASK_TOOLS) {
    const key = `${PROVIDER}_${tool}`;
    const previous = getAt(parsed, ["permission", key]);
    if (!priorManifest) previousPermissions[key] = previous;
    if (!previous.exists) nextText = setJsonc(nextText, ["permission", key], "ask");
  }

  const now = stamp();
  const backupPath = priorManifest?.configBackup ?? `${configPath}.opencode-computer-use.backup-${now}`;
  const priorSkills = new Map((priorManifest?.skills ?? []).map((record) => [record.skill, record]));
  const skillRecords = [];
  for (const skill of SKILLS) {
    const source = path.join(ROOT, "skills", skill, "SKILL.md");
    const destination = path.join(skillsDir, skill, "SKILL.md");
    const sourceBytes = readFileSync(source);
    const sourceHash = hash(sourceBytes);
    const prior = priorSkills.get(skill);
    const existsNow = existsSync(destination);
    // schemaVersion 1 did not record ownership. If such a manifest is
    // encountered, fail conservative: an existing file is treated as
    // pre-existing so uninstall will never delete a possibly user-owned Skill.
    const existedBefore =
      typeof prior?.existedBefore === "boolean" ? prior.existedBefore : prior ? true : existsNow;
    let previousBackup = prior?.previousBackup ?? null;
    if (existsNow) {
      const current = readFileSync(destination);
      const currentHash = hash(current);
      if (prior && currentHash !== prior.installedSha256 && currentHash !== sourceHash) {
        throw new Error(`installed skill ${skill} was modified after installation; refusing to overwrite user changes`);
      }
      if (!prior && currentHash !== sourceHash) previousBackup = `${destination}.opencode-computer-use.backup-${now}`;
    }
    skillRecords.push({ skill, source, destination, installedSha256: sourceHash, previousBackup, existedBefore });
  }

  const manifest = {
    schemaVersion: 2,
    provider: PROVIDER,
    installedAt: priorManifest?.installedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectRoot: ROOT,
    configPath,
    configBackup: backupPath,
    previousProvider,
    previousPermissions,
    installedProvider: providerValue,
    skills: skillRecords.map(({ skill, destination, installedSha256, previousBackup, existedBefore }) => ({
      skill,
      destination,
      installedSha256,
      previousBackup,
      existedBefore,
    })),
  };

  if (!dryRun) {
    mkdirSync(path.dirname(configPath), { recursive: true });
    if (!priorManifest) {
      if (existsSync(configPath)) copyFileSync(configPath, backupPath);
      else writeFileSync(backupPath, existingText, "utf8");
    }
    writeFileSync(configPath, nextText, "utf8");
    for (const record of skillRecords) {
      mkdirSync(path.dirname(record.destination), { recursive: true });
      if (record.previousBackup && !existsSync(record.previousBackup) && existsSync(record.destination)) {
        copyFileSync(record.destination, record.previousBackup);
      }
      copyFileSync(record.source, record.destination);
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

    const verifyErrors = [];
    const verified = parse(readFileSync(configPath, "utf8"), verifyErrors, { allowTrailingComma: true, disallowComments: false });
    if (verifyErrors.length) throw new Error("post-install verification failed: resulting config is not valid JSONC");
    const installed = getAt(verified, ["mcp", PROVIDER]);
    if (!installed.exists || installed.value?.command?.[1] !== serverPath) throw new Error("post-install verification failed: MCP provider was not persisted");
    for (const record of skillRecords) {
      if (!existsSync(record.destination) || hash(readFileSync(record.destination)) !== record.installedSha256) {
        throw new Error(`post-install verification failed for skill ${record.skill}`);
      }
    }
  }

  return { dryRun, configPath, skillsDir, manifestPath, provider: PROVIDER, serverPath, processes, browserOrigins, attachOrigins, askToolCount: ASK_TOOLS.length, skillCount: SKILLS.length };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    console.log(JSON.stringify(install(options), null, 2));
  } catch (error) {
    console.error(`install failed: ${error.message}`);
    process.exit(1);
  }
}
