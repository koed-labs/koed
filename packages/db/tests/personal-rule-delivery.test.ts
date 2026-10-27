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
  type PersonalConfigurationFeature,
  type PersonalGitContext
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
  "Personal rule and exclusion encrypted delivery",
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
    it("keeps exact rule scopes and conservative exclusions through offline edits, reviews, body arrival and replay", async () => {
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
      const features: PersonalConfigurationFeature[] = [
        "source_context_v1",
        "project_membership_v1"
      ];
      const { allPackets, advertise, config, scope, deliver, flush, selected } =
        createPersonalConfigurationDeliveryFixture(
          fixture,
          encryption,
          () => features
        );
      let originConfig = config(origin, fixture.origin, originRepo),
        receiverConfig = config(receiver, fixture.receiver, receiverRepo);

      await originRepo.upsertCapturePolicy(origin, {
        targetType: "global",
        captureState: "ask",
        visibility: "personal",
        pauseUntil: new Date(Date.now() + 3_600_000)
      });
      await receiverRepo.upsertCapturePolicy(receiver, {
        targetType: "global",
        captureState: "enabled",
        visibility: "personal"
      });
      await receiverRepo.upsertCapturePolicy(receiver, {
        targetType: "thread",
        threadId: "unrelated-paused-conversation",
        captureState: "disabled",
        pauseUntil: new Date(Date.now() + 3_600_000),
        visibility: "personal"
      });
      const captureRows = async (pool: pg.Pool, actor: typeof origin) =>
        (
          await pool.query<{ row: unknown }>(
            "select to_jsonb(p) row from capture_policies p where owner_user_id=$1 order by id",
            [actor.userId]
          )
        ).rows;
      const originCaptureBefore = await captureRows(originPool, origin),
        receiverCaptureBefore = await captureRows(receiverPool, receiver);
      const project = await originRepo.createNamedPersonalProject(origin, {
        name: "Rule delivery"
      });
      await flush(originConfig);
      const consumerTarget = {
        kind: "project" as const,
        project: { ownerUserId: receiver.userId, projectId: project.projectId }
      };
      const consumerStart =
        await receiverRepo.startPersonalSelectionEnumeration(receiver, {
          target: consumerTarget
        });
      expect(consumerStart.entries).toEqual([]);
      let consumerCursor = consumerStart.changeCursor!;
      const consumerKinds = new Set<string>();
      const reconcileConsumer = async (expected: string[]) => {
        let next = consumerCursor;
        for (;;) {
          const changes = await receiverRepo.reconcilePersonalSelectionChanges(
            receiver,
            { cursor: next }
          );
          expect(changes.events.length).toBeLessThanOrEqual(100);
          for (const event of changes.events) {
            expect(Object.keys(event).sort()).toEqual(["eventId", "kind"]);
            consumerKinds.add(event.kind);
          }
          expect(JSON.stringify(changes)).not.toContain(
            "RULE_DELIVERY_DECISION"
          );
          if (changes.nextCursor) {
            next = changes.nextCursor;
            continue;
          }
          break;
        }
        let page = await receiverRepo.startPersonalSelectionEnumeration(
          receiver,
          { target: consumerTarget }
        );
        const entries = [...page.entries];
        while (page.nextCursor) {
          page = await receiverRepo.continuePersonalSelectionEnumeration(
            receiver,
            { cursor: page.nextCursor }
          );
          entries.push(...page.entries);
        }
        expect(
          [
            ...new Set(entries.map((entry) => entry.source.localSessionId))
          ].sort()
        ).toEqual([...expected].sort());
        consumerCursor = page.changeCursor!;
        return entries;
      };
      const git: PersonalGitContext = {
        kind: "portable_repository",
        key: `gr_${randomUUID()}`,
        root: "/private/rule-repo",
        branch: "main",
        reason: "origin",
        checkoutId: randomUUID(),
        originatingDeviceId: fixture.origin.deviceId,
        selectedRemote: "origin",
        anchorDisplay: "example.test/rules"
      };
      const folderObservation = {
        identity: {
          folderId: randomUUID(),
          originatingDeploymentId: fixture.origin.deploymentId,
          originatingDeviceId: fixture.origin.deviceId,
          originatingProfileId: "rule-profile",
          directoryIncarnationId: randomUUID()
        },
        normalizedPath: "/private/rule-folder",
        capturedPath: "/private/rule-folder/.",
        observedAt: new Date().toISOString()
      };
      const source = await originRepo.createCapturedSession(origin, {
        externalSessionId: randomUUID(),
        repositoryIdentity: git,
        folderObservation
      });
      const originEvent = await originRepo.createMemoryEvent(origin, {
        sessionId: source.id,
        projectId: "legacy",
        visibility: "personal",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_message",
        content: "RULE_DELIVERY_DECISION",
        idempotencyKey: randomUUID()
      });
      const folder = {
        ownerUserId: origin.userId,
        ...folderObservation.identity
      };
      const version = async (repo: typeof originRepo, actor: typeof origin) =>
        (await repo.getPersonalMembershipSyncState(actor, project.projectId))
          .project.version;
      const gitRule = await originRepo.addPersonalProjectRepositoryRule(
        origin,
        project.projectId,
        { expectedVersion: await version(originRepo, origin), repository: git }
      );
      await originRepo.addPersonalProjectFolderRule(origin, project.projectId, {
        expectedVersion: gitRule.project.version,
        folder
      });
      await flush(originConfig);
      const localEqualPath = await receiverRepo.createCapturedSession(
        receiver,
        {
          externalSessionId: randomUUID(),
          repositoryIdentity: {
            ...git,
            key: `gr_${randomUUID()}`,
            originatingDeviceId: fixture.receiver.deviceId
          },
          folderObservation: {
            ...folderObservation,
            identity: {
              ...folderObservation.identity,
              originatingDeploymentId: fixture.receiver.deploymentId,
              originatingDeviceId: fixture.receiver.deviceId,
              directoryIncarnationId: randomUUID()
            }
          }
        }
      );
      const remoteRules = await receiverRepo.listPersonalProjectRules(
        receiver,
        project.projectId
      );
      expect(remoteRules).toHaveLength(2);
      expect(
        remoteRules.find((r) => r.target.kind === "folder")!.target
      ).toEqual({
        kind: "folder",
        folder: { ...folder, ownerUserId: receiver.userId }
      });
      expect(
        (await selected(receiverPool, receiver, project.projectId)).rows
      ).toHaveLength(0);
      // No path or Git root is present in the encrypted outer package.
      expect(JSON.stringify(allPackets)).not.toContain(
        folderObservation.normalizedPath
      );
      expect(JSON.stringify(allPackets)).not.toContain(git.root);
      // Exclusion reaches the peer before its source; no native exclusion or Session may be fabricated.
      await originRepo.excludePersonalProjectSession(
        origin,
        project.projectId,
        {
          sessionId: source.id,
          expectedVersion: await version(originRepo, origin)
        }
      );
      const sourceSnapshot = (
        await originRepo.personalConfiguration!.listPersonalConfigurationSourceSnapshots(
          scope(origin, fixture.origin)
        )
      ).snapshots.find(
        (s) => s.context.source.logicalSessionId === source.logicalSessionId
      )!;
      const sourcePackage = personalFixtureClosedSource({
        fixture,
        snapshot: sourceSnapshot,
        externalSessionId: source.externalSessionId!,
        content: "RULE_DELIVERY_DECISION"
      });
      const bodyBefore = sourceSnapshot.context;
      await flush(originConfig);
      const missing = await receiverRepo.getPersonalMembershipSyncState(
        receiver,
        project.projectId
      );
      expect(
        missing.memberships.find((e) => e.entityKind === "exclusion")!.source
          ?.ready
      ).toBe(false);
      expect(
        (
          await receiverPool.query(
            "select 1 from personal_project_exclusions where owner_user_id=$1",
            [receiver.userId]
          )
        ).rowCount
      ).toBe(0);
      const remote = await receivePersonalFixtureClosedSource({
        fixture,
        repository: receiverRepo,
        receiverUserId: receiver.userId,
        encryption,
        pkg: sourcePackage,
        beforeAvailable: async () =>
          expect(
            (await selected(receiverPool, receiver, project.projectId)).rows
          ).toHaveLength(0)
      });
      await reconcileConsumer([]);
      // The body is now verified, but native exclusion projection has not run yet.
      expect(
        (
          await receiverPool.query(
            "select 1 from personal_project_exclusions where owner_user_id=$1",
            [receiver.userId]
          )
        ).rowCount
      ).toBe(0);
      expect(
        (await selected(receiverPool, receiver, project.projectId)).rows
      ).toHaveLength(0);
      const denied = await receiverRepo.explainPersonalProjectSession(
        receiver,
        project.projectId,
        {
          sessionId: remote.id,
          expectedVersion: await version(receiverRepo, receiver)
        }
      );
      expect(denied.explanation).toMatchObject({
        included: false,
        exclusion: null,
        syncExclusion: { blocked: true, state: "available" }
      });
      await flush(receiverConfig);
      const back = await receiverRepo.explainPersonalProjectSession(
        receiver,
        project.projectId,
        {
          sessionId: remote.id,
          expectedVersion: await version(receiverRepo, receiver)
        }
      );
      const exclusion = back.explanation!.exclusion!;
      await receiverRepo.restorePersonalProjectSession(
        receiver,
        project.projectId,
        {
          sessionId: remote.id,
          expectedVersion: back.project.version,
          exclusionId: exclusion.exclusionId,
          expectedExclusionRevisionId: exclusion.headRevisionId
        }
      );
      expect(
        (await selected(receiverPool, receiver, project.projectId)).rows.map(
          (s) => s.id
        )
      ).toEqual([remote.id]);
      const consumerIncluded = await reconcileConsumer([remote.id]);
      expect(
        consumerIncluded.every(
          (entry) =>
            entry.source.identityState === "verified" &&
            entry.source.portable?.ownerUserId === receiver.userId &&
            entry.source.portable.originatingDeviceId ===
              fixture.origin.deviceId
        )
      ).toBe(true);
      expect(
        new Set(consumerIncluded.map((entry) => entry.reason.kind))
      ).toEqual(new Set(["repository", "folder", "session"]));
      // Materialization readiness can change without source or membership edits.
      await receiverPool.query(
        "update pds_logical_replicas set materialization_state='stale' where owner_user_id=$1 and local_session_id=$2",
        [receiver.userId, remote.id]
      );
      await reconcileConsumer([]);
      await receiverPool.query(
        "update pds_logical_replicas set materialization_state='ready' where owner_user_id=$1 and local_session_id=$2",
        [receiver.userId, remote.id]
      );
      await reconcileConsumer([remote.id]);
      await flush(receiverConfig);
      expect(
        (await selected(originPool, origin, project.projectId)).rows.map(
          (s) => s.id
        )
      ).toEqual([source.id]);
      expect(
        (
          await receiverRepo.explainPersonalProjectSession(
            receiver,
            project.projectId,
            {
              sessionId: remote.id,
              expectedVersion: await version(receiverRepo, receiver)
            }
          )
        ).explanation!.reasons
      ).toHaveLength(3);
      expect(
        (await selected(receiverPool, receiver, project.projectId)).rows.map(
          (s) => s.id
        )
      ).not.toContain(localEqualPath.id);

      // Independent adds retain different display context for the same canonical scope.
      const independentGit = { ...git, key: `gr_${randomUUID()}` };
      await originRepo.addPersonalProjectRepositoryRule(
        origin,
        project.projectId,
        {
          expectedVersion: await version(originRepo, origin),
          repository: independentGit
        }
      );
      await receiverRepo.addPersonalProjectRepositoryRule(
        receiver,
        project.projectId,
        {
          expectedVersion: await version(receiverRepo, receiver),
          repository: {
            ...independentGit,
            root: "/peer/checkout",
            branch: "peer"
          }
        }
      );
      // Same-rule offline remove/re-add conflicts deny that reason until an exact review.
      const remoteGit = (
        await receiverRepo.listPersonalProjectRules(receiver, project.projectId)
      ).find((r) => r.target.kind === "repository")!;
      await originRepo.removePersonalProjectRule(
        origin,
        project.projectId,
        gitRule.rule.inclusionId,
        { expectedVersion: await version(originRepo, origin) }
      );
      await receiverRepo.removePersonalProjectRule(
        receiver,
        project.projectId,
        remoteGit.inclusionId,
        { expectedVersion: await version(receiverRepo, receiver) }
      );
      await receiverRepo.addPersonalProjectRepositoryRule(
        receiver,
        project.projectId,
        {
          expectedVersion: await version(receiverRepo, receiver),
          repository: { ...git, root: "/other/checkout", branch: "offline" }
        }
      );
      await flush(originConfig);
      await flush(receiverConfig);
      let state = await receiverRepo.getPersonalMembershipSyncState(
        receiver,
        project.projectId
      );
      const conflicted = state.memberships.find(
        (e) =>
          e.entityKind === "rule" &&
          e.state === "conflict" &&
          e.ruleCandidates?.some(
            (c) =>
              c.operation.kind === "include" &&
              c.operation.selector.kind === "repository" &&
              c.operation.selector.repository.key === git.key
          )
      )!;
      expect(conflicted).toBeDefined();
      expect(conflicted.ruleCandidates).toHaveLength(1);
      await expect(
        receiverRepo.addPersonalProjectRepositoryRule(
          receiver,
          project.projectId,
          { expectedVersion: state.project.version, repository: git }
        )
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        receiverRepo.previewPersonalMembershipReview(
          receiver,
          project.projectId,
          {
            entityId: conflicted.entityId,
            expectedVersion: state.project.version,
            expectedHeads: conflicted.heads.map((h) => h.revisionId),
            change: {
              kind: "include",
              candidateRevisionId: "unreviewed_revision"
            }
          }
        )
      ).rejects.toMatchObject({ statusCode: 400 });
      const reviewRule = () =>
        receiverRepo.previewPersonalMembershipReview(
          receiver,
          project.projectId,
          {
            entityId: conflicted.entityId,
            expectedVersion: state.project.version,
            expectedHeads: conflicted.heads.map((h) => h.revisionId),
            change: {
              kind: "include",
              candidateRevisionId: conflicted.ruleCandidates![0]!.revisionId
            }
          }
        );
      const stale = await reviewRule();
      await receiverRepo.updateNamedPersonalProject(
        receiver,
        project.projectId,
        { name: "Rule reviewed", expectedVersion: state.project.version }
      );
      await expect(
        receiverRepo.applyPersonalMembershipReview(
          receiver,
          project.projectId,
          stale.preview.reviewId,
          { expectedVersion: stale.preview.expectedVersion }
        )
      ).rejects.toMatchObject({ statusCode: 409 });
      state = await receiverRepo.getPersonalMembershipSyncState(
        receiver,
        project.projectId
      );
      const resolved = await reviewRule();
      await receiverRepo.applyPersonalMembershipReview(
        receiver,
        project.projectId,
        resolved.preview.reviewId,
        { expectedVersion: resolved.preview.expectedVersion }
      );
      await flush(receiverConfig);
      expect(
        (
          await originRepo.getPersonalMembershipSyncState(
            origin,
            project.projectId
          )
        ).memberships.find((e) => e.entityId === conflicted.entityId)!.state
      ).toBe("available");

      state = await receiverRepo.getPersonalMembershipSyncState(
        receiver,
        project.projectId
      );
      const independentConflict = state.memberships.find(
        (e) => e.entityKind === "rule" && e.state === "conflict"
      )!;
      expect(independentConflict.ruleCandidates).toHaveLength(2);
      await expect(
        receiverRepo.previewPersonalMembershipReview(
          receiver,
          project.projectId,
          {
            entityId: independentConflict.entityId,
            expectedVersion: state.project.version,
            expectedHeads: independentConflict.heads.map((h) => h.revisionId),
            change: { kind: "include" }
          }
        )
      ).rejects.toMatchObject({ statusCode: 400 });
      const chosen = await receiverRepo.previewPersonalMembershipReview(
        receiver,
        project.projectId,
        {
          entityId: independentConflict.entityId,
          expectedVersion: state.project.version,
          expectedHeads: independentConflict.heads.map((h) => h.revisionId),
          change: {
            kind: "include",
            candidateRevisionId:
              independentConflict.ruleCandidates![1]!.revisionId
          }
        }
      );
      await receiverRepo.applyPersonalMembershipReview(
        receiver,
        project.projectId,
        chosen.preview.reviewId,
        { expectedVersion: chosen.preview.expectedVersion }
      );
      await flush(receiverConfig);

      // Exclude versus clear-exclusion on the same causal frontier fails closed.
      const excludeAgain = await originRepo.excludePersonalProjectSession(
        origin,
        project.projectId,
        {
          sessionId: source.id,
          expectedVersion: await version(originRepo, origin)
        }
      );
      await flush(originConfig);
      const remoteExcluded = await receiverRepo.explainPersonalProjectSession(
        receiver,
        project.projectId,
        {
          sessionId: remote.id,
          expectedVersion: await version(receiverRepo, receiver)
        }
      );
      await receiverRepo.restorePersonalProjectSession(
        receiver,
        project.projectId,
        {
          sessionId: remote.id,
          expectedVersion: remoteExcluded.project.version,
          exclusionId: remoteExcluded.explanation!.exclusion!.exclusionId,
          expectedExclusionRevisionId:
            remoteExcluded.explanation!.exclusion!.headRevisionId
        }
      );
      await originRepo.restorePersonalProjectSession(
        origin,
        project.projectId,
        {
          sessionId: source.id,
          expectedVersion: excludeAgain.project.version,
          exclusionId: excludeAgain.explanation!.exclusion!.exclusionId,
          expectedExclusionRevisionId:
            excludeAgain.explanation!.exclusion!.headRevisionId
        }
      );
      await originRepo.excludePersonalProjectSession(
        origin,
        project.projectId,
        {
          sessionId: source.id,
          expectedVersion: await version(originRepo, origin)
        }
      );
      await flush(originConfig);
      await flush(receiverConfig);
      state = await receiverRepo.getPersonalMembershipSyncState(
        receiver,
        project.projectId
      );
      const conflictExclusion = state.memberships.find(
        (e) => e.entityKind === "exclusion"
      )!;
      expect(conflictExclusion.state).toBe("conflict");
      expect(
        (await selected(receiverPool, receiver, project.projectId)).rows
      ).toHaveLength(0);
      expect(
        (await selected(originPool, origin, project.projectId)).rows
      ).toHaveLength(0);
      const direct = state.memberships.find((e) => e.entityKind === "direct")!;
      const blockedPreview = await receiverRepo.previewPersonalMembershipReview(
        receiver,
        project.projectId,
        {
          entityId: direct.entityId,
          expectedVersion: state.project.version,
          expectedHeads: direct.heads.map((h) => h.revisionId),
          change: { kind: "include" }
        }
      );
      expect(blockedPreview.preview.effect).toMatchObject({
        sourceReady: true,
        blockedByExclusion: true,
        included: false
      });
      const clear = await receiverRepo.previewPersonalMembershipReview(
        receiver,
        project.projectId,
        {
          entityId: conflictExclusion.entityId,
          expectedVersion: state.project.version,
          expectedHeads: conflictExclusion.heads.map((h) => h.revisionId),
          change: { kind: "clear_exclusion" }
        }
      );
      await receiverRepo.applyPersonalMembershipReview(
        receiver,
        project.projectId,
        clear.preview.reviewId,
        { expectedVersion: clear.preview.expectedVersion }
      );
      await expect(
        receiverRepo.applyPersonalMembershipReview(
          receiver,
          project.projectId,
          blockedPreview.preview.reviewId,
          { expectedVersion: blockedPreview.preview.expectedVersion }
        )
      ).rejects.toMatchObject({ statusCode: 409 });
      await flush(receiverConfig);
      expect(
        (await selected(receiverPool, receiver, project.projectId)).rows.map(
          (s) => s.id
        )
      ).toEqual([remote.id]);
      expect(
        (await selected(originPool, origin, project.projectId)).rows.map(
          (s) => s.id
        )
      ).toEqual([source.id]);
      const projected = await receiverRepo.projectPendingConversationItems(
        receiver,
        { limit: 100 }
      );
      expect(projected.memoryEventsCreated).toBeGreaterThan(0);
      const vector = Array.from({ length: 1024 }, (_, index) =>
        index === 0 ? 1 : 0
      );
      vi.stubEnv("EMBEDDING_SERVICE_URL", "http://rule.fixture");
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
      for (const [repo, ids] of [
        [originRepo, [originEvent.id]],
        [receiverRepo, projected.memoryEventIds]
      ] as const)
        for (const id of ids)
          await repo.upsertSourceEmbedding({
            source: (await repo.getEmbeddableSource("memory_event", id))!,
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
      const recall = async (repo: typeof originRepo, actor: typeof origin) =>
        (
          await createMemoryEngine(repo).searchMemory({
            requesterContext: actor,
            scope: "personal",
            query: "RULE_DELIVERY_DECISION",
            retrievalStage: "raw_fallback_search",
            limit: 20,
            personalSelection: {
              version: 1,
              ownerUserId: actor.userId,
              target: {
                kind: "project",
                project: {
                  ownerUserId: actor.userId,
                  projectId: project.projectId
                }
              },
              callerRepositoryContext: null
            }
          })
        ).results.map((r) => r.sourceId);
      expect(await recall(originRepo, origin)).toEqual([originEvent.id]);
      expect(await recall(receiverRepo, receiver)).toEqual(
        projected.memoryEventIds
      );
      // Remove direct intent so subsequent eligibility depends only on dynamic rules.
      const directRow = (
        await originRepo.listPersonalProjectMemberships(
          origin,
          project.projectId
        )
      ).find((r) => r.logicalSessionId === source.logicalSessionId)!;
      await originRepo.removePersonalProjectInclusion(
        origin,
        project.projectId,
        directRow.inclusionId,
        { expectedVersion: await version(originRepo, origin) }
      );
      await flush(originConfig);
      const correct = async (
        axis: "git" | "folder",
        action: "unresolved" | "reset",
        expectedVersion: number
      ) => {
        const review = await originRepo.previewPersonalSourceCorrection(
          origin,
          source.id,
          { axis, action, expectedVersion }
        );
        await originRepo.applyPersonalSourceCorrection(
          origin,
          source.id,
          review.preview.reviewId,
          { expectedVersion }
        );
        await flush(originConfig);
      };
      await correct("git", "unresolved", 1);
      expect(await recall(receiverRepo, receiver)).toEqual(
        projected.memoryEventIds
      );
      await correct("folder", "unresolved", 1);
      expect(await recall(originRepo, origin)).toHaveLength(0);
      expect(await recall(receiverRepo, receiver)).toHaveLength(0);
      await correct("git", "reset", 2);
      expect(await recall(receiverRepo, receiver)).toEqual(
        projected.memoryEventIds
      );
      await correct("folder", "reset", 2);
      expect(
        (await originRepo.getPersonalSourceContext(origin, source.id)).context
          .git.original
      ).toEqual(bodyBefore.git.original);
      expect(bodyBefore.folder.original.state).toBe("known");
      if (bodyBefore.folder.original.state !== "known")
        throw new Error("Expected observed Folder");
      expect(
        (await receiverRepo.getPersonalSourceContext(receiver, remote.id))
          .context.folder.original
      ).toEqual({
        ...bodyBefore.folder.original,
        value: {
          ...bodyBefore.folder.original.value,
          reference: {
            ...bodyBefore.folder.original.value.reference,
            ownerUserId: receiver.userId
          }
        }
      });
      // Retained rule removals survive process restart.
      for (const rule of await originRepo.listPersonalProjectRules(
        origin,
        project.projectId
      ))
        await originRepo.removePersonalProjectRule(
          origin,
          project.projectId,
          rule.inclusionId,
          { expectedVersion: await version(originRepo, origin) }
        );
      await flush(originConfig);
      expect(await recall(originRepo, origin)).toHaveLength(0);
      expect(await recall(receiverRepo, receiver)).toHaveLength(0);
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
      await flush(originConfig);
      await flush(receiverConfig);
      expect(await recall(originRepo, origin)).toHaveLength(0);
      expect(await recall(receiverRepo, receiver)).toHaveLength(0);
      await reconcileConsumer([]);
      expect(consumerKinds).toEqual(
        new Set(["source", "membership", "source_context", "availability"])
      );
      // Replaying all earlier encrypted packets cannot revive a removed rule or exclusion.
      for (const pkg of allPackets) await deliver(pkg);
      expect(
        (await selected(receiverPool, receiver, project.projectId)).rows.map(
          (s) => s.id
        )
      ).toEqual([]);
      const sourceAfter = (
        await originRepo.personalConfiguration!.listPersonalConfigurationSourceSnapshots(
          scope(origin, fixture.origin)
        )
      ).snapshots.find(
        (s) => s.context.source.logicalSessionId === source.logicalSessionId
      )!;
      expect(sourceAfter.context.git.original).toEqual(bodyBefore.git.original);
      expect(sourceAfter.context.folder.original).toEqual(
        bodyBefore.folder.original
      );
      expect(await captureRows(originPool, origin)).toEqual(
        originCaptureBefore
      );
      expect(await captureRows(receiverPool, receiver)).toEqual(
        receiverCaptureBefore
      );
      expect(advertise).toHaveBeenCalledWith([
        "source_context_v1",
        "project_membership_v1",
        "project_defaults_v1"
      ]);
    }, 120_000);
  }
);
