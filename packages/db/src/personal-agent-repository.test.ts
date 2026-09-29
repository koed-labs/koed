import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { describe, expect, it } from "vitest";
import { createPersonalAgentRepository } from "./personal-agent-repository.js";

const ownerId = "11111111-1111-4111-8111-111111111111";
const otherOwnerId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-09-22T12:00:00.000Z");
const nameClaims = new Map<string, string>();

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
  retired_at: input.lifecycle === "retired" ? now : null,
  restore_request_id: null,
  restore_request_fingerprint: null,
  retirement_request_id: null,
  retirement_request_fingerprint: null,
  creation_request_id: randomUUID(),
  creation_request_fingerprint: "a".repeat(64)
});

class PersonalAgentPool {
  readonly identityId = randomUUID();
  readonly versionId = randomUUID();
  currentLifecycle: "active" | "retired" = "active";
  currentOwnerUserId = ownerId;
  currentName = "Atlas";
  currentProvider: string | null = "codex";
  currentModel: string | null = "gpt-5.6";
  currentEffort: string | null = "high";
  currentVersion = 1;
  historicalName = "Atlas";
  historyJobRows: Record<string, unknown>[] = [];
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
    if (
      sql.includes("from personal_agent_identities") &&
      sql.includes("where owner_user_id = $1 and restore_request_id = $2")
    ) {
      return { rows: [], rowCount: 0 } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("insert into personal_agent_name_claims")) {
      const normalizedName = String(values[1])
        .trim()
        .replace(/\s+/gu, " ")
        .toLowerCase();
      const key = `${String(values[0])}:${normalizedName}`;
      if (nameClaims.has(key)) {
        return { rows: [], rowCount: 0 } as unknown as pg.QueryResult<T>;
      }
      nameClaims.set(key, String(values[2]));
      return {
        rows: [{ agent_id: String(values[2]) }],
        rowCount: 1
      } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("select agent_id from personal_agent_name_claims")) {
      const normalizedName = String(values[1])
        .trim()
        .replace(/\s+/gu, " ")
        .toLowerCase();
      const key = `${String(values[0])}:${normalizedName}`;
      const agentId = nameClaims.get(key);
      return {
        rows: agentId ? [{ agent_id: agentId }] : [],
        rowCount: agentId ? 1 : 0
      } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("insert into personal_agent_identities")) {
      this.currentOwnerUserId = String(values[0]);
      this.currentName = String(values[1]);
      this.currentProvider = values[4] as string | null;
      this.currentModel = values[5] as string | null;
      this.currentEffort = values[6] as string | null;
      const identity = rowIdentity({
        id: this.identityId,
        ownerUserId: String(values[0])
      });
      return {
        rows: [
          {
            ...identity,
            name: values[1],
            default_provider: values[4],
            default_model: values[5],
            default_reasoning_effort: values[6]
          }
        ],
        rowCount: 1
      } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("insert into personal_agent_identity_versions")) {
      this.currentName = String(values[4]);
      this.currentProvider = values[11] as string | null;
      this.currentModel = values[12] as string | null;
      this.currentEffort = values[13] as string | null;
      this.versionRow = {
        ...this.versionRow,
        name: values[4],
        request_id: values[9],
        request_fingerprint: values[10],
        default_provider: values[11],
        default_model: values[12],
        default_reasoning_effort: values[13]
      };
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
        rows:
          sql.includes("where owner_user_id = $1 and request_id = $2") &&
          this.versionRow.request_id !== values[1]
            ? []
            : [this.versionRow],
        rowCount:
          sql.includes("where owner_user_id = $1 and request_id = $2") &&
          this.versionRow.request_id !== values[1]
            ? 0
            : 1
      } as unknown as pg.QueryResult<T>;
    }
    if (sql.startsWith("select name from personal_agent_identity_versions")) {
      return {
        rows: [{ name: this.historicalName }],
        rowCount: 1
      } as unknown as pg.QueryResult<T>;
    }
    if (
      sql.startsWith("select id, owner_user_id, conversation_id, command_id") &&
      sql.includes("from personal_agent_execution_jobs")
    ) {
      return {
        rows: this.historyJobRows,
        rowCount: this.historyJobRows.length
      } as unknown as pg.QueryResult<T>;
    }
    if (sql.includes("from personal_agent_execution_attempts")) {
      return { rows: [], rowCount: 0 } as unknown as pg.QueryResult<T>;
    }
    if (
      sql.startsWith("select id, owner_user_id, name, role") &&
      sql.includes("where owner_user_id = $1 and creation_request_id = $2")
    ) {
      return { rows: [], rowCount: 0 } as unknown as pg.QueryResult<T>;
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
    if (
      sql.startsWith("select id, owner_user_id, name, role") &&
      sql.includes("where id = $1 and owner_user_id = $2")
    ) {
      const requestedOwner = String(values[1]);
      const owned = requestedOwner === this.currentOwnerUserId;
      return {
        rows: owned
          ? [
              {
                ...rowIdentity({
                  id: this.identityId,
                  ownerUserId: this.currentOwnerUserId,
                  lifecycle: this.currentLifecycle,
                  currentVersion: this.currentVersion
                }),
                name: this.currentName,
                default_provider: this.currentProvider,
                default_model: this.currentModel,
                default_reasoning_effort: this.currentEffort
              }
            ]
          : [],
        rowCount: owned ? 1 : 0
      } as unknown as pg.QueryResult<T>;
    }
    if (
      sql.startsWith("update personal_agent_identities") &&
      sql.includes("set lifecycle = 'retired'")
    ) {
      this.currentLifecycle = "retired";
      return {
        rows: [
          rowIdentity({
            id: this.identityId,
            ownerUserId: this.currentOwnerUserId,
            lifecycle: "retired"
          })
        ],
        rowCount: 1
      } as unknown as pg.QueryResult<T>;
    }
    if (
      sql.startsWith("update personal_agent_identities") &&
      sql.includes("set lifecycle = 'active'")
    ) {
      this.currentLifecycle = "active";
      return {
        rows: [
          rowIdentity({
            id: this.identityId,
            ownerUserId: this.currentOwnerUserId
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

class RestoreRequestReplayPool extends PersonalAgentPool {
  readonly previouslyRestoredAgentId = randomUUID();

  override async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: unknown[] = []
  ): Promise<pg.QueryResult<T>> {
    const sql = text.replace(/\s+/g, " ").trim().toLowerCase();
    if (
      sql.includes("from personal_agent_identities") &&
      sql.includes("where owner_user_id = $1 and restore_request_id = $2")
    ) {
      return {
        rows: [
          {
            ...rowIdentity({
              id: this.previouslyRestoredAgentId,
              ownerUserId: ownerId
            }),
            restore_request_id: values[1],
            restore_request_fingerprint: "b".repeat(64)
          }
        ],
        rowCount: 1
      } as unknown as pg.QueryResult<T>;
    }
    return super.query<T>(text, values);
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

  it("preserves explicitly unset provider and model defaults", async () => {
    const pool = new PersonalAgentPool();
    const repository = createRepository(pool);
    const created = await repository.createPersonalAgent(
      { userId: ownerId },
      {
        requestId: randomUUID(),
        name: `No default ${randomUUID()}`,
        role: "Project assistant",
        soulInstructions: "Choose a model at launch.",
        instructionSource: "custom",
        defaultProvider: null,
        defaultModel: null,
        defaultReasoningEffort: null
      }
    );

    expect(created.agent).toMatchObject({
      defaultProvider: null,
      defaultModel: null,
      defaultReasoningEffort: null
    });
    expect(pool.versionRow).toMatchObject({
      default_provider: null,
      default_model: null
    });
  });

  it("rejects an effort default when no provider and model are saved", async () => {
    const repository = createRepository(new PersonalAgentPool());

    await expect(
      repository.createPersonalAgent(
        { userId: ownerId },
        {
          requestId: randomUUID(),
          name: `No default ${randomUUID()}`,
          role: "Project assistant",
          soulInstructions: "Choose a model at launch.",
          instructionSource: "custom",
          defaultProvider: null,
          defaultModel: null,
          defaultReasoningEffort: "high"
        }
      )
    ).rejects.toThrow(/reasoning effort must be null/);
  });

  it("rejects clearing provider and model while retaining the saved effort", async () => {
    const pool = new PersonalAgentPool();
    const repository = createRepository(pool);
    await repository.createPersonalAgent(
      { userId: ownerId },
      {
        requestId: randomUUID(),
        name: `Configured ${randomUUID()}`,
        role: "Project assistant",
        soulInstructions: "Choose a model at launch.",
        instructionSource: "custom",
        defaultProvider: "codex",
        defaultModel: "gpt-5.6",
        defaultReasoningEffort: "high"
      }
    );

    await expect(
      repository.updatePersonalAgent(
        { userId: ownerId },
        {
          agentId: pool.identityId,
          requestId: randomUUID(),
          expectedVersion: 1,
          defaultProvider: null,
          defaultModel: null
        }
      )
    ).rejects.toThrow(/reasoning effort must be null/);
  });

  it("reserves normalized current and former names per owner", async () => {
    const name = `Unique ${randomUUID()}`;
    const firstPool = new PersonalAgentPool();
    const firstRepository = createRepository(firstPool);
    const created = await firstRepository.createPersonalAgent(
      { userId: ownerId },
      {
        requestId: randomUUID(),
        name,
        role: "Project assistant",
        soulInstructions: "Instructions.",
        instructionSource: "custom",
        defaultProvider: "codex",
        defaultModel: "gpt-5.6"
      }
    );
    await firstRepository.retirePersonalAgent({
      actor: { userId: ownerId },
      agentId: created.agent.id,
      requestId: randomUUID(),
      expectedVersion: 1
    });

    const sameOwnerRepository = createRepository(new PersonalAgentPool());
    await expect(
      sameOwnerRepository.createPersonalAgent(
        { userId: ownerId },
        {
          requestId: randomUUID(),
          name: `  ${name.toUpperCase()}  `,
          role: "Another profile",
          soulInstructions: "Instructions.",
          instructionSource: "custom",
          defaultProvider: null,
          defaultModel: null
        }
      )
    ).rejects.toMatchObject({ code: "PERSONAL_AGENT_NAME_CONFLICT" });

    const otherOwnerRepository = createRepository(new PersonalAgentPool());
    await expect(
      otherOwnerRepository.createPersonalAgent(
        { userId: otherOwnerId },
        {
          requestId: randomUUID(),
          name,
          role: "Another profile",
          soulInstructions: "Instructions.",
          instructionSource: "custom",
          defaultProvider: null,
          defaultModel: null
        }
      )
    ).resolves.toMatchObject({ agent: { ownerUserId: otherOwnerId } });
  });

  it("serializes concurrent same-owner name claims to one winner", async () => {
    const name = `Concurrent ${randomUUID()}`;
    const attempts = await Promise.allSettled(
      [new PersonalAgentPool(), new PersonalAgentPool()].map((pool) =>
        createRepository(pool).createPersonalAgent(
          { userId: ownerId },
          {
            requestId: randomUUID(),
            name,
            role: "Project assistant",
            soulInstructions: "Instructions.",
            instructionSource: "custom",
            defaultProvider: null,
            defaultModel: null
          }
        )
      )
    );
    expect(
      attempts.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      attempts.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    expect(
      attempts.find((result) => result.status === "rejected")
    ).toMatchObject({
      reason: { code: "PERSONAL_AGENT_NAME_CONFLICT" }
    });
  });

  it("returns the name captured by a job's immutable agent version", async () => {
    const pool = new PersonalAgentPool();
    const repository = createRepository(pool);
    const originalName = `Original ${randomUUID()}`;
    await repository.createPersonalAgent(
      { userId: ownerId },
      {
        requestId: randomUUID(),
        name: originalName,
        role: "Project assistant",
        soulInstructions: "Instructions.",
        instructionSource: "custom",
        defaultProvider: "codex",
        defaultModel: "gpt-5.6"
      }
    );
    pool.currentVersion = 2;
    pool.currentName = "Renamed Agent";
    pool.historicalName = originalName;
    pool.versionRow = {
      ...pool.versionRow,
      version: 2,
      name: pool.currentName
    };
    const jobId = randomUUID();
    pool.historyJobRows = [
      {
        id: jobId,
        owner_user_id: ownerId,
        conversation_id: randomUUID(),
        command_id: null,
        title: "Agent task",
        project_id: null,
        output_reference: null,
        version: 1,
        last_observed_at: null,
        attribution_kind: "agent",
        agent_id: pool.identityId,
        agent_version: 1,
        state: "succeeded",
        attempts_started: 1,
        attempts_succeeded: 1,
        attempts_failed: 0,
        attempts_canceled: 0,
        attempts_interrupted: 0,
        last_attempt_id: null,
        created_at: now,
        updated_at: now
      }
    ];

    const detail = await repository.getPersonalAgent(
      { userId: ownerId },
      pool.identityId
    );

    expect(detail?.agent.name).toBe("Renamed Agent");
    expect(detail?.history.jobs[0]).toMatchObject({
      agentName: originalName,
      attribution: { kind: "agent", agentVersion: 1 }
    });
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

    const restored = await repository.restorePersonalAgent({
      actor: { userId: ownerId },
      agentId: pool.identityId,
      requestId: randomUUID(),
      expectedVersion: 1
    });
    expect(restored).toMatchObject({
      id: pool.identityId,
      lifecycle: "active",
      currentVersion: 1,
      retiredAt: null
    });
    await expect(
      repository.restorePersonalAgent({
        actor: { userId: otherOwnerId },
        agentId: pool.identityId,
        requestId: randomUUID(),
        expectedVersion: 1
      })
    ).resolves.toBeNull();
  });

  it("rejects a restore request ID already used for another owned Agent", async () => {
    const pool = new RestoreRequestReplayPool();
    const repository = createRepository(pool);

    await expect(
      repository.restorePersonalAgent({
        actor: { userId: ownerId },
        agentId: pool.identityId,
        requestId: randomUUID(),
        expectedVersion: 1
      })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
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
