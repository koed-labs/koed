import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  installPiPackageTransaction,
  piPackageFileSystem
} from "../packages/koed-server/src/pi-package-transaction.mjs";

const root = resolve(import.meta.dirname, "..");

test("Pi package transaction restores the stable package when the filesystem swap fails", () => {
  const temporary = mkdtempSync(join(tmpdir(), "koed-pi-swap-rollback-"));
  const source = join(temporary, "source");
  const target = join(temporary, "integrations", "pi");
  mkdirSync(join(source, "extensions"), { recursive: true });
  mkdirSync(join(target, "extensions"), { recursive: true });
  writeFileSync(join(source, "package.json"), '{"version":"new"}\n');
  writeFileSync(join(source, "extensions", "koed.mjs"), "// new\n");
  writeFileSync(join(target, "package.json"), '{"version":"old"}\n');
  writeFileSync(join(target, "extensions", "koed.mjs"), "// old\n");
  let renames = 0;

  const result = installPiPackageTransaction({
    source,
    target,
    install: () => ({ status: 0 }),
    installSucceeded: (candidate) => candidate.status === 0,
    suffix: "swap-failure",
    fileSystem: {
      ...piPackageFileSystem,
      rename(from, to) {
        renames += 1;
        if (renames === 2) throw new Error("injected stage swap failure");
        piPackageFileSystem.rename(from, to);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /injected stage swap failure/);
  assert.match(readFileSync(join(target, "package.json"), "utf8"), /old/);
  assert.equal(
    existsSync(`${target}.stage-swap-failure`) ||
      existsSync(`${target}.backup-swap-failure`),
    false
  );
});

test("Pi configure/check/remove preserves unrelated profile settings", () => {
  const temporary = mkdtempSync(join(tmpdir(), "koed-configure-pi-"));
  const koedHome = join(temporary, "koed");
  const piHome = join(temporary, "pi-profile");
  const settingsPath = join(piHome, "settings.json");
  const fakePi = join(temporary, "pi");
  const environmentLog = join(temporary, "pi-environment.jsonl");
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
fs.appendFileSync(${JSON.stringify(environmentLog)}, JSON.stringify({ MEMORY_API_TOKEN: process.env.MEMORY_API_TOKEN, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, DATABASE_URL: process.env.DATABASE_URL }) + "\\n");
const settingsPath = path.join(process.env.PI_CODING_AGENT_DIR, "settings.json");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("0.84.2"); process.exit(0); }
if (args[0] === "--list-models") { console.log("provider model\\nopenai gpt-5.4"); process.exit(0); }
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
    KOED_PI_EXECUTABLE: fakePi,
    MEMORY_API_TOKEN: "must-not-leak",
    ANTHROPIC_API_KEY: "must-not-leak",
    DATABASE_URL: "postgres://must-not-leak"
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
  for (const line of readFileSync(environmentLog, "utf8").trim().split("\n")) {
    assert.deepEqual(JSON.parse(line), {});
  }
});

test("Pi configure restores the previous package after install failure", () => {
  const temporary = mkdtempSync(join(tmpdir(), "koed-configure-pi-rollback-"));
  const koedHome = join(temporary, "koed");
  const target = join(koedHome, "integrations", "pi");
  const fakePi = join(temporary, "pi");
  const attempts = join(temporary, "attempts");
  mkdirSync(join(target, "extensions"), { recursive: true });
  writeFileSync(join(target, "package.json"), '{"version":"old"}\n');
  writeFileSync(join(target, "extensions", "koed.mjs"), "// old\n");
  writeFileSync(
    fakePi,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("0.84.2"); process.exit(0); }
if (args[0] === "--list-models") { console.log("provider model\\nopenai gpt-5.4"); process.exit(0); }
if (args[0] === "install") {
  if (!fs.existsSync(${JSON.stringify(attempts)})) { fs.writeFileSync(${JSON.stringify(attempts)}, "1"); process.exit(1); }
  process.exit(0);
}
`
  );
  chmodSync(fakePi, 0o700);

  assert.throws(() =>
    execFileSync(process.execPath, [join(root, "scripts/configure-pi.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        KOED_HOME: koedHome,
        KOED_PI_EXECUTABLE: fakePi
      },
      stdio: "pipe"
    })
  );
  assert.match(readFileSync(join(target, "package.json"), "utf8"), /old/);
});

test("Pi remove preserves the package when profile removal fails", () => {
  const temporary = mkdtempSync(join(tmpdir(), "koed-configure-pi-remove-"));
  const koedHome = join(temporary, "koed");
  const target = join(koedHome, "integrations", "pi");
  const fakePi = join(temporary, "pi");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "package.json"), "{}\n");
  writeFileSync(
    fakePi,
    '#!/bin/sh\nif [ "$1" = "remove" ]; then exit 1; fi\nexit 0\n'
  );
  chmodSync(fakePi, 0o700);

  assert.throws(() =>
    execFileSync(
      process.execPath,
      [join(root, "scripts/configure-pi.mjs"), "--remove"],
      {
        cwd: root,
        env: {
          ...process.env,
          KOED_HOME: koedHome,
          KOED_PI_EXECUTABLE: fakePi
        },
        stdio: "pipe"
      }
    )
  );
  assert.equal(existsSync(target), true);
});
