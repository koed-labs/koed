import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveElectronExecutable } from "./electron-executable.mjs";

test("loads Electron's package entry point to obtain its executable", () => {
  const root = mkdtempSync(join(tmpdir(), "koed-electron-test-"));
  try {
    const desktop = join(root, "apps/desktop");
    const electron = join(desktop, "node_modules/electron");
    mkdirSync(electron, { recursive: true });
    writeFileSync(
      join(electron, "index.js"),
      'module.exports = "/downloaded/electron";'
    );
    assert.equal(resolveElectronExecutable(root), "/downloaded/electron");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
