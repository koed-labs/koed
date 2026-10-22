import test from "node:test";
import assert from "node:assert/strict";
import {
  compileParity,
  findPassedTest,
  sourceIdentity
} from "./hq-acceptance-parity.mjs";

test("a successful harness cannot turn an unmapped or partial assertion green", () => {
  const result = compileParity(
    [{ id: "S01.1" }, { id: "S02.1" }],
    [
      {
        id: "S01.1",
        clauses: [{ key: "one clause" }],
        gaps: ["Missing live log"]
      }
    ],
    () => true
  );
  assert.equal(result.complete, false);
  assert.equal(result.passed, 0);
  assert.deepEqual(result.results[0].missing, ["Missing live log"]);
  assert.equal(result.results[1].status, "unproven");
});

test("each required owning proof must pass and IDs cannot be duplicated or invented", () => {
  const contract = [{ id: "N1.U" }];
  const claim = { id: "N1.U", proof: [{ key: "catch-up" }, { key: "agent" }] };
  assert.equal(
    compileParity(contract, [claim], (proof) => proof.key === "catch-up")
      .complete,
    false
  );
  assert.equal(compileParity(contract, [claim], () => true).complete, true);
  assert.throws(
    () => compileParity(contract, [claim, claim], () => true),
    /Duplicate claim/
  );
  assert.throws(
    () => compileParity(contract, [{ ...claim, id: "unknown" }], () => true),
    /Unknown claim/
  );
});

test("separate real-backend requirements are not satisfied by simulated IPC", () => {
  const contract = [{ id: "S15.2" }, { id: "N2.I" }];
  const claims = [
    { id: "S15.2", clauses: [{ key: "wording" }], requires: ["N2.I"] },
    { id: "N2.I", proof: [{ key: "actual grant" }] }
  ];
  const result = compileParity(
    contract,
    claims,
    (proof) => proof.key === "wording"
  );
  assert.equal(result.results[0].status, "unproven");
  assert.match(result.results[0].missing[0], /N2.I/);
  assert.throws(
    () =>
      compileParity(
        contract,
        [
          { ...claims[0], requires: ["N2.I"] },
          { ...claims[1], requires: ["S15.2"] }
        ],
        () => true
      ),
    /Cyclic/
  );
});

test("a skipped, ambiguous, failed, or different-file Vitest case never supplies proof", () => {
  const file = "apps/example.test.ts";
  const make = (status) => ({
    success: true,
    testResults: [
      {
        name: `/repo/${file}`,
        assertionResults: [{ title: "exact case", status }]
      }
    ]
  });
  assert.equal(
    findPassedTest(make("passed"), file, "exact case", "/repo"),
    true
  );
  for (const status of ["pending", "skipped", "failed", "todo"])
    assert.equal(
      findPassedTest(make(status), file, "exact case", "/repo"),
      false
    );
  assert.equal(
    findPassedTest(make("passed"), "apps/other.test.ts", "exact case", "/repo"),
    false
  );
  const duplicate = make("passed");
  duplicate.testResults[0].assertionResults.push({
    title: "exact case",
    status: "passed"
  });
  assert.equal(findPassedTest(duplicate, file, "exact case", "/repo"), false);
  assert.equal(
    findPassedTest(
      { ...make("passed"), success: false },
      file,
      "exact case",
      "/repo"
    ),
    false
  );
});

test("source identity hashes directory symlinks without reading their host contents", async () => {
  const { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } =
    await import("node:fs");
  const { resolve } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const temporary = resolve(import.meta.dirname, "../scratch");
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(resolve(temporary, "hq-parity-git-"));
  try {
    execFileSync("git", ["init", "--quiet", root]);
    mkdirSync(resolve(root, "skill"));
    writeFileSync(resolve(root, "skill", "source.txt"), "fixture source");
    symlinkSync("skill", resolve(root, "linked-skill"), "dir");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--quiet",
        "-m",
        "fixture"
      ],
      { cwd: root }
    );
    const before = sourceIdentity(root);
    assert.match(before.sourceDigest, /^[a-f0-9]{64}$/);
    writeFileSync(
      resolve(root, "skill", "source.txt"),
      "changed fixture source"
    );
    assert.notEqual(sourceIdentity(root).sourceDigest, before.sourceDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
