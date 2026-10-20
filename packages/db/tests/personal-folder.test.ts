import {
  pinMemoryAnswerTaskSelection,
  validateMemoryAnswerTaskCompletion
} from "../src/memory-answer-task-request.js";
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
  personalFolderScopeId,
  type PersonalFolderObservation,
  type PersonalSelectionSnapshot,
  type RepositoryIdentity
} from "@koed/shared";
import {
  createDbPool,
  runDbMigrations,
  createMemorySourceRepository
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const options = {
  envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 92).toString("base64")
  )
};
const folder = (
  path: string,
  identity: Partial<PersonalFolderObservation["identity"]> = {}
): PersonalFolderObservation => ({
  identity: {
    folderId: randomUUID(),
    originatingDeploymentId: "origin_deployment",
    originatingDeviceId: "origin_device",
    originatingProfileId: "origin_profile",
    directoryIncarnationId: randomUUID(),
    ...identity
  },
  normalizedPath: path,
  capturedPath: path,
  observedAt: new Date().toISOString()
});
const selected = (
  ownerUserId: string,
  observation: PersonalFolderObservation
): PersonalSelectionSnapshot => ({
  version: 1,
  ownerUserId,
  target: { kind: "folder", folder: { ...observation.identity, ownerUserId } },
  callerRepositoryContext: null
});
const repository: RepositoryIdentity = {
  kind: "portable_repository",
  key: "gr_folder_fixture",
  root: "/work/repo",
  branch: "main",
  reason: "origin",
  checkoutId: "folder_checkout",
  originatingDeviceId: "origin_device",
  selectedRemote: "origin",
  anchorDisplay: "example.test/folder"
};

describe.skipIf(!databaseUrl)(
  "exact Personal Folder selection in PostgreSQL",
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
          email: `folder-${randomUUID()}@example.test`
        })
      ).id
    });

    it("pins original context across resumes, retries, logical Session replacement, and unresolved import", async () => {
      const repo = createMemorySourceRepository(pool, options),
        actor = await user();
      const root = folder("/work/repo"),
        sub = folder("/work/repo/sub");
      const externalSessionId = randomUUID();
      const first = await repo.createCapturedSession(actor, {
        externalSessionId,
        cwd: root.capturedPath,
        repositoryIdentity: repository,
        folderObservation: root
      });
      const resumed = await repo.createCapturedSession(actor, {
        externalSessionId,
        cwd: sub.capturedPath,
        repositoryIdentity: { ...repository, key: "gr_another" },
        folderObservation: sub,
        currentFolderObservation: sub
      });
      expect(resumed.id).toBe(first.id);
      expect(resumed.folderAssignment).toEqual(first.folderAssignment);
      expect(resumed.repositoryAssignment).toEqual(first.repositoryAssignment);
      await repo.createCapturedSession(actor, {
        externalSessionId,
        folderObservation: { ...sub, observedAt: new Date().toISOString() }
      });
      expect(
        (
          await pool.query(
            "select observation from session_folder_observations where session_id=$1",
            [first.id]
          )
        ).rows
      ).toHaveLength(2);
      const laterEvent = await repo.createMemoryEvent(actor, {
        sessionId: first.id,
        projectId: "legacy",
        actor: "user",
        visibility: "personal",
        eventType: "captured",
        rawEventType: "user_message",
        content: "Later turn in the original Folder",
        idempotencyKey: randomUUID()
      });
      expect(
        (
          await repo.listLcmGraphEvents(actor, {
            personalSelection: selected(actor.userId, root),
            canonicalCapturedSessionEventsOnly: true,
            limit: 50
          })
        ).map((row) => row.id)
      ).toEqual([laterEvent.id]);
      expect(
        await repo.listLcmGraphEvents(actor, {
          personalSelection: selected(actor.userId, sub),
          canonicalCapturedSessionEventsOnly: true,
          limit: 50
        })
      ).toEqual([]);
      await pool.query("update sessions set invalidated_at=now() where id=$1", [
        first.id
      ]);
      const replacement = await repo.createCapturedSession(actor, {
        externalSessionId,
        idempotencyKey: randomUUID(),
        cwd: sub.capturedPath,
        // Replacement must retain the exact recorded Capture Target key even
        // when the source observation comes from a later directory.
        detectedProjects: [
          {
            id: root.capturedPath,
            name: "Recorded target",
            path: root.capturedPath
          }
        ],
        folderObservation: sub,
        repositoryIdentity: repository
      });
      expect(replacement.id).not.toBe(first.id);
      expect(replacement.folderAssignment).toEqual(first.folderAssignment);
      expect(
        await repo.getCapturedSession(actor, replacement.id, {
          personalSelection: selected(actor.userId, sub)
        })
      ).toBeNull();
      expect(
        await repo.getCapturedSession(actor, replacement.id, {
          personalSelection: selected(actor.userId, root)
        })
      ).not.toBeNull();
      const oldExternal = randomUUID();
      const historical = await repo.createCapturedSession(actor, {
        externalSessionId: oldExternal,
        importObservedAt: new Date().toISOString(),
        cwd: root.capturedPath
      });
      const later = await repo.createCapturedSession(actor, {
        externalSessionId: oldExternal,
        folderObservation: root
      });
      expect(later.folderAssignment).toEqual(historical.folderAssignment);
      expect(later.folderAssignment?.original).toEqual({
        state: "unresolved",
        reason: "historical_unresolved"
      });
      expect(
        await repo.getCapturedSession(actor, historical.id, {
          personalSelection: selected(actor.userId, root)
        })
      ).toBeNull();
      expect(
        (await repo.listPersonalFolders(actor)).map(
          (entry) => entry.reference.folderId
        )
      ).toEqual([root.identity.folderId]);
      // A deleted Conversation cannot use native replacement to revive its
      // old source, even when it has no independent Capture Target binding.
      await pool.query(
        "update sessions set personal_deleted_at=now(),personal_deleted_by_user_id=$2 where id=$1",
        [historical.id, actor.userId]
      );
      await expect(
        repo.createCapturedSession(actor, {
          externalSessionId: oldExternal,
          folderObservation: root
        })
      ).rejects.toMatchObject({ code: "captured_session_removed" });
      const reconnect = createDbPool({ connectionString: databaseUrl });
      try {
        expect(
          (
            await createMemorySourceRepository(
              reconnect,
              options
            ).getCapturedSession(actor, replacement.id)
          )?.folderAssignment
        ).toEqual(first.folderAssignment);
      } finally {
        await reconnect.end();
      }
    });

    it("separates a checkout from subfolders, devices, profiles, incarnations, and other owners across raw and derived recall", async () => {
      const repo = createMemorySourceRepository(pool, options),
        actor = await user(),
        other = await user();
      const root = folder("/work/repo"),
        sub = folder("/work/repo/sub");
      const contexts: Array<PersonalFolderObservation | undefined> = [
        root,
        sub,
        folder("/work/repo/sub/child"),
        folder("/work/repo/sibling"),
        folder(root.normalizedPath, {
          ...root.identity,
          originatingDeviceId: "other_device"
        }),
        folder(root.normalizedPath, {
          ...root.identity,
          originatingProfileId: "other_profile"
        }),
        folder(root.normalizedPath, {
          ...root.identity,
          directoryIncarnationId: randomUUID()
        }),
        undefined
      ];
      const sources = [];
      for (const [index, context] of contexts.entries()) {
        const session = await repo.createCapturedSession(actor, {
          externalSessionId: randomUUID(),
          repositoryIdentity: repository,
          folderObservation: context,
          cwd: context?.capturedPath ?? root.capturedPath,
          importObservedAt: context ? undefined : new Date().toISOString()
        });
        const event = await repo.createMemoryEvent(actor, {
          sessionId: session.id,
          projectId: "legacy",
          actor: "user",
          visibility: "personal",
          eventType: "captured",
          rawEventType: "user_message",
          content: `FOLDER_DECISION_${index}`,
          idempotencyKey: randomUUID()
        });
        const node = await repo.createMemoryNode(actor, {
          visibility: "personal",
          summaryText: `FOLDER_SUMMARY_${index}`,
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
          summaryText: `FOLDER_SUMMARY_${index}`,
          summaryModel: "fixture-client",
          summaryTokenEstimate: 8,
          summaryPromptVersion: "fixture",
          summaryStructuredJson: {
            schema_version: "lcm-semantic-summary-v1",
            title: "Folder decision",
            summary_text: `FOLDER_SUMMARY_${index}`,
            lexical_anchors: []
          },
          summaryStructuredSchemaVersion: "lcm-semantic-summary-v1"
        });
        sources.push({ session, event, node });
      }
      const foreign = await repo.createCapturedSession(other, {
        externalSessionId: randomUUID(),
        folderObservation: root,
        repositoryIdentity: repository
      });
      await expect(
        repo.getCapturedSession(other, foreign.id, {
          personalSelection: selected(actor.userId, root)
        })
      ).rejects.toMatchObject({ statusCode: 403 });
      const vector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
      vi.stubEnv("EMBEDDING_SERVICE_URL", "http://folder.fixture");
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
      for (const source of sources)
        for (const [type, id] of [
          ["memory_event", source.event.id],
          ["memory_node", source.node.id]
        ] as const) {
          const embeddable = await repo.getEmbeddableSource(type, id);
          expect(embeddable).not.toBeNull();
          await repo.upsertSourceEmbedding({
            source: embeddable!,
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
        }
      const recall = async (
        selection: PersonalSelectionSnapshot,
        stage: "raw_fallback_search" | "leaf_search"
      ) =>
        (
          await createMemoryEngine(repo).searchMemory({
            requesterContext: actor,
            query: "Folder decision",
            scope: "personal",
            personalSelection: selection,
            retrievalStage: stage,
            limit: 50
          })
        ).results
          .map((row) => row.sourceId)
          .sort();
      for (const [index, context] of contexts.entries()) {
        if (!context) continue;
        expect(
          await recall(selected(actor.userId, context), "raw_fallback_search")
        ).toEqual([sources[index]!.event.id]);
        expect(
          await recall(selected(actor.userId, context), "leaf_search")
        ).toEqual([sources[index]!.node.id]);
      }
      const gitSelection: PersonalSelectionSnapshot = {
        version: 1,
        ownerUserId: actor.userId,
        target: { kind: "repository", repository },
        callerRepositoryContext: null
      };
      expect(await recall(gitSelection, "raw_fallback_search")).toEqual(
        sources.map((source) => source.event.id).sort()
      );
      const exact = selected(actor.userId, sub);
      const inventory = await repo.listLcmGraphThreads(actor, {
        personalSelection: exact,
        limit: 50
      });
      expect(
        inventory.flatMap((group) =>
          group.threads.flatMap(
            (thread) =>
              thread.sourceReferences?.map((ref) => ref.sessionId) ?? []
          )
        )
      ).toEqual([sources[1]!.session.id]);
      expect(
        await repo.getLcmGraphNode(actor, sources[0]!.node.id, {
          personalSelection: exact
        })
      ).toBeNull();
      expect(
        (
          await repo.getLcmGraphNode(actor, sources[1]!.node.id, {
            personalSelection: exact
          })
        )?.sources.map((row) => row.id)
      ).toEqual([sources[1]!.event.id]);
      const mixed = await repo.createMemoryNode(actor, {
        visibility: "personal",
        summaryText: "MIXED_FOLDER_SECRET",
        sourceHash: randomUUID()
      });
      await pool.query(
        "update memory_nodes set source_event_count=2,lcm_algorithm_version='fixture',summary_model='fixture-client' where id=$1",
        [mixed.id]
      );
      for (const [index, source] of sources.slice(0, 2).entries())
        await pool.query(
          "insert into memory_node_sources(memory_node_id,memory_event_id,source_order) values($1,$2,$3)",
          [mixed.id, source.event.id, index]
        );
      expect(
        await repo.getLcmGraphNode(actor, mixed.id, {
          personalSelection: exact
        })
      ).toBeNull();
      expect(
        (
          await repo.getLcmGraphNode(actor, mixed.id, {
            personalSelection: gitSelection
          })
        )?.summaryText
      ).toBe("MIXED_FOLDER_SECRET");
      const proposal = await repo.createCuratedMemoryProposal(actor, {
        proposedClaim: "MIXED_FOLDER_CLAIM",
        evidenceMemoryEventIds: sources.slice(0, 2).map((row) => row.event.id)
      });
      const curated = await repo.processCuratedMemoryProposal(actor, {
        proposalId: proposal.id,
        decision: "store",
        assertion: {
          assertionText: "MIXED_FOLDER_CLAIM",
          sources: sources.slice(0, 2).map((row) => ({
            sourceType: "memory_event" as const,
            sourceRole: "primary_evidence" as const,
            memoryEventId: row.event.id
          }))
        }
      });
      expect(
        (
          await repo.searchCuratedMemoryAssertions(actor, {
            query: "MIXED_FOLDER_CLAIM",
            personalSelection: exact,
            limit: 50
          })
        ).map((row) => row.id)
      ).not.toContain(curated.assertionId);
      expect(
        (
          await repo.searchCuratedMemoryAssertions(actor, {
            query: "MIXED_FOLDER_CLAIM",
            personalSelection: gitSelection
          })
        ).map((row) => row.id)
      ).toContain(curated.assertionId);
      const expanded = await repo.expandMemoryNode(
        curated.assertionId!,
        actor,
        { personalSelection: exact }
      );
      expect(expanded.sources.map((row) => row.id)).toEqual([
        sources[1]!.event.id
      ]);
      expect(JSON.stringify(expanded)).not.toContain("MIXED_FOLDER_CLAIM");
      const snapshot = {
        requestVersion: 1,
        selection: exact,
        input: {
          query: "What did this Folder decide?",
          search_domain: "project",
          project_id: personalFolderScopeId({
            ...sub.identity,
            ownerUserId: actor.userId
          }),
          repository_context: null
        }
      };
      expect(pinMemoryAnswerTaskSelection(snapshot, actor.userId)).toEqual(
        snapshot
      );
      expect(() =>
        validateMemoryAnswerTaskCompletion(snapshot, null, {
          query: snapshot.input.query,
          retrievalScope: "personal",
          searchDomain: "project",
          projectId: snapshot.input.project_id
        })
      ).not.toThrow();
      const pending = await repo.createPendingDesktopAsk(actor, {
        folderSelection: { ...sub.identity, ownerUserId: actor.userId },
        idempotencyKey: randomUUID(),
        query: "What did this Folder decide?"
      });
      expect(pending.projectId).toBe(
        personalFolderScopeId({ ...sub.identity, ownerUserId: actor.userId })
      );
      await expect(
        repo.createPendingDesktopAsk(actor, {
          askThreadId: pending.askThreadId!,
          folderSelection: { ...root.identity, ownerUserId: actor.userId },
          idempotencyKey: randomUUID(),
          query: "Change Folder"
        })
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        repo.createPendingDesktopAsk(actor, {
          folderSelection: { ...root.identity, ownerUserId: other.userId },
          idempotencyKey: randomUUID(),
          query: "Wrong owner"
        })
      ).rejects.toMatchObject({ statusCode: 403 });
      const assignment = sources[1]!.session.folderAssignment!;
      await pool.query("update sessions set folder_assignment=$2 where id=$1", [
        sources[1]!.session.id,
        {
          ...assignment,
          revision: 2,
          correction: {
            state: "corrected",
            revisionId: randomUUID(),
            value: { state: "unresolved", reason: "explicit_unresolved" }
          }
        }
      ]);
      expect(await recall(exact, "raw_fallback_search")).toEqual([]);
      expect(await recall(exact, "leaf_search")).toEqual([]);
      await pool.query("update sessions set folder_assignment=$2 where id=$1", [
        sources[1]!.session.id,
        {
          ...assignment,
          revision: 3,
          correction: {
            state: "corrected",
            revisionId: randomUUID(),
            value: {
              state: "known",
              value: {
                reference: { ...root.identity, ownerUserId: actor.userId },
                normalizedPath: root.normalizedPath,
                capturedPath: root.capturedPath
              }
            }
          }
        }
      ]);
      expect(
        await recall(selected(actor.userId, root), "raw_fallback_search")
      ).toEqual([sources[0]!.event.id, sources[1]!.event.id].sort());
      expect(await recall(exact, "raw_fallback_search")).toEqual([]);
      expect(await recall(gitSelection, "raw_fallback_search")).toEqual(
        sources.map((source) => source.event.id).sort()
      );
    });
    it("rejects native replacement that would lose a Capture Pause or change its policy key", async () => {
      const repo = createMemorySourceRepository(pool, options);
      for (const scenario of ["session_pause", "target_key"] as const) {
        const actor = await user();
        const original = await repo.createCapturedSession(actor, {
          externalSessionId: randomUUID(),
          repositoryIdentity: repository,
          cwd: repository.root!
        });
        const policy = await repo.upsertCapturePolicy(actor, {
          ...(scenario === "session_pause"
            ? { targetType: "thread" as const, threadId: original.id }
            : {
                targetType: "project" as const,
                projectId: repository.root!
              }),
          captureState: "enabled",
          pauseUntil: new Date(Date.now() + 3_600_000),
          visibility: "personal"
        });
        expect(
          (
            await repo.getEffectiveCapturePolicy(actor, {
              sessionId: original.id
            })
          ).paused
        ).toBe(true);
        await pool.query(
          "update sessions set invalidated_at=now() where id=$1",
          [original.id]
        );
        const observation =
          scenario === "target_key"
            ? {
                ...repository,
                key: `gr_other_${randomUUID()}`,
                root: "/work/other"
              }
            : repository;
        await expect(
          repo.createCapturedSession(actor, {
            externalSessionId: original.externalSessionId!,
            repositoryIdentity: observation,
            cwd: observation.root!
          })
        ).rejects.toMatchObject({
          code: "captured_session_removed",
          statusCode: 409
        });
        expect(
          (
            await pool.query<{ count: number }>(
              "select count(*)::integer count from sessions where owner_user_id=$1 and external_session_id=$2",
              [actor.userId, original.externalSessionId]
            )
          ).rows[0]?.count
        ).toBe(1);
        expect(await repo.listCapturePolicies(actor)).toEqual([policy]);
      }
    });
  }
);
