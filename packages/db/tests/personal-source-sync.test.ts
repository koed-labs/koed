import { createMemoryEngine } from "@koed/core";
import {
  resolveNativeSharingSource,
  resolvePublisherTakeoverSource,
  readPublisherTakeoverSourceBindings,
  resolveNativeConversationSharingSource,
  resolveReplicaSharingSource
} from "../src/selection-sharing-source-availability.js";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from "vitest";
import {
  canonicalizePdsJson,
  createLocalTestKeyEnvelopeEncryptionProvider,
  createPdsSessionCheckpointManifest,
  createPdsSessionCheckpointPackage,
  createPdsRepositoryAssignmentFromSourceContext,
  createPdsRepositoryAssignment,
  createRepositoryAssignment,
  verifyAndDecryptPdsSessionSourcePackage,
  verifyPdsRepositoryAssignmentWithKeyHistory,
  isPdsSessionCheckpointManifest,
  PdsRelayClient,
  type PersonalSelectionSnapshot,
  type PersonalGitContext,
  type PersonalFolderObservation,
  type PdsSessionPackage,
  type PdsSessionCheckpointManifest,
  type SelectionSharingGoal
} from "@koed/shared";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations,
  type MemorySourceRepository
} from "../src/index.js";
import { decodePersonalConfigurationPacket } from "./fixtures/personal-configuration-delivery.js";
import { personalSourceDeviceFixture } from "./fixtures/personal-source-device.js";
import { pdsConversationItemsForClosure } from "../../../apps/api/src/personal-device-sync/local-source.js";
import { pdsCheckpointMaterializationSource } from "../../../apps/worker/src/personal-device-sync-runtime.js";
import { createPdsConfigurationRuntime } from "../../../apps/worker/src/personal-device-sync-configuration.js";

const originUrl = process.env.P1_SOURCE_ORIGIN_DATABASE_URL,
  receiverUrl = process.env.P1_SOURCE_RECEIVER_DATABASE_URL;
describe.skipIf(!originUrl || !receiverUrl)(
  "Personal source context across two devices",
  () => {
    let originPool: pg.Pool, receiverPool: pg.Pool;
    beforeAll(async () => {
      originPool = createDbPool({ connectionString: originUrl });
      receiverPool = createDbPool({ connectionString: receiverUrl });
      await runDbMigrations(originPool);
      await runDbMigrations(receiverPool);
    }, 60_000);
    afterAll(async () => {
      await Promise.all([originPool?.end(), receiverPool?.end()]);
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
    it("retains encrypted pending corrections, receives Git and Folder provenance, preserves local edits on later capture, and resolves concurrent heads after restart", async () => {
      const fixture = personalSourceDeviceFixture();
      const origin = await fixture.initialize(originPool, fixture.origin),
        receiver = await fixture.initialize(receiverPool, fixture.receiver);
      const encryption = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 113).toString("base64")
      );
      const options = { envelopeEncryptionProvider: encryption };
      let originRepo = createMemorySourceRepository(originPool, options),
        receiverRepo = createMemorySourceRepository(receiverPool, options);
      const gitA: PersonalGitContext = {
        kind: "portable_repository",
        key: "gr_sync_a",
        root: "/same/path/repository",
        branch: "main",
        reason: "origin",
        checkoutId: "origin_checkout",
        originatingDeviceId: fixture.origin.deviceId,
        selectedRemote: "origin",
        anchorDisplay: "example.test/sync-a"
      };
      const gitB: PersonalGitContext = {
        ...gitA,
        key: "gr_sync_b",
        anchorDisplay: "example.test/sync-b"
      };
      const gitC: PersonalGitContext = {
        ...gitA,
        key: "gr_sync_c",
        anchorDisplay: "example.test/sync-c"
      };
      const folder = (
        member: typeof fixture.origin
      ): PersonalFolderObservation => ({
        identity: {
          folderId: randomUUID(),
          originatingDeploymentId: member.deploymentId,
          originatingDeviceId: member.deviceId,
          originatingProfileId: "fixture_profile",
          directoryIncarnationId: randomUUID()
        },
        normalizedPath: "/same/path/folder",
        capturedPath: "/same/path/folder/.",
        observedAt: new Date().toISOString()
      });
      const originalFolder = folder(fixture.origin),
        localFolder = folder(fixture.receiver);
      const source = await originRepo.createCapturedSession(origin, {
        externalSessionId: randomUUID(),
        sourceRuntime: "codex",
        captureMethod: "transcript",
        sourceKind: "codex",
        sourceAdapterVersion: "codex-transcript-v1",
        repositoryIdentity: gitA,
        folderObservation: originalFolder
      });
      // These are independently observed choices, not an identity join by equal path.
      await originRepo.createCapturedSession(origin, {
        externalSessionId: randomUUID(),
        repositoryIdentity: gitB
      });
      await originRepo.createCapturedSession(origin, {
        externalSessionId: randomUUID(),
        repositoryIdentity: gitC
      });
      const localSameProvider = await receiverRepo.createCapturedSession(
        receiver,
        {
          externalSessionId: source.externalSessionId!,
          repositoryIdentity: gitB,
          folderObservation: localFolder
        }
      );
      await receiverRepo.createCapturedSession(receiver, {
        externalSessionId: randomUUID(),
        repositoryIdentity: gitC
      });
      let ordinal = 0;
      const append = async () => {
        const index = ordinal++;
        await originRepo.createConversationItems(origin, {
          items: ["agent_message", "task_complete"].map((type, offset) => ({
            sessionId: source.id,
            externalSessionId: source.externalSessionId!,
            externalThreadId: source.externalSessionId!,
            externalItemId: `item-${index}-${offset}`,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "transcript",
            sourceRecordType: "event_msg",
            sourceEventType: type,
            sourceSequence: index * 2 + offset,
            sourceHash: randomUUID(),
            idempotencyKey: randomUUID(),
            eventTime: new Date().toISOString(),
            observedAt: new Date().toISOString(),
            rawJson: {
              type: "event_msg",
              payload: {
                type,
                message: `SYNC_DECISION_${index}`,
                last_agent_message: `SYNC_DECISION_${index}`
              }
            },
            rawText: `SYNC_DECISION_${index}`,
            metadata: {
              sourceRole: "agent",
              canonicalConversationItemActor: "agent",
              transcriptType: type
            }
          }))
        });
      };
      await append();
      const publish = async (withContext = true) => {
        let built:
          | { manifest: PdsSessionCheckpointManifest; pkg: PdsSessionPackage }
          | undefined;
        await originRepo.checkpointPdsSourceSession({
          userId: origin.userId,
          groupId: fixture.groupId,
          sessionId: source.id,
          originDeploymentId: fixture.origin.deploymentId,
          originDeviceId: fixture.origin.deviceId,
          includeSourceContext: withContext,
          expectedEpoch: fixture.epoch,
          expectedAuthorityHead: fixture.authorityHead,
          async build(input) {
            if (withContext) expect(input.source.sourceContext).toBeDefined();
            expect(input.checkpoint).toBeDefined();
            const manifest = createPdsSessionCheckpointManifest({
              runtime: fixture.runtime(fixture.origin),
              originDeploymentId: fixture.origin.deploymentId,
              sourceSequence: input.sourceSequence,
              sourceNativeSessionId: input.source.externalSessionId,
              contentEpoch: fixture.epoch,
              ...(withContext
                ? { sourceContext: input.source.sourceContext! }
                : {}),
              repositoryAssignment: withContext
                ? createPdsRepositoryAssignmentFromSourceContext(
                    input.source.sourceContext!.context,
                    fixture.epoch,
                    fixture.projectAliasKey,
                    {
                      capturedCwd: input.source.capturedCwd,
                      branchObservation: input.source.branchObservation
                    }
                  )
                : createPdsRepositoryAssignment(
                    createRepositoryAssignment({
                      state: "recorded",
                      version: 999,
                      automatic: gitA,
                      override: {
                        kind: "local_project",
                        key: "legacy_named_group",
                        reason: "manual",
                        root: null,
                        branch: null,
                        checkoutId: null,
                        originatingDeviceId: fixture.origin.deviceId,
                        selectedRemote: null,
                        anchorDisplay: null
                      }
                    }),
                    fixture.epoch,
                    fixture.projectAliasKey
                  ),
              sourceSession: {
                logicalSessionId: input.source.logicalSessionId,
                externalSessionId: input.source.externalSessionId,
                sourceAdapter: "codex",
                sourceAdapterVersion: "codex-transcript-v1",
                sourceRuntime: "codex",
                captureMethod: "transcript",
                sourceCreatedAt: input.source.sourceCreatedAt
              },
              checkpoint: input.checkpoint!,
              terminalCursor: String(input.source.items.length),
              items: pdsConversationItemsForClosure(input.source),
              sourceFingerprintKey: fixture.sourceFingerprintKey,
              tombstoneFloorKey: fixture.tombstoneFloorKey,
              originSigningPrivateKey: fixture.origin.signing.privateKey
            });
            const pkg = createPdsSessionCheckpointPackage({
              runtime: fixture.runtime(fixture.origin),
              manifest,
              servingSigningPrivateKey: fixture.origin.signing.privateKey,
              expiresAt: new Date(Date.now() + 3_600_000).toISOString()
            });
            built = { manifest, pkg };
            return {
              packageId: manifest.packageId,
              sourceManifestHash: pkg.header.sourceManifestHash,
              sourceClosureHash: manifest.sourceClosureHash,
              sourceFingerprint: manifest.sourceFingerprint,
              logicalMemoryId: manifest.logicalMemoryId,
              deletionFloorToken: manifest.deletionFloorToken,
              encryptedEnvelope: await encryption.encrypt({
                plaintext: canonicalizePdsJson({
                  kind: "pds_checkpoint_source_v1",
                  manifest,
                  package: pkg
                }),
                scope: { tenantId: origin.userId },
                provenance: { rowFamily: "pds_retained_packages" },
                ciphertextLocation: "fixture"
              })
            };
          }
        });
        expect(built).toBeDefined();
        return built!;
      };
      const receive = async (pkg: PdsSessionPackage) => {
        const manifest = verifyAndDecryptPdsSessionSourcePackage(
          canonicalizePdsJson(pkg),
          {
            runtime: fixture.runtime(fixture.origin, fixture.receiver),
            recipientKemPrivateKey: fixture.receiver.kem.privateSeed
          }
        );
        if (!isPdsSessionCheckpointManifest(manifest))
          throw new Error("Expected checkpoint");
        const workerId = randomUUID();
        await receiverRepo.receivePdsInbox({
          userId: receiver.userId,
          groupId: fixture.groupId,
          packageId: manifest.packageId,
          sourceManifestHash: pkg.header.sourceManifestHash
        });
        const inbox = (await receiverRepo.claimPdsInbox({ workerId })).find(
          (entry) => entry.packageId === manifest.packageId
        );
        if (!inbox) throw new Error("Missing fixture inbox lease");
        const retained = await receiverRepo.retainPdsInboundPackage({
          userId: receiver.userId,
          groupId: fixture.groupId,
          inboxId: inbox.id,
          packageId: manifest.packageId,
          sourceManifestHash: pkg.header.sourceManifestHash,
          sourceLogicalSessionId: manifest.sourceSession.logicalSessionId,
          ...(manifest.sourceContext
            ? {
                sourceContextHash: createHash("sha256")
                  .update(canonicalizePdsJson(manifest.sourceContext))
                  .digest("base64url")
              }
            : {}),
          originDeploymentId: manifest.originDeploymentId,
          originDeviceId: manifest.originDeviceId,
          sourceSequence: manifest.sourceSequence,
          logicalMemoryId: manifest.logicalMemoryId,
          deletionFloorToken: manifest.deletionFloorToken,
          sourceFingerprint: manifest.sourceFingerprint,
          sourceClosureHash: manifest.sourceClosureHash,
          sourceProfile: "cumulative_checkpoint",
          checkpoint: manifest.checkpoint,
          encryptedEnvelope: await encryption.encrypt({
            plaintext: canonicalizePdsJson(pkg),
            scope: { tenantId: receiver.userId },
            provenance: { rowFamily: "pds_retained_packages" },
            ciphertextLocation: "fixture"
          })
        });
        const assignment = verifyPdsRepositoryAssignmentWithKeyHistory(
          manifest.repositoryAssignment,
          manifest.contentEpoch,
          { currentEpoch: fixture.epoch, projectKey: fixture.projectAliasKey }
        );
        const result = await receiverRepo.materializePdsSessionCheckpoint({
          userId: receiver.userId,
          groupId: fixture.groupId,
          workerId,
          inboxId: inbox.id,
          retainedPackageId: retained.retainedPackageId,
          packageId: manifest.packageId,
          sourceManifestHash: pkg.header.sourceManifestHash,
          sourceFingerprint: manifest.sourceFingerprint,
          closureHash: manifest.sourceClosureHash,
          logicalMemoryId: manifest.logicalMemoryId,
          deletionFloorToken: manifest.deletionFloorToken,
          originDeploymentId: manifest.originDeploymentId,
          originDeviceId: manifest.originDeviceId,
          sourceSequence: manifest.sourceSequence,
          sourceCheckpointAt: new Date(manifest.originSignedAt),
          observedAt: new Date(),
          checkpoint: manifest.checkpoint,
          profileTransition: manifest.profileTransition,
          ...pdsCheckpointMaterializationSource(
            fixture.groupId,
            manifest,
            assignment
          )
        });
        expect(result.deferred).toBe(false);
        expect(result.conflict).toBe(false);
        await receiverRepo.completePdsInbox({
          workerId,
          inboxId: inbox.id,
          retainedPackageId: retained.retainedPackageId,
          state: "ready"
        });
        return result.localSessionId;
      };
      const uploads: PdsSessionPackage[] = [];
      let supports = true;
      const relay = new PdsRelayClient({
        baseUrl: "http://127.0.0.1:59999",
        identity: {
          certificate: fixture.origin.certificate,
          deviceId: fixture.origin.deviceId,
          signingKeyId: fixture.origin.signingKeyId,
          signingPublicKey: fixture.origin.signing.publicKey,
          signingPrivateSeed: fixture.origin.signing.privateSeed
        }
      });
      vi.spyOn(relay, "advertiseConfigurationCapabilities").mockResolvedValue(
        undefined
      );
      vi.spyOn(relay, "configurationCapabilities").mockImplementation(
        async () =>
          supports
            ? [
                fixture.capability(fixture.origin),
                fixture.capability(fixture.receiver)
              ]
            : []
      );
      vi.spyOn(relay, "upload").mockImplementation(async (pkg) => {
        uploads.push(pkg);
        return { transportId: pkg.header.transportId, deliveryState: "acked" };
      });
      const config = (
        repo: MemorySourceRepository,
        actor: typeof origin,
        member: typeof fixture.origin
      ) =>
        createPdsConfigurationRuntime({
          repository: repo.personalConfiguration!,
          runtime: fixture.runtime(member),
          signingKey: member.signing.privateKey,
          relay: () => relay,
          encryption,
          userId: actor.userId,
          groupId: fixture.groupId,
          originDeploymentId: member.deploymentId,
          activeCertificates: fixture.certificates
        });
      let originConfig = config(originRepo, origin, fixture.origin),
        receiverConfig = config(receiverRepo, receiver, fixture.receiver);
      const deliverConfig = async (
        pkg: PdsSessionPackage,
        author: typeof fixture.origin,
        recipient: typeof fixture.origin,
        runtime: typeof receiverConfig
      ) => {
        const { record } = decodePersonalConfigurationPacket(
          fixture,
          pkg,
          author,
          recipient
        );
        return runtime.retainVerified(record);
      };
      const first = await publish();
      supports = false;
      await expect(
        originConfig.requireSourceContextRecipients()
      ).rejects.toMatchObject({ code: "peer_capability_required" });
      await originConfig.reconcile();
      expect(uploads).toHaveLength(0);
      supports = true;
      await originConfig.reconcile();
      expect(uploads).toHaveLength(1);
      const early = await deliverConfig(
        uploads.pop()!,
        fixture.origin,
        fixture.receiver,
        receiverConfig
      );
      expect(early.applied).toBe(false);
      expect(
        (
          await receiverPool.query<{ count: number }>(
            "select count(*)::int as count from personal_source_context_revisions r join personal_source_bindings b on b.binding_id=r.binding_id where b.owner_user_id=$1",
            [receiver.userId]
          )
        ).rows[0]!.count
      ).toBe(0);
      const remoteId = await receive(first.pkg);
      expect(remoteId).not.toBe(source.id);
      expect(remoteId).not.toBe(localSameProvider.id);
      expect(
        (
          await receiverRepo.getPersonalSourceContext(
            receiver,
            localSameProvider.id
          )
        ).context.git.original
      ).toEqual({ state: "known", value: gitB });
      const initial = (
        await receiverRepo.getPersonalSourceContext(receiver, remoteId)
      ).context;
      expect(initial.sync?.source.logicalSessionId).toBe(
        source.logicalSessionId
      );
      expect(initial.git.original).toEqual({ state: "known", value: gitA });
      expect(initial.folder.original).toMatchObject({
        state: "known",
        value: {
          reference: {
            ...originalFolder.identity,
            ownerUserId: receiver.userId
          },
          normalizedPath: originalFolder.normalizedPath
        }
      });
      expect(
        (
          await receiverPool.query<{ count: number }>(
            "select count(*)::int as count from personal_source_bindings where local_session_id=$1",
            [remoteId]
          )
        ).rows[0]!.count
      ).toBe(1);
      expect(
        (
          await receiverPool.query<{ count: number }>(
            "select count(*)::int as count from pds_project_association_acceptances where owner_user_id=$1",
            [receiver.userId]
          )
        ).rows[0]!.count
      ).toBe(0);
      const projected = await receiverRepo.projectPendingConversationItems(
        receiver,
        { limit: 100 }
      );
      expect(projected.memoryEventsCreated).toBeGreaterThan(0);
      if (initial.folder.original.state !== "known")
        throw new Error("Expected verified original Folder");
      for (const target of [
        { kind: "repository" as const, repository: gitA },
        {
          kind: "folder" as const,
          folder: initial.folder.original.value.reference
        }
      ]) {
        const page = await receiverRepo.startPersonalSelectionEnumeration(
          receiver,
          { target }
        );
        const entry = page.entries.find(
          (value) => value.source.localSessionId === remoteId
        );
        expect(entry?.source.identityState).toBe("verified");
        const goal: SelectionSharingGoal = {
          source: entry!.source,
          desired: "present",
          snapshotVersion: page.snapshotVersion,
          contextHash: "a".repeat(64)
        };
        const client = await receiverPool.connect();
        try {
          await client.query("begin");
          const resolved = await resolveReplicaSharingSource(client, {
            ownerUserId: receiver.userId,
            goal,
            target
          });
          const takeover = await resolvePublisherTakeoverSource(client, {
            ownerUserId: receiver.userId,
            sessionId: remoteId,
            target
          });
          expect(takeover).toMatchObject({
            sourceIdentity: resolved,
            source: {
              localSessionId: remoteId,
              localLogicalSessionId: entry!.source.localLogicalSessionId,
              identityState: "verified"
            },
            target
          });
          const bindings = await readPublisherTakeoverSourceBindings(client, {
            ownerUserId: receiver.userId
          });
          expect(
            bindings.entries.find(
              (value) => value.source.localSessionId === remoteId
            )?.source
          ).toEqual(takeover!.source);
          expect(
            (
              await readPublisherTakeoverSourceBindings(client, {
                ownerUserId: origin.userId
              })
            ).entries
          ).toEqual([]);
          expect(
            await resolvePublisherTakeoverSource(client, {
              ownerUserId: origin.userId,
              sessionId: remoteId,
              target
            })
          ).toBeNull();
          expect(
            await resolveNativeConversationSharingSource(client, {
              ownerUserId: receiver.userId,
              sessionId: remoteId,
              deploymentProtocolId: randomUUID()
            })
          ).toBeNull();
          expect(
            await resolveNativeSharingSource(client, {
              ownerUserId: receiver.userId,
              goal,
              target,
              deploymentProtocolId: randomUUID()
            })
          ).toBeNull();
          expect(resolved).toEqual({
            originatingDeploymentId: fixture.origin.deploymentId,
            originatingDeviceId: fixture.origin.deviceId,
            logicalSessionId: source.logicalSessionId
          });
          expect(
            await resolveReplicaSharingSource(client, {
              ownerUserId: receiver.userId,
              target,
              goal: {
                ...goal,
                source: { ...goal.source, localSessionId: localSameProvider.id }
              }
            })
          ).toBeNull();
          expect(
            await resolveReplicaSharingSource(client, {
              ownerUserId: receiver.userId,
              target,
              goal: {
                ...goal,
                source: {
                  ...goal.source,
                  contextVersion: {
                    ...goal.source.contextVersion,
                    git: goal.source.contextVersion.git + 1
                  }
                }
              }
            })
          ).toBeNull();
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
      }
      const vector = Array.from({ length: 1024 }, (_, index) =>
        index === 0 ? 1 : 0
      );
      vi.stubEnv("EMBEDDING_SERVICE_URL", "http://source-sync.fixture");
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              model: "qwen3-0.6b",
              dimensions: 1024,
              vectors: [vector]
            }),
            { status: 200 }
          )
      );
      for (const eventId of projected.memoryEventIds)
        await receiverRepo.upsertSourceEmbedding({
          source: (await receiverRepo.getEmbeddableSource(
            "memory_event",
            eventId
          ))!,
          model: "qwen3-0.6b",
          dimensions: 1024,
          version: "qwen3-0.6b",
          vector,
          modelArtifactHash: "a".repeat(64),
          tokenizer: "qwen3-embedding-0.6b-gguf",
          inputTransform: "qwen3-retrieval-document-v1",
          pooling: "last",
          normalization: "l2"
        });
      type Selection = Extract<PersonalSelectionSnapshot, { version: 1 }>;
      const recall = async (target: Selection["target"]) => {
        const result = await createMemoryEngine(receiverRepo).searchMemory({
          requesterContext: receiver,
          scope: "personal",
          query: "SYNC_DECISION_0",
          retrievalStage: "raw_fallback_search",
          limit: 20,
          personalSelection: {
            version: 1,
            ownerUserId: receiver.userId,
            target,
            callerRepositoryContext: null
          }
        });
        return result.results.map((item) => item.sourceId);
      };
      expect(await recall({ kind: "repository", repository: gitA })).toEqual(
        projected.memoryEventIds
      );
      expect(
        await recall({
          kind: "folder",
          folder: { ...originalFolder.identity, ownerUserId: receiver.userId }
        })
      ).toEqual(projected.memoryEventIds);
      expect(
        await recall({
          kind: "folder",
          folder: { ...localFolder.identity, ownerUserId: receiver.userId }
        })
      ).toEqual([]);
      await receiverConfig.reconcile();
      expect(
        (
          await receiverPool.query<{ application_state: string }>(
            "select application_state from personal_configuration_records where id=$1",
            [early.id]
          )
        ).rows[0]!.application_state
      ).toBe("applied");
      const correct = async (
        repo: MemorySourceRepository,
        actor: typeof origin,
        sessionId: string,
        repository: PersonalGitContext
      ) => {
        const before = (await repo.getPersonalSourceContext(actor, sessionId))
          .context;
        const review = await repo.previewPersonalSourceCorrection(
          actor,
          sessionId,
          {
            axis: "git",
            action: "set",
            repository,
            expectedVersion: before.git.revision
          }
        );
        return repo.applyPersonalSourceCorrection(
          actor,
          sessionId,
          review.preview.reviewId,
          { expectedVersion: before.git.revision }
        );
      };
      await correct(receiverRepo, receiver, remoteId, gitB);
      expect(await recall({ kind: "repository", repository: gitA })).toEqual(
        []
      );
      expect(await recall({ kind: "repository", repository: gitB })).toEqual(
        projected.memoryEventIds
      );
      await append();
      const second = await publish();
      expect(await receive(second.pkg)).toBe(remoteId);
      expect(
        (await receiverRepo.getPersonalSourceContext(receiver, remoteId))
          .context.git.correction
      ).toMatchObject({
        state: "corrected",
        value: { state: "known", value: gitB }
      });
      await correct(originRepo, origin, source.id, gitC);
      await originConfig.reconcile();
      const originUpdate = uploads.pop()!;
      expect(originUpdate).toBeDefined();
      await deliverConfig(
        originUpdate,
        fixture.origin,
        fixture.receiver,
        receiverConfig
      );
      const conflict = (
        await receiverRepo.getPersonalSourceContext(receiver, remoteId)
      ).context;
      expect(conflict.sync?.git.state).toBe("conflict");
      expect(conflict.sync?.git.frontier).toHaveLength(2);
      expect(await recall({ kind: "repository", repository: gitB })).toEqual(
        []
      );
      expect(await recall({ kind: "repository", repository: gitC })).toEqual(
        []
      );
      expect(
        await recall({
          kind: "folder",
          folder: { ...originalFolder.identity, ownerUserId: receiver.userId }
        })
      ).toEqual(projected.memoryEventIds);
      const staleReview = await receiverRepo.previewPersonalSourceCorrection(
        receiver,
        remoteId,
        {
          axis: "git",
          action: "set",
          repository: gitB,
          expectedVersion: conflict.git.revision
        }
      );
      await correct(originRepo, origin, source.id, gitA);
      await originConfig.reconcile();
      const laterHead = uploads.pop()!;
      expect(laterHead).toBeDefined();
      await deliverConfig(
        laterHead,
        fixture.origin,
        fixture.receiver,
        receiverConfig
      );
      await expect(
        receiverRepo.applyPersonalSourceCorrection(
          receiver,
          remoteId,
          staleReview.preview.reviewId,
          { expectedVersion: conflict.git.revision }
        )
      ).rejects.toMatchObject({ statusCode: 409 });
      await correct(receiverRepo, receiver, remoteId, gitB);
      await receiverConfig.reconcile();
      const resolution = uploads.pop()!;
      expect(resolution).toBeDefined();
      await deliverConfig(
        resolution,
        fixture.receiver,
        fixture.origin,
        originConfig
      );
      expect(
        (await originRepo.getPersonalSourceContext(origin, source.id)).context
          .git.correction
      ).toMatchObject({
        state: "corrected",
        value: { state: "known", value: gitB }
      });
      const folderBefore = (
        await receiverRepo.getPersonalSourceContext(receiver, remoteId)
      ).context;
      const folderReview = await receiverRepo.previewPersonalSourceCorrection(
        receiver,
        remoteId,
        {
          axis: "folder",
          action: "set",
          folder: { ...localFolder.identity, ownerUserId: receiver.userId },
          expectedVersion: folderBefore.folder.revision
        }
      );
      await receiverRepo.applyPersonalSourceCorrection(
        receiver,
        remoteId,
        folderReview.preview.reviewId,
        { expectedVersion: folderBefore.folder.revision }
      );
      await receiverConfig.reconcile();
      const folderUpdate = uploads.pop()!;
      expect(folderUpdate).toBeDefined();
      await deliverConfig(
        folderUpdate,
        fixture.receiver,
        fixture.origin,
        originConfig
      );
      expect(
        (await originRepo.getPersonalSourceContext(origin, source.id)).context
          .folder.correction
      ).toMatchObject({
        state: "corrected",
        value: {
          state: "known",
          value: {
            reference: { ...localFolder.identity, ownerUserId: origin.userId }
          }
        }
      });
      expect(
        await recall({
          kind: "folder",
          folder: { ...originalFolder.identity, ownerUserId: receiver.userId }
        })
      ).toEqual([]);
      expect(
        await recall({
          kind: "folder",
          folder: { ...localFolder.identity, ownerUserId: receiver.userId }
        })
      ).toEqual(projected.memoryEventIds);
      expect(await recall({ kind: "repository", repository: gitB })).toEqual(
        projected.memoryEventIds
      );
      await append();
      const third = await publish();
      expect(await receive(third.pkg)).toBe(remoteId);
      expect(
        (await receiverRepo.getPersonalSourceContext(receiver, remoteId))
          .context.folder.correction
      ).toMatchObject({
        state: "corrected",
        value: {
          state: "known",
          value: {
            reference: { ...localFolder.identity, ownerUserId: receiver.userId }
          }
        }
      });
      const beforeLegacy = (
        await receiverRepo.getPersonalSourceContext(receiver, remoteId)
      ).context;
      await append();
      const legacyPackage = await publish(false);
      expect(legacyPackage.manifest.version).toBe("4");
      expect(await receive(legacyPackage.pkg)).toBe(remoteId);
      expect(
        (await receiverRepo.getPersonalSourceContext(receiver, remoteId))
          .context
      ).toEqual(beforeLegacy);
      expect(
        JSON.stringify([
          first.pkg,
          second.pkg,
          third.pkg,
          originUpdate,
          resolution,
          folderUpdate
        ])
      ).not.toContain("/same/path");
      const originalNative = (
        await receiverPool.query<{
          repository_automatic_identity: unknown;
          folder_assignment: unknown;
        }>(
          "select repository_automatic_identity,folder_assignment from sessions where id=$1",
          [remoteId]
        )
      ).rows[0]!;
      expect(originalNative.repository_automatic_identity).toEqual(gitA);
      await Promise.all([originPool.end(), receiverPool.end()]);
      originPool = createDbPool({ connectionString: originUrl });
      receiverPool = createDbPool({ connectionString: receiverUrl });
      originRepo = createMemorySourceRepository(originPool, options);
      receiverRepo = createMemorySourceRepository(receiverPool, options);
      originConfig = config(originRepo, origin, fixture.origin);
      receiverConfig = config(receiverRepo, receiver, fixture.receiver);
      await deliverConfig(
        resolution,
        fixture.receiver,
        fixture.origin,
        originConfig
      );
      expect(
        (await receiverRepo.getPersonalSourceContext(receiver, remoteId))
          .context.sync?.git.state
      ).toBe("available");
      expect(
        (await originRepo.getPersonalSourceContext(origin, source.id)).context
          .sync?.git.state
      ).toBe("available");
      expect(
        (
          await receiverPool.query(
            "select repository_automatic_identity,folder_assignment from sessions where id=$1",
            [remoteId]
          )
        ).rows[0]
      ).toEqual(originalNative);
      const beforeReplay = (
        await receiverRepo.getPersonalSourceContext(receiver, remoteId)
      ).context;
      expect(
        await receiverRepo.receivePdsInbox({
          userId: receiver.userId,
          groupId: fixture.groupId,
          packageId: third.manifest.packageId,
          sourceManifestHash: third.pkg.header.sourceManifestHash
        })
      ).toBe("idempotent");
      expect(
        (
          await receiverRepo.claimPdsInbox({
            workerId: randomUUID(),
            limit: 100
          })
        ).some((entry) => entry.packageId === third.manifest.packageId)
      ).toBe(false);
      expect(
        (await receiverRepo.getPersonalSourceContext(receiver, remoteId))
          .context
      ).toEqual(beforeReplay);
      await originPool.query(
        "update personal_device_group_members set status='revoked' where group_id=(select id from personal_device_groups where group_id=$1) and device_id=$2",
        [fixture.groupId, fixture.receiver.deviceId]
      );
      await expect(
        deliverConfig(
          resolution,
          fixture.receiver,
          fixture.origin,
          originConfig
        )
      ).rejects.toThrow("PdsCryptoConfigurationAuthorAuthorityError");
    }, 60_000);
  }
);
