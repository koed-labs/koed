import type pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  canonicalizePdsJson,
  parseCanonicalPdsJson,
  createLocalTestKeyEnvelopeEncryptionProvider,
  decryptPdsEncryptedPayloadPackage,
  verifyPersonalConfigurationRecord,
  personalConfigurationPackageId,
  personalConfigurationRecordHash,
  PdsRelayClient,
  type PdsSessionPackage,
  type PersonalGitContext,
  type PersonalFolderObservation
} from "@koed/shared";
import { personalProjectDefaultIdentity } from "@koed/shared/personal-project-default";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";
import { preparePersonalSourceContextSnapshot } from "../src/personal-source-context-export.js";
import { personalSourceSelectionSql } from "../src/personal-selection-sql.js";
import {
  personalFixtureClosedSource,
  receivePersonalFixtureClosedSource
} from "./fixtures/personal-source-import.js";
import { personalSourceDeviceFixture } from "./fixtures/personal-source-device.js";
import { createPdsConfigurationRuntime } from "../../../apps/worker/src/personal-device-sync-configuration.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)(
  "PV-06 default Project convergence across native Personal databases",
  () => {
    const names = [0, 1].map(
      () => `default_sync_${randomUUID().replaceAll("-", "")}`
    );
    const admin = createDbPool({
      connectionString: databaseUrl ?? "postgresql://localhost/postgres"
    });
    let pools: pg.Pool[];
    beforeAll(async () => {
      pools = [];
      for (const name of names) {
        await admin.query(`create database "${name}"`);
        const url = new URL(databaseUrl!);
        url.pathname = `/${name}`;
        const pool = createDbPool({ connectionString: url.toString() });
        pools.push(pool);
        await runDbMigrations(pool);
      }
    }, 60_000);
    afterAll(async () => {
      await Promise.all((pools ?? []).map((pool) => pool.end()));
      for (const name of names)
        await admin.query(`drop database if exists "${name}" with(force)`);
      await admin.end();
    });
    const setup = async () => {
      const fixture = personalSourceDeviceFixture();
      const encryption = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 123).toString("base64")
      );
      const devices = [fixture.origin, fixture.receiver];
      const repositories = pools.map((pool) =>
        createMemorySourceRepository(pool, {
          envelopeEncryptionProvider: encryption
        })
      );
      const actors = await Promise.all(
        repositories.map(async (repo, index) => ({
          userId: (
            await repo.createUser({
              email: `defaults-${index}-${randomUUID()}@example.test`
            })
          ).id
        }))
      );
      const git = (index: number, key = "gr_pv06"): PersonalGitContext => ({
        kind: "portable_repository",
        key,
        root: index ? "/other/koed" : "/original/koed",
        branch: "main",
        checkoutId: `checkout_${index}`,
        originatingDeviceId: devices[index]!.deviceId,
        selectedRemote: index ? "upstream" : "origin",
        anchorDisplay: index
          ? "example.test/a/different-label"
          : "example.test/koed",
        reason: index ? "local_selection" : "origin"
      });
      const capture = (index: number, key = "gr_pv06") =>
        repositories[index]!.createCapturedSession(actors[index]!, {
          externalSessionId: randomUUID(),
          repositoryIdentity: git(index, key),
          metadata: { threadName: "Native captured decision" }
        });
      const reconcile = async (index: number) => {
        for (let i = 0; i < 100; i++)
          if (
            !(
              await repositories[index]!.reconcilePersonalProjectDefaults(
                actors[index]!,
                2
              )
            ).pending
          )
            return;
        throw new Error("Default reconciliation did not settle");
      };
      const packets: PdsSessionPackage[] = [];
      const allPackets: PdsSessionPackage[] = [];
      const relay = new PdsRelayClient({
        baseUrl: "http://127.0.0.1:59998",
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
          devices.map((device) =>
            fixture.capability(device, [
              "source_context_v1",
              "project_membership_v1",
              "project_defaults_v1"
            ])
          )
      );
      vi.spyOn(relay, "upload").mockImplementation(async (pkg) => {
        packets.push(pkg);
        allPackets.push(pkg);
        return { transportId: pkg.header.transportId, deliveryState: "acked" };
      });
      const runtime = (index: number) =>
        createPdsConfigurationRuntime({
          ...actors[index]!,
          groupId: fixture.groupId,
          originDeploymentId: devices[index]!.deploymentId,
          activeCertificates: fixture.certificates,
          repository: repositories[index]!.personalConfiguration!,
          runtime: fixture.runtime(devices[index]!),
          signingKey: devices[index]!.signing.privateKey,
          encryption,
          relay: () => relay
        });
      let runtimes: ReturnType<typeof runtime>[] = [];
      const pair = async () => {
        await Promise.all(
          pools.map((pool, index) =>
            fixture.initialize(pool, devices[index]!, actors[index]!.userId)
          )
        );
        runtimes = [runtime(0), runtime(1)];
      };
      const decode = (pkg: PdsSessionPackage) => {
        const originIndex = devices.findIndex(
            (device) => device.deviceId === pkg.header.servingDeviceId
          ),
          receiverIndex = 1 - originIndex;
        expect(originIndex).toBeGreaterThanOrEqual(0);
        const author = devices[originIndex]!,
          recipient = devices[receiverIndex]!;
        const decrypted = decryptPdsEncryptedPayloadPackage(
          canonicalizePdsJson(pkg),
          {
            runtime: fixture.runtime(author, recipient),
            recipientKemPrivateKey: recipient.kem.privateSeed
          }
        );
        const record = verifyPersonalConfigurationRecord(
          parseCanonicalPdsJson(
            Buffer.from(decrypted.plaintext).toString("utf8")
          ),
          {
            groupId: fixture.groupId,
            deviceId: author.deviceId,
            signingKeyId: author.signingKeyId,
            publicKey: author.signing.publicKey
          }
        );
        expect(
          personalConfigurationPackageId(
            personalConfigurationRecordHash(record),
            pkg.header.transportId
          )
        ).toBe(pkg.header.packageId);
        expect(JSON.stringify(pkg)).not.toContain("gr_pv06");
        expect(JSON.stringify(pkg)).not.toContain("/original/koed");
        return { record, receiverIndex };
      };
      const deliver = async (pkg: PdsSessionPackage) => {
        const { record, receiverIndex } = decode(pkg);
        return runtimes[receiverIndex]!.retainVerified(record);
      };
      const drain = async () => {
        while (packets.length) await deliver(packets.shift()!);
      };
      const publish = async (index: number) => {
        for (let i = 0; i < 30; i++) {
          const result = await runtimes[index]!.reconcile();
          if (result < 20) return;
        }
        throw new Error("Configuration publication did not settle");
      };
      const restart = (index: number) => {
        repositories[index] = createMemorySourceRepository(pools[index]!, {
          envelopeEncryptionProvider: encryption
        });
        runtimes[index] = runtime(index);
      };
      return {
        fixture,
        encryption,
        devices,
        repositories,
        actors,
        git,
        capture,
        reconcile,
        pair,
        publish,
        drain,
        deliver,
        decode,
        packets,
        allPackets,
        restart,
        projectId: (key = "gr_pv06") =>
          personalProjectDefaultIdentity({
            kind: "repository",
            repository: git(0, key)
          }).projectIdentity
      };
    };
    it("converges equivalent offline initializations and seed rules, preserves later rename, and keeps real concurrent names in review", async () => {
      const f = await setup();
      await Promise.all([f.capture(0), f.capture(1)]);
      await Promise.all([f.reconcile(0), f.reconcile(1)]);
      const projectId = f.projectId();
      for (let i = 0; i < 2; i++) {
        expect(
          (await f.repositories[i]!.listNamedPersonalProjects(f.actors[i]!))[0]!
            .projectId
        ).toBe(projectId);
        await f.repositories[i]!.createNamedPersonalProject(f.actors[i]!, {
          name: "koed"
        });
      }
      await f.pair();
      // Freeze both native initializations before either device sees its peer.
      await f.publish(0);
      await f.publish(1);
      const old = [...f.packets];
      await f.drain();
      for (let i = 0; i < 2; i++) {
        const state = await f.repositories[i]!.getPersonalMembershipSyncState(
          f.actors[i]!,
          projectId
        );
        expect(state.catalog?.state).toBe("available");
        expect(state.catalog?.heads).toHaveLength(2);
        expect(
          state.catalog?.heads.every((head) => head.automaticDefault)
        ).toBe(true);
        expect(
          state.memberships.filter((entity) => entity.entityKind === "rule")
        ).toHaveLength(1);
        expect(
          state.memberships.find((entity) => entity.entityKind === "rule")
            ?.heads
        ).toHaveLength(2);
        expect(
          (
            await f.repositories[i]!.listNamedPersonalProjects(f.actors[i]!)
          ).filter((project) => project.projectId === projectId)
        ).toHaveLength(1);
        expect(
          await f.repositories[i]!.listNamedPersonalProjects(f.actors[i]!)
        ).toHaveLength(3); // two independent User Projects remain distinct
      }
      const current = (
        await f.repositories[0]!.listNamedPersonalProjects(f.actors[0]!)
      ).find((project) => project.projectId === projectId)!;
      await f.repositories[0]!.updateNamedPersonalProject(
        f.actors[0]!,
        projectId,
        { expectedVersion: current.version, name: "My retained Koed name" }
      );
      await f.capture(0);
      await f.reconcile(0);
      await f.publish(0);
      await f.drain();
      f.restart(1);
      for (const pkg of old) await f.deliver(pkg);
      const remote = (
        await f.repositories[1]!.listNamedPersonalProjects(f.actors[1]!)
      ).find((project) => project.projectId === projectId)!;
      expect(remote.name).toBe("My retained Koed name");
      for (let i = 0; i < 2; i++) {
        const project = (
          await f.repositories[i]!.listNamedPersonalProjects(f.actors[i]!)
        ).find((project) => project.projectId === projectId)!;
        await f.repositories[i]!.updateNamedPersonalProject(
          f.actors[i]!,
          projectId,
          { expectedVersion: project.version, name: `Concurrent name ${i}` }
        );
      }
      await f.publish(0);
      await f.publish(1);
      await f.drain();
      for (let i = 0; i < 2; i++) {
        const state = await f.repositories[i]!.getPersonalMembershipSyncState(
          f.actors[i]!,
          projectId
        );
        expect(state.catalog?.state).toBe("conflict");
        expect(state.catalog?.heads.map((head) => head.operation)).toEqual(
          expect.arrayContaining([
            { kind: "set_project", name: "Concurrent name 0" },
            { kind: "set_project", name: "Concurrent name 1" }
          ])
        );
        expect(
          state.catalog?.heads.every((head) => !head.automaticDefault)
        ).toBe(true);
      }
    });
    it("retains offline seed removal and deletion over concurrent initialization, delayed replay, restart and later capture", async () => {
      const f = await setup();
      await Promise.all([f.capture(0), f.capture(1)]);
      await Promise.all([f.reconcile(0), f.reconcile(1)]);
      const projectId = f.projectId();
      let project = (
        await f.repositories[0]!.listNamedPersonalProjects(f.actors[0]!)
      )[0]!;
      const [seed] = await f.repositories[0]!.listPersonalProjectRules(
        f.actors[0]!,
        projectId
      );
      project = (
        await f.repositories[0]!.removePersonalProjectRule(
          f.actors[0]!,
          projectId,
          seed!.inclusionId,
          { expectedVersion: project.version }
        )
      ).project;
      await f.repositories[0]!.deleteNamedPersonalProject(
        f.actors[0]!,
        projectId,
        { expectedVersion: project.version }
      );
      await f.pair();
      await f.publish(0);
      await f.publish(1);
      const old = [...f.packets];
      await f.drain();
      f.restart(1);
      for (const pkg of old.reverse()) await f.deliver(pkg);
      await f.capture(1);
      await f.reconcile(1);
      await f.publish(1);
      await f.drain();
      for (let i = 0; i < 2; i++) {
        expect(
          await f.repositories[i]!.listNamedPersonalProjects(f.actors[i]!)
        ).toEqual([]);
        const state = await f.repositories[i]!.getPersonalMembershipSyncState(
          f.actors[i]!,
          projectId
        );
        expect(state.catalog?.state).toBe("available");
        expect(
          state.catalog?.heads.some(
            (head) => head.operation.kind === "delete_project"
          )
        ).toBe(true);
        expect(
          await f.repositories[i]!.listPersonalProjectRules(
            f.actors[i]!,
            projectId
          )
        ).toEqual([]);
        expect(
          (
            await pools[i]!.query(
              "select state from personal_project_defaults where owner_user_id=$1",
              [f.actors[i]!.userId]
            )
          ).rows
        ).toEqual([{ state: "suppressed" }]);
        expect(
          (
            await pools[i]!.query<{ count: number }>(
              "select count(*)::int as count from sessions where owner_user_id=$1",
              [f.actors[i]!.userId]
            )
          ).rows[0]!.count
        ).toBeGreaterThan(0);
      }
    });
    it("synchronizes suppression without an automatic Project and keeps equal Folder paths separate by device lifetime", async () => {
      const f = await setup();
      await f.capture(0, "gr_pv06_managed");
      await f.capture(1, "gr_pv06_managed");
      let manual = await f.repositories[0]!.createNamedPersonalProject(
        f.actors[0]!,
        { name: "User grouping" }
      );
      const included =
        await f.repositories[0]!.addPersonalProjectRepositoryRule(
          f.actors[0]!,
          manual.projectId,
          {
            expectedVersion: manual.version,
            repository: f.git(0, "gr_pv06_managed")
          }
        );
      manual = included.project;
      await f.reconcile(0);
      await f.repositories[0]!.removePersonalProjectRule(
        f.actors[0]!,
        manual.projectId,
        included.rule.inclusionId,
        { expectedVersion: manual.version }
      );
      await f.pair();
      await f.publish(0);
      await f.drain();
      await f.reconcile(1);
      expect(
        (await f.repositories[1]!.listNamedPersonalProjects(f.actors[1]!)).map(
          (project) => project.projectId
        )
      ).toEqual([manual.projectId]);
      expect(
        (
          await pools[1]!.query(
            "select state from personal_project_defaults where owner_user_id=$1",
            [f.actors[1]!.userId]
          )
        ).rows
      ).toEqual([{ state: "suppressed" }]);
      for (let i = 0; i < 2; i++) {
        const observed: PersonalFolderObservation = {
          identity: {
            folderId: `folder_${i}`,
            originatingDeploymentId: f.devices[i]!.deploymentId,
            originatingDeviceId: f.devices[i]!.deviceId,
            originatingProfileId: `profile_${i}`,
            directoryIncarnationId: `lifetime_${i}`
          },
          capturedPath: "/equal/notes",
          normalizedPath: "/equal/notes",
          observedAt: new Date().toISOString()
        };
        await f.repositories[i]!.createCapturedSession(f.actors[i]!, {
          externalSessionId: randomUUID(),
          folderObservation: observed,
          repositoryIdentity: {
            ...f.git(i),
            kind: "non_git_project",
            key: `ng_${i}`,
            root: "/equal/notes",
            reason: "non_git",
            selectedRemote: null,
            anchorDisplay: null
          }
        });
        await f.reconcile(i);
      }
      await f.publish(0);
      await f.publish(1);
      await f.drain();
      for (let i = 0; i < 2; i++) {
        const projects = await f.repositories[i]!.listNamedPersonalProjects(
          f.actors[i]!
        );
        expect(
          projects.filter((project) => project.name === "notes")
        ).toHaveLength(2);
        const ruleTargets = (
          await Promise.all(
            projects.map((project) =>
              f.repositories[i]!.listPersonalProjectRules(
                f.actors[i]!,
                project.projectId
              )
            )
          )
        )
          .flat()
          .map((rule) => rule.target);
        const folders = ruleTargets.filter(
          (target) => target.kind === "folder"
        );
        expect(
          new Set(folders.map((target) => target.folder.originatingDeviceId))
            .size
        ).toBe(2);
        expect(
          folders.every(
            (target) => target.folder.ownerUserId === f.actors[i]!.userId
          )
        ).toBe(true);
      }
    });
    it("keeps genuine concurrent seed-rule removal and explicit re-add in review", async () => {
      const f = await setup();
      await Promise.all([f.capture(0), f.capture(1)]);
      await Promise.all([f.reconcile(0), f.reconcile(1)]);
      const projectId = f.projectId();
      for (let i = 0; i < 2; i++) {
        const project = (
          await f.repositories[i]!.listNamedPersonalProjects(f.actors[i]!)
        )[0]!;
        const rule = (
          await f.repositories[i]!.listPersonalProjectRules(
            f.actors[i]!,
            projectId
          )
        )[0]!;
        const removed = await f.repositories[i]!.removePersonalProjectRule(
          f.actors[i]!,
          projectId,
          rule.inclusionId,
          { expectedVersion: project.version }
        );
        if (i === 0)
          await f.repositories[i]!.addPersonalProjectRepositoryRule(
            f.actors[i]!,
            projectId,
            { expectedVersion: removed.project.version, repository: f.git(i) }
          );
      }
      await f.pair();
      await f.publish(0);
      await f.publish(1);
      await f.drain();
      for (let i = 0; i < 2; i++) {
        const state = await f.repositories[i]!.getPersonalMembershipSyncState(
          f.actors[i]!,
          projectId
        );
        expect(state.catalog?.state).toBe("available");
        const rule = state.memberships.find(
          (entity) => entity.entityKind === "rule"
        )!;
        expect(rule.state).toBe("conflict");
        expect(rule.heads.map((head) => head.operation.kind).sort()).toEqual([
          "include",
          "remove_inclusion"
        ]);
        expect(rule.heads.every((head) => !head.automaticDefault)).toBe(true);
        await expect(
          f.repositories[i]!.addPersonalProjectRepositoryRule(
            f.actors[i]!,
            projectId,
            { expectedVersion: state.project.version, repository: f.git(i) }
          )
        ).rejects.toMatchObject({ code: "membership_review_required" });
      }
    });
    it("waits for verified source content, schedules defaults on readiness and correction, and denies an unrelated owner", async () => {
      const f = await setup();
      const source = await f.capture(0, "gr_pv06_arrival");
      await f.pair();
      const sourceClient = await pools[0]!.connect();
      try {
        await sourceClient.query("begin");
        await preparePersonalSourceContextSnapshot(sourceClient, {
          ownerUserId: f.actors[0]!.userId,
          localSessionId: source.id,
          originatingDeploymentId: f.devices[0]!.deploymentId,
          originatingDeviceId: f.devices[0]!.deviceId
        });
        await sourceClient.query("commit");
      } catch (error) {
        await sourceClient.query("rollback");
        throw error;
      } finally {
        sourceClient.release();
      }
      await f.publish(0);
      await f.drain();
      expect(
        (
          await pools[1]!.query<{ count: number }>(
            "select count(*)::int as count from sessions where owner_user_id=$1",
            [f.actors[1]!.userId]
          )
        ).rows[0]!.count
      ).toBe(0);
      await f.reconcile(1);
      expect(
        await f.repositories[1]!.listNamedPersonalProjects(f.actors[1]!)
      ).toEqual([]);
      const scope = {
        ...f.actors[0]!,
        groupId: f.fixture.groupId,
        authorDeviceId: f.devices[0]!.deviceId,
        authorSigningKeyId: f.devices[0]!.signingKeyId,
        originatingDeploymentId: f.devices[0]!.deploymentId,
        expectedEpoch: f.fixture.epoch,
        expectedAuthorityHead: f.fixture.authorityHead
      };
      const page =
        await f.repositories[0]!.personalConfiguration!.listPersonalConfigurationSourceSnapshots(
          scope
        );
      const snapshot = page.snapshots.find(
        (value) =>
          value.context.source.logicalSessionId === source.logicalSessionId
      )!;
      expect(snapshot).toBeDefined();
      const pkg = personalFixtureClosedSource({
        fixture: f.fixture,
        snapshot,
        externalSessionId: source.externalSessionId!,
        content: "PV06_VERIFIED_SOURCE_DECISION"
      });
      const imported = await receivePersonalFixtureClosedSource({
        fixture: f.fixture,
        repository: f.repositories[1]!,
        receiverUserId: f.actors[1]!.userId,
        encryption: f.encryption,
        pkg,
        beforeAvailable: async (id) => {
          expect(
            await f.repositories[1]!.getCapturedSession(f.actors[1]!, id)
          ).toBeNull();
          await f.reconcile(1);
          expect(
            await f.repositories[1]!.listNamedPersonalProjects(f.actors[1]!)
          ).toEqual([]);
        }
      });
      expect(
        (
          await pools[1]!.query<{ pending: boolean }>(
            "select pending from personal_project_default_reconciliation where owner_user_id=$1",
            [f.actors[1]!.userId]
          )
        ).rows[0]!.pending
      ).toBe(true);
      await f.reconcile(1);
      const originalId = f.projectId("gr_pv06_arrival");
      expect(
        (await f.repositories[1]!.listNamedPersonalProjects(f.actors[1]!)).map(
          (project) => project.projectId
        )
      ).toEqual([originalId]);
      await f.capture(0, "gr_pv06_corrected");
      const context = await f.repositories[0]!.getPersonalSourceContext(
        f.actors[0]!,
        source.id
      );
      const correction =
        await f.repositories[0]!.previewPersonalSourceCorrection(
          f.actors[0]!,
          source.id,
          {
            axis: "git",
            action: "set",
            repository: f.git(0, "gr_pv06_corrected"),
            expectedVersion: context.context.git.revision
          }
        );
      await f.repositories[0]!.applyPersonalSourceCorrection(
        f.actors[0]!,
        source.id,
        correction.preview.reviewId,
        { expectedVersion: context.context.git.revision }
      );
      await f.publish(0);
      await f.drain();
      expect(
        (
          await pools[1]!.query<{ pending: boolean }>(
            "select pending from personal_project_default_reconciliation where owner_user_id=$1",
            [f.actors[1]!.userId]
          )
        ).rows[0]!.pending
      ).toBe(true);
      await f.reconcile(1);
      const correctedId = f.projectId("gr_pv06_corrected");
      expect(
        (await f.repositories[1]!.listNamedPersonalProjects(f.actors[1]!)).map(
          (project) => project.projectId
        )
      ).toEqual(expect.arrayContaining([originalId, correctedId]));
      const selected = async (projectId: string) =>
        pools[1]!.query<{ id: string }>(
          `select s.id from sessions s where ${personalSourceSelectionSql("s", "$1", { inspection: true })}`,
          [
            {
              ownerUserId: f.actors[1]!.userId,
              searchDomain: "project",
              namedProjectId: projectId
            }
          ]
        );
      expect((await selected(originalId)).rows).toEqual([]);
      expect((await selected(correctedId)).rows.map((row) => row.id)).toEqual([
        imported.id
      ]);
      const outsider = {
        userId: (
          await f.repositories[1]!.createUser({
            email: `outsider-${randomUUID()}@example.test`
          })
        ).id
      };
      const packet = f.allPackets[0]!,
        record = f.decode(packet).record;
      const encrypted = (
        await pools[1]!.query<{ encrypted_envelope: unknown }>(
          "select encrypted_envelope from personal_configuration_records where owner_user_id=$1 limit 1",
          [f.actors[1]!.userId]
        )
      ).rows[0]!.encrypted_envelope;
      await expect(
        f.repositories[1]!.personalConfiguration!.retainPersonalConfiguration({
          ...outsider,
          groupId: f.fixture.groupId,
          record,
          encryptedEnvelope: encrypted,
          direction: "inbound",
          localDevice: {
            deviceId: f.devices[1]!.deviceId,
            signingKeyId: f.devices[1]!.signingKeyId,
            originatingDeploymentId: f.devices[1]!.deploymentId
          }
        })
      ).rejects.toThrow("PdsCryptoConfigurationGroupAuthorityError");
      expect(
        await f.repositories[1]!.listNamedPersonalProjects(outsider)
      ).toEqual([]);
      expect(
        await f.repositories[1]!.getCapturedSession(outsider, imported.id)
      ).toBeNull();
    });
  }
);
