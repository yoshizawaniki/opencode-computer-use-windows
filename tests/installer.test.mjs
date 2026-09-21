import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { install } from "../scripts/install.mjs";
import { uninstall } from "../scripts/uninstall.mjs";

const temp = mkdtempSync(path.join(tmpdir(), "opencode-cu-installer-"));
const configDir = path.join(temp, ".config", "opencode");
const config = path.join(configDir, "opencode.jsonc");
const skills = path.join(configDir, "skills");
const manifest = path.join(configDir, ".opencode-computer-use-install.json");
mkdirSync(configDir, { recursive: true });
const initial = `{
  // keep this comment: installer must preserve JSONC
  "$schema": "https://opencode.ai/config.json",
  "custom": { "keep": true },
  "permission": { "bash": "ask" }
}\n`;
writeFileSync(config, initial, "utf8");

const dry = install({ configPath: config, skillsDir: skills, manifestPath: manifest, dryRun: true, processes: ["notepad.exe"] });
assert.equal(dry.dryRun, true);
assert.equal(readFileSync(config, "utf8"), initial, "dry-run must not mutate config");
assert.equal(existsSync(manifest), false, "dry-run must not create manifest");

install({ configPath: config, skillsDir: skills, manifestPath: manifest, processes: ["notepad.exe"], browserOrigins: ["https://example.com"] });
const installedText = readFileSync(config, "utf8");
assert.match(installedText, /keep this comment/);
const installed = parse(installedText);
assert.equal(installed.custom.keep, true);
assert.equal(installed.permission.bash, "ask");
assert.equal(installed.mcp["opencode-computer-use"].environment.OPENCODE_CU_WINDOW_ALLOWLIST, "notepad.exe");
assert.equal(installed.permission["opencode-computer-use_browser_attach"], "ask");
assert.equal(existsSync(path.join(skills, "computer-use", "SKILL.md")), true);
assert.equal(existsSync(manifest), true);

install({ configPath: config, skillsDir: skills, manifestPath: manifest, processes: ["notepad.exe"], browserOrigins: ["https://example.com"] });
const reinstalled = parse(readFileSync(config, "utf8"));
assert.equal(reinstalled.custom.keep, true);
assert.equal(Object.keys(reinstalled.mcp).filter((k) => k === "opencode-computer-use").length, 1);

uninstall({ configPath: config, manifestPath: manifest });
const after = parse(readFileSync(config, "utf8"));
assert.equal(after.custom.keep, true);
assert.equal(after.permission.bash, "ask");
assert.equal(after.mcp?.["opencode-computer-use"], undefined);
assert.equal(after.permission?.["opencode-computer-use_browser_attach"], undefined);
assert.equal(existsSync(manifest), false);
assert.equal(
  existsSync(path.join(skills, "computer-use", "SKILL.md")),
  false,
  "uninstall removes a Skill that the installer created from scratch"
);
console.log("installer/uninstaller fixture tests passed");

// Existing same-checkout manual config migration: preserve unrelated
// environment keys while letting explicit installer flags override the
// computer-use scope keys it owns.
const migrationTemp = mkdtempSync(path.join(tmpdir(), "opencode-cu-migration-"));
const migrationConfigDir = path.join(migrationTemp, ".config", "opencode");
const migrationConfig = path.join(migrationConfigDir, "opencode.jsonc");
const migrationSkills = path.join(migrationConfigDir, "skills");
const migrationManifest = path.join(migrationConfigDir, ".opencode-computer-use-install.json");
mkdirSync(migrationConfigDir, { recursive: true });
const serverPath = path.join(path.resolve(import.meta.dirname, ".."), "src", "server.js");
const sameSkillPath = path.join(migrationSkills, "computer-use", "SKILL.md");
const customSkillPath = path.join(migrationSkills, "browser-use", "SKILL.md");
mkdirSync(path.dirname(sameSkillPath), { recursive: true });
mkdirSync(path.dirname(customSkillPath), { recursive: true });
writeFileSync(
  sameSkillPath,
  readFileSync(path.join(path.resolve(import.meta.dirname, ".."), "skills", "computer-use", "SKILL.md")),
  "utf8"
);
writeFileSync(customSkillPath, "pre-existing custom browser-use skill\n", "utf8");
writeFileSync(
  migrationConfig,
  JSON.stringify(
    {
      mcp: {
        "opencode-computer-use": {
          type: "local",
          command: ["node", serverPath],
          environment: {
            NODE_NO_WARNINGS: "1",
            OPENCODE_CU_WINDOW_ALLOWLIST: "legacy.exe",
          },
        },
      },
      permission: {
        "opencode-computer-use_*": "allow",
      },
    },
    null,
    2
  ) + "\n",
  "utf8"
);

install({
  configPath: migrationConfig,
  skillsDir: migrationSkills,
  manifestPath: migrationManifest,
  processes: ["fixture.exe"],
});
const migrated = parse(readFileSync(migrationConfig, "utf8"));
assert.equal(
  migrated.mcp["opencode-computer-use"].environment.NODE_NO_WARNINGS,
  "1",
  "migration preserves unrelated existing MCP environment keys"
);
assert.equal(
  migrated.mcp["opencode-computer-use"].environment.OPENCODE_CU_WINDOW_ALLOWLIST,
  "fixture.exe",
  "explicit installer scope replaces only the owned allowlist key"
);
assert.equal(
  migrated.permission["opencode-computer-use_*"],
  "allow",
  "migration preserves existing wildcard permission"
);
uninstall({ configPath: migrationConfig, manifestPath: migrationManifest });
const restoredMigration = parse(readFileSync(migrationConfig, "utf8"));
assert.equal(
  restoredMigration.mcp["opencode-computer-use"].environment.OPENCODE_CU_WINDOW_ALLOWLIST,
  "legacy.exe",
  "uninstall restores the pre-installer provider environment exactly"
);
assert.equal(
  existsSync(sameSkillPath),
  true,
  "uninstall preserves a Skill that existed before install even when its contents were already identical"
);
assert.equal(
  readFileSync(sameSkillPath, "utf8"),
  readFileSync(path.join(path.resolve(import.meta.dirname, ".."), "skills", "computer-use", "SKILL.md"), "utf8"),
  "pre-existing identical Skill remains unchanged"
);
assert.equal(
  readFileSync(customSkillPath, "utf8"),
  "pre-existing custom browser-use skill\n",
  "uninstall restores a pre-existing Skill whose contents were replaced during install"
);
console.log("existing-config migration fixture tests passed");
