import { createMemoryEngine } from "@koed/core";
import type pg from "pg";
import { randomUUID } from "node:crypto";
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
  createLocalTestKeyEnvelopeEncryptionProvider,
  signPersonalConfigurationRecord,
  encodePdsPersonalMembershipEntitySnapshot,
  personalMembershipInclusionIdentity,
  PERSONAL_CONFIGURATION_PROTOCOL,
  type PersonalConfigurationFeature
} from "@koed/shared";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";
import { personalSourceDeviceFixture } from "./fixtures/personal-source-device.js";
import {
  personalFixtureClosedSource,
  receivePersonalFixtureClosedSource
} from "./fixtures/personal-source-import.js";
import { createPersonalConfigurationDeliveryFixture } from "./fixtures/personal-configuration-delivery.js";

const originUrl = process.env.P1_SOURCE_ORIGIN_DATABASE_URL,
  receiverUrl = process.env.P1_SOURCE_RECEIVER_DATABASE_URL;
describe.skipIf(!originUrl || !receiverUrl)(
  "Personal membership encrypted delivery and source dependencies",
  () => {
    let originPool: pg.Pool, receiverPool: pg.Pool;
    const pools = () => {
      originPool = createDbPool({ connectionString: originUrl });
      receiverPool = createDbPool({ connectionString: receiverUrl });
    };
    beforeAll(async () => {
      pools();
      await runDbMigrations(originPool);
      await runDbMigrations(receiverPool);
    }, 60_000);
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
    afterAll(async () => {
      await Promise.all([originPool?.end(), receiverPool?.end()]);
    });
    it("delivers without capture, gates old peers, waits for the verified body, merges independent edits, and retains deletion through restart", async () => {
      const fixture = personalSourceDeviceFixture(),
        origin = await fixture.initialize(originPool, fixture.origin),
        receiver = await fixture.initialize(receiverPool, fixture.receiver),
        encryption = createLocalTestKeyEnvelopeEncryptionProvider(
          Buffer.alloc(32, 119).toString("base64")
        );
      let originRepo = createMemorySourceRepository(originPool, {
          envelopeEncryptionProvider: encryption
        }),
        receiverRepo = createMemorySourceRepository(receiverPool, {
          envelopeEncryptionProvider: encryption
        });
      let features: PersonalConfigurationFeature[] = ["source_context_v1"];
      // Model the receiving peer’s signed support independently from local advertisement.
      const {
        packets,
        allPackets,
        advertise,
        config,
        scope,
        decode,
        deliver,
        flush,
        selected
      } = createPersonalConfigurationDeliveryFixture(
        fixture,
        encryption,
        () => features
      );
      let originConfig = config(origin, fixture.origin, originRepo),
        receiverConfig = config(receiver, fixture.receiver, receiverRepo);

      const name = "Private empty Project Ω",
        renamed = "Private reviewed rename Ω";
      const project = await originRepo.createNamedPersonalProject(origin, {
        name
      });
      await receiverRepo.createNamedPersonalProject(receiver, { name });
      await originConfig.reconcile();
      expect(packets).toHaveLength(0); // An older source-only peer cannot represent membership.
      expect(
        await receiverRepo.listNamedPersonalProjects(receiver)
      ).toHaveLength(1);
      features = ["project_membership_v1"]; // Membership is independent of source-context publication support.
      await flush(originConfig);
      expect(
        (await receiverRepo.listNamedPersonalProjects(receiver)).filter(
          (value) => value.name === name
        )
      ).toHaveLength(2);
      expect(
        (
          await receiverPool.query<{ n: number }>(
            "select count(*)::int n from sessions where owner_user_id=$1",
            [receiver.userId]
          )
        ).rows[0]!.n
      ).toBe(0);
      expect(advertise).toHaveBeenCalledWith([
        "source_context_v1",
        "project_membership_v1",
        "project_defaults_v1"
      ]);

      const externalSessionId = randomUUID();
      const source = await originRepo.createCapturedSession(origin, {
          externalSessionId
        }),
        localSameProvider = await receiverRepo.createCapturedSession(receiver, {
          externalSessionId
        });
      const current = await originRepo.getPersonalMembershipSyncState(
        origin,
        project.projectId
      );
      await originRepo.addPersonalProjectSession(origin, project.projectId, {
        sessionId: source.id,
        expectedVersion: current.project.version
      });
      await flush(originConfig);
      const pending = await receiverRepo.getPersonalMembershipSyncState(
        receiver,
        project.projectId
      );
      expect(pending.memberships).toHaveLength(1);
      expect(pending.memberships[0]!.source).toMatchObject({
        ready: false,
        localSessionId: null
      });
      expect(
        (await selected(receiverPool, receiver, project.projectId)).rows
      ).toHaveLength(0);
      expect(
        (
          await receiverPool.query<{ n: number }>(
            "select count(*)::int n from sessions where owner_user_id=$1",
            [receiver.userId]
          )
        ).rows[0]!.n
      ).toBe(1);
      const earlyReview = await receiverRepo.previewPersonalMembershipReview(
        receiver,
        project.projectId,
        {
          entityId: pending.memberships[0]!.entityId,
          expectedVersion: pending.project.version,
          expectedHeads: pending.memberships[0]!.heads.map(
            (head) => head.revisionId
          ),
          change: { kind: "remove_inclusion" }
        }
      );
      features = ["source_context_v1", "project_membership_v1"];
      await flush(originConfig);
      const snapshots =
        await originRepo.personalConfiguration!.listPersonalConfigurationSourceSnapshots(
          scope(origin, fixture.origin)
        );
      const snapshot = snapshots.snapshots.find(
        (value) =>
          value.context.source.logicalSessionId === source.logicalSessionId
      )!;
      expect(snapshot).toBeDefined();
      const sourcePackage = personalFixtureClosedSource({
        fixture,
        snapshot,
        externalSessionId,
        content: "MEMBERSHIP_BODY_DECISION"
      });
      const remote = await receivePersonalFixtureClosedSource({
        fixture,
        repository: receiverRepo,
        receiverUserId: receiver.userId,
        encryption,
        pkg: sourcePackage,
        beforeAvailable: async (id) => {
          expect(
            await receiverRepo.getCapturedSession(receiver, id)
          ).toBeNull();
          expect(
            (await selected(receiverPool, receiver, project.projectId)).rows
          ).toHaveLength(0);
        }
      });
      expect(remote.id).not.toBe(localSameProvider.id);
      expect(remote.id).not.toBe(source.id);
      // Body readiness itself changes the meaning of a review, even before view reconciliation bumps the Project version.
      await expect(
        receiverRepo.applyPersonalMembershipReview(
          receiver,
          project.projectId,
          earlyReview.preview.reviewId,
          { expectedVersion: earlyReview.preview.expectedVersion }
        )
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "membership_review_stale"
      });
      const projected = await receiverRepo.projectPendingConversationItems(
        receiver,
        { limit: 100 }
      );
      expect(projected.memoryEventsCreated).toBeGreaterThan(0);
      const vector = Array.from({ length: 1024 }, (_, index) =>
        index === 0 ? 1 : 0
      );
      vi.stubEnv("EMBEDDING_SERVICE_URL", "http://membership.fixture");
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
      const recall = async (targetProjectId = project.projectId) =>
        (
          await createMemoryEngine(receiverRepo).searchMemory({
            requesterContext: receiver,
            scope: "personal",
            query: "MEMBERSHIP_BODY_DECISION",
            retrievalStage: "raw_fallback_search",
            limit: 20,
            personalSelection: {
              version: 1,
              ownerUserId: receiver.userId,
              target: {
                kind: "project",
                project: {
                  ownerUserId: receiver.userId,
                  projectId: targetProjectId
                }
              },
              callerRepositoryContext: null
            }
          })
        ).results.map((value) => value.sourceId);
      expect(await recall()).toHaveLength(0);
      await flush(receiverConfig);
      expect(await recall()).toEqual(projected.memoryEventIds);
      expect(
        (await selected(receiverPool, receiver, project.projectId)).rows.map(
          (row) => row.id
        )
      ).toEqual([remote.id]);
      expect(
        (
          await receiverRepo.getPersonalMembershipSyncState(
            receiver,
            project.projectId
          )
        ).memberships[0]!.source
      ).toMatchObject({ ready: true, localSessionId: remote.id });
      expect(
        await receiverRepo.getCapturedSession(receiver, localSameProvider.id)
      ).not.toBeNull();

      const originBefore = await originRepo.getPersonalMembershipSyncState(
        origin,
        project.projectId
      );
      const receiverBefore = await receiverRepo.getPersonalMembershipSyncState(
        receiver,
        project.projectId
      );
      const inclusion = (
        await receiverRepo.listPersonalProjectMemberships(
          receiver,
          project.projectId
        )
      )[0]!;
      await originRepo.updateNamedPersonalProject(origin, project.projectId, {
        name: renamed,
        expectedVersion: originBefore.project.version
      });
      await receiverRepo.removePersonalProjectInclusion(
        receiver,
        project.projectId,
        inclusion.inclusionId,
        { expectedVersion: receiverBefore.project.version }
      );
      await flush(originConfig);
      await flush(receiverConfig);
      expect(
        (
          await originRepo.getPersonalMembershipSyncState(
            origin,
            project.projectId
          )
        ).project.name
      ).toBe(renamed);
      expect(
        (
          await receiverRepo.getPersonalMembershipSyncState(
            receiver,
            project.projectId
          )
        ).project.name
      ).toBe(renamed);
      expect(
        (await selected(originPool, origin, project.projectId)).rows
      ).toHaveLength(0);
      expect(
        (await selected(receiverPool, receiver, project.projectId)).rows
      ).toHaveLength(0);
      expect(await recall()).toHaveLength(0);
      const readd = await originRepo.getPersonalMembershipSyncState(
        origin,
        project.projectId
      );
      await originRepo.addPersonalProjectSession(origin, project.projectId, {
        sessionId: source.id,
        expectedVersion: readd.project.version
      });
      await flush(originConfig);
      expect(
        (await selected(receiverPool, receiver, project.projectId)).rows.map(
          (row) => row.id
        )
      ).toEqual([remote.id]);

      expect(await recall()).toEqual(projected.memoryEventIds);
      const restart = async () => {
        await Promise.all([originPool.end(), receiverPool.end()]);
        pools();
        originRepo = createMemorySourceRepository(originPool, {
          envelopeEncryptionProvider: encryption
        });
        receiverRepo = createMemorySourceRepository(receiverPool, {
          envelopeEncryptionProvider: encryption
        });
        originConfig = config(origin, fixture.origin, originRepo);
        receiverConfig = config(receiver, fixture.receiver, receiverRepo);
      };
      await restart();
      const beforeReplay = await receiverRepo.getPersonalMembershipSyncState(
        receiver,
        project.projectId
      );
      for (const pkg of allPackets) await deliver(pkg);
      await flush(originConfig);
      await flush(receiverConfig);
      expect(
        (
          await receiverRepo.getPersonalMembershipSyncState(
            receiver,
            project.projectId
          )
        ).project.version
      ).toBe(beforeReplay.project.version);
      expect(
        (await selected(receiverPool, receiver, project.projectId)).rows.map(
          (row) => row.id
        )
      ).toEqual([remote.id]);
      expect(
        await receiverRepo.receivePdsInbox({
          userId: receiver.userId,
          groupId: fixture.groupId,
          packageId: sourcePackage.header.packageId,
          sourceManifestHash: sourcePackage.header.sourceManifestHash
        })
      ).toBe("idempotent");
      expect(await recall()).toEqual(projected.memoryEventIds);
      const deleting = await originRepo.getPersonalMembershipSyncState(
        origin,
        project.projectId
      );
      await originRepo.deleteNamedPersonalProject(origin, project.projectId, {
        expectedVersion: deleting.project.version
      });
      await flush(originConfig);
      await restart();
      for (const pkg of allPackets) await deliver(pkg);
      expect(
        (await receiverRepo.listNamedPersonalProjects(receiver)).some(
          (value) => value.projectId === project.projectId
        )
      ).toBe(false);
      expect(
        (await selected(receiverPool, receiver, project.projectId)).rows
      ).toHaveLength(0);
      expect(
        await receiverRepo.getCapturedSession(receiver, remote.id)
      ).not.toBeNull();
      expect(await recall()).toHaveLength(0);
      for (const pkg of allPackets) {
        expect(JSON.stringify(pkg)).not.toContain(name);
        expect(JSON.stringify(pkg)).not.toContain(renamed);
        expect(JSON.stringify(pkg)).not.toContain("MEMBERSHIP_BODY_DECISION");
      }
      const known = allPackets
        .map((pkg) => decode(pkg).record)
        .find(
          (value) =>
            value.revision.authorDeviceId === fixture.origin.deviceId &&
            value.revision.payload.kind === "project_membership" &&
            value.revision.payload.snapshot.project.projectId ===
              project.projectId
        )!;
      if (known.revision.payload.kind !== "project_membership")
        throw new Error("Expected membership history");
      const rewritten = signPersonalConfigurationRecord(
        {
          protocol: PERSONAL_CONFIGURATION_PROTOCOL,
          groupId: fixture.groupId,
          authorDeviceId: fixture.origin.deviceId,
          authorSigningKeyId: fixture.origin.signingKeyId,
          payload: {
            kind: "project_membership",
            snapshot: {
              ...known.revision.payload.snapshot,
              revisions: known.revision.payload.snapshot.revisions.map(
                (revision) =>
                  revision.operation.kind === "set_project"
                    ? {
                        ...revision,
                        operation: {
                          kind: "set_project" as const,
                          name: "Rewritten historical value"
                        }
                      }
                    : revision
              )
            }
          }
        },
        fixture.origin.signing.privateKey
      );
      await expect(receiverConfig.retainVerified(rewritten)).rejects.toThrow(
        "PdsCryptoMembershipRevisionEquivocationError"
      );
      expect(
        (await selected(receiverPool, receiver, project.projectId)).rows
      ).toHaveLength(0);

      // An active witness can retain and forward old removals without granting
      // the historical author any current transport authority.
      const retiredProject = `opaque_project_${randomUUID().replaceAll("-", "")}`,
        retiredRevision = `opaque_revision_${randomUUID().replaceAll("-", "")}`,
        retiredDevice = "retired_device";
      const historical = {
        version: 1 as const,
        project: { ownerUserId: origin.userId, projectId: retiredProject },
        entityId: retiredProject,
        revisionId: retiredRevision,
        authorDeviceId: retiredDevice,
        replaces: [],
        operation: {
          kind: "set_project" as const,
          name: "Retained historical catalog"
        }
      };
      const historicalRecord = signPersonalConfigurationRecord(
        {
          protocol: PERSONAL_CONFIGURATION_PROTOCOL,
          groupId: fixture.groupId,
          authorDeviceId: fixture.origin.deviceId,
          authorSigningKeyId: fixture.origin.signingKeyId,
          payload: {
            kind: "project_membership",
            snapshot: encodePdsPersonalMembershipEntitySnapshot({
              version: 1,
              project: historical.project,
              entityId: retiredProject,
              entityKind: "project",
              revisions: [historical]
            })
          }
        },
        fixture.origin.signing.privateKey
      );
      expect(
        (await receiverConfig.retainVerified(historicalRecord)).applied
      ).toBe(true);
      const localHistorical = (
        await receiverRepo.listNamedPersonalProjects(receiver)
      ).find((value) => value.name === "Retained historical catalog")!;
      expect(localHistorical.projectId).not.toBe(retiredProject);
      const opaqueState = await receiverRepo.getPersonalMembershipSyncState(
        receiver,
        localHistorical.projectId
      );
      expect(opaqueState.projectIdentity).toBe(retiredProject);
      expect(opaqueState.catalog!.heads[0]!.revisionId).toBe(retiredRevision);
      const opaqueSelector = {
        kind: "session" as const,
        source: snapshot.context.source
      };
      const opaqueInclusionId = personalMembershipInclusionIdentity(
        retiredProject,
        opaqueSelector
      );
      const opaqueInclusionRecord = signPersonalConfigurationRecord(
        {
          protocol: PERSONAL_CONFIGURATION_PROTOCOL,
          groupId: fixture.groupId,
          authorDeviceId: fixture.origin.deviceId,
          authorSigningKeyId: fixture.origin.signingKeyId,
          payload: {
            kind: "project_membership",
            snapshot: encodePdsPersonalMembershipEntitySnapshot({
              version: 1,
              project: historical.project,
              entityId: opaqueInclusionId,
              entityKind: "direct",
              revisions: [
                {
                  version: 1,
                  project: historical.project,
                  entityId: opaqueInclusionId,
                  revisionId: "opaque_inclusion_revision",
                  authorDeviceId: retiredDevice,
                  replaces: [],
                  operation: { kind: "include", selector: opaqueSelector }
                }
              ]
            })
          }
        },
        fixture.origin.signing.privateKey
      );
      expect(
        (await receiverConfig.retainVerified(opaqueInclusionRecord)).applied
      ).toBe(true);
      expect(await recall(localHistorical.projectId)).toEqual(
        projected.memoryEventIds
      );
      expect(await recall(retiredProject)).toEqual(projected.memoryEventIds);
      const afterOpaqueInclusion =
        await receiverRepo.getPersonalMembershipSyncState(
          receiver,
          localHistorical.projectId
        );
      const localRename = await receiverRepo.updateNamedPersonalProject(
        receiver,
        localHistorical.projectId,
        {
          name: "Opaque local rename",
          expectedVersion: afterOpaqueInclusion.project.version
        }
      );
      const renamedOpaque = await receiverRepo.getPersonalMembershipSyncState(
        receiver,
        localHistorical.projectId
      );
      expect(renamedOpaque.catalog!.heads[0]!.replaces).toEqual([
        retiredRevision
      ]);
      await receiverRepo.deleteNamedPersonalProject(
        receiver,
        localHistorical.projectId,
        { expectedVersion: localRename.version }
      );
      await flush(receiverConfig);
      const historicalRows = (
        await originPool.query<{ author: string }>(
          "select revision->>'authorDeviceId' author from personal_membership_revisions where owner_user_id=$1 and project_identity=$2 and entity_identity=$2 order by revision_id",
          [origin.userId, retiredProject]
        )
      ).rows;
      expect(historicalRows).toHaveLength(3);
      expect(
        historicalRows.filter((row) => row.author === retiredDevice)
      ).toHaveLength(1);
      const originMapping = (
        await originPool.query<{ local_project_id: string }>(
          "select local_project_id from personal_membership_entities where owner_user_id=$1 and project_identity=$2 and entity_kind='project'",
          [origin.userId, retiredProject]
        )
      ).rows[0]!;
      expect(originMapping.local_project_id).not.toBe(
        localHistorical.projectId
      );
      expect(
        (
          await originRepo.getPersonalMembershipSyncState(
            origin,
            originMapping.local_project_id
          )
        ).project.deletedAt
      ).not.toBeNull();
      const blocked = await originRepo.createNamedPersonalProject(origin, {
        name: "Revoked author must not apply"
      });
      await originConfig.reconcile();
      const rejected = packets.find((pkg) => {
        const payload = decode(pkg).record.revision.payload;
        return (
          payload.kind === "project_membership" &&
          payload.snapshot.project.projectId === blocked.projectId
        );
      })!;
      expect(rejected).toBeDefined();
      await receiverPool.query(
        `update personal_device_group_members m set status='revoked' from personal_device_groups g
      join local_personal_identities i on i.id=g.local_personal_identity_id
      where m.group_id=g.id and i.owner_user_id=$1 and g.group_id=$2 and m.device_id=$3`,
        [receiver.userId, fixture.groupId, fixture.origin.deviceId]
      );
      await expect(deliver(rejected)).rejects.toThrow(
        "PdsCryptoConfigurationAuthorAuthorityError"
      );
      expect(
        (await receiverRepo.listNamedPersonalProjects(receiver)).some(
          (value) => value.projectId === blocked.projectId
        )
      ).toBe(false);
    }, 60_000);
  }
);
