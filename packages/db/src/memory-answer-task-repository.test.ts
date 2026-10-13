import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { describe, expect, it } from "vitest";
import { createMemoryAnswerTaskRepository } from "./memory-answer-task-repository.js";

const ownerId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-09-10T12:00:00.000Z");
const parseJson = (value: unknown): unknown =>
  JSON.parse(String(value)) as unknown;

interface TaskFixtureRow {
  id: string;
  owner_user_id: string;
  team_workspace_id: string | null;
  team_authorization: Record<string, unknown> | null;
  origin: string;
  invocation_key: string | null;
  request_snapshot: Record<string, unknown>;
  result_snapshot: Record<string, unknown> | null;
  question_id: string | null;
  status: string;
  status_message: string | null;
  attempt_count: number;
  max_attempts: number;
  available_at: Date;
  lease_owner: string | null;
  lease_until: Date | null;
  fence_generation: number;
  cancel_requested_at: Date | null;
  cancelled_at: Date | null;
  started_at: Date | null;
  last_progress_at: Date | null;
  completed_at: Date | null;
  failed_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
  version: number;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

const taskRow = (input: {
  id: string;
  ownerId: string;
  origin?: string;
  invocationKey?: string | null;
  requestSnapshot?: Record<string, unknown>;
  status?: string;
}): TaskFixtureRow => ({
  id: input.id,
  owner_user_id: input.ownerId,
  team_workspace_id: null,
  team_authorization: null,
  origin: input.origin ?? "mcp",
  invocation_key: input.invocationKey ?? null,
  request_snapshot: input.requestSnapshot ?? {},
  result_snapshot: null,
  question_id: null,
  status: input.status ?? "accepted",
  status_message: null,
  attempt_count: 0,
  max_attempts: 3,
  available_at: now,
  lease_owner: null,
  lease_until: null,
  fence_generation: 0,
  cancel_requested_at: null,
  cancelled_at: input.status === "cancelled" ? now : null,
  started_at: null,
  last_progress_at: null,
  completed_at: null,
  failed_at: null,
  last_error_code: null,
  last_error_message: null,
  version: input.status === "cancelled" ? 2 : 1,
  expires_at: new Date("2026-09-11T12:00:00.000Z"),
  created_at: now,
  updated_at: now
});

class AcceptPool {
  encryptedValues: unknown[] | null = null;

  async connect(): Promise<pg.PoolClient> {
    return {
      query: this.query.bind(this),
      release: () => undefined
    } as unknown as pg.PoolClient;
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: unknown[] = []
  ): Promise<pg.QueryResult<T>> {
    const sql = text.replace(/\s+/g, " ").trim();
    if (["begin", "commit", "rollback"].includes(sql)) {
      return { rows: [], rowCount: null } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("select id from users")) {
      return {
        rows: [{ id: ownerId }],
        rowCount: 1
      } as unknown as pg.QueryResult<T>;
    }
    if (sql.includes("and origin = $2 and invocation_key = $3")) {
      return { rows: [], rowCount: 0 } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("select count(*)::text as count")) {
      return {
        rows: [{ count: "0" }],
        rowCount: 1
      } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("insert into memory_answer_tasks")) {
      return {
        rows: [
          taskRow({
            id: String(values[0]),
            ownerId: String(values[1]),
            origin: String(values[2]),
            invocationKey: String(values[3]),
            requestSnapshot: parseJson(values[4]) as Record<string, unknown>
          })
        ],
        rowCount: 1
      } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("insert into encrypted_field_payloads")) {
      this.encryptedValues = values;
      return {
        rows: [
          {
            id: randomUUID(),
            owner_user_id: values[0],
            owner_principal_id: values[1],
            team_id: values[2],
            team_workspace_id: values[3],
            visibility: values[4],
            encryption_scope: values[5],
            source_table: values[6],
            source_id: values[7],
            source_column: values[8],
            plaintext_content_type: values[9],
            plaintext_encoding: values[10],
            envelope_version: values[11],
            provider_mode: values[12],
            key_id: values[13],
            key_version: values[14],
            scope: parseJson(values[15]),
            provenance: parseJson(values[16]),
            algorithm: values[17],
            ciphertext: values[18],
            nonce: values[19],
            tag: values[20],
            wrapped_dek: parseJson(values[21]),
            ciphertext_location: values[22],
            aad: parseJson(values[23]),
            envelope_created_at: new Date(String(values[24])),
            envelope_reencrypted_at: values[25]
              ? new Date(String(values[25]))
              : null,
            created_at: now,
            updated_at: now
          }
        ],
        rowCount: 1
      } as unknown as pg.QueryResult<T>;
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

class OwnedTaskPool extends AcceptPool {
  readonly statements: string[] = [];
  constructor(readonly row: TaskFixtureRow) {
    super();
  }
  override async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: unknown[] = []
  ): Promise<pg.QueryResult<T>> {
    const sql = text.replace(/\s+/g, " ").trim();
    this.statements.push(sql);
    if (
      sql.startsWith("select") &&
      sql.includes("from memory_answer_tasks") &&
      sql.includes("where id = $2")
    ) {
      return { rows: [this.row], rowCount: 1 } as unknown as pg.QueryResult<T>;
    }
    return super.query<T>(text, values);
  }
}

describe("Memory Answer task repository", () => {
  it("keeps Team-only execution credentials out of Personal tasks", async () => {
    const row = taskRow({ id: randomUUID(), ownerId });
    const pool = new OwnedTaskPool(row);
    const repository = createMemoryAnswerTaskRepository(
      pool as unknown as pg.Pool
    );
    await expect(
      repository.getMemoryAnswerTask(
        { userId: ownerId, allowPersonal: false, allowTeam: true },
        row.id
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(pool.statements.at(-1)).toBe("rollback");
  });
  it("requires trusted Team capability before reading owner-private Team payloads", async () => {
    const row = {
      ...taskRow({ id: randomUUID(), ownerId }),
      team_workspace_id: randomUUID(),
      team_authorization: { version: 1 },
      result_snapshot: { contentEncrypted: true }
    };
    const pool = new OwnedTaskPool(row);
    const repository = createMemoryAnswerTaskRepository(
      pool as unknown as pg.Pool
    );
    await expect(
      repository.getMemoryAnswerTask({ userId: ownerId }, row.id)
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(pool.statements.at(-1)).toBe("rollback");
  });

  it("rejects Team acceptance without trusted credential capability", async () => {
    const pool = new AcceptPool();
    const repository = createMemoryAnswerTaskRepository(
      pool as unknown as pg.Pool,
      {
        envelopeEncryptionProvider:
          createLocalTestKeyEnvelopeEncryptionProvider(
            randomBytes(32).toString("base64url")
          )
      }
    );
    await expect(
      repository.acceptMemoryAnswerTask(
        { userId: ownerId },
        {
          origin: "mcp",
          teamWorkspaceId: randomUUID(),
          request: { input: { query: "question" } },
          maxQueued: 16
        }
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("ignores stale completion fences without writing final history", async () => {
    const row = {
      ...taskRow({ id: randomUUID(), ownerId, status: "running" }),
      lease_owner: "live-worker",
      fence_generation: 2
    };
    const pool = new OwnedTaskPool(row);
    const repository = createMemoryAnswerTaskRepository(
      pool as unknown as pg.Pool
    );
    expect(
      await repository.completeMemoryAnswerTask(
        { userId: ownerId },
        {
          taskId: row.id,
          leaseOwner: "stale-worker",
          fenceGeneration: 1,
          finalQuestion: {
            idempotencyKey: "final",
            query: "question",
            searchDomain: "global",
            status: "answered",
            answerMarkdown: "answer"
          },
          result: {}
        }
      )
    ).toBeNull();
    expect(pool.statements.at(-1)).toBe("rollback");
  });
  it("accepts an idempotent owner task without storing request plaintext", async () => {
    const pool = new AcceptPool();
    const repository = createMemoryAnswerTaskRepository(
      pool as unknown as pg.Pool,
      {
        envelopeEncryptionProvider:
          createLocalTestKeyEnvelopeEncryptionProvider(
            randomBytes(32).toString("base64url")
          )
      }
    );
    const secretQuery = "private launch decision marker";

    const task = await repository.acceptMemoryAnswerTask(
      { userId: ownerId },
      {
        origin: "mcp",
        invocationKey: "adapter:call-1",
        maxQueued: 16,
        request: { input: { query: secretQuery }, caller: { cwd: "/private" } }
      }
    );

    expect(task).toMatchObject({
      origin: "mcp",
      invocationKey: "adapter:call-1",
      status: "accepted"
    });
    expect(pool.encryptedValues).not.toBeNull();
    expect(JSON.stringify(pool.encryptedValues)).not.toContain(secretQuery);
    expect(pool.encryptedValues?.[6]).toBe("memory_answer_tasks");
    expect(pool.encryptedValues?.[8]).toBe("request_snapshot");
  });
});
