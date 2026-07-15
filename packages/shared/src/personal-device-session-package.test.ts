import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { signPdsRecord } from "./personal-device-sync.js";
import { canonicalizePdsJson } from "./personal-device-sync-jcs.js";
import {
  PDS_SESSION_PACKAGE_MAX_CHUNK_BYTES,
  classifyPdsSessionPackageReplay,
  createPdsSessionManifest,
  createPdsSessionPackage,
  pdsDeletionFloorToken,
  pdsLogicalMemoryId,
  pdsProjectAliasToken,
  pdsSessionPackageDigest,
  pdsSessionPackageReplayEntry,
  pdsSourceFingerprint,
  retainPdsSessionPackage,
  retryPdsSessionPackage,
  rewrapPdsSessionPackage,
  parsePdsSessionManifestJson,
  parsePdsSessionPackageJson,
  validatePdsSessionManifest,
  validatePdsSessionPackage,
  verifyAndDecryptPdsSessionPackage,
  verifyPdsSessionManifest,
  type PdsSessionPackage
} from "./personal-device-session-package.js";

const sessionPackageVector = (
  JSON.parse(
    readFileSync(
      new URL("../test-fixtures/personal-device-sync-v1.json", import.meta.url),
      "utf8"
    )
  ) as {
    sessionPackageV1: {
      canonicalItemUtf8: string;
      payload: string;
      payloadHash: string;
      sourceClosureHash: string;
    };
  }
).sessionPackageV1;

type RawKeyPair = {
  privateKey: KeyObject;
  publicKey: string;
  privateSeed: string;
};

const rawPair = (type: "ed25519" | "x25519"): RawKeyPair => {
  const pair =
    type === "ed25519"
      ? generateKeyPairSync("ed25519")
      : generateKeyPairSync("x25519");
  const publicJwk = pair.publicKey.export({ format: "jwk" }) as unknown as {
    x?: unknown;
  };
  const privateJwk = pair.privateKey.export({ format: "jwk" }) as unknown as {
    d?: unknown;
  };
  if (typeof publicJwk.x !== "string" || typeof privateJwk.d !== "string") {
    throw new Error("test key export failed");
  }
  return {
    privateKey: pair.privateKey,
    publicKey: publicJwk.x,
    privateSeed: privateJwk.d
  };
};

const fixture = () => {
  const origin = rawPair("ed25519");
  const serving = rawPair("ed25519");
  const recipient = rawPair("x25519");
  const sourceKey = Buffer.from(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    "hex"
  );
  const tombstoneKey = Buffer.from(
    "f0e0d0c0b0a090807060504030201000112233445566778899aabbccddeeff00",
    "hex"
  );
  const projectKey = Buffer.alloc(32, 3);
  const epoch = "3";
  const manifest = createPdsSessionManifest({
    originDeploymentId: "deployment-origin",
    originDeviceId: "device-origin",
    sourceSequence: "7",
    sourceNativeSessionId: "codex-thread-42",
    contentEpoch: epoch,
    closedSession: {
      closed: true,
      sourceAdapter: "codex",
      sourceAdapterVersion: "1",
      captureMethod: "supported_capture_hook",
      sourceCreatedAt: "2026-07-15T00:00:00.000Z",
      sourceClosedAt: "2026-07-15T00:00:01.000Z",
      observedClosedAt: "2026-07-15T00:00:02.000Z"
    },
    terminalCursor: "2",
    items: [
      {
        sourceNativeItemId: "item-0",
        sequence: "0",
        sourceTimestamp: "2026-07-15T00:00:00.000Z",
        observedAt: "2026-07-15T00:00:00.000Z",
        actor: "user",
        type: "message",
        content: "h".repeat(300_000),
        metadata: { contentType: "text/plain", sourceRole: "user" }
      },
      {
        sourceNativeItemId: "item-1",
        sequence: "1",
        sourceTimestamp: "2026-07-15T00:00:01.000Z",
        observedAt: "2026-07-15T00:00:01.000Z",
        actor: "assistant",
        type: "message",
        content: "w".repeat(300_000),
        metadata: { contentType: "text/plain", sourceRole: "assistant" }
      }
    ],
    sourceFingerprintKey: sourceKey,
    tombstoneFloorKey: tombstoneKey,
    originSigningKeyId: "origin-signing-key",
    originSigningPrivateKey: origin.privateKey,
    projectAliasManifest: {
      version: "1",
      epoch,
      tokens: [pdsProjectAliasToken(projectKey, "github.com/example/koed")]
    }
  });
  const input = {
    groupId: "group-alpha",
    authorityHead: Buffer.alloc(32, 7).toString("base64url"),
    expiresAt: "2030-07-15T00:00:00.000Z",
    currentEpoch: epoch,
    servingDeviceId: "device-serving",
    servingSigningKeyId: "serving-signing-key",
    servingSigningPrivateKey: serving.privateKey,
    recipients: [
      {
        deviceId: "device-recipient",
        kemKeyId: "recipient-kem-key",
        kemPublicKey: recipient.publicKey
      }
    ],
    manifest
  };
  const verify = {
    groupId: input.groupId,
    authorityHead: input.authorityHead,
    currentEpoch: epoch,
    recipientDeviceId: "device-recipient",
    recipientKemKeyId: "recipient-kem-key",
    recipientKemPrivateKey: recipient.privateSeed,
    recipientKemPublicKey: recipient.publicKey,
    recipientSnapshot: ["device-recipient"],
    servingDeviceId: input.servingDeviceId,
    servingSigningPublicKey: serving.publicKey,
    servingSigningKeyId: input.servingSigningKeyId,
    originSigningPublicKey: origin.publicKey,
    originSigningKeyId: "origin-signing-key",
    now: new Date("2026-07-15T00:00:00.000Z")
  };
  return {
    input,
    verify,
    manifest,
    origin,
    serving,
    recipient,
    sourceKey,
    tombstoneKey,
    projectKey
  };
};

const digest = (pkg: PdsSessionPackage): PdsSessionPackage =>
  retryPdsSessionPackage(pkg);

const withDigest = (pkg: PdsSessionPackage): PdsSessionPackage => ({
  ...pkg,
  packageDigest: pdsSessionPackageDigest({
    header: pkg.header,
    envelopes: pkg.envelopes,
    chunks: pkg.chunks
  })
});

describe("PDS origin-signed session package", () => {
  it("recomputes committed cross-language source closure vector", () => {
    const item = JSON.parse(
      Buffer.from(sessionPackageVector.payload, "base64url").toString("utf8")
    ) as unknown;
    const payload = Buffer.from(canonicalizePdsJson(item), "utf8");
    const record = {
      ordinal: "0",
      sourceNativeItemId: "item-0",
      sourceTimestamp: "2026-07-15T00:00:00.000Z",
      observedAt: "2026-07-15T00:00:00.000Z",
      payload: payload.toString("base64url"),
      payloadHash: createHash("sha256").update(payload).digest("base64url")
    };
    expect(payload.toString("utf8")).toBe(
      sessionPackageVector.canonicalItemUtf8
    );
    expect(record.payload).toBe(sessionPackageVector.payload);
    expect(record.payloadHash).toBe(sessionPackageVector.payloadHash);
    expect(
      createHash("sha256")
        .update(canonicalizePdsJson([record]))
        .digest("base64url")
    ).toBe(sessionPackageVector.sourceClosureHash);
  });

  it("recomputes fixed protocol HMAC vectors", () => {
    const { sourceKey, tombstoneKey, projectKey } = fixture();
    const fingerprint = pdsSourceFingerprint(sourceKey, "codex-thread-42");
    expect(fingerprint).toBe("ddDVvDeEXrlPT81rZXeCF_Z3AMTgZyq5_dp0EucIMss");
    expect(pdsLogicalMemoryId(tombstoneKey, fingerprint)).toBe(
      "6A-UBrkDyCYgd7QLVHFg8GKDw1OwvEMw73b5qU7-1BY"
    );
    expect(pdsDeletionFloorToken(tombstoneKey, fingerprint)).toBe(
      "5vaQmlye8E4OsU61njLXRK94sOm_yC26uueiGQHZu2M"
    );
    expect(pdsProjectAliasToken(projectKey, "github.com/example/koed")).toBe(
      "flV7fh_IMZUsqQig6k74gf2omzO5sZUlc67G_hTU7wo"
    );
  });

  it("creates, verifies, decrypts, retries, and rewraps immutable origin content", () => {
    const { input, verify, manifest, origin } = fixture();
    const pkg = createPdsSessionPackage(input);
    expect(verifyAndDecryptPdsSessionPackage(pkg, verify)).toEqual(manifest);
    expect(retryPdsSessionPackage(pkg)).toEqual(pkg);
    expect(parsePdsSessionManifestJson(canonicalizePdsJson(manifest))).toEqual(
      manifest
    );
    expect(parsePdsSessionPackageJson(canonicalizePdsJson(pkg))).toEqual(pkg);
    expect(() =>
      parsePdsSessionPackageJson(` ${canonicalizePdsJson(pkg)}`)
    ).toThrow("not RFC 8785 canonical");
    expect(
      retainPdsSessionPackage({
        originManifest: manifest,
        package: pkg,
        localEncryption: { provider: "local-kms", reference: "ciphertext-1" }
      }).originManifest
    ).toEqual(manifest);
    const rewrapped = rewrapPdsSessionPackage({
      ...input,
      originSigningPublicKey: origin.publicKey,
      originSigningKeyId: "origin-signing-key"
    });
    expect(rewrapped.header.transportId).not.toBe(pkg.header.transportId);
    expect(rewrapped.header.payloadNonce).not.toBe(pkg.header.payloadNonce);
    expect(rewrapped.packageDigest).not.toBe(pkg.packageDigest);
    expect(rewrapped.header.sourceManifestHash).toBe(
      pkg.header.sourceManifestHash
    );
    expect(verifyAndDecryptPdsSessionPackage(rewrapped, verify)).toEqual(
      manifest
    );
  });

  it("fails closed before plaintext for altered bindings, signatures, roles, and floors", () => {
    const { input, verify, serving, manifest } = fixture();
    const pkg = createPdsSessionPackage(input);
    const cases: PdsSessionPackage[] = [];
    const header = structuredClone(pkg);
    header.header.groupId = "group-other";
    cases.push(header);
    const content = structuredClone(pkg);
    content.chunks[0]!.ciphertext =
      Buffer.from("changed").toString("base64url");
    cases.push(content);
    const signature = structuredClone(pkg);
    signature.header.servingSignature.signature = Buffer.alloc(64, 9).toString(
      "base64url"
    );
    cases.push(signature);
    for (const value of cases)
      expect(() => verifyAndDecryptPdsSessionPackage(value, verify)).toThrow();
    const aad = structuredClone(pkg);
    aad.header.authorityHead = Buffer.alloc(32, 4).toString("base64url");
    const unsignedHeader = { ...aad.header } as Record<string, unknown>;
    delete unsignedHeader.servingSignature;
    aad.header.servingSignature.signature = signPdsRecord(
      "transport-envelope",
      unsignedHeader,
      serving.privateKey
    );
    const validAadMutation = withDigest(aad);
    expect(() =>
      verifyAndDecryptPdsSessionPackage(validAadMutation, {
        ...verify,
        authorityHead: aad.header.authorityHead
      })
    ).toThrow();
    expect(() =>
      verifyAndDecryptPdsSessionPackage(pkg, {
        ...verify,
        recipientDeviceId: "wrong-device"
      })
    ).toThrow();
    expect(() =>
      verifyAndDecryptPdsSessionPackage(pkg, { ...verify, currentEpoch: "4" })
    ).toThrow();
    expect(() =>
      verifyAndDecryptPdsSessionPackage(pkg, {
        ...verify,
        groupId: "group-other"
      })
    ).toThrow();
    expect(() =>
      verifyAndDecryptPdsSessionPackage(pkg, {
        ...verify,
        servingDeviceId: "device-other"
      })
    ).toThrow();
    expect(() =>
      verifyAndDecryptPdsSessionPackage(pkg, {
        ...verify,
        servingDeviceId: "wrong-member"
      })
    ).toThrow();
    expect(() =>
      verifyAndDecryptPdsSessionPackage(pkg, {
        ...verify,
        deletionFloor: {
          logicalMemoryId: manifest.logicalMemoryId,
          deletionFloorToken: manifest.deletionFloorToken
        }
      })
    ).toThrow();
    const zero = structuredClone(pkg);
    zero.envelopes[0]!.ephemeralPublicKey =
      Buffer.alloc(32).toString("base64url");
    const unsigned = { ...zero.envelopes[0]! } as Record<string, unknown>;
    delete unsigned.servingSignature;
    zero.envelopes[0]!.servingSignature.signature = signPdsRecord(
      "transport-envelope",
      unsigned,
      serving.privateKey
    );
    expect(() =>
      verifyAndDecryptPdsSessionPackage(withDigest(zero), verify)
    ).toThrow();
    const alteredManifest = structuredClone(manifest);
    alteredManifest.originSignature.signature = Buffer.alloc(64, 1).toString(
      "base64url"
    );
    expect(() =>
      verifyPdsSessionManifest(
        alteredManifest,
        verify.originSigningPublicKey,
        verify.originSigningKeyId
      )
    ).toThrow();
  });

  it("classifies replay by package ID and signed source manifest hash", () => {
    const { input } = fixture();
    const entry = pdsSessionPackageReplayEntry(createPdsSessionPackage(input));
    expect(classifyPdsSessionPackageReplay(undefined, entry)).toBe("new");
    expect(classifyPdsSessionPackageReplay(entry, entry)).toBe("idempotent");
    expect(
      classifyPdsSessionPackageReplay(entry, {
        ...entry,
        sourceManifestHash: Buffer.alloc(32, 4).toString("base64url")
      })
    ).toBe("quarantine");
    expect(
      classifyPdsSessionPackageReplay(entry, {
        ...entry,
        packageId: Buffer.alloc(32, 5).toString("base64url")
      })
    ).toBe("new");
  });

  it("rejects malformed nonce/tag, replay mutation, chunks, controls, and untrusted fields", () => {
    const { input, manifest } = fixture();
    const pkg = createPdsSessionPackage(input);
    const nonce = structuredClone(pkg);
    nonce.header.payloadNonce = "AA";
    expect(() => validatePdsSessionPackage(nonce)).toThrow();
    const tag = structuredClone(pkg);
    tag.envelopes[0]!.tag = "AA";
    expect(() => validatePdsSessionPackage(tag)).toThrow();
    const version = structuredClone(pkg);
    version.chunks[0]!.version = "2" as "1";
    expect(() => validatePdsSessionPackage(version)).toThrow();
    const changedId = structuredClone(pkg);
    changedId.header.transportId = Buffer.alloc(32, 2).toString("base64url");
    expect(() => digest(changedId)).toThrow();
    const reordered = structuredClone(pkg);
    reordered.chunks = [...reordered.chunks].reverse();
    expect(() => validatePdsSessionPackage(reordered)).toThrow();
    const dropped = structuredClone(pkg);
    dropped.chunks = [];
    expect(() => validatePdsSessionPackage(dropped)).toThrow();
    const duplicate = structuredClone(pkg);
    duplicate.chunks.push(structuredClone(duplicate.chunks[0]!));
    expect(() => validatePdsSessionPackage(duplicate)).toThrow();
    const truncated = structuredClone(pkg);
    truncated.chunks[0]!.ciphertext = truncated.chunks[0]!.ciphertext.slice(
      0,
      -2
    );
    expect(() => validatePdsSessionPackage(truncated)).toThrow();
    const oversized = structuredClone(pkg);
    oversized.chunks[0]!.ciphertext = Buffer.alloc(
      PDS_SESSION_PACKAGE_MAX_CHUNK_BYTES + 1
    ).toString("base64url");
    expect(() => validatePdsSessionPackage(oversized)).toThrow();
    expect(() =>
      validatePdsSessionPackage({ ...pkg, path: "/secret" })
    ).toThrow();
    expect(() =>
      validatePdsSessionManifest({ ...manifest, teamId: "team-no" })
    ).toThrow();
    const mutated = structuredClone(manifest);
    mutated.rawClosure.records[0]!.payload = Buffer.from("{}", "utf8").toString(
      "base64url"
    );
    expect(() => validatePdsSessionManifest(mutated)).toThrow();
    const open = structuredClone(manifest);
    open.closedSession.closed = false as true;
    expect(() => validatePdsSessionManifest(open)).toThrow();
  });

  it("rejects Session paths, credentials, vectors, derived state, and unknown source metadata", () => {
    const { manifest } = fixture();
    const source = structuredClone(manifest);
    const payload = JSON.parse(
      Buffer.from(source.rawClosure.records[0]!.payload, "base64url").toString(
        "utf8"
      )
    ) as { metadata: Record<string, unknown> };
    payload.metadata.path = "/Users/leak";
    const alteredPayload = Buffer.from(canonicalizePdsJson(payload), "utf8");
    source.rawClosure.records[0]!.payload =
      alteredPayload.toString("base64url");
    source.rawClosure.records[0]!.payloadHash = createHash("sha256")
      .update(alteredPayload)
      .digest("base64url");
    expect(() => validatePdsSessionManifest(source)).toThrow(
      "source item metadata is invalid"
    );
    for (const field of [
      "credential",
      "vector",
      "memoryEvents",
      "team",
      "databaseId"
    ]) {
      expect(() =>
        validatePdsSessionManifest({ ...manifest, [field]: "injected" })
      ).toThrow();
    }
  });
});
