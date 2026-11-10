import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderServerInstaller } from "./render-server-installer.mjs";

const template = readFileSync(
  new URL("./install-server.sh", import.meta.url),
  "utf8"
);

test("renders one exact stable release version deterministically", () => {
  const rendered = renderServerInstaller(template, "1.2.3");
  assert.equal(rendered, renderServerInstaller(template, "1.2.3"));
  assert.equal(rendered.includes("__KOED_INSTALLER_VERSION__"), false);
  const dir = mkdtempSync(join(tmpdir(), "koed-render-test-"));
  try {
    const path = join(dir, "installer.sh");
    writeFileSync(path, rendered);
    const mismatch = spawnSync("/bin/bash", [path, "--version", "1.2.4"], {
      encoding: "utf8"
    });
    assert.match(mismatch.stderr, /one exact Koed Server release/);
    const match = spawnSync("/bin/bash", [path, "--version", "1.2.3"], {
      encoding: "utf8",
      env: { ...process.env, KOED_HOME: join(dir, "missing-parent", "home") }
    });
    assert.doesNotMatch(match.stderr, /one exact Koed Server release/);
    assert.notEqual(match.status, 0, "missing KOED_HOME parent is refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects malformed versions and absent or repeated template markers", () => {
  for (const version of [
    "v1.2.3",
    "01.2.3",
    "1.2.3-rc.1",
    "1.2.3\n",
    "1.2",
    ""
  ]) {
    assert.throws(() => renderServerInstaller(template, version));
  }
  assert.throws(() => renderServerInstaller("no marker", "1.2.3"));
  assert.throws(() =>
    renderServerInstaller(`${template}\n__KOED_INSTALLER_VERSION__`, "1.2.3")
  );
});
