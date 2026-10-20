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
