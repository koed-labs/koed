import { randomBytes, randomUUID } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { createDbPool } from "../src/connection.js";
import { createMemoryAnswerTaskRepository } from "../src/memory-answer-task-repository.js";
import { runDbMigrations } from "../src/migrate.js";
import { createMemorySourceRepository } from "../src/repository.js";

const databaseUrl = process.env.MEMORY_ANSWER_TASK_TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("durable Memory Answer task repository", () => {
  let pool: pg.Pool;
  const encryptionProvider = createLocalTestKeyEnvelopeEncryptionProvider(
    randomBytes(32).toString("base64url")
  );

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query("truncate table users restart identity cascade");
  });

  afterAll(async () => {
    await pool.end();
  });

  const createActor = async (label: string) => {
    const repository = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: encryptionProvider
    });
    const user = await repository.createUser({
      email: `${label}-${randomUUID()}@example.test`
    });
    return { actor: { userId: user.id }, repository };
  };

  it("deduplicates concurrent owner invocations and isolates encrypted requests", async () => {
    const { actor } = await createActor("owner");
    const { actor: otherActor } = await createActor("other");
    const tasks = createMemoryAnswerTaskRepository(pool, {
      envelopeEncryptionProvider: encryptionProvider
    });
    const secret = `private-query-${randomUUID()}`;
    const invocationKey = `adapter:${randomUUID()}`;
    const accepted = await Promise.all(
      Array.from({ length: 8 }, () =>
        tasks.acceptMemoryAnswerTask(actor, {
          origin: "mcp",
          invocationKey,
          request: { input: { query: secret }, caller: { cwd: "/private" } }
        })
      )
    );

    expect(new Set(accepted.map((task) => task.id)).size).toBe(1);
    expect(
      await tasks.getMemoryAnswerTask(otherActor, accepted[0]!.id)
    ).toBeNull();
    expect(
      await tasks.claimMemoryAnswerTask(otherActor, {
        leaseOwner: `other-${randomUUID()}`,
        leaseMs: 1_000
      })
    ).toBeNull();

    const stored = await pool.query<{
      request: string;
      encrypted: string;
    }>(
      `select task.request_snapshot::text as request,
              coalesce(string_agg(payload.ciphertext, ''), '') as encrypted
         from memory_answer_tasks task
         left join encrypted_field_payloads payload
           on payload.source_table = 'memory_answer_tasks'
          and payload.source_id = task.id
        where task.id = $1
        group by task.request_snapshot`,
      [accepted[0]!.id]
    );
    expect(stored.rows[0]!.request).toContain("contentEncrypted");
    expect(JSON.stringify(stored.rows[0])).not.toContain(secret);
  });

  it("reclaims expired leases, fences stale owners, and resolves cancellation races", async () => {
    const { actor } = await createActor("lease-owner");
    const tasks = createMemoryAnswerTaskRepository(pool, {
      envelopeEncryptionProvider: encryptionProvider
    });
    const accepted = await tasks.acceptMemoryAnswerTask(actor, {
      origin: "mcp",
      invocationKey: randomUUID(),
      request: { input: { query: "lease test" }, caller: { cwd: "/work" } }
    });
    const first = await tasks.claimMemoryAnswerTask(actor, {
      leaseOwner: `first-${randomUUID()}`,
      leaseMs: 1_000
    });
    expect(first?.fenceGeneration).toBe(1);
    await pool.query(
      "update memory_answer_tasks set lease_until = now() - interval '1 second' where id = $1",
      [accepted.id]
    );
    const second = await tasks.claimMemoryAnswerTask(actor, {
      leaseOwner: `second-${randomUUID()}`,
      leaseMs: 60_000
    });
    expect(second?.fenceGeneration).toBe(2);
    expect(
      await tasks.heartbeatMemoryAnswerTask(actor, {
        taskId: accepted.id,
        leaseOwner: first!.leaseOwner,
        fenceGeneration: first!.fenceGeneration,
        leaseMs: 60_000
      })
    ).toBeNull();

    expect(
      (await tasks.cancelMemoryAnswerTask(actor, accepted.id))?.status
    ).toBe("cancel_requested");
    expect(
      await tasks.completeMemoryAnswerTask(actor, {
        taskId: accepted.id,
        leaseOwner: second!.leaseOwner,
        fenceGeneration: second!.fenceGeneration,
        questionId: randomUUID(),
        result: { markdown: "late result" }
      })
    ).toBeNull();
    expect(
      await tasks.failMemoryAnswerTask(actor, {
        taskId: accepted.id,
        leaseOwner: second!.leaseOwner,
        fenceGeneration: second!.fenceGeneration,
        errorCode: "cancelled",
        errorMessage: "cancelled by fixture",
        retry: true
      })
    ).toMatchObject({ status: "cancelled" });
  });

  it("encrypts terminal result and error payloads", async () => {
    const { actor, repository } = await createActor("terminal-owner");
    const tasks = createMemoryAnswerTaskRepository(pool, {
      envelopeEncryptionProvider: encryptionProvider
    });
    const question = await repository.createFinalMemoryQuestion(actor, {
      idempotencyKey: `question-${randomUUID()}`,
      query: "fixture question",
      searchDomain: "global",
      status: "answered",
      answerMarkdown: "fixture answer"
    });
    const resultSecret = `result-${randomUUID()}`;
    const completedTask = await tasks.acceptMemoryAnswerTask(actor, {
      origin: "mcp",
      invocationKey: randomUUID(),
      request: { input: { query: "result" }, caller: { cwd: "/work" } }
    });
    const completedClaim = await tasks.claimMemoryAnswerTask(actor, {
      leaseOwner: `complete-${randomUUID()}`,
      leaseMs: 60_000
    });
    await tasks.completeMemoryAnswerTask(actor, {
      taskId: completedTask.id,
      leaseOwner: completedClaim!.leaseOwner,
      fenceGeneration: completedClaim!.fenceGeneration,
      questionId: question.id,
      result: { markdown: resultSecret }
    });

    const errorSecret = `error-${randomUUID()}`;
    const failedTask = await tasks.acceptMemoryAnswerTask(actor, {
      origin: "mcp",
      invocationKey: randomUUID(),
      request: { input: { query: "error" }, caller: { cwd: "/work" } }
    });
    const failedClaim = await tasks.claimMemoryAnswerTask(actor, {
      leaseOwner: `fail-${randomUUID()}`,
      leaseMs: 60_000
    });
    await tasks.failMemoryAnswerTask(actor, {
      taskId: failedTask.id,
      leaseOwner: failedClaim!.leaseOwner,
      fenceGeneration: failedClaim!.fenceGeneration,
      errorCode: "fixture_error",
      errorMessage: errorSecret,
      retry: false
    });

    const raw = await pool.query<{ rendered: string }>(
      `select row_to_json(task)::text as rendered
         from memory_answer_tasks task
        where id = any($1::uuid[])
        order by id`,
      [[completedTask.id, failedTask.id]]
    );
    expect(JSON.stringify(raw.rows)).not.toMatch(
      new RegExp(`${resultSecret}|${errorSecret}`)
    );
    expect(
      await tasks.getMemoryAnswerTask(actor, completedTask.id)
    ).toMatchObject({
      status: "completed",
      result: { markdown: resultSecret }
    });
    expect(await tasks.getMemoryAnswerTask(actor, failedTask.id)).toMatchObject(
      {
        status: "failed",
        lastErrorMessage: errorSecret
      }
    );
  });
});
