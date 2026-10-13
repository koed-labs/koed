import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  checkAdrDirectory,
  findAdrNumberProblems,
  formatAdrNumberProblems
} from "./adr-numbers-lib.mjs";

test("accepts unique ADR numbers and ignores README", () => {
  assert.deepEqual(
    findAdrNumberProblems(["0001-first.md", "0002-second.md", "README.md"]),
    { duplicates: [], invalidNames: [] }
  );
});

test("reports every file that shares an ADR number", () => {
  const problems = findAdrNumberProblems([
    "0030-b.md",
    "0030-a.md",
    "0031-c.md",
    "0030-c.md"
  ]);

  assert.deepEqual(problems.duplicates, [
    { number: "0030", files: ["0030-a.md", "0030-b.md", "0030-c.md"] }
  ]);
  assert.match(
    formatAdrNumberProblems(problems),
    /ADR number 0030 is used by more than one file/
  );
});

test("rejects ADR file names without a four-digit number and slug", () => {
  const { invalidNames } = findAdrNumberProblems([
    "30-short.md",
    "0030_underscore.md",
    "0030-Upper.md",
    "0030-ok.md"
  ]);

  assert.deepEqual(invalidNames, [
    "0030-Upper.md",
    "0030_underscore.md",
    "30-short.md"
  ]);
});

test("repository ADRs have unique numbers", () => {
  const adrDirectory = path.resolve(import.meta.dirname, "..", "docs", "adr");
  assert.deepEqual(checkAdrDirectory(adrDirectory), {
    duplicates: [],
    invalidNames: []
  });
});
