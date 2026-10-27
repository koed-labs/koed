import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { componentManifestSigningBytes } from "./component-signature-format.mjs";
import {
  setupCandidate,
  verificationArgs,
  hash
} from "./test-utils/release-candidate-fixture.mjs";
import { writeDeterministicTarGz } from "./deterministic-tar-gzip.mjs";
import { createPackageReleaseIdentity } from "./package-release-identity.mjs";
import {
  canonicalReleaseJson,
  runReleasePromotion,
  verifyReleaseSignatures,
  verifyNpmCandidate,
  parseArgs
} from "./release-promotion-adapter.mjs";

test("canonical Ed25519 verification retains production v2 domain and trusted key checks", async () => {
  const f = await setupCandidate();
  try {
    const keys = generateKeyPairSync("ed25519");
    const name = "koed-base-1.2.3-linux-x64.tar.gz.manifest.json";
    const bytes = f.contents.get(name);
    const manifest = resolve(f.root, "manifest.json");
    const signature = resolve(f.root, "signature.json");
    writeFileSync(manifest, bytes);
    const roots = {
      schemaVersion: 1,
      keys: { prod: keys.publicKey.export({ type: "spki", format: "pem" }) }
    };
    const artifacts = [
      {
        manifest,
        signature,
        component: "base",
        version: "1.2.3",
        target: "linux-x64"
      }
    ];
    const envelope = {
      schemaVersion: 2,
      algorithm: "ed25519",
      keyId: "prod",
      signature: sign(
        null,
        componentManifestSigningBytes(bytes),
        keys.privateKey
      ).toString("base64")
    };
    writeFileSync(signature, JSON.stringify(envelope));
    assert.equal(verifyReleaseSignatures(artifacts, roots).length, 1);
    assert.throws(
      () =>
        verifyReleaseSignatures(
          [{ ...artifacts[0], target: "darwin-arm64" }],
          roots
        ),
      /target mismatch/
    );
    writeFileSync(signature, JSON.stringify({ ...envelope, schemaVersion: 1 }));
    assert.throws(
      () => verifyReleaseSignatures(artifacts, roots),
      /signature or trusted key is invalid/
    );
    writeFileSync(
      signature,
      JSON.stringify({
        ...envelope,
        signature: sign(
          null,
          Buffer.concat([Buffer.from("koed-component-manifest-v1\n"), bytes]),
          keys.privateKey
        ).toString("base64")
      })
    );
    assert.throws(
      () => verifyReleaseSignatures(artifacts, roots),
      /manifest signature is invalid/
    );
  } finally {
    f.cleanup();
  }
});

test("verify-only ignores mutation/signer capabilities; publication rejects without separate approval before any I/O", async () => {
  const f = await setupCandidate({ desktop: true });
  try {
    const args = verificationArgs(f);
    let calls = 0;
    const forbidden = () => {
      calls++;
      throw new Error("mutation capability touched");
    };
    const adapters = {
      readers: f.readers,
      run: forbidden,
      fetchImpl: forbidden,
      fetchRegistry: forbidden,
      signerToken: "unused"
    };
    const receipt = await runReleasePromotion(
      { ...args, verifyOnly: true },
      adapters
    );
    assert.equal(receipt.kind, "verified-release-candidate");
    await assert.rejects(
      runReleasePromotion(args, {
        ...adapters,
        readers: new Proxy({}, { get: forbidden })
      }),
      /Independent publication approval/
    );
    assert.equal(calls, 0);
    assert.equal(parseArgs(["--verify-only"]).verifyOnly, true);
    assert.throws(
      () => parseArgs(["--expected-build", "--verify-only"]),
      /Missing or duplicate/
    );
  } finally {
    f.cleanup();
  }
});

test("candidate failures block all publication adapters even with independent approval", async () => {
  const cases = [
    (f) => f.contents.delete("component-manifest-hashes.json"),
    (f) => f.contents.set("component-manifest-hashes.json", Buffer.from("{}")),
    (f) =>
      f.contents.set("koed-labs-server.tgz", Buffer.from("substituted npm")),
    (f) =>
      f.contents.set(
        f.expected.desktop.asset,
        Buffer.from("substituted Desktop")
      ),
    (f) => {
      f.expected.commit = "f".repeat(40);
    },
    (f) => {
      f.expected.npm.integrity = `sha512-${"a".repeat(88)}`;
    },
    (f) => {
      f.release.draft = false;
    },
    (f) => {
      f.readers.getAsset = async () => {
        throw new Error("unavailable candidate");
      };
    }
  ];
  for (const alter of cases) {
    const f = await setupCandidate({ desktop: true });
    try {
      alter(f);
      let calls = 0;
      const forbidden = () => {
        calls++;
        throw new Error("mutation/signing touched");
      };
      await assert.rejects(
        runReleasePromotion(verificationArgs(f), {
          publicationApproved: true,
          readers: f.readers,
          run: forbidden,
          fetchRegistry: forbidden,
          fetchImpl: forbidden,
          signerToken: "must-not-use"
        })
      );
      assert.equal(calls, 0);
    } finally {
      f.cleanup();
    }
  }
});

for (const downloadDrift of [false, true, "tarball"])
  test(`production promotion binds signatures before mocked mutation (download drift: ${downloadDrift})`, async () => {
    const f = await setupCandidate({ desktop: true });
    try {
      const keys = generateKeyPairSync("ed25519");
      const roots = {
        schemaVersion: 1,
        keys: { prod: keys.publicKey.export({ type: "spki", format: "pem" }) }
      };
      const rootsPath = resolve(f.root, "roots.json");
      writeFileSync(rootsPath, canonicalReleaseJson(roots));
      writeFileSync(
        resolve(f.packageRoot, "dist/component-trust-roots.js"),
        `export const productionComponentTrustRoots = new Map(${JSON.stringify(Object.entries(roots.keys))});`
      );
      const tarball = resolve(f.assetsDir, "koed-labs-server.tgz");
      writeDeterministicTarGz({
        sourceDir: f.packageRoot,
        tarPath: tarball,
        rootName: "package"
      });
      f.contents.set("koed-labs-server.tgz", readFileSync(tarball));
      const identity = createPackageReleaseIdentity({
        packageRoot: f.packageRoot,
        tarball,
        version: "1.2.3"
      });
      f.contents.set(
        "koed-labs-server-release-identity.json",
        Buffer.from(JSON.stringify(identity))
      );
      f.expected.npm = identity.npm;
      for (const [name, bytes] of [...f.contents])
        if (name.endsWith(".manifest.json")) {
          const signature = {
            schemaVersion: 2,
            algorithm: "ed25519",
            keyId: "prod",
            signature: sign(
              null,
              componentManifestSigningBytes(bytes),
              keys.privateKey
            ).toString("base64")
          };
          const signatureName = name.replace(
            /\.manifest\.json$/,
            ".signature.json"
          );
          f.contents.set(signatureName, Buffer.from(JSON.stringify(signature)));
          if (!f.release.assets.some((asset) => asset.name === signatureName))
            f.release.assets.push({
              id: f.release.assets.length + 10,
              name: signatureName
            });
        }
      f.expected.assets = [...f.contents].map(([name, bytes]) => ({
        name,
        sha256: hash(bytes)
      }));
      const args = {
        ...verificationArgs(f),
        trustRoots: rootsPath,
        trustRootsSha256: hash(readFileSync(rootsPath)),
        controlplaneTrustRootsSha256: hash(canonicalReleaseJson(roots.keys)),
        signerUrl: "https://signer.invalid",
        signerKeyId: "prod"
      };
      let published = false;
      const mutations = [];
      const tarCalls = [];
      let signatures = 0;
      const metadata = {
        name: "@koed-labs/server",
        version: "1.2.3",
        dist: { integrity: identity.npm.integrity }
      };
      f.readers.getRegistryVersion = async (_name, version) =>
        version === "latest" || !published ? null : metadata;
      const adapters = {
        publicationApproved: true,
        signerToken: "mock-oidc",
        readers: f.readers,
        run: (command, argv, options = {}) => {
          if (command === "tar") {
            tarCalls.push(argv);
            return execFileSync(command, argv, { encoding: "utf8" });
          }
          if (command === "gh" && !argv.includes("PATCH")) {
            const assetId = Number(argv.at(-1).split("/").at(-1));
            if (argv.includes("Accept: application/octet-stream")) {
              const asset = f.release.assets.find(
                (item) => item.id === assetId
              );
              const bytes = f.contents.get(asset.name);
              writeFileSync(
                options.stdio[1],
                (downloadDrift === true &&
                  asset.name.endsWith(".signature.json")) ||
                  (downloadDrift === "tarball" &&
                    asset.name === "koed-labs-server.tgz")
                  ? Buffer.concat([bytes, Buffer.from("\n")])
                  : bytes
              );
              return "";
            }
            return JSON.stringify(f.release);
          }
          mutations.push([command, ...argv]);
          if (command === "npm" && argv[0] === "publish") published = true;
          return "";
        },
        fetchRegistry: async (_name, version) =>
          version === "latest" || !published ? null : metadata,
        fetchImpl: async (_url, options) => {
          assert.equal(options.headers.authorization, "Bearer mock-oidc");
          signatures++;
          return { ok: true, json: async () => ({ verified: true }) };
        }
      };
      await assert.rejects(
        runReleasePromotion(args, { ...adapters, signerToken: undefined }),
        /signer authorization/
      );
      if (downloadDrift) {
        await assert.rejects(
          runReleasePromotion(args, adapters),
          /Release asset differs from protected build/
        );
        assert.equal(
          mutations.length,
          0,
          "download drift must reject before any npm/GitHub mutation"
        );
        if (downloadDrift === "tarball")
          assert.equal(
            tarCalls.length,
            0,
            "unreviewed tarball bytes must not reach tar"
          );
        return;
      }
      const result = await runReleasePromotion(args, adapters);
      assert.equal(result.ok, true);
      assert.equal(signatures, 4);
      assert.equal(
        mutations.filter(
          ([cmd, action]) => cmd === "npm" && action === "publish"
        ).length,
        1
      );
      assert.ok(
        mutations.some(([cmd, , , , tag]) => cmd === "npm" && tag === "latest")
      );
      assert.ok(
        mutations.some(
          ([cmd, ...argv]) => cmd === "gh" && argv.includes("PATCH")
        )
      );
      mutations.length = 0;
      f.contents.set(
        "component-manifest-hashes.json",
        Buffer.from("substituted")
      );
      await assert.rejects(runReleasePromotion(args, adapters), /digest/);
      assert.equal(mutations.length, 0);
    } finally {
      f.cleanup();
    }
  });

test("registry package/version/SRI must match exact candidate", async () => {
  const expected = {
    packageName: "@koed-labs/server",
    version: "1.0.0",
    integrity: "sha512-YWJj"
  };
  assert.deepEqual(
    await verifyNpmCandidate(expected, async () => ({
      name: expected.packageName,
      version: expected.version,
      dist: { integrity: expected.integrity }
    })),
    { verified: true }
  );
  await assert.rejects(
    verifyNpmCandidate(expected, async () => ({
      name: expected.packageName,
      version: expected.version,
      dist: { integrity: "sha512-d3Jvbmc=" }
    })),
    /registry integrity mismatch/
  );
});
