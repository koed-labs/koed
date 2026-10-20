import type pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  encodePdsPersonalMembershipEntitySnapshot,
  signPersonalConfigurationRecord,
  PERSONAL_CONFIGURATION_PROTOCOL,
  type PersonalMembershipEntitySnapshot
} from "@koed/shared";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";
import { personalSourceSelectionSql } from "../src/personal-selection-sql.js";
import { personalSourceDeviceFixture } from "./fixtures/personal-source-device.js";
import { createPdsConfigurationRuntime } from "../../../apps/worker/src/personal-device-sync-configuration.js";

const originUrl = process.env.P1_SOURCE_ORIGIN_DATABASE_URL,
  receiverUrl = process.env.P1_SOURCE_RECEIVER_DATABASE_URL;
describe.skipIf(!originUrl || !receiverUrl)(
  "Personal membership causal receipt across two devices",
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
    it("keeps empty catalogs separate, preserves concurrent offline names, and retains missing-source inclusions and removals", async () => {
      const fixture = personalSourceDeviceFixture(),
        origin = await fixture.initialize(originPool, fixture.origin),
        receiver = await fixture.initialize(receiverPool, fixture.receiver),
        encryption = createLocalTestKeyEnvelopeEncryptionProvider(
          Buffer.alloc(32, 117).toString("base64")
        ),
        originRepo = createMemorySourceRepository(originPool, {
          envelopeEncryptionProvider: encryption
        }),
        receiverRepo = createMemorySourceRepository(receiverPool, {
          envelopeEncryptionProvider: encryption
        });
      const scope = (actor: typeof origin, device: typeof fixture.origin) => ({
        ...actor,
        groupId: fixture.groupId,
        authorDeviceId: device.deviceId,
        authorSigningKeyId: device.signingKeyId,
        originatingDeploymentId: device.deploymentId,
        expectedEpoch: fixture.epoch,
        expectedAuthorityHead: fixture.authorityHead
      });
      const runtime = (
        actor: typeof origin,
        device: typeof fixture.origin,
        repo: typeof originRepo
      ) =>
        createPdsConfigurationRuntime({
          ...actor,
          groupId: fixture.groupId,
          originDeploymentId: device.deploymentId,
          activeCertificates: fixture.certificates,
          repository: repo.personalConfiguration!,
          runtime: fixture.runtime(device),
          signingKey: device.signing.privateKey,
          encryption,
          relay: () => {
            throw new Error("This receipt gate performs no relay calls");
          }
        });
      const originRuntime = runtime(origin, fixture.origin, originRepo),
        receiverRuntime = runtime(receiver, fixture.receiver, receiverRepo);
      const record = (
        snapshot: PersonalMembershipEntitySnapshot,
        device: typeof fixture.origin
      ) =>
        signPersonalConfigurationRecord(
          {
            protocol: PERSONAL_CONFIGURATION_PROTOCOL,
            groupId: fixture.groupId,
            authorDeviceId: device.deviceId,
            authorSigningKeyId: device.signingKeyId,
            payload: {
              kind: "project_membership",
              snapshot: encodePdsPersonalMembershipEntitySnapshot(snapshot)
            }
          },
          device.signing.privateKey
        );
      const catalog = async (
        actor: typeof origin,
        device: typeof fixture.origin,
        repo: typeof originRepo,
        id: string
      ) => {
        const page =
          await repo.personalConfiguration!.listPersonalConfigurationCatalogSnapshots(
            scope(actor, device)
          );
        return page.snapshots.find(
          (snapshot) => snapshot.project.projectId === id
        )!;
      };
      const empty = await originRepo.createNamedPersonalProject(origin, {
          name: "Equal name"
        }),
        independent = await receiverRepo.createNamedPersonalProject(receiver, {
          name: "Equal name"
        });
      const original = record(
        await catalog(origin, fixture.origin, originRepo, empty.projectId),
        fixture.origin
      );
      expect((await receiverRuntime.retainVerified(original)).applied).toBe(
        true
      );
      const received = await receiverRepo.listNamedPersonalProjects(receiver);
      expect(
        received.filter((project) => project.name === "Equal name")
      ).toHaveLength(2);
      expect(independent.projectId).not.toBe(empty.projectId);
      expect(
        (
          await receiverPool.query<{ n: number }>(
            "select count(*)::int n from sessions where owner_user_id=$1",
            [receiver.userId]
          )
        ).rows[0]!.n
      ).toBe(0);
      await originRepo.updateNamedPersonalProject(origin, empty.projectId, {
        name: "Origin offline",
        expectedVersion: empty.version
      });
      await receiverRepo.updateNamedPersonalProject(receiver, empty.projectId, {
        name: "Receiver offline",
        expectedVersion: received.find(
          (project) => project.projectId === empty.projectId
        )!.version
      });
      const originEdit = record(
          await catalog(origin, fixture.origin, originRepo, empty.projectId),
          fixture.origin
        ),
        receiverEdit = record(
          await catalog(
            receiver,
            fixture.receiver,
            receiverRepo,
            empty.projectId
          ),
          fixture.receiver
        );
      await receiverRuntime.retainVerified(originEdit);
      await originRuntime.retainVerified(receiverEdit);
      for (const [pool, actor] of [
        [originPool, origin],
        [receiverPool, receiver]
      ] as const) {
        const state = await pool.query<{ state: string; heads: string[] }>(
          "select state,heads from personal_membership_entities where owner_user_id=$1 and project_identity=$2 and entity_kind='project'",
          [actor.userId, empty.projectId]
        );
        expect(state.rows[0]!.state).toBe("conflict");
        expect(state.rows[0]!.heads).toHaveLength(2);
      }
      const conflicted = (
        await receiverRepo.listNamedPersonalProjects(receiver)
      ).find((project) => project.projectId === empty.projectId)!;
      await expect(
        receiverRepo.updateNamedPersonalProject(receiver, empty.projectId, {
          name: "Unreviewed overwrite",
          expectedVersion: conflicted.version
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "membership_review_required"
      });
      const versions = await receiverPool.query<{ version: number }>(
        "select version from personal_named_projects where owner_user_id=$1 and project_id=$2",
        [receiver.userId, empty.projectId]
      );
      await receiverRuntime.retainVerified(originEdit);
      expect(
        (
          await receiverPool.query<{ version: number }>(
            "select version from personal_named_projects where owner_user_id=$1 and project_id=$2",
            [receiver.userId, empty.projectId]
          )
        ).rows
      ).toEqual(versions.rows);

      const previewChange = async (
        repo: typeof originRepo,
        actor: typeof origin,
        projectId: string,
        entityId: string,
        change: Parameters<
          typeof originRepo.previewPersonalMembershipReview
        >[2]["change"]
      ) => {
        const current = await repo.getPersonalMembershipSyncState(
          actor,
          projectId
        );
        const entity =
          current.catalog?.entityId === entityId
            ? current.catalog
            : current.memberships.find((value) => value.entityId === entityId)!;
        return repo.previewPersonalMembershipReview(actor, projectId, {
          entityId,
          expectedVersion: current.project.version,
          expectedHeads: entity.heads.map((head) => head.revisionId),
          change
        });
      };
      const staleCatalogReview = await previewChange(
        receiverRepo,
        receiver,
        empty.projectId,
        empty.projectId,
        { kind: "set_project", name: "Receiver reviewed" }
      );
      const catalogReview = await previewChange(
        originRepo,
        origin,
        empty.projectId,
        empty.projectId,
        { kind: "set_project", name: "Origin reviewed" }
      );
      const catalogApplied = await originRepo.applyPersonalMembershipReview(
        origin,
        empty.projectId,
        catalogReview.preview.reviewId,
        { expectedVersion: catalogReview.preview.expectedVersion }
      );
      expect(catalogApplied.state.catalog?.heads).toHaveLength(1);
      expect(catalogApplied.state.project.name).toBe("Origin reviewed");
      await receiverRuntime.retainVerified(
        record(
          await catalog(origin, fixture.origin, originRepo, empty.projectId),
          fixture.origin
        )
      );
      await expect(
        receiverRepo.applyPersonalMembershipReview(
          receiver,
          empty.projectId,
          staleCatalogReview.preview.reviewId,
          { expectedVersion: staleCatalogReview.preview.expectedVersion }
        )
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "membership_review_stale"
      });
      expect(
        (
          await originRepo.applyPersonalMembershipReview(
            origin,
            empty.projectId,
            catalogReview.preview.reviewId,
            { expectedVersion: catalogReview.preview.expectedVersion }
          )
        ).state.project.version
      ).toBe(catalogApplied.state.project.version);

      const project = await originRepo.createNamedPersonalProject(origin, {
          name: "Pending source"
        }),
        source = await originRepo.createCapturedSession(origin, {
          externalSessionId: randomUUID()
        });
      const added = await originRepo.addPersonalProjectSession(
        origin,
        project.projectId,
        {
          sessionId: source.id,
          expectedVersion: project.version
        }
      );
      const selected = () =>
        originPool.query<{ id: string }>(
          `select s.id from sessions s where ${personalSourceSelectionSql("s", "$1", { inspection: true })}`,
          [
            {
              ownerUserId: origin.userId,
              searchDomain: "project",
              namedProjectId: project.projectId
            }
          ]
        );
      expect((await selected()).rows.map((row) => row.id)).toContain(source.id);
      await receiverRuntime.retainVerified(
        record(
          await catalog(origin, fixture.origin, originRepo, project.projectId),
          fixture.origin
        )
      );
      const direct = async () =>
        (
          await originRepo.personalConfiguration!.listPersonalConfigurationDirectSnapshots(
            scope(origin, fixture.origin)
          )
        ).snapshots.find(
          (snapshot) => snapshot.project.projectId === project.projectId
        )!;
      const included = record(await direct(), fixture.origin);
      expect((await receiverRuntime.retainVerified(included)).applied).toBe(
        true
      );
      expect(
        (
          await receiverPool.query<{ n: number }>(
            "select count(*)::int n from sessions where owner_user_id=$1",
            [receiver.userId]
          )
        ).rows[0]!.n
      ).toBe(0);
      expect(
        (
          await receiverPool.query<{ n: number }>(
            "select count(*)::int n from personal_project_inclusions where owner_user_id=$1 and project_id=$2",
            [receiver.userId, project.projectId]
          )
        ).rows[0]!.n
      ).toBe(0);
      const pending = await receiverPool.query(
        `select e.state,b.availability,b.local_session_id from personal_membership_entities e
      join personal_source_bindings b on b.binding_id=e.source_binding_id where e.owner_user_id=$1 and e.project_identity=$2 and e.entity_kind='direct'`,
        [receiver.userId, project.projectId]
      );
      expect(pending.rows).toEqual([
        { state: "available", availability: "pending", local_session_id: null }
      ]);
      const removed = await originRepo.removePersonalProjectInclusion(
        origin,
        project.projectId,
        added.membership.inclusionId,
        { expectedVersion: added.project.version }
      );
      expect((await selected()).rows).toHaveLength(0);
      await receiverRuntime.retainVerified(
        record(await direct(), fixture.origin)
      );
      expect(
        (
          await receiverPool.query<{ operation: string }>(
            `select current_revision->'operation'->>'kind' operation from personal_membership_entities
      where owner_user_id=$1 and project_identity=$2 and entity_kind='direct'`,
            [receiver.userId, project.projectId]
          )
        ).rows[0]!.operation
      ).toBe("remove_inclusion");
      await receiverRuntime.retainVerified(included);
      expect(
        (
          await receiverPool.query<{ n: number }>(
            "select count(*)::int n from personal_project_inclusions where owner_user_id=$1 and project_id=$2",
            [receiver.userId, project.projectId]
          )
        ).rows[0]!.n
      ).toBe(0);
      await originRepo.addPersonalProjectSession(origin, project.projectId, {
        sessionId: source.id,
        expectedVersion: removed.project.version
      });
      expect((await selected()).rows.map((row) => row.id)).toContain(source.id);
      expect(
        await originRepo.listPersonalProjectMemberships(
          origin,
          project.projectId
        )
      ).toHaveLength(1);
      const receiverState = await receiverRepo.getPersonalMembershipSyncState(
        receiver,
        project.projectId
      );
      const pendingEntityId = receiverState.memberships[0]!.entityId;
      const pendingInclude = await previewChange(
        receiverRepo,
        receiver,
        project.projectId,
        pendingEntityId,
        { kind: "include" }
      );
      expect(pendingInclude.preview.effect).toMatchObject({
        sourceReady: false,
        included: false
      });
      await receiverRepo.applyPersonalMembershipReview(
        receiver,
        project.projectId,
        pendingInclude.preview.reviewId,
        { expectedVersion: pendingInclude.preview.expectedVersion }
      );
      const pendingRemove = await previewChange(
        receiverRepo,
        receiver,
        project.projectId,
        pendingEntityId,
        { kind: "remove_inclusion" }
      );
      await receiverRepo.applyPersonalMembershipReview(
        receiver,
        project.projectId,
        pendingRemove.preview.reviewId,
        { expectedVersion: pendingRemove.preview.expectedVersion }
      );
      expect(
        (
          await receiverPool.query<{ n: number }>(
            "select count(*)::int n from sessions where owner_user_id=$1",
            [receiver.userId]
          )
        ).rows[0]!.n
      ).toBe(0);
      expect(
        (
          await receiverPool.query<{ n: number }>(
            "select count(*)::int n from personal_project_inclusions where owner_user_id=$1 and project_id=$2",
            [receiver.userId, project.projectId]
          )
        ).rows[0]!.n
      ).toBe(0);
      const forwarded = (
        await receiverRepo.personalConfiguration!.listPersonalConfigurationDirectSnapshots(
          scope(receiver, fixture.receiver)
        )
      ).snapshots.find((value) => value.entityId === pendingEntityId)!;
      await originRuntime.retainVerified(record(forwarded, fixture.receiver));
      expect((await selected()).rows).toHaveLength(0);
      const directState = await originRepo.getPersonalMembershipSyncState(
        origin,
        project.projectId
      );
      expect(directState.memberships[0]!.state).toBe("conflict");
      const directReview = await previewChange(
        originRepo,
        origin,
        project.projectId,
        pendingEntityId,
        { kind: "include" }
      );
      expect(directReview.preview.effect).toMatchObject({
        sourceReady: true,
        included: true
      });
      await originRepo.applyPersonalMembershipReview(
        origin,
        project.projectId,
        directReview.preview.reviewId,
        { expectedVersion: directReview.preview.expectedVersion }
      );
      expect((await selected()).rows.map((row) => row.id)).toContain(source.id);
    }, 60_000);
  }
);
