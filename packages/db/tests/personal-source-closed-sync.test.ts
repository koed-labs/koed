import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalizePdsJson,
  createLocalTestKeyEnvelopeEncryptionProvider,
  createPdsSessionManifest,
  createPdsSessionPackage,
  createPdsRepositoryAssignmentFromSourceContext,
  verifyAndDecryptPdsSessionSourcePackage,
  isPdsSessionCheckpointManifest,
  verifyPdsRepositoryAssignmentWithKeyHistory,
  personalSourceContextSnapshotSchema
} from "@koed/shared";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";
import { personalSourceDeviceFixture } from "./fixtures/personal-source-device.js";
import { materializePdsSession } from "../../../apps/worker/src/personal-device-sync-runtime.js";

const originUrl = process.env.P1_SOURCE_ORIGIN_DATABASE_URL,
  receiverUrl = process.env.P1_SOURCE_RECEIVER_DATABASE_URL;
describe.skipIf(!originUrl || !receiverUrl)(
  "closed Personal source format compatibility",
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
    it("maps a signed Unicode logical identity to native storage, preserves historical unknown facts, and still reads legacy closed packages", async () => {
      const fixture = personalSourceDeviceFixture(),
        origin = await fixture.initialize(originPool, fixture.origin),
        receiver = await fixture.initialize(receiverPool, fixture.receiver);
      const encryption = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 114).toString("base64")
      );
      const repo = createMemorySourceRepository(receiverPool, {
        envelopeEncryptionProvider: encryption
      });
      let sequence = 0;
      const importClosed = async (
        logicalSessionId: string,
        withContext: boolean
      ) => {
        const externalSessionId = `closed-provider-${randomUUID()}`;
        const context = personalSourceContextSnapshotSchema.parse({
          version: "1",
          context: {
            version: 1,
            source: {
              ownerUserId: origin.userId,
              originatingDeploymentId: fixture.origin.deploymentId,
              originatingDeviceId: fixture.origin.deviceId,
              logicalSessionId
            },
            git: {
              revision: 1,
              original: {
                state: "unresolved",
                reason: "historical_unresolved"
              },
              correction: { state: "original" }
            },
            folder: {
              revision: 1,
              original: {
                state: "unresolved",
                reason: "historical_unresolved"
              },
              correction: { state: "original" }
            }
          },
          git: {
            head: "origin_git",
            revisions: [
              {
                revisionId: "origin_git",
                replaces: [],
                assignment: {
                  revision: 1,
                  original: {
                    state: "unresolved",
                    reason: "historical_unresolved"
                  },
                  correction: { state: "original" }
                }
              }
            ]
          },
          folder: {
            head: "origin_folder",
            revisions: [
              {
                revisionId: "origin_folder",
                replaces: [],
                assignment: {
                  revision: 1,
                  original: {
                    state: "unresolved",
                    reason: "historical_unresolved"
                  },
                  correction: { state: "original" }
                }
              }
            ]
          }
        });
        const now = new Date().toISOString();
        const manifest = createPdsSessionManifest({
          runtime: fixture.runtime(fixture.origin),
          originDeploymentId: fixture.origin.deploymentId,
          sourceSequence: String(++sequence),
          sourceNativeSessionId: externalSessionId,
          contentEpoch: fixture.epoch,
          ...(withContext ? { sourceContext: context } : {}),
          repositoryAssignment: createPdsRepositoryAssignmentFromSourceContext(
            context.context,
            fixture.epoch,
            fixture.projectAliasKey,
            { capturedCwd: "/receiving/path/is/not/proof" }
          ),
          closedSession: {
            closed: true,
            logicalSessionId,
            externalSessionId,
            sourceAdapter: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            captureMethod: "transcript",
            sourceCreatedAt: now,
            sourceClosedAt: now,
            observedClosedAt: now
          },
          terminalCursor: "1",
          items: [
            {
              sourceNativeItemId: `item-${externalSessionId}`,
              sequence: "0",
              sourceTimestamp: now,
              observedAt: now,
              actor: "agent",
              type: "agent_message",
              content: "Historical source context fixture",
              metadata: {}
            }
          ],
          sourceFingerprintKey: fixture.sourceFingerprintKey,
          tombstoneFloorKey: fixture.tombstoneFloorKey,
          originSigningPrivateKey: fixture.origin.signing.privateKey
        });
        expect(manifest.version).toBe(withContext ? "5" : "3");
        const pkg = createPdsSessionPackage({
          runtime: fixture.runtime(fixture.origin),
          manifest,
          servingSigningPrivateKey: fixture.origin.signing.privateKey,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString()
        });
        const verified = verifyAndDecryptPdsSessionSourcePackage(
          canonicalizePdsJson(pkg),
          {
            runtime: fixture.runtime(fixture.origin, fixture.receiver),
            recipientKemPrivateKey: fixture.receiver.kem.privateSeed
          }
        );
        if (isPdsSessionCheckpointManifest(verified))
          throw new Error("Expected closed manifest");
        const workerId = randomUUID();
        await repo.receivePdsInbox({
          userId: receiver.userId,
          groupId: fixture.groupId,
          packageId: manifest.packageId,
          sourceManifestHash: pkg.header.sourceManifestHash
        });
        const inbox = (await repo.claimPdsInbox({ workerId, limit: 100 })).find(
          (entry) => entry.packageId === manifest.packageId
        );
        if (!inbox) throw new Error("Missing fixture inbox");
        const retained = await repo.retainPdsInboundPackage({
          userId: receiver.userId,
          groupId: fixture.groupId,
          inboxId: inbox.id,
          packageId: manifest.packageId,
          sourceManifestHash: pkg.header.sourceManifestHash,
          sourceLogicalSessionId: logicalSessionId,
          ...(verified.sourceContext
            ? {
                sourceContextHash: createHash("sha256")
                  .update(canonicalizePdsJson(verified.sourceContext))
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
          encryptedEnvelope: await encryption.encrypt({
            plaintext: canonicalizePdsJson(pkg),
            scope: { tenantId: receiver.userId },
            provenance: { rowFamily: "pds_retained_packages" },
            ciphertextLocation: "fixture"
          })
        });
        const assignment = verifyPdsRepositoryAssignmentWithKeyHistory(
          verified.repositoryAssignment,
          verified.contentEpoch,
          { currentEpoch: fixture.epoch, projectKey: fixture.projectAliasKey }
        );
        const session = await materializePdsSession(
          repo,
          receiver.userId,
          fixture.groupId,
          verified,
          assignment,
          retained.retainedPackageId
        );
        expect(await repo.getCapturedSession(receiver, session.id)).toBeNull();
        const staged = (
          await receiverPool.query<{
            context_version: number;
            availability: string;
          }>(
            "select context_version,availability from personal_source_bindings where owner_user_id=$1 and local_session_id=$2",
            [receiver.userId, session.id]
          )
        ).rows[0]!;
        expect(staged).toEqual({ context_version: 0, availability: "pending" });
        const final = await repo.materializePdsReplica({
          workerId,
          inboxId: inbox.id,
          userId: receiver.userId,
          groupId: fixture.groupId,
          retainedPackageId: retained.retainedPackageId,
          localSessionId: session.id,
          sourceItemIds: session.itemIds,
          sourceFingerprint: manifest.sourceFingerprint,
          closureHash: manifest.sourceClosureHash,
          originDeploymentId: manifest.originDeploymentId,
          originDeviceId: manifest.originDeviceId,
          sourceSequence: manifest.sourceSequence,
          sourceClosedAt: new Date(manifest.closedSession.sourceClosedAt),
          observedAt: new Date(),
          closedProfileTransition: manifest.profileTransition,
          pdsRepositoryAssignment: manifest.repositoryAssignment,
          sourceLogicalSessionId: logicalSessionId,
          ...(verified.sourceContext
            ? { sourceContext: verified.sourceContext }
            : {})
        });
        expect(final.conflict).toBe(false);
        await repo.completePdsInbox({
          workerId,
          inboxId: inbox.id,
          retainedPackageId: retained.retainedPackageId,
          state: "ready"
        });
        const accepted = (
          await repo.getPersonalSourceContext(receiver, session.id)
        ).context;
        expect(accepted.logicalSessionId).not.toBe(logicalSessionId);
        expect(accepted.git.original).toEqual({
          state: "unresolved",
          reason: "historical_unresolved"
        });
        expect(accepted.folder.original).toEqual({
          state: "unresolved",
          reason: "historical_unresolved"
        });
        expect(accepted.sync?.source.logicalSessionId).toBe(
          withContext ? logicalSessionId : undefined
        );
        expect(
          await materializePdsSession(
            repo,
            receiver.userId,
            fixture.groupId,
            verified,
            assignment,
            retained.retainedPackageId
          )
        ).toEqual(session);
        expect(
          (await repo.getPersonalSourceContext(receiver, session.id)).context
        ).toEqual(accepted);
        await expect(
          receiverPool.query(
            "update conversation_items set raw_text='rewritten' where id=$1",
            [session.itemIds[0]]
          )
        ).rejects.toThrow("PDS source items are read-only");
        expect(JSON.stringify(pkg)).not.toContain(
          "/receiving/path/is/not/proof"
        );
        return session.id;
      };
      expect(
        await importClosed(`历史/Conversation/α/${randomUUID()}`, true)
      ).toBeDefined();
      expect(
        await importClosed(`legacy-logical-${randomUUID()}`, false)
      ).toBeDefined();
    }, 60_000);
  }
);
