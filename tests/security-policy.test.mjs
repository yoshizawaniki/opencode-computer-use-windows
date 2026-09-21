import { strict as assert } from "node:assert";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertBrowserMutationAllowed } from "../src/browser-origin-policy.js";
import { assertProcessAllowed } from "../src/allowlist.js";

const original = { ...process.env };
try {
  delete process.env.OPENCODE_CU_BROWSER_ORIGINS;
  delete process.env.OPENCODE_CU_ATTACH_ORIGINS;
  delete process.env.OPENCODE_CU_WINDOW_ALLOWLIST;
  assert.doesNotThrow(() => assertBrowserMutationAllowed("http://localhost:3000/path", { mode: "launch" }));
  assert.doesNotThrow(() => assertBrowserMutationAllowed("http://127.0.0.1:8123/", { mode: "launch" }));
  const projectFile = pathToFileURL(path.join(path.resolve(import.meta.dirname, ".."), "tests", "fixtures", "basic.html")).href;
  assert.doesNotThrow(() => assertBrowserMutationAllowed(projectFile, { mode: "launch" }));
  assert.throws(() => assertBrowserMutationAllowed("https://example.com/path", { mode: "launch" }), /mutation refused/);
  assert.throws(() => assertBrowserMutationAllowed("http://localhost:3000/", { mode: "attach" }), /attached to Chrome/);
  process.env.OPENCODE_CU_BROWSER_ORIGINS = "https://example.com";
  assert.doesNotThrow(() => assertBrowserMutationAllowed("https://example.com/path", { mode: "launch" }));
  assert.throws(() => assertBrowserMutationAllowed("https://example.org/", { mode: "launch" }), /mutation refused/);
  process.env.OPENCODE_CU_ATTACH_ORIGINS = "https://example.com";
  assert.doesNotThrow(() => assertBrowserMutationAllowed("https://example.com/path", { mode: "attach" }));
  assert.throws(() => assertProcessAllowed("notepad.exe"), /deny-by-default/);
  process.env.OPENCODE_CU_WINDOW_ALLOWLIST = "notepad.exe";
  assert.doesNotThrow(() => assertProcessAllowed("NOTEPAD.EXE"));
  assert.throws(() => assertProcessAllowed("systemsettings.exe"), /not in the window\/desktop tool allowlist/);
  console.log("security policy tests passed");
} finally {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
}
