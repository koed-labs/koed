import { describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { MemorySourceRepository } from "@koed/db";
import type { PdsSessionManifest, PdsSessionPackage } from "@koed/shared";
import {
  canonicalizePdsJson,
  createPdsSessionCheckpointManifest,
  createPdsSessionCheckpointPackage,
  createPdsSessionPackageRuntimeContext,
  pdsFinalizedTwoStageRecordHash,
  resolveSupportedEmbeddingModelConfig,
  signPdsRecord,
  verifyAndDecryptPdsSessionSourcePackage
} from "@koed/shared";
import {
  createReloadablePdsWorkerRuntimeFromEnvironment,
  deliverPdsPackageDirect,
  materializePdsSession,
  pdsCheckpointMaterializationSource,
  rewrapPdsCheckpointSourceEnvelope,
  resolvePdsEmbeddingCapability,
  resolvePdsLifecycleAuthorizationPublicKey,
  resolvePdsPeerEndpoint,
  resolvePdsProviderRuntimeSecret,
  validatePdsLifecycleStatementBinding
} from "./personal-device-sync-runtime.js";

const testRelayId = (value: string): string =>
  createHash("sha256")
    .update(value)
    .digest()
    .subarray(0, 16)
    .toString("base64url");

const testKeyPair = (type: "ed25519" | "x25519") => {
  const pair =
    type === "ed25519"
      ? generateKeyPairSync("ed25519")
      : generateKeyPairSync("x25519");
  const publicJwk = pair.publicKey.export({ format: "jwk" }) as { x?: unknown };
  const privateJwk = pair.privateKey.export({ format: "jwk" }) as {
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

const testMembershipCertificate = (input: {
  authorityPrivateKey: KeyObject;
  authorityKeyId: string;
  groupId: string;
  authorityHead: string;
  deviceId: string;
  signingKeyId: string;
  signingPublicKey: string;
  kemKeyId: string;
  kemPublicKey: string;
  epoch: string;
  statementSequence: string;
  issuedAt: string;
  expiresAt: string;
}): string => {
  const unsigned = {
    protocol: "koed/pds/v1",
    groupId: input.groupId,
    deviceId: input.deviceId,
    deviceSigningKeyId: input.signingKeyId,
    deviceSigningPublicKey: input.signingPublicKey,
    deviceKemKeyId: input.kemKeyId,
    deviceKemPublicKey: input.kemPublicKey,
    epoch: input.epoch,
    operationFamilies: ["pds_relay"],
    statementSequence: input.statementSequence,
    statementHash: input.authorityHead,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt
  };
  return canonicalizePdsJson({
    ...unsigned,
    authoritySignature: {
      keyId: input.authorityKeyId,
      signature: signPdsRecord(
        "membership-certificate",
        unsigned,
        input.authorityPrivateKey
      )
    }
  });
};

describe("PDS direct package delivery", () => {
  const pkg = {
    header: {
      transportId: Buffer.alloc(32, 1).toString("base64url")
    }
  } as PdsSessionPackage;

  const client = (input: {
    state?: "committed" | "acked";
    transportId?: string;
    receipt?: string | null;
  }) => ({
    upload: vi.fn().mockResolvedValue({
      transportId: input.transportId ?? pkg.header.transportId,
      deliveryState: input.state ?? "acked"
    }),
    waitForWake: vi.fn().mockResolvedValue(undefined),
    peerReceipt: vi
      .fn()
      .mockResolvedValue(
        input.receipt === undefined ? "signed-ack" : input.receipt
      )
  });

  it("requires every selected peer to return a verified materialization receipt", async () => {
    const ready = client({ state: "acked" });
    const waiting = client({ state: "committed" });
    const verifyReceipt = vi.fn();

    await expect(
      deliverPdsPackageDirect({
        pkg,
        clients: new Map([
          ["device-a", ready],
          ["device-b", waiting]
        ]),
        verifyReceipt,
        receiptSignal: () => new AbortController().signal
      })
    ).resolves.toBe(true);

    expect(ready.waitForWake).not.toHaveBeenCalled();
    expect(waiting.waitForWake).toHaveBeenCalledWith(expect.any(AbortSignal), [
      pkg.header.transportId
    ]);
    expect(verifyReceipt).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "no complete route set",
      clients: null,
      verifyReceipt: vi.fn()
    },
    {
      label: "wrong committed transport",
      clients: new Map([
        [
          "device-a",
          client({ transportId: Buffer.alloc(32, 2).toString("base64url") })
        ]
      ]),
      verifyReceipt: vi.fn()
    },
    {
      label: "missing recipient receipt",
      clients: new Map([["device-a", client({ receipt: null })]]),
      verifyReceipt: vi.fn()
    },
    {
      label: "invalid recipient receipt",
      clients: new Map([["device-a", client({})]]),
      verifyReceipt: vi.fn(() => {
        throw new Error("invalid receipt");
      })
    }
  ])(
    "falls back to the relay for $label",
    async ({ clients, verifyReceipt }) => {
      await expect(
        deliverPdsPackageDirect({ pkg, clients, verifyReceipt })
      ).resolves.toBe(false);
    }
  );
});

describe("PDS checkpoint transport rewrap", () => {
  it("rewraps the retained signed manifest for current recipients and leaves V1 transport bytes on the legacy path", () => {
    const authority = testKeyPair("ed25519");
    const origin = testKeyPair("ed25519");
    const oldOriginKem = testKeyPair("x25519");
    const oldRecipientKem = testKeyPair("x25519");
    const joiningSigning = testKeyPair("ed25519");
    const joiningKem = testKeyPair("x25519");
    const newOriginKem = testKeyPair("x25519");
    const groupId = testRelayId("checkpoint-group");
    const authorityKeyId = testRelayId("checkpoint-authority");
    const oldAuthorityHead = Buffer.alloc(32, 3).toString("base64url");
    const newAuthorityHead = Buffer.alloc(32, 4).toString("base64url");
    const originDeviceId = testRelayId("checkpoint-origin-device");
    const originSigningKeyId = testRelayId("checkpoint-origin-signing");
    const oldOriginCertificate = testMembershipCertificate({
      authorityPrivateKey: authority.privateKey,
      authorityKeyId,
      groupId,
      authorityHead: oldAuthorityHead,
      deviceId: originDeviceId,
      signingKeyId: originSigningKeyId,
      signingPublicKey: origin.publicKey,
      kemKeyId: testRelayId("checkpoint-origin-kem-old"),
      kemPublicKey: oldOriginKem.publicKey,
      epoch: "1",
      statementSequence: "1",
      issuedAt: "2026-09-14T00:00:00.000Z",
      expiresAt: "2026-09-19T00:00:00.000Z"
    });
    const oldRecipientCertificate = testMembershipCertificate({
      authorityPrivateKey: authority.privateKey,
      authorityKeyId,
      groupId,
      authorityHead: oldAuthorityHead,
      deviceId: testRelayId("checkpoint-recipient-old"),
      signingKeyId: testRelayId("checkpoint-recipient-old-signing"),
      signingPublicKey: testKeyPair("ed25519").publicKey,
      kemKeyId: testRelayId("checkpoint-recipient-old-kem"),
      kemPublicKey: oldRecipientKem.publicKey,
      epoch: "1",
      statementSequence: "1",
      issuedAt: "2026-09-14T00:00:00.000Z",
      expiresAt: "2026-09-19T00:00:00.000Z"
    });
    const oldRuntime = createPdsSessionPackageRuntimeContext({
      authorityPublicKey: authority.publicKey,
      authorityKeyId,
      groupId,
      authorityHead: oldAuthorityHead,
      currentEpoch: "1",
      servingCertificate: oldOriginCertificate,
      recipientCertificate: oldRecipientCertificate,
      recipientCertificates: [oldRecipientCertificate],
      now: new Date("2026-09-15T00:00:00.000Z")
    });
    const sourceSession = {
      logicalSessionId: "logical-checkpoint-session",
      externalSessionId: "codex-checkpoint-session",
      sourceAdapter: "codex",
      sourceAdapterVersion: "codex-transcript-v1",
      sourceRuntime: "codex" as const,
      captureMethod: "transcript" as const,
      sourceCreatedAt: "2026-09-15T00:00:00.000Z"
    };
    const manifest = createPdsSessionCheckpointManifest({
      runtime: oldRuntime,
      originDeploymentId: testRelayId("checkpoint-origin-deployment"),
      sourceSequence: "1",
      sourceNativeSessionId: sourceSession.externalSessionId,
      contentEpoch: "1",
      sourceSession,
      checkpoint: { version: "1", ordinal: "0", previousClosureHash: null },
      terminalCursor: "1",
      items: [
        {
          sourceNativeItemId: "item-0",
          sequence: "0",
          sourceTimestamp: "2026-09-15T00:00:00.000Z",
          observedAt: "2026-09-15T00:00:00.100Z",
          actor: "assistant",
          type: "message",
          content: "completed turn",
          metadata: { sourceRole: "assistant" }
        }
      ],
      sourceFingerprintKey: Buffer.alloc(32, 5),
      tombstoneFloorKey: Buffer.alloc(32, 6),
      originSigningPrivateKey: origin.privateKey
    });
    const originalPackage = createPdsSessionCheckpointPackage({
      runtime: oldRuntime,
      expiresAt: "2026-09-16T00:00:00.000Z",
      servingSigningPrivateKey: origin.privateKey,
      manifest
    });

    const joiningDeviceId = testRelayId("checkpoint-recipient-joined");
    const newOriginCertificate = testMembershipCertificate({
      authorityPrivateKey: authority.privateKey,
      authorityKeyId,
      groupId,
      authorityHead: newAuthorityHead,
      deviceId: originDeviceId,
      signingKeyId: originSigningKeyId,
      signingPublicKey: origin.publicKey,
      kemKeyId: testRelayId("checkpoint-origin-kem-new"),
      kemPublicKey: newOriginKem.publicKey,
      epoch: "2",
      statementSequence: "2",
      issuedAt: "2026-09-21T00:00:00.000Z",
      expiresAt: "2026-09-26T00:00:00.000Z"
    });
    const joiningCertificate = testMembershipCertificate({
      authorityPrivateKey: authority.privateKey,
      authorityKeyId,
      groupId,
      authorityHead: newAuthorityHead,
      deviceId: joiningDeviceId,
      signingKeyId: testRelayId("checkpoint-recipient-joined-signing"),
      signingPublicKey: joiningSigning.publicKey,
      kemKeyId: testRelayId("checkpoint-recipient-joined-kem"),
      kemPublicKey: joiningKem.publicKey,
      epoch: "2",
      statementSequence: "2",
      issuedAt: "2026-09-21T00:00:00.000Z",
      expiresAt: "2026-09-26T00:00:00.000Z"
    });
    const currentRuntime = createPdsSessionPackageRuntimeContext({
      authorityPublicKey: authority.publicKey,
      authorityKeyId,
      groupId,
      authorityHead: newAuthorityHead,
      currentEpoch: "2",
      servingCertificate: newOriginCertificate,
      recipientCertificate: joiningCertificate,
      recipientCertificates: [joiningCertificate],
      historicalOriginCertificates: [oldOriginCertificate],
      now: new Date("2026-09-22T00:00:00.000Z")
    });
    const plaintext = canonicalizePdsJson({
      kind: "pds_checkpoint_source_v1",
      manifest,
      package: originalPackage
    });
    const expectedSourceManifestHash =
      originalPackage.header.sourceManifestHash;
    const rewrapped = rewrapPdsCheckpointSourceEnvelope({
      plaintext,
      runtime: currentRuntime,
      servingSigningPrivateKey: origin.privateKey,
      expiresAt: "2026-09-23T00:00:00.000Z",
      expectedGroupId: groupId,
      expectedPackageId: manifest.packageId,
      expectedSourceManifestHash
    });

    expect(rewrapped).not.toBeNull();
    expect(rewrapped!.header.transportId).not.toBe(
      originalPackage.header.transportId
    );
    expect(rewrapped!.header.recipientEpoch).toBe("2");
    expect(rewrapped!.header.contentEpoch).toBe("1");
    expect(rewrapped!.header.intendedRecipientSnapshot).toEqual([
      joiningDeviceId
    ]);
    expect(rewrapped!.header.packageId).toBe(manifest.packageId);
    expect(rewrapped!.header.sourceManifestHash).toBe(
      expectedSourceManifestHash
    );
    expect(() =>
      rewrapPdsCheckpointSourceEnvelope({
        plaintext,
        runtime: currentRuntime,
        servingSigningPrivateKey: origin.privateKey,
        expiresAt: "2026-09-23T00:00:00.000Z",
        expectedGroupId: groupId,
        expectedPackageId: manifest.packageId,
        expectedSourceManifestHash: testRelayId("wrong-source-manifest")
      })
    ).toThrow("PdsCryptoIdentityError");
    expect(
      rewrapPdsCheckpointSourceEnvelope({
        plaintext: canonicalizePdsJson(originalPackage),
        runtime: currentRuntime,
        servingSigningPrivateKey: origin.privateKey,
        expiresAt: "2026-09-23T00:00:00.000Z",
        expectedGroupId: groupId,
        expectedPackageId: manifest.packageId,
        expectedSourceManifestHash
      })
    ).toBeNull();

    const recovered = verifyAndDecryptPdsSessionSourcePackage(
      canonicalizePdsJson(rewrapped),
      {
        runtime: currentRuntime,
        recipientKemPrivateKey: joiningKem.privateSeed,
        now: new Date("2026-09-22T00:00:00.000Z")
      }
    );
    expect(recovered).toEqual(manifest);
    expect(recovered.originSignature).toEqual(manifest.originSignature);
  });
});

describe("PDS peer endpoint discovery", () => {
  it("reads a strict Desktop-published endpoint record dynamically", () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-worker-peer-"));
    try {
      mkdirSync(resolve(koedHome, "run"), { recursive: true });
      writeFileSync(
        resolve(koedHome, "run", "pds-peer-endpoint.json"),
        JSON.stringify({
          version: 1,
          endpointUrl: "http://192.168.1.20:3310/pds"
        })
      );
      expect(resolvePdsPeerEndpoint({ KOED_HOME: koedHome })).toBe(
        "http://192.168.1.20:3310/pds"
      );
    } finally {
      rmSync(koedHome, { recursive: true, force: true });
    }
  });

  it("fails closed for malformed records and public plaintext endpoints", () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-worker-peer-"));
    try {
      mkdirSync(resolve(koedHome, "run"), { recursive: true });
      writeFileSync(
        resolve(koedHome, "run", "pds-peer-endpoint.json"),
        JSON.stringify({
          version: 1,
          endpointUrl: "http://public.example/pds",
          injected: true
        })
      );
      expect(resolvePdsPeerEndpoint({ KOED_HOME: koedHome })).toBeNull();
    } finally {
      rmSync(koedHome, { recursive: true, force: true });
    }
  });
});

describe("PDS semantic capability", () => {
  const model = resolveSupportedEmbeddingModelConfig("qwen3-0.6b");
  const modelArtifactHash = model.defaultArtifactSha256;

  it("advertises readiness only for the exact healthy embedding runtime", () => {
    const capability = resolvePdsEmbeddingCapability({
      model,
      modelArtifactHash,
      status: {
        enabled: true,
        healthy: true,
        model: model.key,
        dimensions: model.dimensions
      }
    });

    expect(capability).toEqual({
      contract: {
        artifactClass: "memory_embedding/v1",
        modelKey: model.key,
        modelArtifactHash,
        dimensions: String(model.dimensions),
        tokenizer: model.tokenizer,
        inputTransform: model.inputTransform,
        pooling: model.pooling,
        normalization: model.normalization,
        embeddingVersion: model.key
      },
      compatibilityContractHash: expect.any(String),
      readiness: "ready"
    });
  });

  it.each([
    {
      label: "unhealthy",
      status: {
        enabled: true,
        healthy: false,
        model: model.key,
        dimensions: model.dimensions
      }
    },
    {
      label: "wrong model",
      status: {
        enabled: true,
        healthy: true,
        model: "other-model",
        dimensions: model.dimensions
      }
    },
    {
      label: "wrong dimensions",
      status: {
        enabled: true,
        healthy: true,
        model: model.key,
        dimensions: model.dimensions / 2
      }
    }
  ])("advertises unavailable for a $label runtime", ({ status }) => {
    expect(
      resolvePdsEmbeddingCapability({
        model,
        modelArtifactHash,
        status
      }).readiness
    ).toBe("unavailable");
  });
});

describe("PDS session materialization", () => {
  it("resolves recovery-root lifecycle authorization without a membership certificate", () => {
    const secret = {
      recovery: {
        signingKeyId: "recovery-signing",
        signingPublicKey: "recovery-public"
      },
      recipientCertificates: []
    } as never;

    expect(
      resolvePdsLifecycleAuthorizationPublicKey(secret, "recovery-signing")
    ).toBe("recovery-public");
    expect(() =>
      resolvePdsLifecycleAuthorizationPublicKey(secret, "unknown-signing")
    ).toThrow("PdsCryptoAuthorityError");
  });

  it("binds a lifecycle record to the exact committed statement", () => {
    const lifecycleRecord = {
      draft: {
        statementHash: "prior-head",
        deletionFloorToken: "floor"
      },
      authorization: { signerKeyId: "device", signature: "signature" },
      authority: { keyId: "authority", signature: "signature" }
    };
    const lifecycleHash = pdsFinalizedTwoStageRecordHash(
      lifecycleRecord as never
    );
    const statement = {
      draft: {
        kind: "tombstone",
        previousHash: "prior-head",
        body: {
          tombstoneHash: lifecycleHash,
          deletionFloorToken: "floor"
        }
      }
    };

    expect(() =>
      validatePdsLifecycleStatementBinding(
        "tombstone",
        lifecycleRecord,
        statement
      )
    ).not.toThrow();
    expect(() =>
      validatePdsLifecycleStatementBinding("tombstone", lifecycleRecord, {
        draft: {
          ...statement.draft,
          body: {
            ...statement.draft.body,
            tombstoneHash: "another-valid-record"
          }
        }
      })
    ).toThrow("PdsCryptoAuthorityError");
  });

  it("binds conflict resolution to its exact finalized control", () => {
    const lifecycleRecord = {
      draft: {
        statementHash: "prior-head",
        sourceFingerprint: "fingerprint",
        selectedClosureHash: "selected",
        resolution: "select"
      },
      authorization: { signerKeyId: "device", signature: "signature" },
      authority: { keyId: "authority", signature: "signature" }
    };
    const statement = {
      draft: {
        kind: "resolve-conflict",
        previousHash: "prior-head",
        body: {
          resolutionHash: pdsFinalizedTwoStageRecordHash(
            lifecycleRecord as never
          ),
          sourceFingerprint: "fingerprint",
          selectedClosureHash: "selected",
          resolution: "select"
        }
      }
    };

    expect(() =>
      validatePdsLifecycleStatementBinding(
        "resolve-conflict",
        lifecycleRecord,
        statement
      )
    ).not.toThrow();
    expect(() =>
      validatePdsLifecycleStatementBinding(
        "resolve-conflict",
        {
          ...lifecycleRecord,
          draft: { ...lifecycleRecord.draft, issuedAt: "later" }
        },
        statement
      )
    ).toThrow("PdsCryptoAuthorityError");
  });

  it("adopts a replaced secure runtime between reconciliation cycles", async () => {
    const runtimeA = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group-a"]),
      poll: vi.fn().mockResolvedValue([]),
      publish: vi.fn(),
      materialize: vi.fn()
    };
    const runtimeB = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group-b"]),
      poll: vi.fn().mockResolvedValue([]),
      publish: vi.fn(),
      materialize: vi.fn()
    };
    const secret = {
      version: 1 as const,
      userId: "user",
      relayUrl: "https://relay.example",
      groupId: "group-a",
      device: {
        id: "device",
        originDeploymentId: "deployment",
        signingKeyId: "signing",
        signingPrivateSeed: "signing-seed",
        kemKeyId: "kem",
        kemPrivateSeed: "kem-seed"
      },
      authority: { keyId: "authority", publicKey: "public", head: "head-a" },
      recovery: {
        signingKeyId: "recovery-signing",
        signingPublicKey: "recovery-public"
      },
      certificate: "certificate-a",
      recipientCertificates: [],
      groupSecrets: {
        currentEpoch: "1",
        contentKey: "content",
        sourceFingerprintKey: "fingerprint",
        tombstoneFloorKey: "floor",
        projectAliasKey: "project"
      }
    };
    let available = true;
    const createRuntime = vi
      .fn()
      .mockReturnValueOnce(runtimeA)
      .mockReturnValueOnce(runtimeB);
    const runtime = createReloadablePdsWorkerRuntimeFromEnvironment({
      repository: {} as MemorySourceRepository,
      envelopeEncryptionProvider: {} as never,
      environment: { PDS_SECRET_PROVIDER: "headless" },
      resolveSecret: () => (available ? secret : null),
      createRuntime
    });

    expect(runtime).not.toBeNull();
    if (!runtime) throw new Error("Expected a configured PDS runtime");
    expect(await runtime.heartbeatGroups?.()).toEqual(["group-a"]);
    secret.authority.head = "head-b";
    await runtime.poll();
    expect(runtimeA.poll).toHaveBeenCalledOnce();
    expect(runtimeB.poll).not.toHaveBeenCalled();

    expect(await runtime.heartbeatGroups?.()).toEqual(["group-b"]);
    await runtime.poll();
    expect(runtimeB.poll).toHaveBeenCalledOnce();

    available = false;
    expect(await runtime.heartbeatGroups?.()).toEqual([]);
    await expect(runtime.poll()).rejects.toThrow(
      "PdsSecureRuntimeUnavailableError"
    );
  });

  it("does not start a reloadable runtime without an explicit provider", () => {
    expect(
      createReloadablePdsWorkerRuntimeFromEnvironment({
        repository: {} as MemorySourceRepository,
        envelopeEncryptionProvider: {} as never,
        environment: {},
        resolveSecret: vi.fn(),
        createRuntime: vi.fn()
      })
    ).toBeNull();
  });

  it("accepts the bounded application provider contract", () => {
    const secret = {
      version: 1,
      userId: "user",
      relayUrl: "https://relay.example",
      groupId: "group",
      device: {
        id: "device",
        originDeploymentId: "deployment",
        signingKeyId: "signing",
        signingPrivateSeed: "signing-seed",
        kemKeyId: "kem",
        kemPrivateSeed: "kem-seed"
      },
      authority: { keyId: "authority", publicKey: "public", head: "head" },
      recovery: {
        signingKeyId: "recovery-signing",
        signingPublicKey: "recovery-public"
      },
      certificate: "certificate",
      recipientCertificates: [],
      groupSecrets: {
        currentEpoch: "1",
        contentKey: "content",
        sourceFingerprintKey: "fingerprint",
        tombstoneFloorKey: "floor",
        projectAliasKey: "project"
      }
    };
    const resolved = resolvePdsProviderRuntimeSecret({
      PDS_SECRET_PROVIDER: "headless",
      PDS_SECRET_PROVIDER_COMMAND: process.execPath,
      PDS_SECRET_PROVIDER_COMMAND_ARGS_JSON: JSON.stringify([
        "-e",
        `process.stdout.write(${JSON.stringify(JSON.stringify(secret))})`
      ]),
      PDS_RUNTIME_SECRET_REF: "pds-runtime"
    });
    expect(resolved).toEqual(secret);
  });

  it("rejects an application provider runtime without the opaque provider command", () => {
    expect(
      resolvePdsProviderRuntimeSecret({
        PDS_SECRET_PROVIDER: "headless",
        PDS_RUNTIME_SECRET_REF: "pds-runtime"
      })
    ).toBeNull();
  });

  it("preserves signed native fork lineage on the canonical session", async () => {
    const createCapturedSession = vi.fn().mockResolvedValue({ id: "session" });
    const createConversationItems = vi.fn().mockResolvedValue([{ id: "item" }]);
    const repository = {
      createCapturedSession,
      createConversationItems
    } as unknown as MemorySourceRepository;
    const payload = canonicalizePdsJson({
      actor: "assistant",
      type: "message",
      content: "forked session content",
      metadata: {},
      observedAt: "2026-07-15T00:00:01.000Z",
      sequence: "0",
      sourceNativeItemId: "item-0",
      sourceTimestamp: "2026-07-15T00:00:00.000Z"
    });
    const manifest = {
      originDeploymentId: "deployment-origin",
      originDeviceId: "device-origin",
      sourceSequence: "3",
      sourceFingerprint: "source-fingerprint",
      sourceClosureHash: "source-closure-hash",
      closedSession: {
        logicalSessionId: "logical-child",
        externalSessionId: "provider-child",
        forkedFromExternalThreadId: "provider-parent",
        sourceAdapter: "codex",
        sourceAdapterVersion: "codex-transcript-v1",
        sourceClosedAt: "2026-07-15T00:00:02.000Z"
      },
      rawClosure: {
        records: [
          {
            ordinal: "0",
            sourceNativeItemId: "item-0",
            sourceTimestamp: "2026-07-15T00:00:00.000Z",
            observedAt: "2026-07-15T00:00:01.000Z",
            payload: Buffer.from(payload, "utf8").toString("base64url"),
            payloadHash: "payload-hash"
          }
        ]
      }
    } as unknown as PdsSessionManifest;

    await materializePdsSession(
      repository,
      "user",
      "personal-device-group",
      manifest
    );

    expect(createCapturedSession).toHaveBeenCalledWith(
      { userId: "user" },
      expect.objectContaining({
        logicalSessionId: "logical-child",
        externalSessionId: "provider-child",
        forkedFromExternalThreadId: "provider-parent"
      })
    );
    expect(createConversationItems).toHaveBeenCalledWith(
      { userId: "user" },
      {
        items: expect.arrayContaining([
          expect.objectContaining({
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceEventType: "message",
            rawJson: {
              type: "message",
              role: "assistant",
              content: "forked session content"
            }
          }),
          expect.objectContaining({
            sourceEventType: "pds_session_closed",
            sourceTransport: "pds_relay"
          })
        ])
      }
    );
  });
});

describe("PDS checkpoint source materialization", () => {
  it("preserves Pi and signed title with stable source item identity across later checkpoints", () => {
    const manifest = {
      sourceFingerprint: "fingerprint",
      originDeviceId: "studio",
      originDeploymentId: "origin",
      sourceSession: {
        logicalSessionId: "logical",
        externalSessionId: "pi-native",
        sourceRuntime: "pi",
        sourceAdapter: "pi",
        sourceAdapterVersion: "pi-session-v1",
        sourceTitle: "How is it going"
      },
      rawClosure: {
        records: [
          {
            ordinal: "0",
            sourceNativeItemId: "native-item",
            sourceTimestamp: "2026-09-15T00:00:00.000Z",
            observedAt: "2026-09-15T00:00:01.000Z",
            payloadHash: "hash",
            payload: Buffer.from(
              canonicalizePdsJson({
                actor: "user",
                type: "user_message",
                content: "hello",
                metadata: {}
              })
            ).toString("base64url")
          }
        ]
      }
    };
    const first = pdsCheckpointMaterializationSource(
      "group",
      manifest as never
    );
    const later = pdsCheckpointMaterializationSource("group", {
      ...manifest,
      sourceSequence: "9"
    } as never);
    expect(first.sourceSession).toMatchObject({
      sourceRuntime: "pi",
      sourceKind: "pi",
      sourceTitle: "How is it going"
    });
    expect(first.sourceItems).toEqual(later.sourceItems);
    expect(first.sourceItems[0]).toMatchObject({
      externalItemId: "native-item",
      sourceHash: "hash",
      rawText: "hello"
    });
    expect(
      first.sourceItems.some(
        (item) => item.sourceEventType === "pds_session_closed"
      )
    ).toBe(false);
  });
});
