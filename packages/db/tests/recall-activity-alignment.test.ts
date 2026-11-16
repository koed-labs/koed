import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  recallActivityDetailSchema,
  type PersonalSelectionSnapshot
} from "@koed-labs/shared";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";
import { recordRecallExecution } from "../../mcp-server/src/recall-execution.js";
import { projectRecallExecution } from "../src/recall-activity-execution.js";

const config = {
  maxEvidenceTokens: 24_000,
  maxPromptTokens: 48_000,
  maxSearches: 6,
  maxExpansions: 5,
  maxAttempts: 2
};
const execution = () =>
  recordRecallExecution(
    config,
    {
      workingSetTokens: 13800,
      promptTokenEstimateConsumed: 32600,
      searchAttempts: 1,
      expansionAttempts: 2,
      workerAttempts: 2,
      budgetExhaustions: [],
      deliveryTruncated: false,
      deliveryOperations: [
        {
          kind: "search",
          attempt: 1,
          delivered: 5,
          omitted: 0,
          reasons: [],
          failed: false,
          recovered: false
        },
        {
          kind: "expand",
          attempt: 1,
          delivered: 2,
          omitted: 3,
          reasons: ["recovery_reserve"],
          failed: false,
          recovered: false
        },
        {
          kind: "targeted_expand",
          attempt: 2,
          delivered: 1,
          omitted: 0,
          reasons: [],
          failed: false,
          recovered: true
        }
      ]
    },
    { tokens: 7400, count: 3 }
  );

it("keeps historical ambiguous evidence and missing delivery unknown without inventing defaults", () => {
  const old = projectRecallExecution({
    trace: {
      version: 2,
      budgets: {
        configured: { evidenceTokens: 1000, promptTokens: 2000 },
        consumed: { evidenceTokens: 999, promptTokens: 1900 },
        remaining: { promptTokens: 100 },
        exhausted: ["prompt_tokens", "invalid"]
      }
    }
  });
  expect(old?.budgets?.evidenceWorkingSet).toEqual({
    limit: 1000,
    consumed: null,
    remaining: null
  });
  expect(old?.budgets?.finalEvidenceBundle.consumed).toBeNull();
  expect(old?.budgets?.cumulativePrompt).toEqual({
    limit: 2000,
    consumed: 1900,
    remaining: 100
  });
  expect(old?.delivery).toBeNull();
  expect(old?.budgets?.exhausted).toEqual(["prompt_tokens"]);
  expect(projectRecallExecution({})).toBeNull();
});

describe.skipIf(!process.env.DATABASE_URL)(
  "Recall activity accepted scope and execution",
  () => {
    const pool = createDbPool({ connectionString: process.env.DATABASE_URL });
    const repo = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 73).toString("base64")
      )
    });
    const range = { from: "2026-01-01T00:00:00Z", to: "2030-01-01T00:00:00Z" };
    beforeAll(async () => {
      await runDbMigrations(pool);
    });
    afterAll(async () => {
      await pool.end();
    });
    it("retains a union once, resolves only owner labels, filters every aggregate, and repairs encrypted historical scope without current membership", async () => {
      const actor = {
        userId: (
          await repo.createUser({ email: `${randomUUID()}@example.test` })
        ).id
      };
      const other = {
        userId: (
          await repo.createUser({ email: `${randomUUID()}@example.test` })
        ).id
      };
      const a = await repo.createNamedPersonalProject(actor, { name: "A" });
      const b = await repo.createNamedPersonalProject(actor, { name: "B" });
      const selection: PersonalSelectionSnapshot = {
        version: 1,
        ownerUserId: actor.userId,
        target: {
          kind: "projects",
          projects: [a, b].map(({ projectId }) => ({
            projectId,
            ownerUserId: actor.userId
          })),
          callerSessionId: randomUUID()
        },
        callerRepositoryContext: null
      };
      const runtime = execution();
      const create = () =>
        repo.createFinalMemoryQuestion(actor, {
          idempotencyKey: randomUUID(),
          query: "Retained union",
          searchDomain: "project",
          personalSelection: selection,
          status: "answered",
          answerMarkdown: "Recorded answer",
          evidence: [{ text: "selected only" }],
          retrieval: { activityExecution: runtime },
          recallMetadata: {
            version: 1,
            memoryStatus: "found",
            caller: { name: "codex", version: null },
            timing: {
              acceptedAt: "2026-11-16T10:00:00.000Z",
              completedAt: "2026-11-16T10:00:01.000Z",
              durationMs: 1000
            }
          }
        });
      const first = await create(),
        second = await create();
      await repo.recordWorkflowTokenUsage(actor, {
        workflowType: "mcp_memory_answer",
        questionId: first.id,
        totalTokens: 20,
        idempotencyKey: randomUUID()
      });
      const raw = (
        await pool.query<{
          retrieval: unknown;
          recall_scope: { projectIds: string[] };
        }>(
          "select retrieval,local_memory_worker,recall_scope from memory_questions where id=$1",
          [first.id]
        )
      ).rows[0];
      if (!raw) throw new Error("Missing retained question");
      expect(raw.retrieval).toMatchObject({ contentEncrypted: true });
      expect(JSON.stringify(raw.recall_scope)).not.toContain(
        selection.target.kind === "projects"
          ? selection.target.callerSessionId
          : "invalid"
      );
      expect(raw.recall_scope.projectIds).toEqual([a.projectId, b.projectId]);
      // Model old encrypted history. This is a retained snapshot repair, not a membership backfill.
      await pool.query(
        "update memory_questions set recall_scope=null where id=$1",
        [first.id]
      );
      await pool.query(
        "update personal_named_projects set name='Renamed A' where owner_user_id=$1 and project_id=$2",
        [actor.userId, a.projectId]
      );
      await pool.query(
        "update personal_named_projects set deleted_at=now() where owner_user_id=$1 and project_id=$2",
        [actor.userId, b.projectId]
      );
      const detail = recallActivityDetailSchema.parse(
        await repo.getRecallActivity(actor, first.id)
      );
      expect(detail.question.projectId).toBeNull();
      expect(detail.question.sessionId).toBeNull();
      expect(detail.question.scope).toMatchObject({
        kind: "projects",
        provenance: "accepted",
        projects: [
          { projectId: a.projectId, projectName: "Renamed A" },
          { projectId: b.projectId, projectName: null }
        ]
      });
      expect(detail.execution).toEqual(runtime);
      expect(detail.execution?.budgets?.finalEvidenceBundle.consumed).toBe(
        7400
      );
      expect(detail.evidence).toHaveLength(1); // Display excerpt count never overwrites runtime selection count.
      for (const projectId of [undefined, a.projectId, b.projectId]) {
        const input = { ...range, projectId };
        const page = await repo.listRecallActivity(actor, {
          ...input,
          limit: 1
        });
        expect(page.questions).toHaveLength(1);
        const older = await repo.listRecallActivity(actor, {
          ...input,
          limit: 1,
          cursor: page.nextCursor!
        });
        expect(
          new Set([...page.questions, ...older.questions].map((q) => q.id))
        ).toEqual(new Set([first.id, second.id]));
        expect(page.questions[0]?.scope).toEqual(detail.question.scope);
        const overview = await repo.getRecallActivityOverview(actor, {
          ...input,
          timezone: "UTC"
        });
        expect(overview.recordedQuestions).toBe(2);
        expect(overview.memoryResults.foundPercentage).toBe(100);
        expect(overview.medianDurationMs).toBe(1000);
        expect(overview.tokens.totalTokens).toBe(20);
        expect(
          overview.tokenTimeline.reduce(
            (sum, bin) => sum + (bin.totalTokens ?? 0),
            0
          )
        ).toBe(20);
        expect(
          overview.questions.reduce((sum, bin) => sum + bin.count, 0)
        ).toBe(2);
        expect(overview.filterOptions?.projects).toEqual(
          expect.arrayContaining(detail.question.scope!.projects)
        );
      }
      const filtered = await repo.getRecallActivityOverview(actor, {
        ...range,
        timezone: "UTC",
        callerName: "missing",
        projectId: a.projectId
      });
      expect(filtered.recordedQuestions).toBe(0);
      expect(filtered.filterOptions?.projects).toHaveLength(2);
      // Usage remains on observation time even if its question predates the range.
      await pool.query(
        "update memory_questions set created_at='2020-01-01' where id=$1",
        [first.id]
      );
      const observed = await repo.getRecallActivityOverview(actor, {
        ...range,
        projectId: a.projectId,
        timezone: "UTC"
      });
      expect(observed.recordedQuestions).toBe(1);
      expect(observed.tokens.totalTokens).toBe(20);
      expect(await repo.getRecallActivity(other, first.id)).toBeNull();
      expect(
        (
          await repo.listRecallActivity(other, {
            ...range,
            projectId: a.projectId,
            limit: 50
          })
        ).questions
      ).toEqual([]);
      expect(
        (
          await repo.getRecallActivityOverview(other, {
            ...range,
            timezone: "UTC"
          })
        ).filterOptions?.projects
      ).toEqual([]);
      await expect(
        repo.createFinalMemoryQuestion(other, {
          idempotencyKey: randomUUID(),
          query: "denied",
          searchDomain: "project",
          personalSelection: selection,
          status: "answered",
          answerMarkdown: "no"
        })
      ).rejects.toThrow();
    });
    it("preserves legacy Project filtering, missing diagnostics, and runtime overrides on errors", async () => {
      const actor = {
        userId: (
          await repo.createUser({ email: `${randomUUID()}@example.test` })
        ).id
      };
      const old = await repo.createFinalMemoryQuestion(actor, {
        idempotencyKey: randomUUID(),
        query: "Old",
        searchDomain: "project",
        projectId: "legacy-repository",
        projectName: "Legacy",
        status: "answered",
        answerMarkdown: "Old answer"
      });
      const limited = execution();
      limited.budgets!.cumulativePrompt = {
        limit: 1000,
        consumed: 1001,
        remaining: 0
      };
      limited.budgets!.exhausted = ["prompt_tokens"];
      limited.budgets!.finalEvidenceBundle = {
        limit: 300,
        consumed: null,
        remaining: null
      };
      limited.delivery!.finalSelected = null;
      const error = await repo.createFinalMemoryQuestion(actor, {
        idempotencyKey: randomUUID(),
        query: "Error",
        searchDomain: "global",
        status: "error",
        errorMessage: "private",
        retrieval: { activityExecution: limited }
      });
      expect(
        (await repo.getRecallActivity(actor, old.id))?.execution
      ).toBeNull();
      expect(
        (
          await repo.listRecallActivity(actor, {
            ...range,
            projectId: "legacy-repository",
            limit: 50
          })
        ).questions.map((q) => q.id)
      ).toEqual([old.id]);
      const detail = await repo.getRecallActivity(actor, error.id);
      expect(detail?.execution).toEqual(limited);
      expect(detail?.failure).not.toContain("private");
    });
  }
);

it("keeps explicit Folder, repository, Global and Conversation identities distinct", async () => {
  const { recallScopeIndex } = await import("../src/recall-activity-scope.js");
  const ownerUserId = randomUUID();
  const legacy = { searchDomain: "project", projectId: null };
  const projectId = randomUUID();
  expect(
    recallScopeIndex(
      ownerUserId,
      {
        version: 1,
        ownerUserId,
        callerRepositoryContext: null,
        target: { kind: "project", project: { ownerUserId, projectId } }
      },
      legacy
    )
  ).toEqual({
    kind: "projects",
    provenance: "accepted",
    projectIds: [projectId]
  });
  expect(
    recallScopeIndex(
      ownerUserId,
      {
        version: 1,
        ownerUserId,
        callerRepositoryContext: null,
        target: {
          kind: "folder",
          folder: {
            ownerUserId,
            folderId: "folder",
            originatingDeploymentId: "deployment",
            originatingDeviceId: "device",
            originatingProfileId: "profile",
            directoryIncarnationId: "directory"
          }
        }
      },
      legacy
    )
  ).toMatchObject({ kind: "folder", provenance: "accepted" });
  expect(
    recallScopeIndex(
      ownerUserId,
      {
        version: 0,
        ownerUserId,
        callerRepositoryContext: null,
        target: {
          kind: "legacy_project",
          repository: {
            kind: "portable_repository",
            key: "gr_example",
            root: "/original/checkout",
            branch: "main",
            checkoutId: "checkout",
            originatingDeviceId: "device",
            selectedRemote: "origin",
            anchorDisplay: "example.test/repo",
            reason: "origin"
          }
        }
      },
      legacy
    )
  ).toMatchObject({ kind: "repository", provenance: "accepted" });
  expect(
    recallScopeIndex(
      ownerUserId,
      {
        version: 0,
        ownerUserId,
        callerRepositoryContext: null,
        target: { kind: "legacy_session", sessionId: randomUUID() }
      },
      legacy
    )
  ).toEqual({ kind: "session", provenance: "accepted", projectIds: [] });
  expect(
    recallScopeIndex(
      ownerUserId,
      {
        version: 1,
        ownerUserId,
        callerRepositoryContext: null,
        target: { kind: "global" }
      },
      legacy
    )
  ).toEqual({ kind: "global", provenance: "accepted", projectIds: [] });
  expect(recallScopeIndex(ownerUserId, null, legacy)).toEqual({
    kind: "unknown",
    provenance: "legacy",
    projectIds: []
  });
});
