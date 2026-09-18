import { describe, expect, it, vi } from "vitest";
import {
  parseCanonicalPdsJson,
  pdsSessionPackageDigest,
  type PdsSessionCheckpointManifest,
  type PdsSessionPackage
} from "@koed/shared";
import type { PdsClosureSource } from "@koed/db";
import {
  createPdsCheckpointPublicationService,
  publishPdsCheckpointCandidate
} from "./checkpoint-publication.js";

const candidate = {
  userId: "user-one",
  groupId: "group-one",
  sessionId: "session-one"
};

const source: PdsClosureSource = {
  groupDbId: "group-db-one",
  groupId: candidate.groupId,
  sessionId: candidate.sessionId,
  logicalSessionId: "logical-session-one",
  externalSessionId: "external-session-one",
  forkedFromExternalThreadId: null,
  sourceRuntime: "pi",
  sourceAdapter: "pi",
  sourceAdapterVersion: "pi-session-v1",
  sourceCreatedAt: "2026-07-15T00:00:00.000Z",
  items: [
    {
      id: "item-one",
      externalItemId: "native-item-one",
      sourceSequence: 0,
      eventTime: "2026-07-15T00:00:01.000Z",
      observedAt: "2026-07-15T00:00:02.000Z",
      rawJson: {},
      rawText: "completed turn",
      sourceKind: "pi",
      sourceRecordType: "message",
      sourceEventType: "agent_message",
      metadata: { canonicalConversationItemActor: "assistant" }
    }
  ]
};

const securePackage = (): PdsSessionPackage => {
  const header = {
    packageId: "package-one",
    sourceManifestHash: "manifest-one"
  } as PdsSessionPackage["header"];
  const withoutDigest = { header, envelopes: [], chunks: [] };
  return {
    ...withoutDigest,
    packageDigest: pdsSessionPackageDigest(withoutDigest)
  } as PdsSessionPackage;
};

const checkpointManifest = {
  version: "2",
  profile: "cumulative_checkpoint",
  packageId: "package-one",
  sourceClosureHash: "closure-one"
} as unknown as PdsSessionCheckpointManifest;

describe("PDS completed-turn checkpoint publication", () => {
  it("builds, encrypts, and durably publishes the checkpoint inside the repository boundary", async () => {
    const builtPackage = securePackage();
    const buildCompletedTurnCheckpointPackage = vi.fn(async () => ({
      manifest: checkpointManifest,
      package: builtPackage,
      sourceClosureHash: "closure-one",
      sourceManifestHash: "manifest-one",
      sourceFingerprint: "fingerprint-one",
      logicalMemoryId: "logical-memory-one",
      deletionFloorToken: "floor-one"
    }));
    const encrypt = vi.fn(async (input: { plaintext: string }) => {
      expect(input.plaintext).toBeTruthy();
      return { ciphertext: "encrypted" };
    });
    const checkpointPdsSourceSession = vi.fn(async (value: unknown) => {
      const build = value as {
        build(value: {
          source: PdsClosureSource;
          sourceSequence: string;
          closedAt: Date;
          checkpoint: {
            version: "1";
            ordinal: string;
            previousClosureHash: string | null;
          };
        }): Promise<Record<string, unknown>>;
      };
      const result = await build.build({
        source,
        sourceSequence: "8",
        closedAt: new Date("2026-07-15T00:00:03.000Z"),
        checkpoint: {
          version: "1",
          ordinal: "0",
          previousClosureHash: null
        }
      });
      expect(result).toMatchObject({
        packageId: "package-one",
        sourceClosureHash: "closure-one",
        sourceManifestHash: "manifest-one",
        encryptedEnvelope: { ciphertext: "encrypted" }
      });
      return {
        id: "closure-record-one",
        groupId: candidate.groupId,
        sessionId: candidate.sessionId,
        sourceSequence: "8",
        packageId: "package-one",
        sourceManifestHash: "manifest-one",
        state: "ready",
        closedAt: "2026-07-15T00:00:03.000Z"
      };
    });
    const repository = {
      listPdsCheckpointCandidates: vi.fn(async () => [candidate]),
      checkpointPdsSourceSession
    };
    const secureKeyProvider = {
      getSourceContext: vi.fn(async () => ({
        originDeploymentId: "deployment-one",
        originDeviceId: "device-one",
        buildCompletedTurnCheckpointPackage
      }))
    };

    const published = await publishPdsCheckpointCandidate({
      repository: repository as never,
      secureKeyProvider: secureKeyProvider as never,
      envelopeEncryptionProvider: { encrypt } as never,
      candidate
    });

    expect(published?.packageId).toBe("package-one");
    expect(secureKeyProvider.getSourceContext).toHaveBeenCalledWith({
      userId: candidate.userId,
      groupId: candidate.groupId
    });
    expect(buildCompletedTurnCheckpointPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        source,
        sourceSequence: "8",
        checkpoint: {
          version: "1",
          ordinal: "0",
          previousClosureHash: null
        },
        items: [
          expect.objectContaining({
            sourceNativeItemId: "native-item-one",
            content: "completed turn"
          })
        ]
      })
    );
    expect(encrypt).toHaveBeenCalledWith(
      expect.objectContaining({
        plaintext: expect.any(String),
        scope: {
          tenantId: candidate.userId,
          objectClass: "pds_source_package"
        },
        aad: {
          ownerUserId: candidate.userId,
          groupId: candidate.groupId,
          packageId: "package-one"
        }
      })
    );
    const encryptedSource = parseCanonicalPdsJson(
      encrypt.mock.calls[0]![0].plaintext
    );
    expect(encryptedSource).toMatchObject({
      kind: "pds_checkpoint_source_v1",
      manifest: checkpointManifest,
      package: builtPackage
    });
  });

  it("drains bounded durable candidates on startup and closes cleanly", async () => {
    let listed = false;
    const builtPackage = securePackage();
    let resolvePublished!: () => void;
    const published = new Promise<void>((resolve) => {
      resolvePublished = resolve;
    });
    const repository = {
      listPdsCheckpointCandidates: vi.fn(async () => {
        if (listed) return [];
        listed = true;
        return [candidate];
      }),
      checkpointPdsSourceSession: vi.fn(async (value: unknown) => {
        const build = value as {
          build(input: {
            source: PdsClosureSource;
            sourceSequence: string;
            closedAt: Date;
            checkpoint: {
              version: "1";
              ordinal: string;
              previousClosureHash: string | null;
            };
          }): Promise<Record<string, unknown>>;
        };
        await build.build({
          source,
          sourceSequence: "1",
          closedAt: new Date("2026-07-15T00:00:03.000Z"),
          checkpoint: {
            version: "1",
            ordinal: "0",
            previousClosureHash: null
          }
        });
        resolvePublished();
        return {
          id: "closure-one",
          groupId: candidate.groupId,
          sessionId: candidate.sessionId,
          sourceSequence: "1",
          packageId: "package-one",
          sourceManifestHash: "manifest-one",
          state: "ready",
          closedAt: "2026-07-15T00:00:03.000Z"
        };
      })
    };
    const service = createPdsCheckpointPublicationService({
      repository: repository as never,
      secureKeyProvider: {
        getSourceContext: vi.fn(async () => ({
          originDeploymentId: "deployment-one",
          originDeviceId: "device-one",
          buildCompletedTurnCheckpointPackage: async () => ({
            manifest: checkpointManifest,
            package: builtPackage,
            sourceClosureHash: "closure-hash",
            sourceManifestHash: "manifest-one",
            sourceFingerprint: "fingerprint",
            logicalMemoryId: "logical-memory",
            deletionFloorToken: "floor"
          })
        }))
      } as never,
      envelopeEncryptionProvider: { encrypt: vi.fn() } as never,
      pollIntervalMs: 60_000
    });

    service.start();
    await published;
    await service.stop();

    expect(repository.listPdsCheckpointCandidates).toHaveBeenCalled();
    expect(repository.checkpointPdsSourceSession).toHaveBeenCalledTimes(1);
  });

  it("keyset-paginates and retries a failed candidate after the next rotation", async () => {
    const candidates = Array.from({ length: 51 }, (_, index) => {
      const suffix = String(index).padStart(3, "0");
      return {
        userId: "user-one",
        groupId: `group-${suffix}`,
        sessionId: `session-${suffix}`
      };
    });
    const remaining = new Map(
      candidates.map((value) => [value.sessionId, value])
    );
    const listCalls: Array<{ afterSessionId?: string } | undefined> = [];
    const checkpointCalls: string[] = [];
    let firstCandidateAttempts = 0;
    const repository = {
      listPdsCheckpointCandidates: vi.fn(
        async (input?: { afterSessionId?: string }) => {
          listCalls.push(input);
          return [...remaining.values()]
            .filter(
              (value) =>
                !input?.afterSessionId || value.sessionId > input.afterSessionId
            )
            .sort((left, right) =>
              left.sessionId.localeCompare(right.sessionId)
            )
            .slice(0, 50);
        }
      ),
      checkpointPdsSourceSession: vi.fn(
        async (input: { sessionId: string }) => {
          checkpointCalls.push(input.sessionId);
          remaining.delete(input.sessionId);
          return {
            id: `closure-${input.sessionId}`,
            groupId: "group-one",
            sessionId: input.sessionId,
            sourceSequence: "1",
            packageId: `package-${input.sessionId}`,
            sourceManifestHash: "manifest-one",
            state: "ready",
            closedAt: "2026-07-15T00:00:03.000Z"
          };
        }
      )
    };
    const service = createPdsCheckpointPublicationService({
      repository: repository as never,
      secureKeyProvider: {
        getSourceContext: vi.fn(async (value: { groupId: string }) => {
          if (value.groupId === "group-000" && firstCandidateAttempts++ === 0) {
            throw new Error("transient secure runtime failure");
          }
          return {
            originDeploymentId: "deployment-one",
            originDeviceId: "device-one",
            buildCompletedTurnCheckpointPackage: vi.fn()
          };
        })
      } as never,
      envelopeEncryptionProvider: { encrypt: vi.fn() } as never,
      pollIntervalMs: 60_000
    });

    await service.scanNow();
    expect(listCalls).toEqual([undefined, { afterSessionId: "session-049" }]);
    expect(checkpointCalls).toHaveLength(50);
    expect(firstCandidateAttempts).toBe(1);

    await service.scanNow();
    await service.stop();

    expect(listCalls.slice(2)).toEqual([undefined]);
    expect(checkpointCalls).toHaveLength(51);
    expect(checkpointCalls.at(-1)).toBe("session-000");
    expect(firstCandidateAttempts).toBe(2);
  });

  it("continues through a full bounded drain when every candidate fails", async () => {
    const candidates = Array.from({ length: 250 }, (_, index) => {
      const suffix = String(index).padStart(3, "0");
      return {
        userId: "user-one",
        groupId: `group-${suffix}`,
        sessionId: `session-${suffix}`
      };
    });
    const listCalls: Array<{ afterSessionId?: string } | undefined> = [];
    const onError = vi.fn();
    const repository = {
      listPdsCheckpointCandidates: vi.fn(
        async (input?: { afterSessionId?: string }) => {
          listCalls.push(input);
          return candidates
            .filter(
              (value) =>
                !input?.afterSessionId || value.sessionId > input.afterSessionId
            )
            .slice(0, 50);
        }
      ),
      checkpointPdsSourceSession: vi.fn()
    };
    const service = createPdsCheckpointPublicationService({
      repository: repository as never,
      secureKeyProvider: {
        getSourceContext: vi.fn(async () => {
          throw new Error("transient secure runtime failure");
        })
      } as never,
      envelopeEncryptionProvider: { encrypt: vi.fn() } as never,
      onError,
      pollIntervalMs: 60_000
    });

    await service.scanNow();
    await service.stop();

    expect(listCalls).toEqual([
      undefined,
      { afterSessionId: "session-049" },
      { afterSessionId: "session-099" },
      { afterSessionId: "session-149" }
    ]);
    expect(onError).toHaveBeenCalledTimes(200);
  });
});
