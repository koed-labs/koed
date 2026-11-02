import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { syncChangelogs } from "./product-changelog.mjs";
import { extractReleaseNotes } from "./product-release-notes.mjs";

test("selects exact version heading and excludes later releases", () => {
  const changelog =
    "# Changelog\n\n## 1.2.4\n\nNew release.\n\n## 1.2.3\n\nOld release.\n";
  assert.equal(
    extractReleaseNotes(changelog, "1.2.3"),
    "## 1.2.3\n\nOld release."
  );
});

test("sync output reaches release notes CLI intact across fenced headings", (t) => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(scratch, "release-notes-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, "scripts"));
  for (const file of ["product-release-notes.mjs", "product-changelog.mjs"]) {
    fs.copyFileSync(
      path.join(root, "scripts", file),
      path.join(fixture, "scripts", file)
    );
  }
  const result = syncChangelogs({
    root: "# Koed\n\n~~~md\n## 9.9.9\n~~~\n\n## 1.0.0\n\n## 0.9.0\n\nHistory\n",
    desktop: "# desktop\n",
    product:
      "# product\n\n## 1.0.0\n\n### Patch Changes\n\n- Example:\n\n  ```md\n## fake release\n  ```\n\n- After example\n",
    server: "# server\n",
    version: "1.0.0"
  });
  fs.writeFileSync(path.join(fixture, "CHANGELOG.md"), result.root);
  const script = path.join(fixture, "scripts", "product-release-notes.mjs");
  const expected =
    "## 1.0.0\n\n### Patch Changes\n\n- Example:\n\n  ```md\n## fake release\n  ```\n\n- After example\n";
  assert.equal(
    execFileSync(process.execPath, [script], { encoding: "utf8" }),
    expected
  );
  assert.equal(
    execFileSync(process.execPath, [script, "--version", "1.0.0"], {
      encoding: "utf8"
    }),
    expected
  );
  assert.throws(
    () => extractReleaseNotes(result.root, "9.9.9"),
    /no release section/
  );
});

test("fails when requested version has no release notes", () => {
  assert.throws(
    () => extractReleaseNotes("## 1.2.4\n\nNew release.\n", "1.2.3"),
    /no release section for 1.2.3/
  );
});
