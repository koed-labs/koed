import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("Pi configure/check/remove preserves unrelated profile settings", () => {
  const temporary = mkdtempSync(join(tmpdir(), "koed-configure-pi-"));
  const koedHome = join(temporary, "koed");
  const piHome = join(temporary, "pi-profile");
  const settingsPath = join(piHome, "settings.json");
  const fakePi = join(temporary, "pi");
  mkdirSync(piHome, { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({ theme: "custom", packages: ["npm:unrelated"] })
  );
  writeFileSync(
    fakePi,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const settingsPath = path.join(process.env.PI_CODING_AGENT_DIR, "settings.json");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("0.84.2"); process.exit(0); }
const value = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
if (args[0] === "install") { value.packages = [...new Set([...(value.packages || []), path.resolve(args[1])])]; fs.writeFileSync(settingsPath, JSON.stringify(value)); }
if (args[0] === "remove") { value.packages = (value.packages || []).filter((item) => item !== path.resolve(args[1])); fs.writeFileSync(settingsPath, JSON.stringify(value)); }
if (args[0] === "list") console.log((value.packages || []).join("\\n"));
`
  );
  chmodSync(fakePi, 0o700);
  const environment = {
    ...process.env,
    KOED_HOME: koedHome,
    PI_CODING_AGENT_DIR: piHome,
    KOED_PI_EXECUTABLE: fakePi
  };
  execFileSync(process.execPath, [join(root, "scripts/configure-pi.mjs")], {
    cwd: root,
    env: environment
  });
  execFileSync(
    process.execPath,
    [join(root, "scripts/configure-pi.mjs"), "--check"],
    { cwd: root, env: environment }
  );
  let settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(settings.theme, "custom");
  assert.ok(settings.packages.includes("npm:unrelated"));
  assert.ok(
    settings.packages.some((entry) => entry.endsWith("/integrations/pi"))
  );
  execFileSync(
    process.execPath,
    [join(root, "scripts/configure-pi.mjs"), "--remove"],
    { cwd: root, env: environment }
  );
  settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.deepEqual(settings, { theme: "custom", packages: ["npm:unrelated"] });
});
