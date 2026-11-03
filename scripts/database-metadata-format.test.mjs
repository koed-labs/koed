import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("database metadata formatting uses repository settings and stays scoped", () => {
  const scratch = path.join(root, "scratch");
  mkdirSync(scratch, { recursive: true });
  const fixture = mkdtempSync(path.join(scratch, "database-format-"));
  const db = path.join(fixture, "packages/db");
  const metadata = path.join(db, "drizzle/meta");
  const source = {
    items: ["a".repeat(20), "b".repeat(20), "c".repeat(20)],
    enabled: true
  };
  const unformatted = JSON.stringify(source);
  try {
    assert.equal(spawnSync("git", ["init", "--quiet", fixture]).status, 0);
    mkdirSync(path.join(metadata, "nested"), { recursive: true });
    copyFileSync(
      path.join(root, ".oxfmtrc.json"),
      path.join(fixture, ".oxfmtrc.json")
    );
    for (const file of ["_journal.json", "0000_snapshot.json"]) {
      writeFileSync(path.join(metadata, file), unformatted);
    }
    const excluded = [
      path.join(db, "unrelated.json"),
      path.join(metadata, "nested/untouched.json")
    ];
    for (const file of excluded) writeFileSync(file, unformatted);
    const { scripts } = JSON.parse(
      readFileSync(path.join(root, "packages/db/package.json"), "utf8")
    );
    const result = spawnSync(scripts["migrate:format"], {
      shell: true,
      cwd: db,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: [
          path.join(root, "node_modules/.bin"),
          path.dirname(process.execPath),
          "/usr/bin",
          "/bin"
        ].join(path.delimiter)
      }
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const file of ["_journal.json", "0000_snapshot.json"]) {
      const formatted = readFileSync(path.join(metadata, file), "utf8");
      assert.deepEqual(JSON.parse(formatted), source);
      assert.match(formatted, /"items": \[\n/);
      assert.ok(formatted.endsWith("\n"));
    }
    for (const file of excluded) {
      assert.equal(readFileSync(file, "utf8"), unformatted);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
