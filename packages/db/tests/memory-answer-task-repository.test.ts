import { randomBytes, randomUUID } from "node:crypto";
import {
  repositoryScopeId,
  type RepositoryIdentity,
  createLocalTestKeyEnvelopeEncryptionProvider
} from "@koed/shared";
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
          maxQueued: 16,
          request: {
            input: {
              query: secret,
              search_domain: "global",
              repository_context: null
            },
            caller: { cwd: "/private" }
          }
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
    ).toMatchObject({ task: null, reconciled: [] });

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

  it("restricts claims to credential capabilities and the requested scope", async () => {
    const { actor } = await createActor("scope-selector");
    const tasks = createMemoryAnswerTaskRepository(pool, {
      envelopeEncryptionProvider: encryptionProvider
    });
    const accepted = await tasks.acceptMemoryAnswerTask(actor, {
      origin: "mcp",
      maxQueued: 16,
      request: {
        input: {
          query: "personal question",
          search_domain: "global",
          repository_context: null
        }
      }
    });
    expect(
      await tasks.claimMemoryAnswerTask(
        { ...actor, allowPersonal: false, allowTeam: true },
        {
          leaseOwner: `team-only-${randomUUID()}`,
          leaseMs: 60_000,
          allowTeam: true
        }
      )
    ).toMatchObject({ task: null, reconciled: [] });
    expect(
      await tasks.claimMemoryAnswerTask(
        { ...actor, allowTeam: true },
        {
          leaseOwner: `team-filter-${randomUUID()}`,
          leaseMs: 60_000,
          allowTeam: true,
          scopeFilter: "team"
        }
      )
    ).toMatchObject({ task: null, reconciled: [] });
    expect(
      await tasks.claimMemoryAnswerTask(actor, {
        leaseOwner: `personal-${randomUUID()}`,
        leaseMs: 60_000,
        scopeFilter: "personal"
      })
    ).toMatchObject({ task: { id: accepted.id } });
  });

  it("links usage across retried worker jobs and preserves it after task expiry", async () => {
    const { actor, repository } = await createActor("usage-owner");
    const { actor: otherActor } = await createActor("other-usage-owner");
    const tasks = createMemoryAnswerTaskRepository(pool, {
      envelopeEncryptionProvider: encryptionProvider
    });
    const accepted = await tasks.acceptMemoryAnswerTask(actor, {
      origin: "mcp",
      invocationKey: randomUUID(),
      maxQueued: 16,
      request: {
        input: {
          query: "retry usage",
          search_domain: "global",
          repository_context: null
        }
      }
    });
    const first = (
      await tasks.claimMemoryAnswerTask(actor, {
        leaseOwner: "run-a",
        leaseMs: 60_000
      })
    ).task!;
    const usage = (jobId: string, amount: number) => ({
      workflowType: "mcp_memory_answer",
      workflowId: jobId,
      answerJobId: jobId,
      memoryAnswerTaskId: accepted.id,
      totalTokens: amount,
      idempotencyKey: `usage:${jobId}`
    });
    const runA = usage(randomUUID(), 11),
      runB = usage(randomUUID(), 17);
    await repository.recordWorkflowTokenUsage(actor, runA);
    await repository.recordWorkflowTokenUsage(actor, runA);
    await expect(
      repository.recordWorkflowTokenUsage(otherActor, usage(randomUUID(), 99))
    ).rejects.toThrow(/not found|not authorized/);
    const workspace = await pool.query<{ id: string }>(
      `with team as (insert into teams (name, created_by_user_id) values ('Usage boundary', $1) returning id)
       insert into team_workspaces (team_id, name) select id, 'Usage boundary' from team returning id`,
      [actor.userId]
    );
    await pool.query(
      "update memory_answer_tasks set team_workspace_id=$2, team_authorization='{}'::jsonb where id=$1",
      [accepted.id, workspace.rows[0]!.id]
    );
    await expect(
      repository.recordWorkflowTokenUsage(actor, usage(randomUUID(), 99))
    ).rejects.toThrow(/not authorized/);
    await pool.query(
      "update memory_answer_tasks set team_workspace_id=null, team_authorization=null, lease_until=now()-interval '1 second' where id=$1",
      [accepted.id]
    );
    const second = (
      await tasks.claimMemoryAnswerTask(actor, {
        leaseOwner: "run-b",
        leaseMs: 60_000
      })
    ).task!;
    await repository.recordWorkflowTokenUsage(actor, runB);
    const completion = {
      taskId: accepted.id,
      finalQuestion: {
        idempotencyKey: randomUUID(),
        query: "retry usage",
        searchDomain: "global" as const,
        status: "answered" as const,
        answerMarkdown: "Retried answer",
        recallMetadata: {
          version: 1 as const,
          memoryStatus: "found" as const,
          caller: { name: "pi", version: "fixture" }
        }
      },
      result: { markdown: "Retried answer" }
    };
    expect(
      await tasks.completeMemoryAnswerTask(actor, {
        ...completion,
        leaseOwner: first.leaseOwner,
        fenceGeneration: first.fenceGeneration
      })
    ).toBeNull();
    const links = async () =>
      (
        await pool.query<{ count: string; total: string | null }>(
          `select count(*)::text as count, sum(u.total_tokens)::text as total
       from workflow_token_usage u join workflow_token_usage_source_references r on r.workflow_token_usage_id=u.id
       where u.owner_user_id=$1 and r.source_type='question'`,
          [actor.userId]
        )
      ).rows[0];
    expect(await links()).toEqual({ count: "0", total: null });
    const completed = await tasks.completeMemoryAnswerTask(actor, {
      ...completion,
      leaseOwner: second.leaseOwner,
      fenceGeneration: second.fenceGeneration
    });
    expect(completed?.questionId).toBeTruthy();
    const retainedMetadata = async () =>
      (
        await pool.query<{
          recall_metadata: {
            timing: {
              acceptedAt: string;
              completedAt: string;
              durationMs: number;
            };
            caller: { name: string };
            memoryStatus: string;
          };
        }>("select recall_metadata from memory_questions where id=$1", [
          completed!.questionId
        ])
      ).rows[0]!.recall_metadata;
    const metadata = await retainedMetadata();
    expect(metadata.memoryStatus).toBe("found");
    expect(metadata.caller.name).toBe("pi");
    expect(metadata.timing.acceptedAt).toBe(accepted.createdAt);
    expect(metadata.timing.completedAt).toBe(completed!.completedAt);
    expect(metadata.timing.durationMs).toBe(
      Date.parse(completed!.completedAt!) - Date.parse(accepted.createdAt)
    );
    expect(await links()).toEqual({ count: "2", total: "28" });
    expect(
      await tasks.completeMemoryAnswerTask(actor, {
        ...completion,
        leaseOwner: second.leaseOwner,
        fenceGeneration: second.fenceGeneration
      })
    ).toBeNull();
    await pool.query(
      "update memory_answer_tasks set expires_at=now()-interval '1 second' where id=$1",
      [accepted.id]
    );
    await tasks.deleteExpiredMemoryAnswerTasks(actor);
    expect(await tasks.getMemoryAnswerTask(actor, accepted.id)).toBeNull();
    expect(await retainedMetadata()).toEqual(metadata);
    expect(await links()).toEqual({ count: "2", total: "28" });
    expect(
      await repository.getMemoryQuestion(actor, completed!.questionId!)
    ).not.toBeNull();
  });

  it("aggregates forward-only Recall results, callers and individual durations", async () => {
    const { actor, repository } = await createActor("recall-metadata");
    const { actor: other } = await createActor("other-recall-owner");
    const outcomes = [
      "found",
      "found",
      "not_found",
      "insufficient",
      "pending_summary",
      null,
      null
    ] as const;
    const ids: string[] = [];
    for (let index = 0; index < outcomes.length; index++) {
      const durationMs = [1000, 3000, 9000][index];
      const question = await repository.createFinalMemoryQuestion(actor, {
        idempotencyKey: randomUUID(),
        query: "Synthetic metadata question",
        origin: "mcp_memory_answer",
        searchDomain: "global",
        ...(index === 5
          ? { status: "error" as const, errorMessage: "Synthetic error" }
          : {
              status: "answered" as const,
              answerMarkdown: "Synthetic answer"
            }),
        recallMetadata:
          index === 6
            ? undefined
            : {
                version: 1,
                memoryStatus: index === 5 ? "found" : outcomes[index]!,
                caller:
                  index === 4
                    ? null
                    : {
                        name: ["codex", "claude-code", "pi"][index % 3]!,
                        version: "fixture"
                      },
                ...(durationMs === undefined
                  ? {}
                  : {
                      timing: {
                        acceptedAt: "2026-11-10T10:00:00.000Z",
                        completedAt: new Date(
                          Date.parse("2026-11-10T10:00:00Z") + durationMs
                        ).toISOString(),
                        durationMs
                      }
                    })
              },
        localMemoryWorker: { provider: "claude", memoryStatus: "found" }
      });
      ids.push(question.id);
      await pool.query(
        "update memory_questions set created_at='2026-11-10T10:00:00Z' where id=$1",
        [question.id]
      );
    }
    const range = { from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" };
    const overview = await repository.getRecallActivityOverview(actor, {
      ...range,
      timezone: "UTC"
    });
    expect(overview.memoryResults).toEqual({
      found: 2,
      not_found: 1,
      insufficient: 1,
      pending_summary: 1,
      unknown: 2,
      foundPercentage: 200 / 3
    });
    expect(overview.medianDurationMs).toBe(3000);
    expect(overview.knownDurations).toBe(3);
    const filtered = await repository.listRecallActivity(actor, {
      ...range,
      limit: 50,
      memoryStatus: "found",
      callerName: "codex",
      maxDurationMs: 1000
    });
    expect(filtered.questions.map((q) => q.id)).toEqual([ids[0]]);
    const unknown = await repository.getRecallActivityOverview(actor, {
      ...range,
      timezone: "UTC",
      memoryStatus: "unknown"
    });
    expect(unknown.memoryResults.foundPercentage).toBeNull();
    expect(unknown.medianDurationMs).toBeNull();
    expect(
      (
        await repository.listRecallActivity(actor, {
          ...range,
          limit: 50,
          callerName: ""
        })
      ).questions
    ).toHaveLength(2);
    expect(await repository.getRecallActivity(actor, ids[0]!)).toMatchObject({
      worker: "claude",
      question: { metadata: { caller: { name: "codex" } } }
    });
    expect(
      (await repository.getRecallActivity(actor, ids[5]!))?.memoryStatus
    ).toBeNull();
    expect(await repository.getRecallActivity(other, ids[0]!)).toBeNull();
  });

  it("uses DST-aware half-open dates and usage observation time for Recall timelines", async () => {
    const { actor, repository } = await createActor("recall-dates");
    const ids: string[] = [];
    for (const createdAt of [
      "2026-03-28T23:59:59Z",
      "2026-03-29T00:00:00Z",
      "2026-03-29T23:30:00Z",
      "2026-03-30T23:00:00Z"
    ]) {
      const question = await repository.createFinalMemoryQuestion(actor, {
        idempotencyKey: randomUUID(),
        query: "Synthetic boundary",
        origin: "mcp_memory_answer",
        searchDomain: "global",
        status: "answered",
        answerMarkdown: "Synthetic"
      });
      await pool.query(
        "update memory_questions set created_at=$2 where id=$1",
        [question.id, createdAt]
      );
      ids.push(question.id);
    }
    const key = randomUUID();
    await repository.recordWorkflowTokenUsage(actor, {
      workflowType: "mcp_memory_answer",
      questionId: ids[2],
      totalTokens: 15,
      inputTokens: 10,
      outputTokens: 5,
      idempotencyKey: key
    });
    await pool.query(
      "update workflow_token_usage set observed_at='2026-03-29T22:30:00Z' where idempotency_key=$1",
      [key]
    );
    const range = {
      from: "2026-03-29T00:00:00Z",
      to: "2026-03-30T23:00:00Z",
      timezone: "Europe/London"
    };
    const overview = await repository.getRecallActivityOverview(actor, range);
    expect(overview.recordedQuestions).toBe(2);
    expect(overview.questions.map((q) => [q.start, q.count])).toEqual([
      ["2026-03-29T00:00:00.000000Z", 1],
      ["2026-03-29T23:00:00.000000Z", 1]
    ]);
    const firstDay = await repository.getRecallActivityOverview(actor, {
      ...range,
      to: "2026-03-29T23:00:00Z"
    });
    expect(firstDay.recordedQuestions).toBe(1);
    expect(firstDay.tokens.totalTokens).toBe(15);
    expect(
      (
        await repository.getRecallActivityOverview(actor, {
          ...range,
          from: "2026-03-29T23:00:00Z"
        })
      ).tokens.totalTokens
    ).toBeNull();
  });

  it.each([
    {
      timezone: "Europe/London",
      from: "2026-03-29T00:00:00Z",
      to: "2026-03-29T23:00:00Z",
      hours: 23
    },
    {
      timezone: "Europe/London",
      from: "2026-10-24T23:00:00Z",
      to: "2026-10-26T00:00:00Z",
      hours: 25
    },
    {
      timezone: "Asia/Kolkata",
      from: "2026-11-10T18:30:00Z",
      to: "2026-11-11T18:30:00Z",
      hours: 24
    }
  ])(
    "uses distinct hourly Recall and usage buckets for $hours-hour days in $timezone",
    async (range) => {
      const { actor, repository } = await createActor("recall-hourly");
      const ids: string[] = [];
      // Include both ends to prove the range is half-open. On the autumn date,
      // the middle records fall in the two different occurrences of 01:00.
      for (const offset of [0, 1, 2, range.hours]) {
        const question = await repository.createFinalMemoryQuestion(actor, {
          idempotencyKey: randomUUID(),
          query: "Synthetic hourly boundary",
          origin: "mcp_memory_answer",
          searchDomain: "global",
          status: "answered",
          answerMarkdown: "Synthetic"
        });
        const instant = new Date(
          Date.parse(range.from) + offset * 3_600_000
        ).toISOString();
        await pool.query(
          "update memory_questions set created_at=$2 where id=$1",
          [question.id, instant]
        );
        const key = randomUUID();
        await repository.recordWorkflowTokenUsage(actor, {
          workflowType: "mcp_memory_answer",
          questionId: question.id,
          totalTokens: 10,
          inputTokens: 8,
          outputTokens: 2,
          idempotencyKey: key
        });
        await pool.query(
          "update workflow_token_usage set observed_at=$2 where idempotency_key=$1",
          [key, instant]
        );
        ids.push(question.id);
      }
      const stats = await repository.getRecallActivityOverview(actor, {
        from: range.from,
        to: range.to,
        timezone: range.timezone,
        bucket: "hour"
      });
      const legacy = await repository.getRecallActivityOverview(actor, {
        from: range.from,
        to: range.to,
        timezone: range.timezone
      });
      expect(legacy.bucket).toBe("day");
      expect(legacy.recordedQuestions).toBe(stats.recordedQuestions);
      expect(stats.bucket).toBe("hour");
      expect(stats.questions).toHaveLength(range.hours);
      expect(stats.tokenTimeline).toHaveLength(range.hours);
      expect(new Set(stats.questions.map((point) => point.start)).size).toBe(
        range.hours
      );
      expect(stats.questions.slice(0, 3).map((point) => point.count)).toEqual([
        1, 1, 1
      ]);
      expect(stats.questions.slice(3).every((point) => point.count === 0)).toBe(
        true
      );
      expect(stats.recordedQuestions).toBe(3);
      expect(stats.tokens.totalTokens).toBe(30);
      expect(
        stats.tokenTimeline.slice(0, 3).map((point) => point.totalTokens)
      ).toEqual([10, 10, 10]);
      expect(
        stats.tokenTimeline
          .slice(3)
          .every((point) => point.totalTokens === null)
      ).toBe(true);
    }
  );

  it("reclaims expired leases, fences stale owners, and resolves cancellation races", async () => {
    const { actor } = await createActor("lease-owner");
    const tasks = createMemoryAnswerTaskRepository(pool, {
      envelopeEncryptionProvider: encryptionProvider
    });
    const accepted = await tasks.acceptMemoryAnswerTask(actor, {
      origin: "mcp",
      invocationKey: randomUUID(),
      maxQueued: 16,
      request: {
        input: {
          query: "lease test",
          search_domain: "global",
          repository_context: null
        },
        caller: { cwd: "/work" }
      }
    });
    const first = await tasks.claimMemoryAnswerTask(actor, {
      leaseOwner: `first-${randomUUID()}`,
      leaseMs: 1_000
    });
    expect(first.task?.fenceGeneration).toBe(1);
    await pool.query(
      "update memory_answer_tasks set lease_until = now() - interval '1 second' where id = $1",
      [accepted.id]
    );
    const second = await tasks.claimMemoryAnswerTask(actor, {
      leaseOwner: `second-${randomUUID()}`,
      leaseMs: 60_000
    });
    expect(second.task?.fenceGeneration).toBe(2);
    expect(
      await tasks.heartbeatMemoryAnswerTask(actor, {
        taskId: accepted.id,
        leaseOwner: first.task!.leaseOwner,
        fenceGeneration: first.task!.fenceGeneration,
        leaseMs: 60_000
      })
    ).toBeNull();

    expect(
      (await tasks.cancelMemoryAnswerTask(actor, accepted.id))?.status
    ).toBe("cancel_requested");
    expect(
      await tasks.completeMemoryAnswerTask(actor, {
        taskId: accepted.id,
        leaseOwner: second.task!.leaseOwner,
        fenceGeneration: second.task!.fenceGeneration,
        finalQuestion: {
          idempotencyKey: randomUUID(),
          query: "lease test",
          searchDomain: "global",
          status: "answered",
          answerMarkdown: "late result"
        },
        result: { markdown: "late result" }
      })
    ).toBeNull();
    expect(
      await tasks.failMemoryAnswerTask(actor, {
        taskId: accepted.id,
        leaseOwner: second.task!.leaseOwner,
        fenceGeneration: second.task!.fenceGeneration,
        errorCode: "cancelled",
        errorMessage: "cancelled by fixture",
        retry: true
      })
    ).toMatchObject({ status: "cancelled" });
  });

  it("encrypts terminal result and error payloads", async () => {
    const { actor } = await createActor("terminal-owner");
    const tasks = createMemoryAnswerTaskRepository(pool, {
      envelopeEncryptionProvider: encryptionProvider
    });
    const resultSecret = `result-${randomUUID()}`;
    const completedTask = await tasks.acceptMemoryAnswerTask(actor, {
      origin: "mcp",
      invocationKey: randomUUID(),
      maxQueued: 16,
      request: {
        input: {
          query: "result",
          search_domain: "global",
          repository_context: null
        },
        caller: { cwd: "/work" }
      }
    });
    const completedClaim = await tasks.claimMemoryAnswerTask(actor, {
      leaseOwner: `complete-${randomUUID()}`,
      leaseMs: 60_000
    });
    await tasks.completeMemoryAnswerTask(actor, {
      taskId: completedTask.id,
      leaseOwner: completedClaim.task!.leaseOwner,
      fenceGeneration: completedClaim.task!.fenceGeneration,
      finalQuestion: {
        idempotencyKey: randomUUID(),
        query: "result",
        searchDomain: "global",
        status: "answered",
        answerMarkdown: resultSecret
      },
      result: { markdown: resultSecret, question_id: randomUUID() }
    });

    const errorSecret = `error-${randomUUID()}`;
    const failedTask = await tasks.acceptMemoryAnswerTask(actor, {
      origin: "mcp",
      invocationKey: randomUUID(),
      maxQueued: 16,
      request: {
        input: {
          query: "error",
          search_domain: "global",
          repository_context: null
        },
        caller: { cwd: "/work" }
      }
    });
    const failedClaim = await tasks.claimMemoryAnswerTask(actor, {
      leaseOwner: `fail-${randomUUID()}`,
      leaseMs: 60_000
    });
    await tasks.failMemoryAnswerTask(actor, {
      taskId: failedTask.id,
      leaseOwner: failedClaim.task!.leaseOwner,
      fenceGeneration: failedClaim.task!.fenceGeneration,
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
    const completed = await tasks.getMemoryAnswerTask(actor, completedTask.id);
    expect(completed?.result?.question_id).toBe(completed?.questionId);
    const history = await pool.query<{ count: string }>(
      `select count(*)::text as count from memory_questions where owner_user_id = $1 and id = $2`,
      [actor.userId, completed?.questionId]
    );
    expect(history.rows[0]?.count).toBe("1");
    expect(await tasks.getMemoryAnswerTask(actor, failedTask.id)).toMatchObject(
      {
        status: "failed",
        lastErrorMessage: errorSecret
      }
    );
  });

  it("rolls back final history when terminal task persistence fails", async () => {
    const { actor } = await createActor("atomic-completion");
    const tasks = createMemoryAnswerTaskRepository(pool, {
      envelopeEncryptionProvider: encryptionProvider
    });
    const accepted = await tasks.acceptMemoryAnswerTask(actor, {
      origin: "mcp",
      maxQueued: 16,
      request: {
        input: {
          query: "atomic question",
          search_domain: "global",
          repository_context: null
        }
      }
    });
    const claim = await tasks.claimMemoryAnswerTask(actor, {
      leaseOwner: `worker-${randomUUID()}`,
      leaseMs: 60_000
    });
    await pool.query(
      `alter table memory_answer_tasks add constraint fixture_reject_completed check (status <> 'completed')`
    );
    try {
      await expect(
        tasks.completeMemoryAnswerTask(actor, {
          taskId: accepted.id,
          leaseOwner: claim.task!.leaseOwner,
          fenceGeneration: claim.task!.fenceGeneration,
          finalQuestion: {
            idempotencyKey: randomUUID(),
            query: "atomic question",
            searchDomain: "global",
            status: "answered",
            answerMarkdown: "atomic answer"
          },
          result: { markdown: "atomic answer" }
        })
      ).rejects.toThrow();
      const state = await pool.query<{
        status: string;
        question_id: string | null;
      }>(`select status, question_id from memory_answer_tasks where id = $1`, [
        accepted.id
      ]);
      expect(state.rows[0]).toMatchObject({
        status: "running",
        question_id: null
      });
      const history = await pool.query<{ count: string }>(
        `select count(*)::text as count from memory_questions where owner_user_id = $1`,
        [actor.userId]
      );
      expect(history.rows[0]?.count).toBe("0");
    } finally {
      await pool.query(
        `alter table memory_answer_tasks drop constraint fixture_reject_completed`
      );
    }
  });

  it("rolls back final history if the lease expires during final persistence", async () => {
    const { actor } = await createActor("slow-completion");
    const tasks = createMemoryAnswerTaskRepository(pool, {
      envelopeEncryptionProvider: encryptionProvider
    });
    const accepted = await tasks.acceptMemoryAnswerTask(actor, {
      origin: "mcp",
      maxQueued: 16,
      request: {
        input: {
          query: "slow question",
          search_domain: "global",
          repository_context: null
        }
      }
    });
    const claim = await tasks.claimMemoryAnswerTask(actor, {
      leaseOwner: `worker-${randomUUID()}`,
      leaseMs: 60_000
    });
    await pool.query(
      `create function fixture_delay_final_question() returns trigger language plpgsql as $$ begin perform pg_sleep(0.2); return new; end $$`
    );
    await pool.query(
      `create trigger fixture_delay_final_question before insert on memory_questions for each row execute function fixture_delay_final_question()`
    );
    try {
      await pool.query(
        `update memory_answer_tasks set lease_until = clock_timestamp() + interval '100 milliseconds' where id = $1`,
        [accepted.id]
      );
      expect(
        await tasks.completeMemoryAnswerTask(actor, {
          taskId: accepted.id,
          leaseOwner: claim.task!.leaseOwner,
          fenceGeneration: claim.task!.fenceGeneration,
          finalQuestion: {
            idempotencyKey: randomUUID(),
            query: "slow question",
            searchDomain: "global",
            status: "answered",
            answerMarkdown: "answer"
          },
          result: { markdown: "answer" }
        })
      ).toBeNull();
      const history = await pool.query<{ count: string }>(
        `select count(*)::text as count from memory_questions where owner_user_id = $1`,
        [actor.userId]
      );
      expect(history.rows[0]?.count).toBe("0");
      expect(await tasks.getMemoryAnswerTask(actor, accepted.id)).toMatchObject(
        { status: "running", questionId: null }
      );
    } finally {
      await pool.query(
        `drop trigger fixture_delay_final_question on memory_questions`
      );
      await pool.query(`drop function fixture_delay_final_question()`);
    }
  });

  it("enforces the durable backlog bound without rejecting an idempotent retry", async () => {
    const { actor } = await createActor("bounded-queue");
    const tasks = createMemoryAnswerTaskRepository(pool, {
      envelopeEncryptionProvider: encryptionProvider
    });
    const invocationKey = randomUUID();
    const first = await tasks.acceptMemoryAnswerTask(actor, {
      origin: "mcp",
      invocationKey,
      maxQueued: 1,
      request: {
        input: {
          query: "first",
          search_domain: "global",
          repository_context: null
        },
        caller: { cwd: "/work" }
      }
    });

    await expect(
      tasks.acceptMemoryAnswerTask(actor, {
        origin: "mcp",
        invocationKey: randomUUID(),
        maxQueued: 1,
        request: {
          input: {
            query: "second",
            search_domain: "global",
            repository_context: null
          },
          caller: { cwd: "/work" }
        }
      })
    ).rejects.toMatchObject({
      name: "MemoryAnswerTaskQueueFullError",
      statusCode: 429
    });
    await expect(
      tasks.acceptMemoryAnswerTask(actor, {
        origin: "mcp",
        invocationKey,
        maxQueued: 1,
        request: {
          input: {
            query: "duplicate",
            search_domain: "global",
            repository_context: null
          },
          caller: { cwd: "/work" }
        }
      })
    ).resolves.toMatchObject({ id: first.id });
  });

  it("rolls back a claim when its encrypted request cannot be loaded", async () => {
    const { actor } = await createActor("claim-decryption");
    const tasks = createMemoryAnswerTaskRepository(pool, {
      envelopeEncryptionProvider: encryptionProvider
    });
    const accepted = await tasks.acceptMemoryAnswerTask(actor, {
      origin: "mcp",
      invocationKey: randomUUID(),
      maxQueued: 16,
      request: {
        input: {
          query: "decrypt",
          search_domain: "global",
          repository_context: null
        },
        caller: { cwd: "/work" }
      }
    });
    await pool.query(
      `delete from encrypted_field_payloads
        where source_table = 'memory_answer_tasks' and source_id = $1`,
      [accepted.id]
    );

    await expect(
      tasks.claimMemoryAnswerTask(actor, {
        leaseOwner: `claim-${randomUUID()}`,
        leaseMs: 1_000
      })
    ).rejects.toThrow("request_snapshot is missing");
    await expect(
      tasks.getMemoryAnswerTask(actor, accepted.id)
    ).resolves.toMatchObject({
      status: "accepted",
      attemptCount: 0,
      fenceGeneration: 0
    });
  });

  it("returns terminal lease reconciliation alongside the next claim", async () => {
    const { actor } = await createActor("claim-reconciliation");
    const tasks = createMemoryAnswerTaskRepository(pool, {
      envelopeEncryptionProvider: encryptionProvider
    });
    const accepted = await tasks.acceptMemoryAnswerTask(actor, {
      origin: "mcp",
      invocationKey: randomUUID(),
      maxQueued: 16,
      maxAttempts: 1,
      request: {
        input: {
          query: "expire",
          search_domain: "global",
          repository_context: null
        },
        caller: { cwd: "/work" }
      }
    });
    await tasks.claimMemoryAnswerTask(actor, {
      leaseOwner: `first-${randomUUID()}`,
      leaseMs: 1_000
    });
    await pool.query(
      "update memory_answer_tasks set lease_until = now() - interval '1 second' where id = $1",
      [accepted.id]
    );

    await expect(
      tasks.claimMemoryAnswerTask(actor, {
        leaseOwner: `second-${randomUUID()}`,
        leaseMs: 1_000
      })
    ).resolves.toMatchObject({
      task: null,
      reconciled: [
        {
          id: accepted.id,
          status: "failed",
          lastErrorCode: "attempts_exhausted"
        }
      ]
    });
  });

  it("bounds expired-lease reconciliation and recovers the remaining queue on later claims", async () => {
    const { actor } = await createActor("bounded-reconciliation");
    const tasks = createMemoryAnswerTaskRepository(pool, {
      envelopeEncryptionProvider: encryptionProvider
    });
    for (let i = 0; i < 17; i += 1) {
      await tasks.acceptMemoryAnswerTask(actor, {
        origin: "mcp",
        maxQueued: 32,
        maxAttempts: 1,
        request: {
          input: {
            query: `expired ${i}`,
            search_domain: "global",
            repository_context: null
          }
        }
      });
    }
    await pool.query(
      "update memory_answer_tasks set status = 'running', attempt_count = 1, lease_owner = 'expired', lease_until = now() - interval '1 second' where owner_user_id = $1",
      [actor.userId]
    );
    const first = await tasks.claimMemoryAnswerTask(actor, {
      leaseOwner: "cleanup",
      leaseMs: 60_000
    });
    expect(first.task).toBeNull();
    expect(first.reconciled).toHaveLength(16);
    expect(
      first.reconciled.every(
        (task) =>
          task.status === "failed" &&
          task.lastErrorCode === "attempts_exhausted"
      )
    ).toBe(true);
    const second = await tasks.claimMemoryAnswerTask(actor, {
      leaseOwner: "cleanup",
      leaseMs: 60_000
    });
    expect(second.task).toBeNull();
    expect(second.reconciled).toHaveLength(1);
    expect(
      new Set(
        [...first.reconciled, ...second.reconciled].map((task) => task.id)
      ).size
    ).toBe(17);
  });

  it("leaves future work and live leases unlocked while competing workers claim ready tasks", async () => {
    const { actor } = await createActor("concurrent-claims");
    const tasks = createMemoryAnswerTaskRepository(pool, {
      envelopeEncryptionProvider: encryptionProvider
    });
    const accepted = [];
    for (let i = 0; i < 4; i += 1) {
      accepted.push(
        await tasks.acceptMemoryAnswerTask(actor, {
          origin: "mcp",
          maxQueued: 16,
          request: {
            input: {
              query: `question ${i}`,
              search_domain: "global",
              repository_context: null
            }
          }
        })
      );
    }
    await tasks.claimMemoryAnswerTask(actor, {
      leaseOwner: "live",
      leaseMs: 60_000
    });
    await pool.query(
      "update memory_answer_tasks set available_at = now() + interval '1 hour' where id = $1",
      [accepted[1]!.id]
    );
    let resume!: () => void;
    let started!: () => void;
    const paused = new Promise<void>((resolve) => {
      started = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const blockedTasks = createMemoryAnswerTaskRepository(pool, {
      envelopeEncryptionProvider: {
        mode: encryptionProvider.mode,
        keyId: encryptionProvider.keyId,
        keyVersion: encryptionProvider.keyVersion,
        encrypt: (input) => encryptionProvider.encrypt(input),
        decrypt: async (envelope) => {
          started();
          await resumed;
          return encryptionProvider.decrypt(envelope);
        }
      }
    });
    const first = blockedTasks.claimMemoryAnswerTask(actor, {
      leaseOwner: "paused",
      leaseMs: 60_000
    });
    await paused;
    const competing = await pool.connect();
    let second: ReturnType<typeof tasks.claimMemoryAnswerTask> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await competing.query("begin");
      await competing.query("set local lock_timeout = '200ms'");
      for (const task of accepted.slice(0, 2)) {
        await competing.query(
          "select id from memory_answer_tasks where id = $1 for update",
          [task.id]
        );
      }
      await competing.query("commit");
      second = tasks.claimMemoryAnswerTask(actor, {
        leaseOwner: "competing",
        leaseMs: 60_000
      });
      expect(
        await Promise.race([
          second,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("competing claim blocked")),
              1_000
            );
          })
        ])
      ).toMatchObject({ task: { id: accepted[3]!.id } });
    } finally {
      if (timeout) clearTimeout(timeout);
      resume();
      await first;
      await second;
      await competing.query("rollback");
      competing.release();
    }
    expect((await first).task?.id).toBe(accepted[2]!.id);
  });

  it("retires revoked Team tasks and permits owner cancellation without decrypting protected payloads", async () => {
    const { actor } = await createActor("revoked-team");
    const team = await pool.query<{ id: string }>(
      "insert into teams(name,entitlement_status) values('Task Team','active') returning id"
    );
    const teamId = team.rows[0]!.id;
    const workspace = await pool.query<{ id: string }>(
      "insert into team_workspaces(team_id,name) values($1,'Task Workspace') returning id",
      [teamId]
    );
    const teamWorkspaceId = workspace.rows[0]!.id;
    await pool.query(
      "insert into team_memberships(team_id,user_id,role,status,accepted_at) values($1,$2,'owner','enabled',now())",
      [teamId, actor.userId]
    );
    await pool.query(
      "insert into team_workspace_access_grants(team_workspace_id,team_id,user_id,access,granted_by_user_id) values($1,$2,$3,'write',$3)",
      [teamWorkspaceId, teamId, actor.userId]
    );
    const teamActor = { ...actor, allowTeam: true };
    const tasks = createMemoryAnswerTaskRepository(pool, {
      envelopeEncryptionProvider: encryptionProvider
    });
    const accept = () =>
      tasks.acceptMemoryAnswerTask(teamActor, {
        origin: "mcp",
        teamWorkspaceId,
        maxQueued: 2,
        request: {
          input: {
            query: "protected question",
            team_workspace_id: teamWorkspaceId
          }
        }
      });
    const first = await accept();
    const second = await accept();
    const running = await tasks.claimMemoryAnswerTask(teamActor, {
      leaseOwner: "revoked-worker",
      leaseMs: 60_000,
      allowTeam: true,
      scopeFilter: "team"
    });
    expect(running.task?.id).toBe(first.id);
    await pool.query(
      "update team_memberships set status='disabled',disabled_at=now(),version=version+1 where user_id=$1",
      [actor.userId]
    );
    await pool.query(
      `update memory_answer_tasks
          set last_error_message = '[koed encrypted memory answer task]',
              status_message = 'protected progress', invocation_key = 'protected invocation'
        where id = $1`,
      [first.id]
    );
    const noDecrypt = createMemoryAnswerTaskRepository(pool, {
      envelopeEncryptionProvider: {
        mode: encryptionProvider.mode,
        keyId: encryptionProvider.keyId,
        keyVersion: encryptionProvider.keyVersion,
        encrypt: (input) => encryptionProvider.encrypt(input),
        decrypt: () => {
          throw new Error("protected data must not be decrypted");
        }
      }
    });
    await expect(
      noDecrypt.cancelMemoryAnswerTask(actor, first.id)
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      noDecrypt.getMemoryAnswerTask(teamActor, first.id)
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(
      await noDecrypt.cancelMemoryAnswerTask(teamActor, first.id)
    ).toMatchObject({
      status: "cancelled",
      result: null,
      lastErrorMessage: null,
      invocationKey: null,
      statusMessage: null,
      fenceGeneration: running.task!.fenceGeneration + 1
    });
    expect(
      await noDecrypt.claimMemoryAnswerTask(teamActor, {
        leaseOwner: "cleanup",
        leaseMs: 60_000,
        allowTeam: true,
        scopeFilter: "team"
      })
    ).toMatchObject({
      task: null,
      reconciled: [
        {
          id: second.id,
          status: "failed",
          lastErrorCode: "team_authority_revoked",
          result: null
        }
      ]
    });
    const recovered = await tasks.acceptMemoryAnswerTask(actor, {
      origin: "mcp",
      maxQueued: 1,
      request: {
        input: {
          query: "new personal work",
          search_domain: "global",
          repository_context: null
        }
      }
    });
    expect(recovered.status).toBe("accepted");
    await expect(
      noDecrypt.heartbeatMemoryAnswerTask(teamActor, {
        taskId: first.id,
        leaseOwner: running.task!.leaseOwner,
        fenceGeneration: running.task!.fenceGeneration,
        leaseMs: 60_000
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it("retains encrypted Project context across worker replacement and repeated owner collection", async () => {
    const { actor } = await createActor("pinned-project");
    const options = { envelopeEncryptionProvider: encryptionProvider };
    const tasks = createMemoryAnswerTaskRepository(pool, options);
    const context: RepositoryIdentity = {
      kind: "portable_repository",
      key: "gr_pinned_fixture",
      root: "/original-checkout",
      branch: "main",
      reason: "origin",
      checkoutId: "checkout_fixture",
      originatingDeviceId: "fixture_device",
      selectedRemote: "origin",
      anchorDisplay: "example.test/team/fixture"
    };
    const projectId = repositoryScopeId(context);
    const request = {
      input: {
        query: "pinned repository decision",
        search_domain: "project",
        project_id: projectId,
        repository_context: context
      },
      caller: { cwd: "/original-checkout/subdirectory" }
    };
    const accepted = await tasks.acceptMemoryAnswerTask(actor, {
      origin: "mcp",
      maxQueued: 16,
      request
    });
    const first = await tasks.claimMemoryAnswerTask(actor, {
      leaseOwner: "first-worker",
      leaseMs: 1000
    });
    expect(first.task?.request).toMatchObject({
      ...request,
      requestVersion: 1,
      selection: {
        version: 0,
        ownerUserId: actor.userId,
        target: { kind: "legacy_project", repository: context }
      }
    });
    await pool.query(
      "update memory_answer_tasks set lease_until=now()-interval '1 second' where id=$1",
      [accepted.id]
    );
    const restarted = createMemoryAnswerTaskRepository(pool, options);
    const second = await restarted.claimMemoryAnswerTask(actor, {
      leaseOwner: "restarted-worker",
      leaseMs: 60000
    });
    expect(second.task?.request).toEqual(first.task?.request);
    const result = {
      markdown: "The pinned repository uses the cobalt checklist."
    };
    await restarted.completeMemoryAnswerTask(actor, {
      taskId: accepted.id,
      leaseOwner: second.task!.leaseOwner,
      fenceGeneration: second.task!.fenceGeneration,
      finalQuestion: {
        idempotencyKey: randomUUID(),
        query: request.input.query,
        searchDomain: "project",
        projectId,
        status: "answered",
        answerMarkdown: result.markdown
      },
      result
    });
    const collected = (await restarted.getMemoryAnswerTask(actor, accepted.id))
      ?.result;
    expect(collected).toMatchObject(result);
    expect(
      (await tasks.getMemoryAnswerTask(actor, accepted.id))?.result
    ).toEqual(collected);
    expect(
      (
        await restarted.claimMemoryAnswerTask(actor, {
          leaseOwner: "another-worker",
          leaseMs: 60000
        })
      ).task
    ).toBeNull();
    await expect(
      tasks.acceptMemoryAnswerTask(actor, {
        origin: "mcp",
        maxQueued: 16,
        request: {
          input: {
            query: "unresolved",
            search_domain: "project",
            project_id: "/old-path"
          }
        }
      })
    ).rejects.toThrow();
  });
  it.each([
    null,
    {
      kind: "portable_repository",
      key: "gr_global_pinned",
      root: "/accepted",
      branch: "main",
      reason: "origin",
      checkoutId: "checkout_global",
      originatingDeviceId: "fixture_device",
      selectedRemote: "origin",
      anchorDisplay: "example.test/team/global"
    } satisfies RepositoryIdentity
  ])(
    "persists Global context through encrypted lease recovery: %j",
    async (context) => {
      const { actor } = await createActor("global-pinned");
      const options = { envelopeEncryptionProvider: encryptionProvider };
      const tasks = createMemoryAnswerTaskRepository(pool, options);
      const request = {
        input: {
          query: "cross-project decisions",
          search_domain: "global",
          repository_context: context
        },
        caller: { cwd: "/accepted" }
      };
      const accepted = await tasks.acceptMemoryAnswerTask(actor, {
        origin: "mcp",
        maxQueued: 16,
        request
      });
      const first = await tasks.claimMemoryAnswerTask(actor, {
        leaseOwner: "original",
        leaseMs: 1000
      });
      expect(first.task?.request).toMatchObject({
        ...request,
        requestVersion: 1,
        selection: {
          version: 0,
          ownerUserId: actor.userId,
          target: { kind: "global" },
          callerRepositoryContext: context
        }
      });
      await pool.query(
        "update memory_answer_tasks set lease_until=now()-interval '1 second' where id=$1",
        [accepted.id]
      );
      const restarted = createMemoryAnswerTaskRepository(pool, options);
      const retry = await restarted.claimMemoryAnswerTask(actor, {
        leaseOwner: "restarted",
        leaseMs: 60000
      });
      expect(retry.task?.request).toEqual(first.task?.request);
      await expect(
        tasks.acceptMemoryAnswerTask(actor, {
          origin: "mcp",
          maxQueued: 16,
          request: { input: { query: "unpinned", search_domain: "global" } }
        })
      ).rejects.toThrow("pinned repository context");
    }
  );
});
