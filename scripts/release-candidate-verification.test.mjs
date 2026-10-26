import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { bundleControlPlane } from "./control-plane-bundle.mjs";
import { resolve } from "node:path";
import { writeDeterministicTarGz } from "./deterministic-tar-gzip.mjs";
import { createPackageReleaseIdentity } from "./package-release-identity.mjs";
import { canonicalComponentManifestBytes } from "./koed-server-package-lib.mjs";
import { buildComponentManifestCatalog } from "./component-manifest-catalog.mjs";
import {
  setupCandidate as setup,
  addDesktopFixture,
  refreshCandidatePackage,
  hash
} from "./test-utils/release-candidate-fixture.mjs";
import * as candidate from "./release-candidate-verification.mjs";

const rehash = (f) => {
  f.expected.assets = [...f.contents].map(([name, bytes]) => ({
    name,
    sha256: hash(bytes)
  }));
};
const recatalog = (f) => {
  f.contents.set(
    "component-manifest-hashes.json",
    canonicalComponentManifestBytes(
      buildComponentManifestCatalog({
        version: "1.2.3",
        manifests: [...f.contents]
          .filter(([name]) => name.endsWith(".manifest.json"))
          .map(([, bytes]) => bytes)
      })
    )
  );
  rehash(f);
};

test("pin-only candidate verifies real npm/Desktop inventories without executing candidate or signer/mutators", async () => {
  const f = await setup({ desktop: true });
  try {
    const result = await candidate.verifyReleaseCandidate(f.input, f.readers);
    assert.equal(result.kind, "verified-release-candidate");
    assert.equal(result.components, 4);
    assert.equal(result.npm.integrity, f.identity.npm.integrity);
    assert.equal(result.repository, "org/repo");
    assert.equal(result.desktop.catalogVerified, true);
  } finally {
    f.cleanup();
  }
});

for (const field of [
  "repository",
  "commit",
  "runId",
  "runAttempt",
  "version"
]) {
  test(`protected ${field} disagreement rejects candidate`, async () => {
    const f = await setup();
    try {
      f.input[field] = typeof f.input[field] === "number" ? 99 : "wrong";
      await assert.rejects(
        candidate.verifyReleaseCandidate(f.input, f.readers),
        /identity|version/i
      );
    } finally {
      f.cleanup();
    }
  });
}
for (const damage of [
  "missing",
  "duplicate",
  "bytes",
  "substitution",
  "registry",
  "artifact",
  "changed-input",
  "latest",
  "run-origin"
]) {
  test(`${damage} rejects before any mutation capability exists`, async () => {
    const f = await setup();
    try {
      if (damage === "missing") f.release.assets.shift();
      if (damage === "duplicate") f.release.assets.push(f.release.assets[0]);
      if (damage === "bytes" || damage === "substitution") {
        for (const name of damage === "bytes"
          ? ["component-manifest-hashes.json"]
          : f.contents.keys())
          f.contents.set(name, Buffer.from("substituted"));
      }
      if (damage === "registry")
        f.readers.getRegistryVersion = async () => ({
          name: "@koed-labs/server",
          version: "1.2.3",
          dist: { integrity: "sha512-d3Jvbmc=" }
        });
      if (damage === "artifact")
        f.readers.getArtifact = async () => ({ expired: true });
      if (damage === "latest")
        f.readers.getRegistryVersion = async (_name, version) =>
          version === "latest" ? { version: "9.0.0" } : null;
      if (damage === "run-origin")
        f.readers.getWorkflowRun = async () => ({
          id: 42,
          run_attempt: 2,
          head_sha: "f".repeat(40)
        });
      if (damage === "changed-input") {
        const original = f.readers.getWorkflowRun;
        f.readers.getWorkflowRun = async () => {
          f.expected.assets[0].sha256 = "c".repeat(64);
          return original();
        };
      }
      await assert.rejects(
        candidate.verifyReleaseCandidate(f.input, f.readers),
        /asset|digest|identity|registry|artifact|changed|downgrade/i
      );
    } finally {
      f.cleanup();
    }
  });
}

test("coherent valid catalog/manifest/archive/npm substitution cannot replace reviewed build", async () => {
  const reviewed = await setup();
  const substitute = await setup({
    payload: "export const substituted = true;\n"
  });
  try {
    assert.equal(
      (
        await candidate.verifyReleaseCandidate(
          substitute.input,
          substitute.readers
        )
      ).kind,
      "verified-release-candidate"
    );
    reviewed.contents.clear();
    for (const [name, bytes] of substitute.contents)
      reviewed.contents.set(name, bytes);
    await assert.rejects(
      candidate.verifyReleaseCandidate(reviewed.input, reviewed.readers),
      /digest mismatch/
    );
  } finally {
    reviewed.cleanup();
    substitute.cleanup();
  }
});

test("rehashed archive with wrong inventory still rejects", async () => {
  const f = await setup();
  try {
    const name = "koed-base-1.2.3-linux-x64.tar.gz";
    writeFileSync(resolve(f.root, "components/base/main.js"), "tampered\n");
    writeDeterministicTarGz({
      sourceDir: resolve(f.root, "components/base"),
      tarPath: resolve(f.assetsDir, name)
    });
    f.contents.set(name, readFileSync(resolve(f.assetsDir, name)));
    const manifest = JSON.parse(f.contents.get(`${name}.manifest.json`));
    manifest.archive.sha256 = hash(f.contents.get(name));
    manifest.archive.bytes = f.contents.get(name).length;
    f.contents.set(
      `${name}.manifest.json`,
      canonicalComponentManifestBytes(manifest)
    );
    recatalog(f);
    await assert.rejects(
      candidate.verifyReleaseCandidate(f.input, f.readers),
      /file hash mismatch/
    );
  } finally {
    f.cleanup();
  }
});

for (const damage of ["version", "libc", "tuple", "missing-tuple"])
  test(`rehashed ${damage} cannot bypass tuple validation`, async () => {
    const f = await setup();
    try {
      const name = "koed-base-1.2.3-linux-x64.tar.gz.manifest.json";
      const manifest = JSON.parse(f.contents.get(name));
      if (damage === "version") manifest.productVersion = "2.0.0";
      if (damage === "libc") manifest.target.libc.minimumVersion = "2.36";
      if (damage === "tuple") manifest.component = "privacy";
      if (damage === "missing-tuple") {
        f.contents.delete(name);
        f.release.assets = f.release.assets.filter((a) => a.name !== name);
      } else f.contents.set(name, canonicalComponentManifestBytes(manifest));
      rehash(f);
      await assert.rejects(
        candidate.verifyReleaseCandidate(f.input, f.readers),
        /catalog|manifest|target|component/i
      );
    } finally {
      f.cleanup();
    }
  });

for (const damage of [
  "pins",
  "name",
  "bin",
  "inventory",
  "sri",
  "disconnected-cli",
  "disconnected-consumer",
  "uncalled-consumer",
  "comma-consumer",
  "spread-consumer",
  "reference-consumer",
  "alias-admission",
  "computed-override",
  "shorthand-override"
])
  test(`actual npm ${damage} mismatch rejects even with rehashed tarball`, async () => {
    const f = await setup();
    try {
      if (damage === "pins")
        writeFileSync(
          resolve(f.packageRoot, "vendor/control-plane.js"),
          "export const productionComponentManifestCatalog = null;"
        );
      if (damage === "disconnected-cli") {
        writeFileSync(
          resolve(f.packageRoot, "bin/koed.js"),
          "await import('../vendor/stale.js');"
        );
        writeFileSync(
          resolve(f.packageRoot, "vendor/stale.js"),
          "throw new Error('CANDIDATE_EXECUTED');"
        );
      }
      if (damage === "disconnected-consumer") {
        const path = resolve(f.packageRoot, "vendor/control-plane.js");
        writeFileSync(
          path,
          readFileSync(path, "utf8").replace(
            "validateManifestCatalog(productionComponentManifestCatalog)",
            "validateManifestCatalog(null)"
          )
        );
      }
      if (
        ["uncalled-consumer", "comma-consumer", "spread-consumer"].includes(
          damage
        )
      ) {
        const path = resolve(f.packageRoot, "vendor/control-plane.js");
        let source = readFileSync(path, "utf8");
        if (damage === "uncalled-consumer")
          source = source
            .replace(
              "export function runKoedServerCli(args) {",
              "export function runKoedServerCli(args) { return 0; function unused() {"
            )
            .replace(
              "export function shouldExitPackagedSupervisor",
              "} export function shouldExitPackagedSupervisor"
            );
        if (damage === "comma-consumer")
          source = source.replace(
            "manifestCatalog: catalog",
            "manifestCatalog: (catalog, null)"
          );
        if (damage === "spread-consumer")
          source = source.replace(
            "manifestCatalog: catalog",
            "manifestCatalog: catalog, ...{ manifestCatalog: null }"
          );
        writeFileSync(path, source);
      }
      if (
        [
          "reference-consumer",
          "alias-admission",
          "computed-override",
          "shorthand-override"
        ].includes(damage)
      ) {
        const path = resolve(f.packageRoot, "vendor/control-plane.js");
        let source = readFileSync(path, "utf8");
        if (damage === "reference-consumer")
          source =
            source.replace(
              "export function runKoedServerCli(args) {",
              "function connected(args) {"
            ) +
            " export function runKoedServerCli(args) { void connected; return 0; }";
        if (damage === "alias-admission")
          source =
            source.replace(
              "export function runKoedServerCli(args) {",
              "function connected(args) {"
            ) +
            " const admit = verifyComponent; export function runKoedServerCli(args) { connected(args); return admit({manifestCatalog: null}); }";
        if (damage === "computed-override")
          source = source.replace(
            "manifestCatalog: catalog",
            "manifestCatalog: catalog, ['manifestCatalog']: null"
          );
        if (damage === "shorthand-override")
          source = source
            .replace(
              "return verifyComponent",
              "const manifestCatalog = null; return verifyComponent"
            )
            .replace(
              "manifestCatalog: catalog",
              "manifestCatalog: catalog, manifestCatalog"
            );
        writeFileSync(path, source);
      }
      if (damage === "name" || damage === "bin") {
        const path = resolve(f.packageRoot, "package.json");
        const manifest = JSON.parse(readFileSync(path));
        if (damage === "name") manifest.name = "@attacker/server";
        else manifest.bin = { koed: "evil.js" };
        writeFileSync(path, JSON.stringify(manifest));
      }
      const tarball = resolve(f.assetsDir, "koed-labs-server.tgz");
      writeDeterministicTarGz({
        sourceDir: f.packageRoot,
        tarPath: tarball,
        rootName: "package"
      });
      const identity =
        damage === "name"
          ? structuredClone(f.identity)
          : createPackageReleaseIdentity({
              packageRoot: f.packageRoot,
              tarball,
              version: "1.2.3"
            });
      if (damage === "name") {
        const bytes = readFileSync(tarball);
        identity.npm.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
        identity.npm.bytes = bytes.length;
      }
      if (damage === "inventory") identity.npm.inventorySha256 = "a".repeat(64);
      if (damage === "sri")
        identity.npm.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
      f.expected.npm = identity.npm;
      f.readers.getRegistryVersion = async () => null;
      f.contents.set("koed-labs-server.tgz", readFileSync(tarball));
      f.contents.set(
        "koed-labs-server-release-identity.json",
        Buffer.from(JSON.stringify(identity))
      );
      rehash(f);
      await assert.rejects(
        candidate.verifyReleaseCandidate(f.input, f.readers),
        /catalog|npm|package/i
      );
    } finally {
      f.cleanup();
    }
  });

const rewriteGeneratedAdmissions = (fixture, rewrite) => {
  const vendor = resolve(fixture.packageRoot, "vendor");
  let count = 0;
  for (const name of readdirSync(vendor).filter((name) =>
    name.endsWith(".js")
  )) {
    const path = resolve(vendor, name);
    let text = readFileSync(path, "utf8");
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true
    );
    const edits = [];
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        /^verifyComponent(?:ManifestPin)?$/.test(node.expression.text) &&
        node.arguments[0]?.getText(source).includes("manifestCatalog: catalog")
      )
        edits.push({ start: node.getStart(source), end: node.end, node });
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (!edits.length) continue;
    const preambles = [];
    for (const { start, end, node } of edits.reverse()) {
      const replacement = rewrite(node, source, preambles.length);
      preambles.push(replacement.preamble ?? "");
      text =
        text.slice(0, start) +
        (replacement.expression ?? replacement) +
        text.slice(end);
    }
    count += edits.length;
    writeFileSync(path, preambles.join("\n") + "\n" + text);
  }
  assert.equal(count, 3, "mutate all real generated admission sites");
};

const damageGeneratedAdmission = (damage, node, source, index) => {
  const call = node.getText(source);
  const callee = node.expression.getText(source);
  const args = node.arguments[0].getText(source);
  const stale = args.replace(
    "manifestCatalog: catalog",
    "manifestCatalog: null"
  );
  if (damage === "dead-decoy-indirect")
    return `(false ? ${call} : [${callee}][0](${stale}))`;
  const alias = `admit${index}`;
  if (damage === "reassigned-alias")
    return {
      preamble: `let ${alias} = ${callee}; ${alias} = options => ${callee}({ manifestCatalog: null });`,
      expression: `${alias}(${args})`
    };
  if (damage === "writable-alias")
    return {
      preamble: `let ${alias} = ${callee};`,
      expression: `${alias}(${args})`
    };
  if (damage === "const-array-alias")
    return {
      preamble: `const ${alias} = [${callee}][0];`,
      expression: `(false ? ${call} : ${alias}(${stale}))`
    };
  return `(false ? ${call} : ${callee}.call(null, ${stale}))`;
};

const damagePackageScope = (f, damage) => {
  if (damage.startsWith("root-")) {
    const path = resolve(f.packageRoot, "package.json");
    const manifest = JSON.parse(readFileSync(path));
    if (damage === "root-untyped") delete manifest.type;
    else manifest.type = "commonjs";
    writeFileSync(path, JSON.stringify(manifest));
  }
  if (/^(bin|vendor)-/.test(damage)) {
    const dir = damage.split("-")[0];
    writeFileSync(
      resolve(f.packageRoot, dir, "package.json"),
      JSON.stringify(damage.endsWith("untyped") ? {} : { type: "commonjs" })
    );
  }
  if (damage === "nested-commonjs") {
    const dir = resolve(f.packageRoot, "vendor/nested");
    mkdirSync(dir);
    writeFileSync(resolve(dir, "package.json"), '{"type":"commonjs"}');
    writeFileSync(resolve(dir, "entry.js"), "export const value = 1;");
  }
};

for (const damage of [
  "dead-decoy-indirect",
  "reassigned-alias",
  "writable-alias",
  "const-array-alias",
  "call-dispatch",
  "root-commonjs",
  "root-untyped",
  "bin-commonjs",
  "vendor-commonjs",
  "vendor-untyped",
  "nested-commonjs",
  "valid-esm"
])
  test(`generated npm ${damage} full verifier ${damage === "valid-esm" ? "accepts" : "rejects"} without execution`, async () => {
    const f = await setup();
    try {
      await bundleControlPlane({
        repoRoot: resolve("."),
        vendorRoot: resolve(f.packageRoot, "vendor"),
        version: "1.2.3",
        catalog: f.catalog
      });
      if (
        [
          "dead-decoy-indirect",
          "reassigned-alias",
          "writable-alias",
          "const-array-alias",
          "call-dispatch"
        ].includes(damage)
      )
        rewriteGeneratedAdmissions(f, (node, source, index) =>
          damageGeneratedAdmission(damage, node, source, index)
        );
      damagePackageScope(f, damage);
      // Any accidental candidate execution fails even in the positive case.
      const entry = resolve(f.packageRoot, "vendor/control-plane.js");
      writeFileSync(
        entry,
        "throw new Error('CANDIDATE_EXECUTED');\n" + readFileSync(entry, "utf8")
      );
      refreshCandidatePackage(f);
      if (damage === "valid-esm")
        assert.equal(
          (await candidate.verifyReleaseCandidate(f.input, f.readers)).kind,
          "verified-release-candidate"
        );
      else
        await assert.rejects(
          candidate.verifyReleaseCandidate(f.input, f.readers),
          /npm package.*(?:binding|scope)/i
        );
    } finally {
      f.cleanup();
    }
  });

test("stale effective Desktop pins reject protected final ZIP", async () => {
  const f = await setup({ desktop: true });
  try {
    await addDesktopFixture(f, { stalePins: true });
    f.contents.set(
      f.expected.desktop.asset,
      readFileSync(resolve(f.assetsDir, f.expected.desktop.asset))
    );
    rehash(f);
    await assert.rejects(
      candidate.verifyReleaseCandidate(f.input, f.readers),
      /catalog/i
    );
  } finally {
    f.cleanup();
  }
});

for (const damage of ["missing", "candidate-ABI", "candidate-Electron"])
  test(`reviewed identity rejects ${damage} runtime matrix before readers`, async () => {
    const f = await setup();
    try {
      if (damage === "missing") delete f.expected.runtimeIdentities;
      if (damage === "candidate-ABI")
        f.expected.runtimeIdentities[0].modulesAbi = "999";
      if (damage === "candidate-Electron")
        f.expected.runtimeIdentities[2].version = "40.0.0";
      let reads = 0;
      f.readers.getWorkflowRun = async () => {
        reads++;
        throw new Error("unexpected reader");
      };
      await assert.rejects(
        candidate.verifyReleaseCandidate(f.input, f.readers),
        /runtime|matrix/i
      );
      assert.equal(reads, 0);
    } finally {
      f.cleanup();
    }
  });
