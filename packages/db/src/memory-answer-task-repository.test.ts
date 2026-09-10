import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { describe, expect, it } from "vitest";
import { createMemoryAnswerTaskRepository } from "./memory-answer-task-repository.js";

const ownerId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-09-10T12:00:00.000Z");
const parseJson = (value: unknown): unknown =>
  JSON.parse(String(value)) as unknown;

const taskRow = (input: {
  id: string;
  ownerId: string;
  origin?: string;
  invocationKey?: string | null;
  requestSnapshot?: Record<string, unknown>;
  status?: string;
}) => ({
  id: input.id,
  owner_user_id: input.ownerId,
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

describe("Memory Answer task repository", () => {
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
