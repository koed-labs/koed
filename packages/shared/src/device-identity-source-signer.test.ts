import { randomBytes, randomUUID, verify } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDeviceBoundSourceSigner,
  createPlatformHostProofStore,
  deviceIdentityStatePathFor,
  deviceProofFingerprint,
  hostProofReferenceFor,
  serializeHostProof
} from "./device-identity.js";
import { pdsEd25519PublicKey } from "./personal-device-sync.js";

const roots: string[] = [];

const fixture = (options: { symlinkedAncestor?: boolean } = {}) => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-source-signer-"));
  roots.push(root);
  const storageRoot = resolve(root, "storage");
  mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  const homeRoot = options.symlinkedAncestor
    ? resolve(root, "storage-alias")
    : storageRoot;
  if (options.symlinkedAncestor) {
    symlinkSync(storageRoot, homeRoot, "dir");
  }
  const koedHome = resolve(homeRoot, "home");
  const proofDirectory = resolve(root, "proof");
  mkdirSync(resolve(koedHome, "config"), { recursive: true, mode: 0o700 });
  const deploymentId = randomUUID();
  const deviceInstanceId = randomUUID();
  const proof = randomBytes(32).toString("base64url");
  const reference = hostProofReferenceFor(deviceInstanceId);
  const statePath = deviceIdentityStatePathFor(koedHome);
  writeFileSync(
    statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      deploymentId,
      deviceInstanceId,
      proof: {
        reference,
        fingerprint: deviceProofFingerprint(proof)
      },
      remoteOperations: "enabled",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    })}\n`,
    { mode: 0o600 }
  );
  const environment = {
    ...process.env,
    KOED_DEVICE_PROOF_DIR: proofDirectory
  };
  createPlatformHostProofStore({
    koedHome,
    environment,
    platform: "linux"
  }).write(
    reference,
    serializeHostProof({
      deploymentId,
      deviceInstanceId,
      proof,
      canonicalKoedHome: realpathSync(koedHome)
    })
  );
  return { koedHome, environment };
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("device-bound conversation source signing", () => {
  it("derives a stable generation-scoped Ed25519 key without persisting it", () => {
    const source = fixture();
    const sourceGenerationId = randomUUID();
    const originKeyId = randomUUID();
    const first = createDeviceBoundSourceSigner({
      ...source,
      sourceGenerationId,
      originKeyId,
      platform: "linux"
    });
    const second = createDeviceBoundSourceSigner({
      ...source,
      sourceGenerationId,
      originKeyId,
      platform: "linux"
    });
    const payload = Buffer.from("source manifest", "utf8");

    expect(second.keyId).toBe(first.keyId);
    expect(second.publicKey).toBe(first.publicKey);
    expect(
      verify(
        null,
        payload,
        pdsEd25519PublicKey(first.publicKey),
        Buffer.from(first.sign(payload), "base64url")
      )
    ).toBe(true);
  });

  it("derives distinct keys for distinct source generations", () => {
    const source = fixture();
    const first = createDeviceBoundSourceSigner({
      ...source,
      sourceGenerationId: randomUUID(),
      originKeyId: randomUUID(),
      platform: "linux"
    });
    const second = createDeviceBoundSourceSigner({
      ...source,
      sourceGenerationId: randomUUID(),
      originKeyId: randomUUID(),
      platform: "linux"
    });

    expect(second.keyId).not.toBe(first.keyId);
    expect(second.publicKey).not.toBe(first.publicKey);
  });

  it("accepts a canonical home reached through a symlinked ancestor", () => {
    const source = fixture({ symlinkedAncestor: true });

    expect(() =>
      createDeviceBoundSourceSigner({
        ...source,
        sourceGenerationId: randomUUID(),
        originKeyId: randomUUID(),
        platform: "linux"
      })
    ).not.toThrow();
  });

  it("fails closed when the host-bound proof is unavailable", () => {
    const source = fixture();
    expect(() =>
      createDeviceBoundSourceSigner({
        koedHome: source.koedHome,
        environment: {
          ...source.environment,
          KOED_DEVICE_PROOF_DIR: resolve(source.koedHome, "copied-proof")
        },
        sourceGenerationId: randomUUID(),
        originKeyId: randomUUID(),
        platform: "linux"
      })
    ).toThrow("verified device identity");
  });
});
