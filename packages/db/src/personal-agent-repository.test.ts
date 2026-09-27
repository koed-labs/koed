import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { describe, expect, it } from "vitest";
import { createPersonalAgentRepository } from "./personal-agent-repository.js";

const ownerId = "11111111-1111-4111-8111-111111111111";
const otherOwnerId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-09-22T12:00:00.000Z");

const rowIdentity = (input: {
  id: string;
  ownerUserId: string;
  lifecycle?: "active" | "retired";
  currentVersion?: number;
}): Record<string, unknown> => ({
  id: input.id,
  owner_user_id: input.ownerUserId,
  name: "Atlas",
  role: "Project assistant",
  avatar_reference: "pixelkin:atlas",
  lifecycle: input.lifecycle ?? "active",
  default_provider: "codex",
  default_model: "gpt-5.6",
  default_reasoning_effort: "high",
  current_version: input.currentVersion ?? 1,
  created_at: now,
  updated_at: now,
  retired_at: input.lifecycle === "retired" ? now : null
});

class PersonalAgentPool {
  readonly identityId = randomUUID();
  readonly versionId = randomUUID();
  encryptedValues: unknown[] | null = null;
  versionRow: Record<string, unknown> = {
    id: this.versionId,
    agent_id: this.identityId,
    owner_user_id: ownerId,
    version: 1,
    name: "Atlas",
    role: "Project assistant",
    avatar_reference: "pixelkin:atlas",
    default_provider: "codex",
    default_model: "gpt-5.6",
    default_reasoning_effort: "high",
    soul_instructions: "[koed encrypted personal agent soul]",
    instruction_source: "custom",
    created_by_user_id: ownerId,
    request_id: randomUUID(),
    request_fingerprint: "a".repeat(64),
    created_at: now
  };

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
    const sql = text.replace(/\s+/g, " ").trim().toLowerCase();
    if (["begin", "commit", "rollback"].includes(sql)) {
      return { rows: [], rowCount: 0 } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("select pg_advisory_xact_lock")) {
      return { rows: [], rowCount: 1 } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("insert into personal_agent_identities")) {
      return {
        rows: [rowIdentity({ id: this.identityId, ownerUserId: ownerId })],
        rowCount: 1
      } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("insert into personal_agent_identity_versions")) {
      return {
        rows: [this.versionRow],
        rowCount: 1
      } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("insert into encrypted_field_payloads")) {
      this.encryptedValues = values;
      const parse = (value: unknown): unknown => JSON.parse(String(value));
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
            scope: parse(values[15]),
            provenance: parse(values[16]),
            algorithm: values[17],
            ciphertext: values[18],
            nonce: values[19],
            tag: values[20],
            wrapped_dek: parse(values[21]),
            ciphertext_location: values[22],
            aad: parse(values[23]),
            envelope_created_at: now,
            envelope_reencrypted_at: values[25],
            created_at: now,
            updated_at: now
          }
        ],
        rowCount: 1
      } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("select id, agent_id, owner_user_id, version")) {
      return {
        rows: [this.versionRow],
        rowCount: 1
      } as unknown as pg.QueryResult<T>;
    }
    if (sql.includes("from encrypted_field_payloads")) {
      const values = this.encryptedValues ?? [];
      const parse = (value: unknown): unknown => JSON.parse(String(value));
      return {
        rows: values.length
          ? [
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
                scope: parse(values[15]),
                provenance: parse(values[16]),
                algorithm: values[17],
                ciphertext: values[18],
                nonce: values[19],
                tag: values[20],
                wrapped_dek: parse(values[21]),
                ciphertext_location: values[22],
                aad: parse(values[23]),
                envelope_created_at: now,
                envelope_reencrypted_at: values[25],
                created_at: now,
                updated_at: now
              }
            ]
          : [],
        rowCount: values.length ? 1 : 0
      } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("select id, owner_user_id, conversation_id")) {
      return { rows: [], rowCount: 0 } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("select state, count(*)::text as count")) {
      return { rows: [], rowCount: 0 } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("select status, count(*)::text as count")) {
      return { rows: [], rowCount: 0 } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("select count(distinct a.id) filter")) {
      return {
        rows: [{ persisted_count: "0", verified_count: "0", observed_at: now }],
        rowCount: 1
      } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("select count(distinct project_id)::text as count")) {
      return {
        rows: [{ count: "0" }],
        rowCount: 1
      } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("with agent_projects as")) {
      return { rows: [], rowCount: 0 } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("select id, owner_user_id, name, role")) {
      const requestedOwner = String(values[1]);
      return {
        rows:
          requestedOwner === ownerId
            ? [rowIdentity({ id: this.identityId, ownerUserId: ownerId })]
            : [],
        rowCount: requestedOwner === ownerId ? 1 : 0
      } as unknown as pg.QueryResult<T>;
    }
    if (
      sql.startsWith("update personal_agent_identities") &&
      sql.includes("lifecycle = 'retired'")
    ) {
      return {
        rows: [
          rowIdentity({
            id: this.identityId,
            ownerUserId: ownerId,
            lifecycle: "retired"
          })
        ],
        rowCount: 1
      } as unknown as pg.QueryResult<T>;
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

class CompletionReplayPool extends PersonalAgentPool {
  readonly jobId = randomUUID();
  readonly attemptId = randomUUID();
  readonly otherAttemptId = randomUUID();
  readonly conversationId = randomUUID();

  override async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: unknown[] = []
  ): Promise<pg.QueryResult<T>> {
    const sql = text.replace(/\s+/g, " ").trim().toLowerCase();
    if (["begin", "commit", "rollback"].includes(sql)) {
      return { rows: [], rowCount: 0 } as unknown as pg.QueryResult<T>;
    }
    if (
      sql.includes("from personal_agent_execution_jobs") &&
      sql.includes("for update")
    ) {
      return {
        rows: [
          {
            id: this.jobId,
            owner_user_id: ownerId,
            conversation_id: this.conversationId
          }
        ],
        rowCount: 1
      } as unknown as pg.QueryResult<T>;
    }
    if (
      sql.includes("from personal_agent_execution_attempts") &&
      sql.includes("for update")
    ) {
      return {
        rows: [
          {
            id: this.attemptId,
            owner_user_id: ownerId,
            job_id: this.jobId,
            attempt_number: 1,
            attribution_kind: "agent",
            agent_id: this.identityId,
            agent_version: 1,
            provider: "codex",
            model: "gpt-5.6",
            ai_client_instance_id: "codex-app-server",
            reasoning_effort: "high",
            permission_mode: "supervised",
            managed_execution_id: this.conversationId,
            managed_execution_generation: 1,
            status: "running",
            outcome: null,
            started_at: now,
            completed_at: null
          }
        ],
        rowCount: 1
      } as unknown as pg.QueryResult<T>;
    }
    if (sql.includes("from personal_agent_execution_job_events")) {
      return {
        rows: [
          { payload: { attemptId: this.otherAttemptId, outcome: "succeeded" } }
        ],
        rowCount: 1
      } as unknown as pg.QueryResult<T>;
    }
    throw new Error(`Unexpected SQL: ${sql}; values=${JSON.stringify(values)}`);
  }
}

const createRepository = (pool: PersonalAgentPool, plaintext = "") => {
  const provider = createLocalTestKeyEnvelopeEncryptionProvider(
    randomBytes(32).toString("base64url")
  );
  return createPersonalAgentRepository(pool as unknown as pg.Pool, {
    envelopeEncryptionProvider: {
      ...provider,
      decrypt: () => Buffer.from(plaintext, "utf8")
    }
  });
};

describe("Personal Agent repository", () => {
  it("stores only the soul marker in the version row and encrypts the soul", async () => {
    const pool = new PersonalAgentPool();
    const secret = "private launch policy and project context";
    const repository = createRepository(pool, secret);

    const created = await repository.createPersonalAgent(
      { userId: ownerId },
      {
        requestId: randomUUID(),
        name: "Atlas",
        role: "Project assistant",
        avatarReference: "pixelkin:atlas",
        soulInstructions: secret,
        instructionSource: "custom",
        defaultProvider: "codex",
        defaultModel: "gpt-5.6",
        defaultReasoningEffort: "high"
      }
    );

    expect(created.soulInstructions).toBe(secret);
    expect(pool.versionRow.soul_instructions).toBe(
      "[koed encrypted personal agent soul]"
    );
    expect(JSON.stringify(pool.encryptedValues)).not.toContain(secret);
    expect(pool.encryptedValues?.[6]).toBe("personal_agent_identity_versions");
    expect(pool.encryptedValues?.[8]).toBe("soul_instructions");
  });

  it("does not return another owner's identity and preserves retirement history", async () => {
    const pool = new PersonalAgentPool();
    const repository = createRepository(pool);

    await expect(
      repository.getPersonalAgent({ userId: otherOwnerId }, pool.identityId)
    ).resolves.toBeNull();

    const retired = await repository.retirePersonalAgent({
      actor: { userId: ownerId },
      agentId: pool.identityId,
      requestId: randomUUID(),
      expectedVersion: 1
    });
    expect(retired?.lifecycle).toBe("retired");
    expect(retired?.retiredAt).not.toBeNull();
    expect(retired?.currentVersion).toBe(1);
  });

  it("rejects a terminal event replay that belongs to another attempt", async () => {
    const pool = new CompletionReplayPool();
    const repository = createRepository(pool);

    await expect(
      repository.completePersonalAgentExecutionAttempt({
        actor: { userId: ownerId },
        jobId: pool.jobId,
        attemptId: pool.attemptId,
        outcome: "succeeded",
        eventId: "attempt-event"
      })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});
