import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { comparePackageTrees } from "./compare-package-trees.mjs";

const fixture = (root) => {
  mkdirSync(resolve(root, "bin"), { recursive: true });
  writeFileSync(resolve(root, "bin", "tool"), "payload\n", { mode: 0o755 });
  symlinkSync("tool", resolve(root, "bin", "tool-current"));
};

test("compares file content, modes, directories, and symlink targets", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "koed-tree-compare-"));
  const first = resolve(temporary, "first");
  const second = resolve(temporary, "second");
  try {
    fixture(first);
    fixture(second);
    const matching = comparePackageTrees(first, second);
    assert.equal(matching.ok, true);
    assert.equal(matching.first.sha256, matching.second.sha256);

    chmodSync(resolve(second, "bin", "tool"), 0o644);
    const changed = comparePackageTrees(first, second);
    assert.equal(changed.ok, false);
    assert.deepEqual(
      changed.differences.map((entry) => entry.path),
      ["bin/tool"]
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
