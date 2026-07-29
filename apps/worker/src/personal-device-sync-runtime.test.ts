import { describe, expect, it, vi } from "vitest";
import type { MemorySourceRepository } from "@koed/db";
import type { PdsSessionManifest } from "@koed/shared";
import {
  canonicalizePdsJson,
  resolveSupportedEmbeddingModelConfig
} from "@koed/shared";
import {
  createReloadablePdsWorkerRuntimeFromEnvironment,
  materializePdsSession,
  resolvePdsEmbeddingCapability,
  resolvePdsProviderRuntimeSecret
} from "./personal-device-sync-runtime.js";

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
      environment: { PDS_SECRET_PROVIDER: "desktop_bridge" },
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

  it("accepts the bounded Desktop secret bridge provider contract", () => {
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
      PDS_SECRET_PROVIDER: "desktop_bridge",
      PDS_SECRET_PROVIDER_COMMAND: process.execPath,
      PDS_SECRET_PROVIDER_COMMAND_ARGS_JSON: JSON.stringify([
        "-e",
        `process.stdout.write(${JSON.stringify(JSON.stringify(secret))})`
      ]),
      PDS_RUNTIME_SECRET_REF: "pds-runtime"
    });
    expect(resolved).toEqual(secret);
  });

  it("rejects a Desktop bridge runtime without the opaque provider command", () => {
    expect(
      resolvePdsProviderRuntimeSecret({
        PDS_SECRET_PROVIDER: "desktop_bridge",
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
