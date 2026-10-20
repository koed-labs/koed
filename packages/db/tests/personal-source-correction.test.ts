import { randomUUID } from "node:crypto";
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
import { createMemoryEngine } from "@koed/core";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  type PersonalFolderObservation,
  type PersonalSelectionSnapshot,
  repositoryScopeId,
  type PersonalSourceCorrectionInput,
  type PersonalGitContext
} from "@koed/shared";
import {
  createDbPool,
  runDbMigrations,
  createMemorySourceRepository
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const options = {
  envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 94).toString("base64")
  )
};
const folder = (
  path: string,
  identity: Partial<PersonalFolderObservation["identity"]> = {}
): PersonalFolderObservation => ({
  identity: {
    folderId: randomUUID(),
    originatingDeploymentId: "deployment",
    originatingDeviceId: "device",
    originatingProfileId: "profile",
    directoryIncarnationId: randomUUID(),
    ...identity
  },
  normalizedPath: path,
  capturedPath: `${path}/.`,
  observedAt: new Date().toISOString()
});
const git: PersonalGitContext = {
  kind: "portable_repository",
  key: "gr_folder_rule",
  root: "/repo",
  branch: "main",
  reason: "origin",
  checkoutId: "checkout",
  originatingDeviceId: "device",
  selectedRemote: "origin",
  anchorDisplay: "example.test/repo"
};
type Selection = Extract<PersonalSelectionSnapshot, { version: 1 }>;
const selected = (ownerUserId: string, projectId: string): Selection => ({
  version: 1,
  ownerUserId,
  target: { kind: "project", project: { ownerUserId, projectId } },
  callerRepositoryContext: null
});

describe.skipIf(!databaseUrl)(
  "reviewed Personal source corrections in PostgreSQL",
  () => {
    let pool: pg.Pool;
    beforeAll(async () => {
      pool = createDbPool({ connectionString: databaseUrl });
      await runDbMigrations(pool);
    });
    afterAll(async () => {
      await pool?.end();
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
    const user = async () => ({
      userId: (
        await createMemorySourceRepository(pool, options).createUser({
          email: `correction-${randomUUID()}@example.test`
        })
      ).id
    });
    it("corrects Git and Folder independently across rules, raw and derived recall while retaining original and direct membership", async () => {
      const repo = createMemorySourceRepository(pool, options),
        actor = await user(),
        other = await user();
      const folderA = folder("/repo/a"),
        folderB = folder("/repo/b"),
        gitA = { ...git, key: "gr_correction_a" },
        gitB = {
          ...git,
          key: "gr_correction_b",
          anchorDisplay: "example.test/b"
        };
      const refA = { ...folderA.identity, ownerUserId: actor.userId },
        refB = { ...folderB.identity, ownerUserId: actor.userId };
      const external = randomUUID();
      const source = await repo.createCapturedSession(actor, {
        externalSessionId: external,
        repositoryIdentity: gitA,
        folderObservation: folderA
      });
      await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        repositoryIdentity: gitB,
        folderObservation: folderB
      });
      const event = await repo.createMemoryEvent(actor, {
        projectId: "legacy",
        sessionId: source.id,
        actor: "user",
        visibility: "personal",
        eventType: "captured",
        rawEventType: "user_message",
        content: "CORRECTION_DECISION",
        idempotencyKey: randomUUID()
      });
      const node = await repo.createMemoryNode(actor, {
        visibility: "personal",
        summaryText: "CORRECTION_SUMMARY",
        sourceHash: randomUUID()
      });
      await pool.query(
        "update memory_nodes set source_event_count=1,lcm_algorithm_version='fixture' where id=$1",
        [node.id]
      );
      await pool.query(
        "insert into memory_node_sources(memory_node_id,memory_event_id,source_order) values($1,$2,0)",
        [node.id, event.id]
      );
      await repo.updateLcmNodeSummary({
        nodeId: node.id,
        summaryText: "CORRECTION_SUMMARY",
        summaryModel: "fixture-client",
        summaryTokenEstimate: 8,
        summaryPromptVersion: "fixture",
        summaryStructuredJson: {
          schema_version: "lcm-semantic-summary-v1",
          title: "Correction",
          summary_text: "CORRECTION_SUMMARY",
          lexical_anchors: []
        },
        summaryStructuredSchemaVersion: "lcm-semantic-summary-v1"
      });
      const vector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
      vi.stubEnv("EMBEDDING_SERVICE_URL", "http://correction.fixture");
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
      for (const [type, id] of [
        ["memory_event", event.id],
        ["memory_node", node.id]
      ] as const)
        await repo.upsertSourceEmbedding({
          source: (await repo.getEmbeddableSource(type, id))!,
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
      const proposal = await repo.createCuratedMemoryProposal(actor, {
        proposedClaim: "CORRECTION_CLAIM",
        evidenceMemoryEventIds: [event.id]
      });
      const curated = await repo.processCuratedMemoryProposal(actor, {
        proposalId: proposal.id,
        decision: "store",
        assertion: {
          assertionText: "CORRECTION_CLAIM",
          sources: [
            {
              sourceType: "memory_event",
              sourceRole: "primary_evidence",
              memoryEventId: event.id
            }
          ]
        }
      });
      const directProject = await repo.createNamedPersonalProject(actor, {
        name: "Direct"
      });
      const direct = await repo.addPersonalProjectSession(
        actor,
        directProject.projectId,
        { sessionId: source.id, expectedVersion: directProject.version }
      );
      const gitProject = await repo.createNamedPersonalProject(actor, {
        name: "Git A"
      });
      await repo.addPersonalProjectRepositoryRule(actor, gitProject.projectId, {
        repository: gitA,
        expectedVersion: gitProject.version
      });
      const folderProject = await repo.createNamedPersonalProject(actor, {
        name: "Folder B"
      });
      await repo.addPersonalProjectFolderRule(actor, folderProject.projectId, {
        folder: refB,
        expectedVersion: folderProject.version
      });
      const directBefore = await repo.listPersonalProjectMemberships(
        actor,
        directProject.projectId
      );
      const original = (await repo.getPersonalSourceContext(actor, source.id))
        .context;
      const pick = (target: Selection["target"]): Selection => ({
        version: 1,
        ownerUserId: actor.userId,
        target,
        callerRepositoryContext: null
      });
      const recall = async (
        target: Selection["target"],
        stage: "raw_fallback_search" | "leaf_search" = "raw_fallback_search"
      ) =>
        (
          await createMemoryEngine(repo).searchMemory({
            requesterContext: actor,
            scope: "personal",
            query: "CORRECTION_DECISION",
            personalSelection: pick(target),
            retrievalStage: stage,
            limit: 20
          })
        ).results.map((r) => r.sourceId);
      const preview = await repo.previewPersonalSourceCorrection(
        actor,
        source.id,
        {
          axis: "git",
          action: "set",
          repository: { ...gitB, root: "/caller/invented" },
          expectedVersion: 1
        }
      );
      expect(
        (await repo.getPersonalSourceContext(actor, source.id)).context
      ).toEqual(original);
      expect(preview.preview.after.git).toMatchObject({
        revision: 2,
        original: original.git.original,
        correction: {
          state: "corrected",
          value: { state: "known", value: gitB }
        }
      });
      expect(
        preview.preview.projects.find(
          (p) => p.projectId === gitProject.projectId
        )
      ).toMatchObject({ beforeIncluded: true, afterIncluded: false });
      expect(
        preview.preview.projects.find(
          (p) => p.projectId === directProject.projectId
        )
      ).toMatchObject({ beforeIncluded: true, afterIncluded: true });
      await expect(
        repo.applyPersonalSourceCorrection(
          other,
          source.id,
          preview.preview.reviewId,
          { expectedVersion: 1 }
        )
      ).rejects.toMatchObject({ statusCode: 404 });
      const applied = await repo.applyPersonalSourceCorrection(
        actor,
        source.id,
        preview.preview.reviewId,
        { expectedVersion: 1 }
      );
      expect(applied.context.folder).toEqual(original.folder);
      expect(
        await repo.applyPersonalSourceCorrection(
          actor,
          source.id,
          preview.preview.reviewId,
          { expectedVersion: 1 }
        )
      ).toEqual(applied);
      expect(await recall({ kind: "repository", repository: gitA })).toEqual(
        []
      );
      expect(await recall({ kind: "repository", repository: gitB })).toEqual([
        event.id
      ]);
      expect(
        await recall({ kind: "repository", repository: gitB }, "leaf_search")
      ).toEqual([node.id]);
      expect(await recall({ kind: "folder", folder: refA })).toEqual([
        event.id
      ]);
      expect(await recall({ kind: "folder", folder: refB })).toEqual([]);
      expect(
        await recall(selected(actor.userId, gitProject.projectId).target)
      ).toEqual([]);
      expect(
        await recall(selected(actor.userId, directProject.projectId).target)
      ).toEqual([event.id]);
      expect(
        await repo.searchCuratedMemoryAssertions(actor, {
          query: "CORRECTION_CLAIM",
          personalSelection: pick({ kind: "repository", repository: gitA })
        })
      ).toEqual([]);
      expect(
        (
          await repo.expandMemoryNode(curated.assertionId!, actor, {
            personalSelection: pick({ kind: "repository", repository: gitB })
          })
        ).sources.map((row) => row.id)
      ).toEqual([event.id]);
      const global = await repo.listLcmGraphThreads(actor, {
        personalSelection: pick({ kind: "global" }),
        groupBySession: true
      });
      expect(
        global
          .find((project) => project.id === repositoryScopeId(gitB))
          ?.threads.map((t) => t.sessionId)
      ).toContain(source.id);
      const correct = async (input: PersonalSourceCorrectionInput) => {
        const review = await repo.previewPersonalSourceCorrection(
          actor,
          source.id,
          input
        );
        return repo.applyPersonalSourceCorrection(
          actor,
          source.id,
          review.preview.reviewId,
          { expectedVersion: input.expectedVersion }
        );
      };
      const folderChanged = await correct({
        axis: "folder",
        action: "set",
        folder: refB,
        expectedVersion: 1
      });
      expect(folderChanged.context.git).toEqual(applied.context.git);
      expect(folderChanged.context.folder).toMatchObject({
        revision: 2,
        original: original.folder.original
      });
      expect(await recall({ kind: "folder", folder: refA })).toEqual([]);
      expect(
        await recall({ kind: "folder", folder: refB }, "leaf_search")
      ).toEqual([node.id]);
      expect(
        await recall(selected(actor.userId, folderProject.projectId).target)
      ).toEqual([event.id]);
      const continued = await repo.createCapturedSession(actor, {
        externalSessionId: external,
        repositoryIdentity: gitA,
        folderObservation: folderA,
        currentFolderObservation: folderA
      });
      expect(continued.id).toBe(source.id);
      expect(
        (await repo.getPersonalSourceContext(actor, source.id)).context
      ).toEqual(folderChanged.context);
      const unresolved = await correct({
        axis: "git",
        action: "unresolved",
        expectedVersion: 2
      });
      expect(unresolved.context.git.correction).toMatchObject({
        state: "corrected",
        value: { state: "unresolved", reason: "explicit_unresolved" }
      });
      expect(await recall({ kind: "repository", repository: gitA })).toEqual(
        []
      );
      expect(await recall({ kind: "repository", repository: gitB })).toEqual(
        []
      );
      expect(await recall({ kind: "folder", folder: refB })).toEqual([
        event.id
      ]);
      expect(await recall({ kind: "global" })).toEqual([event.id]);
      await correct({
        axis: "folder",
        action: "unresolved",
        expectedVersion: 2
      });
      expect(await recall({ kind: "folder", folder: refA })).toEqual([]);
      expect(await recall({ kind: "folder", folder: refB })).toEqual([]);
      expect(
        await recall(
          selected(actor.userId, directProject.projectId).target,
          "leaf_search"
        )
      ).toEqual([node.id]);
      await correct({ axis: "git", action: "reset", expectedVersion: 3 });
      const reset = await correct({
        axis: "folder",
        action: "reset",
        expectedVersion: 3
      });
      expect(reset.context.git.original).toEqual(original.git.original);
      expect(reset.context.git.correction).toEqual({ state: "original" });
      expect(reset.context.folder).toEqual({ ...original.folder, revision: 4 });
      expect(await recall({ kind: "repository", repository: gitA })).toEqual([
        event.id
      ]);
      expect(
        await recall({ kind: "folder", folder: refA }, "leaf_search")
      ).toEqual([node.id]);
      expect(
        await repo.listPersonalProjectMemberships(
          actor,
          directProject.projectId
        )
      ).toEqual(directBefore);
      expect(reset.context.logicalSessionId).toBe(original.logicalSessionId);
      expect(directBefore[0]!.inclusionId).toBe(direct.membership.inclusionId);
      const audit = await pool.query<{
        axis: string;
        version: number;
        value: { context: unknown };
      }>(
        "select axis,version,value from personal_source_context_changes where owner_user_id=$1 and logical_session_id=$2 order by sequence",
        [actor.userId, source.logicalSessionId]
      );
      expect(audit.rows.map((r) => [r.axis, r.version])).toEqual([
        ["git", 2],
        ["folder", 2],
        ["git", 3],
        ["folder", 3],
        ["git", 4],
        ["folder", 4]
      ]);
      await expect(
        repo.applyPersonalSourceCorrection(
          actor,
          source.id,
          preview.preview.reviewId,
          { expectedVersion: 1 }
        )
      ).rejects.toMatchObject({ statusCode: 409 });
    });
    it("rejects stale Project effects, foreign or unknown targets and preserves historical unresolved facts on reset", async () => {
      const repo = createMemorySourceRepository(pool, options),
        actor = await user(),
        other = await user();
      const observed = folder("/recorded"),
        ref = { ...observed.identity, ownerUserId: actor.userId };
      await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        repositoryIdentity: git,
        folderObservation: observed
      });
      const source = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        importObservedAt: new Date().toISOString(),
        cwd: "/recorded"
      });
      const initial = (await repo.getPersonalSourceContext(actor, source.id))
        .context;
      expect(initial.git.original).toMatchObject({
        state: "unresolved",
        reason: "historical_unresolved"
      });
      expect(initial.folder.original).toEqual({
        state: "unresolved",
        reason: "historical_unresolved"
      });
      await expect(
        repo.previewPersonalSourceCorrection(actor, source.id, {
          axis: "folder",
          action: "set",
          folder: { ...ref, ownerUserId: other.userId },
          expectedVersion: 1
        })
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        repo.previewPersonalSourceCorrection(actor, source.id, {
          axis: "git",
          action: "set",
          repository: { ...git, key: "gr_unknown" },
          expectedVersion: 1
        })
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        repo.previewPersonalSourceCorrection(actor, source.id, {
          axis: "folder",
          action: "set",
          folder: { ...ref, folderId: "unknown" },
          expectedVersion: 1
        })
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        repo.previewPersonalSourceCorrection(actor, source.id, {
          axis: "git",
          action: "reset",
          expectedVersion: 2
        })
      ).rejects.toMatchObject({ statusCode: 409 });
      const pending = await repo.previewPersonalSourceCorrection(
        actor,
        source.id,
        { axis: "git", action: "set", repository: git, expectedVersion: 1 }
      );
      await repo.createNamedPersonalProject(actor, {
        name: "Changed after preview"
      });
      await expect(
        repo.applyPersonalSourceCorrection(
          actor,
          source.id,
          pending.preview.reviewId,
          { expectedVersion: 1 }
        )
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(
        (await repo.getPersonalSourceContext(actor, source.id)).context
      ).toEqual(initial);
      for (const axis of ["git", "folder"] as const) {
        const review = await repo.previewPersonalSourceCorrection(
          actor,
          source.id,
          axis === "git"
            ? { axis, action: "set", repository: git, expectedVersion: 1 }
            : { axis, action: "set", folder: ref, expectedVersion: 1 }
        );
        await repo.applyPersonalSourceCorrection(
          actor,
          source.id,
          review.preview.reviewId,
          { expectedVersion: 1 }
        );
        const reset = await repo.previewPersonalSourceCorrection(
          actor,
          source.id,
          { axis, action: "reset", expectedVersion: 2 }
        );
        await repo.applyPersonalSourceCorrection(
          actor,
          source.id,
          reset.preview.reviewId,
          { expectedVersion: 2 }
        );
      }
      const reset = (await repo.getPersonalSourceContext(actor, source.id))
        .context;
      expect(reset.git).toEqual({ ...initial.git, revision: 3 });
      expect(reset.folder).toEqual({ ...initial.folder, revision: 3 });
      const after = await repo.createCapturedSession(actor, {
        externalSessionId: source.externalSessionId!,
        folderObservation: observed,
        repositoryIdentity: git
      });
      expect(after.id).toBe(source.id);
      expect(
        (await repo.getPersonalSourceContext(actor, source.id)).context
      ).toEqual(reset);
      expect(
        (
          await pool.query(
            "select sequence from personal_source_context_changes where owner_user_id=$1",
            [actor.userId]
          )
        ).rows
      ).toHaveLength(4);
    });
    it("retains the latest independent correction state across repeated native Session replacement", async () => {
      const repo = createMemorySourceRepository(pool, options),
        actor = await user(),
        external = randomUUID(),
        observed = folder("/original");
      const capture = () =>
        repo.createCapturedSession(actor, {
          externalSessionId: external,
          idempotencyKey: randomUUID(),
          repositoryIdentity: git,
          folderObservation: observed
        });
      const first = await capture();
      const project = await repo.createNamedPersonalProject(actor, {
        name: "Retained logical source"
      });
      await repo.addPersonalProjectSession(actor, project.projectId, {
        expectedVersion: project.version,
        sessionId: first.id
      });
      const change = async (
        sessionId: string,
        axis: "git" | "folder",
        action: "unresolved" | "reset",
        expectedVersion: number
      ) => {
        const review = await repo.previewPersonalSourceCorrection(
          actor,
          sessionId,
          { axis, action, expectedVersion }
        );
        return repo.applyPersonalSourceCorrection(
          actor,
          sessionId,
          review.preview.reviewId,
          { expectedVersion }
        );
      };
      await change(first.id, "git", "unresolved", 1);
      await change(first.id, "folder", "unresolved", 1);
      const corrected = (await repo.getPersonalSourceContext(actor, first.id))
        .context;
      await pool.query("update sessions set invalidated_at=now() where id=$1", [
        first.id
      ]);
      const second = await capture();
      expect(second.id).not.toBe(first.id);
      expect(
        (await repo.getPersonalSourceContext(actor, second.id)).context
      ).toEqual({
        ...corrected,
        sessionId: second.id,
        logicalSessionId: second.logicalSessionId
      });
      await change(second.id, "git", "reset", 2);
      await change(second.id, "folder", "reset", 2);
      const reset = (await repo.getPersonalSourceContext(actor, second.id))
        .context;
      expect(reset.git.correction).toEqual({ state: "original" });
      expect(reset.folder.correction).toEqual({ state: "original" });
      await pool.query("update sessions set invalidated_at=now() where id=$1", [
        second.id
      ]);
      const third = await capture();
      expect(
        (await repo.getPersonalSourceContext(actor, third.id)).context
      ).toEqual({
        ...reset,
        sessionId: third.id,
        logicalSessionId: third.logicalSessionId
      });
      expect(third.logicalSessionId).not.toBe(first.logicalSessionId);
      // Native replacement does not invent a membership transfer from an external provider ID.
      expect(
        (await repo.listPersonalProjectMemberships(actor, project.projectId))[0]
          ?.logicalSessionId
      ).toBe(first.logicalSessionId);
    });
  }
);
