import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  recallActivityDetailSchema,
  recallActivityPageSchema,
  type RecallQuestionMetadata
} from "@koed-labs/shared";
import { createDbPool } from "../src/connection.js";
import { runDbMigrations } from "../src/migrate.js";
import { createMemorySourceRepository } from "../src/repository.js";
import { createMemoryAnswerTaskRepository } from "../src/memory-answer-task-repository.js";

const databaseUrl = process.env.MEMORY_ANSWER_TASK_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("Recall review regressions", () => {
  const options = {
    envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64url")
    )
  };
  let pool: ReturnType<typeof createDbPool>;
  let repository: ReturnType<typeof createMemorySourceRepository>;
  let actor: { userId: string };
  const range = () => ({
    from: new Date(Date.now() - 86_400_000).toISOString(),
    to: new Date(Date.now() + 86_400_000).toISOString()
  });
  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
    repository = createMemorySourceRepository(pool, options);
  });
  beforeEach(async () => {
    await pool.query("truncate users restart identity cascade");
    actor = {
      userId: (
        await repository.createUser({ email: `${randomUUID()}@example.test` })
      ).id
    };
  });
  afterAll(async () => pool?.end());
  const question = (
    input: {
      query?: string;
      projectId?: string;
      projectName?: string;
      recallMetadata?: RecallQuestionMetadata;
    } = {}
  ) =>
    repository.createFinalMemoryQuestion(actor, {
      idempotencyKey: randomUUID(),
      query: "Synthetic question",
      origin: "mcp_memory_answer",
      searchDomain: "global",
      status: "answered",
      answerMarkdown: "Synthetic answer",
      ...input
    });
  const usage = (job: string, questionId?: string, expectedExecutions = 1) => ({
    workflowType: "mcp_memory_answer",
    workflowId: job,
    answerJobId: job,
    questionId,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    idempotencyKey: randomUUID(),
    metadata: { expectedExecutions }
  });
  const page = () =>
    repository.listRecallActivity(actor, { ...range(), limit: 50 });
  const overview = () =>
    repository.getRecallActivityOverview(actor, {
      ...range(),
      timezone: "UTC"
    });

  it("marks missing writes and entire missing runs as partial without inventing spend", async () => {
    const job = randomUUID();
    const q = await question({
      recallMetadata: {
        version: 1,
        memoryStatus: "found",
        usage: { jobId: job, attempts: 2 }
      }
    });
    await repository.recordWorkflowTokenUsage(actor, usage(job, q.id, 2));
    expect((await page()).questions[0]!.usage).toMatchObject({
      coverage: "partial",
      totalTokens: 15
    });
    expect(
      (await repository.getRecallActivity(actor, q.id))!.usage.coverage
    ).toBe("partial");
    expect((await overview()).tokens.coverage).toBe("partial");
    await repository.recordWorkflowTokenUsage(actor, usage(job, q.id, 2));
    expect((await page()).questions[0]!.usage).toMatchObject({
      coverage: "recorded",
      totalTokens: 30
    });
    await pool.query(
      "update memory_questions set recall_metadata=jsonb_set(recall_metadata,'{usage,taskAttempts}','2') where id=$1",
      [q.id]
    );
    expect((await overview()).tokens.coverage).toBe("partial");
    await repository.recordWorkflowTokenUsage(actor, usage(randomUUID(), q.id));
    expect((await overview()).tokens).toMatchObject({
      coverage: "recorded",
      totalTokens: 45
    });
    await question({
      recallMetadata: {
        version: 1,
        memoryStatus: "found",
        usage: { jobId: randomUUID(), attempts: 1 }
      }
    });
    expect((await overview()).tokens).toMatchObject({
      coverage: "partial",
      totalTokens: 45
    });
  });

  it("accepts late observations after expiry and cancellation without exposing unlinked usage", async () => {
    const tasks = createMemoryAnswerTaskRepository(pool, options);
    const accepted = await tasks.acceptMemoryAnswerTask(actor, {
      origin: "mcp",
      invocationKey: randomUUID(),
      maxQueued: 16,
      request: {
        input: {
          query: "Synthetic question",
          search_domain: "global",
          repository_context: null
        }
      }
    });
    const observed = {
      ...usage(randomUUID()),
      memoryAnswerTaskId: accepted.id
    };
    await expect(
      repository.recordWorkflowTokenUsage(actor, observed)
    ).rejects.toThrow(/not authorized/);
    await tasks.claimMemoryAnswerTask(actor, {
      leaseOwner: "fixture",
      leaseMs: 60_000
    });
    await pool.query(
      "update memory_answer_tasks set expires_at=now()-interval '1 second' where id=$1",
      [accepted.id]
    );
    await repository.recordWorkflowTokenUsage(actor, observed);
    await pool.query(
      "update memory_answer_tasks set status='cancelled',cancelled_at=now(),lease_owner=null,lease_until=null where id=$1",
      [accepted.id]
    );
    await repository.recordWorkflowTokenUsage(actor, {
      ...usage(randomUUID()),
      memoryAnswerTaskId: accepted.id
    });
    const other = {
      userId: (
        await repository.createUser({ email: `${randomUUID()}@example.test` })
      ).id
    };
    await expect(
      repository.recordWorkflowTokenUsage(other, observed)
    ).rejects.toThrow(/not authorized/);
    const workspace = await pool.query<{ id: string }>(
      `with team as (insert into teams(name, created_by_user_id) values('Fixture', $1) returning id)
       insert into team_workspaces(team_id, name) select id, 'Fixture' from team returning id`,
      [actor.userId]
    );
    await pool.query(
      "update memory_answer_tasks set team_workspace_id=$2,team_authorization='{}'::jsonb where id=$1",
      [accepted.id, workspace.rows[0]!.id]
    );
    await expect(
      repository.recordWorkflowTokenUsage(actor, observed)
    ).rejects.toThrow(/not authorized/);
    await pool.query(
      "update memory_answer_tasks set team_workspace_id=null,team_authorization=null where id=$1",
      [accepted.id]
    );
    expect(await tasks.deleteExpiredMemoryAnswerTasks(actor)).toBe(1);
    await repository.recordWorkflowTokenUsage(actor, {
      ...usage(randomUUID()),
      memoryAnswerTaskId: accepted.id
    });
    await expect(
      repository.recordWorkflowTokenUsage(other, observed)
    ).rejects.toThrow(/not authorized/);
    expect((await overview()).tokens.coverage).toBe("unavailable");
    expect((await page()).questions).toEqual([]);
  });

  it("links a late observation to a completed question and keeps it idempotent", async () => {
    const tasks = createMemoryAnswerTaskRepository(pool, options);
    const accepted = await tasks.acceptMemoryAnswerTask(actor, {
      origin: "mcp",
      invocationKey: randomUUID(),
      maxQueued: 16,
      request: {
        input: {
          query: "Synthetic question",
          search_domain: "global",
          repository_context: null
        }
      }
    });
    const claim = (
      await tasks.claimMemoryAnswerTask(actor, {
        leaseOwner: "fixture",
        leaseMs: 60_000
      })
    ).task!;
    expect(claim.id).toBe(accepted.id);
    const job = randomUUID();
    const completed = await tasks.completeMemoryAnswerTask(actor, {
      taskId: claim.id,
      leaseOwner: "fixture",
      fenceGeneration: claim.fenceGeneration,
      finalQuestion: {
        idempotencyKey: randomUUID(),
        query: "Synthetic question",
        searchDomain: "global",
        status: "answered",
        answerMarkdown: "Synthetic answer",
        recallMetadata: {
          version: 1,
          memoryStatus: "found",
          usage: { jobId: job, attempts: 1 }
        }
      },
      result: {}
    });
    expect(completed?.questionId).toBeTruthy();
    await pool.query(
      "update memory_answer_tasks set expires_at=now()-interval '1 second' where id=$1",
      [claim.id]
    );
    expect(await tasks.deleteExpiredMemoryAnswerTasks(actor)).toBe(1);
    const observed = { ...usage(job), memoryAnswerTaskId: claim.id };
    await repository.recordWorkflowTokenUsage(actor, observed);
    await repository.recordWorkflowTokenUsage(actor, observed);
    expect((await page()).questions[0]!.usage).toMatchObject({
      coverage: "recorded",
      totalTokens: 15,
      recordedAttempts: 1
    });
  });

  it("bounds historical question text without altering the stored encrypted content", async () => {
    const query = "x".repeat(100_001);
    const q = await question({ query });
    const list = await page();
    expect(recallActivityPageSchema.safeParse(list).success).toBe(true);
    expect(list.questions[0]!.query).toHaveLength(100_000);
    expect(list.questions[0]!.queryTruncated).toBe(true);
    const detail = (await repository.getRecallActivity(actor, q.id))!;
    expect(recallActivityDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail.contentTruncated).toBe(true);
    expect(detail.question.queryTruncated).toBe(true);
    expect((await repository.getMemoryQuestion(actor, q.id))!.query).toBe(
      query
    );
  });

  it("returns filter choices beyond the current page and active filters", async () => {
    for (const [projectId, caller] of [
      ["project-a", "codex"],
      ["project-b", "pi"]
    ])
      await question({
        projectId,
        projectName: projectId,
        recallMetadata: {
          version: 1,
          memoryStatus: "found",
          caller: { name: caller!, version: null }
        }
      });
    expect(
      (await repository.listRecallActivity(actor, { ...range(), limit: 1 }))
        .questions
    ).toHaveLength(1);
    const all = await repository.getRecallActivityOverview(actor, {
      ...range(),
      timezone: "UTC",
      projectId: "project-a",
      callerName: "codex"
    });
    expect(all.recordedQuestions).toBe(1);
    expect(all.filterOptions).toEqual({
      projects: [
        { projectId: "project-a", projectName: "project-a" },
        { projectId: "project-b", projectName: "project-b" }
      ],
      callerNames: ["codex", "pi"]
    });
  });
});
