import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import {
  buildComponentManifest,
  canonicalComponentManifestBytes
} from "./koed-server-package-lib.mjs";
import { writeDeterministicTarGz } from "./deterministic-tar-gzip.mjs";
import { verifyComponent } from "../packages/koed-server/dist/component-verification.js";

test("fixture pin binds exact canonical manifest and rejects manifest/archive tampering", async (t) => {
  const { createSyntheticManifestCatalog } =
    await import("./component-signing-rehearsal-fixture.mjs");
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch", "component-signing-rehearsal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const payload = resolve(root, "payload");
  mkdirSync(payload);
  writeFileSync(resolve(payload, "fixture.txt"), "synthetic fixture\n");
  const archivePath = resolve(root, "base.tar.gz");
  writeDeterministicTarGz({ sourceDir: payload, tarPath: archivePath });
  const manifest = buildComponentManifest({
    componentRoot: payload,
    archivePath,
    component: "base",
    productVersion: "0.8.1",
    target: { platform: "linux", architecture: "x64" },
    runtimes: [
      {
        kind: "node",
        runtimeRange: ">=24 <25",
        nodeRange: ">=24 <25",
        modulesAbi: process.versions.modules,
        minimumNapi: 10
      }
    ],
    requiredFiles: ["fixture.txt"]
  });
  const manifestBytes = canonicalComponentManifestBytes(manifest);
  const manifestCatalog = createSyntheticManifestCatalog(manifestBytes);
  assert.throws(
    () =>
      createSyntheticManifestCatalog(
        Buffer.from(JSON.stringify(manifest, null, 2))
      ),
    /must be canonical/
  );
  const input = {
    manifestBytes,
    manifestCatalog,
    archivePath,
    expectedComponent: "base",
    expectedVersion: "0.8.1",
    target: manifest.target,
    runtime: {
      kind: "node",
      version: process.versions.node,
      nodeVersion: process.versions.node,
      modulesAbi: process.versions.modules,
      napiVersion: Number(process.versions.napi),
      platform: "linux",
      architecture: "x64"
    }
  };
  assert.equal(manifestCatalog.entries.length, 1);
  assert.deepEqual(await verifyComponent(input), manifest);
  await assert.rejects(
    verifyComponent({ ...input, manifestCatalog: null }),
    /pin catalog is unavailable/
  );
  await assert.rejects(
    verifyComponent({
      ...input,
      manifestBytes: canonicalComponentManifestBytes({
        ...manifest,
        requiredFiles: []
      })
    }),
    /component manifest pin mismatch/
  );
  const archive = readFileSync(archivePath);
  archive[archive.length - 1] ^= 1;
  writeFileSync(archivePath, archive);
  await assert.rejects(
    verifyComponent(input),
    /component archive SHA-256 mismatch/
  );
});

// Exercise the real script and verifier; only external OIDC/signer I/O is mocked.
test("synthetic rehearsal verifies payloads with current pin contract and retains remote tamper checks", async (t) => {
  const environment = {
    KOED_COMPONENT_SIGNER_URL: "https://signer.invalid",
    KOED_COMPONENT_SIGNER_KEY_ID: "koed-components-2026-01",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid/token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "offline-fixture"
  };
  const previousEnvironment = { ...process.env };
  Object.assign(process.env, environment);
  t.after(() => {
    for (const key of Object.keys(environment)) {
      if (previousEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnvironment[key];
    }
  });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const address = new URL(url);
    if (address.hostname === "oidc.invalid")
      return Response.json({ value: "offline-token" });
    assert.equal(address.hostname, "signer.invalid");
    const body = JSON.parse(options.body);
    calls.push({ path: address.pathname, body });
    if (address.pathname === "/v1/sign")
      return Response.json({
        signature: {
          schemaVersion: 2,
          keyId: environment.KOED_COMPONENT_SIGNER_KEY_ID,
          algorithm: "ed25519",
          signature: "synthetic-not-a-real-signature"
        }
      });
    assert.equal(address.pathname, "/v1/verify");
    return Response.json({
      verified: body.manifest.productVersion === "0.8.1"
    });
  });
  const output = [];
  t.mock.method(console, "log", (value) => output.push(value));
  await import("./component-signing-rehearsal.mjs?offline-contract-test");
  const result = JSON.parse(output[0]);
  assert.equal(result.ok, true);
  assert.equal(result.publication, false);
  assert.equal(result.evidence, "synthetic-fixture-only");
  assert.equal(result.nativeAcceptance, false);
  assert.equal(result.publisherTrust, false);
  assert.deepEqual(
    calls.map(({ path }) => path),
    [
      "/v1/sign",
      "/v1/verify",
      "/v1/verify",
      "/v1/sign",
      "/v1/verify",
      "/v1/verify"
    ]
  );
  assert.deepEqual(
    result.report.map(({ component }) => component),
    ["base", "privacy"]
  );
  for (const entry of result.report) {
    assert.ok(entry.manifestBytes > 65536);
    assert.equal(entry.syntheticPayloadVerified, true);
    assert.equal(entry.remoteSignatureVerified, true);
    assert.equal(entry.remoteManifestTamperingRejected, true);
  }
});
