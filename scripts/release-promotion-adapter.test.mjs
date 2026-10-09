import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  canonicalReleaseJson,
  runReleasePromotion,
  verifyReleaseSignatures,
  verifyNpmCandidate
} from "./release-promotion-adapter.mjs";

const temporary = () => mkdtempSync(resolve(tmpdir(), "koed-promotion-test-"));
const sha256 = "a".repeat(64);

test("verifies canonical Ed25519 component signatures against explicit digest-pinned roots", () => {
  const root = temporary();
  try {
    const keys = generateKeyPairSync("ed25519");
    const manifest = {
      archive: { name: "koed-base-1.0.0-linux-x64.tar.gz", bytes: 1, sha256 },
      component: "base",
      productVersion: "1.0.0",
      schemaVersion: 1,
      target: { platform: "linux", architecture: "x64" }
    };
    const signature = sign(
      null,
      Buffer.concat([
        Buffer.from("koed-component-manifest-v1\n"),
        Buffer.from(canonicalReleaseJson(manifest))
      ]),
      keys.privateKey
    ).toString("base64");
    const files = {
      manifest: resolve(root, "manifest.json"),
      signature: resolve(root, "signature.json")
    };
    writeFileSync(files.manifest, canonicalReleaseJson(manifest));
    writeFileSync(
      files.signature,
      `${JSON.stringify({ schemaVersion: 1, algorithm: "ed25519", keyId: "prod", signature })}\n`
    );
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" });
    const roots = { schemaVersion: 1, keys: { prod: publicKeyPem } };
    assert.equal(
      verifyReleaseSignatures(
        [
          { ...files, component: "base", version: "1.0.0", target: "linux-x64" }
        ],
        roots
      ).length,
      1
    );
    assert.throws(
      () =>
        verifyReleaseSignatures(
          [
            {
              ...files,
              component: "base",
              version: "1.0.0",
              target: "darwin-arm64"
            }
          ],
          roots
        ),
      /target mismatch/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promotes draft through mocked GitHub, signer, and npm adapters after real signature checks", async () => {
  const root = temporary();
  try {
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" });
    const roots = { schemaVersion: 1, keys: { prod: publicKeyPem } };
    const rootBytes = Buffer.from(`${JSON.stringify(roots)}\n`);
    const rootsPath = resolve(root, "roots.json");
    writeFileSync(rootsPath, rootBytes);
    const version = "1.0.0";
    const packedRoot = resolve(root, "packed");
    mkdirSync(resolve(packedRoot, "package/dist"), { recursive: true });
    writeFileSync(
      resolve(packedRoot, "package/dist/component-trust-roots.js"),
      `export const productionComponentTrustRoots = new Map([["prod", ${JSON.stringify(publicKeyPem)}]]);`
    );
    const packedPath = resolve(root, "server.tgz");
    execFileSync("tar", ["-czf", packedPath, "-C", packedRoot, "package"]);
    const packageTarball = readFileSync(packedPath);
    const packageIntegrity = `sha512-${createHash("sha512").update(packageTarball).digest("base64")}`;
    const identity = {
      packageName: "@koed-labs/server",
      version,
      npm: { integrity: packageIntegrity, inventorySha256: "b".repeat(64) }
    };
    const assets = [];
    const contents = new Map();
    for (const [component, platform, architecture] of [
      ["base", "linux", "x64"],
      ["privacy", "linux", "x64"],
      ["base", "macos", "arm64"],
      ["privacy", "macos", "arm64"]
    ]) {
      const archiveName = `koed-${component}-${version}-${platform}-${architecture}.tar.gz`;
      const archive = Buffer.alloc(
        2 * 1024 * 1024,
        `${component}-${platform}-${architecture}`
      );
      const manifest = {
        archive: {
          name: archiveName,
          bytes: archive.length,
          sha256: createHash("sha256").update(archive).digest("hex")
        },
        component,
        productVersion: version,
        schemaVersion: 1,
        target: { platform, architecture }
      };
      const manifestName = `${archiveName}.manifest.json`;
      const signatureName = `${archiveName}.signature.json`;
      const signature = sign(
        null,
        Buffer.concat([
          Buffer.from("koed-component-manifest-v1\n"),
          Buffer.from(canonicalReleaseJson(manifest))
        ]),
        keys.privateKey
      ).toString("base64");
      contents.set(manifestName, Buffer.from(canonicalReleaseJson(manifest)));
      contents.set(
        signatureName,
        Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            algorithm: "ed25519",
            keyId: "prod",
            signature
          })
        )
      );
      contents.set(archiveName, archive);
      for (const name of [archiveName, manifestName, signatureName])
        assets.push({ name, id: assets.length + 1 });
    }
    contents.set(
      "koed-labs-server-release-identity.json",
      Buffer.from(JSON.stringify(identity))
    );
    contents.set("koed-labs-server.tgz", packageTarball);
    assets.push(
      { name: "koed-labs-server-release-identity.json", id: assets.length + 1 },
      { name: "koed-labs-server.tgz", id: assets.length + 2 }
    );
    const calls = [];
    const result = await runReleasePromotion(
      {
        trustRoots: rootsPath,
        trustRootsSha256: createHash("sha256").update(rootBytes).digest("hex"),
        controlplaneTrustRootsSha256: createHash("sha256")
          .update(canonicalReleaseJson(roots.keys))
          .digest("hex"),
        signerUrl: "https://signer.invalid",
        signerKeyId: "prod",
        repository: "org/repo",
        releaseId: "42",
        version
      },
      {
        run: (name, args, options = {}) => {
          calls.push([name, args]);
          if (name === "gh" && args[0] === "api" && args.length === 2)
            return JSON.stringify({ tag_name: "v1.0.0", draft: true, assets });
          if (name === "gh" && args[0] === "api" && args[1] === "--header") {
            const asset = assets.find((asset) =>
              args.at(-1).endsWith(`/${asset.id}`)
            );
            const fixturePath = resolve(root, asset.name);
            writeFileSync(fixturePath, contents.get(asset.name));
            return execFileSync(
              process.execPath,
              [
                "-e",
                "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))",
                fixturePath
              ],
              {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "inherit"],
                ...options
              }
            );
          }
          if (name === "tar")
            return execFileSync(name, args, { encoding: "utf8", ...options });
          return "";
        },
        fetchRegistry: async (_name, requestedVersion) =>
          requestedVersion === "latest"
            ? { name: "@koed-labs/server", version: "0.9.0" }
            : {
                name: identity.packageName,
                version,
                dist: { integrity: packageIntegrity }
              },
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ verified: true })
        })
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.verifiedSignatures, 4);
    assert.ok(
      calls.some(
        ([name, args]) => name === "gh" && args.includes("draft=false")
      )
    );
    assert.ok(
      calls.some(([name, args]) => name === "npm" && args.at(-1) === "latest")
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checks candidate registry metadata for exact package, version, and sha512 integrity", async () => {
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
