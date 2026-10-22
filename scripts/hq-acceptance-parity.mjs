import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  lstatSync,
  readlinkSync
} from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { hqAcceptanceContract } from "../apps/desktop/scripts/hq-acceptance-contract.mjs";
import { earlyProofs } from "../apps/desktop/scripts/validate-hq901-early-proofs.mjs";
import { lateProofs } from "../apps/desktop/scripts/validate-hq901-late-proofs.mjs";
import { ownedAcceptanceSuites } from "./hq-acceptance-owned-suites.mjs";

const repository = resolve(import.meta.dirname, "..");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const git = (root, ...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

export function sourceIdentity(root) {
  const files = git(
    root,
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard"
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file).update("\0");
    const path = resolve(root, file);
    try {
      hash.update(
        lstatSync(path).isSymbolicLink()
          ? `symlink:${readlinkSync(path)}`
          : readFileSync(path)
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update("<deleted>");
    }
    hash.update("\0");
  }
  return {
    head: git(root, "rev-parse", "HEAD").trim(),
    sourceDigest: hash.digest("hex")
  };
}

export function findPassedTest(report, file, title, root) {
  const suites =
    report.testResults?.filter(
      (suite) => resolve(suite.name) === resolve(root, file)
    ) ?? [];
  const cases = suites
    .flatMap((suite) => suite.assertionResults ?? [])
    .filter((item) => item.title === title);
  return (
    report.success === true &&
    suites.length === 1 &&
    cases.length === 1 &&
    cases[0].status === "passed"
  );
}

function strings(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(strings);
}

export function evaluateClaim(claim, evidence) {
  const missing = [...(claim.gaps ?? []), ...(claim.unresolvedClauses ?? [])];
  const proofs = claim.clauses ?? claim.proof ?? [];
  if (!proofs.length) missing.push("No executable owning proof is mapped.");
  for (const proof of proofs) {
    if (!evidence(proof))
      missing.push(proof.key ?? `${proof.file}: ${proof.title}`);
  }
  return {
    id: claim.id,
    status: missing.length ? "unproven" : "pass",
    missing,
    proofs
  };
}

export function compileParity(contract, claims, evidence) {
  assert.equal(
    new Set(contract.map((item) => item.id)).size,
    contract.length,
    "Duplicate approved ID"
  );
  const known = new Set(contract.map((item) => item.id));
  assert.ok(
    claims.every((item) => known.has(item.id)),
    "Unknown claim ID"
  );
  assert.equal(
    new Set(claims.map((item) => item.id)).size,
    claims.length,
    "Duplicate claim ID"
  );
  const results = contract.map((item) => {
    const claim = claims.find((claim) => claim.id === item.id);
    return {
      ...item,
      ...(claim
        ? evaluateClaim(claim, evidence)
        : {
            status: "unproven",
            missing: ["Owning proof is not mapped."],
            proofs: []
          })
    };
  });
  for (const claim of claims) {
    for (const dependency of claim.requires ?? [])
      assert.ok(known.has(dependency), `Unknown required ID: ${dependency}`);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    assert.ok(!visiting.has(id), `Cyclic acceptance dependency: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const claim = claims.find((item) => item.id === id);
    const result = results.find((item) => item.id === id);
    for (const dependency of claim?.requires ?? []) {
      visit(dependency);
      if (results.find((item) => item.id === dependency).status !== "pass") {
        result.status = "unproven";
        result.missing.push(
          `Required owning assertion has no green result: ${dependency}`
        );
      }
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of contract) visit(item.id);
  return {
    complete: results.every((item) => item.status === "pass"),
    passed: results.filter((item) => item.status === "pass").length,
    total: results.length,
    results
  };
}

function command(root, output, name, executable, args, environment = {}) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const result = spawnSync(executable, args, {
    cwd: root,
    env: { ...process.env, ...environment },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  const log = resolve(output, `${name}.log`);
  writeFileSync(
    log,
    `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`
  );
  const record = {
    name,
    executable,
    args,
    startedAt,
    seconds: (Date.now() - start) / 1000,
    exitCode: result.status ?? 1,
    log
  };
  writeFileSync(
    resolve(output, `${name}.command.json`),
    JSON.stringify(record, null, 2) + "\n"
  );
  return record;
}

export function runParity(root, output) {
  assert.ok(
    process.env.KOED_HQ713_TEST_DATABASE_URL,
    "Set the disposable real-service database prerequisite."
  );
  assert.ok(
    relative(root, output).startsWith("scratch/"),
    "Keep generated evidence in the checkout's ignored scratch directory."
  );
  mkdirSync(output, { recursive: true });
  const identity = sourceIdentity(root);
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const unitPath = resolve(output, "owned-vitest.json");
  const files = [
    ...new Set(
      ownedAcceptanceSuites.flatMap((item) =>
        item.proof
          .filter((proof) => proof.kind === "vitest")
          .map((proof) => proof.file)
      )
    )
  ].sort();
  const units = command(root, output, "owned-suites", pnpm, [
    "exec",
    "vitest",
    "run",
    ...files,
    "--maxWorkers=1",
    "--no-file-parallelism",
    "--reporter=json",
    `--outputFile=${unitPath}`
  ]);
  const browserStarted = Date.now();
  const browser = command(root, output, "new-hq-browser", process.execPath, [
    "apps/desktop/scripts/run-hq-validation.mjs"
  ]);
  const assertionsPath = resolve(output, "two-user-assertions.json");
  const realPath = resolve(output, "two-user-vitest.json");
  const real = command(
    root,
    output,
    "real-two-user",
    pnpm,
    [
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.hq-two-user.config.ts",
      "--reporter=json",
      `--outputFile=${realPath}`
    ],
    {
      KOED_HQ713_DESKTOP: "1",
      KOED_HQ713_RESULT_OUTPUT: assertionsPath,
      KOED_HQ713_DESKTOP_OUTPUT: resolve(output, "native")
    }
  );
  const unitReport = existsSync(unitPath) ? readJson(unitPath) : {};
  const realReport = existsSync(realPath) ? readJson(realPath) : {};
  const assertions = existsSync(assertionsPath) ? readJson(assertionsPath) : {};
  const nativePath = resolve(output, "native", "desktop-result.json");
  const native = existsSync(nativePath) ? readJson(nativePath) : {};
  // Reports older than this Native command cannot supply evidence.
  // Fresh timestamps alone never replace a successful owning command.
  const browserProof = (proof) => {
    if (browser.exitCode !== 0) return false;
    const file = resolve(root, proof.reportPath);
    if (!existsSync(file)) return false;
    const record = readJson(file);
    if (statSync(file).mtimeMs < browserStarted) return false;
    return record.status === "pass" && strings(record).includes(proof.proofId);
  };
  const evidence = (proof) => {
    if (proof.runner) return browserProof(proof);
    if (proof.kind === "vitest")
      return (
        units.exitCode === 0 &&
        findPassedTest(unitReport, proof.file, proof.title, root)
      );
    if (proof.kind === "hq713-record")
      return (
        real.exitCode === 0 &&
        findPassedTest(realReport, proof.file, proof.title, root) &&
        assertions.assertionCoverageComplete === true &&
        assertions.missing?.length === 0 &&
        assertions.assertions?.some((item) => item.id === proof.record) &&
        native.realIpc === true &&
        native.realHttp === true &&
        native.consoleErrors?.length === 0
      );
    return false;
  };
  // S01.2 belongs to the late Team-column validator, not the early inventory.
  const claims = [
    ...earlyProofs.filter((item) => item.id !== "S01.2"),
    ...lateProofs,
    ...ownedAcceptanceSuites
  ];
  const report = {
    ...identity,
    commands: [units, browser, real],
    ...compileParity(hqAcceptanceContract, claims, evidence)
  };
  const after = sourceIdentity(root);
  assert.deepEqual(
    after,
    identity,
    "Source changed during parity validation; discard this run."
  );
  writeFileSync(
    resolve(output, "parity.json"),
    JSON.stringify(report, null, 2) + "\n"
  );
  return report;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const output = process.argv
    .find((arg) => arg.startsWith("--output="))
    ?.slice(9);
  assert.ok(output, "Pass --output=<ignored evidence directory>.");
  const report = runParity(repository, resolve(output));
  process.stdout.write(
    `HQ acceptance parity: ${report.passed}/${report.total}; ${report.complete ? "PASS" : "NOT READY"}\n`
  );
  process.exitCode = report.complete ? 0 : 1;
}
