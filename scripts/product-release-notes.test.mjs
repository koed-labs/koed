import assert from "node:assert/strict";
import test from "node:test";
import { extractReleaseNotes } from "./product-release-notes.mjs";

test("selects exact version heading and excludes later releases", () => {
  const changelog =
    "# Changelog\n\n## 1.2.4\n\nNew release.\n\n## 1.2.3\n\nOld release.\n";
  assert.equal(
    extractReleaseNotes(changelog, "1.2.3"),
    "## 1.2.3\n\nOld release."
  );
});

test("fails when requested version has no release notes", () => {
  assert.throws(
    () => extractReleaseNotes("## 1.2.4\n\nNew release.\n", "1.2.3"),
    /no release section for 1.2.3/
  );
});
