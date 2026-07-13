import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID
} from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from "vitest";
import type pg from "pg";
import { createMemoryEngine, estimateTokens } from "@koed/core";
import {
  createLocalWorkQueueRepository,
  createEncryptedPayloadRepository,
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations,
  type ConversationItemInput,
  type MemorySourceRepository
} from "../src/index.js";
import {
  createEncryptedJsonPackage,
  createLocalTestKeyEnvelopeEncryptionProvider,
  createManagedKmsEnvelopeEncryptionProvider,
  decryptEnvelopeToUtf8,
  rawConversationTransportChunkGroupId,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider,
  type ManagedKmsKeyring
} from "@koed/shared";

const databaseUrl = process.env.DATABASE_URL;
const runDbTests = Boolean(databaseUrl);
const originalLeafEventThreshold = process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD;
const originalLeafTokenThreshold = process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD;
const originalFreshEventTail = process.env.MEMORY_LCM_FRESH_EVENT_TAIL;
const originalDepthOneFanout = process.env.MEMORY_LCM_DEPTH1_FANOUT;
const originalMemoryEventMaxTokens = process.env.MEMORY_EVENT_MAX_TOKENS;
const originalAgentTurnStaleMs = process.env.MEMORY_AGENT_TURN_STALE_MS;
const originalEmbeddingMaxTokens = process.env.EMBEDDING_MAX_TOKENS;
const originalEmbeddingModel = process.env.EMBEDDING_MODEL;
const originalEmbeddingServiceUrl = process.env.EMBEDDING_SERVICE_URL;
const originalRerankerKey = process.env.RERANKER_KEY;
const originalEmbeddingQueryInstructionEnabled =
  process.env.EMBEDDING_QUERY_INSTRUCTION_ENABLED;
const originalEmbeddingQueryInstruction =
  process.env.EMBEDDING_QUERY_INSTRUCTION;
const originalSemanticMemoryRebuildDebounceMs =
  process.env.SEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS;
const originalKoedDeploymentProfile = process.env.KOED_DEPLOYMENT_PROFILE;
const originalKoedManagedCloudReleaseStage =
  process.env.KOED_MANAGED_CLOUD_RELEASE_STAGE;
const originalPlaintextLexicalSearchEnabled =
  process.env.MEMORY_PLAINTEXT_LEXICAL_SEARCH_ENABLED;

const describeDb = runDbTests ? describe : describe.skip;

const codexCanonicalConversationItemKey = (input: {
  externalThreadId: string;
  externalTurnId: string;
  stableItemId: string;
  component: string;
}): string =>
  `conversation-item:${createHash("sha256")
    .update(
      JSON.stringify({
        version: 3,
        provider: "codex",
        externalThreadId: input.externalThreadId,
        externalTurnId: input.externalTurnId,
        stableItemId: input.stableItemId,
        component: input.component
      })
    )
    .digest("hex")}`;

describeDb("memory repository visibility", () => {
  let pool: pg.Pool;
  let repo: MemorySourceRepository;

  const captureUserEvent = (
    engine: ReturnType<typeof createMemoryEngine>,
    userId: string,
    input: {
      workspaceId: string;
      content: string;
      sessionId?: string;
      actor?: "user" | "assistant" | "agent" | "subagent" | "tool" | "system";
      visibility?: "personal";
      metadata?: Record<string, unknown>;
    }
  ) =>
    engine.capturePersonalEvent({
      requesterContext: { userId },
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      actor: input.actor ?? "user",
      eventType: "user_prompt",
      content: input.content,
      visibility: input.visibility,
      metadata: input.metadata
    });

  const embedPendingSources = async () => {
    const dimensions = 1024;
    const vector = Array.from({ length: dimensions }, (_, index) =>
      index === 0 ? 1 : 0
    );
    const sources = await repo.listSourcesNeedingEmbeddings(500);
    for (const source of sources) {
      await repo.upsertSourceEmbedding({
        source,
        model: process.env.EMBEDDING_MODEL ?? "qwen3-0.6b",
        dimensions,
        version: process.env.EMBEDDING_MODEL ?? "qwen3-0.6b",
        vector
      });
    }
  };

  const mockEmbeddingQuery = () => {
    const dimensions = 1024;
    const vector = Array.from({ length: dimensions }, (_, index) =>
      index === 0 ? 1 : 0
    );
    return vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        const endpoint = String(url);
        if (endpoint.endsWith("/rerank")) {
          const body =
            typeof init?.body === "string"
              ? (JSON.parse(init.body) as { documents?: unknown[] })
              : {};
          const count = Array.isArray(body.documents)
            ? body.documents.length
            : 1;
          return new Response(
            JSON.stringify({
              model: process.env.RERANKER_KEY ?? "qwen3-reranker-0.6b",
              scores: Array.from({ length: count }, () => 1)
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            model: process.env.EMBEDDING_MODEL ?? "qwen3-0.6b",
            dimensions,
            vectors: [vector]
          }),
          { status: 200 }
        );
      });
  };

  const withPaidManagedCloudProfile = async <T>(
    callback: () => Promise<T>
  ): Promise<T> => {
    const previousProfile = process.env.KOED_DEPLOYMENT_PROFILE;
    const previousReleaseStage = process.env.KOED_MANAGED_CLOUD_RELEASE_STAGE;
    process.env.KOED_DEPLOYMENT_PROFILE = "koed_managed_cloud";
    process.env.KOED_MANAGED_CLOUD_RELEASE_STAGE = "paid";
    try {
      return await callback();
    } finally {
      if (previousProfile === undefined) {
        delete process.env.KOED_DEPLOYMENT_PROFILE;
      } else {
        process.env.KOED_DEPLOYMENT_PROFILE = previousProfile;
      }
      if (previousReleaseStage === undefined) {
        delete process.env.KOED_MANAGED_CLOUD_RELEASE_STAGE;
      } else {
        process.env.KOED_MANAGED_CLOUD_RELEASE_STAGE = previousReleaseStage;
      }
    }
  };

  const createManagedTestKeyring = ({
    currentVersion,
    keys,
    fail = false
  }: {
    currentVersion: number;
    keys: Record<number, Buffer>;
    fail?: boolean;
  }): ManagedKmsKeyring => ({
    keyId: "managed-kms:fixture-tenant-key",
    keyVersion: currentVersion,
    wrapDek(input) {
      if (fail) {
        throw new Error("kms unavailable");
      }
      const key = keys[input.keyVersion];
      if (!key) {
        throw new Error("unknown kms key version");
      }
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(input.aad);
      const ciphertext = Buffer.concat([
        cipher.update(input.dek),
        cipher.final()
      ]);
      const tag = cipher.getAuthTag();
      return {
        ciphertext: ciphertext.toString("base64"),
        nonce: nonce.toString("base64"),
        tag: tag.toString("base64")
      };
    },
    unwrapDek(input) {
      if (fail) {
        throw new Error("kms unavailable");
      }
      const key = keys[input.keyVersion];
      if (!key) {
        throw new Error("unknown kms key version");
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(input.wrappedDek.nonce, "base64")
      );
      decipher.setAAD(input.aad);
      decipher.setAuthTag(Buffer.from(input.wrappedDek.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(input.wrappedDek.ciphertext, "base64")),
        decipher.final()
      ]);
    },
    status() {
      return {
        mode: "managed_kms",
        keyId: "managed-kms:fixture-tenant-key",
        keyVersion: currentVersion,
        status: fail ? "degraded" : "available"
      };
    }
  });

  beforeAll(async () => {
    process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD = "5";
    process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD = "6000";
    process.env.MEMORY_LCM_FRESH_EVENT_TAIL = "0";
    process.env.MEMORY_LCM_DEPTH1_FANOUT = "2";
    pool = createDbPool({ connectionString: databaseUrl });
    repo = createMemorySourceRepository(pool);
    await runDbMigrations(pool);
  });

  it("requeues a completed deterministic local job", async () => {
    const queue = createLocalWorkQueueRepository(pool);
    const first = await queue.enqueue({
      queueName: "memory-embed",
      jobName: "embed-source",
      jobKey: "completed-requeue",
      data: { sourceId: "event-1" },
      maxAttempts: 2
    });
    const firstClaim = await queue.claim<{ sourceId: string }>({
      queueName: "memory-embed",
      leaseMs: 60_000
    });
    expect(firstClaim).toMatchObject({
      id: first.id,
      data: { sourceId: "event-1" },
      attemptCount: 1
    });
    expect(
      await queue.complete({
        id: firstClaim!.id,
        lockToken: firstClaim!.lockToken
      })
    ).toBe(true);

    const second = await queue.enqueue({
      queueName: "memory-embed",
      jobName: "embed-source-again",
      jobKey: "completed-requeue",
      data: { sourceId: "event-2" },
      maxAttempts: 4
    });
    const secondClaim = await queue.claim<{ sourceId: string }>({
      queueName: "memory-embed",
      leaseMs: 60_000
    });

    expect(second.id).toBe(first.id);
    expect(secondClaim).toMatchObject({
      id: first.id,
      jobName: "embed-source-again",
      data: { sourceId: "event-2" },
      attemptCount: 1,
      maxAttempts: 4
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.query(
      `
        truncate table
          audit_events,
          encrypted_field_backfill_runs,
          encrypted_field_payloads,
          local_work_queue,
          sync_inbox_entries,
          sync_outbox_entries,
          sync_package_chunks,
          sync_package_upload_sessions,
          cross_identity_sync_relationships,
          memory_replicas,
          logical_memories,
          deployment_identities,
          team_billing_seat_states,
          team_session_share_grants,
          team_workspace_access_grants,
          team_invites,
          team_workspaces,
          external_auth_organizations,
          team_memberships,
          teams,
          external_auth_identities,
          api_tokens,
          memory_questions,
          memory_embeddings_3072,
          memory_embeddings_1536,
          memory_embeddings_1024,
          memory_embeddings_384,
          memory_embeddings,
          memory_node_children,
          memory_node_sources,
          memory_event_sources,
          workflow_token_usage_source_references,
          workflow_token_usage,
          memory_nodes,
          memory_events,
          conversation_items,
          tool_events,
          messages,
          turns,
          sessions,
          workspaces,
          user_sessions,
          users
        restart identity cascade
      `
    );
  });

  afterAll(async () => {
    if (originalLeafEventThreshold === undefined) {
      delete process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD;
    } else {
      process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD = originalLeafEventThreshold;
    }
    if (originalLeafTokenThreshold === undefined) {
      delete process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD;
    } else {
      process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD = originalLeafTokenThreshold;
    }
    if (originalFreshEventTail === undefined) {
      delete process.env.MEMORY_LCM_FRESH_EVENT_TAIL;
    } else {
      process.env.MEMORY_LCM_FRESH_EVENT_TAIL = originalFreshEventTail;
    }
    if (originalDepthOneFanout === undefined) {
      delete process.env.MEMORY_LCM_DEPTH1_FANOUT;
    } else {
      process.env.MEMORY_LCM_DEPTH1_FANOUT = originalDepthOneFanout;
    }
    if (originalMemoryEventMaxTokens === undefined) {
      delete process.env.MEMORY_EVENT_MAX_TOKENS;
    } else {
      process.env.MEMORY_EVENT_MAX_TOKENS = originalMemoryEventMaxTokens;
    }
    if (originalAgentTurnStaleMs === undefined) {
      delete process.env.MEMORY_AGENT_TURN_STALE_MS;
    } else {
      process.env.MEMORY_AGENT_TURN_STALE_MS = originalAgentTurnStaleMs;
    }
    if (originalEmbeddingMaxTokens === undefined) {
      delete process.env.EMBEDDING_MAX_TOKENS;
    } else {
      process.env.EMBEDDING_MAX_TOKENS = originalEmbeddingMaxTokens;
    }
    if (originalEmbeddingModel === undefined) {
      delete process.env.EMBEDDING_MODEL;
    } else {
      process.env.EMBEDDING_MODEL = originalEmbeddingModel;
    }
    if (originalEmbeddingServiceUrl === undefined) {
      delete process.env.EMBEDDING_SERVICE_URL;
    } else {
      process.env.EMBEDDING_SERVICE_URL = originalEmbeddingServiceUrl;
    }
    if (originalRerankerKey === undefined) {
      delete process.env.RERANKER_KEY;
    } else {
      process.env.RERANKER_KEY = originalRerankerKey;
    }
    if (originalEmbeddingQueryInstructionEnabled === undefined) {
      delete process.env.EMBEDDING_QUERY_INSTRUCTION_ENABLED;
    } else {
      process.env.EMBEDDING_QUERY_INSTRUCTION_ENABLED =
        originalEmbeddingQueryInstructionEnabled;
    }
    if (originalEmbeddingQueryInstruction === undefined) {
      delete process.env.EMBEDDING_QUERY_INSTRUCTION;
    } else {
      process.env.EMBEDDING_QUERY_INSTRUCTION =
        originalEmbeddingQueryInstruction;
    }
    if (originalSemanticMemoryRebuildDebounceMs === undefined) {
      delete process.env.SEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS;
    } else {
      process.env.SEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS =
        originalSemanticMemoryRebuildDebounceMs;
    }
    if (originalKoedDeploymentProfile === undefined) {
      delete process.env.KOED_DEPLOYMENT_PROFILE;
    } else {
      process.env.KOED_DEPLOYMENT_PROFILE = originalKoedDeploymentProfile;
    }
    if (originalKoedManagedCloudReleaseStage === undefined) {
      delete process.env.KOED_MANAGED_CLOUD_RELEASE_STAGE;
    } else {
      process.env.KOED_MANAGED_CLOUD_RELEASE_STAGE =
        originalKoedManagedCloudReleaseStage;
    }
    if (originalPlaintextLexicalSearchEnabled === undefined) {
      delete process.env.MEMORY_PLAINTEXT_LEXICAL_SEARCH_ENABLED;
    } else {
      process.env.MEMORY_PLAINTEXT_LEXICAL_SEARCH_ENABLED =
        originalPlaintextLexicalSearchEnabled;
    }
    await pool?.end();
  });

  it("manages API tokens through the Drizzle-backed repository slice", async () => {
    const email = `api-token-${randomUUID()}@example.com`;
    const user = await repo.createUser({
      email: email.toUpperCase(),
      displayName: "API Token User"
    });

    const foundUser = await repo.findUserByEmail(email);
    expect(foundUser).toMatchObject({
      id: user.id,
      email,
      displayName: "API Token User",
      passwordHash: null
    });

    const tokenHash = `hash-${randomUUID()}-${randomUUID()}`;
    const token = await repo.createApiToken({
      ownerUserId: user.id,
      name: "Codex",
      tokenHash,
      tokenPrefix: "cmt_test",
      scopes: ["memory:read", "memory:write"]
    });

    expect(token).toMatchObject({
      ownerUserId: user.id,
      name: "Codex",
      tokenPrefix: "cmt_test",
      scopes: ["memory:read", "memory:write"],
      lastUsedAt: null,
      revokedAt: null
    });

    expect(await repo.listApiTokens(user.id)).toEqual([token]);

    const authenticatedUser = await repo.getApiTokenUser(tokenHash);
    expect(authenticatedUser).toMatchObject({
      id: user.id,
      email,
      displayName: "API Token User",
      passwordHash: null
    });

    const tokensAfterAuth = await repo.listApiTokens(user.id);
    expect(tokensAfterAuth).toHaveLength(1);
    expect(tokensAfterAuth[0]?.lastUsedAt).not.toBeNull();

    expect(await repo.revokeApiToken(user.id, token.id)).toBe(true);
    expect(await repo.revokeApiToken(user.id, token.id)).toBe(false);
    expect(await repo.listApiTokens(user.id)).toEqual([]);
    expect(await repo.getApiTokenUser(tokenHash)).toBeNull();
  });

  it("stores encrypted field payloads and authorizes before decrypting", async () => {
    const encryptedRepo = createEncryptedPayloadRepository(pool);
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 7).toString("base64")
    );
    const decrypt = vi.fn(provider.decrypt.bind(provider));
    const instrumentedProvider = {
      mode: provider.mode,
      keyId: provider.keyId,
      keyVersion: provider.keyVersion,
      encrypt: provider.encrypt.bind(provider),
      decrypt
    };
    const owner = await repo.createUser({
      email: `encrypted-owner-${randomUUID()}@example.com`
    });
    const other = await repo.createUser({
      email: `encrypted-other-${randomUUID()}@example.com`
    });
    const sourceId = randomUUID();
    const plaintext = {
      content: "commercial memory plaintext must not sit in the encrypted row",
      evidence: [{ source: "test", quote: "sensitive evidence" }]
    };

    const stored = await encryptedRepo.upsertEncryptedField(
      { userId: owner.id },
      instrumentedProvider,
      {
        sourceTable: "memory_events",
        sourceId,
        sourceColumn: "payload",
        plaintext,
        scope: {
          tenantId: owner.id,
          objectClass: "memory_event"
        },
        rowFamily: "memory_event"
      }
    );

    expect(stored.ownerUserId).toBe(owner.id);
    expect(stored.envelope.providerMode).toBe("local_test_key");
    expect(stored.envelope.provenance).toMatchObject({
      rowFamily: "memory_event",
      sourceTable: "memory_events",
      sourceColumn: "payload",
      sourceId
    });
    expect(JSON.stringify(stored.envelope)).not.toContain(
      "commercial memory plaintext"
    );
    expect(JSON.stringify(stored.envelope)).not.toContain("sensitive evidence");

    const raw = await pool.query(
      `
        select ciphertext, nonce, tag, wrapped_dek, provenance
        from encrypted_field_payloads
        where id = $1
      `,
      [stored.id]
    );
    expect(JSON.stringify(raw.rows[0])).not.toContain(
      "commercial memory plaintext"
    );
    expect(JSON.stringify(raw.rows[0])).not.toContain("sensitive evidence");

    await expect(
      encryptedRepo.decryptAuthorizedEncryptedField(
        { userId: other.id },
        instrumentedProvider,
        {
          sourceTable: "memory_events",
          sourceId,
          sourceColumn: "payload"
        }
      )
    ).resolves.toBeNull();
    expect(decrypt).not.toHaveBeenCalled();

    await expect(
      encryptedRepo.decryptAuthorizedEncryptedField(
        { userId: owner.id },
        instrumentedProvider,
        {
          sourceTable: "memory_events",
          sourceId,
          sourceColumn: "payload"
        }
      )
    ).resolves.toMatchObject({
      plaintext
    });
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  it("stores Team-scoped encrypted field metadata without granting generic personal decrypt", async () => {
    const encryptedRepo = createEncryptedPayloadRepository(pool);
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 17).toString("base64")
    );
    const decrypt = vi.fn(provider.decrypt.bind(provider));
    const instrumentedProvider = {
      mode: provider.mode,
      keyId: provider.keyId,
      keyVersion: provider.keyVersion,
      encrypt: provider.encrypt.bind(provider),
      decrypt
    };
    const owner = await repo.createUser({
      email: `encrypted-team-owner-${randomUUID()}@example.com`
    });
    const team = await repo.createTeam(
      { userId: owner.id },
      { name: "Encrypted Team Scope" }
    );
    const workspace = await repo.createTeamWorkspace(
      { userId: owner.id },
      { teamId: team.id, name: "Encrypted Workspace Scope" }
    );
    const sourceId = randomUUID();
    const plaintext = {
      content: "team encrypted field plaintext",
      source: "fixture"
    };

    const stored = await encryptedRepo.upsertEncryptedField(
      { userId: owner.id },
      instrumentedProvider,
      {
        sourceTable: "memory_events",
        sourceId,
        sourceColumn: "payload",
        plaintext,
        visibility: "team",
        teamId: team.id,
        teamWorkspaceId: workspace!.id,
        scope: {
          tenantId: team.id,
          objectClass: "memory_event",
          teamId: team.id,
          workspaceId: workspace!.id
        },
        rowFamily: "team_memory_event"
      }
    );

    expect(stored).toMatchObject({
      ownerUserId: owner.id,
      teamId: team.id,
      teamWorkspaceId: workspace!.id,
      visibility: "personal",
      encryptionScope: "team"
    });
    expect(stored.envelope.aad).toMatchObject({
      ownerUserId: owner.id,
      visibility: "personal",
      encryptionScope: "team",
      teamId: team.id,
      teamWorkspaceId: workspace!.id,
      sourceTable: "memory_events",
      sourceId,
      sourceColumn: "payload"
    });
    const raw = await pool.query(
      `
        select owner_user_id, team_id, team_workspace_id, visibility, encryption_scope, aad
        from encrypted_field_payloads
        where id = $1
      `,
      [stored.id]
    );
    expect(raw.rows[0]).toMatchObject({
      owner_user_id: owner.id,
      team_id: team.id,
      team_workspace_id: workspace!.id,
      visibility: "personal",
      encryption_scope: "team"
    });
    expect(JSON.stringify(raw.rows[0])).not.toContain(
      "team encrypted field plaintext"
    );

    await expect(
      encryptedRepo.upsertEncryptedField(
        { userId: owner.id },
        instrumentedProvider,
        {
          sourceTable: "memory_events",
          sourceId: randomUUID(),
          sourceColumn: "payload",
          plaintext,
          visibility: "team"
        }
      )
    ).rejects.toThrow("Team encrypted fields require teamId");

    await expect(
      encryptedRepo.decryptAuthorizedEncryptedField(
        { userId: owner.id },
        instrumentedProvider,
        {
          sourceTable: "memory_events",
          sourceId,
          sourceColumn: "payload"
        }
      )
    ).resolves.toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("tracks encrypted field backfill progress for resumable commercial migrations", async () => {
    const encryptedRepo = createEncryptedPayloadRepository(pool);
    const owner = await repo.createUser({
      email: `encrypted-backfill-${randomUUID()}@example.com`
    });

    const run = await encryptedRepo.createEncryptedFieldBackfillRun(
      { userId: owner.id },
      {
        sourceTable: "memory_questions",
        sourceColumn: "evidence",
        providerMode: "local_test_key",
        totalRows: 12
      }
    );

    expect(run).toMatchObject({
      ownerUserId: owner.id,
      sourceTable: "memory_questions",
      sourceColumn: "evidence",
      status: "pending",
      totalRows: 12,
      processedRows: 0,
      encryptedRows: 0,
      failedRows: 0
    });

    const cursorSourceId = randomUUID();
    const updated = await encryptedRepo.updateEncryptedFieldBackfillRun(
      { userId: owner.id },
      run.id,
      {
        status: "processing",
        cursorSourceId,
        processedRows: 8,
        encryptedRows: 7,
        failedRows: 1,
        lastErrorMessage: "one row had malformed historical JSON"
      }
    );

    expect(updated).toMatchObject({
      id: run.id,
      status: "processing",
      cursorSourceId,
      processedRows: 8,
      encryptedRows: 7,
      failedRows: 1,
      lastErrorMessage: "one row had malformed historical JSON"
    });

    const completed = await encryptedRepo.updateEncryptedFieldBackfillRun(
      { userId: owner.id },
      run.id,
      {
        status: "completed",
        processedRows: 12,
        encryptedRows: 11,
        failedRows: 1
      }
    );
    expect(completed).toMatchObject({
      status: "completed",
      processedRows: 12,
      encryptedRows: 11,
      failedRows: 1
    });
    expect(completed?.completedAt).not.toBeNull();
  });

  it("backfills Memory Event payload encryption idempotently and fails closed on provider errors", async () => {
    const encryptedRepo = createEncryptedPayloadRepository(pool);
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 8).toString("base64")
    );
    const owner = await repo.createUser({
      email: `encrypted-memory-event-${randomUUID()}@example.com`
    });
    const firstEvent = await repo.createMemoryEvent(
      { userId: owner.id },
      {
        visibility: "personal",
        workspaceId: "encrypted-backfill",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        content: "First commercial Memory Event payload.",
        captureMethod: "api",
        idempotencyKey: `encrypted-backfill-${randomUUID()}`
      }
    );
    await repo.createMemoryEvent(
      { userId: owner.id },
      {
        visibility: "personal",
        workspaceId: "encrypted-backfill",
        actor: "assistant",
        eventType: "captured",
        rawEventType: "agent_message",
        content: "Second commercial Memory Event payload.",
        captureMethod: "api",
        idempotencyKey: `encrypted-backfill-${randomUUID()}`
      }
    );

    const run = await encryptedRepo.createEncryptedFieldBackfillRun(
      { userId: owner.id },
      {
        sourceTable: "memory_events",
        sourceColumn: "payload",
        providerMode: "local_test_key",
        totalRows: 2
      }
    );
    const backfill = await encryptedRepo.backfillEncryptedFieldBatch(
      { userId: owner.id },
      provider,
      {
        runId: run.id,
        sourceTable: "memory_events",
        sourceColumn: "payload",
        batchSize: 10
      }
    );

    expect(backfill).toMatchObject({
      processedRows: 2,
      encryptedRows: 2,
      failedRows: 0,
      done: true
    });
    expect(backfill.run.status).toBe("completed");

    const rawEncryptedRows = await pool.query<{
      count: number;
      ciphertext: string | null;
    }>(
      `
        select count(*)::int as count, string_agg(ciphertext, '') as ciphertext
        from encrypted_field_payloads
        where owner_user_id = $1
          and source_table = 'memory_events'
          and source_column = 'payload'
          and invalidated_at is null
      `,
      [owner.id]
    );
    expect(rawEncryptedRows.rows[0]).toMatchObject({ count: 2 });
    expect(rawEncryptedRows.rows[0]!.ciphertext).not.toContain(
      "commercial Memory Event payload"
    );

    const redactedSources = await pool.query<{ payload_text: string }>(
      `
        select payload::text as payload_text
        from memory_events
        where owner_user_id = $1
        order by id::text asc
      `,
      [owner.id]
    );
    expect(redactedSources.rows).toHaveLength(2);
    expect(
      redactedSources.rows.map((row) => row.payload_text).join(" ")
    ).not.toContain("commercial Memory Event payload");
    expect(redactedSources.rows[0]?.payload_text).toContain("contentEncrypted");
    expect(redactedSources.rows[0]?.payload_text).toContain("memory_events");

    const decrypted = await encryptedRepo.decryptAuthorizedEncryptedField(
      { userId: owner.id },
      provider,
      {
        sourceTable: "memory_events",
        sourceId: firstEvent.id,
        sourceColumn: "payload"
      }
    );
    expect(decrypted?.plaintext).toMatchObject({
      content: "First commercial Memory Event payload.",
      workspaceId: "encrypted-backfill"
    });

    await expect(
      encryptedRepo.backfillEncryptedFieldBatch(
        { userId: owner.id },
        provider,
        {
          runId: run.id,
          sourceTable: "memory_events",
          sourceColumn: "payload"
        }
      )
    ).resolves.toMatchObject({
      processedRows: 0,
      encryptedRows: 0,
      failedRows: 0,
      done: true
    });

    const mismatchRun = await encryptedRepo.createEncryptedFieldBackfillRun(
      { userId: owner.id },
      {
        sourceTable: "memory_events",
        sourceColumn: "payload",
        providerMode: "local_test_key"
      }
    );
    const mismatchedProvider = {
      ...provider,
      mode: "managed_kms"
    } satisfies EnvelopeEncryptionProvider;

    await expect(
      encryptedRepo.backfillEncryptedFieldBatch(
        { userId: owner.id },
        mismatchedProvider,
        {
          runId: mismatchRun.id,
          sourceTable: "memory_events",
          sourceColumn: "payload"
        }
      )
    ).rejects.toThrow("Backfill provider mismatch");

    const failedRun = await pool.query(
      `
        select status, last_error_message
        from encrypted_field_backfill_runs
        where id = $1
      `,
      [mismatchRun.id]
    );
    expect(failedRun.rows[0]).toMatchObject({
      status: "error",
      last_error_message:
        "Backfill provider mismatch: expected local_test_key, received managed_kms"
    });

    const failureOwner = await repo.createUser({
      email: `encrypted-memory-event-failure-${randomUUID()}@example.com`
    });
    await repo.createMemoryEvent(
      { userId: failureOwner.id },
      {
        visibility: "personal",
        workspaceId: "encrypted-backfill-failure",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        content: "First provider failure Memory Event payload.",
        captureMethod: "api",
        idempotencyKey: `encrypted-backfill-failure-${randomUUID()}`
      }
    );
    await repo.createMemoryEvent(
      { userId: failureOwner.id },
      {
        visibility: "personal",
        workspaceId: "encrypted-backfill-failure",
        actor: "assistant",
        eventType: "captured",
        rawEventType: "agent_message",
        content: "Second provider failure Memory Event payload.",
        captureMethod: "api",
        idempotencyKey: `encrypted-backfill-failure-${randomUUID()}`
      }
    );
    const providerErrorRun =
      await encryptedRepo.createEncryptedFieldBackfillRun(
        { userId: failureOwner.id },
        {
          sourceTable: "memory_events",
          sourceColumn: "payload",
          providerMode: "local_test_key"
        }
      );
    const failingProvider = {
      ...provider,
      encrypt() {
        throw new Error("simulated KMS encrypt failure");
      }
    } satisfies EnvelopeEncryptionProvider;

    await expect(
      encryptedRepo.backfillEncryptedFieldBatch(
        { userId: failureOwner.id },
        failingProvider,
        {
          runId: providerErrorRun.id,
          sourceTable: "memory_events",
          sourceColumn: "payload"
        }
      )
    ).rejects.toThrow("simulated KMS encrypt failure");

    const providerFailure = await pool.query(
      `
        select status, cursor_source_id, processed_rows, encrypted_rows, failed_rows, last_error_message
        from encrypted_field_backfill_runs
        where id = $1
      `,
      [providerErrorRun.id]
    );
    expect(providerFailure.rows[0]).toMatchObject({
      status: "error",
      cursor_source_id: null,
      processed_rows: 1,
      encrypted_rows: 0,
      failed_rows: 1,
      last_error_message: "simulated KMS encrypt failure"
    });

    const failedSourceStillPlaintext = await pool.query<{
      payload_text: string;
    }>(
      `
        select string_agg(payload::text, ' ') as payload_text
        from memory_events
        where owner_user_id = $1
      `,
      [failureOwner.id]
    );
    expect(failedSourceStillPlaintext.rows[0]?.payload_text).toContain(
      "provider failure Memory Event payload"
    );

    const retried = await encryptedRepo.backfillEncryptedFieldBatch(
      { userId: failureOwner.id },
      provider,
      {
        runId: providerErrorRun.id,
        sourceTable: "memory_events",
        sourceColumn: "payload",
        batchSize: 10
      }
    );
    expect(retried).toMatchObject({
      processedRows: 2,
      encryptedRows: 2,
      failedRows: 0,
      done: true
    });
    const retriedSourceRedacted = await pool.query<{ payload_text: string }>(
      `
        select string_agg(payload::text, ' ') as payload_text
        from memory_events
        where owner_user_id = $1
      `,
      [failureOwner.id]
    );
    expect(retriedSourceRedacted.rows[0]?.payload_text).not.toContain(
      "provider failure Memory Event payload"
    );
    expect(retriedSourceRedacted.rows[0]?.payload_text).toContain(
      "contentEncrypted"
    );
  });

  it("rewraps encrypted field DEKs for managed KMS key rotation", async () => {
    const encryptedRepo = createEncryptedPayloadRepository(pool);
    const owner = await repo.createUser({
      email: `encrypted-rewrap-${randomUUID()}@example.com`
    });
    const sourceId = randomUUID();
    const keyV1 = randomBytes(32);
    const keyV2 = randomBytes(32);
    const originalProvider = createManagedKmsEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 1,
        keys: { 1: keyV1, 2: keyV2 }
      })
    );
    const rotatedProvider = createManagedKmsEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 2,
        keys: { 1: keyV1, 2: keyV2 }
      })
    );

    const stored = await encryptedRepo.upsertEncryptedField(
      { userId: owner.id },
      originalProvider,
      {
        sourceTable: "memory_events",
        sourceId,
        sourceColumn: "payload",
        plaintext: {
          content: "managed KMS rotated memory payload",
          workspaceId: "encrypted-rewrap"
        },
        scope: {
          tenantId: owner.id,
          objectClass: "memory_event"
        }
      }
    );
    expect(stored.envelope).toMatchObject({
      providerMode: "managed_kms",
      keyVersion: 1
    });

    const rewrap = await encryptedRepo.rewrapEncryptedFieldBatch(
      rotatedProvider,
      {
        ownerUserId: owner.id,
        sourceTable: "memory_events",
        sourceColumn: "payload",
        batchSize: 10
      }
    );
    expect(rewrap).toMatchObject({
      processedRows: 1,
      rewrappedRows: 1,
      failedRows: 0,
      done: true
    });
    expect(typeof rewrap.nextCursorId).toBe("string");

    const rotated = await encryptedRepo.getAuthorizedEncryptedField(
      { userId: owner.id },
      {
        sourceTable: "memory_events",
        sourceId,
        sourceColumn: "payload"
      }
    );
    expect(rotated?.envelope.keyVersion).toBe(2);
    expect(rotated?.envelope.wrappedDek.version).toBe(2);
    expect(rotated?.envelope.reencryptedAt).not.toBeNull();
    await expect(
      decryptEnvelopeToUtf8(rotatedProvider, rotated!.envelope)
    ).resolves.toContain("managed KMS rotated memory payload");

    const failingProvider = createManagedKmsEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 3,
        keys: { 1: keyV1, 2: keyV2, 3: randomBytes(32) },
        fail: true
      })
    );
    await expect(
      encryptedRepo.rewrapEncryptedFieldBatch(failingProvider, {
        ownerUserId: owner.id,
        force: true
      })
    ).rejects.toThrow(
      "Encrypted field rewrap failed after 0 successful row(s)"
    );

    const afterFailure = await encryptedRepo.getAuthorizedEncryptedField(
      { userId: owner.id },
      {
        sourceTable: "memory_events",
        sourceId,
        sourceColumn: "payload"
      }
    );
    expect(afterFailure?.envelope.keyVersion).toBe(2);
  });

  it("advances forced encrypted field rewraps across batches", async () => {
    const encryptedRepo = createEncryptedPayloadRepository(pool);
    const owner = await repo.createUser({
      email: `encrypted-force-rewrap-${randomUUID()}@example.com`
    });
    const key = randomBytes(32);
    const provider = createManagedKmsEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 1,
        keys: { 1: key }
      })
    );

    for (const suffix of ["a", "b", "c"]) {
      await encryptedRepo.upsertEncryptedField({ userId: owner.id }, provider, {
        sourceTable: "memory_events",
        sourceId: randomUUID(),
        sourceColumn: "payload",
        plaintext: {
          content: `forced rewrap ${suffix}`,
          workspaceId: "encrypted-force-rewrap"
        },
        scope: {
          tenantId: owner.id,
          objectClass: "memory_event"
        }
      });
    }

    const first = await encryptedRepo.rewrapEncryptedFieldBatch(provider, {
      ownerUserId: owner.id,
      sourceTable: "memory_events",
      sourceColumn: "payload",
      batchSize: 1,
      force: true
    });
    const second = await encryptedRepo.rewrapEncryptedFieldBatch(provider, {
      ownerUserId: owner.id,
      sourceTable: "memory_events",
      sourceColumn: "payload",
      batchSize: 1,
      force: true,
      afterId: first.nextCursorId!
    });
    const third = await encryptedRepo.rewrapEncryptedFieldBatch(provider, {
      ownerUserId: owner.id,
      sourceTable: "memory_events",
      sourceColumn: "payload",
      batchSize: 1,
      force: true,
      afterId: second.nextCursorId!
    });

    expect(first).toMatchObject({
      processedRows: 1,
      rewrappedRows: 1,
      done: false
    });
    expect(second).toMatchObject({
      processedRows: 1,
      rewrappedRows: 1,
      done: false
    });
    expect(third).toMatchObject({
      processedRows: 1,
      rewrappedRows: 1
    });
    expect(
      new Set([first.nextCursorId, second.nextCursorId, third.nextCursorId])
        .size
    ).toBe(3);
  });

  it("writes encrypted Memory Event payload companions when the repository has an envelope provider", async () => {
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 9).toString("base64")
    );
    const encryptedRepo = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const owner = await encryptedRepo.createUser({
      email: `encrypted-projection-${randomUUID()}@example.com`
    });

    const event = await encryptedRepo.createMemoryEvent(
      { userId: owner.id },
      {
        visibility: "personal",
        workspaceId: "encrypted-projection",
        actor: "assistant",
        eventType: "captured",
        rawEventType: "agent_message",
        content: "Projection-created Memory Event should have ciphertext.",
        captureMethod: "api",
        idempotencyKey: `encrypted-projection-${randomUUID()}`
      }
    );

    const encryptedRow = await pool.query(
      `
        select ciphertext, provenance
        from encrypted_field_payloads
        where owner_user_id = $1
          and source_table = 'memory_events'
          and source_id = $2
          and source_column = 'payload'
          and invalidated_at is null
      `,
      [owner.id, event.id]
    );
    expect(encryptedRow.rowCount).toBe(1);
    expect(JSON.stringify(encryptedRow.rows[0])).not.toContain(
      "Projection-created Memory Event"
    );

    await expect(
      encryptedRepo.decryptAuthorizedEncryptedField(
        { userId: owner.id },
        provider,
        {
          sourceTable: "memory_events",
          sourceId: event.id,
          sourceColumn: "payload"
        }
      )
    ).resolves.toMatchObject({
      plaintext: {
        content: "Projection-created Memory Event should have ciphertext.",
        workspaceId: "encrypted-projection"
      }
    });
  });

  it("fails closed before storing paid managed-cloud Memory Events without an envelope provider", async () => {
    await withPaidManagedCloudProfile(async () => {
      const owner = await repo.createUser({
        email: `managed-cloud-no-provider-${randomUUID()}@example.com`
      });
      const sentinel =
        "Managed cloud missing provider sentinel must never be stored.";
      const idempotencyKey = `managed-cloud-no-provider-${randomUUID()}`;

      await expect(
        repo.createMemoryEvent(
          { userId: owner.id },
          {
            visibility: "personal",
            workspaceId: "managed-cloud-no-provider",
            actor: "assistant",
            eventType: "captured",
            rawEventType: "agent_turn",
            content: sentinel,
            captureMethod: "api",
            idempotencyKey
          }
        )
      ).rejects.toThrow(
        "Envelope encryption provider is required when plaintext Memory Event payload storage is disabled"
      );

      const stored = await pool.query<{ count: number; payloads: string }>(
        `
          select
            count(*)::int as count,
            coalesce(string_agg(payload::text, ' '), '') as payloads
          from memory_events
          where owner_user_id = $1 or idempotency_key = $2
        `,
        [owner.id, idempotencyKey]
      );
      expect(stored.rows[0]).toMatchObject({ count: 0, payloads: "" });
    });
  });

  it("stores paid managed-cloud Memory Event content only in encrypted companions and hydrates authorized reads", async () => {
    await withPaidManagedCloudProfile(async () => {
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 11).toString("base64")
      );
      const encryptedRepo = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const owner = await encryptedRepo.createUser({
        email: `managed-cloud-encrypted-event-${randomUUID()}@example.com`
      });
      const sentinel =
        "Paid managed cloud encrypted Memory Event sentinel 1a8e87.";

      const event = await encryptedRepo.createMemoryEvent(
        { userId: owner.id },
        {
          visibility: "personal",
          workspaceId: "managed-cloud-encrypted-event",
          actor: "assistant",
          eventType: "captured",
          rawEventType: "agent_turn",
          content: sentinel,
          captureMethod: "api",
          idempotencyKey: `managed-cloud-encrypted-event-${randomUUID()}`
        }
      );

      const storedEvent = await pool.query<{
        payload: { content?: string; contentEncrypted?: boolean };
        payload_text: string;
      }>(
        `
          select payload, payload::text as payload_text
          from memory_events
          where id = $1
        `,
        [event.id]
      );
      expect(storedEvent.rows[0]?.payload).toMatchObject({
        contentEncrypted: true
      });
      expect(storedEvent.rows[0]?.payload.content).toBeUndefined();
      expect(storedEvent.rows[0]?.payload_text).not.toContain(sentinel);

      const encryptedRow = await pool.query<{ ciphertext: string }>(
        `
          select ciphertext
          from encrypted_field_payloads
          where owner_user_id = $1
            and source_table = 'memory_events'
            and source_id = $2
            and source_column = 'payload'
            and invalidated_at is null
        `,
        [owner.id, event.id]
      );
      expect(encryptedRow.rowCount).toBe(1);
      expect(JSON.stringify(encryptedRow.rows[0])).not.toContain(sentinel);

      await expect(
        encryptedRepo.decryptAuthorizedEncryptedField(
          { userId: owner.id },
          provider,
          {
            sourceTable: "memory_events",
            sourceId: event.id,
            sourceColumn: "payload"
          }
        )
      ).resolves.toMatchObject({
        plaintext: {
          content: sentinel,
          workspaceId: "managed-cloud-encrypted-event"
        }
      });

      const graphEvents = await encryptedRepo.listLcmGraphEvents(
        { userId: owner.id },
        { includeContent: true, limit: 10 }
      );
      expect(graphEvents.find((item) => item.id === event.id)?.content).toBe(
        sentinel
      );

      const embeddable = await encryptedRepo.getEmbeddableSource(
        "memory_event",
        event.id
      );
      expect(embeddable).toMatchObject({
        sourceType: "memory_event",
        sourceId: event.id,
        text: sentinel
      });
      expect(embeddable?.sourceHash).toBeDefined();
    });
  });

  it("stores paid managed-cloud LCM leaf node content only in encrypted companions and hydrates authorized reads", async () => {
    await withPaidManagedCloudProfile(async () => {
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 12).toString("base64")
      );
      const encryptedRepo = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const owner = await encryptedRepo.createUser({
        email: `managed-cloud-encrypted-lcm-${randomUUID()}@example.com`
      });
      const workspaceId = "managed-cloud-encrypted-lcm";
      const sentinel = "Managed cloud encrypted LCM source sentinel c2d19f";

      for (let index = 1; index <= 5; index += 1) {
        await encryptedRepo.createMemoryEvent(
          { userId: owner.id },
          {
            visibility: "personal",
            workspaceId,
            actor: "user",
            eventType: "captured",
            rawEventType: "user_prompt",
            content: `${sentinel} item ${index}`,
            captureMethod: "api",
            idempotencyKey: `managed-cloud-encrypted-lcm-${index}-${randomUUID()}`
          }
        );
      }

      const storedPayloads = await pool.query<{ payloads: string }>(
        `
          select string_agg(payload::text, ' ') as payloads
          from memory_events
          where owner_user_id = $1
        `,
        [owner.id]
      );
      expect(storedPayloads.rows[0]?.payloads).not.toContain(sentinel);

      const compacted = await encryptedRepo.createLcmNodes(
        { userId: owner.id },
        { visibility: "personal" }
      );
      expect(compacted.leafNodeIds).toHaveLength(1);

      const node = await pool.query<{ source_items_json: unknown }>(
        `
          select summary_text, body_text, source_items_json::text as source_items_json
          from memory_nodes
          where id = $1
        `,
        [compacted.leafNodeIds[0]]
      );
      expect(JSON.stringify(node.rows[0])).toContain(
        "[koed encrypted memory node]"
      );
      expect(JSON.stringify(node.rows[0])).not.toContain(`${sentinel} item 1`);
      expect(JSON.stringify(node.rows[0])).not.toContain(`${sentinel} item 5`);

      const encryptedRows = await pool.query<{
        source_column: string;
        ciphertext: string;
      }>(
        `
          select source_column, ciphertext
          from encrypted_field_payloads
          where owner_user_id = $1
            and source_table = 'memory_nodes'
            and source_id = $2
            and invalidated_at is null
          order by source_column
        `,
        [owner.id, compacted.leafNodeIds[0]]
      );
      expect(encryptedRows.rows.map((row) => row.source_column)).toEqual([
        "body_text",
        "source_items_json",
        "summary_text"
      ]);
      expect(JSON.stringify(encryptedRows.rows)).not.toContain(sentinel);

      const decryptedSourceItems =
        await encryptedRepo.decryptAuthorizedEncryptedField(
          { userId: owner.id },
          provider,
          {
            sourceTable: "memory_nodes",
            sourceId: compacted.leafNodeIds[0]!,
            sourceColumn: "source_items_json"
          }
        );
      expect(JSON.stringify(decryptedSourceItems?.plaintext)).toContain(
        `${sentinel} item 1`
      );
      expect(JSON.stringify(decryptedSourceItems?.plaintext)).toContain(
        `${sentinel} item 5`
      );

      const graphNode = await encryptedRepo.getLcmGraphNode(
        { userId: owner.id },
        compacted.leafNodeIds[0]!
      );
      expect(graphNode?.summaryText).toContain(`${sentinel} item 1`);
      expect(JSON.stringify(graphNode?.sourceItems)).toContain(
        `${sentinel} item 5`
      );

      const summarizationNode = await encryptedRepo.getLcmNodeForSummarization(
        compacted.leafNodeIds[0]!
      );
      expect(summarizationNode?.summaryText).toContain(`${sentinel} item 1`);
      expect(JSON.stringify(summarizationNode?.sourceItems)).toContain(
        `${sentinel} item 5`
      );

      const embeddable = await encryptedRepo.getEmbeddableSource(
        "memory_node",
        compacted.leafNodeIds[0]!
      );
      expect(embeddable?.text).toContain(`${sentinel} item 1`);
      expect(embeddable?.text).toContain(`${sentinel} item 5`);
    });
  });

  it("stores paid managed-cloud LCM summary updates only in encrypted companions and hydrates authorized reads", async () => {
    await withPaidManagedCloudProfile(async () => {
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 13).toString("base64")
      );
      const encryptedRepo = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const owner = await encryptedRepo.createUser({
        email: `managed-cloud-node-summary-${randomUUID()}@example.com`
      });
      const node = await encryptedRepo.createMemoryNode(
        { userId: owner.id },
        {
          visibility: "personal",
          summaryText: "Managed cloud pending summary sentinel 731f3c"
        }
      );
      const structured = {
        title: "Encrypted managed cloud node",
        summary_text: "Managed cloud finished summary sentinel 731f3c",
        facts: ["The LCM worker summary is encrypted at rest."]
      };

      await encryptedRepo.updateLcmNodeSummary({
        nodeId: node.id,
        summaryText: "Managed cloud finished summary sentinel 731f3c",
        summaryModel: "codex:test",
        summaryPromptVersion: "lcm-codex-summary-json-v2",
        summaryTokenEstimate: 23,
        summaryStructuredJson: structured,
        summaryStructuredSchemaVersion: "lcm-structured-summary-v1"
      });

      const stored = await pool.query<{
        summary_text: string;
        body_text: string | null;
        summary_structured_json: unknown;
        row_text: string;
      }>(
        `
          select summary_text, body_text, summary_structured_json, to_jsonb(memory_nodes)::text as row_text
          from memory_nodes
          where id = $1
        `,
        [node.id]
      );
      expect(stored.rows[0]?.summary_text).toBe("[koed encrypted memory node]");
      expect(stored.rows[0]?.body_text).toBe("[koed encrypted memory node]");
      expect(stored.rows[0]?.summary_structured_json).toMatchObject({
        contentEncrypted: true,
        encryptedSourceTable: "memory_nodes"
      });
      expect(stored.rows[0]?.row_text).not.toContain(
        "Managed cloud finished summary sentinel"
      );

      const encryptedRows = await pool.query<{ source_column: string }>(
        `
          select source_column
          from encrypted_field_payloads
          where owner_user_id = $1
            and source_table = 'memory_nodes'
            and source_id = $2
            and invalidated_at is null
          order by source_column
        `,
        [owner.id, node.id]
      );
      expect(encryptedRows.rows.map((row) => row.source_column)).toContain(
        "summary_structured_json"
      );

      const fetched = await encryptedRepo.getLcmNodeForSummarization(node.id);
      const visible = await encryptedRepo.getVisibleLcmNodeForSummarization(
        { userId: owner.id },
        node.id
      );
      const graphNode = await encryptedRepo.getLcmGraphNode(
        { userId: owner.id },
        node.id
      );
      expect(fetched?.summaryText).toBe(
        "Managed cloud finished summary sentinel 731f3c"
      );
      expect(fetched?.summaryStructuredJson).toEqual(structured);
      expect(visible?.summaryStructuredJson).toEqual(structured);
      expect(graphNode?.summaryText).toBe(
        "Managed cloud finished summary sentinel 731f3c"
      );
      expect(graphNode?.summaryStructuredJson).toEqual(structured);
    });
  });

  it("keeps null paid managed-cloud Memory Node title and body fields null", async () => {
    await withPaidManagedCloudProfile(async () => {
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 44).toString("base64")
      );
      const encryptedRepo = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const owner = await encryptedRepo.createUser({
        email: `managed-cloud-null-node-fields-${randomUUID()}@example.com`
      });
      const node = await encryptedRepo.createMemoryNode(
        { userId: owner.id },
        {
          visibility: "personal",
          title: null,
          summaryText: "Managed cloud null node fields summary sentinel",
          bodyText: null
        }
      );

      const stored = await pool.query<{
        title: string | null;
        body_text: string | null;
        encrypted_optional_fields: number;
      }>(
        `
          select
            mn.title,
            mn.body_text,
            count(efp.id) filter (
              where efp.source_column in ('title', 'body_text')
            )::int as encrypted_optional_fields
          from memory_nodes mn
          left join encrypted_field_payloads efp
            on efp.source_table = 'memory_nodes'
           and efp.source_id = mn.id
          where mn.id = $1
          group by mn.id
        `,
        [node.id]
      );

      expect(stored.rows[0]).toMatchObject({
        title: null,
        body_text: null,
        encrypted_optional_fields: 0
      });
      expect(node.title).toBeNull();
    });
  });

  it("stores paid managed-cloud embedding source text only in encrypted companions and hydrates retrieval rows", async () => {
    await withPaidManagedCloudProfile(async () => {
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 14).toString("base64")
      );
      const encryptedRepo = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const owner = await encryptedRepo.createUser({
        email: `managed-cloud-embedding-source-${randomUUID()}@example.com`
      });
      const sentinel =
        "Managed cloud encrypted embedding source sentinel 98b8b7";
      const event = await encryptedRepo.createMemoryEvent(
        { userId: owner.id },
        {
          visibility: "personal",
          workspaceId: "managed-cloud-embedding-source",
          actor: "assistant",
          eventType: "captured",
          rawEventType: "agent_turn",
          content: sentinel,
          captureMethod: "api",
          idempotencyKey: `managed-cloud-embedding-source-${randomUUID()}`
        }
      );
      const vector = Array.from({ length: 1024 }, (_, index) =>
        index === 0 ? 1 : 0
      );

      await encryptedRepo.upsertSourceEmbedding({
        source: {
          sourceType: "memory_event",
          sourceId: event.id,
          ownerUserId: owner.id,
          visibility: "personal",
          text: sentinel,
          sourceHash: `managed-cloud-embedding-source-${randomUUID()}`
        },
        model: process.env.EMBEDDING_MODEL ?? "qwen3-0.6b",
        dimensions: 1024,
        version: process.env.EMBEDDING_MODEL ?? "qwen3-0.6b",
        vector,
        sourceText: sentinel
      });

      const storedEmbedding = await pool.query<{
        id: string;
        source_text: string;
        queryable_vector_strategy: string;
        search_boundary: string;
        canonical_embedding_state: string;
      }>(
        `
          select
            id,
            source_text,
            queryable_vector_strategy,
            search_boundary,
            canonical_embedding_state
          from memory_embeddings
          where memory_event_id = $1
        `,
        [event.id]
      );
      expect(storedEmbedding.rows[0]?.source_text).toBe(
        "[koed encrypted embedding source]"
      );
      expect(storedEmbedding.rows[0]).toMatchObject({
        queryable_vector_strategy: "trusted_backend_pgvector_v1",
        search_boundary: "owner_user_dynamic_grants",
        canonical_embedding_state: "not_stored"
      });

      const encryptedRows = await pool.query<{ ciphertext: string }>(
        `
          select ciphertext
          from encrypted_field_payloads
          where owner_user_id = $1
            and source_table = 'memory_embeddings'
            and source_id = $2
            and source_column = 'source_text'
            and invalidated_at is null
        `,
        [owner.id, storedEmbedding.rows[0]!.id]
      );
      expect(encryptedRows.rowCount).toBe(1);
      expect(JSON.stringify(encryptedRows.rows)).not.toContain(sentinel);

      const fetchMock = mockEmbeddingQuery();
      try {
        const search = await encryptedRepo.searchMemoryNodes(
          { userId: owner.id },
          {
            query: "managed cloud encrypted embedding source",
            scope: "personal",
            searchDomain: "global",
            retrievalStage: "raw_fallback_search",
            limit: 5
          }
        );
        expect(search.results[0]?.summaryText).toContain(sentinel);
      } finally {
        fetchMock.mockRestore();
      }
    });
  });

  it("fails closed before storing paid managed-cloud raw conversation items without an envelope provider", async () => {
    await withPaidManagedCloudProfile(async () => {
      const owner = await repo.createUser({
        email: `managed-cloud-raw-no-provider-${randomUUID()}@example.com`
      });
      const idempotencyKey = `managed-cloud-raw-no-provider-${randomUUID()}`;

      await expect(
        repo.createConversationItems(
          { userId: owner.id },
          {
            items: [
              {
                sourceKind: "codex",
                sourceAdapterVersion: "codex-transcript-v1",
                sourceTransport: "hook",
                sourceRecordType: "event_msg",
                sourceEventType: "user_message",
                rawJson: {
                  type: "event_msg",
                  payload: {
                    type: "user_message",
                    role: "user",
                    content: "Raw provider missing sentinel."
                  }
                },
                rawText: "Raw provider missing sentinel.",
                sourceHash: `managed-cloud-raw-no-provider-${randomUUID()}`,
                idempotencyKey,
                metadata: { transcriptType: "user_message" }
              }
            ]
          }
        )
      ).rejects.toThrow(
        "Envelope encryption provider is required when plaintext conversation item storage is disabled"
      );

      const stored = await pool.query<{ count: number }>(
        "select count(*)::int as count from conversation_items where owner_user_id = $1 or idempotency_key = $2",
        [owner.id, idempotencyKey]
      );
      expect(stored.rows[0]?.count).toBe(0);
    });
  });

  it("skips encrypted companions for empty optional conversation text", async () => {
    await withPaidManagedCloudProfile(async () => {
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 17).toString("base64")
      );
      const encryptedRepo = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const owner = await encryptedRepo.createUser({
        email: `managed-cloud-empty-raw-${randomUUID()}@example.com`
      });
      const session = await encryptedRepo.createCapturedSession(
        { userId: owner.id },
        {
          externalSessionId: `managed-cloud-empty-raw-${randomUUID()}`,
          sourceRuntime: "codex",
          captureMethod: "hook"
        }
      );
      const [item] = await encryptedRepo.createConversationItems(
        { userId: owner.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "transcript",
              externalSessionId: session.externalSessionId ?? undefined,
              externalThreadId: session.externalSessionId ?? undefined,
              externalTurnId: "empty-raw-turn",
              sourceRecordType: "event_msg",
              sourceEventType: "task_started",
              sourcePath: "/tmp/empty-raw-rollout.jsonl",
              sourceLineNumber: 0,
              sourceSequence: 0,
              rawJson: {
                type: "event_msg",
                payload: { type: "task_started", turn_id: "empty-raw-turn" }
              },
              rawText: "",
              sourceHash: `managed-cloud-empty-raw-${randomUUID()}`,
              idempotencyKey: `managed-cloud-empty-raw-${randomUUID()}`,
              metadata: { transcriptType: "task_started" }
            }
          ]
        }
      );

      const stored = await pool.query<{
        raw_text: string | null;
        source_path: string | null;
        encrypted_columns: string[];
      }>(
        `
          select
            raw_text,
            source_path,
            metadata -> 'encryptedConversationItemColumns' as encrypted_columns
          from conversation_items
          where id = $1
        `,
        [item!.id]
      );
      expect(stored.rows[0]).toMatchObject({
        raw_text: "",
        source_path: "[koed encrypted conversation item]",
        encrypted_columns: ["raw_json", "source_path", "metadata"]
      });
      const encryptedColumns = await pool.query<{ source_column: string }>(
        `
          select source_column
          from encrypted_field_payloads
          where owner_user_id = $1
            and source_table in ('conversation_items', 'conversation_item_observations')
            and source_column = 'raw_text'
            and invalidated_at is null
        `,
        [owner.id]
      );
      expect(encryptedColumns.rows).toEqual([]);
    });
  });

  it("atomically augments encrypted app-server items with transcript provenance", async () => {
    await withPaidManagedCloudProfile(async () => {
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 18).toString("base64")
      );
      const encryptedRepo = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const owner = await encryptedRepo.createUser({
        email: `managed-cloud-provenance-${randomUUID()}@example.com`
      });
      const externalThreadId = `managed-cloud-provenance-${randomUUID()}`;
      const externalTurnId = "managed-cloud-provenance-turn";
      const stableItemId = "managed-cloud-provenance-user";
      const session = await encryptedRepo.createCapturedSession(
        { userId: owner.id },
        {
          externalSessionId: externalThreadId,
          sourceRuntime: "codex",
          captureMethod: "api",
          codexTranscriptPath: "/tmp/managed-cloud-provenance.jsonl",
          metadata: { managedConversation: true }
        }
      );
      const canonicalItemKey = codexCanonicalConversationItemKey({
        externalThreadId,
        externalTurnId,
        stableItemId,
        component: "message"
      });
      const sentinel = "Encrypted app-server provenance sentinel 6b35b1.";
      const common = {
        sessionId: session.id,
        sourceKind: "codex",
        externalSessionId: externalThreadId,
        externalThreadId,
        externalTurnId,
        externalItemId: stableItemId,
        rawText: sentinel,
        canonicalItemKey,
        canonicalStableItemId: stableItemId,
        observationComponent: "message",
        projectionStatus: "pending" as const
      };

      const [appServerItem] = await encryptedRepo.createConversationItems(
        { userId: owner.id },
        {
          items: [
            {
              ...common,
              sourceAdapterVersion: "codex-app-server-conversation-v1",
              sourceTransport: "app_server",
              sourceRecordType: "app_server_notification",
              sourceEventType: "item/completed",
              sourceSequence: 1,
              eventTime: "2026-04-01T12:00:00.000Z",
              rawJson: {
                method: "item/completed",
                params: {
                  item: {
                    id: stableItemId,
                    type: "userMessage",
                    content: [{ type: "text", text: sentinel }]
                  }
                }
              },
              sourceHash: `managed-cloud-app-${randomUUID()}`,
              idempotencyKey: `managed-cloud-app-${randomUUID()}`,
              canonicalSourcePriority: 300,
              observationKind: "lifecycle_completed",
              projectionVersion: "codex-app-server-conversation-v1",
              metadata: {
                managedConversation: true,
                transcriptType: "user_message",
                providerDetail: "app-server",
                toolCall: {
                  id: "managed-cloud-provenance-call",
                  name: "exec_command",
                  input: { cmd: "/bin/bash -lc 'printf provenance'" }
                }
              }
            }
          ]
        }
      );
      const [transcriptItem] = await encryptedRepo.createConversationItems(
        { userId: owner.id },
        {
          items: [
            {
              ...common,
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "transcript",
              sourceRecordType: "event_msg",
              sourceEventType: "user_message",
              sourcePath: "/tmp/managed-cloud-provenance.jsonl",
              sourceLineNumber: 3,
              sourceSequence: 3,
              eventTime: "2026-04-01T12:00:00.000Z",
              rawJson: {
                timestamp: "2026-04-01T12:00:00.000Z",
                type: "event_msg",
                payload: { type: "user_message", message: sentinel }
              },
              sourceHash: `managed-cloud-transcript-${randomUUID()}`,
              idempotencyKey: `managed-cloud-transcript-${randomUUID()}`,
              canonicalSourcePriority: 200,
              observationKind: "reconciliation",
              projectionVersion: "codex-transcript-v1",
              metadata: {
                managedConversationReconciliation: true,
                transcriptType: "user_message",
                transcriptDetail: "persisted-rollout",
                toolCall: {
                  id: "managed-cloud-provenance-call",
                  input: {
                    cmd: "printf provenance",
                    workdir: "/tmp/provenance"
                  },
                  output: { exitCode: 0, chunkId: "provenance-chunk" }
                }
              }
            }
          ]
        }
      );
      expect(transcriptItem!.id).toBe(appServerItem!.id);

      const stored = await pool.query<{
        source_path: string | null;
        encrypted_columns: string[];
        encrypted_source_path_count: number;
      }>(
        `
          select
            ci.source_path,
            ci.metadata -> 'encryptedConversationItemColumns' as encrypted_columns,
            count(ep.id) filter (
              where ep.source_column = 'source_path'
                and ep.invalidated_at is null
            )::int as encrypted_source_path_count
          from conversation_items as ci
          left join encrypted_field_payloads as ep
            on ep.source_table = 'conversation_items'
            and ep.source_id = ci.id
          where ci.id = $1
          group by ci.id
        `,
        [appServerItem!.id]
      );
      expect(stored.rows[0]).toMatchObject({
        source_path: "[koed encrypted conversation item]",
        encrypted_columns: ["raw_json", "raw_text", "source_path", "metadata"],
        encrypted_source_path_count: 1
      });
      const decryptedMetadata = await createEncryptedPayloadRepository(
        pool
      ).decryptAuthorizedEncryptedField({ userId: owner.id }, provider, {
        sourceTable: "conversation_items",
        sourceId: appServerItem!.id,
        sourceColumn: "metadata"
      });
      expect(decryptedMetadata?.plaintext).toMatchObject({
        managedConversationReconciliation: true,
        providerDetail: "app-server",
        transcriptDetail: "persisted-rollout",
        toolCall: {
          id: "managed-cloud-provenance-call",
          name: "exec_command",
          input: {
            cmd: "/bin/bash -lc 'printf provenance'",
            workdir: "/tmp/provenance"
          },
          output: { exitCode: 0, chunkId: "provenance-chunk" }
        }
      });

      const terminalStableItemId = `turn:${externalTurnId}:completed`;
      const terminalCanonicalItemKey = codexCanonicalConversationItemKey({
        externalThreadId,
        externalTurnId,
        stableItemId: terminalStableItemId,
        component: "control"
      });
      await encryptedRepo.createConversationItems(
        { userId: owner.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-app-server-conversation-v1",
              sourceTransport: "app_server",
              externalSessionId: externalThreadId,
              externalThreadId,
              externalTurnId,
              sourceRecordType: "app_server_notification",
              sourceEventType: "turn/completed",
              sourceSequence: 4,
              eventTime: "2026-04-01T12:00:01.000Z",
              rawJson: {
                method: "turn/completed",
                params: { turn: { id: externalTurnId, status: "completed" } }
              },
              sourceHash: `managed-cloud-terminal-app-${randomUUID()}`,
              idempotencyKey: `managed-cloud-terminal-app-${randomUUID()}`,
              canonicalItemKey: terminalCanonicalItemKey,
              canonicalStableItemId: terminalStableItemId,
              observationKind: "control",
              observationComponent: "control",
              projectionStatus: "pending",
              projectionVersion: "codex-app-server-conversation-v1",
              metadata: {
                managedConversation: true,
                transcriptType: "turn/completed",
                semanticControl: "turn_completed"
              }
            },
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "transcript",
              externalSessionId: externalThreadId,
              externalThreadId,
              externalTurnId,
              sourceRecordType: "event_msg",
              sourceEventType: "task_complete",
              sourcePath: "/tmp/managed-cloud-provenance.jsonl",
              sourceLineNumber: 4,
              sourceSequence: 4,
              eventTime: "2026-04-01T12:00:01.000Z",
              rawJson: {
                type: "event_msg",
                payload: { type: "task_complete", turn_id: externalTurnId }
              },
              sourceHash: `managed-cloud-terminal-transcript-${randomUUID()}`,
              idempotencyKey: `managed-cloud-terminal-transcript-${randomUUID()}`,
              canonicalItemKey: terminalCanonicalItemKey,
              canonicalStableItemId: terminalStableItemId,
              observationKind: "reconciliation",
              observationComponent: "control",
              projectionStatus: "pending",
              projectionVersion: "codex-transcript-v1",
              metadata: {
                managedConversationReconciliation: true,
                transcriptType: "task_complete",
                semanticControl: "turn_completed"
              }
            }
          ]
        }
      );
      await encryptedRepo.releaseConversationProjectionHold(
        { userId: owner.id },
        { sessionId: session.id, externalTurnId }
      );
      const projection = await encryptedRepo.projectPendingConversationItems(
        { userId: owner.id },
        { limit: 10 }
      );
      expect(projection).toMatchObject({
        rawItemsScanned: 2,
        messagesCreated: 1,
        memoryEventsCreated: 1
      });
    });
  });

  it("projects paid managed-cloud raw conversation items from encrypted companions", async () => {
    await withPaidManagedCloudProfile(async () => {
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 15).toString("base64")
      );
      const encryptedRepo = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const owner = await encryptedRepo.createUser({
        email: `managed-cloud-raw-project-${randomUUID()}@example.com`
      });
      const workspaceId = randomUUID();
      await pool.query(
        `
          insert into workspaces (id, owner_user_id, visibility, name)
          values ($1, $2, 'personal', 'Managed Cloud Raw Projection')
        `,
        [workspaceId, owner.id]
      );
      const session = await encryptedRepo.createCapturedSession(
        { userId: owner.id },
        {
          workspaceId,
          externalSessionId: `managed-cloud-raw-project-${randomUUID()}`,
          sourceRuntime: "codex",
          captureMethod: "hook"
        }
      );
      const sentinel =
        "Paid managed cloud raw transcript projection sentinel 930f51.";
      const canonicalItemKey = codexCanonicalConversationItemKey({
        externalThreadId: session.externalSessionId!,
        externalTurnId: "managed-cloud-raw-user-turn",
        stableItemId: "turn:managed-cloud-raw-user-turn:user",
        component: "message"
      });
      const [rawItem] = await encryptedRepo.createConversationItems(
        { userId: owner.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "transcript",
              externalSessionId: session.externalSessionId ?? undefined,
              externalThreadId: session.externalSessionId ?? undefined,
              externalTurnId: "managed-cloud-raw-user-turn",
              sourceRecordType: "event_msg",
              sourceEventType: "user_message",
              sourceSequence: 1,
              eventTime: "2026-04-01T12:00:00.000Z",
              rawJson: {
                type: "event_msg",
                payload: {
                  type: "user_message",
                  role: "user",
                  content: sentinel
                }
              },
              rawText: sentinel,
              sourceHash: `managed-cloud-raw-project-${randomUUID()}`,
              idempotencyKey: `managed-cloud-raw-project-${randomUUID()}`,
              canonicalItemKey,
              canonicalStableItemId: "turn:managed-cloud-raw-user-turn:user",
              canonicalSourcePriority: 200,
              observationKind: "reconciliation",
              observationComponent: "message",
              projectionStatus: "pending",
              metadata: {
                workspaceId: "client-controlled-workspace-sentinel",
                transcriptType: "user_message"
              }
            }
          ]
        }
      );
      const [appServerItem] = await encryptedRepo.createConversationItems(
        { userId: owner.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-app-server-conversation-v1",
              sourceTransport: "app_server",
              externalSessionId: session.externalSessionId ?? undefined,
              externalThreadId: session.externalSessionId ?? undefined,
              externalTurnId: "managed-cloud-raw-user-turn",
              externalItemId: "managed-cloud-user-item",
              sourceRecordType: "app_server_notification",
              sourceEventType: "item/completed",
              sourceSequence: 1,
              eventTime: "2026-04-01T12:00:00.000Z",
              rawJson: {
                method: "item/completed",
                params: {
                  item: {
                    id: "managed-cloud-user-item",
                    type: "userMessage",
                    content: [{ type: "text", text: sentinel }]
                  }
                }
              },
              rawText: sentinel,
              sourceHash: `managed-cloud-app-server-${randomUUID()}`,
              idempotencyKey: `managed-cloud-app-server-${randomUUID()}`,
              canonicalItemKey,
              canonicalStableItemId: "turn:managed-cloud-raw-user-turn:user",
              canonicalSourcePriority: 300,
              observationKind: "lifecycle_completed",
              observationComponent: "message",
              projectionStatus: "pending",
              projectionVersion: "codex-app-server-conversation-v1",
              metadata: {
                workspaceId: "client-controlled-workspace-sentinel",
                managedConversation: true,
                transcriptType: "user_message"
              }
            }
          ]
        }
      );
      expect(appServerItem!.id).toBe(rawItem!.id);

      const storedRaw = await pool.query<{
        raw_json_text: string;
        raw_text: string | null;
        metadata: Record<string, unknown>;
      }>(
        `
          select raw_json::text as raw_json_text, raw_text, metadata
          from conversation_items
          where id = $1
        `,
        [rawItem!.id]
      );
      expect(storedRaw.rows[0]?.raw_json_text).not.toContain(sentinel);
      expect(storedRaw.rows[0]?.raw_text).not.toContain(sentinel);
      expect(storedRaw.rows[0]?.metadata).not.toHaveProperty("workspaceId");
      expect(JSON.stringify(storedRaw.rows[0])).not.toContain(
        "client-controlled-workspace-sentinel"
      );
      expect(storedRaw.rows[0]?.metadata).toMatchObject({
        encryptedConversationItemColumns: ["raw_json", "raw_text", "metadata"]
      });

      const encryptedFields = await pool.query<{
        source_column: string;
        ciphertext: string;
      }>(
        `
          select source_column, ciphertext
          from encrypted_field_payloads
          where owner_user_id = $1
            and source_table = 'conversation_items'
            and source_id = $2
            and invalidated_at is null
          order by source_column asc
        `,
        [owner.id, rawItem!.id]
      );
      expect(encryptedFields.rows.map((row) => row.source_column)).toEqual([
        "metadata",
        "raw_json",
        "raw_text"
      ]);
      expect(JSON.stringify(encryptedFields.rows)).not.toContain(sentinel);

      const storedObservations = await pool.query<{
        id: string;
        raw_json_text: string;
        raw_text: string | null;
        metadata: Record<string, unknown>;
      }>(
        `
          select id, raw_json::text as raw_json_text, raw_text, metadata
          from conversation_item_observations
          where conversation_item_id = $1
        `,
        [rawItem!.id]
      );
      expect(storedObservations.rows).toHaveLength(2);
      expect(JSON.stringify(storedObservations.rows)).not.toContain(sentinel);
      for (const observation of storedObservations.rows) {
        expect(observation.metadata).not.toHaveProperty("workspaceId");
      }
      for (const observation of storedObservations.rows) {
        expect(observation.metadata).toMatchObject({
          encryptedConversationItemObservationColumns: [
            "raw_json",
            "raw_text",
            "metadata"
          ]
        });
      }
      const encryptedObservationFields = await pool.query<{
        source_column: string;
        ciphertext: string;
      }>(
        `
          select source_column, ciphertext
          from encrypted_field_payloads
          where owner_user_id = $1
            and source_table = 'conversation_item_observations'
            and source_id = any($2::uuid[])
            and invalidated_at is null
          order by source_column asc
        `,
        [owner.id, storedObservations.rows.map((observation) => observation.id)]
      );
      expect(
        encryptedObservationFields.rows.map((row) => row.source_column)
      ).toEqual([
        "metadata",
        "metadata",
        "raw_json",
        "raw_json",
        "raw_text",
        "raw_text"
      ]);
      expect(JSON.stringify(encryptedObservationFields.rows)).not.toContain(
        sentinel
      );

      const projection = await encryptedRepo.projectPendingConversationItems(
        { userId: owner.id },
        { limit: 10 }
      );
      expect(projection).toMatchObject({
        messagesCreated: 1,
        memoryEventsCreated: 1
      });
      const messages = await pool.query<{
        id: string;
        content: string;
        content_json_text: string | null;
      }>(
        "select id, content, content_json::text as content_json_text from messages where session_id = $1",
        [session.id]
      );
      expect(messages.rows.map((row) => row.content)).toEqual([
        "[koed encrypted message]"
      ]);
      expect(JSON.stringify(messages.rows)).not.toContain(sentinel);
      const encryptedMessageFields = await pool.query<{
        source_column: string;
      }>(
        `
	          select source_column
	          from encrypted_field_payloads
	          where owner_user_id = $1
	            and source_table = 'messages'
	            and source_id = $2
	            and invalidated_at is null
	          order by source_column asc
	        `,
        [owner.id, messages.rows[0]!.id]
      );
      expect(
        encryptedMessageFields.rows.map((row) => row.source_column)
      ).toEqual(["content", "content_json"]);
      const graphEvents = await encryptedRepo.listLcmGraphEvents(
        { userId: owner.id },
        { includeContent: true, limit: 10 }
      );
      expect(graphEvents.map((event) => event.content)).toContain(sentinel);
      const graphThreads = await encryptedRepo.listLcmGraphThreads({
        userId: owner.id
      });
      expect(
        graphThreads.flatMap((project) =>
          project.threads.map((thread) => thread.sample)
        )
      ).toContain(sentinel);
    });
  });

  it("keeps encrypted raw_json companions aligned with canonical duplicate winners", async () => {
    await withPaidManagedCloudProfile(async () => {
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 18).toString("base64")
      );
      const encryptedRepo = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const owner = await encryptedRepo.createUser({
        email: `managed-cloud-raw-canonical-${randomUUID()}@example.com`
      });
      const session = await encryptedRepo.createCapturedSession(
        { userId: owner.id },
        {
          externalSessionId: `managed-cloud-raw-canonical-${randomUUID()}`,
          sourceRuntime: "codex",
          captureMethod: "hook"
        }
      );
      const transcriptSentinel =
        "Paid managed cloud canonical transcript winner sentinel 5a7420.";
      const lowerPrioritySentinel =
        "Paid managed cloud lower priority hook duplicate sentinel 3ef915.";
      const idempotencyKey = `managed-cloud-raw-canonical-${randomUUID()}`;
      const [stored] = await encryptedRepo.createConversationItems(
        { userId: owner.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "hook",
              externalSessionId: session.externalSessionId ?? undefined,
              externalThreadId: session.externalSessionId ?? undefined,
              externalTurnId: "managed-cloud-raw-canonical-turn",
              sourceRecordType: "event_msg",
              sourceEventType: "user_message",
              sourceSequence: 1,
              eventTime: "2026-04-01T12:00:00.000Z",
              rawJson: {
                type: "event_msg",
                payload: {
                  type: "user_message",
                  role: "user",
                  content: transcriptSentinel
                }
              },
              rawText: transcriptSentinel,
              sourceHash: `managed-cloud-raw-canonical-transcript-${randomUUID()}`,
              idempotencyKey,
              projectionStatus: "pending",
              metadata: { transcriptType: "user_message" }
            }
          ]
        }
      );

      await encryptedRepo.createConversationItems(
        { userId: owner.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-hook-v1",
              sourceTransport: "hook",
              externalSessionId: session.externalSessionId ?? undefined,
              externalThreadId: session.externalSessionId ?? undefined,
              externalTurnId: "managed-cloud-raw-canonical-turn",
              sourceRecordType: "hook_payload",
              sourceEventType: "Stop",
              sourceSequence: 2,
              eventTime: "2026-04-01T12:00:01.000Z",
              rawJson: {
                hook_event_name: "Stop",
                message: lowerPrioritySentinel
              },
              sourceHash: `managed-cloud-raw-canonical-hook-${randomUUID()}`,
              idempotencyKey,
              metadata: {}
            }
          ]
        }
      );

      const encrypted = await pool.query<{
        envelope_version: number;
        provider_mode: EncryptedPayloadEnvelope["providerMode"];
        key_id: string;
        key_version: number;
        scope: EncryptedPayloadEnvelope["scope"];
        provenance: EncryptedPayloadEnvelope["provenance"];
        algorithm: EncryptedPayloadEnvelope["algorithm"];
        ciphertext: string;
        nonce: string;
        tag: string;
        wrapped_dek: EncryptedPayloadEnvelope["wrappedDek"];
        ciphertext_location: EncryptedPayloadEnvelope["ciphertextLocation"];
        aad: EncryptedPayloadEnvelope["aad"];
        envelope_created_at: Date;
        envelope_reencrypted_at: Date | null;
      }>(
        `
          select
            envelope_version,
            provider_mode,
            key_id,
            key_version,
            scope,
            provenance,
            algorithm,
            ciphertext,
            nonce,
            tag,
            wrapped_dek,
            ciphertext_location,
            aad,
            envelope_created_at,
            envelope_reencrypted_at
          from encrypted_field_payloads
          where owner_user_id = $1
            and source_table = 'conversation_items'
            and source_id = $2
            and source_column = 'raw_json'
            and invalidated_at is null
        `,
        [owner.id, stored!.id]
      );
      expect(encrypted.rows).toHaveLength(1);
      const row = encrypted.rows[0]!;
      const decrypted = await decryptEnvelopeToUtf8(provider, {
        version: row.envelope_version as 1,
        providerMode: row.provider_mode,
        keyId: row.key_id,
        keyVersion: row.key_version,
        scope: row.scope,
        provenance: row.provenance,
        algorithm: row.algorithm,
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        tag: row.tag,
        wrappedDek: row.wrapped_dek,
        ciphertextLocation: row.ciphertext_location,
        aad: row.aad,
        createdAt: row.envelope_created_at.toISOString(),
        reencryptedAt: row.envelope_reencrypted_at?.toISOString() ?? null
      });
      expect(decrypted).toContain(transcriptSentinel);
      expect(decrypted).not.toContain(lowerPrioritySentinel);
    });
  });

  it("projects paid managed-cloud tool events from encrypted display companions", async () => {
    await withPaidManagedCloudProfile(async () => {
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 19).toString("base64")
      );
      const encryptedRepo = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const owner = await encryptedRepo.createUser({
        email: `managed-cloud-tool-event-${randomUUID()}@example.com`
      });
      const session = await encryptedRepo.createCapturedSession(
        { userId: owner.id },
        {
          externalSessionId: `managed-cloud-tool-event-${randomUUID()}`,
          sourceRuntime: "codex",
          captureMethod: "hook"
        }
      );
      const callId = `managed-cloud-tool-call-${randomUUID()}`;
      const inputSentinel = "paid managed cloud tool input sentinel 08cab1";
      const outputSentinel = "paid managed cloud tool output sentinel aa3914";
      await encryptedRepo.createConversationItems(
        { userId: owner.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "hook",
              externalSessionId: session.externalSessionId ?? undefined,
              externalThreadId: session.externalSessionId ?? undefined,
              externalTurnId: "managed-cloud-tool-turn",
              sourceRecordType: "event_msg",
              sourceEventType: "function_call",
              sourceSequence: 1,
              eventTime: "2026-04-01T12:00:00.000Z",
              rawJson: {
                type: "event_msg",
                payload: {
                  type: "function_call",
                  name: "exec_command",
                  arguments: { cmd: inputSentinel }
                }
              },
              rawText: `Tool call: ${inputSentinel}`,
              sourceHash: `managed-cloud-tool-call-${randomUUID()}`,
              idempotencyKey: `managed-cloud-tool-call-${randomUUID()}`,
              projectionStatus: "pending",
              metadata: {
                transcriptType: "function_call",
                toolName: "exec_command",
                toolCall: {
                  kind: "call",
                  id: callId,
                  name: "exec_command",
                  input: { cmd: inputSentinel }
                }
              }
            },
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "hook",
              externalSessionId: session.externalSessionId ?? undefined,
              externalThreadId: session.externalSessionId ?? undefined,
              externalTurnId: "managed-cloud-tool-turn",
              sourceRecordType: "event_msg",
              sourceEventType: "function_call_output",
              sourceSequence: 2,
              eventTime: "2026-04-01T12:00:01.000Z",
              rawJson: {
                type: "event_msg",
                payload: {
                  type: "function_call_output",
                  output: outputSentinel
                }
              },
              rawText: outputSentinel,
              sourceHash: `managed-cloud-tool-output-${randomUUID()}`,
              idempotencyKey: `managed-cloud-tool-output-${randomUUID()}`,
              projectionStatus: "pending",
              metadata: {
                transcriptType: "function_call_output",
                toolName: "exec_command",
                toolEventKind: "function_call_output",
                toolCall: {
                  kind: "output",
                  id: callId,
                  name: "exec_command",
                  output: outputSentinel
                }
              }
            },
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-hook-v1",
              sourceTransport: "hook",
              externalSessionId: session.externalSessionId ?? undefined,
              externalThreadId: session.externalSessionId ?? undefined,
              externalTurnId: "managed-cloud-tool-turn",
              sourceRecordType: "hook_payload",
              sourceEventType: "Stop",
              sourceSequence: 3,
              eventTime: "2026-04-01T12:00:02.000Z",
              rawJson: { hook_event_name: "Stop" },
              sourceHash: `managed-cloud-tool-stop-${randomUUID()}`,
              idempotencyKey: `managed-cloud-tool-stop-${randomUUID()}`,
              metadata: {}
            }
          ]
        }
      );

      const projection = await encryptedRepo.projectPendingConversationItems(
        { userId: owner.id },
        { limit: 10 }
      );
      expect(projection.toolEventsCreated).toBe(1);
      const storedToolEvents = await pool.query<{
        id: string;
        tool_input_text: string | null;
        tool_response_text: string | null;
      }>(
        `
          select id, tool_input::text as tool_input_text, tool_response::text as tool_response_text
          from tool_events
          where session_id = $1
        `,
        [session.id]
      );
      expect(storedToolEvents.rows).toHaveLength(1);
      expect(JSON.stringify(storedToolEvents.rows)).not.toContain(
        inputSentinel
      );
      expect(JSON.stringify(storedToolEvents.rows)).not.toContain(
        outputSentinel
      );
      const encryptedFields = await pool.query<{ source_column: string }>(
        `
          select source_column
          from encrypted_field_payloads
          where owner_user_id = $1
            and source_table = 'tool_events'
            and source_id = $2
            and invalidated_at is null
          order by source_column asc
        `,
        [owner.id, storedToolEvents.rows[0]!.id]
      );
      expect(encryptedFields.rows.map((row) => row.source_column)).toEqual([
        "tool_input",
        "tool_response"
      ]);

      const graphEvents = await encryptedRepo.listLcmGraphEvents(
        { userId: owner.id },
        { includeContent: true, limit: 10 }
      );
      const toolEvent = graphEvents.find(
        (event) => event.metadata.sourceTable === "tool_events"
      );
      expect(toolEvent?.content).toContain(inputSentinel);
      expect(toolEvent?.content).toContain(outputSentinel);
      expect(JSON.stringify(toolEvent?.metadata)).toContain(inputSentinel);
      expect(JSON.stringify(toolEvent?.metadata)).toContain(outputSentinel);
    });
  });

  it("seals paid managed-cloud agent turns from Stop source event type without plaintext raw_json", async () => {
    await withPaidManagedCloudProfile(async () => {
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 16).toString("base64")
      );
      const encryptedRepo = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const owner = await encryptedRepo.createUser({
        email: `managed-cloud-stop-seal-${randomUUID()}@example.com`
      });
      const session = await encryptedRepo.createCapturedSession(
        { userId: owner.id },
        {
          externalSessionId: `managed-cloud-stop-seal-${randomUUID()}`,
          sourceRuntime: "codex",
          captureMethod: "hook"
        }
      );
      const sentinel =
        "Paid managed cloud Stop-sealed agent turn sentinel 0180ba.";
      await encryptedRepo.createConversationItems(
        { userId: owner.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "hook",
              externalSessionId: session.externalSessionId ?? undefined,
              externalThreadId: session.externalSessionId ?? undefined,
              externalTurnId: "managed-cloud-stop-turn",
              sourceRecordType: "event_msg",
              sourceEventType: "agent_message",
              sourceSequence: 1,
              eventTime: "2026-04-01T12:00:00.000Z",
              rawJson: {
                type: "event_msg",
                payload: { type: "agent_message", message: sentinel }
              },
              rawText: sentinel,
              sourceHash: `managed-cloud-stop-agent-${randomUUID()}`,
              idempotencyKey: `managed-cloud-stop-agent-${randomUUID()}`,
              metadata: { transcriptType: "agent_message" }
            },
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-hook-v1",
              sourceTransport: "hook",
              externalSessionId: session.externalSessionId ?? undefined,
              externalThreadId: session.externalSessionId ?? undefined,
              externalTurnId: "managed-cloud-stop-turn",
              sourceRecordType: "hook_payload",
              sourceEventType: "Stop",
              sourceSequence: 2,
              eventTime: "2026-04-01T12:00:01.000Z",
              rawJson: {
                hook_event_name: "Stop",
                turn_id: "managed-cloud-stop-turn"
              },
              sourceHash: `managed-cloud-stop-hook-${randomUUID()}`,
              idempotencyKey: `managed-cloud-stop-hook-${randomUUID()}`,
              metadata: {}
            }
          ]
        }
      );
      const stored = await pool.query<{ raw_json_text: string }>(
        `
          select string_agg(raw_json::text, ' ') as raw_json_text
          from conversation_items
          where session_id = $1
        `,
        [session.id]
      );
      expect(stored.rows[0]?.raw_json_text).not.toContain("hook_event_name");
      expect(stored.rows[0]?.raw_json_text).not.toContain(sentinel);

      const projection = await encryptedRepo.projectPendingConversationItems(
        { userId: owner.id },
        { limit: 10 }
      );
      expect(projection).toMatchObject({
        rawItemsWaitingForAgentSeal: 0,
        memoryEventsCreated: 1
      });
      const graphEvents = await encryptedRepo.listLcmGraphEvents(
        { userId: owner.id },
        { includeContent: true, limit: 10 }
      );
      expect(graphEvents.map((event) => event.content)).toContain(sentinel);
    });
  });

  it("reconstructs paid managed-cloud encrypted transport chunk conversation items for Projection", async () => {
    await withPaidManagedCloudProfile(async () => {
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 17).toString("base64")
      );
      const encryptedRepo = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const owner = await encryptedRepo.createUser({
        email: `managed-cloud-chunk-project-${randomUUID()}@example.com`
      });
      const session = await encryptedRepo.createCapturedSession(
        { userId: owner.id },
        {
          externalSessionId: `managed-cloud-chunk-project-${randomUUID()}`,
          sourceRuntime: "codex",
          captureMethod: "hook"
        }
      );
      const sentinel =
        "Paid managed cloud encrypted transport chunk sentinel 111d29.";
      const envelope = JSON.stringify({
        rawJson: {
          type: "event_msg",
          payload: { type: "user_message", role: "user", content: sentinel }
        },
        rawText: sentinel
      });
      const logicalSourceId = `managed-cloud-chunk-${randomUUID()}`;
      const sourceItemHash = `managed-cloud-chunk-source-${randomUUID()}`;
      const transportChunkGroupId = rawConversationTransportChunkGroupId({
        sourceKind: "codex",
        sourceAdapterVersion: "codex-transcript-v1",
        sourceTransport: "hook",
        logicalSourceId,
        sourceItemHash,
        transportChunkCount: 2,
        transportChunkEncoding: "conversation-item-json-v1"
      });
      const firstHalf = envelope.slice(0, Math.ceil(envelope.length / 2));
      const secondHalf = envelope.slice(Math.ceil(envelope.length / 2));
      await encryptedRepo.createConversationItems(
        { userId: owner.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "hook",
              externalSessionId: session.externalSessionId ?? undefined,
              externalThreadId: session.externalSessionId ?? undefined,
              externalTurnId: "managed-cloud-chunk-turn",
              sourceRecordType: "event_msg",
              sourceEventType: "user_message",
              sourceSequence: 1,
              eventTime: "2026-04-01T12:00:00.000Z",
              rawJson: {
                transportChunk: true,
                transportChunkGroupId,
                sourceItemHash,
                chunkIndex: 0,
                chunkCount: 2
              },
              logicalSourceId,
              transportChunkIndex: 0,
              transportChunkCount: 2,
              transportChunkText: firstHalf,
              transportChunkEncoding: "conversation-item-json-v1",
              sourceHash: `managed-cloud-chunk-0-${randomUUID()}`,
              idempotencyKey: `managed-cloud-chunk-0-${randomUUID()}`,
              metadata: { transcriptType: "user_message" }
            },
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "hook",
              externalSessionId: session.externalSessionId ?? undefined,
              externalThreadId: session.externalSessionId ?? undefined,
              externalTurnId: "managed-cloud-chunk-turn",
              sourceRecordType: "event_msg",
              sourceEventType: "user_message",
              sourceSequence: 2,
              eventTime: "2026-04-01T12:00:00.001Z",
              rawJson: {
                transportChunk: true,
                transportChunkGroupId,
                sourceItemHash,
                chunkIndex: 1,
                chunkCount: 2
              },
              logicalSourceId,
              transportChunkIndex: 1,
              transportChunkCount: 2,
              transportChunkText: secondHalf,
              transportChunkEncoding: "conversation-item-json-v1",
              sourceHash: `managed-cloud-chunk-1-${randomUUID()}`,
              idempotencyKey: `managed-cloud-chunk-1-${randomUUID()}`,
              metadata: { transcriptType: "user_message" }
            }
          ]
        }
      );
      const stored = await pool.query<{ chunk_text: string }>(
        `
          select string_agg(transport_chunk_text, '') as chunk_text
          from conversation_items
          where logical_source_id = $1
        `,
        [logicalSourceId]
      );
      expect(stored.rows[0]?.chunk_text).not.toContain(sentinel);

      const projection = await encryptedRepo.projectPendingConversationItems(
        { userId: owner.id },
        { limit: 10 }
      );
      const projectionErrors = await pool.query<{
        projection_status: string;
        projection_error: string | null;
      }>(
        `
          select projection_status, projection_error
          from conversation_items
          where logical_source_id = $1
          order by transport_chunk_index
        `,
        [logicalSourceId]
      );
      expect(projectionErrors.rows).toEqual([
        { projection_status: "projected", projection_error: null },
        { projection_status: "projected", projection_error: null }
      ]);
      expect(projection).toMatchObject({
        rawItemsProjected: 2,
        messagesCreated: 1,
        memoryEventsCreated: 1
      });
      const messages = await pool.query<{ content: string }>(
        "select content from messages where session_id = $1",
        [session.id]
      );
      expect(messages.rows.map((row) => row.content)).toEqual([
        "[koed encrypted message]"
      ]);
      expect(JSON.stringify(messages.rows)).not.toContain(sentinel);
      const graphEvents = await encryptedRepo.listLcmGraphEvents(
        { userId: owner.id },
        { includeContent: true, limit: 10 }
      );
      expect(graphEvents.map((event) => event.content)).toContain(sentinel);
    });
  });

  it("rejects tombstoned users from account and API token authentication", async () => {
    const email = `deleted-api-token-${randomUUID()}@example.com`;
    const user = await repo.createUser({
      email,
      displayName: "Deleted API Token User"
    });
    const tokenHash = `hash-${randomUUID()}-${randomUUID()}`;
    await repo.createApiToken({
      ownerUserId: user.id,
      name: "Deleted User Token",
      tokenHash,
      tokenPrefix: "cmt_deleted"
    });

    await pool.query("update users set deleted_at = now() where id = $1", [
      user.id
    ]);

    await expect(repo.getUser(user.id)).resolves.toBeNull();
    await expect(repo.findUserByEmail(email)).resolves.toBeNull();
    await expect(repo.getApiTokenUser(tokenHash)).resolves.toBeNull();
  });

  it("manages browser-mediated device credentials without storing reusable secrets in audit metadata", async () => {
    const user = await repo.createUser({
      email: `device-credential-${randomUUID()}@example.com`,
      displayName: "Device Credential User"
    });
    const challengeHash = `challenge-${randomUUID()}-${randomUUID()}`;
    const verifierHash = `verifier-${randomUUID()}-${randomUUID()}`;

    const challenge = await repo.createDeviceEnrollmentChallenge({
      challengeHash,
      upstreamBackendId: "team-vps",
      deviceInstanceId: "desktop-1",
      deviceLabel: "Desktop",
      requestedOperationFamilies: ["team.recall", "sync.outbox"],
      metadata: { platform: "linux" },
      expiresAt: new Date(Date.now() + 60_000)
    });
    const overScopedChallengeHash = `challenge-${randomUUID()}-${randomUUID()}`;
    await repo.createDeviceEnrollmentChallenge({
      challengeHash: overScopedChallengeHash,
      upstreamBackendId: "team-vps",
      deviceInstanceId: "desktop-over-scoped",
      requestedOperationFamilies: ["team.recall"],
      expiresAt: new Date(Date.now() + 60_000)
    });
    await expect(
      repo.redeemDeviceEnrollmentChallenge(
        { userId: user.id },
        {
          challengeHash: overScopedChallengeHash,
          credentialKeyId: `device-key-${randomUUID()}`,
          verifierKind: "secret_hash",
          verifierHash,
          operationFamilies: ["team.recall", "admin"]
        }
      )
    ).rejects.toThrow(
      "Device credential operation families exceed enrollment challenge"
    );
    const boundedCredential = await repo.redeemDeviceEnrollmentChallenge(
      { userId: user.id },
      {
        challengeHash: overScopedChallengeHash,
        credentialKeyId: `device-key-${randomUUID()}`,
        verifierKind: "secret_hash",
        verifierHash,
        operationFamilies: ["team.recall"]
      }
    );
    expect(boundedCredential?.operationFamilies).toEqual(["team.recall"]);

    const credential = await repo.redeemDeviceEnrollmentChallenge(
      { userId: user.id },
      {
        challengeHash,
        credentialKeyId: `device-key-${randomUUID()}`,
        verifierKind: "secret_hash",
        verifierHash
      }
    );

    expect(credential).toMatchObject({
      ownerUserId: user.id,
      enrollmentChallengeId: challenge.id,
      upstreamBackendId: "team-vps",
      deviceInstanceId: "desktop-1",
      deviceLabel: "Desktop",
      operationFamilies: ["team.recall", "sync.outbox"],
      lastUsedAt: null,
      revokedAt: null
    });
    const replacementChallengeHash = `challenge-${randomUUID()}-${randomUUID()}`;
    await repo.createDeviceEnrollmentChallenge({
      challengeHash: replacementChallengeHash,
      upstreamBackendId: "team-vps",
      deviceInstanceId: "desktop-1",
      deviceLabel: "Desktop",
      requestedOperationFamilies: ["team.recall"],
      expiresAt: new Date(Date.now() + 60_000)
    });
    const replacementVerifierHash = `verifier-${randomUUID()}-${randomUUID()}`;
    const replacementCredential = await repo.redeemDeviceEnrollmentChallenge(
      { userId: user.id },
      {
        challengeHash: replacementChallengeHash,
        credentialKeyId: `device-key-${randomUUID()}`,
        verifierKind: "secret_hash",
        verifierHash: replacementVerifierHash
      }
    );
    expect(replacementCredential).toMatchObject({
      ownerUserId: user.id,
      upstreamBackendId: "team-vps",
      deviceInstanceId: "desktop-1",
      operationFamilies: ["team.recall"],
      revokedAt: null
    });
    expect(
      await repo.getDeviceCredentialUser({
        credentialKeyId: credential!.credentialKeyId,
        verifierHash
      })
    ).toBeNull();
    expect(
      await repo.redeemDeviceEnrollmentChallenge(
        { userId: user.id },
        {
          challengeHash,
          credentialKeyId: `device-key-${randomUUID()}`,
          verifierKind: "secret_hash",
          verifierHash
        }
      )
    ).toBeNull();

    const listed = await repo.listDeviceCredentials(
      { userId: user.id },
      { upstreamBackendId: "team-vps" }
    );
    expect(listed.map((item) => item.id).sort()).toEqual(
      [boundedCredential!.id, replacementCredential!.id].sort()
    );

    const authenticated = await repo.getDeviceCredentialUser({
      credentialKeyId: replacementCredential!.credentialKeyId,
      verifierHash: replacementVerifierHash
    });
    expect(authenticated?.user).toMatchObject({ id: user.id });
    expect(authenticated?.credential.lastUsedAt).not.toBeNull();
    expect(authenticated?.credential.lastValidatedAt).not.toBeNull();

    expect(
      await repo.revokeDeviceCredential(
        { userId: user.id },
        replacementCredential!.id,
        "rotated"
      )
    ).toBe(true);
    expect(
      await repo.revokeDeviceCredential(
        { userId: user.id },
        replacementCredential!.id,
        "rotated"
      )
    ).toBe(false);
    expect(
      await repo.getDeviceCredentialUser({
        credentialKeyId: replacementCredential!.credentialKeyId,
        verifierHash: replacementVerifierHash
      })
    ).toBeNull();

    const audit = await repo.listAuditEvents(
      { userId: user.id },
      { action: "device_credential.created", limit: 10 }
    );
    const auditJson = JSON.stringify(audit);
    expect(auditJson).toContain("team-vps");
    expect(auditJson).not.toContain(verifierHash);
    expect(auditJson).not.toContain(challengeHash);
  });

  it("serializes concurrent device credential replacement for one device", async () => {
    const user = await repo.createUser({
      email: `concurrent-device-${randomUUID()}@example.com`,
      displayName: "Concurrent Device User"
    });
    const deviceInstanceId = `desktop-${randomUUID()}`;
    const challenges = await Promise.all(
      [0, 1].map((index) =>
        repo.createDeviceEnrollmentChallenge({
          challengeHash: `challenge-${index}-${randomUUID()}-${randomUUID()}`,
          upstreamBackendId: "team-vps",
          deviceInstanceId,
          requestedOperationFamilies: ["team_workspace_read"],
          expiresAt: new Date(Date.now() + 60_000)
        })
      )
    );

    const credentials = await Promise.all(
      challenges.map((challenge, index) =>
        repo.approveDeviceEnrollmentChallenge(
          { userId: user.id },
          challenge.id,
          {
            credentialKeyId: `concurrent-device-key-${index}-${randomUUID()}`,
            verifierKind: "secret_hash",
            verifierHash: `concurrent-verifier-${index}-${randomUUID()}`
          }
        )
      )
    );

    expect(credentials.every(Boolean)).toBe(true);
    const active = await repo.listDeviceCredentials(
      { userId: user.id },
      { upstreamBackendId: "team-vps" }
    );
    expect(active).toHaveLength(1);
    const counts = await pool.query<{ active: string; total: string }>(
      `select
         count(*) filter (where revoked_at is null)::text as active,
         count(*)::text as total
       from device_credentials
       where owner_user_id = $1
         and upstream_backend_id = 'team-vps'
         and device_instance_id = $2`,
      [user.id, deviceInstanceId]
    );
    expect(counts.rows[0]).toEqual({ active: "1", total: "2" });
  });

  it("rejects ambiguous device credential key ids", async () => {
    const user = await repo.createUser({
      email: `invalid-device-key-${randomUUID()}@example.com`
    });
    const challengeHash = `challenge-${randomUUID()}-${randomUUID()}`;
    await repo.createDeviceEnrollmentChallenge({
      challengeHash,
      upstreamBackendId: "team-vps",
      requestedOperationFamilies: ["team_workspace_read"],
      expiresAt: new Date(Date.now() + 60_000)
    });

    await expect(
      repo.redeemDeviceEnrollmentChallenge(
        { userId: user.id },
        {
          challengeHash,
          credentialKeyId: "invalid:key:id:1234",
          verifierKind: "secret_hash",
          verifierHash: `verifier-${randomUUID()}-${randomUUID()}`
        }
      )
    ).rejects.toThrow("Device credential key id is invalid");
  });

  it("enforces Team roles and Workspace access at request time", async () => {
    const owner = await repo.createUser({
      email: `team-owner-${randomUUID()}@example.com`,
      displayName: "Team Owner"
    });
    const admin = await repo.createUser({
      email: `team-admin-${randomUUID()}@example.com`,
      displayName: "Team Admin"
    });
    const member = await repo.createUser({
      email: `team-member-${randomUUID()}@example.com`,
      displayName: "Team Member"
    });
    const outsider = await repo.createUser({
      email: `team-outsider-${randomUUID()}@example.com`,
      displayName: "Team Outsider"
    });

    const team = await repo.createTeam(
      { userId: owner.id },
      { name: "Launch Team" }
    );
    const ownerMembership = await repo.getTeamMembership(
      { userId: owner.id },
      team.id
    );
    expect(ownerMembership).toMatchObject({
      teamId: team.id,
      userId: owner.id,
      role: "owner",
      status: "enabled"
    });

    await expect(
      repo.upsertTeamMember(
        { userId: outsider.id },
        { teamId: team.id, userId: member.id, role: "member" }
      )
    ).resolves.toBeNull();

    const adminMembership = await repo.upsertTeamMember(
      { userId: owner.id },
      { teamId: team.id, userId: admin.id, role: "admin" }
    );
    const memberMembership = await repo.upsertTeamMember(
      { userId: admin.id },
      { teamId: team.id, userId: member.id, role: "member" }
    );
    expect(adminMembership).toMatchObject({ role: "admin", status: "enabled" });
    expect(memberMembership).toMatchObject({
      role: "member",
      status: "enabled"
    });
    expect(memberMembership?.acceptedAt).toEqual(expect.any(String));
    const memberAcceptedAt = memberMembership!.acceptedAt;

    await expect(
      repo.upsertTeamMember(
        { userId: admin.id },
        { teamId: team.id, userId: member.id, role: "owner" }
      )
    ).resolves.toBeNull();
    await expect(
      repo.upsertTeamMember(
        { userId: admin.id },
        {
          teamId: team.id,
          userId: owner.id,
          role: "member",
          status: "disabled"
        }
      )
    ).resolves.toBeNull();
    await expect(
      repo.getTeamMembership({ userId: owner.id }, team.id)
    ).resolves.toMatchObject({
      role: "owner",
      status: "enabled"
    });
    await expect(
      repo.upsertTeamMember(
        { userId: owner.id },
        {
          teamId: team.id,
          userId: owner.id,
          role: "member",
          status: "disabled"
        }
      )
    ).resolves.toBeNull();
    await expect(
      repo.getTeamMembership({ userId: owner.id }, team.id)
    ).resolves.toMatchObject({
      role: "owner",
      status: "enabled"
    });

    const workspace = await repo.createTeamWorkspace(
      { userId: owner.id },
      { teamId: team.id, name: "Memory OS" }
    );
    expect(workspace).toMatchObject({ teamId: team.id, name: "Memory OS" });
    await expect(
      repo.getTeamWorkspaceAccess({ userId: owner.id }, workspace!.id)
    ).resolves.toMatchObject({
      access: "write",
      canRecall: true,
      canCreateShare: true,
      canManageWorkspace: true
    });

    const otherTeam = await repo.createTeam(
      { userId: owner.id },
      { name: "Other Team" }
    );
    await expect(
      pool.query(
        `
          insert into team_workspace_access_grants (
            team_workspace_id,
            team_id,
            user_id,
            access,
            granted_by_user_id
          )
          values ($1, $2, $3, 'read', $4)
        `,
        [workspace!.id, team.id, outsider.id, owner.id]
      )
    ).rejects.toThrow();
    await expect(
      pool.query(
        `
          insert into team_workspace_access_grants (
            team_workspace_id,
            team_id,
            user_id,
            access,
            granted_by_user_id
          )
          values ($1, $2, $3, 'read', $4)
        `,
        [workspace!.id, otherTeam.id, owner.id, owner.id]
      )
    ).rejects.toThrow();

    await expect(
      repo.createTeamWorkspace(
        { userId: member.id },
        { teamId: team.id, name: "Member-created Workspace" }
      )
    ).resolves.toBeNull();

    const readAccess = await repo.setTeamWorkspaceAccess(
      { userId: owner.id },
      {
        teamWorkspaceId: workspace!.id,
        userId: member.id,
        access: "read"
      }
    );
    expect(readAccess).toMatchObject({
      access: "read",
      teamEntitlementStatus: "active",
      teamEntitlementAllowsAccess: true,
      canRecall: true,
      canCreateShare: false,
      canManageWorkspace: false
    });
    await expect(
      repo.getTeamEntitlementGate({ userId: owner.id }, team.id)
    ).resolves.toMatchObject({
      teamId: team.id,
      status: "active",
      allowsTeamAccess: true,
      deniedOperationFamilies: []
    });
    const graceGate = await repo.setTeamEntitlementState(
      { userId: owner.id },
      { teamId: team.id, status: "grace", reason: "payment_retry" }
    );
    expect(graceGate).toMatchObject({
      status: "grace",
      allowsTeamAccess: true,
      reason: "payment_retry"
    });
    await expect(
      repo.getTeamWorkspaceAccess({ userId: member.id }, workspace!.id)
    ).resolves.toMatchObject({
      teamEntitlementStatus: "grace",
      teamEntitlementAllowsAccess: true,
      access: "read",
      canRecall: true
    });
    const suspendedGate = await repo.setTeamEntitlementState(
      { userId: owner.id },
      { teamId: team.id, status: "suspended", reason: "billing_suspended" }
    );
    expect(suspendedGate).not.toBeNull();
    expect(suspendedGate).toMatchObject({
      status: "suspended",
      allowsTeamAccess: false
    });
    expect(suspendedGate!.deniedOperationFamilies).toEqual(
      expect.arrayContaining([
        "ingestion",
        "recall",
        "share",
        "sync",
        "team_admin"
      ])
    );
    await expect(
      repo.getTeamWorkspaceAccess({ userId: member.id }, workspace!.id)
    ).resolves.toMatchObject({
      teamEntitlementStatus: "suspended",
      teamEntitlementAllowsAccess: false,
      access: "disabled",
      canRecall: false,
      canCreateShare: false
    });
    await expect(
      repo.createTeamWorkspace(
        { userId: owner.id },
        { teamId: team.id, name: "Blocked Workspace" }
      )
    ).resolves.toBeNull();
    const revokedGate = await repo.setTeamEntitlementState(
      { userId: owner.id },
      { teamId: team.id, status: "revoked", reason: "license_revoked" }
    );
    expect(revokedGate).toMatchObject({
      status: "revoked",
      allowsTeamAccess: false
    });
    await expect(
      repo.createTeamInvite(
        { userId: owner.id },
        {
          teamId: team.id,
          email: `revoked-invite-${randomUUID()}@example.com`,
          role: "member",
          tokenHash: `token-${randomUUID()}`,
          expiresAt: new Date(Date.now() + 60_000)
        }
      )
    ).resolves.toBeNull();
    await repo.setTeamEntitlementState(
      { userId: owner.id },
      { teamId: team.id, status: "active", reason: "billing_restored" }
    );
    await pool.query(
      `
        update team_workspace_access_grants
        set disabled_at = now(), disabled_reason = 'billing_suspended'
        where team_workspace_id = $1 and user_id = $2
      `,
      [workspace!.id, member.id]
    );
    await expect(
      repo.getTeamWorkspaceAccess({ userId: member.id }, workspace!.id)
    ).resolves.toMatchObject({
      access: "disabled",
      canRecall: false,
      canCreateShare: false,
      canManageWorkspace: false
    });
    await pool.query(
      `
        update team_workspace_access_grants
        set disabled_at = null, disabled_reason = null
        where team_workspace_id = $1 and user_id = $2
      `,
      [workspace!.id, member.id]
    );

    await expect(
      repo.setTeamWorkspaceAccess(
        { userId: admin.id },
        {
          teamWorkspaceId: workspace!.id,
          userId: outsider.id,
          access: "read"
        }
      )
    ).resolves.toBeNull();

    const disabledAdminAccess = await repo.setTeamWorkspaceAccess(
      { userId: owner.id },
      {
        teamWorkspaceId: workspace!.id,
        userId: admin.id,
        access: "disabled"
      }
    );
    expect(disabledAdminAccess).toMatchObject({
      access: "disabled",
      canRecall: false,
      canCreateShare: false,
      canManageWorkspace: false
    });
    await expect(
      repo.setTeamWorkspaceAccess(
        { userId: admin.id },
        {
          teamWorkspaceId: workspace!.id,
          userId: outsider.id,
          access: "read"
        }
      )
    ).resolves.toBeNull();

    const writeAccess = await repo.setTeamWorkspaceAccess(
      { userId: owner.id },
      {
        teamWorkspaceId: workspace!.id,
        userId: admin.id,
        access: "write"
      }
    );
    expect(writeAccess).toMatchObject({
      access: "write",
      canRecall: true,
      canCreateShare: true,
      canManageWorkspace: true
    });

    const memberWriteAccess = await repo.setTeamWorkspaceAccess(
      { userId: admin.id },
      {
        teamWorkspaceId: workspace!.id,
        userId: member.id,
        access: "write"
      }
    );
    expect(memberWriteAccess).toMatchObject({
      access: "write",
      canRecall: true,
      canCreateShare: true,
      canManageWorkspace: false
    });

    await pool.query(
      "update team_workspaces set archived_at = now() where id = $1",
      [workspace!.id]
    );
    await expect(
      repo.getTeamWorkspaceAccess({ userId: owner.id }, workspace!.id)
    ).resolves.toMatchObject({
      access: "disabled",
      canManageTeam: false,
      canManageWorkspace: false,
      canRecall: false,
      canCreateShare: false
    });
    await pool.query(
      "update team_workspaces set archived_at = null where id = $1",
      [workspace!.id]
    );
    await pool.query("update teams set archived_at = now() where id = $1", [
      team.id
    ]);
    await expect(
      repo.getTeamWorkspaceAccess({ userId: owner.id }, workspace!.id)
    ).resolves.toMatchObject({
      access: "disabled",
      canManageTeam: false,
      canManageWorkspace: false,
      canRecall: false,
      canCreateShare: false
    });
    await expect(
      repo.setTeamWorkspaceAccess(
        { userId: owner.id },
        {
          teamWorkspaceId: workspace!.id,
          userId: member.id,
          access: "read"
        }
      )
    ).resolves.toBeNull();
    await pool.query("update teams set archived_at = null where id = $1", [
      team.id
    ]);

    await expect(
      repo.setTeamWorkspaceAccess(
        { userId: member.id },
        {
          teamWorkspaceId: workspace!.id,
          userId: outsider.id,
          access: "read"
        }
      )
    ).resolves.toBeNull();
    await expect(
      repo.getTeamWorkspaceAccess({ userId: outsider.id }, workspace!.id)
    ).resolves.toBeNull();

    const disabledMember = await repo.upsertTeamMember(
      { userId: owner.id },
      {
        teamId: team.id,
        userId: member.id,
        role: "member",
        status: "disabled"
      }
    );
    expect(disabledMember).toMatchObject({
      status: "disabled",
      acceptedAt: memberAcceptedAt
    });
    await expect(
      repo.getTeamWorkspaceAccess({ userId: member.id }, workspace!.id)
    ).resolves.toMatchObject({
      membershipStatus: "disabled",
      access: "disabled",
      canRecall: false,
      canCreateShare: false
    });
    const reenabledMember = await repo.upsertTeamMember(
      { userId: owner.id },
      {
        teamId: team.id,
        userId: member.id,
        role: "member",
        status: "enabled"
      }
    );
    expect(reenabledMember).toMatchObject({
      status: "enabled",
      acceptedAt: memberAcceptedAt,
      disabledAt: null
    });
    await expect(
      repo.listTeamAuditEvents(
        { userId: owner.id },
        { teamId: team.id, action: "team.entitlement.changed", limit: 10 }
      )
    ).resolves.toHaveLength(4);
  });

  it("tracks Team billing seats through member lifecycle and over-limit recovery", async () => {
    const owner = await repo.createUser({
      email: `seat-owner-${randomUUID()}@example.com`,
      displayName: "Seat Owner"
    });
    const admin = await repo.createUser({
      email: `seat-admin-${randomUUID()}@example.com`,
      displayName: "Seat Admin"
    });
    const invitedEmail = `seat-invitee-${randomUUID()}@example.com`;
    const team = await repo.createTeam(
      { userId: owner.id },
      { name: "Seat Team" }
    );

    await expect(
      repo.getTeamBillingSeatState({ userId: owner.id }, team.id)
    ).resolves.toMatchObject({
      teamId: team.id,
      seatLimit: null,
      billableSeatCount: 1,
      pendingBillingSeatCount: 1,
      syncStatus: "synced"
    });

    const adminMembership = await repo.upsertTeamMember(
      { userId: owner.id },
      { teamId: team.id, userId: admin.id, role: "admin" }
    );
    expect(adminMembership).toMatchObject({ status: "enabled" });

    await expect(
      repo.setTeamBillingSeatPolicy(
        { userId: admin.id },
        { teamId: team.id, seatLimit: 1 }
      )
    ).resolves.toBeNull();

    const overLimit = await repo.setTeamBillingSeatPolicy(
      { userId: owner.id },
      { teamId: team.id, seatLimit: 1 }
    );
    expect(overLimit).toMatchObject({
      seatLimit: 1,
      billableSeatCount: 2,
      pendingBillingSeatCount: 2,
      syncStatus: "over_limit"
    });
    expect(typeof overLimit?.overLimitAt).toBe("string");
    await expect(
      repo.getTeamEntitlementGate({ userId: owner.id }, team.id)
    ).resolves.toMatchObject({
      status: "grace",
      allowsTeamAccess: true,
      reason: "seat_limit_exceeded"
    });

    const inviteTokenHash = `seat-token-${randomUUID()}`;
    const invite = await repo.createTeamInvite(
      { userId: owner.id },
      {
        teamId: team.id,
        email: invitedEmail,
        role: "member",
        tokenHash: inviteTokenHash,
        expiresAt: new Date(Date.now() + 60_000)
      }
    );
    expect(invite).not.toBeNull();
    const accepted = await repo.acceptTeamInvite({
      tokenHash: `missing-${randomUUID()}`
    });
    expect(accepted).toBeNull();
    const acceptedInvite = await repo.acceptTeamInvite({
      tokenHash: inviteTokenHash,
      email: invitedEmail,
      displayName: "Seat Invitee"
    });
    expect(acceptedInvite).toMatchObject({
      createdUser: true,
      membership: { status: "enabled", role: "member" }
    });
    await expect(
      repo.getTeamBillingSeatState({ userId: owner.id }, team.id)
    ).resolves.toMatchObject({
      seatLimit: 1,
      billableSeatCount: 3,
      pendingBillingSeatCount: 3,
      syncStatus: "over_limit"
    });

    await expect(
      repo.disableTeamMember(
        { userId: owner.id },
        { teamId: team.id, userId: acceptedInvite!.user.id }
      )
    ).resolves.toMatchObject({ status: "disabled" });
    await expect(
      repo.disableTeamMember(
        { userId: owner.id },
        { teamId: team.id, userId: admin.id }
      )
    ).resolves.toMatchObject({ status: "disabled" });
    await expect(
      repo.getTeamBillingSeatState({ userId: owner.id }, team.id)
    ).resolves.toMatchObject({
      seatLimit: 1,
      billableSeatCount: 1,
      pendingBillingSeatCount: 1,
      syncStatus: "pending_provider_update",
      overLimitAt: null
    });
    await expect(
      repo.getTeamEntitlementGate({ userId: owner.id }, team.id)
    ).resolves.toMatchObject({
      status: "active",
      allowsTeamAccess: true,
      reason: "seat_limit_restored"
    });

    const auditEvents = await repo.listTeamAuditEvents(
      { userId: owner.id },
      { teamId: team.id, action: "team.billing_seats.changed", limit: 20 }
    );
    expect(auditEvents?.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(auditEvents?.map((event) => event.metadata))).toEqual(
      expect.stringContaining('"syncStatus":"over_limit"')
    );
  });

  it("returns a redacted Team support overview and audits the view", async () => {
    const owner = await repo.createUser({
      email: `support-owner-${randomUUID()}@example.com`,
      displayName: "Support Owner"
    });
    const member = await repo.createUser({
      email: `support-member-${randomUUID()}@example.com`,
      displayName: "Support Member"
    });
    const team = await repo.createTeam(
      { userId: owner.id },
      { name: "Support Team" }
    );
    await repo.upsertTeamMember(
      { userId: owner.id },
      { teamId: team.id, userId: member.id, role: "member" }
    );
    const workspace = await repo.createTeamWorkspace(
      { userId: owner.id },
      { teamId: team.id, name: "Support Workspace" }
    );
    await repo.setTeamWorkspaceAccess(
      { userId: owner.id },
      {
        teamWorkspaceId: workspace!.id,
        userId: member.id,
        access: "read"
      }
    );
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        workspaceId: "support-overview-project",
        externalSessionId: `support-overview-${randomUUID()}`,
        sourceRuntime: "codex",
        captureMethod: "hook"
      }
    );
    const grant = await repo.createTeamSessionShareGrant(
      { userId: owner.id },
      { teamWorkspaceId: workspace!.id, sessionId: session.id }
    );
    await repo.revokeTeamSessionShareGrant(
      { userId: owner.id },
      {
        teamWorkspaceId: workspace!.id,
        shareGrantId: grant!.id,
        reason: "support_overview_test"
      }
    );
    const challengeHash = `support-challenge-${randomUUID()}`;
    const verifierHash = `support-verifier-${randomUUID()}`;
    const credentialKeyId = `support-device-key-${randomUUID()}`;
    await repo.createDeviceEnrollmentChallenge({
      challengeHash,
      upstreamBackendId: "support-overview-vps",
      deviceInstanceId: "support-device-instance",
      deviceLabel: "Support overview desktop",
      requestedOperationFamilies: ["team.recall"],
      metadata: { secretMarker: "support-device-metadata-secret" },
      expiresAt: new Date(Date.now() + 60_000)
    });
    const credential = await repo.redeemDeviceEnrollmentChallenge(
      { userId: owner.id },
      {
        challengeHash,
        credentialKeyId,
        verifierKind: "secret_hash",
        verifierHash
      }
    );
    await repo.getDeviceCredentialUser({
      credentialKeyId,
      verifierHash
    });

    await expect(
      repo.getTeamSupportOverview({ userId: member.id }, team.id)
    ).resolves.toBeNull();

    const overview = await repo.getTeamSupportOverview(
      { userId: owner.id },
      team.id
    );
    expect(overview).toMatchObject({
      supportAccess: {
        policy: "team_manager_redacted",
        actorUserId: owner.id,
        actorRole: "owner",
        rawContentAccess: "not_permitted",
        breakGlassRequiredForRawContent: true
      },
      team: { id: team.id, name: "Support Team" },
      entitlement: { teamId: team.id, status: "active" },
      billingSeats: {
        teamId: team.id,
        billableSeatCount: 2,
        pendingBillingSeatCount: 2
      },
      diagnosticSurfaces: {
        auth: "browser_session",
        rawContentAccess: "not_permitted",
        operationsStatusPath: "/ops/status",
        capabilitiesPath: `/v1/capabilities/authenticated?teamId=${team.id}`,
        auditEventsPath: `/v1/teams/${team.id}/audit-events`,
        entitlementPath: `/v1/teams/${team.id}/entitlement`,
        billingSeatsPath: `/v1/teams/${team.id}/billing-seats`,
        supportOverviewPath: `/v1/teams/${team.id}/support/overview`
      },
      counts: {
        memberships: { enabled: 2, invited: 0, disabled: 0 },
        workspaces: { active: 1, archived: 0 },
        workspaceAccess: { read: 1, write: 1, disabled: 0 },
        invites: { pending: 0, accepted: 0, revoked: 0, expired: 0 },
        sessionShareGrants: {
          active: 0,
          revoked: 1,
          retainedAfterPersonalDeletion: 0
        },
        setupAndIntegrations: {
          externalAuthOrganizations: {
            linked: 0,
            disabled: 0,
            lastSeenAt: null
          },
          externalAuthIdentities: {
            linked: 0,
            disabled: 0,
            emailVerified: 0,
            lastSeenAt: null
          },
          deviceCredentials: {
            active: 1,
            revoked: 0,
            expired: 0
          }
        }
      }
    });
    expect(
      typeof overview?.counts.setupAndIntegrations.deviceCredentials
        .lastValidatedAt
    ).toBe("string");
    const overviewJson = JSON.stringify(overview);
    expect(overviewJson).not.toContain("support_overview_test");
    expect(overviewJson).not.toContain(session.id);
    expect(overviewJson).not.toContain(grant!.id);
    expect(overviewJson).not.toContain(credential!.credentialKeyId);
    expect(overviewJson).not.toContain(verifierHash);
    expect(overviewJson).not.toContain("Support overview desktop");
    expect(overviewJson).not.toContain("support-device-metadata-secret");

    const supportAuditEvents = await repo.listTeamAuditEvents(
      { userId: owner.id },
      { teamId: team.id, action: "team.support_overview.viewed", limit: 5 }
    );
    expect(supportAuditEvents).toEqual([
      expect.objectContaining({
        actorUserId: owner.id,
        targetTable: "teams",
        targetId: team.id,
        metadata: {
          teamId: team.id,
          policy: "team_manager_redacted",
          rawContentAccess: "not_permitted"
        }
      })
    ]);
  });

  it("creates, lists, and revokes Captured Session Share Grants through repository policy", async () => {
    const owner = await repo.createUser({
      email: `share-owner-${randomUUID()}@example.com`,
      displayName: "Share Owner"
    });
    const member = await repo.createUser({
      email: `share-member-${randomUUID()}@example.com`,
      displayName: "Share Member"
    });
    const outsider = await repo.createUser({
      email: `share-outsider-${randomUUID()}@example.com`,
      displayName: "Share Outsider"
    });
    const team = await repo.createTeam(
      { userId: owner.id },
      { name: "Share Team" }
    );
    await repo.upsertTeamMember(
      { userId: owner.id },
      { teamId: team.id, userId: member.id, role: "member" }
    );
    const workspace = await repo.createTeamWorkspace(
      { userId: owner.id },
      { teamId: team.id, name: "Share Workspace" }
    );
    await repo.setTeamWorkspaceAccess(
      { userId: owner.id },
      {
        teamWorkspaceId: workspace!.id,
        userId: member.id,
        access: "read"
      }
    );
    const ownerSession = await repo.createCapturedSession(
      { userId: owner.id },
      {
        workspaceId: "share-project",
        externalSessionId: `share-session-${randomUUID()}`,
        sourceRuntime: "codex",
        captureMethod: "hook"
      }
    );
    const memberSession = await repo.createCapturedSession(
      { userId: member.id },
      {
        workspaceId: "member-share-project",
        externalSessionId: `member-share-session-${randomUUID()}`,
        sourceRuntime: "codex",
        captureMethod: "hook"
      }
    );

    await expect(
      repo.createTeamSessionShareGrant(
        { userId: member.id },
        { teamWorkspaceId: workspace!.id, sessionId: memberSession.id }
      )
    ).resolves.toBeNull();
    await expect(
      repo.createTeamSessionShareGrant(
        { userId: owner.id },
        { teamWorkspaceId: workspace!.id, sessionId: memberSession.id }
      )
    ).resolves.toBeNull();
    await expect(
      repo.listTeamSessionShareGrants(
        { userId: outsider.id },
        { teamWorkspaceId: workspace!.id }
      )
    ).resolves.toBeNull();
    await repo.setTeamWorkspaceAccess(
      { userId: owner.id },
      {
        teamWorkspaceId: workspace!.id,
        userId: member.id,
        access: "write"
      }
    );
    const memberOwnedGrant = await repo.createTeamSessionShareGrant(
      { userId: member.id },
      { teamWorkspaceId: workspace!.id, sessionId: memberSession.id }
    );
    expect(memberOwnedGrant).toMatchObject({
      ownerUserId: member.id,
      sessionId: memberSession.id,
      revokedAt: null
    });
    await repo.setTeamWorkspaceAccess(
      { userId: owner.id },
      {
        teamWorkspaceId: workspace!.id,
        userId: member.id,
        access: "read"
      }
    );
    const revokedBySourceOwner = await repo.revokeTeamSessionShareGrant(
      { userId: member.id },
      {
        teamWorkspaceId: workspace!.id,
        shareGrantId: memberOwnedGrant!.id,
        reason: "source_owner_exit"
      }
    );
    expect(revokedBySourceOwner).toMatchObject({
      id: memberOwnedGrant!.id,
      revokedByUserId: member.id,
      revocationReason: "source_owner_exit"
    });

    const created = await repo.createTeamSessionShareGrant(
      { userId: owner.id },
      { teamWorkspaceId: workspace!.id, sessionId: ownerSession.id }
    );
    expect(created).toMatchObject({
      ownerUserId: owner.id,
      sessionId: ownerSession.id,
      teamId: team.id,
      teamWorkspaceId: workspace!.id,
      grantedByUserId: owner.id,
      revokedAt: null,
      retentionReason: "active_team_share"
    });
    expect(typeof created?.retainedByTeamAt).toBe("string");

    const duplicate = await repo.createTeamSessionShareGrant(
      { userId: owner.id },
      { teamWorkspaceId: workspace!.id, sessionId: ownerSession.id }
    );
    expect(duplicate?.id).toBe(created?.id);

    await expect(
      repo.listTeamSessionShareGrants(
        { userId: member.id },
        { teamWorkspaceId: workspace!.id }
      )
    ).resolves.toEqual([expect.objectContaining({ id: created!.id })]);

    await expect(
      repo.revokeTeamSessionShareGrant(
        { userId: member.id },
        {
          teamWorkspaceId: workspace!.id,
          shareGrantId: created!.id,
          reason: "readers_cannot_revoke"
        }
      )
    ).resolves.toBeNull();

    const revoked = await repo.revokeTeamSessionShareGrant(
      { userId: owner.id },
      {
        teamWorkspaceId: workspace!.id,
        shareGrantId: created!.id,
        reason: "owner_revoked"
      }
    );
    expect(revoked).toMatchObject({
      id: created!.id,
      revokedByUserId: owner.id,
      revocationReason: "owner_revoked"
    });

    await expect(
      repo.listTeamSessionShareGrants(
        { userId: owner.id },
        { teamWorkspaceId: workspace!.id }
      )
    ).resolves.toEqual([]);
    const revokedGrants = await repo.listTeamSessionShareGrants(
      { userId: owner.id },
      { teamWorkspaceId: workspace!.id, includeRevoked: true }
    );
    expect(revokedGrants).toHaveLength(2);
    const ownerRevokedGrant = revokedGrants?.find(
      (grant) => grant.id === created!.id
    );
    expect(ownerRevokedGrant).toMatchObject({ id: created!.id });
    expect(typeof ownerRevokedGrant?.revokedAt).toBe("string");

    const auditEvents = await repo.listTeamAuditEvents(
      { userId: owner.id },
      { teamId: team.id, action: "team.session_share.created", limit: 10 }
    );
    expect(auditEvents).toHaveLength(2);
  });

  const createCrossIdentitySyncFixture = async (input?: {
    relationshipIdempotencyKey?: string;
  }) => {
    const owner = await repo.createUser({
      email: `sync-owner-${randomUUID()}@example.com`,
      displayName: "Sync Owner"
    });
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        workspaceId: "sync-project",
        externalSessionId: `sync-session-${randomUUID()}`,
        sourceRuntime: "codex",
        captureMethod: "hook"
      }
    );
    const localDeployment = await repo.upsertDeploymentIdentity(
      { userId: owner.id },
      {
        deploymentKey: "local-laptop",
        profile: "local_personal",
        displayName: "Local laptop"
      }
    );
    const hostedDeployment = await repo.upsertDeploymentIdentity(
      { userId: owner.id },
      {
        deploymentKey: "koed-cloud",
        profile: "koed_managed_cloud",
        displayName: "Koed Cloud"
      }
    );
    const logical = await repo.upsertCapturedSessionLogicalMemory(
      { userId: owner.id },
      {
        sessionId: session.id,
        deploymentIdentityId: localDeployment.id,
        externalReplicaId: `source-${session.id}`,
        metadata: { source: "fixture" },
        policyManifest: { sourceBoundary: "captured_session" }
      }
    );
    const sync = await repo.upsertCrossIdentitySyncRelationship(
      { userId: owner.id },
      {
        logicalMemoryId: logical!.logicalMemory.id,
        sourceReplicaId: logical!.sourceReplica.id,
        targetDeploymentIdentityId: hostedDeployment.id,
        idempotencyKey:
          input?.relationshipIdempotencyKey ?? `sync:${session.id}:cloud`,
        targetExternalReplicaId: `target-${session.id}`,
        syncMode: "live",
        policyManifest: {
          sourceBoundary: "captured_session",
          shareGrantRevocation: "separate"
        },
        consentManifest: { consentRecordId: `consent-${session.id}` }
      }
    );
    return {
      owner,
      session,
      localDeployment,
      hostedDeployment,
      logical: logical!,
      sync: sync!
    };
  };

  it("keeps Cross-Identity Sync logical memory and replicas idempotent", async () => {
    const fixture = await createCrossIdentitySyncFixture();
    const replayedLogical = await repo.upsertCapturedSessionLogicalMemory(
      { userId: fixture.owner.id },
      {
        sessionId: fixture.session.id,
        deploymentIdentityId: fixture.localDeployment.id,
        logicalKey: `captured-session:${fixture.session.id}`,
        metadata: { replayed: true }
      }
    );
    expect(replayedLogical?.logicalMemory.id).toBe(
      fixture.logical.logicalMemory.id
    );
    expect(replayedLogical?.sourceReplica.id).toBe(
      fixture.logical.sourceReplica.id
    );

    const replayedSync = await repo.upsertCrossIdentitySyncRelationship(
      { userId: fixture.owner.id },
      {
        logicalMemoryId: fixture.logical.logicalMemory.id,
        sourceReplicaId: fixture.logical.sourceReplica.id,
        targetDeploymentIdentityId: fixture.hostedDeployment.id,
        idempotencyKey: fixture.sync.relationship.idempotencyKey,
        policyManifest: { replayed: true }
      }
    );
    expect(replayedSync?.relationship.id).toBe(fixture.sync.relationship.id);
    expect(replayedSync?.targetReplica.id).toBe(fixture.sync.targetReplica.id);

    const counts = await pool.query<{
      logical_memories: string;
      replicas: string;
      relationships: string;
    }>(
      `
        select
          (select count(*) from logical_memories) as logical_memories,
          (select count(*) from memory_replicas) as replicas,
          (select count(*) from cross_identity_sync_relationships) as relationships
      `
    );
    expect(counts.rows[0]).toEqual({
      logical_memories: "1",
      replicas: "2",
      relationships: "1"
    });
  });

  it("scopes Cross-Identity Sync idempotency by source owner and rejects mismatched replay", async () => {
    const sharedIdempotencyKey = `sync:shared:${randomUUID()}`;
    const first = await createCrossIdentitySyncFixture({
      relationshipIdempotencyKey: sharedIdempotencyKey
    });
    const second = await createCrossIdentitySyncFixture({
      relationshipIdempotencyKey: sharedIdempotencyKey
    });

    const mismatch = await repo.upsertCrossIdentitySyncRelationship(
      { userId: first.owner.id },
      {
        logicalMemoryId: first.logical.logicalMemory.id,
        sourceReplicaId: first.logical.sourceReplica.id,
        targetDeploymentIdentityId: first.localDeployment.id,
        idempotencyKey: first.sync.relationship.idempotencyKey,
        syncMode: "live"
      }
    );
    expect(mismatch).toBeNull();

    expect(second.sync.relationship.idempotencyKey).toBe(sharedIdempotencyKey);
    expect(second.sync.relationship.sourceOwnerUserId).toBe(second.owner.id);

    const counts = await pool.query<{
      relationships: string;
    }>(
      `
        select count(*) as relationships
        from cross_identity_sync_relationships
        where idempotency_key = $1
      `,
      [sharedIdempotencyKey]
    );
    expect(counts.rows[0]).toEqual({ relationships: "2" });
  });

  it("stores resumable sync packages, chunks, and queue entries idempotently", async () => {
    const fixture = await createCrossIdentitySyncFixture();
    const packageProvider = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64")
    );
    const packageManifest = (
      await createEncryptedJsonPackage(packageProvider, {
        objectClass: "sync_package",
        payload: {
          logicalMemoryId: fixture.logical.logicalMemory.id,
          sourceSessionId: fixture.session.id,
          chunks: [{ index: 0, checksum: "sha256:first" }]
        },
        metadata: {
          chunkCount: 1
        }
      })
    ).manifest;
    const replayManifest = (
      await createEncryptedJsonPackage(packageProvider, {
        objectClass: "sync_package",
        payload: { ignored: true },
        metadata: {
          chunkCount: 1
        }
      })
    ).manifest;
    await expect(
      repo.createSyncPackageUploadSession(
        { userId: fixture.owner.id },
        {
          syncRelationshipId: fixture.sync.relationship.id,
          idempotencyKey: "bad-package",
          packageManifest: {},
          packageChecksum: "sha256:bad-package",
          totalBytes: 0
        }
      )
    ).rejects.toThrow("encrypted package manifest");
    await expect(
      repo.createSyncPackageUploadSession(
        { userId: fixture.owner.id },
        {
          syncRelationshipId: fixture.sync.relationship.id,
          idempotencyKey: "leaky-package",
          packageManifest: {
            ...packageManifest,
            plaintext: "raw Memory must not be stored in manifests"
          },
          packageChecksum: "sha256:leaky-package",
          totalBytes: 0
        }
      )
    ).rejects.toThrow("must be redacted");
    const upload = await repo.createSyncPackageUploadSession(
      { userId: fixture.owner.id },
      {
        syncRelationshipId: fixture.sync.relationship.id,
        idempotencyKey: "package-1",
        packageManifest: packageManifest as unknown as Record<string, unknown>,
        packageChecksum: "sha256:package",
        totalBytes: 20
      }
    );
    const replayedUpload = await repo.createSyncPackageUploadSession(
      { userId: fixture.owner.id },
      {
        syncRelationshipId: fixture.sync.relationship.id,
        idempotencyKey: "package-1",
        packageManifest: replayManifest as unknown as Record<string, unknown>,
        packageChecksum: "sha256:ignored",
        totalBytes: 20
      }
    );
    expect(replayedUpload?.id).toBe(upload?.id);
    expect(replayedUpload?.packageChecksum).toBe("sha256:package");

    const chunk = await repo.recordSyncPackageChunk(
      { userId: fixture.owner.id },
      {
        uploadSessionId: upload!.id,
        chunkIndex: 0,
        chunkChecksum: "sha256:first",
        byteCount: 12,
        storageRef: "object://sync/package-1/0"
      }
    );
    const replayedChunk = await repo.recordSyncPackageChunk(
      { userId: fixture.owner.id },
      {
        uploadSessionId: upload!.id,
        chunkIndex: 0,
        chunkChecksum: "sha256:first",
        byteCount: 12,
        storageRef: "object://sync/package-1/0-replay"
      }
    );
    expect(replayedChunk?.id).toBe(chunk?.id);

    const outbox = await repo.enqueueSyncOutboxEntry(
      { userId: fixture.owner.id },
      {
        syncRelationshipId: fixture.sync.relationship.id,
        uploadSessionId: upload!.id,
        idempotencyKey: "outbox-package-1",
        payloadManifest: { packageId: upload!.id }
      }
    );
    const replayedOutbox = await repo.enqueueSyncOutboxEntry(
      { userId: fixture.owner.id },
      {
        syncRelationshipId: fixture.sync.relationship.id,
        uploadSessionId: upload!.id,
        idempotencyKey: "outbox-package-1",
        payloadManifest: { ignored: true }
      }
    );
    expect(replayedOutbox?.id).toBe(outbox?.id);

    const inbox = await repo.recordSyncInboxEntry(
      { userId: fixture.owner.id },
      {
        syncRelationshipId: fixture.sync.relationship.id,
        uploadSessionId: upload!.id,
        idempotencyKey: "inbox-package-1",
        payloadManifest: { packageId: upload!.id }
      }
    );
    expect(inbox).toMatchObject({
      syncRelationshipId: fixture.sync.relationship.id,
      uploadSessionId: upload!.id,
      state: "pending"
    });

    const persisted = await pool.query<{
      uploaded_bytes: string;
      chunk_count: number;
      outbox_count: string;
      inbox_count: string;
    }>(
      `
        select
          spu.uploaded_bytes,
          spu.chunk_count,
          (select count(*) from sync_outbox_entries) as outbox_count,
          (select count(*) from sync_inbox_entries) as inbox_count
        from sync_package_upload_sessions spu
        where spu.id = $1
      `,
      [upload!.id]
    );
    expect(persisted.rows[0]).toEqual({
      uploaded_bytes: "12",
      chunk_count: 1,
      outbox_count: "1",
      inbox_count: "1"
    });
  });

  it("revokes future Cross-Identity Sync without deleting local offline state", async () => {
    const fixture = await createCrossIdentitySyncFixture();
    const revoked = await repo.revokeCrossIdentitySyncRelationship(
      { userId: fixture.owner.id },
      {
        syncRelationshipId: fixture.sync.relationship.id,
        reason: "operator_requested"
      }
    );
    expect(revoked).toMatchObject({
      id: fixture.sync.relationship.id,
      state: "revoked",
      revokedByUserId: fixture.owner.id,
      revocationReason: "operator_requested"
    });

    await expect(
      repo.createSyncPackageUploadSession(
        { userId: fixture.owner.id },
        {
          syncRelationshipId: fixture.sync.relationship.id,
          idempotencyKey: "after-revoke",
          packageManifest: {},
          packageChecksum: "sha256:after-revoke",
          totalBytes: 0
        }
      )
    ).resolves.toBeNull();
    await expect(
      repo.enqueueSyncOutboxEntry(
        { userId: fixture.owner.id },
        {
          syncRelationshipId: fixture.sync.relationship.id,
          idempotencyKey: "outbox-after-revoke"
        }
      )
    ).resolves.toBeNull();

    const persisted = await pool.query<{
      session_count: string;
      logical_count: string;
      source_replica_disabled_at: Date | null;
      target_replica_status: string;
      target_replica_disabled_at: Date | null;
    }>(
      `
        select
          (select count(*) from sessions where id = $1) as session_count,
          (select count(*) from logical_memories where id = $2) as logical_count,
          source.disabled_at as source_replica_disabled_at,
          target.freshness_status as target_replica_status,
          target.disabled_at as target_replica_disabled_at
        from memory_replicas source
        join memory_replicas target on target.id = $4
        where source.id = $3
      `,
      [
        fixture.session.id,
        fixture.logical.logicalMemory.id,
        fixture.logical.sourceReplica.id,
        fixture.sync.targetReplica.id
      ]
    );
    expect(persisted.rows[0]).toMatchObject({
      session_count: "1",
      logical_count: "1",
      source_replica_disabled_at: null,
      target_replica_status: "revoked"
    });
    expect(persisted.rows[0]?.target_replica_disabled_at).toBeInstanceOf(Date);
  });

  it("retains Team session share grants through personal deletion and member exit", async () => {
    const owner = await repo.createUser({
      email: `retention-owner-${randomUUID()}@example.com`,
      displayName: "Retention Owner"
    });
    const member = await repo.createUser({
      email: `retention-member-${randomUUID()}@example.com`,
      displayName: "Retention Member"
    });
    const team = await repo.createTeam(
      { userId: owner.id },
      { name: "Retention Team" }
    );
    await repo.upsertTeamMember(
      { userId: owner.id },
      { teamId: team.id, userId: member.id, role: "member" }
    );
    const workspace = await repo.createTeamWorkspace(
      { userId: owner.id },
      { teamId: team.id, name: "Retained Workspace" }
    );
    await repo.setTeamWorkspaceAccess(
      { userId: owner.id },
      {
        teamWorkspaceId: workspace!.id,
        userId: member.id,
        access: "read"
      }
    );
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        workspaceId: "retention-project",
        externalSessionId: `retained-session-${randomUUID()}`,
        sourceRuntime: "codex",
        captureMethod: "hook"
      }
    );
    const event = await repo.createMemoryEvent(
      { userId: owner.id },
      {
        visibility: "personal",
        workspaceId: "retention-project",
        sessionId: session.id,
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        content: "The billing grace period decision stays with the workspace.",
        captureMethod: "api"
      }
    );
    const retainedNode = await repo.createMemoryNode(
      { userId: owner.id },
      {
        visibility: "personal",
        summaryText: "Retained Team decision summary.",
        captureMethod: "hook",
        sourceRuntime: "codex",
        sourceHash: `retained-team-node-${randomUUID()}`
      }
    );
    await pool.query(
      `
        insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
        values ($1, $2, 0)
      `,
      [retainedNode.id, event.id]
    );

    const grant = await pool.query<{ id: string }>(
      `
        insert into team_session_share_grants (
          owner_user_id,
          session_id,
          team_id,
          team_workspace_id,
          granted_by_user_id
        )
        values ($1, $2, $3, $4, $5)
        returning id
      `,
      [owner.id, session.id, team.id, workspace!.id, owner.id]
    );
    const grantId = grant.rows[0]!.id;

    await pool.query(
      `
        update sessions
        set
          personal_deleted_at = now(),
          personal_deleted_by_user_id = $1,
          personal_deletion_reason = 'user_deleted'
        where id = $2
      `,
      [owner.id, session.id]
    );
    await pool.query(
      `
        update memory_events
        set
          personal_deleted_at = now(),
          personal_deleted_by_user_id = $1,
          personal_deletion_reason = 'user_deleted'
        where id = $2
      `,
      [owner.id, event.id]
    );
    await pool.query(
      `
        update memory_nodes
        set
          personal_deleted_at = now(),
          personal_deleted_by_user_id = $1,
          personal_deletion_reason = 'user_deleted'
        where id = $2
      `,
      [owner.id, retainedNode.id]
    );
    await pool.query(
      `
        update team_session_share_grants
        set
          personal_deleted_at = now(),
          personal_deleted_by_user_id = $1,
          personal_deletion_reason = 'user_deleted'
        where id = $2
      `,
      [owner.id, grantId]
    );
    const retainedGraphEvents = await repo.listLcmGraphEvents(
      { userId: member.id },
      {
        teamWorkspaceId: workspace!.id,
        includeContent: true
      }
    );
    expect(retainedGraphEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: event.id,
          content: "The billing grace period decision stays with the workspace."
        })
      ])
    );
    const retainedThreads = await repo.listLcmGraphThreads(
      { userId: member.id },
      { teamWorkspaceId: workspace!.id }
    );
    expect(retainedThreads.flatMap((project) => project.threads)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: session.id })
      ])
    );
    await expect(
      repo.getLcmGraphNode({ userId: member.id }, retainedNode.id, {
        teamWorkspaceId: workspace!.id
      })
    ).resolves.toMatchObject({
      id: retainedNode.id,
      sources: [expect.objectContaining({ id: event.id })]
    });
    await expect(
      repo.expandMemoryNode(
        retainedNode.id,
        { userId: member.id },
        {
          teamWorkspaceId: workspace!.id
        }
      )
    ).resolves.toMatchObject({
      nodeId: retainedNode.id,
      sources: [expect.objectContaining({ id: event.id })]
    });
    await repo.upsertTeamMember(
      { userId: owner.id },
      {
        teamId: team.id,
        userId: member.id,
        role: "member",
        status: "disabled"
      }
    );
    await repo.setTeamWorkspaceAccess(
      { userId: owner.id },
      {
        teamWorkspaceId: workspace!.id,
        userId: member.id,
        access: "disabled"
      }
    );
    await pool.query(
      `
        update users
        set
          deleted_at = now(),
          deletion_reason = 'account_deleted'
        where id = $1
      `,
      [owner.id]
    );
    await expect(
      pool.query("delete from users where id = $1", [owner.id])
    ).rejects.toThrow();

    const retained = await pool.query<{
      id: string;
      session_id: string;
      owner_user_id: string;
      personal_deleted_at: Date | null;
      revoked_at: Date | null;
      retention_reason: string;
    }>(
      `
        select
          id,
          session_id,
          owner_user_id,
          personal_deleted_at,
          revoked_at,
          retention_reason
        from team_session_share_grants
        where id = $1
      `,
      [grantId]
    );
    expect(retained.rows).toHaveLength(1);
    expect(retained.rows[0]).toMatchObject({
      id: grantId,
      session_id: session.id,
      owner_user_id: owner.id,
      revoked_at: null,
      retention_reason: "active_team_share"
    });
    expect(retained.rows[0]!.personal_deleted_at).toBeInstanceOf(Date);
    const retainedSources = await pool.query<{
      session_exists: string;
      memory_event_exists: string;
    }>(
      `
        select
          exists(select 1 from sessions where id = $1)::text as session_exists,
          exists(select 1 from memory_events where id = $2)::text as memory_event_exists
      `,
      [session.id, event.id]
    );
    expect(retainedSources.rows[0]).toEqual({
      session_exists: "true",
      memory_event_exists: "true"
    });
    await expect(
      repo.getTeamWorkspaceAccess({ userId: member.id }, workspace!.id)
    ).resolves.toMatchObject({
      membershipStatus: "disabled",
      access: "disabled",
      canRecall: false,
      canCreateShare: false
    });
    await expect(
      pool.query("delete from team_workspaces where id = $1", [workspace!.id])
    ).rejects.toThrow();
  });

  it("uses strict Team Workspace boundaries instead of requester personal rows", async () => {
    const owner = await repo.createUser({
      email: `team-boundary-owner-${randomUUID()}@example.com`,
      displayName: "Team Boundary Owner"
    });
    const team = await repo.createTeam(
      { userId: owner.id },
      { name: "Boundary Team" }
    );
    const electronWorkspace = await repo.createTeamWorkspace(
      { userId: owner.id },
      { teamId: team.id, name: "Electron Boundary" }
    );
    const cloudWorkspace = await repo.createTeamWorkspace(
      { userId: owner.id },
      { teamId: team.id, name: "Cloud Boundary" }
    );

    const createNodeFromSession = async (input: {
      workspaceId: string;
      content: string;
      summaryText: string;
      grantWorkspaceId?: string;
      revoked?: boolean;
    }) => {
      const session = await repo.createCapturedSession(
        { userId: owner.id },
        {
          workspaceId: input.workspaceId,
          externalSessionId: `boundary-session-${randomUUID()}`,
          sourceRuntime: "codex",
          captureMethod: "hook"
        }
      );
      const event = await repo.createMemoryEvent(
        { userId: owner.id },
        {
          visibility: "personal",
          workspaceId: input.workspaceId,
          sessionId: session.id,
          actor: "user",
          eventType: "captured",
          rawEventType: "user_prompt",
          content: input.content,
          captureMethod: "api"
        }
      );
      const node = await repo.createMemoryNode(
        { userId: owner.id },
        {
          visibility: "personal",
          summaryText: input.summaryText,
          bodyText: input.content,
          captureMethod: "hook",
          sourceRuntime: "codex",
          sourceHash: `boundary-node-${randomUUID()}`
        }
      );
      await pool.query(
        `
          insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
          values ($1, $2, 0)
        `,
        [node.id, event.id]
      );
      if (input.grantWorkspaceId) {
        await pool.query(
          `
            insert into team_session_share_grants (
              owner_user_id,
              session_id,
              team_id,
              team_workspace_id,
              granted_by_user_id,
              revoked_at,
              revoked_by_user_id,
              revocation_reason
            )
            values (
              $1,
              $2,
              $3,
              $4,
              $5,
              case when $6::boolean then now() else null end,
              case when $6::boolean then $5::uuid else null end,
              case when $6::boolean then 'boundary_regression_revoked' else null end
            )
          `,
          [
            owner.id,
            session.id,
            team.id,
            input.grantWorkspaceId,
            owner.id,
            input.revoked ?? false
          ]
        );
      }
      return { session, event, node };
    };

    const sharedElectron = await createNodeFromSession({
      workspaceId: "electron-boundary-project",
      content:
        "SharedElectronBoundaryUnique belongs in the Electron Team Workspace.",
      summaryText: "SharedElectronBoundaryUnique summary.",
      grantWorkspaceId: electronWorkspace!.id
    });
    const privateCloud = await createNodeFromSession({
      workspaceId: "cloud-boundary-project",
      content: "PrivatePricingBoundaryUnique must remain personal-only.",
      summaryText: "PrivatePricingBoundaryUnique summary."
    });
    const cloudOnly = await createNodeFromSession({
      workspaceId: "cloud-boundary-project",
      content:
        "CloudOnlyBoundaryUnique belongs only to the Cloud Team Workspace.",
      summaryText: "CloudOnlyBoundaryUnique summary.",
      grantWorkspaceId: cloudWorkspace!.id
    });
    const revokedElectron = await createNodeFromSession({
      workspaceId: "electron-boundary-project",
      content:
        "RevokedElectronBoundaryUnique was revoked from the Electron Team Workspace.",
      summaryText: "RevokedElectronBoundaryUnique summary.",
      grantWorkspaceId: electronWorkspace!.id,
      revoked: true
    });
    const visibleRollup = await repo.createMemoryNode(
      { userId: owner.id },
      {
        visibility: "personal",
        summaryText:
          "BoundaryVisibleRollupUnique summarizes only active Electron sources.",
        bodyText:
          "BoundaryVisibleRollupUnique body includes SharedElectronBoundaryUnique.",
        captureMethod: "hook",
        sourceRuntime: "codex",
        sourceHash: `boundary-visible-rollup-${randomUUID()}`
      }
    );
    const hiddenMixedRollup = await repo.createMemoryNode(
      { userId: owner.id },
      {
        visibility: "personal",
        summaryText:
          "BoundaryHiddenMixedRollupUnique mixes active and revoked Electron sources.",
        bodyText:
          "BoundaryHiddenMixedRollupUnique body includes RevokedElectronBoundaryUnique.",
        captureMethod: "hook",
        sourceRuntime: "codex",
        sourceHash: `boundary-hidden-mixed-rollup-${randomUUID()}`
      }
    );
    await pool.query(
      "update memory_nodes set kind = 'rollup', depth = 1 where id = any($1::uuid[])",
      [[visibleRollup.id, hiddenMixedRollup.id]]
    );
    await pool.query(
      `
        insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
        values
          ($1, $2, 0),
          ($3, $2, 0),
          ($3, $4, 1)
      `,
      [
        visibleRollup.id,
        sharedElectron.event.id,
        hiddenMixedRollup.id,
        revokedElectron.event.id
      ]
    );
    await pool.query(
      `
        insert into memory_node_children (parent_memory_node_id, child_memory_node_id, child_order)
        values
          ($1, $2, 0),
          ($3, $2, 0),
          ($3, $4, 1)
      `,
      [
        visibleRollup.id,
        sharedElectron.node.id,
        hiddenMixedRollup.id,
        revokedElectron.node.id
      ]
    );

    const electronActor = { userId: owner.id };
    const graphNodes = await repo.listLcmGraphNodes(electronActor, {
      teamWorkspaceId: electronWorkspace!.id,
      query: "BoundaryUnique",
      limit: 20
    });
    expect(graphNodes.map((node) => node.id)).toContain(sharedElectron.node.id);
    expect(graphNodes.map((node) => node.id)).not.toEqual(
      expect.arrayContaining([
        privateCloud.node.id,
        cloudOnly.node.id,
        revokedElectron.node.id
      ])
    );

    const graphEvents = await repo.listLcmGraphEvents(electronActor, {
      teamWorkspaceId: electronWorkspace!.id,
      includeContent: true,
      query: "BoundaryUnique",
      limit: 20
    });
    expect(graphEvents.map((event) => event.id)).toContain(
      sharedElectron.event.id
    );
    expect(graphEvents.map((event) => event.id)).not.toEqual(
      expect.arrayContaining([
        privateCloud.event.id,
        cloudOnly.event.id,
        revokedElectron.event.id
      ])
    );

    const graphThreads = await repo.listLcmGraphThreads(electronActor, {
      teamWorkspaceId: electronWorkspace!.id,
      query: "BoundaryUnique",
      limit: 20
    });
    expect(graphThreads.flatMap((project) => project.threads)).toEqual([
      expect.objectContaining({ sessionId: sharedElectron.session.id })
    ]);

    const lexical = await repo.searchMemoryNodes(electronActor, {
      query: "BoundaryUnique",
      scope: "personal",
      teamWorkspaceId: electronWorkspace!.id,
      retrievalStage: "lexical_search",
      limit: 20
    });
    expect(lexical.results.map((result) => result.nodeId)).toContain(
      sharedElectron.node.id
    );
    expect(lexical.results.map((result) => result.nodeId)).not.toEqual(
      expect.arrayContaining([
        privateCloud.node.id,
        cloudOnly.node.id,
        revokedElectron.node.id,
        hiddenMixedRollup.id
      ])
    );
    const sharedLeafResult = lexical.results.find(
      (result) => result.nodeId === sharedElectron.node.id
    );
    expect(sharedLeafResult?.parentNodeIds).toContain(visibleRollup.id);
    expect(sharedLeafResult?.parentNodeIds).not.toContain(hiddenMixedRollup.id);

    await expect(
      repo.expandMemoryNode(privateCloud.node.id, electronActor, {
        teamWorkspaceId: electronWorkspace!.id
      })
    ).rejects.toThrow("Memory node not found or not visible");
    await expect(
      repo.expandMemoryNode(cloudOnly.node.id, electronActor, {
        teamWorkspaceId: electronWorkspace!.id
      })
    ).rejects.toThrow("Memory node not found or not visible");
    await expect(
      repo.expandMemoryNode(revokedElectron.node.id, electronActor, {
        teamWorkspaceId: electronWorkspace!.id
      })
    ).rejects.toThrow("Memory node not found or not visible");
    await expect(
      repo.expandMemoryNode(sharedElectron.node.id, electronActor, {
        teamWorkspaceId: electronWorkspace!.id
      })
    ).resolves.toMatchObject({
      nodeId: sharedElectron.node.id,
      sources: [expect.objectContaining({ id: sharedElectron.event.id })]
    });
  });

  it("resolves Team Workspace authorization and lifecycle gates before encrypted companion decrypt", async () => {
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 13).toString("base64")
    );
    const decrypt = vi.fn(provider.decrypt.bind(provider));
    const instrumentedProvider = {
      mode: provider.mode,
      keyId: provider.keyId,
      keyVersion: provider.keyVersion,
      encrypt: provider.encrypt.bind(provider),
      decrypt
    } satisfies EnvelopeEncryptionProvider;
    const encryptedRepo = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: instrumentedProvider
    });
    const owner = await encryptedRepo.createUser({
      email: `encrypted-team-owner-${randomUUID()}@example.com`
    });
    const member = await encryptedRepo.createUser({
      email: `encrypted-team-member-${randomUUID()}@example.com`
    });
    const outsider = await encryptedRepo.createUser({
      email: `encrypted-team-outsider-${randomUUID()}@example.com`
    });
    const team = await encryptedRepo.createTeam(
      { userId: owner.id },
      { name: "Encrypted Boundary Team" }
    );
    await encryptedRepo.upsertTeamMember(
      { userId: owner.id },
      {
        teamId: team.id,
        userId: member.id,
        role: "member"
      }
    );
    const workspace = await encryptedRepo.createTeamWorkspace(
      { userId: owner.id },
      { teamId: team.id, name: "Encrypted Boundary Workspace" }
    );
    await encryptedRepo.setTeamWorkspaceAccess(
      { userId: owner.id },
      {
        teamWorkspaceId: workspace!.id,
        userId: member.id,
        access: "read"
      }
    );

    const createEncryptedNode = async (input: {
      label: string;
      shared?: boolean;
      revoked?: boolean;
    }) => {
      const session = await encryptedRepo.createCapturedSession(
        { userId: owner.id },
        {
          workspaceId: "encrypted-team-boundary",
          externalSessionId: `encrypted-team-${randomUUID()}`,
          sourceRuntime: "codex",
          captureMethod: "hook"
        }
      );
      const event = await encryptedRepo.createMemoryEvent(
        { userId: owner.id },
        {
          visibility: "personal",
          workspaceId: "encrypted-team-boundary",
          sessionId: session.id,
          actor: "user",
          eventType: "captured",
          rawEventType: "user_prompt",
          content: `${input.label} encrypted Team payload sentinel.`,
          captureMethod: "api",
          idempotencyKey: `encrypted-team-${randomUUID()}`
        }
      );
      const node = await encryptedRepo.createMemoryNode(
        { userId: owner.id },
        {
          visibility: "personal",
          summaryText: `${input.label} encrypted Team summary sentinel.`,
          bodyText: `${input.label} encrypted Team payload sentinel.`,
          captureMethod: "hook",
          sourceRuntime: "codex",
          sourceHash: `encrypted-team-node-${randomUUID()}`
        }
      );
      await pool.query(
        `
          insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
          values ($1, $2, 0)
        `,
        [node.id, event.id]
      );
      if (input.shared) {
        await pool.query(
          `
            insert into team_session_share_grants (
              owner_user_id,
              session_id,
              team_id,
              team_workspace_id,
              granted_by_user_id,
              revoked_at,
              revoked_by_user_id,
              revocation_reason
            )
            values (
              $1,
              $2,
              $3,
              $4,
              $5,
              case when $6::boolean then now() else null end,
              case when $6::boolean then $5::uuid else null end,
              case when $6::boolean then 'encrypted_boundary_revoked' else null end
            )
          `,
          [
            owner.id,
            session.id,
            team.id,
            workspace!.id,
            owner.id,
            input.revoked ?? false
          ]
        );
      }
      return { session, event, node };
    };

    const shared = await createEncryptedNode({
      label: "SharedEncryptedBoundaryUnique",
      shared: true
    });
    const privateOnly = await createEncryptedNode({
      label: "PrivateEncryptedBoundaryUnique"
    });
    const revoked = await createEncryptedNode({
      label: "RevokedEncryptedBoundaryUnique",
      shared: true,
      revoked: true
    });
    expect(decrypt).not.toHaveBeenCalled();

    const graphEvents = await encryptedRepo.listLcmGraphEvents(
      { userId: member.id },
      {
        teamWorkspaceId: workspace!.id,
        includeContent: true,
        query: "EncryptedBoundaryUnique",
        limit: 20
      }
    );
    const graphNodes = await encryptedRepo.listLcmGraphNodes(
      { userId: member.id },
      {
        teamWorkspaceId: workspace!.id,
        query: "EncryptedBoundaryUnique",
        limit: 20
      }
    );
    const lexical = await encryptedRepo.searchMemoryNodes(
      { userId: member.id },
      {
        query: "EncryptedBoundaryUnique",
        scope: "personal",
        teamWorkspaceId: workspace!.id,
        retrievalStage: "lexical_search",
        limit: 20
      }
    );

    expect(graphEvents.map((event) => event.id)).toEqual([shared.event.id]);
    expect(graphNodes.map((node) => node.id)).toEqual([shared.node.id]);
    expect(
      lexical.results
        .filter((result) => result.sourceType === "memory_node")
        .map((result) => result.sourceId)
    ).toEqual([shared.node.id]);
    expect(
      lexical.results
        .filter((result) => result.sourceType === "memory_event")
        .map((result) => result.sourceId)
    ).toEqual([shared.event.id]);
    expect(lexical.results.map((result) => result.sourceId)).not.toEqual(
      expect.arrayContaining([
        privateOnly.node.id,
        privateOnly.event.id,
        revoked.node.id,
        revoked.event.id
      ])
    );
    expect(JSON.stringify(graphEvents)).not.toContain(
      "PrivateEncryptedBoundaryUnique"
    );
    expect(JSON.stringify(graphNodes)).not.toContain(
      "RevokedEncryptedBoundaryUnique"
    );
    expect(decrypt).not.toHaveBeenCalled();

    await expect(
      encryptedRepo.decryptAuthorizedEncryptedField(
        { userId: member.id },
        instrumentedProvider,
        {
          sourceTable: "memory_events",
          sourceId: shared.event.id,
          sourceColumn: "payload"
        }
      )
    ).resolves.toBeNull();
    await expect(
      encryptedRepo.decryptAuthorizedEncryptedField(
        { userId: outsider.id },
        instrumentedProvider,
        {
          sourceTable: "memory_events",
          sourceId: privateOnly.event.id,
          sourceColumn: "payload"
        }
      )
    ).resolves.toBeNull();
    expect(decrypt).not.toHaveBeenCalled();

    await encryptedRepo.setTeamEntitlementState(
      { userId: owner.id },
      { teamId: team.id, status: "suspended", reason: "test_suspension" }
    );
    await expect(
      encryptedRepo.listLcmGraphEvents(
        { userId: member.id },
        {
          teamWorkspaceId: workspace!.id,
          includeContent: true,
          query: "SharedEncryptedBoundaryUnique"
        }
      )
    ).resolves.toEqual([]);
    expect(decrypt).not.toHaveBeenCalled();

    const ownerDecryptedShared =
      await encryptedRepo.decryptAuthorizedEncryptedField(
        { userId: owner.id },
        instrumentedProvider,
        {
          sourceTable: "memory_events",
          sourceId: shared.event.id,
          sourceColumn: "payload"
        }
      );
    expect(ownerDecryptedShared?.plaintext).toMatchObject({
      content: "SharedEncryptedBoundaryUnique encrypted Team payload sentinel."
    });
    expect(decrypt).toHaveBeenCalledTimes(1);

    await expect(
      encryptedRepo.invalidateEncryptedField(
        { userId: owner.id },
        {
          sourceTable: "memory_events",
          sourceId: shared.event.id,
          sourceColumn: "payload",
          reason: "owner_redaction"
        }
      )
    ).resolves.toBe(true);
    await expect(
      encryptedRepo.decryptAuthorizedEncryptedField(
        { userId: owner.id },
        instrumentedProvider,
        {
          sourceTable: "memory_events",
          sourceId: shared.event.id,
          sourceColumn: "payload"
        }
      )
    ).resolves.toBeNull();
    expect(decrypt).toHaveBeenCalledTimes(1);

    const auditMetadata = await pool.query<{ metadata: unknown }>(
      `
        select metadata
        from audit_events
        where metadata ->> 'teamId' = $1
        order by created_at asc
      `,
      [team.id]
    );
    const auditText = JSON.stringify(auditMetadata.rows);
    expect(auditText).not.toContain("SharedEncryptedBoundaryUnique");
    expect(auditText).not.toContain("PrivateEncryptedBoundaryUnique");
    expect(auditText).not.toContain("RevokedEncryptedBoundaryUnique");
  });

  it("validates encrypted Team fixture boundaries before decrypt, queue, and audit exposure", async () => {
    await withPaidManagedCloudProfile(async () => {
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 36).toString("base64")
      );
      const decrypt = vi.fn(provider.decrypt.bind(provider));
      const instrumentedProvider = {
        mode: provider.mode,
        keyId: provider.keyId,
        keyVersion: provider.keyVersion,
        encrypt: provider.encrypt.bind(provider),
        decrypt
      } satisfies EnvelopeEncryptionProvider;
      const encryptedRepo = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: instrumentedProvider
      });
      const queueRepo = createLocalWorkQueueRepository(pool);

      const owner = await encryptedRepo.createUser({
        email: `encrypted-fixture-owner-${randomUUID()}@example.com`
      });
      const member = await encryptedRepo.createUser({
        email: `encrypted-fixture-member-${randomUUID()}@example.com`
      });
      const removedMember = await encryptedRepo.createUser({
        email: `encrypted-fixture-removed-${randomUUID()}@example.com`
      });
      const outsider = await encryptedRepo.createUser({
        email: `encrypted-fixture-outsider-${randomUUID()}@example.com`
      });
      const team = await encryptedRepo.createTeam(
        { userId: owner.id },
        { name: "Encrypted Fixture Team" }
      );
      await encryptedRepo.upsertTeamMember(
        { userId: owner.id },
        { teamId: team.id, userId: member.id, role: "member" }
      );
      await encryptedRepo.upsertTeamMember(
        { userId: owner.id },
        { teamId: team.id, userId: removedMember.id, role: "member" }
      );
      const workspace = await encryptedRepo.createTeamWorkspace(
        { userId: owner.id },
        { teamId: team.id, name: "Encrypted Fixture Workspace" }
      );
      await encryptedRepo.setTeamWorkspaceAccess(
        { userId: owner.id },
        {
          teamWorkspaceId: workspace!.id,
          userId: member.id,
          access: "read"
        }
      );
      await encryptedRepo.setTeamWorkspaceAccess(
        { userId: owner.id },
        {
          teamWorkspaceId: workspace!.id,
          userId: removedMember.id,
          access: "disabled"
        }
      );

      const createCase = async (input: {
        label: string;
        shared?: boolean;
        revoked?: boolean;
      }) => {
        const session = await encryptedRepo.createCapturedSession(
          { userId: owner.id },
          {
            workspaceId: "encrypted-fixture",
            externalSessionId: `encrypted-fixture-${randomUUID()}`,
            sourceRuntime: "codex",
            captureMethod: "hook"
          }
        );
        const event = await encryptedRepo.createMemoryEvent(
          { userId: owner.id },
          {
            visibility: "personal",
            workspaceId: "encrypted-fixture",
            sessionId: session.id,
            actor: "user",
            eventType: "captured",
            rawEventType: "user_prompt",
            content: `${input.label} fixture memory payload sentinel.`,
            metadata: {
              cwd: "/Users/owner/private-checkout",
              projectPath: "/Users/owner/private-checkout",
              localProjectId: "owner-device-local-project",
              projectId: "owner-personal-project"
            },
            captureMethod: "api",
            idempotencyKey: `encrypted-fixture-event-${randomUUID()}`
          }
        );
        const node = await encryptedRepo.createMemoryNode(
          { userId: owner.id },
          {
            visibility: "personal",
            summaryText: `${input.label} fixture summary sentinel.`,
            bodyText: `${input.label} fixture body sentinel.`,
            captureMethod: "hook",
            sourceRuntime: "codex",
            sourceHash: `encrypted-fixture-node-${randomUUID()}`
          }
        );
        await pool.query(
          `
            insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
            values ($1, $2, 0)
          `,
          [node.id, event.id]
        );
        await encryptedRepo.upsertSourceEmbedding({
          source: {
            sourceType: "memory_event",
            sourceId: event.id,
            ownerUserId: owner.id,
            visibility: "personal",
            text: `${input.label} fixture embedding source sentinel.`,
            sourceHash: `encrypted-fixture-embedding-${randomUUID()}`
          },
          model: "qwen3-0.6b",
          dimensions: 1024,
          version: "qwen3-0.6b",
          vector: Array.from({ length: 1024 }, (_, index) =>
            index === 0 ? 1 : 0
          )
        });
        if (input.shared) {
          const grant = await encryptedRepo.createTeamSessionShareGrant(
            { userId: owner.id },
            { teamWorkspaceId: workspace!.id, sessionId: session.id }
          );
          if (input.revoked) {
            await encryptedRepo.revokeTeamSessionShareGrant(
              { userId: owner.id },
              {
                teamWorkspaceId: workspace!.id,
                shareGrantId: grant!.id,
                reason: `${input.label} revoked fixture sentinel`
              }
            );
          }
        }
        return { session, event, node };
      };

      const shared = await createCase({
        label: "SharedEncryptedFixtureUnique",
        shared: true
      });
      const privateOnly = await createCase({
        label: "PrivateEncryptedFixtureUnique"
      });
      const revoked = await createCase({
        label: "RevokedEncryptedFixtureUnique",
        shared: true,
        revoked: true
      });

      await queueRepo.enqueue({
        queueName: "memory-embed",
        jobName: "embed-source",
        data: { sourceType: "memory_event", sourceId: shared.event.id },
        jobKey: `encrypted-fixture-${shared.event.id}`
      });
      await queueRepo.enqueue({
        queueName: "lcm-compact",
        jobName: "compact-scope",
        data: { userId: owner.id, visibility: "personal" },
        jobKey: `encrypted-fixture-lcm-${owner.id}`
      });

      decrypt.mockClear();
      const rawStores = await pool.query<{ raw_payload: string }>(
        `
          select coalesce(string_agg(raw_payload, ' '), '') as raw_payload
          from (
            select row_to_json(memory_events)::text as raw_payload
            from memory_events
            where id = any($1::uuid[])
            union all
            select row_to_json(memory_nodes)::text as raw_payload
            from memory_nodes
            where id = any($2::uuid[])
            union all
            select row_to_json(memory_embeddings)::text as raw_payload
            from memory_embeddings
            where memory_event_id = any($1::uuid[])
            union all
            select row_to_json(local_work_queue)::text as raw_payload
            from local_work_queue
            union all
            select row_to_json(audit_events)::text as raw_payload
            from audit_events
            where metadata ->> 'teamId' = $3
          ) stores
        `,
        [
          [shared.event.id, privateOnly.event.id, revoked.event.id],
          [shared.node.id, privateOnly.node.id, revoked.node.id],
          team.id
        ]
      );
      const rawPayload = rawStores.rows[0]?.raw_payload ?? "";
      expect(rawPayload).not.toContain("FixtureUnique");
      expect(rawPayload).not.toContain("fixture memory payload sentinel");
      expect(rawPayload).not.toContain("fixture summary sentinel");
      expect(rawPayload).not.toContain("fixture embedding source sentinel");
      expect(rawPayload).not.toContain("revoked fixture sentinel");
      expect(decrypt).not.toHaveBeenCalled();

      const outsiderEvents = await encryptedRepo.listLcmGraphEvents(
        { userId: outsider.id },
        {
          teamWorkspaceId: workspace!.id,
          includeContent: true,
          limit: 20
        }
      );
      const removedMemberNodes = await encryptedRepo.listLcmGraphNodes(
        { userId: removedMember.id },
        {
          teamWorkspaceId: workspace!.id,
          limit: 20
        }
      );
      expect(outsiderEvents).toEqual([]);
      expect(removedMemberNodes).toEqual([]);
      expect(decrypt).not.toHaveBeenCalled();

      const memberEvents = await encryptedRepo.listLcmGraphEvents(
        { userId: member.id },
        {
          teamWorkspaceId: workspace!.id,
          includeContent: true,
          limit: 20
        }
      );
      expect(memberEvents).toEqual([
        expect.objectContaining({
          id: shared.event.id,
          content:
            "SharedEncryptedFixtureUnique fixture memory payload sentinel."
        })
      ]);
      expect(JSON.stringify(memberEvents)).not.toContain(
        "PrivateEncryptedFixtureUnique"
      );
      expect(JSON.stringify(memberEvents)).not.toContain(
        "RevokedEncryptedFixtureUnique"
      );
      expect(memberEvents[0]?.metadata).not.toHaveProperty("cwd");
      expect(memberEvents[0]?.metadata).not.toHaveProperty("projectPath");
      expect(memberEvents[0]?.metadata).not.toHaveProperty("localProjectId");
      expect(memberEvents[0]?.metadata).not.toHaveProperty("projectId");
      expect(JSON.stringify(memberEvents)).not.toContain(
        "/Users/owner/private-checkout"
      );
      expect(decrypt).toHaveBeenCalledTimes(1);

      decrypt.mockClear();
      await encryptedRepo.setTeamEntitlementState(
        { userId: owner.id },
        { teamId: team.id, status: "suspended", reason: "fixture_suspended" }
      );
      await expect(
        encryptedRepo.listLcmGraphEvents(
          { userId: member.id },
          {
            teamWorkspaceId: workspace!.id,
            includeContent: true,
            limit: 20
          }
        )
      ).resolves.toEqual([]);
      expect(decrypt).not.toHaveBeenCalled();
    });
  });

  it("decrypts paid managed-cloud redacted Memory Event payloads only after Team authorization", async () => {
    await withPaidManagedCloudProfile(async () => {
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 14).toString("base64")
      );
      const decrypt = vi.fn(provider.decrypt.bind(provider));
      const instrumentedProvider = {
        mode: provider.mode,
        keyId: provider.keyId,
        keyVersion: provider.keyVersion,
        encrypt: provider.encrypt.bind(provider),
        decrypt
      } satisfies EnvelopeEncryptionProvider;
      const encryptedRepo = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: instrumentedProvider
      });
      const owner = await encryptedRepo.createUser({
        email: `redacted-team-owner-${randomUUID()}@example.com`
      });
      const member = await encryptedRepo.createUser({
        email: `redacted-team-member-${randomUUID()}@example.com`
      });
      const team = await encryptedRepo.createTeam(
        { userId: owner.id },
        { name: "Redacted Team Boundary" }
      );
      await encryptedRepo.upsertTeamMember(
        { userId: owner.id },
        { teamId: team.id, userId: member.id, role: "member" }
      );
      const workspace = await encryptedRepo.createTeamWorkspace(
        { userId: owner.id },
        { teamId: team.id, name: "Redacted Boundary Workspace" }
      );
      await encryptedRepo.setTeamWorkspaceAccess(
        { userId: owner.id },
        {
          teamWorkspaceId: workspace!.id,
          userId: member.id,
          access: "read"
        }
      );

      const createRedactedEvent = async (input: {
        label: string;
        shared?: boolean;
        revoked?: boolean;
      }) => {
        const session = await encryptedRepo.createCapturedSession(
          { userId: owner.id },
          {
            workspaceId: "redacted-team-boundary",
            externalSessionId: `redacted-team-${randomUUID()}`,
            sourceRuntime: "codex",
            captureMethod: "hook"
          }
        );
        const event = await encryptedRepo.createMemoryEvent(
          { userId: owner.id },
          {
            visibility: "personal",
            workspaceId: "redacted-team-boundary",
            sessionId: session.id,
            actor: "user",
            eventType: "captured",
            rawEventType: "user_prompt",
            content: `${input.label} paid cloud redacted payload sentinel.`,
            captureMethod: "api",
            idempotencyKey: `redacted-team-${randomUUID()}`
          }
        );
        if (input.shared) {
          await pool.query(
            `
              insert into team_session_share_grants (
                owner_user_id,
                session_id,
                team_id,
                team_workspace_id,
                granted_by_user_id,
                revoked_at,
                revoked_by_user_id,
                revocation_reason
              )
              values (
                $1,
                $2,
                $3,
                $4,
                $5,
                case when $6::boolean then now() else null end,
                case when $6::boolean then $5::uuid else null end,
                case when $6::boolean then 'redacted_boundary_revoked' else null end
              )
            `,
            [
              owner.id,
              session.id,
              team.id,
              workspace!.id,
              owner.id,
              input.revoked ?? false
            ]
          );
        }
        return event;
      };

      const shared = await createRedactedEvent({
        label: "SharedRedactedBoundaryUnique",
        shared: true
      });
      const privateOnly = await createRedactedEvent({
        label: "PrivateRedactedBoundaryUnique"
      });
      const revoked = await createRedactedEvent({
        label: "RevokedRedactedBoundaryUnique",
        shared: true,
        revoked: true
      });

      const storedPayloads = await pool.query<{ payloads: string }>(
        `
          select string_agg(payload::text, ' ') as payloads
          from memory_events
          where id = any($1::uuid[])
        `,
        [[shared.id, privateOnly.id, revoked.id]]
      );
      expect(storedPayloads.rows[0]?.payloads).not.toContain(
        "RedactedBoundaryUnique"
      );
      expect(decrypt).not.toHaveBeenCalled();

      const graphEvents = await encryptedRepo.listLcmGraphEvents(
        { userId: member.id },
        {
          teamWorkspaceId: workspace!.id,
          includeContent: true,
          limit: 20
        }
      );
      expect(graphEvents).toEqual([
        expect.objectContaining({
          id: shared.id,
          content:
            "SharedRedactedBoundaryUnique paid cloud redacted payload sentinel."
        })
      ]);
      expect(JSON.stringify(graphEvents)).not.toContain(
        "PrivateRedactedBoundaryUnique"
      );
      expect(JSON.stringify(graphEvents)).not.toContain(
        "RevokedRedactedBoundaryUnique"
      );
      expect(decrypt).toHaveBeenCalledTimes(1);

      decrypt.mockClear();
      await encryptedRepo.setTeamEntitlementState(
        { userId: owner.id },
        { teamId: team.id, status: "suspended", reason: "test_suspension" }
      );
      await expect(
        encryptedRepo.listLcmGraphEvents(
          { userId: member.id },
          {
            teamWorkspaceId: workspace!.id,
            includeContent: true,
            limit: 20
          }
        )
      ).resolves.toEqual([]);
      expect(decrypt).not.toHaveBeenCalled();
    });
  });

  it("filters Team-expanded supporting context to shared Workspace sessions", async () => {
    const owner = await repo.createUser({
      email: `supporting-context-owner-${randomUUID()}@example.com`
    });
    const member = await repo.createUser({
      email: `supporting-context-member-${randomUUID()}@example.com`
    });
    const team = await repo.createTeam(
      { userId: owner.id },
      { name: "Supporting Context Team" }
    );
    await repo.upsertTeamMember(
      { userId: owner.id },
      { teamId: team.id, userId: member.id, role: "member" }
    );
    const workspace = await repo.createTeamWorkspace(
      { userId: owner.id },
      { teamId: team.id, name: "Supporting Context Workspace" }
    );
    await repo.setTeamWorkspaceAccess(
      { userId: owner.id },
      {
        teamWorkspaceId: workspace!.id,
        userId: member.id,
        access: "read"
      }
    );

    const sharedSession = await repo.createCapturedSession(
      { userId: owner.id },
      {
        workspaceId: "supporting-context-shared-project",
        externalSessionId: `supporting-context-shared-${randomUUID()}`,
        sourceRuntime: "codex",
        captureMethod: "hook"
      }
    );
    const privateSession = await repo.createCapturedSession(
      { userId: owner.id },
      {
        workspaceId: "supporting-context-private-project",
        externalSessionId: `supporting-context-private-${randomUUID()}`,
        sourceRuntime: "codex",
        captureMethod: "hook"
      }
    );

    const [sharedContext, privateContext] = await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          {
            sessionId: sharedSession.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "hook",
            externalTurnId: "shared-context-turn",
            sourceRecordType: "event_msg",
            sourceEventType: "user_message",
            rawJson: {
              type: "event_msg",
              payload: { type: "user_message" }
            },
            rawText: "Shared IDE context visible to the Team Workspace.",
            sourceHash: `shared-supporting-context-${randomUUID()}`,
            idempotencyKey: `shared-supporting-context-${randomUUID()}`,
            metadata: {
              transcriptType: "ide_context",
              contextKind: "ide_client_context",
              sourceRole: "supporting_context"
            }
          },
          {
            sessionId: privateSession.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalTurnId: "private-context-turn",
            sourceRecordType: "event_msg",
            sourceEventType: "user_message",
            rawJson: {
              type: "event_msg",
              payload: { type: "user_message" }
            },
            rawText: "Private IDE context must not leak to the Team Workspace.",
            sourceHash: `private-supporting-context-${randomUUID()}`,
            idempotencyKey: `private-supporting-context-${randomUUID()}`,
            metadata: {
              transcriptType: "ide_context",
              contextKind: "ide_client_context",
              sourceRole: "supporting_context"
            }
          }
        ]
      }
    );
    const sharedEvent = await repo.createMemoryEvent(
      { userId: owner.id },
      {
        visibility: "personal",
        workspaceId: "supporting-context-shared-project",
        sessionId: sharedSession.id,
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        content: "Shared decision with supporting context.",
        captureMethod: "hook"
      }
    );
    await pool.query(
      `
        insert into memory_event_sources (
          memory_event_id,
          conversation_item_id,
          source_order,
          source_role
        )
        values ($1, $2, 0, 'supporting_context'), ($1, $3, 1, 'supporting_context')
      `,
      [sharedEvent.id, sharedContext!.id, privateContext!.id]
    );
    const node = await repo.createMemoryNode(
      { userId: owner.id },
      {
        visibility: "personal",
        summaryText: "Shared node with mixed supporting context.",
        captureMethod: "hook",
        sourceRuntime: "codex",
        sourceHash: `shared-supporting-context-node-${randomUUID()}`
      }
    );
    await pool.query(
      `
        insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
        values ($1, $2, 0)
      `,
      [node.id, sharedEvent.id]
    );
    await pool.query(
      `
        insert into team_session_share_grants (
          owner_user_id,
          session_id,
          team_id,
          team_workspace_id,
          granted_by_user_id
        )
        values ($1, $2, $3, $4, $5)
      `,
      [owner.id, sharedSession.id, team.id, workspace!.id, owner.id]
    );

    const supportingTextFor = async (userId: string) => {
      const expanded = await repo.expandMemoryNode(
        node.id,
        { userId },
        { teamWorkspaceId: workspace!.id }
      );
      return expanded.sourceItems
        .flatMap((item) => item.supportingContext ?? [])
        .map((item) => item.text)
        .join("\n");
    };

    const memberSupportingText = await supportingTextFor(member.id);
    expect(memberSupportingText).toContain(
      "Shared IDE context visible to the Team Workspace."
    );
    expect(memberSupportingText).not.toContain(
      "Private IDE context must not leak to the Team Workspace."
    );

    const ownerSupportingText = await supportingTextFor(owner.id);
    expect(ownerSupportingText).toContain(
      "Shared IDE context visible to the Team Workspace."
    );
    expect(ownerSupportingText).not.toContain(
      "Private IDE context must not leak to the Team Workspace."
    );
  });

  it("handles Team invites, acceptance, disablement, and audit boundaries", async () => {
    const owner = await repo.createUser({
      email: `invite-owner-${randomUUID()}@example.com`,
      displayName: "Invite Owner"
    });
    const existingUserEmail = `existing-member-${randomUUID()}@example.com`;
    const existingUser = await repo.createUser({
      email: existingUserEmail,
      displayName: "Existing Member"
    });
    const outsider = await repo.createUser({
      email: `invite-outsider-${randomUUID()}@example.com`,
      displayName: "Invite Outsider"
    });
    const team = await repo.createTeam(
      { userId: owner.id },
      { name: "Invite Team" }
    );
    const workspace = await repo.createTeamWorkspace(
      { userId: owner.id },
      { teamId: team.id, name: "Launch Workspace" }
    );

    const existingTokenHash = `invite-${randomUUID()}-${randomUUID()}`;
    const existingInvite = await repo.createTeamInvite(
      { userId: owner.id },
      {
        teamId: team.id,
        email: existingUserEmail.toUpperCase(),
        role: "member",
        tokenHash: existingTokenHash,
        expiresAt: new Date(Date.now() + 60_000)
      }
    );
    expect(existingInvite).toMatchObject({
      teamId: team.id,
      email: existingUserEmail,
      role: "member",
      acceptedAt: null,
      revokedAt: null
    });
    await expect(
      repo.getTeamMembership({ userId: existingUser.id }, team.id)
    ).resolves.toMatchObject({
      role: "member",
      status: "invited"
    });

    await expect(
      repo.createTeamInvite(
        { userId: outsider.id },
        {
          teamId: team.id,
          email: `blocked-${randomUUID()}@example.com`,
          role: "member",
          tokenHash: `blocked-${randomUUID()}-${randomUUID()}`,
          expiresAt: new Date(Date.now() + 60_000)
        }
      )
    ).resolves.toBeNull();

    const acceptedExisting = await repo.acceptTeamInvite({
      tokenHash: existingTokenHash,
      userId: existingUser.id
    });
    expect(acceptedExisting).toMatchObject({
      createdUser: false,
      user: {
        id: existingUser.id,
        email: existingUserEmail
      },
      membership: {
        teamId: team.id,
        userId: existingUser.id,
        role: "member",
        status: "enabled"
      }
    });
    expect(acceptedExisting?.invite.acceptedAt).toEqual(expect.any(String));
    await expect(
      repo.acceptTeamInvite({
        tokenHash: existingTokenHash,
        userId: existingUser.id
      })
    ).resolves.toBeNull();

    await repo.createTeamInvite(
      { userId: owner.id },
      {
        teamId: team.id,
        email: existingUserEmail,
        role: "member",
        tokenHash: `reinvite-${randomUUID()}-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000)
      }
    );
    await expect(
      repo.getTeamMembership({ userId: existingUser.id }, team.id)
    ).resolves.toMatchObject({
      role: "member",
      status: "enabled"
    });

    await repo.upsertTeamMember(
      { userId: owner.id },
      { teamId: team.id, userId: existingUser.id, role: "admin" }
    );
    const lowerRoleInviteHash = `lower-role-${randomUUID()}-${randomUUID()}`;
    await repo.createTeamInvite(
      { userId: owner.id },
      {
        teamId: team.id,
        email: existingUserEmail,
        role: "member",
        tokenHash: lowerRoleInviteHash,
        expiresAt: new Date(Date.now() + 60_000)
      }
    );
    await expect(
      repo.acceptTeamInvite({
        tokenHash: lowerRoleInviteHash,
        userId: existingUser.id
      })
    ).resolves.toMatchObject({
      membership: {
        teamId: team.id,
        userId: existingUser.id,
        role: "admin",
        status: "enabled"
      }
    });

    const invitedOwnerEmail = `invited-owner-${randomUUID()}@example.com`;
    const invitedOwner = await repo.createUser({
      email: invitedOwnerEmail,
      displayName: "Invited Owner"
    });
    await repo.upsertTeamMember(
      { userId: owner.id },
      {
        teamId: team.id,
        userId: invitedOwner.id,
        role: "owner",
        status: "invited"
      }
    );
    await expect(
      repo.createTeamInvite(
        { userId: existingUser.id },
        {
          teamId: team.id,
          email: invitedOwnerEmail,
          role: "member",
          tokenHash: `owner-downgrade-${randomUUID()}-${randomUUID()}`,
          expiresAt: new Date(Date.now() + 60_000)
        }
      )
    ).resolves.toBeNull();
    await expect(
      repo.getTeamMembership({ userId: invitedOwner.id }, team.id)
    ).resolves.toMatchObject({
      role: "owner",
      status: "invited"
    });

    await repo.setTeamWorkspaceAccess(
      { userId: owner.id },
      {
        teamWorkspaceId: workspace!.id,
        userId: existingUser.id,
        access: "write"
      }
    );
    await expect(
      repo.getTeamWorkspaceAccess({ userId: existingUser.id }, workspace!.id)
    ).resolves.toMatchObject({
      access: "write",
      canRecall: true,
      canCreateShare: true
    });
    await repo.setTeamWorkspaceAccess(
      { userId: owner.id },
      {
        teamWorkspaceId: workspace!.id,
        userId: existingUser.id,
        access: "disabled"
      }
    );
    await expect(
      repo.getTeamWorkspaceAccess({ userId: existingUser.id }, workspace!.id)
    ).resolves.toMatchObject({
      access: "disabled",
      canRecall: false,
      canCreateShare: false
    });
    await repo.setTeamWorkspaceAccess(
      { userId: owner.id },
      {
        teamWorkspaceId: workspace!.id,
        userId: existingUser.id,
        access: "read"
      }
    );
    await expect(
      repo.getTeamWorkspaceAccess({ userId: existingUser.id }, workspace!.id)
    ).resolves.toMatchObject({
      access: "read",
      canRecall: true,
      canCreateShare: false
    });

    const staleInviteHash = `stale-${randomUUID()}-${randomUUID()}`;
    await repo.createTeamInvite(
      { userId: owner.id },
      {
        teamId: team.id,
        email: existingUserEmail,
        role: "member",
        tokenHash: staleInviteHash,
        expiresAt: new Date(Date.now() + 60_000)
      }
    );
    const disabled = await repo.disableTeamMember(
      { userId: owner.id },
      { teamId: team.id, userId: existingUser.id }
    );
    expect(disabled).toMatchObject({
      teamId: team.id,
      userId: existingUser.id,
      status: "disabled"
    });
    await expect(
      repo.getTeamWorkspaceAccess({ userId: existingUser.id }, workspace!.id)
    ).resolves.toMatchObject({
      membershipStatus: "disabled",
      access: "disabled",
      canRecall: false,
      canCreateShare: false
    });
    await expect(
      repo.acceptTeamInvite({
        tokenHash: staleInviteHash,
        userId: existingUser.id
      })
    ).resolves.toBeNull();
    await expect(
      repo.getTeamMembership({ userId: existingUser.id }, team.id)
    ).resolves.toMatchObject({
      role: "admin",
      status: "disabled"
    });

    const newUserEmail = `new-member-${randomUUID()}@example.com`;
    const newUserTokenHash = `invite-${randomUUID()}-${randomUUID()}`;
    const newUserInvite = await repo.createTeamInvite(
      { userId: owner.id },
      {
        teamId: team.id,
        email: newUserEmail,
        role: "admin",
        tokenHash: newUserTokenHash,
        expiresAt: new Date(Date.now() + 60_000)
      }
    );
    expect(newUserInvite).toMatchObject({
      email: newUserEmail,
      role: "admin"
    });

    const acceptedNewUser = await repo.acceptTeamInvite({
      tokenHash: newUserTokenHash,
      email: newUserEmail,
      displayName: "New Team Admin",
      passwordHash: "hashed-password"
    });
    expect(acceptedNewUser).toMatchObject({
      createdUser: true,
      user: {
        email: newUserEmail,
        displayName: "New Team Admin",
        passwordHash: "hashed-password"
      },
      membership: {
        teamId: team.id,
        role: "admin",
        status: "enabled"
      }
    });

    const concurrentEmail = `concurrent-member-${randomUUID()}@example.com`;
    const concurrentHashA = `concurrent-a-${randomUUID()}-${randomUUID()}`;
    const concurrentHashB = `concurrent-b-${randomUUID()}-${randomUUID()}`;
    await repo.createTeamInvite(
      { userId: owner.id },
      {
        teamId: team.id,
        email: concurrentEmail,
        role: "member",
        tokenHash: concurrentHashA,
        expiresAt: new Date(Date.now() + 60_000)
      }
    );
    await repo.createTeamInvite(
      { userId: owner.id },
      {
        teamId: team.id,
        email: concurrentEmail,
        role: "member",
        tokenHash: concurrentHashB,
        expiresAt: new Date(Date.now() + 60_000)
      }
    );
    const concurrentAccepted = await Promise.all([
      repo.acceptTeamInvite({
        tokenHash: concurrentHashA,
        email: concurrentEmail,
        displayName: "Concurrent Member"
      }),
      repo.acceptTeamInvite({
        tokenHash: concurrentHashB,
        email: concurrentEmail,
        displayName: "Concurrent Member"
      })
    ]);
    expect(concurrentAccepted).toHaveLength(2);
    expect(concurrentAccepted[0]?.user.id).toBe(concurrentAccepted[1]?.user.id);
    expect(
      concurrentAccepted.filter((accepted) => accepted?.createdUser).length
    ).toBe(1);

    await expect(
      repo.disableTeamMember(
        { userId: acceptedNewUser!.user.id },
        { teamId: team.id, userId: owner.id }
      )
    ).resolves.toBeNull();

    const auditRows = await pool.query<{
      action: string;
      metadata: Record<string, unknown>;
      audit_sequence: string;
    }>(
      `
        select action, metadata, audit_sequence
        from audit_events
        where action like 'team.%'
        order by created_at asc, audit_sequence asc
      `
    );
    expect(auditRows.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "team.invite.created",
        "team.invite.accepted",
        "team.member.enabled",
        "team.member.disabled",
        "team.workspace.created",
        "team.workspace_access.created",
        "team.workspace_access.removed"
      ])
    );
    expect(
      auditRows.rows.find(
        (row) => row.action === "team.workspace_access.created"
      )?.metadata
    ).toMatchObject({
      teamId: team.id,
      teamWorkspaceId: workspace!.id,
      userId: existingUser.id,
      access: "write",
      previousAccess: "disabled"
    });
    expect(
      auditRows.rows.find(
        (row) => row.action === "team.workspace_access.removed"
      )?.metadata
    ).toMatchObject({
      teamId: team.id,
      teamWorkspaceId: workspace!.id,
      userId: existingUser.id,
      access: "disabled",
      previousAccess: "write"
    });
    const accessEvents = auditRows.rows.filter(
      (row) =>
        row.metadata.teamWorkspaceId === workspace!.id &&
        row.metadata.userId === existingUser.id
    );
    expect(accessEvents.map((row) => row.action)).toEqual([
      "team.workspace_access.created",
      "team.workspace_access.removed",
      "team.workspace_access.created"
    ]);
    expect(accessEvents.at(-1)?.metadata).toMatchObject({
      teamId: team.id,
      teamWorkspaceId: workspace!.id,
      userId: existingUser.id,
      access: "read",
      previousAccess: "disabled"
    });
    const acceptedAuditIndex = auditRows.rows.findIndex(
      (row) =>
        row.action === "team.invite.accepted" &&
        row.metadata.userId === acceptedNewUser!.user.id
    );
    const enabledAuditIndex = auditRows.rows.findIndex(
      (row) =>
        row.action === "team.member.enabled" &&
        row.metadata.userId === acceptedNewUser!.user.id
    );
    expect(acceptedAuditIndex).toBeGreaterThanOrEqual(0);
    expect(enabledAuditIndex).toBeGreaterThan(acceptedAuditIndex);
    for (const row of auditRows.rows) {
      expect(JSON.stringify(row.metadata)).not.toContain(existingTokenHash);
      expect(JSON.stringify(row.metadata)).not.toContain(newUserTokenHash);
      expect(JSON.stringify(row.metadata)).not.toContain("hashed-password");
      expect(JSON.stringify(row.metadata)).not.toContain("raw memory");
      expect(JSON.stringify(row.metadata)).not.toContain("Launch Workspace");
    }
    const teamAuditEvents = await repo.listTeamAuditEvents(
      { userId: owner.id },
      { teamId: team.id }
    );
    const removedAccessAudit = teamAuditEvents?.find(
      (event) => event.action === "team.workspace_access.removed"
    );
    expect(
      teamAuditEvents?.find((event) => event.action === "team.member.enabled")
    ).toMatchObject({
      action: "team.member.enabled"
    });
    expect(removedAccessAudit).toMatchObject({
      action: "team.workspace_access.removed"
    });
    expect(removedAccessAudit?.metadata).toMatchObject({
      teamId: team.id,
      teamWorkspaceId: workspace!.id,
      userId: existingUser.id
    });
    await expect(
      repo.listTeamAuditEvents(
        { userId: owner.id },
        { teamId: team.id, action: "team.invite.created", limit: 1 }
      )
    ).resolves.toEqual([
      expect.objectContaining({ action: "team.invite.created" })
    ]);
    await expect(
      repo.listTeamAuditEvents({ userId: existingUser.id }, { teamId: team.id })
    ).resolves.toBeNull();
  });

  it("rolls back API token lifecycle changes when audit insertion fails", async () => {
    const user = await repo.createUser({
      email: `api-token-audit-rollback-${randomUUID()}@example.com`
    });
    const missingActorId = randomUUID();
    const failedCreateHash = `hash-${randomUUID()}-${randomUUID()}`;

    await expect(
      repo.createApiToken({
        ownerUserId: user.id,
        name: "Rollback Create",
        tokenHash: failedCreateHash,
        tokenPrefix: "cmt_fail",
        audit: {
          actorUserId: missingActorId,
          actorType: "user"
        }
      })
    ).rejects.toThrow();
    expect(await repo.listApiTokens(user.id)).toEqual([]);

    const tokenHash = `hash-${randomUUID()}-${randomUUID()}`;
    const token = await repo.createApiToken({
      ownerUserId: user.id,
      name: "Rollback Revoke",
      tokenHash,
      tokenPrefix: "cmt_keep"
    });
    await expect(
      repo.revokeApiToken(user.id, token.id, {
        actorUserId: missingActorId,
        actorType: "user"
      })
    ).rejects.toThrow();
    expect(await repo.listApiTokens(user.id)).toEqual([token]);
  });

  it("manages auth sessions through the Drizzle-backed repository slice", async () => {
    const email = `auth-session-${randomUUID()}@example.com`;
    const user = await repo.createUser({
      email,
      displayName: "Session User"
    });
    const activeHash = `${randomUUID()}-${randomUUID()}`;
    const revokedHash = `${randomUUID()}-${randomUUID()}`;
    const expiredHash = `${randomUUID()}-${randomUUID()}`;
    const disabledHash = `${randomUUID()}-${randomUUID()}`;

    await repo.createSession(
      user.id,
      activeHash,
      new Date(Date.now() + 60_000)
    );
    expect(await repo.getSessionUser(activeHash)).toMatchObject({
      id: user.id,
      email,
      displayName: "Session User",
      passwordHash: null
    });

    await repo.createSession(
      user.id,
      revokedHash,
      new Date(Date.now() + 60_000)
    );
    await repo.revokeSession(revokedHash);
    expect(await repo.getSessionUser(revokedHash)).toBeNull();
    await repo.revokeSession(revokedHash);

    await repo.createSession(
      user.id,
      expiredHash,
      new Date(Date.now() - 60_000)
    );
    expect(await repo.getSessionUser(expiredHash)).toBeNull();

    await repo.createSession(
      user.id,
      disabledHash,
      new Date(Date.now() + 60_000)
    );
    await pool.query("update users set disabled_at = now() where id = $1", [
      user.id
    ]);
    expect(await repo.getSessionUser(disabledHash)).toBeNull();

    const deletedUser = await repo.createUser({
      email: `auth-session-deleted-${randomUUID()}@example.com`
    });
    const deletedHash = `${randomUUID()}-${randomUUID()}`;
    await repo.createSession(
      deletedUser.id,
      deletedHash,
      new Date(Date.now() + 60_000)
    );
    await pool.query("update users set deleted_at = now() where id = $1", [
      deletedUser.id
    ]);
    expect(await repo.getSessionUser(deletedHash)).toBeNull();
  });

  it("maps external AuthKit identities by provider user id instead of email", async () => {
    const existingEmail = `external-auth-existing-${randomUUID()}@example.com`;
    await repo.createUser({
      email: existingEmail,
      displayName: "Existing Local User"
    });

    await expect(
      repo.upsertExternalAuthSession({
        provider: "workos_authkit",
        providerEnvironment: "test",
        providerUserId: `workos-${randomUUID()}`,
        email: existingEmail,
        emailVerified: true,
        displayName: "External Same Email"
      })
    ).rejects.toThrow(
      "External identity is not linked to the existing Koed account"
    );

    const providerUserId = `workos-${randomUUID()}`;
    const created = await repo.upsertExternalAuthSession({
      provider: "workos_authkit",
      providerEnvironment: "test",
      providerUserId,
      email: `external-auth-created-${randomUUID()}@example.com`,
      emailVerified: true,
      displayName: "External User",
      profile: {
        safe: true,
        refresh_token: "should-not-be-supplied-by-route"
      }
    });
    const seenAgain = await repo.upsertExternalAuthSession({
      provider: "workos_authkit",
      providerEnvironment: "test",
      providerUserId,
      email: `external-auth-renamed-${randomUUID()}@example.com`,
      emailVerified: false,
      displayName: "External Renamed"
    });

    expect(created.createdUser).toBe(true);
    expect(seenAgain.createdUser).toBe(false);
    expect(seenAgain.user.id).toBe(created.user.id);
    const identity = await repo.getExternalAuthIdentity({
      provider: "workos_authkit",
      providerEnvironment: "test",
      providerUserId
    });
    expect(identity).toMatchObject({
      userId: created.user.id,
      emailVerified: false,
      displayName: "External Renamed"
    });
    expect(JSON.stringify(identity?.profile)).not.toContain("refresh_token");
  });

  it("relinks external AuthKit identity when its previous Koed user is inactive", async () => {
    const providerUserId = `workos-${randomUUID()}`;
    const created = await repo.upsertExternalAuthSession({
      provider: "workos_authkit",
      providerEnvironment: "test",
      providerUserId,
      email: `external-auth-relink-${randomUUID()}@example.com`,
      emailVerified: true,
      displayName: "Original External User"
    });
    await pool.query("update users set disabled_at = now() where id = $1", [
      created.user.id
    ]);

    await expect(
      repo.upsertExternalAuthSession({
        provider: "workos_authkit",
        providerEnvironment: "test",
        providerUserId,
        email: created.user.email,
        emailVerified: true,
        displayName: "Inactive Same Email"
      })
    ).rejects.toMatchObject({
      message: "External identity is linked to an inactive Koed account",
      statusCode: 403
    });

    const relinked = await repo.upsertExternalAuthSession({
      provider: "workos_authkit",
      providerEnvironment: "test",
      providerUserId,
      email: `external-auth-relink-new-${randomUUID()}@example.com`,
      emailVerified: true,
      displayName: "Relinked External User"
    });
    const seenAgain = await repo.upsertExternalAuthSession({
      provider: "workos_authkit",
      providerEnvironment: "test",
      providerUserId,
      email: relinked.user.email,
      emailVerified: true,
      displayName: "Relinked External User Again"
    });
    const identity = await repo.getExternalAuthIdentity({
      provider: "workos_authkit",
      providerEnvironment: "test",
      providerUserId
    });

    expect(relinked.createdUser).toBe(true);
    expect(relinked.user.id).not.toBe(created.user.id);
    expect(seenAgain.createdUser).toBe(false);
    expect(seenAgain.user.id).toBe(relinked.user.id);
    expect(identity?.userId).toBe(relinked.user.id);
  });

  it("records WorkOS organization mapping without granting Team membership", async () => {
    const providerUserId = `workos-${randomUUID()}`;
    const providerOrganizationId = `org-${randomUUID()}`;
    const result = await repo.upsertExternalAuthSession({
      provider: "workos_authkit",
      providerEnvironment: "test",
      providerUserId,
      email: `external-auth-org-${randomUUID()}@example.com`,
      organization: {
        providerOrganizationId,
        name: "Mapped Organization",
        metadata: { source: "test" }
      }
    });
    await repo.upsertExternalAuthSession({
      provider: "workos_authkit",
      providerEnvironment: "test",
      providerUserId,
      email: `external-auth-org-updated-${randomUUID()}@example.com`,
      organization: {
        providerOrganizationId,
        name: "Mapped Organization Renamed",
        metadata: { source: "test-again" }
      }
    });
    const mappedTeamCount = await pool.query<{ count: string }>(
      `
        select count(*)::text as count
        from teams t
        join external_auth_organizations eao on eao.team_id = t.id
        where eao.provider_organization_id = $1
      `,
      [providerOrganizationId]
    );
    const namedTeamCount = await pool.query<{ count: string }>(
      `
        select count(*)::text as count
        from teams
        where name like 'Mapped Organization%'
      `
    );

    expect(result.organization).toMatchObject({
      provider: "workos_authkit",
      providerEnvironment: "test",
      name: "Mapped Organization",
      status: "linked"
    });
    expect(
      await repo.getTeamMembership(
        { userId: result.user.id },
        result.organization!.teamId
      )
    ).toBeNull();
    expect(mappedTeamCount.rows[0]?.count).toBe("1");
    expect(namedTeamCount.rows[0]?.count).toBe("1");
  });

  it("records user-scoped audit events through the Drizzle-backed repository slice", async () => {
    const alice = await repo.createUser({
      email: `audit-alice-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `audit-bob-${randomUUID()}@example.com`
    });
    const targetId = randomUUID();

    const aliceEvent = await repo.recordAuditEvent({
      actorUserId: alice.id,
      ownerUserId: alice.id,
      visibility: "personal",
      action: "api_token.created",
      targetTable: "api_tokens",
      targetId,
      metadata: {
        tokenPrefix: "cmt_test",
        nested: { ok: true }
      }
    });
    await repo.recordAuditEvent({
      actorUserId: bob.id,
      ownerUserId: bob.id,
      visibility: "personal",
      action: "api_token.revoked",
      targetTable: "api_tokens",
      targetId: randomUUID(),
      metadata: { tokenPrefix: "cmt_other" }
    });
    await repo.recordAuditEvent({
      actorUserId: alice.id,
      action: "operator.maintenance",
      metadata: { reason: "not user-scoped" }
    });

    expect(aliceEvent).toMatchObject({
      actorUserId: alice.id,
      ownerUserId: alice.id,
      visibility: "personal",
      action: "api_token.created",
      targetTable: "api_tokens",
      targetId,
      metadata: {
        tokenPrefix: "cmt_test",
        nested: { ok: true }
      }
    });
    expect(aliceEvent.createdAt).toEqual(expect.any(String));

    const aliceEvents = await repo.listAuditEvents({ userId: alice.id });
    expect(aliceEvents).toHaveLength(1);
    expect(aliceEvents[0]).toEqual(aliceEvent);

    expect(await repo.listAuditEvents({ userId: bob.id })).toHaveLength(1);
    expect(
      await repo.listAuditEvents(
        { userId: alice.id },
        { action: "api_token.revoked" }
      )
    ).toEqual([]);
    expect(
      await repo.listAuditEvents({ userId: alice.id }, { limit: 1 })
    ).toHaveLength(1);
  });

  it("summarizes activation analytics without exposing event attributes", async () => {
    const owner = await repo.createUser({
      email: `analytics-owner-${randomUUID()}@example.com`
    });
    const member = await repo.createUser({
      email: `analytics-member-${randomUUID()}@example.com`
    });
    const outsider = await repo.createUser({
      email: `analytics-outsider-${randomUUID()}@example.com`
    });
    const team = await repo.createTeam(
      { userId: owner.id },
      { name: "Analytics Team" }
    );
    await repo.upsertTeamMember(
      { userId: owner.id },
      { teamId: team.id, userId: member.id, role: "member" }
    );

    await repo.recordAuditEvent({
      actorUserId: owner.id,
      ownerUserId: owner.id,
      action: "analytics.activation.desktop_connected",
      targetTable: "teams",
      targetId: team.id,
      metadata: {
        event: "desktop_connected",
        surface: "desktop",
        deploymentProfile: "koed_managed_cloud",
        teamId: team.id,
        attributes: { os: "linux", rawPromptLikeValue: "must not appear" }
      }
    });
    await repo.recordAuditEvent({
      actorUserId: member.id,
      ownerUserId: member.id,
      action: "analytics.activation.first_recall_completed",
      targetTable: "teams",
      targetId: team.id,
      metadata: {
        event: "first_recall_completed",
        surface: "explorer",
        deploymentProfile: "koed_managed_cloud",
        teamId: team.id,
        attributes: { route: "memory_answer" }
      }
    });
    await repo.recordAuditEvent({
      actorUserId: outsider.id,
      ownerUserId: outsider.id,
      action: "analytics.activation.desktop_connected",
      targetTable: "users",
      targetId: outsider.id,
      metadata: {
        event: "desktop_connected",
        surface: "desktop",
        deploymentProfile: "private_vps"
      }
    });

    const teamFunnel = await repo.getActivationAnalyticsFunnel(
      { userId: owner.id },
      { teamId: team.id }
    );
    expect(teamFunnel).toMatchObject({
      scope: { ownerUserId: null, teamId: team.id, teamWorkspaceId: null },
      window: { since: null, until: null },
      events: [
        {
          event: "desktop_connected",
          count: 1,
          surfaces: { desktop: 1 },
          deploymentProfiles: { koed_managed_cloud: 1 }
        },
        {
          event: "first_recall_completed",
          count: 1,
          surfaces: { explorer: 1 },
          deploymentProfiles: { koed_managed_cloud: 1 }
        }
      ]
    });
    expect(JSON.stringify(teamFunnel)).not.toContain("must not appear");
    expect(JSON.stringify(teamFunnel)).not.toContain("memory_answer");
    await expect(
      repo.getActivationAnalyticsFunnel(
        { userId: member.id },
        { teamId: team.id }
      )
    ).resolves.toBeNull();
    await expect(
      repo.getActivationAnalyticsFunnel(
        { userId: outsider.id },
        { teamId: team.id }
      )
    ).resolves.toBeNull();

    const personalFunnel = await repo.getActivationAnalyticsFunnel({
      userId: outsider.id
    });
    expect(personalFunnel).toMatchObject({
      scope: { ownerUserId: outsider.id, teamId: null, teamWorkspaceId: null },
      events: [
        {
          event: "desktop_connected",
          count: 1,
          surfaces: { desktop: 1 },
          deploymentProfiles: { private_vps: 1 }
        }
      ]
    });
  });

  it("filters personal memory to the owning user", async () => {
    const alice = await repo.createUser({
      email: `alice-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-${randomUUID()}@example.com`
    });

    await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText: "Alice private memory",
        captureMethod: "hook",
        sourceRuntime: "codex",
        codexTranscriptPath: "/tmp/codex/transcript.jsonl",
        idempotencyKey: `hook:${randomUUID()}`,
        sourceHash: randomUUID()
      }
    );

    const aliceMemories = await repo.listVisibleMemoryNodes({
      userId: alice.id
    });
    const bobMemories = await repo.listVisibleMemoryNodes({ userId: bob.id });

    expect(aliceMemories).toHaveLength(1);
    expect(aliceMemories[0]?.summaryText).toBe("Alice private memory");
    expect(bobMemories).toHaveLength(0);
  });

  it("keeps personal memory boundaries across read, delete, export, and expansion paths", async () => {
    const alice = await repo.createUser({
      email: `alice-boundary-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-boundary-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);

    const aliceEvent = await captureUserEvent(engine, alice.id, {
      workspaceId: "workspace-personal-boundary",
      content: "Alice-only source evidence."
    });
    const bobEvent = await captureUserEvent(engine, bob.id, {
      workspaceId: "workspace-personal-boundary",
      content: "Bob source evidence must not leak through Alice expansion."
    });
    const invalidatedAliceEvent = await captureUserEvent(engine, alice.id, {
      workspaceId: "workspace-personal-boundary",
      content: "Invalidated Alice evidence must not expand."
    });
    await repo.invalidateLcmGraphEvent(
      { userId: alice.id },
      invalidatedAliceEvent.id
    );

    const aliceNode = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText: "Alice-only memory node",
        captureMethod: "hook",
        sourceRuntime: "codex"
      }
    );
    await pool.query(
      `
          insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
          values ($1, $2, 0), ($1, $3, 1), ($1, $4, 2)
        `,
      [aliceNode.id, aliceEvent.id, bobEvent.id, invalidatedAliceEvent.id]
    );

    expect(
      await repo.getVisibleMemoryNode({ userId: bob.id }, aliceNode.id)
    ).toBeNull();
    expect(await repo.deleteMemory({ userId: bob.id }, aliceNode.id)).toBe(
      false
    );
    expect(
      await repo.updateMemoryPresentation({ userId: bob.id }, aliceNode.id, {
        summaryText: "Bob rewrite attempt"
      })
    ).toBeNull();
    await expect(
      engine.expandMemoryNode(aliceNode.id, { userId: bob.id })
    ).rejects.toThrow("Memory node not found or not visible");

    const bobExport = await repo.exportMemoryRecords({ userId: bob.id });
    expect(bobExport.nodes.map((node) => node.id)).not.toContain(aliceNode.id);
    expect(bobExport.events.map((event) => event.id)).not.toContain(
      aliceEvent.id
    );

    const aliceExpanded = await engine.expandMemoryNode(aliceNode.id, {
      userId: alice.id
    });
    expect(aliceExpanded.sources.map((source) => source.content)).toEqual([
      "Alice-only source evidence."
    ]);
  }, 30_000);

  it("audits successful destructive memory actions without cross-user attempts or memory content", async () => {
    const alice = await repo.createUser({
      email: `alice-destructive-audit-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-destructive-audit-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const node = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText: "Sensitive node text must not enter audit metadata",
        captureMethod: "hook",
        sourceRuntime: "codex"
      }
    );
    const event = await captureUserEvent(engine, alice.id, {
      workspaceId: "audit-workspace",
      content: "Sensitive event text must not enter audit metadata"
    });

    expect(
      await repo.updateMemoryPresentation({ userId: bob.id }, node.id, {
        summaryText: "Bob rewrite attempt"
      })
    ).toBeNull();
    expect(await repo.deleteMemory({ userId: bob.id }, node.id)).toBe(false);
    expect(
      await repo.invalidateLcmGraphEvent({ userId: bob.id }, event.id)
    ).toBe(false);

    const updatedNode = await repo.updateMemoryPresentation(
      { userId: alice.id },
      node.id,
      {
        summaryText: "Updated sensitive node text",
        pinned: true
      }
    );
    expect(updatedNode).toMatchObject({ id: node.id });
    expect(updatedNode?.pinnedAt).toEqual(expect.any(String));
    expect(
      await repo.invalidateLcmGraphEvent({ userId: alice.id }, event.id)
    ).toBe(true);
    expect(await repo.deleteMemory({ userId: alice.id }, node.id)).toBe(true);

    const auditEvents = await repo.listAuditEvents({ userId: alice.id });
    expect(auditEvents.map((eventRecord) => eventRecord.action).sort()).toEqual(
      [
        "memory.deleted",
        "memory.presentation_updated",
        "memory_event.invalidated"
      ]
    );
    expect(await repo.listAuditEvents({ userId: bob.id })).toEqual([]);
    expect(
      auditEvents.every(
        (eventRecord) =>
          eventRecord.actorUserId === alice.id &&
          eventRecord.ownerUserId === alice.id
      )
    ).toBe(true);
    expect(
      auditEvents.find(
        (eventRecord) => eventRecord.action === "memory.presentation_updated"
      )
    ).toMatchObject({
      visibility: "personal",
      targetTable: "memory_nodes",
      targetId: node.id,
      metadata: {
        changedFields: ["summaryText", "pinned"],
        previousVisibility: "personal",
        nextVisibility: "personal",
        previousPinned: false,
        nextPinned: true
      }
    });
    expect(
      auditEvents.find((eventRecord) => eventRecord.action === "memory.deleted")
    ).toMatchObject({
      visibility: "personal",
      targetTable: "memory_nodes",
      targetId: node.id
    });
    expect(
      auditEvents.find(
        (eventRecord) => eventRecord.action === "memory_event.invalidated"
      )
    ).toMatchObject({
      visibility: "personal",
      targetTable: "memory_events",
      targetId: event.id,
      metadata: {
        eventType: "user_prompt",
        projectId: "audit-workspace"
      }
    });
    expect(
      JSON.stringify(auditEvents.map((eventRecord) => eventRecord.metadata))
    ).not.toContain("Sensitive");
  });

  it("captures personal facts, compacts, searches, answers, and expands a cited node", async () => {
    const alice = await repo.createUser({
      email: `alice-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);

    for (let index = 1; index <= 10; index += 1) {
      await captureUserEvent(engine, alice.id, {
        workspaceId: "workspace-personal",
        content: `Personal fact ${index}: Alice project codename is Aurora-${index}.`,
        metadata: { index }
      });
    }

    const compacted = await engine.scheduleCompaction({
      requesterContext: { userId: alice.id },
      visibility: "personal"
    });
    expect(compacted.leafNodeIds).toHaveLength(2);
    expect(compacted.rollupNodeId).not.toBeNull();
    await embedPendingSources();
    mockEmbeddingQuery();

    const search = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "Aurora",
      scope: "personal",
      limit: 10
    });
    expect(search.results[0]?.citation.visibility).toBe("personal");

    const answer = await engine.answerMemory({
      requesterContext: { userId: alice.id },
      query: "Aurora",
      scope: "personal",
      limit: 10
    });
    expect(answer.answer).toContain("Personal fact");
    expect(answer.citations[0]?.visibility).toBe("personal");

    const expanded = await engine.expandMemoryNode(search.results[0]!.nodeId, {
      userId: alice.id
    });
    expect(
      expanded.sourceItems.some(
        (item) =>
          item.kind === "memory_event" && item.sourceTable === "memory_events"
      )
    ).toBe(true);
    expect(
      expanded.sources.some((source) =>
        source.content.startsWith("Personal fact ")
      )
    ).toBe(true);
    expect(expanded.sources.map((source) => source.content)).toEqual(
      [...expanded.sources]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((source) => source.content)
    );
  });

  it("prefixes semantic recall query embeddings with the default Qwen instruction", async () => {
    process.env.EMBEDDING_SERVICE_URL = "http://embedding.test";
    process.env.EMBEDDING_MODEL = "qwen3-0.6b";
    process.env.EMBEDDING_QUERY_INSTRUCTION_ENABLED = "true";
    delete process.env.EMBEDDING_QUERY_INSTRUCTION;
    delete process.env.RERANKER_KEY;

    const alice = await repo.createUser({
      email: `alice-query-instruction-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const workspaceId = `workspace-query-instruction-${randomUUID()}`;
    const event = await captureUserEvent(engine, alice.id, {
      workspaceId,
      content: "Aurora retrieval target for query instruction testing."
    });
    const dimensions = 1024;
    const vector = Array.from({ length: dimensions }, (_, index) =>
      index === 0 ? 1 : 0
    );
    await repo.upsertSourceEmbedding({
      source: {
        sourceType: "memory_event",
        sourceId: event.id,
        ownerUserId: alice.id,
        visibility: "personal",
        text: event.content,
        sourceHash: `hash-${event.id}`
      },
      model: "qwen3-0.6b",
      dimensions,
      version: "qwen3-0.6b",
      vector
    });

    const embeddingFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "qwen3-0.6b",
          dimensions,
          vectors: [vector]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(embeddingFetch);

    const query = "Which memory mentions Aurora?";
    await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query,
      scope: "personal",
      searchDomain: "project",
      workspaceId,
      retrievalStage: "raw_fallback_search",
      strictLimit: true,
      limit: 1
    });

    const init = embeddingFetch.mock.calls[0]?.[1];
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as { texts?: string[] })
        : {};
    expect(body.texts?.[0]).toBe(
      [
        "Instruct: Given a question about captured AI-client memory, retrieve relevant memory events, conversation items, and summaries that answer the question.",
        `Query: ${query}`
      ].join("\n")
    );
  });

  it("can disable semantic recall query embedding instructions", async () => {
    process.env.EMBEDDING_SERVICE_URL = "http://embedding.test";
    process.env.EMBEDDING_MODEL = "qwen3-0.6b";
    process.env.EMBEDDING_QUERY_INSTRUCTION_ENABLED = "false";
    delete process.env.RERANKER_KEY;

    const alice = await repo.createUser({
      email: `alice-query-instruction-disabled-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const workspaceId = `workspace-query-instruction-disabled-${randomUUID()}`;
    const event = await captureUserEvent(engine, alice.id, {
      workspaceId,
      content: "Plain query embedding target for disabled instruction testing."
    });
    const dimensions = 1024;
    const vector = Array.from({ length: dimensions }, (_, index) =>
      index === 0 ? 1 : 0
    );
    await repo.upsertSourceEmbedding({
      source: {
        sourceType: "memory_event",
        sourceId: event.id,
        ownerUserId: alice.id,
        visibility: "personal",
        text: event.content,
        sourceHash: `hash-${event.id}`
      },
      model: "qwen3-0.6b",
      dimensions,
      version: "qwen3-0.6b",
      vector
    });

    const embeddingFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "qwen3-0.6b",
          dimensions,
          vectors: [vector]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(embeddingFetch);

    const query = "Find the plain query target";
    await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query,
      scope: "personal",
      searchDomain: "project",
      workspaceId,
      retrievalStage: "raw_fallback_search",
      strictLimit: true,
      limit: 1
    });

    const init = embeddingFetch.mock.calls[0]?.[1];
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as { texts?: string[] })
        : {};
    expect(body.texts).toEqual([query]);
  });

  it("packs LCM leaves on semantic memory event boundaries without crossing the token threshold", async () => {
    const previousLeafEventThreshold =
      process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD;
    const previousLeafTokenThreshold =
      process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD;
    const previousFreshTail = process.env.MEMORY_LCM_FRESH_EVENT_TAIL;
    const previousFanout = process.env.MEMORY_LCM_DEPTH1_FANOUT;
    process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD = "100";
    process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD = "120";
    process.env.MEMORY_LCM_FRESH_EVENT_TAIL = "0";
    process.env.MEMORY_LCM_DEPTH1_FANOUT = "20";

    try {
      const alice = await repo.createUser({
        email: `alice-lcm-boundary-${randomUUID()}@example.com`
      });
      const engine = createMemoryEngine(repo);
      const content = (index: number) =>
        `Semantic memory event ${index}: ${"boundary ".repeat(80)}`;

      for (let index = 1; index <= 3; index += 1) {
        await captureUserEvent(engine, alice.id, {
          workspaceId: "workspace-lcm-boundary",
          content: content(index),
          metadata: { index }
        });
      }

      const compacted = await engine.scheduleCompaction({
        requesterContext: { userId: alice.id },
        visibility: "personal"
      });
      expect(compacted.leafNodeIds).toHaveLength(2);

      const leaves = await pool.query<{
        id: string;
        source_event_count: number;
        source_token_estimate: number;
        source_items_json: unknown;
      }>(
        `
          select id, source_event_count, source_token_estimate, source_items_json
          from memory_nodes
          where id = any($1::uuid[])
          order by created_at asc, id asc
        `,
        [compacted.leafNodeIds]
      );

      expect(leaves.rows.map((row) => row.source_event_count)).toEqual([1, 1]);
      expect(leaves.rows.every((row) => row.source_token_estimate <= 120)).toBe(
        true
      );
      let sourceItemCount = 0;
      for (const row of leaves.rows) {
        if (Array.isArray(row.source_items_json)) {
          sourceItemCount += row.source_items_json.length;
        }
      }
      expect(sourceItemCount).toBe(2);
    } finally {
      if (previousLeafEventThreshold === undefined) {
        delete process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD;
      } else {
        process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD =
          previousLeafEventThreshold;
      }
      if (previousLeafTokenThreshold === undefined) {
        delete process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD;
      } else {
        process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD =
          previousLeafTokenThreshold;
      }
      if (previousFreshTail === undefined) {
        delete process.env.MEMORY_LCM_FRESH_EVENT_TAIL;
      } else {
        process.env.MEMORY_LCM_FRESH_EVENT_TAIL = previousFreshTail;
      }
      if (previousFanout === undefined) {
        delete process.env.MEMORY_LCM_DEPTH1_FANOUT;
      } else {
        process.env.MEMORY_LCM_DEPTH1_FANOUT = previousFanout;
      }
    }
  });

  it("uses semantic source text rather than provenance payloads for LCM token estimates", async () => {
    const previousLeafEventThreshold =
      process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD;
    const previousLeafTokenThreshold =
      process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD;
    const previousFreshTail = process.env.MEMORY_LCM_FRESH_EVENT_TAIL;
    process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD = "1";
    process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD = "6000";
    process.env.MEMORY_LCM_FRESH_EVENT_TAIL = "0";

    try {
      const alice = await repo.createUser({
        email: `alice-lcm-token-text-${randomUUID()}@example.com`
      });
      const engine = createMemoryEngine(repo);
      const event = await captureUserEvent(engine, alice.id, {
        workspaceId: "workspace-lcm-token-text",
        content: "Small semantic source text.",
        metadata: {
          provenanceNoise: "metadata noise ".repeat(10_000)
        }
      });

      const compacted = await engine.scheduleCompaction({
        requesterContext: { userId: alice.id },
        visibility: "personal"
      });
      const node = await pool.query<{
        source_token_estimate: number;
        source_items_json: unknown;
      }>(
        `
          select source_token_estimate, source_items_json
          from memory_nodes
          where id = $1
        `,
        [compacted.leafNodeIds[0]]
      );

      expect(node.rows[0]?.source_token_estimate).toBeLessThan(100);
      expect(JSON.stringify(node.rows[0]?.source_items_json)).toContain(
        event.id
      );
      expect(JSON.stringify(node.rows[0]?.source_items_json)).toContain(
        "provenanceNoise"
      );
    } finally {
      if (previousLeafEventThreshold === undefined) {
        delete process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD;
      } else {
        process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD =
          previousLeafEventThreshold;
      }
      if (previousLeafTokenThreshold === undefined) {
        delete process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD;
      } else {
        process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD =
          previousLeafTokenThreshold;
      }
      if (previousFreshTail === undefined) {
        delete process.env.MEMORY_LCM_FRESH_EVENT_TAIL;
      } else {
        process.env.MEMORY_LCM_FRESH_EVENT_TAIL = previousFreshTail;
      }
    }
  });

  it("stores multiple embedding chunks for one logical source", async () => {
    const alice = await repo.createUser({
      email: `alice-chunks-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const event = await captureUserEvent(engine, alice.id, {
      workspaceId: "workspace-chunks",
      content: "Chunkable source text alpha beta gamma."
    });
    const source = await repo.getEmbeddableSource("memory_event", event.id);
    expect(source).not.toBeNull();

    const dimensions = 1024;
    const firstVector = Array.from({ length: dimensions }, (_, index) =>
      index === 0 ? 1 : 0
    );
    const secondVector = Array.from({ length: dimensions }, (_, index) =>
      index === 1 ? 1 : 0
    );
    const model = process.env.EMBEDDING_MODEL ?? "qwen3-0.6b";
    const version = process.env.EMBEDDING_MODEL ?? "qwen3-0.6b";

    await repo.upsertSourceEmbedding({
      source: source!,
      model,
      dimensions,
      version,
      vector: firstVector,
      chunkIndex: 0,
      chunkCount: 2,
      sourceText: "Chunkable source text alpha."
    });
    const pendingAfterPartial = await repo.listSourcesNeedingEmbeddings(50);
    expect(
      pendingAfterPartial.some((candidate) => candidate.sourceId === event.id)
    ).toBe(true);
    await repo.upsertSourceEmbedding({
      source: source!,
      model,
      dimensions,
      version,
      vector: secondVector,
      chunkIndex: 1,
      chunkCount: 2,
      sourceText: "Chunkable source text beta gamma."
    });

    const stored = await pool.query<{
      source_chunk_index: number;
      source_chunk_count: number;
      source_text: string;
    }>(
      `
        select source_chunk_index, source_chunk_count, source_text
        from memory_embeddings
        where memory_event_id = $1
        order by source_chunk_index asc
      `,
      [event.id]
    );
    expect(stored.rows).toEqual([
      {
        source_chunk_index: 0,
        source_chunk_count: 2,
        source_text: "Chunkable source text alpha."
      },
      {
        source_chunk_index: 1,
        source_chunk_count: 2,
        source_text: "Chunkable source text beta gamma."
      }
    ]);

    const pending = await repo.listSourcesNeedingEmbeddings(50);
    expect(pending.some((candidate) => candidate.sourceId === event.id)).toBe(
      false
    );

    await pool.query(
      "update memory_events set source_hash = $2 where id = $1",
      [event.id, `updated-source-${randomUUID()}`]
    );
    const pendingAfterSourceChange =
      await repo.listSourcesNeedingEmbeddings(50);
    expect(
      pendingAfterSourceChange.some(
        (candidate) => candidate.sourceId === event.id
      )
    ).toBe(true);
  });

  it("atomically replaces partial embedding sets and preserves a valid active set on rejection", async () => {
    const alice = await repo.createUser({
      email: `alice-atomic-embedding-${randomUUID()}@example.com`
    });
    const event = await captureUserEvent(createMemoryEngine(repo), alice.id, {
      workspaceId: "workspace-atomic-embedding",
      content: "Atomic embedding replacement source text."
    });
    const source = await repo.getEmbeddableSource("memory_event", event.id);
    expect(source).not.toBeNull();

    const dimensions = 1024;
    const model = process.env.EMBEDDING_MODEL ?? "qwen3-0.6b";
    const version = process.env.EMBEDDING_MODEL ?? "qwen3-0.6b";
    const vector = (activeIndex: number) =>
      Array.from({ length: dimensions }, (_, index) =>
        index === activeIndex ? 1 : 0
      );
    await repo.upsertSourceEmbedding({
      source: source!,
      model,
      dimensions,
      version,
      vector: vector(0),
      chunkIndex: 0,
      chunkCount: 2,
      sourceText: "Incomplete old chunk."
    });

    const replaced = await repo.replaceSourceEmbeddings({
      source: source!,
      model,
      dimensions,
      version,
      chunks: [
        {
          vector: vector(1),
          chunkIndex: 0,
          chunkCount: 2,
          sourceText: "Complete new chunk one."
        },
        {
          vector: vector(2),
          chunkIndex: 1,
          chunkCount: 2,
          sourceText: "Complete new chunk two."
        }
      ]
    });
    const replay = await repo.replaceSourceEmbeddings({
      source: source!,
      model,
      dimensions,
      version,
      chunks: [
        {
          vector: vector(1),
          chunkIndex: 0,
          chunkCount: 2,
          sourceText: "Complete new chunk one."
        },
        {
          vector: vector(2),
          chunkIndex: 1,
          chunkCount: 2,
          sourceText: "Complete new chunk two."
        }
      ]
    });
    await expect(
      repo.replaceSourceEmbeddings({
        source: source!,
        model,
        dimensions,
        version,
        chunks: [
          {
            vector: vector(3),
            chunkIndex: 1,
            chunkCount: 1,
            sourceText: "Out-of-order replacement."
          }
        ]
      })
    ).rejects.toThrow("complete ordered set");

    const rows = await pool.query<{
      invalidated_at: string | null;
      source_chunk_index: number;
      source_text: string;
    }>(
      `
        select invalidated_at::text, source_chunk_index, source_text
        from memory_embeddings
        where memory_event_id = $1
        order by invalidated_at nulls first, source_chunk_index asc
      `,
      [event.id]
    );
    expect(replaced.inserted).toBe(true);
    expect(replay).toEqual({ ids: replaced.ids, inserted: false });
    expect(
      rows.rows
        .filter((row) => row.invalidated_at === null)
        .map(({ source_chunk_index, source_text }) => ({
          source_chunk_index,
          source_text
        }))
    ).toEqual([
      {
        source_chunk_index: 0,
        source_text: "Complete new chunk one."
      },
      {
        source_chunk_index: 1,
        source_text: "Complete new chunk two."
      }
    ]);
    expect(rows.rows.filter((row) => row.invalidated_at !== null)).toHaveLength(
      1
    );
  });

  it("displays stored LCM summaries instead of node embedding chunk text", async () => {
    const originalEmbeddingServiceUrl = process.env.EMBEDDING_SERVICE_URL;
    process.env.EMBEDDING_SERVICE_URL = "http://embedding.test";

    try {
      const dimensions = 1024;
      const queryVector = Array.from({ length: dimensions }, (_, index) =>
        index === 0 ? 1 : 0
      );
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            model: process.env.EMBEDDING_MODEL ?? "qwen3-0.6b",
            dimensions,
            vectors: [queryVector]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        )
      );

      const alice = await repo.createUser({
        email: `alice-lcm-display-${randomUUID()}@example.com`
      });
      const engine = createMemoryEngine(repo);
      const event = await captureUserEvent(engine, alice.id, {
        workspaceId: "workspace-lcm-display",
        content: "Koed is being run in Docker for local testing."
      });
      const node = await repo.createMemoryNode(
        { userId: alice.id },
        {
          visibility: "personal",
          summaryText:
            "Clean LCM summary: Koed is being run in Docker for local testing.",
          summaryModel: "codex:test"
        }
      );
      await pool.query(
        "insert into memory_node_sources (memory_node_id, memory_event_id, source_order) values ($1, $2, 0)",
        [node.id, event.id]
      );
      const source = await repo.getEmbeddableSource("memory_node", node.id);
      expect(source).not.toBeNull();

      await repo.upsertSourceEmbedding({
        source: source!,
        model: process.env.EMBEDDING_MODEL ?? "qwen3-0.6b",
        dimensions,
        version: process.env.EMBEDDING_MODEL ?? "qwen3-0.6b",
        vector: queryVector,
        sourceText: [
          "LCM depth 0 leaf summary",
          "Source items: 100",
          "",
          "Exact ordered source outline:",
          "- [memory_event abc] tool: Tool call internal outline text"
        ].join("\n")
      });

      const search = await engine.searchMemory({
        requesterContext: { userId: alice.id },
        query: "Is Koed running in Docker?",
        scope: "personal",
        searchDomain: "global",
        limit: 1
      });

      expect(search.results[0]?.sourceType).toBe("memory_node");
      expect(search.results[0]?.summaryText).toBe(
        "Clean LCM summary: Koed is being run in Docker for local testing."
      );
      expect(search.results[0]?.summaryText).not.toContain(
        "Exact ordered source outline"
      );
    } finally {
      if (originalEmbeddingServiceUrl === undefined) {
        delete process.env.EMBEDDING_SERVICE_URL;
      } else {
        process.env.EMBEDDING_SERVICE_URL = originalEmbeddingServiceUrl;
      }
    }
  });

  it("keeps non-rerankable vector hits when summary reranking is requested", async () => {
    const originalEmbeddingServiceUrl = process.env.EMBEDDING_SERVICE_URL;
    const originalRerankerKey = process.env.RERANKER_KEY;
    const originalEmbeddingServiceToken = process.env.EMBEDDING_SERVICE_TOKEN;
    process.env.EMBEDDING_SERVICE_URL = "http://embedding.test";
    process.env.RERANKER_KEY = "qwen3-reranker-0.6b";
    process.env.EMBEDDING_SERVICE_TOKEN = "test-embedding-token";

    try {
      const dimensions = 1024;
      const queryVector = Array.from({ length: dimensions }, (_, index) =>
        index === 0 ? 1 : 0
      );
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const endpoint = String(url);
        if (endpoint.endsWith("/embed")) {
          const headers = new Headers(init?.headers);
          expect(headers.get("x-koed-embedding-token")).toBe(
            "test-embedding-token"
          );
          expect(headers.get("x-koed-embedding-priority")).toBe("interactive");
          return new Response(
            JSON.stringify({
              model: process.env.EMBEDDING_MODEL ?? "qwen3-0.6b",
              dimensions,
              vectors: [queryVector]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }
        if (endpoint.endsWith("/rerank")) {
          expect(new Headers(init?.headers).get("x-koed-embedding-token")).toBe(
            "test-embedding-token"
          );
          const request = JSON.parse(String(init?.body ?? "{}")) as {
            documents?: string[];
          };
          return new Response(
            JSON.stringify({
              model: "test-reranker",
              scores: Array.from(
                { length: request.documents?.length ?? 0 },
                () => 0.1
              )
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }
        return new Response(JSON.stringify({ detail: "unexpected endpoint" }), {
          status: 500,
          headers: { "content-type": "application/json" }
        });
      });

      const alice = await repo.createUser({
        email: `alice-rerank-${randomUUID()}@example.com`
      });
      const engine = createMemoryEngine(repo);
      const completedNode = await repo.createMemoryNode(
        { userId: alice.id },
        {
          visibility: "personal",
          summaryText: "Completed summary about archived preferences.",
          summaryModel: "codex:test"
        }
      );
      const freshEvent = await captureUserEvent(engine, alice.id, {
        workspaceId: "workspace-rerank",
        content:
          "Fresh raw event says the favourite footballer is Paul McGrath."
      });
      const nodeSource = await repo.getEmbeddableSource(
        "memory_node",
        completedNode.id
      );
      const eventSource = await repo.getEmbeddableSource(
        "memory_event",
        freshEvent.id
      );
      expect(nodeSource).not.toBeNull();
      expect(eventSource).not.toBeNull();
      const model = process.env.EMBEDDING_MODEL ?? "qwen3-0.6b";
      const version = process.env.EMBEDDING_MODEL ?? "qwen3-0.6b";
      await repo.upsertSourceEmbedding({
        source: nodeSource!,
        model,
        dimensions,
        version,
        vector: queryVector
      });
      await repo.upsertSourceEmbedding({
        source: eventSource!,
        model,
        dimensions,
        version,
        vector: queryVector
      });

      const search = await engine.searchMemory({
        requesterContext: { userId: alice.id },
        query: "Who is the favourite footballer?",
        scope: "personal",
        searchDomain: "global",
        limit: 2
      });

      expect(search.metadata.retrievalMode).toBe("semantic_vector");
      expect(search.metadata.rerankingEnabled).toBe(true);
      expect(search.results.map((result) => result.sourceType)).toContain(
        "memory_event"
      );
      expect(search.results.map((result) => result.summaryText)).toContain(
        "Fresh raw event says the favourite footballer is Paul McGrath."
      );
    } finally {
      if (originalEmbeddingServiceUrl === undefined) {
        delete process.env.EMBEDDING_SERVICE_URL;
      } else {
        process.env.EMBEDDING_SERVICE_URL = originalEmbeddingServiceUrl;
      }
      if (originalRerankerKey === undefined) {
        delete process.env.RERANKER_KEY;
      } else {
        process.env.RERANKER_KEY = originalRerankerKey;
      }
      if (originalEmbeddingServiceToken === undefined) {
        delete process.env.EMBEDDING_SERVICE_TOKEN;
      } else {
        process.env.EMBEDDING_SERVICE_TOKEN = originalEmbeddingServiceToken;
      }
    }
  });

  it("does not duplicate identical LCM summary and body text for node embeddings", async () => {
    const alice = await repo.createUser({
      email: `alice-node-source-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);

    for (let index = 1; index <= 5; index += 1) {
      await captureUserEvent(engine, alice.id, {
        workspaceId: "workspace-node-source",
        content: `Node source fact ${index}: Paul McGrath was mentioned.`,
        metadata: { index }
      });
    }

    const compacted = await engine.scheduleCompaction({
      requesterContext: { userId: alice.id },
      visibility: "personal"
    });
    const nodeId = compacted.leafNodeIds[0];
    expect(nodeId).toBeTruthy();

    const source = await repo.getEmbeddableSource("memory_node", nodeId!);
    expect(source).not.toBeNull();
    const text = source!.text;
    const firstIndex = text.indexOf("Node source fact 1");
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Node source fact 1", firstIndex + 1)).toBe(-1);
  });

  it("stores child links and ordered source outlines for LCM rollups", async () => {
    const alice = await repo.createUser({
      email: `alice-rollup-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);

    for (let index = 1; index <= 20; index += 1) {
      await captureUserEvent(engine, alice.id, {
        workspaceId: "workspace-rollup",
        content: `Rollup source ${index}`,
        metadata: { index }
      });
    }

    const compacted = await engine.scheduleCompaction({
      requesterContext: { userId: alice.id },
      visibility: "personal"
    });
    expect(compacted.rollupNodeId).not.toBeNull();

    const childLinks = await pool.query<{ count: string }>(
      "select count(*) as count from memory_node_children where parent_memory_node_id = $1",
      [compacted.rollupNodeId]
    );
    expect(Number(childLinks.rows[0]?.count)).toBeGreaterThan(0);

    const expanded = await engine.expandMemoryNode(compacted.rollupNodeId!, {
      userId: alice.id
    });
    expect(expanded.sourceItems.some((item) => item.kind === "lcm_child")).toBe(
      true
    );
    expect(expanded.sources.map((source) => source.content)).toHaveLength(10);
    expect(expanded.sources[0]?.content).toMatch(/^Rollup source /);
  });

  it("filters hierarchical retrieval by source event time and only uses raw fallback when needed", async () => {
    const alice = await repo.createUser({
      email: `alice-recent-rag-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);

    const oldEventIds: string[] = [];
    const recentEventIds: string[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const event = await captureUserEvent(engine, alice.id, {
        workspaceId: "workspace-recent-rag",
        content:
          index <= 5
            ? `Old-only temporal evidence ${index}.`
            : `Recent temporal evidence ${index}.`,
        metadata: { index }
      });
      if (index <= 5) {
        oldEventIds.push(event.id);
      } else {
        recentEventIds.push(event.id);
      }
    }

    await pool.query(
      "update memory_events set captured_at = now() - interval '45 days', created_at = now() where id = any($1::uuid[])",
      [oldEventIds]
    );
    await pool.query(
      "update memory_events set captured_at = now() - interval '2 days', created_at = now() where id = any($1::uuid[])",
      [recentEventIds]
    );

    const compacted = await engine.scheduleCompaction({
      requesterContext: { userId: alice.id },
      visibility: "personal"
    });
    expect(compacted.rollupNodeId).not.toBeNull();
    await embedPendingSources();

    const oldLeaf = await pool.query<{ memory_node_id: string }>(
      `
        select mns.memory_node_id
        from memory_node_sources mns
        join memory_nodes mn on mn.id = mns.memory_node_id
        where mns.memory_event_id = $1
          and mn.kind = 'leaf'
        limit 1
      `,
      [oldEventIds[0]]
    );
    const recentLeaf = await pool.query<{ memory_node_id: string }>(
      `
        select mns.memory_node_id
        from memory_node_sources mns
        join memory_nodes mn on mn.id = mns.memory_node_id
        where mns.memory_event_id = $1
          and mn.kind = 'leaf'
        limit 1
      `,
      [recentEventIds[0]]
    );
    const oldLeafId = oldLeaf.rows[0]!.memory_node_id;
    const recentLeafId = recentLeaf.rows[0]!.memory_node_id;

    mockEmbeddingQuery();
    const recentSearch = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "temporal evidence",
      scope: "personal",
      recentDays: 30,
      limit: 10
    });

    const resultNodeIds = recentSearch.results.map((result) => result.nodeId);
    expect(resultNodeIds).toContain(compacted.rollupNodeId);
    expect(resultNodeIds).toContain(recentLeafId);
    expect(resultNodeIds).not.toContain(oldLeafId);
    expect(
      recentSearch.results.some((result) =>
        result.summaryText.includes("Recent temporal evidence")
      )
    ).toBe(true);
    expect(
      recentSearch.results.some((result) =>
        result.summaryText.includes("Old-only temporal evidence")
      )
    ).toBe(false);
    expect(recentSearch.metadata.temporalFilter).toMatchObject({
      recentDays: 30
    });
    expect(recentSearch.metadata.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "rollup_search",
          used: true,
          temporalFilterApplied: true
        }),
        expect.objectContaining({
          name: "raw_fallback_search",
          ran: true
        })
      ])
    );
    const expandedRecent = await engine.expandMemoryNode(
      compacted.rollupNodeId!,
      { userId: alice.id },
      { recentDays: 30 }
    );
    expect(
      expandedRecent.sourceItems.some((item) =>
        item.text?.includes("Recent temporal evidence")
      )
    ).toBe(true);
    expect(
      expandedRecent.sourceItems.some((item) =>
        item.text?.includes("Old-only temporal evidence")
      )
    ).toBe(false);
    expect(
      expandedRecent.sources.some((source) =>
        source.content.includes("Old-only temporal evidence")
      )
    ).toBe(false);

    mockEmbeddingQuery();
    const boundedSearch = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "temporal evidence",
      scope: "personal",
      sourceAfter: new Date(
        Date.now() - 30 * 24 * 60 * 60 * 1000
      ).toISOString(),
      limit: 1
    });
    expect(boundedSearch.results[0]?.retrievalStage).toBe("rollup_search");
    expect(
      boundedSearch.metadata.stages?.find(
        (stage) => stage.name === "raw_fallback_search"
      )
    ).toMatchObject({ ran: true, used: false, selectedCount: 0 });

    mockEmbeddingQuery();
    const unboundedSearch = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "temporal evidence",
      scope: "personal",
      limit: 10
    });
    expect(unboundedSearch.results.map((result) => result.nodeId)).toContain(
      oldLeafId
    );
    expect(unboundedSearch.metadata.temporalFilter).toBeUndefined();
  });

  it("requires the same node source to satisfy project and temporal filters", async () => {
    const alice = await repo.createUser({
      email: `alice-project-boundary-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const projectA = `workspace-project-a-${randomUUID()}`;
    const projectB = `workspace-project-b-${randomUUID()}`;

    const oldProjectA = await captureUserEvent(engine, alice.id, {
      workspaceId: projectA,
      content: "Boundary correlation project A old only.",
      metadata: { project: "a", age: "old" }
    });
    const recentProjectB = await captureUserEvent(engine, alice.id, {
      workspaceId: projectB,
      content: "Boundary correlation project B recent only.",
      metadata: { project: "b", age: "recent" }
    });
    const recentProjectA = await captureUserEvent(engine, alice.id, {
      workspaceId: projectA,
      content: "Boundary correlation project A recent valid.",
      metadata: { project: "a", age: "recent" }
    });

    await pool.query(
      "update memory_events set captured_at = now() - interval '45 days', created_at = now() where id = $1",
      [oldProjectA.id]
    );
    await pool.query(
      "update memory_events set captured_at = now() - interval '2 days', created_at = now() where id = any($1::uuid[])",
      [[recentProjectB.id, recentProjectA.id]]
    );

    const mixedNode = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText:
          "Mixed project boundary node: project A old plus project B recent.",
        captureMethod: "mcp",
        sourceRuntime: "codex",
        sourceHash: `mixed-project-boundary-${randomUUID()}`
      }
    );
    const validNode = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText: "Valid project boundary node: project A recent valid.",
        captureMethod: "mcp",
        sourceRuntime: "codex",
        sourceHash: `valid-project-boundary-${randomUUID()}`
      }
    );
    await pool.query(
      `
        insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
        values ($1, $2, 0), ($1, $3, 1), ($4, $5, 0)
      `,
      [
        mixedNode.id,
        oldProjectA.id,
        recentProjectB.id,
        validNode.id,
        recentProjectA.id
      ]
    );

    await embedPendingSources();
    mockEmbeddingQuery();
    const search = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "boundary correlation project",
      scope: "personal",
      searchDomain: "project",
      workspaceId: projectA,
      recentDays: 30,
      limit: 10
    });

    expect(search.results.map((result) => result.nodeId)).toContain(
      validNode.id
    );
    expect(search.results.map((result) => result.nodeId)).not.toContain(
      mixedNode.id
    );

    const expanded = await engine.expandMemoryNode(
      mixedNode.id,
      { userId: alice.id },
      { searchDomain: "project", workspaceId: projectA, recentDays: 30 }
    );
    expect(expanded.sources).toHaveLength(0);
    expect(
      expanded.sourceItems.some((item) =>
        item.text?.includes("Boundary correlation")
      )
    ).toBe(false);
  });

  it("requires the same node source to satisfy session and temporal filters", async () => {
    const alice = await repo.createUser({
      email: `alice-session-boundary-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const workspaceId = `workspace-session-boundary-${randomUUID()}`;
    const sessionA = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `session-a-${randomUUID()}`,
        idempotencyKey: `session-a-${randomUUID()}`
      }
    );
    const sessionB = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `session-b-${randomUUID()}`,
        idempotencyKey: `session-b-${randomUUID()}`
      }
    );

    const oldSessionA = await captureUserEvent(engine, alice.id, {
      workspaceId,
      sessionId: sessionA.id,
      content: "Boundary correlation session A old only.",
      metadata: { session: "a", age: "old" }
    });
    const recentSessionB = await captureUserEvent(engine, alice.id, {
      workspaceId,
      sessionId: sessionB.id,
      content: "Boundary correlation session B recent only.",
      metadata: { session: "b", age: "recent" }
    });
    const recentSessionA = await captureUserEvent(engine, alice.id, {
      workspaceId,
      sessionId: sessionA.id,
      content: "Boundary correlation session A recent valid.",
      metadata: { session: "a", age: "recent" }
    });

    await pool.query(
      "update memory_events set captured_at = now() - interval '45 days', created_at = now() where id = $1",
      [oldSessionA.id]
    );
    await pool.query(
      "update memory_events set captured_at = now() - interval '2 days', created_at = now() where id = any($1::uuid[])",
      [[recentSessionB.id, recentSessionA.id]]
    );

    const mixedNode = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText:
          "Mixed session boundary node: session A old plus session B recent.",
        captureMethod: "mcp",
        sourceRuntime: "codex",
        sourceHash: `mixed-session-boundary-${randomUUID()}`
      }
    );
    const validNode = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText: "Valid session boundary node: session A recent valid.",
        captureMethod: "mcp",
        sourceRuntime: "codex",
        sourceHash: `valid-session-boundary-${randomUUID()}`
      }
    );
    await pool.query(
      `
        insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
        values ($1, $2, 0), ($1, $3, 1), ($4, $5, 0)
      `,
      [
        mixedNode.id,
        oldSessionA.id,
        recentSessionB.id,
        validNode.id,
        recentSessionA.id
      ]
    );

    await embedPendingSources();
    mockEmbeddingQuery();
    const search = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "boundary correlation session",
      scope: "personal",
      searchDomain: "session",
      sessionId: sessionA.id,
      recentDays: 30,
      limit: 10
    });

    expect(search.results.map((result) => result.nodeId)).toContain(
      validNode.id
    );
    expect(search.results.map((result) => result.nodeId)).not.toContain(
      mixedNode.id
    );

    const expanded = await engine.expandMemoryNode(
      mixedNode.id,
      { userId: alice.id },
      { searchDomain: "session", sessionId: sessionA.id, recentDays: 30 }
    );
    expect(expanded.sources).toHaveLength(0);
    expect(
      expanded.sourceItems.some((item) =>
        item.text?.includes("Boundary correlation")
      )
    ).toBe(false);
  });

  it("retrieves full lexical evidence from unembedded fresh memory only when lexical is requested", async () => {
    const alice = await repo.createUser({
      email: `alice-lexical-fresh-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const workspaceId = `workspace-lexical-fresh-${randomUUID()}`;
    const filler = Array.from(
      { length: 260 },
      (_, index) => `The quiet lamp story filler passage ${index}.`
    ).join(" ");
    const story = [
      filler,
      "Only at the end did the keeper of the lamp reveal her name: Seraphina."
    ].join(" ");
    const event = await captureUserEvent(engine, alice.id, {
      workspaceId,
      content: story,
      metadata: { kind: "long-story-tail-name" }
    });

    const embeddingFetch = mockEmbeddingQuery();
    const scan = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "Who was the keeper of the lamp named Seraphina?",
      scope: "personal",
      searchDomain: "project",
      workspaceId,
      retrievalStage: "score_scan",
      limit: 1
    });
    const lexicalStage = scan.metadata.stages?.find(
      (stage) => stage.name === "lexical_search"
    );
    expect(scan.results).toHaveLength(0);
    expect(lexicalStage).toBeUndefined();

    embeddingFetch.mockClear();
    const lexical = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "Seraphina",
      scope: "personal",
      searchDomain: "project",
      workspaceId,
      retrievalStage: "lexical_search",
      strictLimit: true,
      limit: 1
    });
    expect(lexical.results).toHaveLength(1);
    expect(lexical.results[0]?.sourceType).toBe("memory_event");
    expect(lexical.results[0]?.sourceId).toBe(event.id);
    expect(lexical.results[0]?.summaryText).toContain("Seraphina");
    expect(embeddingFetch).not.toHaveBeenCalled();

    await expect(
      engine.searchMemory({
        requesterContext: { userId: alice.id },
        query: "Seraphina",
        scope: "personal",
        searchDomain: "project",
        workspaceId,
        retrievalStage: "lexical_search",
        strictLimit: true,
        limit: 2
      })
    ).rejects.toThrow("above threshold");
  });

  it("excludes personal-deleted memory events from Personal Memory recall", async () => {
    const alice = await repo.createUser({
      email: `alice-personal-deleted-recall-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const workspaceId = `workspace-personal-deleted-${randomUUID()}`;
    const event = await captureUserEvent(engine, alice.id, {
      workspaceId,
      content: "The private launch codename is Violet Harbor."
    });

    await pool.query(
      "update memory_events set personal_deleted_at = now() where id = $1",
      [event.id]
    );

    const recall = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "Violet Harbor",
      scope: "personal",
      searchDomain: "project",
      workspaceId,
      retrievalStage: "lexical_search",
      limit: 5
    });

    expect(recall.results).toEqual([]);
  });

  it("ranks original lexical story evidence above later question and tool echoes", async () => {
    const alice = await repo.createUser({
      email: `alice-lexical-echo-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const workspaceId = `workspace-lexical-echo-${randomUUID()}`;
    const query =
      "What was the name of the keeper of the lamp in the story about the city by the sea?";
    const story = [
      "At dawn, the city woke without bells.",
      "The keeper of the lamp watched the sea and kept the city visible.",
      "The story ended by revealing the keeper's name.",
      "Her name was Mara."
    ].join(" ");
    const storyEvent = await captureUserEvent(engine, alice.id, {
      workspaceId,
      actor: "agent",
      content: story,
      metadata: { kind: "story-source" }
    });
    await captureUserEvent(engine, alice.id, {
      workspaceId,
      content: `This question failed before: "${query}"`,
      metadata: { kind: "question-echo" }
    });
    await captureUserEvent(engine, alice.id, {
      workspaceId,
      actor: "tool",
      content: `Tool output from diagnostics repeated the prompt: ${query}`,
      metadata: { kind: "tool-echo" }
    });

    const lexical = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query,
      scope: "personal",
      searchDomain: "project",
      workspaceId,
      retrievalStage: "lexical_search",
      strictLimit: true,
      limit: 3
    });

    expect(lexical.results[0]).toMatchObject({
      sourceType: "memory_event",
      sourceId: storyEvent.id,
      retrievalStage: "lexical_search"
    });
    expect(lexical.results[0]?.summaryText).toContain("Her name was Mara.");
  });

  it("filters lexical node evidence to the requested project boundary", async () => {
    const alice = await repo.createUser({
      email: `alice-lexical-boundary-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const inScopeWorkspaceId = `workspace-lexical-in-${randomUUID()}`;
    const outOfScopeWorkspaceId = `workspace-lexical-out-${randomUUID()}`;
    const inScopeEvent = await captureUserEvent(engine, alice.id, {
      workspaceId: inScopeWorkspaceId,
      content: "Project alpha visible banana context.",
      metadata: { kind: "in-scope-source" }
    });
    const outOfScopeEvent = await captureUserEvent(engine, alice.id, {
      workspaceId: outOfScopeWorkspaceId,
      content: "Project beta secret moonbase context.",
      metadata: { kind: "out-of-scope-source" }
    });
    const mixedNode = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText:
          "Mixed summary mentions visible banana and secret moonbase context.",
        bodyText:
          "Mixed body also mentions visible banana and secret moonbase context.",
        captureMethod: "mcp",
        sourceRuntime: "codex",
        sourceHash: `lexical-boundary-${randomUUID()}`
      }
    );
    await pool.query(
      `
        insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
        values ($1, $2, 0), ($1, $3, 1)
      `,
      [mixedNode.id, inScopeEvent.id, outOfScopeEvent.id]
    );

    const outOfScopeSearch = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "secret moonbase",
      scope: "personal",
      searchDomain: "project",
      workspaceId: inScopeWorkspaceId,
      retrievalStage: "lexical_search",
      limit: 1
    });
    expect(
      outOfScopeSearch.results.some(
        (result) => result.sourceId === mixedNode.id
      )
    ).toBe(false);
    expect(JSON.stringify(outOfScopeSearch.results)).not.toContain(
      "secret moonbase"
    );

    const inScopeSearch = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "visible banana",
      scope: "personal",
      searchDomain: "project",
      workspaceId: inScopeWorkspaceId,
      retrievalStage: "lexical_search",
      limit: 5
    });
    const nodeResult = inScopeSearch.results.find(
      (result) => result.sourceId === mixedNode.id
    );
    expect(nodeResult?.summaryText).toContain("visible banana");
    expect(nodeResult?.summaryText).not.toContain("secret moonbase");
  });

  it("can inspect fresh embedded memory events before LCM nodes exist", async () => {
    const alice = await repo.createUser({
      email: `alice-fresh-event-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const workspaceId = `workspace-fresh-event-${randomUUID()}`;
    const event = await captureUserEvent(engine, alice.id, {
      workspaceId,
      content:
        "Fresh unsummarized story memory says the lamp keeper is Seraphina.",
      metadata: { kind: "fresh-unsummarized" }
    });
    await embedPendingSources();
    mockEmbeddingQuery();

    const search = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "lamp keeper Seraphina",
      scope: "personal",
      searchDomain: "project",
      workspaceId,
      retrievalStage: "fresh_pending_search",
      strictLimit: true,
      limit: 1
    });

    expect(search.results).toHaveLength(1);
    expect(search.results[0]).toMatchObject({
      sourceType: "memory_event",
      sourceId: event.id,
      retrievalStage: "fresh_pending_search"
    });
    expect(search.results[0]?.summaryText).toContain("Seraphina");
  });

  it("keeps generic raw and fresh fallback evidence focused on non-tool memory", async () => {
    const alice = await repo.createUser({
      email: `alice-non-tool-fallback-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const workspaceId = `workspace-non-tool-fallback-${randomUUID()}`;
    const agentEvent = await captureUserEvent(engine, alice.id, {
      workspaceId,
      actor: "agent",
      content:
        "Fresh unsummarized story memory says the lamp keeper is Seraphina.",
      metadata: { kind: "story-source" }
    });
    await captureUserEvent(engine, alice.id, {
      workspaceId,
      actor: "tool",
      content:
        "Tool output repeated diagnostics saying the lamp keeper is Seraphina.",
      metadata: { kind: "tool-diagnostic-echo" }
    });
    await embedPendingSources();
    mockEmbeddingQuery();

    for (const stage of [
      "fresh_pending_search",
      "raw_fallback_search"
    ] as const) {
      const search = await engine.searchMemory({
        requesterContext: { userId: alice.id },
        query: "lamp keeper Seraphina",
        scope: "personal",
        searchDomain: "project",
        workspaceId,
        retrievalStage: stage,
        strictLimit: true,
        limit: 1
      });

      expect(search.results).toHaveLength(1);
      expect(search.results[0]).toMatchObject({
        sourceType: "memory_event",
        sourceId: agentEvent.id,
        retrievalStage: stage
      });
      expect(search.results[0]?.summaryText).toContain("story memory");
    }
  });

  it("caps rollup evidence so scoped leaves are not crowded out", async () => {
    const alice = await repo.createUser({
      email: `alice-rollup-cap-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);

    for (let index = 1; index <= 12; index += 1) {
      const event = await captureUserEvent(engine, alice.id, {
        workspaceId: "workspace-rollup-cap",
        content: `Rollup cap source ${index}: scoped leaf detail ${index}.`,
        metadata: { index }
      });
      const leaf = await repo.createMemoryNode(
        { userId: alice.id },
        {
          visibility: "personal",
          summaryText: `Scoped leaf detail ${index}.`,
          captureMethod: "mcp",
          sourceRuntime: "codex",
          sourceHash: `leaf-rollup-cap-${index}-${randomUUID()}`
        }
      );
      const rollup = await repo.createMemoryNode(
        { userId: alice.id },
        {
          visibility: "personal",
          summaryText: `Broad rollup route ${index}.`,
          captureMethod: "mcp",
          sourceRuntime: "codex",
          sourceHash: `rollup-cap-${index}-${randomUUID()}`
        }
      );
      await pool.query(
        "update memory_nodes set kind = 'rollup', depth = 1 where id = $1",
        [rollup.id]
      );
      await pool.query(
        `
          insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
          values ($1, $2, 0), ($3, $2, 0)
        `,
        [leaf.id, event.id, rollup.id]
      );
      await pool.query(
        `
          insert into memory_node_children (parent_memory_node_id, child_memory_node_id, child_order)
          values ($1, $2, 0)
        `,
        [rollup.id, leaf.id]
      );
    }

    await embedPendingSources();
    mockEmbeddingQuery();

    const search = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "rollup cap scoped leaf detail",
      scope: "personal",
      limit: 10
    });

    const rollupResults = search.results.filter(
      (result) => result.retrievalStage === "rollup_search"
    );
    const scopedLeafResults = search.results.filter(
      (result) => result.retrievalStage === "scoped_leaf_search"
    );
    expect(rollupResults.length).toBeLessThanOrEqual(5);
    expect(scopedLeafResults.length).toBeGreaterThan(0);
    expect(search.metadata.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "rollup_search",
          candidateCount: 12
        }),
        expect.objectContaining({
          name: "scoped_leaf_search",
          used: true
        })
      ])
    );

    const explicitRollupSearch = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "rollup cap scoped leaf detail",
      scope: "personal",
      retrievalStage: "rollup_search",
      strictLimit: true,
      limit: 10
    });
    expect(explicitRollupSearch.results).toHaveLength(10);
    expect(
      explicitRollupSearch.results.every(
        (result) => result.retrievalStage === "rollup_search"
      )
    ).toBe(true);
  });

  it("does not mix sessions when creating LCM leaves or rollups", async () => {
    const alice = await repo.createUser({
      email: `alice-session-lcm-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const firstWorkspaceId = randomUUID();
    const secondWorkspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values
          ($1, $3, 'personal', 'Session A'),
          ($2, $3, 'personal', 'Session B')
      `,
      [firstWorkspaceId, secondWorkspaceId, alice.id]
    );
    const firstSession = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId: firstWorkspaceId,
        externalSessionId: `session-a-${randomUUID()}`,
        idempotencyKey: `session-a-${randomUUID()}`
      }
    );
    const secondSession = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId: secondWorkspaceId,
        externalSessionId: `session-b-${randomUUID()}`,
        idempotencyKey: `session-b-${randomUUID()}`
      }
    );

    for (let index = 1; index <= 20; index += 1) {
      const session = index % 2 === 0 ? secondSession : firstSession;
      await captureUserEvent(engine, alice.id, {
        workspaceId:
          session.id === firstSession.id ? firstWorkspaceId : secondWorkspaceId,
        sessionId: session.id,
        content: `Session ${session.id} source ${index}`,
        metadata: { index }
      });
    }

    const compacted = await engine.scheduleCompaction({
      requesterContext: { userId: alice.id },
      visibility: "personal"
    });

    expect(compacted.leafNodeIds).toHaveLength(4);
    expect(compacted.rollupNodeId).not.toBeNull();

    const nodeSessions = await pool.query<{
      memory_node_id: string;
      session_count: string;
      sessions: string;
    }>(
      `
        select
          mns.memory_node_id,
          count(distinct me.session_id)::text as session_count,
          string_agg(distinct me.session_id::text, ',') as sessions
        from memory_node_sources mns
        join memory_events me on me.id = mns.memory_event_id
        where mns.memory_node_id = any($1::uuid[])
        group by mns.memory_node_id
        order by mns.memory_node_id
      `,
      [[...compacted.leafNodeIds, compacted.rollupNodeId!]]
    );

    expect(nodeSessions.rows).toHaveLength(5);
    expect(
      nodeSessions.rows.every((row) => Number(row.session_count) === 1)
    ).toBe(true);
    expect(new Set(nodeSessions.rows.map((row) => row.sessions)).size).toBe(2);
  });

  it("ignores only explicit includeInLcm false metadata during LCM compaction", async () => {
    const alice = await repo.createUser({
      email: `alice-lcm-include-metadata-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'LCM Metadata Include Project')
      `,
      [workspaceId, alice.id]
    );

    for (let index = 1; index <= 6; index += 1) {
      await captureUserEvent(engine, alice.id, {
        workspaceId,
        content: `LCM include metadata source ${index}`,
        metadata: {
          includeInLcm:
            index === 1 ? false : index === 2 ? { malformed: true } : true
        }
      });
    }

    const compacted = await repo.createLcmNodes(
      { userId: alice.id },
      { visibility: "personal" }
    );
    const leafSources = await pool.query<{ content: string }>(
      `
        select me.payload ->> 'content' as content
        from memory_node_sources mns
        join memory_events me on me.id = mns.memory_event_id
        where mns.memory_node_id = $1
        order by mns.source_order asc
      `,
      [compacted.leafNodeIds[0]]
    );

    expect(compacted.leafNodeIds).toHaveLength(1);
    expect(leafSources.rows.map((row) => row.content)).toEqual([
      "LCM include metadata source 2",
      "LCM include metadata source 3",
      "LCM include metadata source 4",
      "LCM include metadata source 5",
      "LCM include metadata source 6"
    ]);
  });

  it("keeps LCM graph hydration working with encrypted Memory Event and Node fields present", async () => {
    const encryptedRepo = createEncryptedPayloadRepository(pool);
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 10).toString("base64")
    );
    const encryptedMemoryRepo = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const alice = await repo.createUser({
      email: `alice-lcm-encrypted-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Encrypted LCM Project')
      `,
      [workspaceId, alice.id]
    );

    for (let index = 1; index <= 5; index += 1) {
      await captureUserEvent(engine, alice.id, {
        workspaceId,
        content: `Encrypted LCM source ${index}: retain falcon database shard detail.`
      });
    }

    const compacted = await repo.createLcmNodes(
      { userId: alice.id },
      { visibility: "personal" }
    );
    expect(compacted.leafNodeIds).toHaveLength(1);
    const leafNodeId = compacted.leafNodeIds[0]!;

    for (const source of [
      { sourceTable: "memory_events", sourceColumn: "payload", totalRows: 5 },
      {
        sourceTable: "memory_nodes",
        sourceColumn: "summary_text",
        totalRows: 1
      },
      {
        sourceTable: "memory_nodes",
        sourceColumn: "source_items_json",
        totalRows: 1
      }
    ] as const) {
      const run = await encryptedRepo.createEncryptedFieldBackfillRun(
        { userId: alice.id },
        {
          sourceTable: source.sourceTable,
          sourceColumn: source.sourceColumn,
          providerMode: "local_test_key",
          totalRows: source.totalRows
        }
      );
      await expect(
        encryptedRepo.backfillEncryptedFieldBatch(
          { userId: alice.id },
          provider,
          {
            runId: run.id,
            sourceTable: source.sourceTable,
            sourceColumn: source.sourceColumn,
            batchSize: 20
          }
        )
      ).resolves.toMatchObject({
        failedRows: 0,
        done: true
      });
    }

    const encryptedCount = await pool.query<{ count: number }>(
      `
        select count(*)::int as count
        from encrypted_field_payloads
        where owner_user_id = $1
          and invalidated_at is null
      `,
      [alice.id]
    );
    expect(encryptedCount.rows[0]?.count).toBe(7);

    const graphNode = await encryptedMemoryRepo.getLcmGraphNode(
      { userId: alice.id },
      leafNodeId
    );
    expect(JSON.stringify(graphNode)).toContain("falcon database shard detail");

    const lexical = await encryptedMemoryRepo.searchMemoryNodes(
      { userId: alice.id },
      {
        query: "falcon database shard",
        scope: "personal",
        searchDomain: "project",
        workspaceId,
        retrievalStage: "lexical_search"
      }
    );
    expect(JSON.stringify(lexical.results)).not.toContain(
      "falcon database shard detail"
    );

    const decryptedSourceItems =
      await encryptedRepo.decryptAuthorizedEncryptedField(
        { userId: alice.id },
        provider,
        {
          sourceTable: "memory_nodes",
          sourceId: leafNodeId,
          sourceColumn: "source_items_json"
        }
      );
    const decryptedItems = decryptedSourceItems?.plaintext;
    expect(Array.isArray(decryptedItems)).toBe(true);
    expect(
      (decryptedItems as Array<{ text?: unknown }>).some(
        (item) =>
          typeof item.text === "string" &&
          item.text.includes("falcon database shard detail")
      )
    ).toBe(true);
  });

  it("persists personal memory questions as shells and hydrated detail", async () => {
    const alice = await repo.createUser({
      email: `alice-question-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-question-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Question Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `question-session-${randomUUID()}`,
        idempotencyKey: `question-session-${randomUUID()}`
      }
    );
    const created = await repo.createMemoryQuestion(
      { userId: alice.id },
      {
        query: "What did we decide about memory questions?",
        searchDomain: "session",
        workspaceId,
        projectName: "Question Project",
        projectPath: "/tmp/question-project",
        sessionId: session.id,
        threadId: "thread-1",
        threadName: "Question Thread",
        localMemoryWorkerConfig: {
          provider: "codex",
          model: "gpt-5.4",
          reasoningEffort: "medium",
          timeoutMs: 150000,
          maxAttempts: 4
        }
      }
    );

    expect(created.status).toBe("pending");
    expect(created.origin).toBe("explorer");
    expect(created.answerMarkdown).toBeNull();
    expect(created.processingLeaseUntil).toBeNull();

    const mismatchedOriginClaim = await repo.claimPendingMemoryQuestions(
      { userId: alice.id },
      {
        questionId: created.id,
        origin: "mcp_memory_answer",
        limit: 1,
        leaseSeconds: 120
      }
    );
    const claimed = await repo.claimPendingMemoryQuestions(
      { userId: alice.id },
      {
        questionId: created.id,
        origin: "explorer",
        limit: 1,
        leaseSeconds: 120
      }
    );
    const claimedAgain = await repo.claimPendingMemoryQuestions(
      { userId: alice.id },
      { questionId: created.id, limit: 1, leaseSeconds: 120 }
    );
    expect(mismatchedOriginClaim).toEqual([]);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: created.id,
      status: "pending",
      attemptCount: 1,
      localMemoryWorkerConfig: {
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "medium",
        timeoutMs: 150000,
        maxAttempts: 4
      }
    });
    expect(claimed[0]?.processingStartedAt).toBeTruthy();
    expect(claimed[0]?.processingLeaseUntil).toBeTruthy();
    expect(claimedAgain).toEqual([]);
    await pool.query(
      `
        update memory_questions
        set processing_lease_until = now() - interval '1 second'
        where id = $1
      `,
      [created.id]
    );
    const reclaimed = await repo.claimPendingMemoryQuestions(
      { userId: alice.id },
      { questionId: created.id, limit: 1, leaseSeconds: 120 }
    );
    const staleCompletion = await repo.updateMemoryQuestion(
      { userId: alice.id },
      created.id,
      {
        status: "answered",
        attemptCount: claimed[0]!.attemptCount,
        answerMarkdown: "This stale worker should not win."
      }
    );
    expect(reclaimed[0]?.attemptCount).toBe(2);
    expect(staleCompletion).toBeNull();

    const retryCreated = await repo.createMemoryQuestion(
      { userId: alice.id },
      {
        origin: "mcp_memory_answer",
        query: "Can a failed local answer retry later?",
        searchDomain: "global"
      }
    );
    const retryClaimed = await repo.claimPendingMemoryQuestions(
      { userId: alice.id },
      { questionId: retryCreated.id, limit: 1, leaseSeconds: 120 }
    );
    const retryReleased = await repo.updateMemoryQuestion(
      { userId: alice.id },
      retryCreated.id,
      {
        status: "pending",
        attemptCount: retryClaimed[0]!.attemptCount,
        lastErrorMessage: "Codex unavailable",
        response: { markdown: "raw fallback must not become the answer" },
        retrieval: { mode: "test" },
        localMemoryWorker: {
          usedFallback: true,
          skippedReason: "codex_failed"
        }
      }
    );
    const retryReclaimed = await repo.claimPendingMemoryQuestions(
      { userId: alice.id },
      { questionId: retryCreated.id, limit: 1, leaseSeconds: 120 }
    );

    expect(retryReleased).toMatchObject({
      id: retryCreated.id,
      origin: "mcp_memory_answer",
      status: "pending",
      answerMarkdown: null,
      errorMessage: null,
      processingStartedAt: null,
      processingLeaseUntil: null,
      lastErrorMessage: "Codex unavailable"
    });
    expect(retryReleased?.answeredAt).toBeNull();
    expect(retryReclaimed).toHaveLength(1);
    expect(retryReclaimed[0]?.attemptCount).toBe(
      retryClaimed[0]!.attemptCount + 1
    );
    expect(retryReclaimed[0]?.lastErrorMessage).toBeNull();

    const finalCreated = await repo.createFinalMemoryQuestion(
      { userId: alice.id },
      {
        origin: "mcp_memory_answer",
        query: "What did the MCP memory answer return?",
        searchDomain: "global",
        status: "answered",
        answerMarkdown: "MCP memory answer completed.",
        response: { markdown: "MCP memory answer completed." },
        evidence: [{ id: "mcp-source-1" }],
        retrieval: { mode: "app_server_dynamic_tools" },
        localMemoryWorker: { usedFallback: false }
      }
    );
    const finalClaimed = await repo.claimPendingMemoryQuestions(
      { userId: alice.id },
      {
        questionId: finalCreated.id,
        origin: "mcp_memory_answer",
        limit: 1,
        leaseSeconds: 120
      }
    );

    expect(finalCreated).toMatchObject({
      origin: "mcp_memory_answer",
      status: "answered",
      answerMarkdown: "MCP memory answer completed.",
      processingStartedAt: null,
      processingLeaseUntil: null,
      evidenceCount: 1
    });
    expect(finalCreated.answeredAt).toBeTruthy();
    expect(finalClaimed).toEqual([]);

    const updated = await repo.updateMemoryQuestion(
      { userId: alice.id },
      created.id,
      {
        status: "answered",
        attemptCount: reclaimed[0]!.attemptCount,
        answerMarkdown: "Memory questions are persisted separately.",
        evidence: [{ id: "source-1" }],
        citations: [{ id: "citation-1" }],
        retrieval: { searchDomain: "session" },
        localMemoryWorker: { status: "ok" },
        response: { markdown: "Memory questions are persisted separately." }
      }
    );
    const shells = await repo.listMemoryQuestions(
      { userId: alice.id },
      { searchDomain: "session", sessionId: session.id }
    );
    const detail = await repo.getMemoryQuestion(
      { userId: alice.id },
      created.id
    );
    const hidden = await repo.getMemoryQuestion({ userId: bob.id }, created.id);
    expect(updated).toMatchObject({
      id: created.id,
      status: "answered",
      localMemoryWorkerConfig: {
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "medium",
        timeoutMs: 150000,
        maxAttempts: 4
      }
    });
    expect(detail).toMatchObject({
      id: created.id,
      origin: "explorer",
      answerMarkdown: "Memory questions are persisted separately.",
      localMemoryWorkerConfig: {
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "medium",
        timeoutMs: 150000,
        maxAttempts: 4
      },
      evidenceCount: 1
    });
    const slowCreated = await repo.createMemoryQuestion(
      { userId: alice.id },
      {
        query: "Can a slow local answer still complete?",
        searchDomain: "global"
      }
    );
    const slowClaimed = await repo.claimPendingMemoryQuestions(
      { userId: alice.id },
      { questionId: slowCreated.id, limit: 1, leaseSeconds: 120 }
    );
    await pool.query(
      `
        update memory_questions
        set processing_lease_until = now() - interval '1 second'
        where id = $1
      `,
      [slowCreated.id]
    );
    const slowCompletion = await repo.updateMemoryQuestion(
      { userId: alice.id },
      slowCreated.id,
      {
        status: "answered",
        attemptCount: slowClaimed[0]!.attemptCount,
        answerMarkdown: "Slow answers complete if no newer attempt exists."
      }
    );

    expect(updated?.status).toBe("answered");
    expect(updated?.processingLeaseUntil).toBeNull();
    expect(updated?.lastErrorMessage).toBeNull();
    expect(shells).toHaveLength(1);
    expect(shells[0]).toMatchObject({
      id: created.id,
      answerPreview: "Memory questions are persisted separately.",
      evidenceCount: 1,
      sessionId: session.id
    });
    expect(detail?.evidence).toEqual([{ id: "source-1" }]);
    expect(hidden).toBeNull();
    expect(slowCompletion?.status).toBe("answered");
    expect(slowCompletion?.answerMarkdown).toBe(
      "Slow answers complete if no newer attempt exists."
    );
  });

  it("encrypts paid managed-cloud Memory Question payloads on live writes", async () => {
    await withPaidManagedCloudProfile(async () => {
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 34).toString("base64")
      );
      const encryptedQuestionRepo = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const encryptedPayloadRepo = createEncryptedPayloadRepository(pool);
      const alice = await repo.createUser({
        email: `alice-question-live-encrypted-${randomUUID()}@example.com`
      });
      const bob = await repo.createUser({
        email: `bob-question-live-encrypted-${randomUUID()}@example.com`
      });
      const created = await encryptedQuestionRepo.createMemoryQuestion(
        { userId: alice.id },
        {
          origin: "mcp_memory_answer",
          query: "Where did the obsidian retrieval plan land?",
          searchDomain: "global",
          localMemoryWorkerConfig: {
            provider: "codex",
            model: "gpt-5.4-mini",
            prompt: "obsidian worker config must stay encrypted"
          }
        }
      );

      expect(created).toMatchObject({
        query: "Where did the obsidian retrieval plan land?",
        localMemoryWorkerConfig: {
          provider: "codex",
          model: "gpt-5.4-mini",
          prompt: "obsidian worker config must stay encrypted"
        }
      });

      const claimed = await encryptedQuestionRepo.claimPendingMemoryQuestions(
        { userId: alice.id },
        { questionId: created.id, limit: 1, leaseSeconds: 120 }
      );
      expect(claimed[0]).toMatchObject({
        id: created.id,
        query: "Where did the obsidian retrieval plan land?",
        localMemoryWorkerConfig: {
          prompt: "obsidian worker config must stay encrypted"
        }
      });

      const answered = await encryptedQuestionRepo.updateMemoryQuestion(
        { userId: alice.id },
        created.id,
        {
          status: "answered",
          attemptCount: claimed[0]!.attemptCount,
          answerMarkdown:
            "The obsidian retrieval plan landed in the Team launch doc.",
          evidence: [
            {
              sourceId: "obsidian-evidence-1",
              text: "First obsidian evidence snippet"
            },
            {
              sourceId: "obsidian-evidence-2",
              text: "Second obsidian evidence snippet"
            }
          ],
          citations: [
            {
              sourceId: "obsidian-evidence-1",
              label: "Obsidian source"
            }
          ],
          retrieval: {
            query: "obsidian retrieval plan",
            stages: ["vector_search", "rerank"]
          },
          localMemoryWorker: {
            provider: "codex",
            model: "gpt-5.4-mini",
            summary: "obsidian local worker details"
          },
          response: {
            markdown:
              "The obsidian retrieval plan landed in the Team launch doc."
          }
        }
      );

      expect(answered).toMatchObject({
        id: created.id,
        status: "answered",
        query: "Where did the obsidian retrieval plan land?",
        answerMarkdown:
          "The obsidian retrieval plan landed in the Team launch doc.",
        evidenceCount: 2,
        evidence: [
          {
            sourceId: "obsidian-evidence-1",
            text: "First obsidian evidence snippet"
          },
          {
            sourceId: "obsidian-evidence-2",
            text: "Second obsidian evidence snippet"
          }
        ]
      });

      const rawQuestion = await pool.query<{
        query: string;
        answer_markdown: string | null;
        evidence: unknown[] | null;
        local_memory_worker_config: Record<string, unknown> | null;
        raw_payload: string;
      }>(
        `
          select
            query,
            answer_markdown,
            evidence,
            local_memory_worker_config,
            row_to_json(memory_questions)::text as raw_payload
          from memory_questions
          where id = $1
        `,
        [created.id]
      );
      expect(rawQuestion.rows[0]).toMatchObject({
        query: "[koed encrypted memory question]",
        answer_markdown: "[koed encrypted memory question]"
      });
      expect(rawQuestion.rows[0]?.local_memory_worker_config).toMatchObject({
        contentEncrypted: true,
        encryptedSourceTable: "memory_questions"
      });
      expect(rawQuestion.rows[0]?.evidence).toEqual([
        {
          contentEncrypted: true,
          encryptedSourceTable: "memory_questions"
        }
      ]);
      expect(rawQuestion.rows[0]?.raw_payload).not.toContain("obsidian");
      expect(rawQuestion.rows[0]?.raw_payload).not.toContain("Team launch doc");

      const encryptedColumns = await pool.query<{ source_column: string }>(
        `
          select source_column
          from encrypted_field_payloads
          where owner_user_id = $1
            and source_table = 'memory_questions'
            and source_id = $2
            and invalidated_at is null
          order by source_column
        `,
        [alice.id, created.id]
      );
      expect(encryptedColumns.rows.map((row) => row.source_column)).toEqual([
        "answer_markdown",
        "citations",
        "evidence",
        "local_memory_worker",
        "local_memory_worker_config",
        "query",
        "response",
        "retrieval"
      ]);

      const hidden = await encryptedPayloadRepo.decryptAuthorizedEncryptedField(
        { userId: bob.id },
        provider,
        {
          sourceTable: "memory_questions",
          sourceId: created.id,
          sourceColumn: "query"
        }
      );
      expect(hidden).toBeNull();

      const detail = await encryptedQuestionRepo.getMemoryQuestion(
        { userId: alice.id },
        created.id
      );
      expect(detail).toMatchObject({
        id: created.id,
        answerMarkdown:
          "The obsidian retrieval plan landed in the Team launch doc.",
        evidenceCount: 2,
        retrieval: {
          query: "obsidian retrieval plan"
        },
        localMemoryWorker: {
          summary: "obsidian local worker details"
        }
      });

      const shells = await encryptedQuestionRepo.listMemoryQuestions(
        { userId: alice.id },
        { query: "Team launch doc", limit: 10 }
      );
      expect(shells).toHaveLength(1);
      expect(shells[0]).toMatchObject({
        id: created.id,
        query: "Where did the obsidian retrieval plan land?",
        answerPreview:
          "The obsidian retrieval plan landed in the Team launch doc.",
        evidenceCount: 2
      });
    });
  });

  it("searches encrypted Memory Questions past the first raw batch", async () => {
    await withPaidManagedCloudProfile(async () => {
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 38).toString("base64")
      );
      const encryptedQuestionRepo = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: provider,
        encryptedMemoryQuestionSearchBatchSize: 5
      });
      const alice = await repo.createUser({
        email: `alice-question-deep-search-${randomUUID()}@example.com`
      });
      const target = await encryptedQuestionRepo.createMemoryQuestion(
        { userId: alice.id },
        {
          origin: "mcp_memory_answer",
          query: "Where is the deep encrypted launch retrieval marker?",
          searchDomain: "global"
        }
      );

      await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          encryptedQuestionRepo.createMemoryQuestion(
            { userId: alice.id },
            {
              origin: "mcp_memory_answer",
              query: `Encrypted filler memory question ${index}`,
              searchDomain: "global"
            }
          )
        )
      );
      await pool.query(
        "update memory_questions set created_at = now() - interval '2 days' where id = $1",
        [target.id]
      );

      const shells = await encryptedQuestionRepo.listMemoryQuestions(
        { userId: alice.id },
        { query: "deep encrypted launch", limit: 10 }
      );

      expect(shells).toHaveLength(1);
      expect(shells[0]).toMatchObject({
        id: target.id,
        query: "Where is the deep encrypted launch retrieval marker?"
      });
    });
  });

  it("encrypts paid managed-cloud Memory Question retry and error payloads", async () => {
    await withPaidManagedCloudProfile(async () => {
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 35).toString("base64")
      );
      const encryptedQuestionRepo = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const alice = await repo.createUser({
        email: `alice-question-error-encrypted-${randomUUID()}@example.com`
      });
      const pending = await encryptedQuestionRepo.createMemoryQuestion(
        { userId: alice.id },
        {
          query: "Can garnet memory worker failures be retried?",
          searchDomain: "global"
        }
      );
      const claimed = await encryptedQuestionRepo.claimPendingMemoryQuestions(
        { userId: alice.id },
        { questionId: pending.id, limit: 1, leaseSeconds: 120 }
      );
      const released = await encryptedQuestionRepo.updateMemoryQuestion(
        { userId: alice.id },
        pending.id,
        {
          status: "pending",
          attemptCount: claimed[0]!.attemptCount,
          lastErrorMessage: "garnet worker timed out",
          retrieval: { query: "garnet retry retrieval" },
          response: { markdown: "garnet retry raw response" },
          localMemoryWorker: { error: "garnet worker timed out" }
        }
      );

      expect(released).toMatchObject({
        status: "pending",
        lastErrorMessage: "garnet worker timed out",
        retrieval: { query: "garnet retry retrieval" },
        response: { markdown: "garnet retry raw response" },
        localMemoryWorker: { error: "garnet worker timed out" }
      });

      const finalError = await encryptedQuestionRepo.createFinalMemoryQuestion(
        { userId: alice.id },
        {
          origin: "mcp_memory_answer",
          query: "Why did the garnet memory answer fail?",
          searchDomain: "global",
          status: "error",
          errorMessage: "garnet memory answer failed permanently",
          response: { error: "garnet permanent failure" },
          retrieval: { query: "garnet error retrieval" },
          localMemoryWorker: { error: "garnet permanent failure" }
        }
      );

      expect(finalError).toMatchObject({
        status: "error",
        query: "Why did the garnet memory answer fail?",
        errorMessage: "garnet memory answer failed permanently",
        lastErrorMessage: "garnet memory answer failed permanently",
        response: { error: "garnet permanent failure" },
        retrieval: { query: "garnet error retrieval" }
      });

      const rawQuestions = await pool.query<{ raw_payload: string }>(
        `
          select string_agg(row_to_json(memory_questions)::text, E'\n') as raw_payload
          from memory_questions
          where owner_user_id = $1
        `,
        [alice.id]
      );
      expect(rawQuestions.rows[0]?.raw_payload).not.toContain("garnet");

      const encryptedColumns = await pool.query<{
        source_id: string;
        source_column: string;
      }>(
        `
          select source_id::text, source_column
          from encrypted_field_payloads
          where owner_user_id = $1
            and source_table = 'memory_questions'
            and invalidated_at is null
          order by source_id::text, source_column
        `,
        [alice.id]
      );
      const retryColumns = encryptedColumns.rows
        .filter((row) => row.source_id === pending.id)
        .map((row) => row.source_column);
      const errorColumns = encryptedColumns.rows
        .filter((row) => row.source_id === finalError.id)
        .map((row) => row.source_column);
      expect(retryColumns).toEqual([
        "last_error_message",
        "local_memory_worker",
        "query",
        "response",
        "retrieval"
      ]);
      expect(errorColumns).toEqual([
        "error_message",
        "last_error_message",
        "local_memory_worker",
        "query",
        "response",
        "retrieval"
      ]);
    });
  });

  it("backfills Memory Question answers, evidence, citations, and retrieval as encrypted fields", async () => {
    const encryptedRepo = createEncryptedPayloadRepository(pool);
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 11).toString("base64")
    );
    const encryptedQuestionRepo = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const alice = await repo.createUser({
      email: `alice-question-encrypted-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-question-encrypted-${randomUUID()}@example.com`
    });
    const question = await repo.createFinalMemoryQuestion(
      { userId: alice.id },
      {
        origin: "mcp_memory_answer",
        query: "What evidence did encrypted questions retain?",
        searchDomain: "global",
        status: "answered",
        answerMarkdown: "The encrypted question retained source evidence.",
        response: {
          markdown: "The encrypted question retained source evidence."
        },
        evidence: [
          {
            sourceId: "evidence-1",
            text: "Evidence quote about the cobalt cache key."
          }
        ],
        citations: [
          {
            sourceId: "evidence-1",
            label: "Cobalt cache source"
          }
        ],
        retrieval: {
          stages: ["lexical_search"],
          query: "cobalt cache key"
        },
        localMemoryWorker: {
          usedFallback: false,
          model: "gpt-5.4-mini"
        }
      }
    );

    for (const sourceColumn of [
      "answer_markdown",
      "evidence",
      "citations",
      "retrieval",
      "local_memory_worker",
      "response"
    ]) {
      const run = await encryptedRepo.createEncryptedFieldBackfillRun(
        { userId: alice.id },
        {
          sourceTable: "memory_questions",
          sourceColumn,
          providerMode: "local_test_key",
          totalRows: 1
        }
      );
      await expect(
        encryptedRepo.backfillEncryptedFieldBatch(
          { userId: alice.id },
          provider,
          {
            runId: run.id,
            sourceTable: "memory_questions",
            sourceColumn,
            batchSize: 10
          }
        )
      ).resolves.toMatchObject({
        processedRows: 1,
        encryptedRows: 1,
        failedRows: 0,
        done: true
      });
    }

    const rawEncryptedRows = await pool.query<{
      count: number;
      ciphertext: string | null;
    }>(
      `
        select count(*)::int as count, string_agg(ciphertext, '') as ciphertext
        from encrypted_field_payloads
        where owner_user_id = $1
          and source_table = 'memory_questions'
          and source_id = $2
          and invalidated_at is null
      `,
      [alice.id, question.id]
    );
    expect(rawEncryptedRows.rows[0]).toMatchObject({ count: 6 });
    expect(rawEncryptedRows.rows[0]?.ciphertext).not.toContain(
      "cobalt cache key"
    );
    expect(rawEncryptedRows.rows[0]?.ciphertext).not.toContain(
      "encrypted question retained"
    );

    const hidden = await encryptedRepo.decryptAuthorizedEncryptedField(
      { userId: bob.id },
      provider,
      {
        sourceTable: "memory_questions",
        sourceId: question.id,
        sourceColumn: "evidence"
      }
    );
    expect(hidden).toBeNull();

    const decryptedEvidence =
      await encryptedRepo.decryptAuthorizedEncryptedField(
        { userId: alice.id },
        provider,
        {
          sourceTable: "memory_questions",
          sourceId: question.id,
          sourceColumn: "evidence"
        }
      );
    expect(decryptedEvidence?.plaintext).toEqual([
      {
        sourceId: "evidence-1",
        text: "Evidence quote about the cobalt cache key."
      }
    ]);

    const detail = await encryptedQuestionRepo.getMemoryQuestion(
      { userId: alice.id },
      question.id
    );
    expect(detail).toMatchObject({
      id: question.id,
      status: "answered",
      answerMarkdown: "The encrypted question retained source evidence.",
      evidenceCount: 1
    });
  });

  it("disables plaintext lexical search by default in managed SaaS profile", async () => {
    const alice = await repo.createUser({
      email: `alice-managed-lexical-${randomUUID()}@example.com`
    });
    try {
      process.env.KOED_DEPLOYMENT_PROFILE = "koed_managed_cloud";
      delete process.env.MEMORY_PLAINTEXT_LEXICAL_SEARCH_ENABLED;

      await expect(
        repo.searchMemoryNodes(
          { userId: alice.id },
          {
            query: "plaintext lexical should not run",
            scope: "personal",
            searchDomain: "global",
            retrievalStage: "lexical_search"
          }
        )
      ).rejects.toMatchObject({
        statusCode: 400,
        payload: {
          error: "plaintext_lexical_search_disabled",
          deploymentProfile: "koed_managed_cloud"
        }
      });

      process.env.MEMORY_PLAINTEXT_LEXICAL_SEARCH_ENABLED = "true";
      await expect(
        repo.searchMemoryNodes(
          { userId: alice.id },
          {
            query: "plaintext lexical allowed only by explicit opt-in",
            scope: "personal",
            searchDomain: "global",
            retrievalStage: "lexical_search"
          }
        )
      ).resolves.toMatchObject({
        results: []
      });
    } finally {
      if (originalKoedDeploymentProfile === undefined) {
        delete process.env.KOED_DEPLOYMENT_PROFILE;
      } else {
        process.env.KOED_DEPLOYMENT_PROFILE = originalKoedDeploymentProfile;
      }
      if (originalPlaintextLexicalSearchEnabled === undefined) {
        delete process.env.MEMORY_PLAINTEXT_LEXICAL_SEARCH_ENABLED;
      } else {
        process.env.MEMORY_PLAINTEXT_LEXICAL_SEARCH_ENABLED =
          originalPlaintextLexicalSearchEnabled;
      }
    }
  });

  it("returns the original memory event for duplicate capture keys", async () => {
    const alice = await repo.createUser({
      email: `alice-duplicate-event-${randomUUID()}@example.com`
    });
    const sourceHash = `source-hash-${randomUUID()}`;
    const idempotencyKey = `idempotency-${randomUUID()}`;
    const input = {
      workspaceId: "workspace-duplicate-event",
      actor: "user" as const,
      eventType: "captured" as const,
      rawEventType: "user_prompt",
      visibility: "personal" as const,
      content: "Duplicate capture should return the first event",
      idempotencyKey,
      sourceHash
    };

    const first = await repo.createMemoryEvent({ userId: alice.id }, input);
    const duplicateBySourceHash = await repo.createMemoryEvent(
      { userId: alice.id },
      { ...input, idempotencyKey: `other-${randomUUID()}` }
    );
    const duplicateByIdempotencyKey = await repo.createMemoryEvent(
      { userId: alice.id },
      { ...input, sourceHash: `other-${randomUUID()}` }
    );
    const events = await repo.listLcmGraphEvents(
      { userId: alice.id },
      { query: "Duplicate capture", includeInvalidated: false }
    );

    expect(duplicateBySourceHash.id).toBe(first.id);
    expect(duplicateByIdempotencyKey.id).toBe(first.id);
    expect(events.map((event) => event.id)).toEqual([first.id]);
  });

  it("loads standalone memory events from thread rows", async () => {
    const alice = await repo.createUser({
      email: `alice-standalone-thread-${randomUUID()}@example.com`
    });
    const event = await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId: "workspace-standalone-thread",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        visibility: "personal",
        content: "Standalone memory event should open from the graph thread",
        metadata: {
          projectName: "Standalone Project",
          projectPath: "/tmp/standalone-project"
        }
      }
    );

    const projects = await repo.listLcmGraphThreads(
      { userId: alice.id },
      { projectId: "workspace-standalone-thread", limit: 10 }
    );
    const thread = projects[0]?.threads[0];
    const events = await repo.listLcmGraphEvents(
      { userId: alice.id },
      {
        projectId: "workspace-standalone-thread",
        threadId: thread?.id,
        limit: 10
      }
    );

    expect(thread?.id).toBe(event.id);
    expect(thread?.name).toBe("Untitled conversation");
    expect(events.map((graphEvent) => graphEvent.id)).toEqual([event.id]);
  });

  it("seeds explicit projection policy rows while allowing independent display and recall policy", async () => {
    const rows = await pool.query<{
      transcript_type: string;
      project_to_ui: boolean;
      include_in_embedding: boolean;
      create_memory_event: boolean;
    }>(
      `
        select
          transcript_type,
          project_to_ui,
          include_in_embedding,
          create_memory_event
        from projection_policy_rules
        where source_kind = 'codex'
          and source_adapter_version = 'codex-transcript-v1'
        order by transcript_type asc
      `
    );
    const byType = new Map(rows.rows.map((row) => [row.transcript_type, row]));

    expect([...byType.keys()]).toEqual(
      expect.arrayContaining([
        "user_message",
        "assistant_message",
        "agent_message",
        "subagent_message",
        "message",
        "function_call",
        "function_call_output",
        "custom_tool_call",
        "custom_tool_call_output",
        "reasoning_summary",
        "ide_context",
        "system_message",
        "task_started",
        "task_complete",
        "turn_context",
        "context_compacted",
        "compacted",
        "thread/tokenusage/updated",
        "mcp_tool_call_end",
        "patch_apply_end",
        "agentmessage/delta",
        "unknown"
      ])
    );
    expect(
      rows.rows.every((row) => row.project_to_ui === row.include_in_embedding)
    ).toBe(true);
    const displayOnlyType = `display_only_${randomUUID().replaceAll("-", "_")}`;
    const recallOnlyType = `recall_only_${randomUUID().replaceAll("-", "_")}`;
    try {
      await pool.query(
        `
          insert into projection_policy_rules (
            transcript_type,
            description,
            project_to_ui,
            create_message,
            create_tool_event,
            create_memory_event,
            include_in_embedding,
            include_in_lcm
          )
          values
            (
              $1,
              'Temporary display-only policy rule.',
              true,
              true,
              false,
              false,
              false,
              false
            ),
            (
              $2,
              'Temporary recall-only policy rule.',
              false,
              false,
              false,
              true,
              true,
              false
            )
        `,
        [displayOnlyType, recallOnlyType]
      );
    } finally {
      await pool.query(
        "delete from projection_policy_rules where transcript_type = any($1)",
        [[displayOnlyType, recallOnlyType]]
      );
    }
    expect(byType.get("user_message")).toMatchObject({
      project_to_ui: true,
      include_in_embedding: true,
      create_memory_event: true
    });
    expect(byType.get("function_call_output")).toMatchObject({
      project_to_ui: true,
      include_in_embedding: true,
      create_memory_event: true
    });
    expect(byType.get("ide_context")).toMatchObject({
      project_to_ui: false,
      include_in_embedding: false,
      create_memory_event: false
    });
    expect(byType.get("mcp_tool_call_end")).toMatchObject({
      project_to_ui: false,
      include_in_embedding: false,
      create_memory_event: false
    });
    expect(byType.get("patch_apply_end")).toMatchObject({
      project_to_ui: false,
      include_in_embedding: false,
      create_memory_event: false
    });
  });

  it("uses projection policy rules instead of only the hardcoded semantic allowlist", async () => {
    const alice = await repo.createUser({
      email: `alice-projection-policy-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    const transcriptType = `projection_policy_user_${randomUUID().replaceAll("-", "_")}`;
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Projection Policy Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `projection-policy-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        captureMethod: "hook",
        idempotencyKey: `projection-policy-session-${randomUUID()}`
      }
    );

    await pool.query(
      `
        insert into projection_policy_rules (
          transcript_type,
          description,
          project_to_ui,
          create_message,
          create_tool_event,
          create_memory_event,
          include_in_embedding,
          include_in_lcm
        )
        values (
          $1,
          'Temporary test projection policy rule.',
          true,
          true,
          false,
          true,
          true,
          true
        )
      `,
      [transcriptType]
    );

    try {
      await repo.createConversationItems(
        { userId: alice.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "hook",
              externalSessionId: session.externalSessionId ?? undefined,
              externalThreadId: session.externalSessionId ?? undefined,
              externalTurnId: "projection-policy-turn",
              sourceRecordType: "event_msg",
              sourceEventType: transcriptType,
              sourceSequence: 14,
              eventTime: "2026-04-01T12:00:00.000Z",
              rawJson: {
                type: "event_msg",
                payload: {
                  type: transcriptType,
                  content: "Policy table selected this custom transcript type."
                }
              },
              rawText: "Policy table selected this custom transcript type.",
              sourceHash: `projection-policy-raw-${randomUUID()}`,
              idempotencyKey: `projection-policy-raw-${randomUUID()}`,
              projectionStatus: "pending",
              metadata: {
                workspaceId,
                transcriptType
              }
            }
          ]
        }
      );

      const projection = await repo.projectPendingConversationItems(
        { userId: alice.id },
        { limit: 10 }
      );
      const messages = await pool.query<{ content: string }>(
        "select content from messages where session_id = $1",
        [session.id]
      );
      const memoryEvents = await pool.query<{ content: string }>(
        "select payload ->> 'content' as content from memory_events where session_id = $1",
        [session.id]
      );

      expect(projection).toMatchObject({
        messagesCreated: 1,
        memoryEventsCreated: 1
      });
      expect(messages.rows.map((row) => row.content)).toEqual([
        "Policy table selected this custom transcript type."
      ]);
      expect(memoryEvents.rows.map((row) => row.content)).toEqual([
        "Policy table selected this custom transcript type."
      ]);
    } finally {
      await pool.query(
        "delete from projection_policy_rules where transcript_type = $1",
        [transcriptType]
      );
    }
  });

  it("rebuilds display and semantic memory when Projection Policy selection changes", async () => {
    const owner = await repo.createUser({
      email: `projection-policy-rebuild-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    const transcriptType = `policy_rebuild_user_${randomUUID().replaceAll("-", "_")}`;
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Projection Policy Rebuild')
      `,
      [workspaceId, owner.id]
    );
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        workspaceId,
        externalSessionId: `policy-rebuild-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        captureMethod: "hook"
      }
    );
    await pool.query(
      `
        insert into projection_policy_rules (
          transcript_type, description, project_to_ui, create_message,
          create_tool_event, create_memory_event, include_in_embedding,
          include_in_lcm
        )
        values ($1, 'Policy rebuild test.', true, true, false, true, true, true)
      `,
      [transcriptType]
    );

    try {
      await repo.createConversationItems(
        { userId: owner.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "hook",
              externalThreadId: session.externalSessionId ?? undefined,
              externalTurnId: "policy-rebuild-turn",
              sourceRecordType: "event_msg",
              sourceEventType: transcriptType,
              sourceSequence: 1,
              eventTime: "2026-07-12T00:00:00.000Z",
              rawJson: {
                type: "event_msg",
                payload: {
                  type: transcriptType,
                  content: "Projection Policy rebuild source text."
                }
              },
              rawText: "Projection Policy rebuild source text.",
              sourceHash: `policy-rebuild-${randomUUID()}`,
              idempotencyKey: `policy-rebuild-${randomUUID()}`,
              metadata: {
                transcriptType,
                projectionActor: "user",
                workspaceId
              }
            }
          ]
        }
      );
      const initial = await repo.projectPendingConversationItems(
        { userId: owner.id },
        { limit: 10 }
      );
      expect(initial).toMatchObject({
        messagesCreated: 1,
        memoryEventsCreated: 1,
        memoryEventScopes: [
          expect.objectContaining({
            includeInEmbedding: true,
            includeInLcm: true
          })
        ]
      });

      await pool.query(
        `
          update projection_policy_rules
          set project_to_ui = true,
              create_message = true,
              create_memory_event = false,
              include_in_embedding = false,
              include_in_lcm = false,
              updated_at = now()
          where transcript_type = $1
        `,
        [transcriptType]
      );
      const displayReset = await repo.resetConversationProjection(
        { userId: owner.id },
        { sessionId: session.id }
      );
      const displayOnly = await repo.projectPendingConversationItems(
        { userId: owner.id },
        {
          limit: 10,
          conversationItemIds: displayReset.conversationItemIds
        }
      );
      const displayState = await pool.query<{
        active_messages: number;
        active_events: number;
      }>(
        `
          select
            (select count(*)::int from messages where session_id = $1 and invalidated_at is null) as active_messages,
            (select count(*)::int from memory_events where session_id = $1 and invalidated_at is null) as active_events
        `,
        [session.id]
      );
      expect(displayOnly.memoryEventScopes).toEqual([]);
      expect(displayState.rows[0]).toEqual({
        active_messages: 1,
        active_events: 0
      });

      await pool.query(
        `
          update projection_policy_rules
          set project_to_ui = false,
              create_message = false,
              create_memory_event = true,
              include_in_embedding = true,
              include_in_lcm = false,
              updated_at = now()
          where transcript_type = $1
        `,
        [transcriptType]
      );
      const recallReset = await repo.resetConversationProjection(
        { userId: owner.id },
        { sessionId: session.id }
      );
      const recallOnly = await repo.projectPendingConversationItems(
        { userId: owner.id },
        {
          limit: 10,
          conversationItemIds: recallReset.conversationItemIds
        }
      );
      const recallState = await pool.query<{
        active_messages: number;
        active_events: number;
      }>(
        `
          select
            (select count(*)::int from messages where session_id = $1 and invalidated_at is null) as active_messages,
            (select count(*)::int from memory_events where session_id = $1 and invalidated_at is null) as active_events
        `,
        [session.id]
      );
      expect(recallOnly.memoryEventScopes).toEqual([
        expect.objectContaining({
          includeInEmbedding: true,
          includeInLcm: false
        })
      ]);
      expect(recallState.rows[0]).toEqual({
        active_messages: 0,
        active_events: 1
      });
    } finally {
      await pool.query(
        "delete from projection_policy_rules where transcript_type = $1",
        [transcriptType]
      );
    }
  });

  it("prefers an exact app-server projection policy over transcript defaults", async () => {
    const alice = await repo.createUser({
      email: `alice-app-server-policy-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `app-server-policy-${randomUUID()}`,
        sourceRuntime: "codex",
        captureMethod: "api",
        idempotencyKey: `app-server-policy-session-${randomUUID()}`
      }
    );
    await pool.query(
      `
        insert into projection_policy_rules (
          source_kind,
          source_adapter_version,
          transcript_type,
          description,
          project_to_ui,
          create_message,
          create_tool_event,
          create_memory_event,
          include_in_embedding,
          include_in_lcm
        )
        values (
          'codex',
          'codex-app-server-conversation-v1',
          'user_message',
          'App-server user messages remain raw for this policy test.',
          false,
          false,
          false,
          false,
          false,
          false
        )
      `
    );

    try {
      const [item] = await repo.createConversationItems(
        { userId: alice.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-app-server-conversation-v1",
              sourceTransport: "app_server",
              externalSessionId: session.externalSessionId ?? undefined,
              externalThreadId: session.externalSessionId ?? undefined,
              externalTurnId: "app-server-policy-turn",
              externalItemId: "app-server-policy-user",
              canonicalItemKey: codexCanonicalConversationItemKey({
                externalThreadId: session.externalSessionId!,
                externalTurnId: "app-server-policy-turn",
                stableItemId: "app-server-policy-user",
                component: "message"
              }),
              canonicalStableItemId: "app-server-policy-user",
              observationComponent: "message",
              sourceRecordType: "app_server_notification",
              sourceEventType: "item/completed",
              sourceSequence: 1,
              eventTime: "2026-04-01T12:00:00.000Z",
              rawJson: {
                method: "item/completed",
                params: {
                  item: {
                    id: "app-server-policy-user",
                    type: "userMessage",
                    content: [{ type: "text", text: "Keep this raw." }]
                  }
                }
              },
              rawText: "Keep this raw.",
              sourceHash: `app-server-policy-${randomUUID()}`,
              idempotencyKey: `app-server-policy-${randomUUID()}`,
              projectionStatus: "pending",
              metadata: { transcriptType: "user_message" }
            }
          ]
        }
      );

      const projection = await repo.projectPendingConversationItems(
        { userId: alice.id },
        { limit: 10 }
      );
      const messages = await pool.query(
        "select id from messages where session_id = $1",
        [session.id]
      );
      const memoryEvents = await pool.query(
        "select id from memory_events where session_id = $1",
        [session.id]
      );
      const stored = await pool.query<{ projection_status: string }>(
        "select projection_status from conversation_items where id = $1",
        [item!.id]
      );

      expect(projection).toMatchObject({
        messagesCreated: 0,
        memoryEventsCreated: 0
      });
      expect(messages.rows).toEqual([]);
      expect(memoryEvents.rows).toEqual([]);
      expect(stored.rows[0]?.projection_status).toBe("projected");
    } finally {
      await pool.query(
        `
          delete from projection_policy_rules
          where source_kind = 'codex'
            and source_adapter_version = 'codex-app-server-conversation-v1'
            and transcript_type = 'user_message'
        `
      );
    }
  });

  it("uses projection policy rules to keep semantic events out of LCM", async () => {
    const alice = await repo.createUser({
      email: `alice-projection-policy-lcm-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    const transcriptType = `projection_policy_lcm_user_${randomUUID().replaceAll("-", "_")}`;
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Projection Policy LCM Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `projection-policy-lcm-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        captureMethod: "hook",
        idempotencyKey: `projection-policy-lcm-session-${randomUUID()}`
      }
    );

    await pool.query(
      `
        insert into projection_policy_rules (
          transcript_type,
          description,
          project_to_ui,
          create_message,
          create_tool_event,
          create_memory_event,
          include_in_embedding,
          include_in_lcm
        )
        values (
          $1,
          'Temporary LCM exclusion projection policy rule.',
          true,
          true,
          false,
          true,
          true,
          false
        )
      `,
      [transcriptType]
    );

    try {
      await repo.createConversationItems(
        { userId: alice.id },
        {
          items: Array.from({ length: 5 }, (_, index) => ({
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: `projection-policy-lcm-turn-${index}`,
            sourceRecordType: "event_msg",
            sourceEventType: transcriptType,
            sourceSequence: index + 1,
            eventTime: `2026-04-01T12:00:0${index}.000Z`,
            rawJson: {
              type: "event_msg",
              payload: {
                type: transcriptType,
                content: `LCM-excluded semantic event ${index + 1}.`
              }
            },
            rawText: `LCM-excluded semantic event ${index + 1}.`,
            sourceHash: `projection-policy-lcm-${index}-${randomUUID()}`,
            idempotencyKey: `projection-policy-lcm-${index}-${randomUUID()}`,
            projectionStatus: "pending" as const,
            metadata: {
              workspaceId,
              transcriptType
            }
          }))
        }
      );

      const projection = await repo.projectPendingConversationItems(
        { userId: alice.id },
        { limit: 10 }
      );
      const memoryEvents = await pool.query<{ include_in_lcm: string | null }>(
        `
          select payload #>> '{metadata,includeInLcm}' as include_in_lcm
          from memory_events
          where session_id = $1
          order by captured_at asc
        `,
        [session.id]
      );
      const messages = await pool.query<{ content: string }>(
        `
          select content
          from messages
          where session_id = $1
          order by source_event_time asc, created_at asc, id asc
        `,
        [session.id]
      );
      const compacted = await repo.createLcmNodes(
        { userId: alice.id },
        { visibility: "personal" }
      );

      expect(messages.rows.map((row) => row.content)).toEqual(
        Array.from(
          { length: 5 },
          (_, index) => `LCM-excluded semantic event ${index + 1}.`
        )
      );
      expect(projection).toMatchObject({
        messagesCreated: 5,
        memoryEventsCreated: 5
      });
      expect(memoryEvents.rows.map((row) => row.include_in_lcm)).toEqual([
        "false",
        "false",
        "false",
        "false",
        "false"
      ]);
      expect(compacted.leafNodeIds).toEqual([]);
    } finally {
      await pool.query(
        "delete from projection_policy_rules where transcript_type = $1",
        [transcriptType]
      );
    }
  });

  it("uses raw-only projection policy rows to suppress fallback tool projection", async () => {
    const alice = await repo.createUser({
      email: `alice-projection-policy-raw-only-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Raw-only Projection Policy Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `projection-policy-raw-only-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        captureMethod: "hook",
        idempotencyKey: `projection-policy-raw-only-session-${randomUUID()}`
      }
    );

    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "projection-policy-raw-only-turn",
            sourceRecordType: "event_msg",
            sourceEventType: "mcp_tool_call_end",
            sourceSequence: 19,
            eventTime: "2026-04-01T12:00:00.000Z",
            rawJson: {
              type: "event_msg",
              payload: {
                type: "mcp_tool_call_end",
                invocation: {
                  tool: "memory_answer",
                  arguments: { query: "This low-level event should stay raw." }
                },
                result: {
                  Ok: {
                    content: [
                      {
                        type: "text",
                        text: "Raw-only policy should suppress this tool-shaped item."
                      }
                    ]
                  }
                }
              }
            },
            rawText: "Raw-only policy should suppress this tool-shaped item.",
            sourceHash: `projection-policy-raw-only-${randomUUID()}`,
            idempotencyKey: `projection-policy-raw-only-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: {
              workspaceId,
              transcriptType: "mcp_tool_call_end"
            }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "projection-policy-raw-only-turn",
            sourceRecordType: "event_msg",
            sourceEventType: `unlisted_tool_result_${randomUUID().replaceAll("-", "_")}`,
            sourceSequence: 20,
            eventTime: "2026-04-01T12:00:01.000Z",
            rawJson: {
              type: "event_msg",
              payload: {
                type: "unlisted_tool_result",
                invocation: {
                  tool: "memory_answer",
                  arguments: { query: "Unlisted tool-shaped item." }
                },
                result: {
                  Ok: {
                    content: [
                      {
                        type: "text",
                        text: "Missing policy should suppress this tool-shaped item."
                      }
                    ]
                  }
                }
              }
            },
            rawText: "Missing policy should suppress this tool-shaped item.",
            sourceHash: `projection-policy-missing-${randomUUID()}`,
            idempotencyKey: `projection-policy-missing-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: {
              workspaceId,
              transcriptType: "unlisted_tool_result"
            }
          }
        ]
      }
    );
    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const statuses = await pool.query<{
      projection_status: string;
      projection_error: string | null;
    }>(
      "select projection_status, projection_error from conversation_items where session_id = $1 order by source_sequence",
      [session.id]
    );
    const messages = await pool.query<{ count: string }>(
      "select count(*) from messages where session_id = $1",
      [session.id]
    );
    const toolEvents = await pool.query<{ count: string }>(
      "select count(*) from tool_events where session_id = $1",
      [session.id]
    );
    const memoryEvents = await pool.query<{ count: string }>(
      "select count(*) from memory_events where session_id = $1",
      [session.id]
    );

    expect(projection).toMatchObject({
      messagesCreated: 0,
      toolEventsCreated: 0,
      memoryEventsCreated: 0
    });
    expect(statuses.rows).toEqual([
      { projection_status: "projected", projection_error: null },
      { projection_status: "projected", projection_error: null }
    ]);
    expect(messages.rows[0]?.count).toBe("0");
    expect(toolEvents.rows[0]?.count).toBe("0");
    expect(memoryEvents.rows[0]?.count).toBe("0");
  });

  it("does not project hook-only payload content into semantic memory", async () => {
    const alice = await repo.createUser({
      email: `alice-hook-control-only-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Hook Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `hook-control-only-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        captureMethod: "hook",
        idempotencyKey: `hook-control-only-session-${randomUUID()}`
      }
    );
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "hook-turn-1",
            sourceRecordType: "hook_payload",
            sourceEventType: "UserPromptSubmit",
            sourceSequence: 1,
            rawJson: {
              hook_event_name: "UserPromptSubmit",
              prompt: "Hook-only prompt should be retained."
            },
            rawText: "Hook-only prompt should be retained.",
            sourceHash: `hook-prompt-${randomUUID()}`,
            idempotencyKey: `hook-prompt-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: { projectName: "Hook Project" }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "hook-turn-1",
            sourceRecordType: "hook_payload",
            sourceEventType: "Stop",
            sourceSequence: 2,
            rawJson: {
              hook_event_name: "Stop",
              last_assistant_message:
                "Hook-only assistant reply should be retained."
            },
            rawText: "Hook-only assistant reply should be retained.",
            sourceHash: `hook-stop-${randomUUID()}`,
            idempotencyKey: `hook-stop-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: { projectName: "Hook Project" }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const messages = await pool.query<{ count: string }>(
      "select count(*)::text as count from messages where session_id = $1",
      [session.id]
    );
    const toolEvents = await pool.query<{ count: string }>(
      "select count(*)::text as count from tool_events where session_id = $1",
      [session.id]
    );
    const memoryEvents = await pool.query<{ count: string }>(
      "select count(*)::text as count from memory_events where session_id = $1",
      [session.id]
    );
    const statuses = await pool.query<{
      source_event_type: string | null;
      projection_status: string;
    }>(
      `
        select source_event_type, projection_status
        from conversation_items
        where session_id = $1
        order by source_sequence asc
      `,
      [session.id]
    );

    expect(projection).toMatchObject({
      rawItemsProjected: 2,
      messagesCreated: 0,
      toolEventsCreated: 0,
      memoryEventsCreated: 0
    });
    expect(messages.rows[0]?.count).toBe("0");
    expect(toolEvents.rows[0]?.count).toBe("0");
    expect(memoryEvents.rows[0]?.count).toBe("0");
    expect(statuses.rows).toEqual([
      { source_event_type: "UserPromptSubmit", projection_status: "projected" },
      { source_event_type: "Stop", projection_status: "projected" }
    ]);
  });

  it("projects transcript prompt messages without using UserPromptSubmit hook content", async () => {
    const alice = await repo.createUser({
      email: `alice-live-prompt-dedupe-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Live Prompt Dedupe Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `live-prompt-dedupe-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        captureMethod: "hook",
        idempotencyKey: `live-prompt-dedupe-session-${randomUUID()}`
      }
    );
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "immediate-hook-turn",
            sourceRecordType: "hook_payload",
            sourceEventType: "UserPromptSubmit",
            rawJson: {
              hook_event_name: "UserPromptSubmit",
              prompt: "Where should duplicate prompts render?"
            },
            rawText: "Where should duplicate prompts render?",
            sourceHash: `live-prompt-hook-${randomUUID()}`,
            idempotencyKey: `live-prompt-hook-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: { projectName: "Live Prompt Dedupe Project" }
          }
        ]
      }
    );

    await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );

    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "immediate-hook-turn",
            sourceRecordType: "event_msg",
            sourceEventType: "user_message",
            sourceSequence: 12,
            eventTime: new Date().toISOString(),
            rawJson: {
              type: "event_msg",
              payload: {
                type: "user_message",
                message: "Where should duplicate prompts render?"
              }
            },
            rawText: "Where should duplicate prompts render?",
            sourceHash: `live-prompt-transcript-${randomUUID()}`,
            idempotencyKey: `live-prompt-transcript-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: {
              projectName: "Live Prompt Dedupe Project",
              transcriptType: "user_message"
            }
          }
        ]
      }
    );

    await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const messageRows = await pool.query<{
      content: string;
      transcript_item_id: string | null;
    }>(
      `
        select content, transcript_item_id
        from messages
        where session_id = $1
        order by transcript_item_id asc nulls last
      `,
      [session.id]
    );
    const events = await repo.listLcmGraphEvents(
      { userId: alice.id },
      {
        projectId: workspaceId,
        threadId: session.externalSessionId ?? undefined,
        limit: 10
      }
    );
    const rawRows = await pool.query<{
      source_record_type: string;
      source_event_type: string | null;
      source_sequence: number | null;
      projection_status: string;
      canonical_key: string | null;
    }>(
      `
        select
          source_record_type,
          source_event_type,
          source_sequence,
          projection_status,
          metadata ->> 'canonicalConversationItemKey' as canonical_key
        from conversation_items
        where session_id = $1
      `,
      [session.id]
    );
    const memoryEvents = await pool.query<{ count: string }>(
      "select count(*)::text as count from memory_events where session_id = $1",
      [session.id]
    );

    expect(messageRows.rows).toEqual([
      {
        content: "Where should duplicate prompts render?",
        transcript_item_id: "12"
      }
    ]);
    expect(events.map((event) => event.contentPreview)).toEqual([
      "Where should duplicate prompts render?"
    ]);
    expect(events[0]?.sourceSequence).toBe(12);
    expect(rawRows.rows).toHaveLength(2);
    const transcriptRawRow = rawRows.rows.find(
      (row) => row.source_record_type === "event_msg"
    );
    expect(transcriptRawRow?.canonical_key).toBeNull();
    expect(rawRows.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_record_type: "hook_payload",
          source_event_type: "UserPromptSubmit",
          projection_status: "projected",
          canonical_key: null
        }),
        expect.objectContaining({
          source_record_type: "event_msg",
          source_event_type: "user_message",
          source_sequence: 12,
          projection_status: "projected",
          canonical_key: transcriptRawRow?.canonical_key
        })
      ])
    );
    expect(memoryEvents.rows[0]?.count).toBe("1");
  });

  it("does not assign canonical content identity to transcript lifecycle rows", async () => {
    const alice = await repo.createUser({
      email: `alice-lifecycle-canonical-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Lifecycle Canonical Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `lifecycle-canonical-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        captureMethod: "hook",
        idempotencyKey: `lifecycle-canonical-session-${randomUUID()}`
      }
    );

    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "lifecycle-turn",
            sourceRecordType: "event_msg",
            sourceEventType: "task_started",
            sourceSequence: 1,
            eventTime: "2026-04-01T12:00:00.000Z",
            rawJson: {
              type: "event_msg",
              payload: { type: "task_started", turn_id: "lifecycle-turn" }
            },
            rawText: "Task started",
            sourceHash: `lifecycle-start-${randomUUID()}`,
            idempotencyKey: `lifecycle-start-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: {
              workspaceId,
              transcriptType: "task_started"
            }
          }
        ]
      }
    );

    const rawRows = await pool.query<{ canonical_key: string | null }>(
      `
        select metadata ->> 'canonicalConversationItemKey' as canonical_key
        from conversation_items
        where session_id = $1
      `,
      [session.id]
    );

    expect(rawRows.rows).toEqual([{ canonical_key: null }]);
  });

  it("updates existing message projections when source hash wins the conflict", async () => {
    const alice = await repo.createUser({
      email: `alice-message-source-hash-conflict-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Message Source Hash Conflict Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `message-source-hash-conflict-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        captureMethod: "hook",
        idempotencyKey: `message-source-hash-conflict-session-${randomUUID()}`
      }
    );
    const sourceHash = `message-source-hash-conflict-${randomUUID()}`;

    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "message-source-hash-turn",
            sourceRecordType: "event_msg",
            sourceEventType: "user_message",
            sourceSequence: 42,
            eventTime: "2026-04-01T12:00:01.000Z",
            rawJson: {
              type: "event_msg",
              payload: {
                type: "user_message",
                message: "Projection should refresh this message."
              }
            },
            rawText: "Projection should refresh this message.",
            sourceHash,
            idempotencyKey: `message-source-hash-raw-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: {
              workspaceId,
              transcriptType: "user_message"
            }
          }
        ]
      }
    );

    await pool.query(
      `
        insert into messages (
          session_id, owner_user_id, visibility, role, content,
          source_runtime, capture_method, transcript_item_id,
          idempotency_key, source_hash, source_event_time
        )
        values (
          $1, $2, 'personal', 'user', 'stale content',
          'codex', 'hook', 'stale-transcript-item',
          $3, $4, '2026-04-01T12:00:00.000Z'
        )
      `,
      [
        session.id,
        alice.id,
        `stale-message-${randomUUID()}`,
        `message:${sourceHash}`
      ]
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const messages = await pool.query<{
      content: string;
      transcript_item_id: string | null;
      source_hash: string | null;
    }>(
      `
        select content, transcript_item_id, source_hash
        from messages
        where session_id = $1
        order by created_at asc
      `,
      [session.id]
    );
    const statuses = await pool.query<{
      projection_status: string;
      projection_error: string | null;
    }>(
      `
        select projection_status, projection_error
        from conversation_items
        where session_id = $1
      `,
      [session.id]
    );

    expect(projection.messagesCreated).toBe(0);
    expect(messages.rows).toEqual([
      {
        content: "Projection should refresh this message.",
        transcript_item_id: "42",
        source_hash: `message:${sourceHash}`
      }
    ]);
    expect(statuses.rows).toEqual([
      { projection_status: "projected", projection_error: null }
    ]);
  });

  it("uses Stop hook payloads as seal signals without projecting assistant fallback content", async () => {
    const alice = await repo.createUser({
      email: `alice-live-agent-dedupe-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Live Agent Dedupe Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `live-agent-dedupe-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        captureMethod: "hook",
        idempotencyKey: `live-agent-dedupe-session-${randomUUID()}`
      }
    );

    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "agent-turn-1",
            sourceRecordType: "hook_payload",
            sourceEventType: "Stop",
            rawJson: {
              hook_event_name: "Stop",
              turn_id: "agent-turn-1",
              last_assistant_message:
                "Transcript assistant content should project."
            },
            rawText: "Transcript assistant content should project.",
            sourceHash: `live-agent-hook-${randomUUID()}`,
            idempotencyKey: `live-agent-hook-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: { projectName: "Live Agent Dedupe Project" }
          }
        ]
      }
    );

    const hookOnlyProjection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );

    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "agent-turn-1",
            sourceRecordType: "event_msg",
            sourceEventType: "agent_message",
            sourceSequence: 22,
            eventTime: new Date().toISOString(),
            rawJson: {
              type: "event_msg",
              payload: {
                type: "agent_message",
                message: "Transcript assistant content should project."
              }
            },
            rawText: "Transcript assistant content should project.",
            sourceHash: `live-agent-transcript-${randomUUID()}`,
            idempotencyKey: `live-agent-transcript-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: {
              projectName: "Live Agent Dedupe Project",
              transcriptType: "agent_message"
            }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "agent-turn-1",
            sourceRecordType: "hook_payload",
            sourceEventType: "Stop",
            sourceSequence: 23,
            rawJson: { hook_event_name: "Stop", turn_id: "agent-turn-1" },
            sourceHash: `live-agent-stop-${randomUUID()}`,
            idempotencyKey: `live-agent-stop-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: { projectName: "Live Agent Dedupe Project" }
          }
        ]
      }
    );

    const transcriptProjection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );

    const rawRows = await pool.query<{
      source_record_type: string;
      source_event_type: string | null;
      source_sequence: number | null;
      canonical_key: string | null;
    }>(
      `
        select
          source_record_type,
          source_event_type,
          source_sequence,
          metadata ->> 'canonicalConversationItemKey' as canonical_key
        from conversation_items
        where session_id = $1
        order by source_sequence asc nulls last
      `,
      [session.id]
    );
    const messages = await pool.query<{
      role: string;
      content: string;
      transcript_item_id: string | null;
    }>(
      `
        select role, content, transcript_item_id
        from messages
        where session_id = $1
        order by created_at asc
      `,
      [session.id]
    );
    const memoryEvents = await pool.query<{ content: string }>(
      `
        select payload ->> 'content' as content
        from memory_events
        where session_id = $1
        order by created_at asc
      `,
      [session.id]
    );

    expect(hookOnlyProjection).toMatchObject({
      messagesCreated: 0,
      memoryEventsCreated: 0
    });
    expect(transcriptProjection).toMatchObject({
      messagesCreated: 1,
      memoryEventsCreated: 1
    });
    expect(rawRows.rows[0]?.canonical_key).toBeNull();
    expect(rawRows.rows).toEqual([
      {
        source_record_type: "event_msg",
        source_event_type: "agent_message",
        source_sequence: 22,
        canonical_key: rawRows.rows[0]?.canonical_key
      },
      {
        source_record_type: "hook_payload",
        source_event_type: "Stop",
        source_sequence: 23,
        canonical_key: null
      },
      {
        source_record_type: "hook_payload",
        source_event_type: "Stop",
        source_sequence: null,
        canonical_key: null
      }
    ]);
    expect(messages.rows).toEqual([
      {
        role: "assistant",
        content: "Transcript assistant content should project.",
        transcript_item_id: "22"
      }
    ]);
    expect(memoryEvents.rows.map((row) => row.content)).toEqual([
      "Transcript assistant content should project."
    ]);
  });

  it("skips personal-deleted raw conversation items during semantic projection", async () => {
    const alice = await repo.createUser({
      email: `alice-projection-personal-delete-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Projection Personal Delete Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `projection-personal-delete-${randomUUID()}`,
        sourceRuntime: "codex",
        captureMethod: "hook"
      }
    );
    const [rawItem] = await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "deleted-turn-1",
            sourceRecordType: "hook_payload",
            sourceEventType: "UserPromptSubmit",
            sourceSequence: 1,
            rawJson: {
              hook_event_name: "UserPromptSubmit",
              prompt: "This deleted raw prompt must not be projected."
            },
            rawText: "This deleted raw prompt must not be projected.",
            sourceHash: `deleted-raw-prompt-${randomUUID()}`,
            idempotencyKey: `deleted-raw-prompt-${randomUUID()}`,
            projectionStatus: "pending"
          }
        ]
      }
    );
    await pool.query(
      "update conversation_items set personal_deleted_at = now() where id = $1",
      [rawItem!.id]
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const events = await pool.query<{ count: string }>(
      "select count(*)::text as count from memory_events where session_id = $1",
      [session.id]
    );

    expect(projection.rawItemsScanned).toBe(0);
    expect(projection.memoryEventsCreated).toBe(0);
    expect(events.rows[0]?.count).toBe("0");
  });

  it("exposes transcript source chronology for projected graph events", async () => {
    const alice = await repo.createUser({
      email: `alice-source-chronology-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Source Chronology Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `source-chronology-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        captureMethod: "hook",
        idempotencyKey: `source-chronology-session-${randomUUID()}`
      }
    );
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "source-chronology-turn",
            sourceRecordType: "response_item",
            sourceEventType: "message",
            sourceSequence: 1,
            eventTime: "2026-04-01T12:00:00.000Z",
            rawJson: {
              type: "response_item",
              payload: {
                client_id: "source-chronology-user-message",
                type: "message",
                role: "user",
                content: "Older source prompt"
              }
            },
            rawText: "Older source prompt",
            sourceHash: `source-chronology-prompt-${randomUUID()}`,
            idempotencyKey: `source-chronology-prompt-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: {
              projectName: "Source Chronology Project",
              transcriptType: "user_message"
            }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "source-chronology-turn",
            sourceRecordType: "response_item",
            sourceEventType: "message",
            sourceSequence: 2,
            eventTime: "2026-04-01T12:00:00.000Z",
            rawJson: {
              type: "response_item",
              payload: {
                type: "message",
                role: "assistant",
                content: "Older source reply"
              }
            },
            rawText: "Older source reply",
            sourceHash: `source-chronology-reply-${randomUUID()}`,
            idempotencyKey: `source-chronology-reply-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: {
              projectName: "Source Chronology Project",
              transcriptType: "agent_message"
            }
          }
        ]
      }
    );

    await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const firstPage = await repo.listLcmGraphEvents(
      { userId: alice.id },
      {
        projectId: workspaceId,
        threadId: session.externalSessionId ?? undefined,
        limit: 1
      }
    );
    const secondPage = await repo.listLcmGraphEvents(
      { userId: alice.id },
      {
        projectId: workspaceId,
        threadId: session.externalSessionId ?? undefined,
        limit: 1,
        cursorTimestamp: firstPage[0]!.timestamp,
        cursorSourceSequence: firstPage[0]!.sourceSequence ?? undefined,
        cursorId: firstPage[0]!.id
      }
    );
    const legacyCursorPage = await repo.listLcmGraphEvents(
      { userId: alice.id },
      {
        projectId: workspaceId,
        threadId: session.externalSessionId ?? undefined,
        limit: 1,
        cursorTimestamp: firstPage[0]!.timestamp,
        cursorId: firstPage[0]!.id
      }
    );
    const threadIndex = await repo.listLcmGraphThreads(
      { userId: alice.id },
      {
        projectId: workspaceId,
        threadId: session.externalSessionId ?? undefined,
        limit: 10
      }
    );

    expect(firstPage[0]).toMatchObject({
      contentPreview: "Older source reply",
      sourceEventTime: "2026-04-01T12:00:00.000Z",
      sourceSequence: 2,
      timestamp: "2026-04-01T12:00:00.000Z"
    });
    expect(secondPage[0]).toMatchObject({
      contentPreview: "Older source prompt",
      sourceEventTime: "2026-04-01T12:00:00.000Z",
      sourceSequence: 1
    });
    expect(legacyCursorPage[0]?.id).toBe(secondPage[0]!.id);
    expect(firstPage[0]!.createdAt).not.toBe(firstPage[0]!.timestamp);
    expect(threadIndex[0]?.threads[0]).toMatchObject({
      latestAt: "2026-04-01T12:00:00.000Z",
      sample: "Older source reply"
    });
  });

  it("renders projected display sources while semantic bundles stay memory-only", async () => {
    const alice = await repo.createUser({
      email: `alice-display-sources-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Display Source Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `display-source-${randomUUID()}`,
        sourceRuntime: "codex",
        captureMethod: "hook",
        idempotencyKey: `display-source-session-${randomUUID()}`
      }
    );
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "display-source-turn",
            sourceRecordType: "event_msg",
            sourceEventType: "user_message",
            sourceSequence: 1,
            eventTime: "2026-04-01T12:00:00.000Z",
            rawJson: {
              type: "event_msg",
              payload: {
                type: "user_message",
                message: "Display prompt"
              }
            },
            rawText: "Display prompt",
            sourceHash: `display-source-user-${randomUUID()}`,
            idempotencyKey: `display-source-user-${randomUUID()}`,
            metadata: {
              projectName: "Display Source Project",
              transcriptType: "user_message"
            }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "display-source-turn",
            sourceRecordType: "response_item",
            sourceEventType: "function_call",
            sourceSequence: 2,
            eventTime: "2026-04-01T12:00:01.000Z",
            rawJson: {
              type: "response_item",
              payload: {
                type: "function_call",
                name: "exec_command",
                call_id: "toolu-display-1",
                arguments: '{"cmd":"rg projection"}'
              }
            },
            rawText: '{"cmd":"rg projection"}',
            sourceHash: `display-source-tool-call-${randomUUID()}`,
            idempotencyKey: `display-source-tool-call-${randomUUID()}`,
            metadata: {
              toolName: "exec_command",
              toolCallId: "toolu-display-1",
              toolCall: {
                id: "toolu-display-1",
                kind: "call",
                name: "exec_command",
                input: { cmd: "rg projection" }
              }
            }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "display-source-turn",
            sourceRecordType: "response_item",
            sourceEventType: "function_call_output",
            sourceSequence: 3,
            eventTime: "2026-04-01T12:00:02.000Z",
            rawJson: {
              type: "response_item",
              payload: {
                type: "function_call_output",
                call_id: "toolu-display-1",
                output: "projection match"
              }
            },
            rawText: "projection match",
            sourceHash: `display-source-tool-result-${randomUUID()}`,
            idempotencyKey: `display-source-tool-result-${randomUUID()}`,
            metadata: {
              toolCallId: "toolu-display-1",
              toolCall: {
                id: "toolu-display-1",
                kind: "output",
                output: "projection match"
              }
            }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "display-source-turn",
            sourceRecordType: "event_msg",
            sourceEventType: "agent_message",
            sourceSequence: 4,
            eventTime: "2026-04-01T12:00:03.000Z",
            rawJson: {
              type: "event_msg",
              payload: {
                type: "agent_message",
                message: "Display reply"
              }
            },
            rawText: "Display reply",
            sourceHash: `display-source-agent-${randomUUID()}`,
            idempotencyKey: `display-source-agent-${randomUUID()}`,
            metadata: {
              hookEventName: "Stop",
              transcriptType: "agent_message"
            }
          }
        ]
      }
    );

    await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );

    const displayEvents = await repo.listLcmGraphEvents(
      { userId: alice.id },
      {
        projectId: workspaceId,
        threadId: session.externalSessionId ?? undefined,
        includeContent: true,
        limit: 10
      }
    );
    const semanticEvents = await pool.query<{
      id: string;
      semantic_unit_type: string | null;
    }>(
      `
	        select
            id,
            payload #>> '{metadata,semanticUnitType}' as semantic_unit_type
	        from memory_events
	        where session_id = $1
	        order by source_sequence asc nulls last, created_at asc
	      `,
      [session.id]
    );
    const threads = await repo.listLcmGraphThreads(
      { userId: alice.id },
      {
        projectId: workspaceId,
        threadId: session.externalSessionId ?? undefined,
        limit: 10
      }
    );

    const timelineEvents = [...displayEvents].sort(
      (left, right) => (left.sourceSequence ?? 0) - (right.sourceSequence ?? 0)
    );
    expect(timelineEvents.map((event) => event.content)).toEqual([
      "Display prompt",
      expect.stringContaining("Tool call: exec_command"),
      "Display reply"
    ]);
    expect(timelineEvents.map((event) => event.metadata.sourceTable)).toEqual([
      "messages",
      "tool_events",
      "messages"
    ]);
    expect(timelineEvents[1]).toMatchObject({
      actor: "tool",
      eventType: "tool_result",
      metadata: {
        toolName: "exec_command",
        input: { cmd: "rg projection" },
        output: "projection match"
      }
    });
    expect(
      semanticEvents.rows.map((row) => ({
        semantic_unit_type: row.semantic_unit_type
      }))
    ).toEqual([
      { semantic_unit_type: "user_turn" },
      { semantic_unit_type: "agent_turn" }
    ]);
    expect(threads[0]?.threads[0]).toMatchObject({
      eventCount: 2,
      sample: '{"cmd":"rg projection"} projection match Display reply'
    });

    const agentSemanticEventId = semanticEvents.rows.find(
      (row) => row.semantic_unit_type === "agent_turn"
    )?.id;
    if (!agentSemanticEventId) {
      throw new Error("Expected projected agent semantic event");
    }
    const node = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText: "Display reply node",
        captureMethod: "hook",
        sourceRuntime: "codex"
      }
    );
    await pool.query(
      `
        insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
        values ($1, $2, 0)
      `,
      [node.id, agentSemanticEventId]
    );
    await pool.query(
      `
        insert into memory_embeddings (
          memory_event_id, owner_user_id, visibility, embedding_model,
          embedding_dimensions, embedding_version, source_hash,
          source_chunk_index, source_chunk_count, source_text
        )
        values ($1, $2, 'personal', 'test-model', 384, 'test-version', $3, 0, 1, 'Display reply')
      `,
      [agentSemanticEventId, alice.id, `display-semantic-${randomUUID()}`]
    );
    await pool.query(
      `
        insert into memory_embeddings (
          memory_node_id, owner_user_id, visibility, embedding_model,
          embedding_dimensions, embedding_version, source_hash,
          source_chunk_index, source_chunk_count, source_text
        )
        values ($1, $2, 'personal', 'test-model', 384, 'test-version', $3, 0, 1, 'Display reply node')
      `,
      [node.id, alice.id, `display-node-${randomUUID()}`]
    );

    const previousRebuildDebounce =
      process.env.SEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS;
    process.env.SEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS = "0";
    try {
      expect(
        await repo.invalidateLcmGraphEvent(
          { userId: alice.id },
          timelineEvents[1]!.id
        )
      ).toBe(true);
    } finally {
      if (previousRebuildDebounce === undefined) {
        delete process.env.SEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS;
      } else {
        process.env.SEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS =
          previousRebuildDebounce;
      }
    }
    const invalidated = await pool.query<{
      id: string;
      semantic_unit_type: string | null;
      invalidated_at: Date | null;
      invalidation_reason: string | null;
    }>(
      `
        select
          id,
          payload #>> '{metadata,semanticUnitType}' as semantic_unit_type,
          invalidated_at,
          invalidation_reason
        from memory_events
        where session_id = $1
        order by source_sequence asc nulls last, created_at asc
      `,
      [session.id]
    );
    const invalidatedEmbeddings = await pool.query<{ count: string }>(
      `
        select count(*)::text as count
        from memory_embeddings
        where invalidated_at is not null
          and (
            memory_event_id = $1
            or memory_node_id = $2
          )
      `,
      [agentSemanticEventId, node.id]
    );
    const queuedRebuild = await pool.query<{
      status: string;
      scheduled_after: Date;
    }>(
      `
        select status, scheduled_after
        from semantic_memory_rebuild_jobs
        where memory_event_id = $1
      `,
      [agentSemanticEventId]
    );
    const invalidatedNode = await pool.query<{
      invalidated_at: Date | null;
      invalidation_reason: string | null;
    }>(
      "select invalidated_at, invalidation_reason from memory_nodes where id = $1",
      [node.id]
    );

    expect(invalidated.rows[0]?.semantic_unit_type).toBe("user_turn");
    expect(invalidated.rows[0]?.invalidated_at).toBeNull();
    expect(invalidated.rows[0]?.invalidation_reason).toBeNull();
    expect(invalidated.rows[1]?.semantic_unit_type).toBe("agent_turn");
    expect(invalidated.rows[1]?.invalidated_at).toBeInstanceOf(Date);
    expect(invalidated.rows[1]?.invalidation_reason).toBe(
      "source_event_deleted"
    );
    expect(invalidatedEmbeddings.rows[0]?.count).toBe("2");
    expect(queuedRebuild.rows[0]).toMatchObject({ status: "pending" });
    expect(queuedRebuild.rows[0]?.scheduled_after).toBeInstanceOf(Date);
    expect(invalidatedNode.rows[0]?.invalidated_at).toBeInstanceOf(Date);
    expect(invalidatedNode.rows[0]?.invalidation_reason).toBe(
      "source_event_deleted"
    );

    const rebuildResult = await repo.processDueSemanticMemoryRebuilds(
      { userId: alice.id },
      { limit: 10 }
    );
    expect(rebuildResult).toMatchObject({
      jobsClaimed: 1,
      jobsCompleted: 1,
      jobsFailed: 0,
      memoryEventsCreated: 1
    });
    const replacementEventId = rebuildResult.memoryEventIds[0];
    if (!replacementEventId) {
      throw new Error("Expected replacement semantic Memory Event");
    }
    const rebuiltEvents = await pool.query<{
      id: string;
      content: string;
      semantic_unit_type: string | null;
      rebuilt_from: string | null;
      rebuild_reason: string | null;
      invalidated_at: Date | null;
    }>(
      `
        select
          id,
          payload ->> 'content' as content,
          payload #>> '{metadata,semanticUnitType}' as semantic_unit_type,
          payload #>> '{metadata,semanticBundleRebuiltFromMemoryEventId}' as rebuilt_from,
          payload #>> '{metadata,semanticBundleRebuildReason}' as rebuild_reason,
          invalidated_at
        from memory_events
        where session_id = $1
        order by created_at asc
      `,
      [session.id]
    );
    const replacement = rebuiltEvents.rows.find(
      (row) => row.id === replacementEventId
    );
    expect(replacement).toMatchObject({
      semantic_unit_type: "agent_turn",
      rebuilt_from: agentSemanticEventId,
      rebuild_reason: "source_event_deleted",
      invalidated_at: null
    });
    expect(replacement?.content).toContain("Display reply");
    expect(replacement?.content).not.toContain('{"cmd":"rg projection"}');
    expect(replacement?.content).not.toContain("projection match");
    const rebuildJob = await pool.query<{
      status: string;
      replacement_memory_event_ids: string[];
    }>(
      `
        select status, replacement_memory_event_ids
        from semantic_memory_rebuild_jobs
        where memory_event_id = $1
      `,
      [agentSemanticEventId]
    );
    expect(rebuildJob.rows[0]).toEqual({
      status: "completed",
      replacement_memory_event_ids: [replacementEventId]
    });
    const replacementSource = await repo.getEmbeddableSource(
      "memory_event",
      replacementEventId
    );
    expect(replacementSource?.text).toBe(replacement?.content);
    if (!replacementSource) {
      throw new Error("Expected rebuilt Memory Event to be embeddable");
    }
    const storedEmbedding = await repo.upsertSourceEmbedding({
      source: replacementSource,
      model: "test-model",
      dimensions: 384,
      version: "test-version",
      vector: Array.from({ length: 384 }, () => 0)
    });
    expect(storedEmbedding.inserted).toBe(true);

    await pool.query(
      `
        insert into memory_embeddings (
          message_id, owner_user_id, visibility, embedding_model,
          embedding_dimensions, embedding_version, source_hash,
          source_chunk_index, source_chunk_count, source_text
        )
        values ($1, $2, 'personal', 'test-model', 384, 'test-version', $3, 0, 1, 'Display reply')
      `,
      [timelineEvents[2]!.id, alice.id, `display-message-${randomUUID()}`]
    );

    const previousMessageRebuildDebounce =
      process.env.SEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS;
    process.env.SEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS = "0";
    try {
      expect(
        await repo.invalidateLcmGraphEvent(
          { userId: alice.id },
          timelineEvents[2]!.id
        )
      ).toBe(true);
    } finally {
      if (previousMessageRebuildDebounce === undefined) {
        delete process.env.SEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS;
      } else {
        process.env.SEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS =
          previousMessageRebuildDebounce;
      }
    }

    const messageDeleteState = await pool.query<{
      replacement_invalidated_at: Date | null;
      replacement_invalidation_reason: string | null;
      invalidated_message_embeddings: string;
    }>(
      `
        select
          me.invalidated_at as replacement_invalidated_at,
          me.invalidation_reason as replacement_invalidation_reason,
          (
            select count(*)::text
            from memory_embeddings emb
            where emb.message_id = $2
              and emb.invalidated_at is not null
          ) as invalidated_message_embeddings
        from memory_events me
        where me.id = $1
      `,
      [replacementEventId, timelineEvents[2]!.id]
    );
    expect(
      messageDeleteState.rows[0]?.replacement_invalidated_at
    ).toBeInstanceOf(Date);
    expect(messageDeleteState.rows[0]?.replacement_invalidation_reason).toBe(
      "source_event_deleted"
    );
    expect(messageDeleteState.rows[0]?.invalidated_message_embeddings).toBe(
      "1"
    );

    const messageRebuildResult = await repo.processDueSemanticMemoryRebuilds(
      { userId: alice.id },
      { limit: 10 }
    );
    expect(messageRebuildResult).toMatchObject({
      jobsClaimed: 1,
      jobsCompleted: 1,
      jobsFailed: 0,
      memoryEventsCreated: 0,
      memoryEventIds: []
    });
  });

  it("does not project hook-only tool payloads into semantic memory or tool events", async () => {
    const previousStaleMs = process.env.MEMORY_AGENT_TURN_STALE_MS;
    process.env.MEMORY_AGENT_TURN_STALE_MS = "1";
    try {
      const alice = await repo.createUser({
        email: `alice-hook-tool-fallback-${randomUUID()}@example.com`
      });
      const workspaceId = randomUUID();
      await pool.query(
        `
          insert into workspaces (id, owner_user_id, visibility, name)
          values ($1, $2, 'personal', 'Hook Tool Project')
        `,
        [workspaceId, alice.id]
      );
      const session = await repo.createCapturedSession(
        { userId: alice.id },
        {
          workspaceId,
          externalSessionId: `hook-tool-fallback-${randomUUID()}`,
          sourceRuntime: "codex-cli",
          captureMethod: "hook",
          idempotencyKey: `hook-tool-fallback-session-${randomUUID()}`
        }
      );
      const staleEventTime = new Date(Date.now() - 60_000).toISOString();
      await repo.createConversationItems(
        { userId: alice.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-hook-v1",
              sourceTransport: "hook",
              externalSessionId: session.externalSessionId ?? undefined,
              externalThreadId: session.externalSessionId ?? undefined,
              externalTurnId: "hook-tool-turn-1",
              sourceRecordType: "hook_payload",
              sourceEventType: "PostToolUse",
              sourceSequence: 1,
              eventTime: staleEventTime,
              rawJson: {
                hook_event_name: "PostToolUse",
                tool_use_id: "toolu-hook-1",
                tool_name: "exec_command",
                tool_input: { cmd: "git status --short" },
                tool_response: "clean"
              },
              sourceHash: `hook-tool-${randomUUID()}`,
              idempotencyKey: `hook-tool-${randomUUID()}`,
              projectionStatus: "pending",
              metadata: { projectName: "Hook Tool Project" }
            },
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-hook-v1",
              sourceTransport: "hook",
              externalSessionId: session.externalSessionId ?? undefined,
              externalThreadId: session.externalSessionId ?? undefined,
              externalTurnId: "hook-tool-turn-2",
              sourceRecordType: "hook_payload",
              sourceEventType: "PostToolUse",
              sourceSequence: 2,
              eventTime: staleEventTime,
              rawJson: {
                hook_event_name: "PostToolUse",
                tool_use_id: "toolu-hook-2",
                tool_name: "exec_command",
                tool_input: { cmd: "git status --branch" }
              },
              sourceHash: `hook-tool-missing-response-${randomUUID()}`,
              idempotencyKey: `hook-tool-missing-response-${randomUUID()}`,
              projectionStatus: "pending",
              metadata: { projectName: "Hook Tool Project" }
            }
          ]
        }
      );

      const projection = await repo.projectPendingConversationItems(
        { userId: alice.id },
        { limit: 10 }
      );
      const events = await repo.listLcmGraphEvents(
        { userId: alice.id },
        {
          projectId: workspaceId,
          threadId: session.externalSessionId ?? undefined,
          limit: 10
        }
      );
      const memoryEvents = await pool.query<{
        actor: string | null;
        content: string;
        semantic_unit_type: string | null;
        sealed_reason: string | null;
      }>(
        `
          select
            payload ->> 'actor' as actor,
            payload ->> 'content' as content,
            payload #>> '{metadata,semanticUnitType}' as semantic_unit_type,
            seal_reason as sealed_reason
          from memory_events
          where session_id = $1
          order by created_at asc, id asc
        `,
        [session.id]
      );
      const toolEvents = await pool.query<{
        tool_name: string;
        tool_input: unknown;
        tool_response: unknown;
      }>(
        `
          select tool_name, tool_input, tool_response
          from tool_events
          where session_id = $1
          order by transcript_item_id asc nulls last, id asc
        `,
        [session.id]
      );

      expect(projection).toMatchObject({
        rawItemsProjected: 2,
        messagesCreated: 0,
        toolEventsCreated: 0,
        memoryEventsCreated: 0
      });
      expect(events.map((event) => event.contentPreview)).toEqual([]);
      expect(memoryEvents.rows).toEqual([]);
      expect(toolEvents.rows).toEqual([]);
    } finally {
      if (previousStaleMs === undefined) {
        delete process.env.MEMORY_AGENT_TURN_STALE_MS;
      } else {
        process.env.MEMORY_AGENT_TURN_STALE_MS = previousStaleMs;
      }
    }
  });

  it("bundles complete agent turns across projection limits in source order", async () => {
    const alice = await repo.createUser({
      email: `alice-complete-turn-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Complete Turn Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `complete-turn-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `complete-turn-session-${randomUUID()}`
      }
    );
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "turn-limit-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 3,
            rawJson: {
              method: "item/completed",
              params: { item: { type: "agentMessage", text: "third" } }
            },
            rawText: "third",
            sourceHash: `complete-third-${randomUUID()}`,
            idempotencyKey: `complete-third-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: { transcriptType: "agent_message" }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "turn-limit-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 1,
            rawJson: {
              method: "item/completed",
              params: { item: { type: "agentMessage", text: "first" } }
            },
            rawText: "first",
            sourceHash: `complete-first-${randomUUID()}`,
            idempotencyKey: `complete-first-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: { transcriptType: "agent_message" }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "turn-limit-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 2,
            rawJson: {
              method: "item/completed",
              params: { item: { type: "agentMessage", text: "second" } }
            },
            rawText: "second",
            sourceHash: `complete-second-${randomUUID()}`,
            idempotencyKey: `complete-second-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: { transcriptType: "agent_message" }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "turn-limit-1",
            sourceRecordType: "hook_payload",
            sourceEventType: "Stop",
            sourceSequence: 4,
            rawJson: { hook_event_name: "Stop", turn_id: "turn-limit-1" },
            sourceHash: `complete-stop-${randomUUID()}`,
            idempotencyKey: `complete-stop-${randomUUID()}`,
            projectionStatus: "pending"
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 1 }
    );
    const events = await repo.listLcmGraphEvents(
      { userId: alice.id },
      {
        projectId: workspaceId,
        threadId: session.externalSessionId ?? undefined,
        limit: 10
      }
    );
    const statuses = await pool.query<{
      projection_status: string;
      count: string;
    }>(
      `
        select projection_status, count(*)::text as count
        from conversation_items
        where session_id = $1
        group by projection_status
      `,
      [session.id]
    );
    const eventContent = await pool.query<{ content: string }>(
      `
        select payload ->> 'content' as content
        from memory_events
        where session_id = $1
        order by captured_at asc, id asc
      `,
      [session.id]
    );

    expect(projection.rawItemsScanned).toBe(4);
    expect(projection.memoryEventsCreated).toBe(1);
    expect(
      [...events]
        .sort(
          (left, right) =>
            (left.sourceSequence ?? 0) - (right.sourceSequence ?? 0)
        )
        .map((event) => event.contentPreview)
    ).toEqual(["first", "second", "third"]);
    expect(eventContent.rows.map((row) => row.content)).toEqual([
      "first\n\nsecond\n\nthird"
    ]);
    expect(statuses.rows).toEqual([
      { projection_status: "projected", count: "4" }
    ]);
  });

  it("does not seal agent turns on boundary changes or batch end", async () => {
    const alice = await repo.createUser({
      email: `alice-projection-no-internal-seal-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `projection-no-internal-seal-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `projection-no-internal-seal-session-${randomUUID()}`
      }
    );
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "first-unsealed-turn",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 0,
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  type: "agentMessage",
                  text: "First agent turn is still in progress."
                }
              }
            },
            rawText: "First agent turn is still in progress.",
            sourceHash: `projection-no-internal-first-${randomUUID()}`,
            idempotencyKey: `projection-no-internal-first-${randomUUID()}`,
            metadata: { transcriptType: "agent_message" }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "second-unsealed-turn",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 1,
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  type: "agentMessage",
                  text: "Second agent turn is also still in progress."
                }
              }
            },
            rawText: "Second agent turn is also still in progress.",
            sourceHash: `projection-no-internal-second-${randomUUID()}`,
            idempotencyKey: `projection-no-internal-second-${randomUUID()}`,
            metadata: { transcriptType: "agent_message" }
          }
        ]
      }
    );
    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const messages = await pool.query<{ content: string }>(
      "select content from messages where session_id = $1 order by created_at asc",
      [session.id]
    );
    const events = await pool.query<{ seal_reason: string | null }>(
      `
        select seal_reason
        from memory_events
        where session_id = $1
          and payload #>> '{metadata,semanticUnitType}' = 'agent_turn'
      `,
      [session.id]
    );
    const statuses = await pool.query<{
      projection_status: string;
      count: string;
    }>(
      `
        select projection_status, count(*)::text as count
        from conversation_items
        where session_id = $1
        group by projection_status
      `,
      [session.id]
    );

    expect(projection.messagesCreated).toBe(2);
    expect(projection.memoryEventsCreated).toBe(0);
    expect(messages.rows.map((row) => row.content)).toEqual([
      "First agent turn is still in progress.",
      "Second agent turn is also still in progress."
    ]);
    expect(events.rows).toEqual([]);
    expect(statuses.rows).toEqual([
      { projection_status: "pending", count: "2" }
    ]);
  });

  it("ignores later hook payload content after transcript-derived agent memory exists", async () => {
    const alice = await repo.createUser({
      email: `alice-projection-suppress-hook-control-only-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `projection-suppress-hook-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `projection-suppress-hook-session-${randomUUID()}`
      }
    );
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "turn-with-transcript-memory",
            sourceRecordType: "event_msg",
            sourceEventType: "agent_message",
            sourceSequence: 0,
            eventTime: "2026-04-01T12:00:00.000Z",
            rawJson: {
              type: "event_msg",
              payload: {
                type: "agent_message",
                message:
                  "Transcript-derived answer should be the only semantic bundle."
              }
            },
            rawText:
              "Transcript-derived answer should be the only semantic bundle.",
            sourceHash: `projection-suppress-transcript-${randomUUID()}`,
            idempotencyKey: `projection-suppress-transcript-${randomUUID()}`,
            metadata: { transcriptType: "agent_message" }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "turn-with-transcript-memory",
            sourceRecordType: "hook_payload",
            sourceEventType: "Stop",
            sourceSequence: 1,
            rawJson: {
              hook_event_name: "Stop",
              turn_id: "turn-with-transcript-memory"
            },
            sourceHash: `projection-suppress-stop-${randomUUID()}`,
            idempotencyKey: `projection-suppress-stop-${randomUUID()}`,
            metadata: { hookEventName: "Stop" }
          }
        ]
      }
    );

    const transcriptProjection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );

    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "turn-with-transcript-memory",
            sourceRecordType: "hook_payload",
            sourceEventType: "PostToolUse",
            sourceSequence: 2,
            rawJson: {
              hook_event_name: "PostToolUse",
              tool_use_id: "toolu-suppressed-hook",
              tool_name: "exec_command",
              tool_input: { cmd: "git status --short" },
              tool_response: "clean"
            },
            sourceHash: `projection-suppress-hook-tool-${randomUUID()}`,
            idempotencyKey: `projection-suppress-hook-tool-${randomUUID()}`,
            metadata: {}
          }
        ]
      }
    );

    const hookProjection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const memoryEvents = await pool.query<{
      content: string;
      seal_reason: string | null;
      source_records: string[];
    }>(
      `
        select
          me.payload ->> 'content' as content,
          me.seal_reason,
          array_agg(ci.source_record_type order by mes.source_order) as source_records
        from memory_events me
        join memory_event_sources mes
          on mes.memory_event_id = me.id
        join conversation_items ci
          on ci.id = mes.conversation_item_id
        where me.session_id = $1
          and me.payload #>> '{metadata,semanticUnitType}' = 'agent_turn'
        group by me.id
        order by me.created_at asc
      `,
      [session.id]
    );
    const toolEvents = await pool.query<{ count: string }>(
      "select count(*)::text as count from tool_events where session_id = $1",
      [session.id]
    );
    const statuses = await pool.query<{
      source_event_type: string | null;
      projection_status: string;
    }>(
      `
        select source_event_type, projection_status
        from conversation_items
        where session_id = $1
        order by source_sequence asc
      `,
      [session.id]
    );

    expect(transcriptProjection.memoryEventsCreated).toBe(1);
    expect(hookProjection.memoryEventsCreated).toBe(0);
    expect(hookProjection.toolEventsCreated).toBe(0);
    expect(memoryEvents.rows).toEqual([
      {
        content:
          "Transcript-derived answer should be the only semantic bundle.",
        seal_reason: "stop_hook",
        source_records: ["event_msg"]
      }
    ]);
    expect(toolEvents.rows[0]?.count).toBe("0");
    expect(statuses.rows).toEqual([
      { source_event_type: "agent_message", projection_status: "projected" },
      { source_event_type: "Stop", projection_status: "projected" },
      { source_event_type: "PostToolUse", projection_status: "projected" }
    ]);
  });

  it("keeps Stop control records from creating cross-thread fallback memory", async () => {
    const alice = await repo.createUser({
      email: `alice-projection-boundary-hook-control-${randomUUID()}@example.com`
    });
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: "boundary-thread-a",
        sourceRuntime: "codex",
        idempotencyKey: `projection-boundary-hook-control-session-${randomUUID()}`
      }
    );
    const [transcriptItem] = await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalThreadId: "boundary-thread-a",
            externalTurnId: "shared-turn",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 0,
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  type: "agentMessage",
                  text: "Thread A transcript memory."
                }
              }
            },
            rawText: "Thread A transcript memory.",
            sourceHash: `projection-boundary-transcript-${randomUUID()}`,
            idempotencyKey: `projection-boundary-transcript-${randomUUID()}`,
            metadata: {
              workspaceId: workspaceA,
              transcriptType: "agent_message"
            }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalThreadId: "boundary-thread-a",
            externalTurnId: "shared-turn",
            sourceRecordType: "hook_payload",
            sourceEventType: "Stop",
            sourceSequence: 1,
            rawJson: { hook_event_name: "Stop", turn_id: "shared-turn" },
            sourceHash: `projection-boundary-stop-a-${randomUUID()}`,
            idempotencyKey: `projection-boundary-stop-a-${randomUUID()}`,
            metadata: {
              workspaceId: workspaceA,
              hookEventName: "Stop"
            }
          }
        ]
      }
    );

    const transcriptProjection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    if (!transcriptItem?.turnId) {
      throw new Error("Expected transcript item to create a turn");
    }

    await expect(
      repo.createConversationItems(
        { userId: alice.id },
        {
          items: [
            {
              sessionId: session.id,
              turnId: transcriptItem.turnId,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-hook-v1",
              sourceTransport: "hook",
              externalThreadId: "boundary-thread-b",
              externalTurnId: "shared-turn",
              sourceRecordType: "hook_payload",
              sourceEventType: "Stop",
              sourceSequence: 2,
              rawJson: {
                hook_event_name: "Stop",
                last_assistant_message: "Thread B hook content must be ignored."
              },
              rawText: "Thread B hook content must be ignored.",
              sourceHash: `projection-boundary-stop-b-${randomUUID()}`,
              idempotencyKey: `projection-boundary-stop-b-${randomUUID()}`,
              metadata: {
                workspaceId: workspaceB,
                hookEventName: "Stop"
              }
            }
          ]
        }
      )
    ).rejects.toMatchObject({ code: "conversation_session_thread_mismatch" });

    const afterRejectedHook = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const memoryEvents = await pool.query<{
      content: string;
      external_thread_id: string | null;
      workspace_id: string | null;
      seal_reason: string | null;
    }>(
      `
        select
          payload ->> 'content' as content,
          payload #>> '{metadata,externalThreadId}' as external_thread_id,
          payload ->> 'workspaceId' as workspace_id,
          seal_reason
        from memory_events
        where session_id = $1
          and payload #>> '{metadata,semanticUnitType}' = 'agent_turn'
        order by source_sequence asc nulls last, created_at asc
      `,
      [session.id]
    );

    expect(transcriptProjection.memoryEventsCreated).toBe(1);
    expect(afterRejectedHook.memoryEventsCreated).toBe(0);
    expect(memoryEvents.rows).toEqual([
      {
        content: "Thread A transcript memory.",
        external_thread_id: "boundary-thread-a",
        workspace_id: "conversation-projection",
        seal_reason: "stop_hook"
      }
    ]);
  });

  it("stores raw conversation items idempotently and links projected memory events to sources", async () => {
    const alice = await repo.createUser({
      email: `alice-raw-conversation-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Raw Conversation Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: "codex-thread-1",
        sourceRuntime: "codex",
        idempotencyKey: `session-${randomUUID()}`
      }
    );
    const idempotencyKey = `raw-item-${randomUUID()}`;
    const [rawItem] = await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalSessionId: "codex-thread-1",
            externalThreadId: "codex-thread-1",
            externalTurnId: "turn-1",
            externalItemId: "item-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/agentMessage/delta",
            sourceSequence: 1,
            eventTime: new Date().toISOString(),
            rawJson: {
              method: "item/agentMessage/delta",
              params: { delta: "Hello from raw Codex output." }
            },
            rawText: "Hello from raw Codex output.",
            sourceHash: `source-${idempotencyKey}`,
            idempotencyKey,
            projectionStatus: "pending",
            metadata: { workflow: "test" }
          }
        ]
      }
    );
    const [duplicateRawItem] = await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalSessionId: "codex-thread-1",
            externalThreadId: "codex-thread-1",
            externalTurnId: "turn-1",
            externalItemId: "item-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/agentMessage/delta",
            sourceSequence: 1,
            rawJson: {
              method: "item/agentMessage/delta",
              params: { delta: "Hello from raw Codex output." }
            },
            rawText: "Hello from raw Codex output.",
            sourceHash: `source-${idempotencyKey}`,
            idempotencyKey,
            projectionStatus: "projected"
          }
        ]
      }
    );
    const projected = await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId,
        sessionId: session.id,
        actor: "assistant",
        eventType: "captured",
        rawEventType: "agent_message",
        visibility: "personal",
        content: "Hello from raw Codex output.",
        idempotencyKey: `projected-${randomUUID()}`,
        sourceHash: `projected-source-${randomUUID()}`,
        metadata: { rawConversationItemId: rawItem!.id }
      }
    );
    const rawCount = await pool.query<{ count: string }>(
      "select count(*)::text as count from conversation_items where idempotency_key = $1",
      [idempotencyKey]
    );
    const rawStatus = await pool.query<{
      projection_status: string;
      turn_id: string | null;
      turn_index: number | null;
    }>(
      `
        select ci.projection_status, ci.turn_id, t.turn_index
        from conversation_items ci
        left join turns t on t.id = ci.turn_id
        where ci.id = $1
      `,
      [rawItem!.id]
    );
    const links = await pool.query<{
      memory_event_id: string;
      conversation_item_id: string;
      source_order: number;
    }>(
      `
        select memory_event_id, conversation_item_id, source_order
        from memory_event_sources
        where memory_event_id = $1
      `,
      [projected.id]
    );

    expect(rawItem?.id).toBeTruthy();
    expect(duplicateRawItem?.id).toBe(rawItem?.id);
    expect(rawCount.rows[0]?.count).toBe("1");
    expect(rawStatus.rows[0]?.projection_status).toBe("pending");
    expect(rawStatus.rows[0]?.turn_id).toBeTruthy();
    expect(rawStatus.rows[0]?.turn_index).toBe(0);
    expect(links.rows).toEqual([
      {
        memory_event_id: projected.id,
        conversation_item_id: rawItem!.id,
        source_order: 0
      }
    ]);

    const bob = await repo.createUser({
      email: `bob-raw-item-${randomUUID()}@example.com`
    });
    const bobSession = await repo.createCapturedSession(
      { userId: bob.id },
      {
        workspaceId,
        externalSessionId: `bob-codex-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `bob-session-${randomUUID()}`
      }
    );
    const [bobRawItem] = await repo.createConversationItems(
      { userId: bob.id },
      {
        items: [
          {
            sessionId: bobSession.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            sourceRecordType: "app_server_notification",
            rawJson: { owner: "bob" },
            sourceHash: `bob-source-${idempotencyKey}`,
            idempotencyKey,
            projectionStatus: "pending"
          }
        ]
      }
    );
    expect(bobRawItem?.id).toBeTruthy();
    expect(bobRawItem?.id).not.toBe(rawItem?.id);
  });

  it("scopes Captured Session idempotency and source hashes to the owner", async () => {
    const alice = await repo.createUser({
      email: `alice-session-scope-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-session-scope-${randomUUID()}@example.com`
    });
    const sharedIdempotencyKey = `shared-session-${randomUUID()}`;
    const sharedSourceHash = `shared-source-${randomUUID()}`;
    const aliceSession = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: "alice-thread",
        sourceRuntime: "codex",
        idempotencyKey: sharedIdempotencyKey,
        sourceHash: sharedSourceHash
      }
    );
    const bobSession = await repo.createCapturedSession(
      { userId: bob.id },
      {
        externalSessionId: "bob-thread",
        sourceRuntime: "codex",
        idempotencyKey: sharedIdempotencyKey,
        sourceHash: sharedSourceHash
      }
    );

    expect(bobSession.id).not.toBe(aliceSession.id);
    expect(bobSession.externalSessionId).toBe("bob-thread");
    const rows = await pool.query<{
      owner_user_id: string;
      external_session_id: string;
    }>(
      `
        select owner_user_id, external_session_id
        from sessions
        where idempotency_key = $1
        order by owner_user_id
      `,
      [sharedIdempotencyKey]
    );
    expect(rows.rows).toEqual(
      [
        { owner_user_id: alice.id, external_session_id: "alice-thread" },
        { owner_user_id: bob.id, external_session_id: "bob-thread" }
      ].sort((left, right) =>
        left.owner_user_id.localeCompare(right.owner_user_id)
      )
    );
  });

  it("reconciles app-server lifecycle and transcript observations into one canonical item", async () => {
    const owner = await repo.createUser({
      email: `canonical-observations-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: `canonical-thread-${randomUUID()}`,
        sourceRuntime: "codex",
        captureMethod: "api"
      }
    );
    const threadId = session.externalSessionId!;
    const canonicalItemKey = codexCanonicalConversationItemKey({
      externalThreadId: threadId,
      externalTurnId: "turn-1",
      stableItemId: "message-1",
      component: "message"
    });
    const completedSourceHash = `app-completed-${randomUUID()}`;
    const completedIdempotencyKey = `app-observation-${randomUUID()}`;
    const base = {
      sessionId: session.id,
      sourceKind: "codex",
      externalSessionId: threadId,
      externalThreadId: threadId,
      externalTurnId: "turn-1",
      externalItemId: "message-1",
      canonicalItemKey,
      canonicalStableItemId: "message-1",
      observationComponent: "message",
      projectionVersion: "codex-app-server-conversation-v1",
      metadata: { transcriptType: "agent_message" }
    } as const;

    const [started] = await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          {
            ...base,
            sourceAdapterVersion: "codex-app-server-conversation-v1",
            sourceTransport: "app_server",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/started",
            sourceSequence: 1,
            observedAt: "2026-07-11T10:00:00.000Z",
            rawJson: {
              method: "item/started",
              params: {
                item: { id: "message-1", type: "agentMessage", text: "" }
              }
            },
            sourceHash: `app-started-${randomUUID()}`,
            idempotencyKey: `app-observation-${randomUUID()}`,
            canonicalSourcePriority: 100,
            observationKind: "lifecycle_started",
            projectionStatus: "raw_only"
          }
        ]
      }
    );
    const [completed] = await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          {
            ...base,
            sourceAdapterVersion: "codex-app-server-conversation-v1",
            sourceTransport: "app_server",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 2,
            eventTime: "2026-07-11T09:59:58.500Z",
            observedAt: "2026-07-11T10:00:01.000Z",
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  id: "message-1",
                  type: "agentMessage",
                  text: "Canonical answer"
                }
              }
            },
            rawText: "Canonical answer",
            sourceHash: completedSourceHash,
            idempotencyKey: completedIdempotencyKey,
            canonicalSourcePriority: 300,
            observationKind: "lifecycle_completed",
            projectionStatus: "pending"
          }
        ]
      }
    );
    const [reconciled] = await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          {
            ...base,
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "transcript",
            sourceRecordType: "response_item",
            sourceEventType: "message",
            sourcePath: "/tmp/canonical-thread.jsonl",
            sourceLineNumber: 4,
            sourceSequence: 8,
            eventTime: "2026-07-11T09:59:59.000Z",
            observedAt: "2026-07-11T10:00:02.000Z",
            rawJson: {
              timestamp: "2026-07-11T09:59:59.000Z",
              type: "response_item",
              payload: {
                id: "message-1",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Canonical answer" }]
              }
            },
            rawText: "Canonical answer",
            sourceHash: `transcript-${randomUUID()}`,
            idempotencyKey: `transcript-observation-${randomUUID()}`,
            canonicalSourcePriority: 200,
            observationKind: "reconciliation",
            projectionStatus: "pending",
            projectionVersion: "codex-transcript-v1",
            metadata: { transcriptType: "message" }
          }
        ]
      }
    );

    expect(started!.id).toBe(completed!.id);
    expect(reconciled!.id).toBe(completed!.id);
    const canonical = await pool.query<{
      canonical_source_priority: number;
      source_transport: string;
      raw_text: string | null;
      event_time: Date | null;
      observed_at: Date;
      canonical_stable_item_id: string | null;
      transcript_type: string | null;
    }>(
      `
        select
          canonical_source_priority,
          source_transport,
          raw_text,
          event_time,
          observed_at,
          canonical_stable_item_id,
          metadata ->> 'transcriptType' as transcript_type
        from conversation_items
        where id = $1
      `,
      [completed!.id]
    );
    expect(canonical.rows[0]).toMatchObject({
      canonical_source_priority: 300,
      source_transport: "app_server",
      raw_text: "Canonical answer",
      canonical_stable_item_id: "message-1",
      transcript_type: "agent_message"
    });
    expect(canonical.rows[0]!.event_time?.toISOString()).toBe(
      "2026-07-11T09:59:58.500Z"
    );
    expect(canonical.rows[0]!.observed_at.toISOString()).toBe(
      "2026-07-11T10:00:00.000Z"
    );

    const observations = await pool.query<{
      conversation_item_id: string;
      observation_kind: string;
      ingestion_status: string;
      source_transport: string;
      canonical_stable_item_id: string | null;
    }>(
      `
        select
          conversation_item_id,
          observation_kind,
          ingestion_status,
          source_transport,
          canonical_stable_item_id
        from conversation_item_observations
        where conversation_item_id = $1
        order by observed_at asc
      `,
      [completed!.id]
    );
    expect(observations.rows).toEqual([
      {
        conversation_item_id: completed!.id,
        observation_kind: "lifecycle_started",
        ingestion_status: "persisted",
        source_transport: "app_server",
        canonical_stable_item_id: "message-1"
      },
      {
        conversation_item_id: completed!.id,
        observation_kind: "lifecycle_completed",
        ingestion_status: "persisted",
        source_transport: "app_server",
        canonical_stable_item_id: "message-1"
      },
      {
        conversation_item_id: completed!.id,
        observation_kind: "reconciliation",
        ingestion_status: "persisted",
        source_transport: "transcript",
        canonical_stable_item_id: "message-1"
      }
    ]);

    const [duplicate] = await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          {
            ...base,
            sourceAdapterVersion: "codex-app-server-conversation-v1",
            sourceTransport: "app_server",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 2,
            eventTime: "2026-07-11T09:59:58.500Z",
            observedAt: "2026-07-11T10:00:09.000Z",
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  id: "message-1",
                  type: "agentMessage",
                  text: "Canonical answer"
                }
              }
            },
            rawText: "Canonical answer",
            sourceHash: completedSourceHash,
            idempotencyKey: completedIdempotencyKey,
            canonicalSourcePriority: 300,
            observationKind: "lifecycle_completed",
            projectionStatus: "pending"
          }
        ]
      }
    );
    expect(duplicate!.id).toBe(completed!.id);
    const observationCount = await pool.query<{
      count: number;
      immutable: boolean;
    }>(
      `
        select
          count(*)::int as count,
          bool_and(updated_at = created_at) as immutable
        from conversation_item_observations
        where conversation_item_id = $1
      `,
      [completed!.id]
    );
    expect(observationCount.rows[0]?.count).toBe(3);
    expect(observationCount.rows[0]?.immutable).toBe(true);
    await expect(
      pool.query(
        `
          update conversation_item_observations
          set source_hash = 'mutated-source-hash'
          where source_idempotency_key = $1
        `,
        [completedIdempotencyKey]
      )
    ).rejects.toThrow("conversation observations are immutable");

    await expect(
      repo.createConversationItems(
        { userId: owner.id },
        {
          items: [
            {
              ...base,
              sourceAdapterVersion: "codex-app-server-conversation-v1",
              sourceTransport: "app_server",
              sourceRecordType: "app_server_notification",
              sourceEventType: "item/completed",
              sourceSequence: 2,
              rawJson: { tampered: true },
              rawText: "Tampered answer",
              sourceHash: `tampered-${randomUUID()}`,
              idempotencyKey: completedIdempotencyKey,
              canonicalSourcePriority: 300,
              observationKind: "lifecycle_completed",
              projectionStatus: "pending"
            }
          ]
        }
      )
    ).rejects.toThrow("Source observation identity conflicts");

    const unresolvedObservationKey = `unresolved-${randomUUID()}`;
    const unresolved = await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          {
            observationOnly: true,
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-conversation-v1",
            sourceTransport: "app_server",
            externalSessionId: threadId,
            externalThreadId: threadId,
            externalTurnId: "turn-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 3,
            rawJson: { method: "item/completed", params: { item: {} } },
            sourceHash: `unresolved-${randomUUID()}`,
            idempotencyKey: unresolvedObservationKey,
            observationKind: "control",
            observationComponent: "unresolved",
            projectionStatus: "raw_only",
            metadata: { identityResolution: "unresolved" }
          }
        ]
      }
    );
    expect(unresolved).toEqual([]);
    const unresolvedStatus = await pool.query<{
      ingestion_status: string;
      conversation_item_id: string | null;
    }>(
      `
        select ingestion_status, conversation_item_id
        from conversation_item_observations
        where source_idempotency_key = $1
      `,
      [unresolvedObservationKey]
    );
    expect(unresolvedStatus.rows).toEqual([
      {
        ingestion_status: "identity_unresolved",
        conversation_item_id: null
      }
    ]);

    await expect(
      repo.createConversationItems(
        { userId: owner.id },
        {
          items: [
            {
              ...base,
              sourceAdapterVersion: "codex-app-server-conversation-v1",
              sourceTransport: "app_server",
              sourceRecordType: "app_server_notification",
              sourceEventType: "item/completed",
              sourceSequence: 4,
              rawJson: { method: "item/completed" },
              rawText: "Forged canonical identity",
              sourceHash: `forged-${randomUUID()}`,
              idempotencyKey: `forged-${randomUUID()}`,
              canonicalItemKey: `conversation-item:${"0".repeat(64)}`,
              observationKind: "lifecycle_completed",
              projectionStatus: "pending"
            }
          ]
        }
      )
    ).rejects.toMatchObject({ code: "canonical_identity_mismatch" });

    const userTurnId = "turn-user-role";
    const clientUserMessageId = "koed-user-message:role-aware-user";
    const userCanonicalKey = codexCanonicalConversationItemKey({
      externalThreadId: threadId,
      externalTurnId: userTurnId,
      stableItemId: clientUserMessageId,
      component: "message"
    });
    const userRows = await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-conversation-v1",
            sourceTransport: "app_server",
            externalSessionId: threadId,
            externalThreadId: threadId,
            externalTurnId: userTurnId,
            externalItemId: "provider-user-item",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  id: "provider-user-item",
                  type: "userMessage",
                  clientId: clientUserMessageId,
                  content: [{ type: "text", text: "Role-aware user" }]
                }
              }
            },
            rawText: "Role-aware user",
            sourceHash: `user-app-${randomUUID()}`,
            idempotencyKey: `user-app-${randomUUID()}`,
            canonicalItemKey: userCanonicalKey,
            canonicalStableItemId: clientUserMessageId,
            observationKind: "lifecycle_completed",
            observationComponent: "message",
            metadata: { transcriptType: "user_message" }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "transcript",
            externalSessionId: threadId,
            externalThreadId: threadId,
            externalTurnId: userTurnId,
            sourceRecordType: "event_msg",
            sourceEventType: "user_message",
            rawJson: {
              type: "event_msg",
              payload: {
                type: "user_message",
                client_id: clientUserMessageId,
                message: "Role-aware user"
              }
            },
            rawText: "Role-aware user",
            sourceHash: `user-transcript-${randomUUID()}`,
            idempotencyKey: `user-transcript-${randomUUID()}`,
            canonicalItemKey: userCanonicalKey,
            canonicalStableItemId: clientUserMessageId,
            observationKind: "reconciliation",
            observationComponent: "message",
            metadata: { transcriptType: "user_message" }
          }
        ]
      }
    );
    expect(userRows[0]!.id).toBe(userRows[1]!.id);
  });

  it("seals one agent-turn bundle from a canonical turn-completed control", async () => {
    const owner = await repo.createUser({
      email: `canonical-turn-seal-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Canonical Turn Seal')
      `,
      [workspaceId, owner.id]
    );
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        workspaceId,
        externalSessionId: `canonical-seal-thread-${randomUUID()}`,
        sourceRuntime: "codex",
        captureMethod: "api",
        metadata: { workspaceId, managedConversation: true }
      }
    );
    const threadId = session.externalSessionId!;
    const turnId = "canonical-seal-turn";
    const turnEventBaseTime = Date.now();
    const controlSourceHash = `canonical-control-${randomUUID()}`;
    const controlIdempotencyKey = `canonical-control-observation-${randomUUID()}`;
    const controlCanonicalItemKey = codexCanonicalConversationItemKey({
      externalThreadId: threadId,
      externalTurnId: turnId,
      stableItemId: `turn:${turnId}:completed`,
      component: "control"
    });
    const controlItem = () => ({
      sessionId: session.id,
      sourceKind: "codex" as const,
      sourceAdapterVersion: "codex-app-server-conversation-v1",
      sourceTransport: "app_server" as const,
      externalSessionId: threadId,
      externalThreadId: threadId,
      externalTurnId: turnId,
      sourceRecordType: "app_server_notification",
      sourceEventType: "turn/completed",
      sourceSequence: 0,
      eventTime: new Date(turnEventBaseTime).toISOString(),
      rawJson: {
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: "completed" } }
      },
      sourceHash: controlSourceHash,
      idempotencyKey: controlIdempotencyKey,
      canonicalItemKey: controlCanonicalItemKey,
      canonicalStableItemId: `turn:${turnId}:completed`,
      canonicalSourcePriority: 300,
      observationKind: "control" as const,
      observationComponent: "control",
      projectionStatus: "pending" as const,
      projectionVersion: "codex-app-server-conversation-v1",
      metadata: {
        workspaceId,
        transcriptType: "turn/completed",
        semanticControl: "turn_completed"
      }
    });
    const reconciledControlItem = () => ({
      ...controlItem(),
      sourceAdapterVersion: "codex-transcript-v1" as const,
      sourceTransport: "transcript" as const,
      sourceRecordType: "event_msg",
      sourceEventType: "task_complete",
      sourcePath: "/tmp/canonical-seal.jsonl",
      sourceLineNumber: 2,
      sourceSequence: 2,
      rawJson: {
        timestamp: new Date(turnEventBaseTime + 1_000).toISOString(),
        type: "event_msg",
        payload: { type: "task_complete", turn_id: turnId }
      },
      sourceHash: `canonical-control-transcript-${randomUUID()}`,
      idempotencyKey: `canonical-control-transcript-${randomUUID()}`,
      observationKind: "reconciliation" as const,
      metadata: { workspaceId, transcriptType: "task_complete" }
    });
    await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-conversation-v1",
            sourceTransport: "app_server",
            externalSessionId: threadId,
            externalThreadId: threadId,
            sourceRecordType: "app_server_notification",
            sourceEventType: "thread/start",
            sourceSequence: 0,
            eventTime: new Date(turnEventBaseTime - 1_000).toISOString(),
            rawJson: {
              method: "thread/start",
              result: { thread: { id: threadId } }
            },
            sourceHash: `canonical-thread-${randomUUID()}`,
            idempotencyKey: `canonical-thread-observation-${randomUUID()}`,
            observationKind: "control",
            observationComponent: "control",
            metadata: {
              workspaceId,
              transcriptType: "thread/start"
            }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-conversation-v1",
            sourceTransport: "app_server",
            externalSessionId: threadId,
            externalThreadId: threadId,
            externalTurnId: turnId,
            externalItemId: "agent-message-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 1,
            eventTime: new Date(turnEventBaseTime + 900).toISOString(),
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  id: "agent-message-1",
                  type: "agentMessage",
                  text: "One canonical agent answer"
                }
              }
            },
            rawText: "One canonical agent answer",
            sourceHash: `canonical-agent-${randomUUID()}`,
            idempotencyKey: `canonical-agent-observation-${randomUUID()}`,
            canonicalItemKey: codexCanonicalConversationItemKey({
              externalThreadId: threadId,
              externalTurnId: turnId,
              stableItemId: "agent-message-1",
              component: "message"
            }),
            canonicalStableItemId: "agent-message-1",
            canonicalSourcePriority: 300,
            observationKind: "lifecycle_completed",
            observationComponent: "message",
            projectionStatus: "pending",
            projectionVersion: "codex-app-server-conversation-v1",
            metadata: {
              workspaceId,
              transcriptType: "agent_message"
            }
          }
        ]
      }
    );

    const earlyProjection = await repo.projectPendingConversationItems(
      { userId: owner.id },
      { limit: 10 }
    );
    const earlyEvents = await pool.query<{ count: string }>(
      "select count(*)::text as count from memory_events where session_id = $1",
      [session.id]
    );
    const earlyMessages = await pool.query<{ content: string }>(
      "select content from messages where session_id = $1",
      [session.id]
    );
    const earlyStatuses = await pool.query<{
      projection_status: string;
      source_event_type: string;
    }>(
      `
        select source_event_type, projection_status
        from conversation_items
        where session_id = $1
        order by source_event_type
      `,
      [session.id]
    );
    expect(earlyProjection.memoryEventsCreated).toBe(0);
    expect(earlyMessages.rows).toEqual([]);
    expect(earlyEvents.rows[0]?.count).toBe("0");
    expect(earlyStatuses.rows).toEqual([
      { source_event_type: "item/completed", projection_status: "held" },
      { source_event_type: "thread/start", projection_status: "projected" }
    ]);

    await expect(
      repo.releaseConversationProjectionHold(
        { userId: owner.id },
        { sessionId: session.id, externalTurnId: turnId }
      )
    ).rejects.toMatchObject({ code: "managed_turn_not_terminal" });

    await repo.createConversationItems(
      { userId: owner.id },
      { items: [controlItem(), reconciledControlItem()] }
    );
    const release = await repo.releaseConversationProjectionHold(
      { userId: owner.id },
      { sessionId: session.id, externalTurnId: turnId }
    );
    const releasedStatuses = await pool.query<{
      projection_status: string;
      source_event_type: string;
    }>(
      `
        select source_event_type, projection_status
        from conversation_items
        where session_id = $1
        order by source_event_type
      `,
      [session.id]
    );
    expect(releasedStatuses.rows).toEqual([
      { source_event_type: "item/completed", projection_status: "pending" },
      { source_event_type: "thread/start", projection_status: "projected" },
      { source_event_type: "turn/completed", projection_status: "pending" }
    ]);
    const releasedProjection = await repo.projectPendingConversationItems(
      { userId: owner.id },
      { limit: 10, conversationItemIds: release.conversationItemIds }
    );
    const messages = await pool.query<{ content: string }>(
      "select content from messages where session_id = $1",
      [session.id]
    );
    const events = await pool.query<{
      content: string;
      seal_reason: string | null;
    }>(
      `
        select payload ->> 'content' as content, seal_reason
        from memory_events
        where session_id = $1
      `,
      [session.id]
    );
    const controlRows = await pool.query<{ observations: string }>(
      `
        select count(*)::text as observations
        from conversation_item_observations
        where owner_user_id = $1
          and canonical_item_key = $2
      `,
      [owner.id, controlCanonicalItemKey]
    );

    expect(controlRows.rows[0]?.observations).toBe("2");
    expect(messages.rows).toEqual([{ content: "One canonical agent answer" }]);
    expect(events.rows).toEqual([
      {
        content: "One canonical agent answer",
        seal_reason: "turn_completed"
      }
    ]);
    expect(release.conversationItemIds).toHaveLength(2);
    expect(releasedProjection.messagesCreated).toBe(1);
    expect(releasedProjection.memoryEventsCreated).toBe(1);
  });

  it("enforces Capture Policy and Capture Pause at canonical raw ingestion", async () => {
    const owner = await repo.createUser({
      email: `canonical-capture-policy-${randomUUID()}@example.com`
    });
    const threadId = `capture-policy-thread-${randomUUID()}`;
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: threadId,
        sourceRuntime: "codex",
        captureMethod: "api"
      }
    );
    await repo.upsertCapturePolicy(
      { userId: owner.id },
      {
        targetType: "thread",
        threadId,
        captureState: "disabled",
        visibility: "personal"
      }
    );
    const managedItem = (suffix: string) =>
      ({
        sessionId: session.id,
        sourceKind: "codex",
        sourceAdapterVersion: "codex-app-server-conversation-v1",
        sourceTransport: "app_server",
        externalSessionId: threadId,
        externalThreadId: threadId,
        externalTurnId: "turn-1",
        externalItemId: `message-${suffix}`,
        sourceRecordType: "app_server_notification",
        sourceEventType: "item/completed",
        rawJson: {
          method: "item/completed",
          params: {
            item: {
              id: `message-${suffix}`,
              type: "agentMessage",
              text: `Capture policy ${suffix}`
            }
          }
        },
        rawText: `Capture policy ${suffix}`,
        sourceHash: `capture-policy-${suffix}-${randomUUID()}`,
        idempotencyKey: `capture-policy-observation-${suffix}-${randomUUID()}`,
        canonicalItemKey: codexCanonicalConversationItemKey({
          externalThreadId: threadId,
          externalTurnId: "turn-1",
          stableItemId: `message-${suffix}`,
          component: "message"
        }),
        canonicalStableItemId: `message-${suffix}`,
        canonicalSourcePriority: 300,
        observationKind: "lifecycle_completed" as const,
        observationComponent: "message",
        projectionStatus: "pending" as const,
        projectionVersion: "codex-app-server-conversation-v1",
        metadata: {
          managedConversation: true,
          transcriptType: "agent_message"
        }
      }) as const;

    await expect(
      repo.createConversationItems(
        { userId: owner.id },
        { items: [managedItem("disabled")] }
      )
    ).rejects.toMatchObject({
      message: "Capture Policy disabled raw conversation ingestion",
      code: "capture_disabled"
    });
    expect(
      (
        await pool.query<{ count: number }>(
          "select count(*)::int as count from conversation_items where owner_user_id = $1",
          [owner.id]
        )
      ).rows[0]?.count
    ).toBe(0);

    await repo.upsertCapturePolicy(
      { userId: owner.id },
      {
        targetType: "thread",
        threadId,
        captureState: "enabled",
        visibility: "personal"
      }
    );
    await repo.upsertCapturePolicy(
      { userId: owner.id },
      {
        targetType: "global",
        captureState: "enabled",
        visibility: "personal",
        pauseUntil: new Date(Date.now() + 60_000)
      }
    );
    await expect(
      repo.createConversationItems(
        { userId: owner.id },
        { items: [managedItem("paused")] }
      )
    ).rejects.toMatchObject({ code: "capture_disabled" });

    await expect(
      repo.createConversationItems(
        { userId: owner.id },
        {
          items: [
            {
              ...managedItem("internal"),
              metadata: {
                workflow: "memory_question",
                transcriptType: "agent_message"
              }
            }
          ]
        }
      )
    ).rejects.toMatchObject({ code: "capture_disabled" });
  });

  it("keeps managed app-server and external JSONL turns downstream-equivalent", async () => {
    const owner = await repo.createUser({
      email: `managed-jsonl-parity-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Managed JSONL Parity')
      `,
      [workspaceId, owner.id]
    );
    const managedSession = await repo.createCapturedSession(
      { userId: owner.id },
      {
        workspaceId,
        externalSessionId: `managed-parity-${randomUUID()}`,
        sourceRuntime: "codex",
        captureMethod: "api",
        metadata: { workspaceId, managedConversation: true }
      }
    );
    const externalSession = await repo.createCapturedSession(
      { userId: owner.id },
      {
        workspaceId,
        externalSessionId: `external-parity-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        captureMethod: "hook",
        metadata: { workspaceId }
      }
    );
    const callId = `parity-call-${randomUUID()}`;
    const semanticItems = [
      {
        component: "reasoning_summary",
        transcriptType: "reasoning_summary",
        text: "I should inspect the projection path.",
        metadata: {}
      },
      {
        component: "tool_call",
        transcriptType: "function_call",
        text: 'Tool call: exec_command\n\nInput:\n{"cmd":"rg projection"}',
        metadata: {
          toolName: "exec_command",
          toolEventKind: "function_call",
          callId,
          toolCallId: callId,
          toolCall: {
            kind: "call",
            type: "function_call",
            id: callId,
            name: "exec_command",
            input: { cmd: "rg projection" }
          }
        }
      },
      {
        component: "tool_result",
        transcriptType: "function_call_output",
        text: "Tool output: exec_command\n\nprojection found",
        metadata: {
          toolName: "exec_command",
          toolEventKind: "function_call_output",
          callId,
          toolCallId: callId,
          toolCall: {
            kind: "output",
            type: "function_call_output",
            id: callId,
            name: "exec_command",
            output: "projection found"
          }
        }
      },
      {
        component: "message",
        transcriptType: "agent_message",
        text: "The projection path is shared.",
        metadata: {}
      }
    ];
    const baseTime = Date.now();
    const managedTurnId = "managed-parity-turn";
    const externalTurnId = "external-parity-turn";
    const managedItems: ConversationItemInput[] = semanticItems.flatMap(
      (item, index) => {
        const appSourceSequence =
          item.component === "tool_result" ? index - 1 : index;
        const externalItemId =
          item.component === "tool_call" || item.component === "tool_result"
            ? callId
            : `managed-item-${index}`;
        const canonicalItemKey = codexCanonicalConversationItemKey({
          externalThreadId: managedSession.externalSessionId!,
          externalTurnId: managedTurnId,
          stableItemId: externalItemId,
          component: item.component
        });
        const metadata = {
          workspaceId,
          transcriptType: item.transcriptType,
          ...item.metadata
        };
        return [
          {
            sessionId: managedSession.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-conversation-v1",
            sourceTransport: "app_server",
            externalSessionId: managedSession.externalSessionId ?? undefined,
            externalThreadId: managedSession.externalSessionId ?? undefined,
            externalTurnId: managedTurnId,
            externalItemId,
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: appSourceSequence,
            eventTime: new Date(baseTime + index).toISOString(),
            rawJson: {
              method: "item/completed",
              params: {
                item: { id: externalItemId, type: item.transcriptType }
              }
            },
            rawText: item.text,
            sourceHash: `managed-app-${randomUUID()}`,
            idempotencyKey: `managed-app-observation-${randomUUID()}`,
            canonicalItemKey,
            canonicalStableItemId: externalItemId,
            canonicalSourcePriority: 300,
            observationKind: "lifecycle_completed" as const,
            observationComponent: item.component,
            projectionStatus: "pending" as const,
            projectionVersion: "codex-app-server-conversation-v1",
            metadata
          },
          {
            sessionId: managedSession.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "transcript",
            externalSessionId: managedSession.externalSessionId ?? undefined,
            externalThreadId: managedSession.externalSessionId ?? undefined,
            externalTurnId: managedTurnId,
            externalItemId,
            sourceRecordType: "response_item",
            sourceEventType: item.transcriptType,
            sourcePath: "/tmp/managed-parity.jsonl",
            sourceLineNumber: index,
            sourceSequence: index,
            eventTime: new Date(baseTime + index).toISOString(),
            rawJson: {
              timestamp: new Date(baseTime + index).toISOString(),
              type: "response_item",
              payload: { id: externalItemId, type: item.transcriptType }
            },
            rawText: item.text,
            sourceHash: `managed-transcript-${randomUUID()}`,
            idempotencyKey: `managed-transcript-observation-${randomUUID()}`,
            canonicalItemKey,
            canonicalStableItemId: externalItemId,
            canonicalSourcePriority: 200,
            observationKind: "reconciliation" as const,
            observationComponent: item.component,
            projectionStatus: "pending" as const,
            projectionVersion: "codex-transcript-v1",
            metadata
          }
        ];
      }
    );
    const managedControlKey = codexCanonicalConversationItemKey({
      externalThreadId: managedSession.externalSessionId!,
      externalTurnId: managedTurnId,
      stableItemId: `turn:${managedTurnId}:completed`,
      component: "control"
    });
    managedItems.push({
      sessionId: managedSession.id,
      sourceKind: "codex",
      sourceAdapterVersion: "codex-app-server-conversation-v1",
      sourceTransport: "app_server",
      externalSessionId: managedSession.externalSessionId ?? undefined,
      externalThreadId: managedSession.externalSessionId ?? undefined,
      externalTurnId: managedTurnId,
      externalItemId: undefined,
      sourceRecordType: "app_server_notification",
      sourceEventType: "turn/completed",
      sourceSequence: semanticItems.length,
      eventTime: new Date(baseTime + semanticItems.length).toISOString(),
      rawJson: {
        method: "turn/completed",
        params: { turn: { id: managedTurnId, status: "completed" } }
      },
      rawText: undefined,
      sourceHash: `managed-control-${randomUUID()}`,
      idempotencyKey: `managed-control-observation-${randomUUID()}`,
      canonicalItemKey: managedControlKey,
      canonicalStableItemId: `turn:${managedTurnId}:completed`,
      canonicalSourcePriority: 300,
      observationKind: "control" as const,
      observationComponent: "control",
      projectionStatus: "pending" as const,
      projectionVersion: "codex-app-server-conversation-v1",
      metadata: {
        workspaceId,
        transcriptType: "turn/completed",
        semanticControl: "turn_completed"
      }
    });
    managedItems.push({
      ...managedItems[managedItems.length - 1]!,
      sourceAdapterVersion: "codex-transcript-v1",
      sourceTransport: "transcript",
      sourceRecordType: "event_msg",
      sourceEventType: "task_complete",
      sourcePath: "/tmp/managed-parity.jsonl",
      sourceLineNumber: semanticItems.length,
      rawJson: {
        type: "event_msg",
        payload: { type: "task_complete", turn_id: managedTurnId }
      },
      sourceHash: `managed-control-transcript-${randomUUID()}`,
      idempotencyKey: `managed-control-transcript-observation-${randomUUID()}`,
      canonicalSourcePriority: 200,
      observationKind: "reconciliation" as const,
      projectionVersion: "codex-transcript-v1"
    });
    await repo.createConversationItems(
      { userId: owner.id },
      { items: managedItems }
    );
    await repo.releaseConversationProjectionHold(
      { userId: owner.id },
      { sessionId: managedSession.id, externalTurnId: managedTurnId }
    );

    await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          ...semanticItems.map((item, index) => ({
            sessionId: externalSession.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalSessionId: externalSession.externalSessionId ?? undefined,
            externalThreadId: externalSession.externalSessionId ?? undefined,
            externalTurnId,
            externalItemId:
              item.component === "tool_call" || item.component === "tool_result"
                ? callId
                : `external-item-${index}`,
            sourceRecordType: "response_item",
            sourceEventType: item.transcriptType,
            sourcePath: "/tmp/external-parity.jsonl",
            sourceLineNumber: index,
            sourceSequence: index,
            eventTime: new Date(baseTime + index).toISOString(),
            rawJson: {
              timestamp: new Date(baseTime + index).toISOString(),
              type: "response_item",
              payload: { type: item.transcriptType }
            },
            rawText: item.text,
            sourceHash: `external-transcript-${randomUUID()}`,
            idempotencyKey: `external-transcript-${randomUUID()}`,
            projectionStatus: "pending" as const,
            projectionVersion: "codex-transcript-v1",
            metadata: {
              workspaceId,
              transcriptType: item.transcriptType,
              ...item.metadata
            }
          })),
          {
            sessionId: externalSession.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalSessionId: externalSession.externalSessionId ?? undefined,
            externalThreadId: externalSession.externalSessionId ?? undefined,
            externalTurnId,
            sourceRecordType: "hook_payload",
            sourceEventType: "Stop",
            sourceSequence: semanticItems.length,
            eventTime: new Date(baseTime + semanticItems.length).toISOString(),
            rawJson: { hook_event_name: "Stop", turn_id: externalTurnId },
            sourceHash: `external-stop-${randomUUID()}`,
            idempotencyKey: `external-stop-${randomUUID()}`,
            projectionStatus: "pending" as const,
            projectionVersion: "codex-hook-v1",
            metadata: { workspaceId, hookEventName: "Stop" }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: owner.id },
      { limit: 50 }
    );
    expect(projection.memoryEventsCreated).toBe(2);

    const projectedRows = async (sessionId: string) => {
      const messages = await pool.query<{
        role: string;
        content: string;
      }>(
        "select role, content from messages where session_id = $1 order by created_at asc, id asc",
        [sessionId]
      );
      const tools = await pool.query<{
        tool_name: string;
        tool_input: unknown;
        tool_response: unknown;
      }>(
        `
          select tool_name, tool_input, tool_response
          from tool_events
          where session_id = $1
          order by created_at asc
        `,
        [sessionId]
      );
      const events = await pool.query<{
        id: string;
        content: string;
        token_count: number;
        manifest: Array<Record<string, unknown>>;
        seal_reason: string;
        source_count: number;
      }>(
        `
          select
            me.id,
            me.payload ->> 'content' as content,
            me.token_count,
            me.payload #> '{metadata,semanticItemManifest}' as manifest,
            me.seal_reason,
            count(mes.conversation_item_id)::int as source_count
          from memory_events me
          join memory_event_sources mes on mes.memory_event_id = me.id
          where me.session_id = $1
          group by me.id
        `,
        [sessionId]
      );
      const event = events.rows[0]!;
      const embedding = await repo.getEmbeddableSource(
        "memory_event",
        event.id
      );
      return {
        messages: messages.rows,
        tools: tools.rows,
        event: {
          content: event.content,
          tokenCount: event.token_count,
          manifest: event.manifest.map((item) => ({
            actor: item.actor,
            kind: item.kind,
            toolName: item.toolName
          })),
          sourceCount: event.source_count,
          embeddingText: embedding?.text
        },
        sealReason: event.seal_reason
      };
    };

    const managed = await projectedRows(managedSession.id);
    const external = await projectedRows(externalSession.id);
    expect({ ...managed, sealReason: undefined }).toEqual({
      ...external,
      sealReason: undefined
    });
    expect(managed.sealReason).toBe("turn_completed");
    expect(external.sealReason).toBe("stop_hook");

    const managedCounts = await pool.query<{
      canonical_count: number;
      observation_count: number;
    }>(
      `
        select
          count(distinct ci.id)::int as canonical_count,
          count(cio.id)::int as observation_count
        from conversation_items ci
        left join conversation_item_observations cio on cio.conversation_item_id = ci.id
        where ci.session_id = $1
      `,
      [managedSession.id]
    );
    expect(managedCounts.rows[0]).toEqual({
      canonical_count: semanticItems.length + 1,
      observation_count: (semanticItems.length + 1) * 2
    });

    const previousLeafEventThreshold =
      process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD;
    process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD = "1";
    try {
      await repo.createLcmNodes(
        { userId: owner.id },
        { visibility: "personal" }
      );
    } finally {
      if (previousLeafEventThreshold === undefined) {
        delete process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD;
      } else {
        process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD =
          previousLeafEventThreshold;
      }
    }
    const lcmSources = await pool.query<{
      session_id: string;
      source_count: number;
    }>(
      `
        select me.session_id, count(distinct mns.memory_event_id)::int as source_count
        from memory_node_sources mns
        join memory_events me on me.id = mns.memory_event_id
        where me.session_id = any($1::uuid[])
        group by me.session_id
      `,
      [[managedSession.id, externalSession.id]]
    );
    expect(
      lcmSources.rows.sort((left, right) =>
        left.session_id.localeCompare(right.session_id)
      )
    ).toEqual(
      [managedSession.id, externalSession.id]
        .sort()
        .map((sessionId) => ({ session_id: sessionId, source_count: 1 }))
    );
  });

  it("rebuilds JSONL-only managed records when Projection Policy opts them in", async () => {
    const owner = await repo.createUser({
      email: `managed-jsonl-policy-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Managed JSONL Policy')
      `,
      [workspaceId, owner.id]
    );
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        workspaceId,
        externalSessionId: `managed-jsonl-policy-${randomUUID()}`,
        sourceRuntime: "codex",
        captureMethod: "api",
        metadata: { workspaceId, managedConversation: true }
      }
    );
    const threadId = session.externalSessionId!;
    const turnId = "managed-jsonl-policy-turn";
    const planId = "managed-jsonl-plan";
    const planText = "Inspect the JSONL-only deployment plan before release.";
    const planCanonicalKey = codexCanonicalConversationItemKey({
      externalThreadId: threadId,
      externalTurnId: turnId,
      stableItemId: planId,
      component: "raw"
    });
    const controlStableId = `turn:${turnId}:completed`;
    const controlCanonicalKey = codexCanonicalConversationItemKey({
      externalThreadId: threadId,
      externalTurnId: turnId,
      stableItemId: controlStableId,
      component: "control"
    });

    try {
      await repo.createConversationItems(
        { userId: owner.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "transcript",
              externalSessionId: threadId,
              externalThreadId: threadId,
              externalTurnId: turnId,
              externalItemId: planId,
              canonicalItemKey: planCanonicalKey,
              canonicalStableItemId: planId,
              sourceRecordType: "response_item",
              sourceEventType: "plan",
              sourcePath: "/tmp/managed-jsonl-policy.jsonl",
              sourceLineNumber: 1,
              sourceSequence: 1,
              eventTime: "2026-07-12T01:00:00.000Z",
              rawJson: {
                timestamp: "2026-07-12T01:00:00.000Z",
                type: "response_item",
                payload: { id: planId, type: "plan", text: planText }
              },
              rawText: planText,
              sourceHash: `managed-jsonl-plan-${randomUUID()}`,
              idempotencyKey: `managed-jsonl-plan-${randomUUID()}`,
              observationKind: "reconciliation",
              observationComponent: "raw",
              metadata: {
                workspaceId,
                transcriptType: "plan",
                projectionActor: "agent"
              }
            },
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-app-server-conversation-v1",
              sourceTransport: "app_server",
              externalSessionId: threadId,
              externalThreadId: threadId,
              externalTurnId: turnId,
              canonicalItemKey: controlCanonicalKey,
              canonicalStableItemId: controlStableId,
              sourceRecordType: "app_server_notification",
              sourceEventType: "turn/completed",
              sourceSequence: 2,
              eventTime: "2026-07-12T01:00:01.000Z",
              rawJson: {
                method: "turn/completed",
                params: { turn: { id: turnId, status: "completed" } }
              },
              sourceHash: `managed-jsonl-control-${randomUUID()}`,
              idempotencyKey: `managed-jsonl-control-${randomUUID()}`,
              observationKind: "control",
              observationComponent: "control",
              metadata: {
                workspaceId,
                transcriptType: "turn/completed",
                semanticControl: "turn_completed"
              }
            },
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "transcript",
              externalSessionId: threadId,
              externalThreadId: threadId,
              externalTurnId: turnId,
              canonicalItemKey: controlCanonicalKey,
              canonicalStableItemId: controlStableId,
              sourceRecordType: "event_msg",
              sourceEventType: "task_complete",
              sourcePath: "/tmp/managed-jsonl-policy.jsonl",
              sourceLineNumber: 2,
              sourceSequence: 3,
              eventTime: "2026-07-12T01:00:01.000Z",
              rawJson: {
                timestamp: "2026-07-12T01:00:01.000Z",
                type: "event_msg",
                payload: { type: "task_complete", turn_id: turnId }
              },
              sourceHash: `managed-jsonl-control-transcript-${randomUUID()}`,
              idempotencyKey: `managed-jsonl-control-transcript-${randomUUID()}`,
              observationKind: "reconciliation",
              observationComponent: "control",
              metadata: {
                workspaceId,
                transcriptType: "task_complete"
              }
            }
          ]
        }
      );
      const released = await repo.releaseConversationProjectionHold(
        { userId: owner.id },
        { sessionId: session.id, externalTurnId: turnId }
      );
      expect(released.conversationItemIds).toHaveLength(2);

      const initialProjection = await repo.projectPendingConversationItems(
        { userId: owner.id },
        { conversationItemIds: released.conversationItemIds, limit: 10 }
      );
      expect(initialProjection).toMatchObject({
        messagesCreated: 0,
        memoryEventsCreated: 0
      });

      await pool.query(
        `
          update projection_policy_rules
          set project_to_ui = true,
              create_message = true,
              create_tool_event = false,
              create_memory_event = true,
              include_in_embedding = true,
              include_in_lcm = true,
              updated_at = now()
          where source_kind = 'codex'
            and source_adapter_version = 'codex-transcript-v1'
            and transcript_type = 'plan'
        `
      );
      const unrelatedEvent = await repo.createMemoryEvent(
        { userId: owner.id },
        {
          workspaceId,
          sessionId: session.id,
          actor: "user",
          eventType: "captured",
          rawEventType: "manual_unrelated",
          visibility: "personal",
          content:
            "Unrelated direct Memory Event must survive Projection rebuild.",
          idempotencyKey: `managed-jsonl-unrelated-${randomUUID()}`,
          sourceHash: `managed-jsonl-unrelated-${randomUUID()}`
        }
      );
      const reset = await repo.resetConversationProjection(
        { userId: owner.id },
        { sessionId: session.id }
      );
      const rebuilt = await repo.projectPendingConversationItems(
        { userId: owner.id },
        { conversationItemIds: reset.conversationItemIds, limit: 10 }
      );
      expect(rebuilt).toMatchObject({
        messagesCreated: 1,
        memoryEventsCreated: 1,
        memoryEventScopes: [
          expect.objectContaining({
            includeInEmbedding: true,
            includeInLcm: true
          })
        ]
      });
      const unrelatedAfterReset = await pool.query<{
        invalidated_at: Date | null;
      }>("select invalidated_at from memory_events where id = $1", [
        unrelatedEvent.id
      ]);
      expect(unrelatedAfterReset.rows[0]?.invalidated_at).toBeNull();

      const state = await pool.query<{
        canonical_count: number;
        observation_count: number;
        active_messages: number;
        active_events: number;
        total_events: number;
      }>(
        `
          select
            (select count(*)::int from conversation_items where session_id = $1) as canonical_count,
            (
              select count(*)::int
              from conversation_item_observations cio
              join conversation_items ci on ci.id = cio.conversation_item_id
              where ci.session_id = $1
            ) as observation_count,
            (select count(*)::int from messages where session_id = $1 and invalidated_at is null) as active_messages,
            (select count(*)::int from memory_events where session_id = $1 and invalidated_at is null) as active_events,
            (select count(*)::int from memory_events where session_id = $1) as total_events
        `,
        [session.id]
      );
      expect(state.rows[0]).toEqual({
        canonical_count: 2,
        observation_count: 3,
        active_messages: 1,
        active_events: 2,
        total_events: 2
      });

      const event = await pool.query<{ id: string; content: string }>(
        `
          select id, payload ->> 'content' as content
          from memory_events
          where session_id = $1
            and invalidated_at is null
            and payload ->> 'content' like '%' || $2 || '%'
        `,
        [session.id, planText]
      );
      expect(event.rows[0]?.content).toContain(planText);
      const embeddable = await repo.getEmbeddableSource(
        "memory_event",
        event.rows[0]!.id
      );
      expect(embeddable?.text).toContain(planText);

      const previousLeafEventThreshold =
        process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD;
      process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD = "1";
      try {
        const compacted = await repo.createLcmNodes(
          { userId: owner.id },
          { visibility: "personal" }
        );
        expect(compacted.leafNodeIds).toHaveLength(2);
        const secondReset = await repo.resetConversationProjection(
          { userId: owner.id },
          { sessionId: session.id }
        );
        await repo.projectPendingConversationItems(
          { userId: owner.id },
          {
            conversationItemIds: secondReset.conversationItemIds,
            limit: 10
          }
        );
        const compactedAgain = await repo.createLcmNodes(
          { userId: owner.id },
          { visibility: "personal" }
        );
        expect(compactedAgain.leafNodeIds).toHaveLength(1);
        const activeNodes = await pool.query<{ count: number }>(
          `
            select count(*)::int as count
            from memory_nodes
            where owner_user_id = $1
              and kind = 'leaf'
              and invalidated_at is null
          `,
          [owner.id]
        );
        expect(activeNodes.rows[0]?.count).toBe(2);
      } finally {
        if (previousLeafEventThreshold === undefined) {
          delete process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD;
        } else {
          process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD =
            previousLeafEventThreshold;
        }
      }
    } finally {
      await pool.query(
        `
          update projection_policy_rules
          set project_to_ui = false,
              create_message = false,
              create_tool_event = false,
              create_memory_event = false,
              include_in_embedding = false,
              include_in_lcm = false,
              updated_at = now()
          where source_kind = 'codex'
            and source_adapter_version = 'codex-transcript-v1'
            and transcript_type = 'plan'
        `
      );
    }
  });

  it("sanitizes storage-unsafe strings in raw conversation items before storage and projection", async () => {
    const alice = await repo.createUser({
      email: `alice-raw-nul-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Raw NUL Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `nul-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `nul-session-${randomUUID()}`,
        metadata: { workspaceId }
      }
    );
    const idempotencyKey = `nul-raw-${randomUUID()}`;
    const [rawItem] = await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "nul-turn",
            externalItemId: "nul-item",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourcePath: `/tmp/a${"\u0000"}b.jsonl`,
            sourceSequence: 0,
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  type: "agentMessage",
                  text: `The captured text is a${"\u0000"}b${"\uD800"}c.`
                },
                nested: [{ value: `nested-${"\u0000"}value` }]
              }
            },
            rawText: `Raw text 你好 🚀\nline a${"\u0000"}b`,
            sourceHash: `source-${idempotencyKey}`,
            idempotencyKey,
            projectionStatus: "pending",
            metadata: {
              workspaceId,
              transcriptType: "agent_message",
              label: `metadata a${"\u0000"}b`,
              valid: "Cafe\u0301",
              nested: {
                [`key${"\u0000"}name`]: `value${"\u0000"}text${"\uDC00"}`
              }
            }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalTurnId: "nul-turn",
            sourceRecordType: "hook_payload",
            sourceEventType: "Stop",
            sourceSequence: 1,
            rawJson: { hook_event_name: "Stop", turn_id: "nul-turn" },
            sourceHash: `nul-stop-${randomUUID()}`,
            idempotencyKey: `nul-stop-${randomUUID()}`,
            metadata: { workspaceId, hookEventName: "Stop" }
          }
        ]
      }
    );
    const [duplicateRawItem] = await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "nul-turn",
            externalItemId: "nul-item",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourcePath: `/tmp/a${"\u0000"}b.jsonl`,
            sourceSequence: 0,
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  type: "agentMessage",
                  text: `The captured text is a${"\u0000"}b${"\uD800"}c.`
                },
                nested: [{ value: `nested-${"\u0000"}value` }]
              }
            },
            rawText: `Raw text 你好 🚀\nline a${"\u0000"}b`,
            sourceHash: `source-${idempotencyKey}`,
            idempotencyKey,
            projectionStatus: "pending",
            metadata: {
              workspaceId,
              transcriptType: "agent_message",
              label: `metadata a${"\u0000"}b`,
              valid: "Cafe\u0301",
              nested: {
                [`key${"\u0000"}name`]: `value${"\u0000"}text${"\uDC00"}`
              }
            }
          }
        ]
      }
    );
    const transportIdempotencyKey = `nul-transport-text-${randomUUID()}`;
    const transportSourceItemHash = `source-${transportIdempotencyKey}`;
    const transportLogicalSourceId = `logical-${transportIdempotencyKey}`;
    const transportChunkGroupId = rawConversationTransportChunkGroupId({
      sourceKind: "codex",
      sourceAdapterVersion: "codex-app-server-v1",
      sourceTransport: "app_server",
      logicalSourceId: transportLogicalSourceId,
      sourceItemHash: transportSourceItemHash,
      transportChunkCount: 1,
      transportChunkEncoding: "test-plain-text"
    });
    const [transportTextItem] = await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            rawJson: {
              transportChunk: true,
              transportChunkGroupId,
              sourceItemHash: transportSourceItemHash,
              chunkIndex: 0,
              chunkCount: 1
            },
            logicalSourceId: transportLogicalSourceId,
            transportChunkIndex: 0,
            transportChunkCount: 1,
            transportChunkText: `Transport a${"\u0000"}b${"\uDC00"}c`,
            transportChunkEncoding: "test-plain-text",
            sourceHash: transportSourceItemHash,
            idempotencyKey: transportIdempotencyKey,
            projectionStatus: "projected"
          }
        ]
      }
    );
    const stored = await pool.query<{
      raw_json_text: string;
      raw_payload_text: string | null;
      raw_text: string | null;
      source_path: string | null;
      metadata: Record<string, unknown>;
    }>(
      `
        select
          raw_json::text as raw_json_text,
          raw_json #>> '{params,item,text}' as raw_payload_text,
          raw_text,
          source_path,
          metadata
        from conversation_items
        where id = $1
      `,
      [rawItem!.id]
    );
    const storedTransport = await pool.query<{
      transport_chunk_text: string | null;
      metadata: Record<string, unknown>;
    }>(
      "select transport_chunk_text, metadata from conversation_items where id = $1",
      [transportTextItem!.id]
    );
    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const event = await pool.query<{
      content: string;
      metadata: Record<string, unknown>;
    }>(
      "select payload ->> 'content' as content, payload -> 'metadata' as metadata from memory_events limit 1"
    );

    expect(rawItem?.id).toBeTruthy();
    expect(duplicateRawItem?.id).toBe(rawItem?.id);
    expect(stored.rows[0]?.raw_payload_text).toBe(
      "The captured text is a�b�c."
    );
    expect(stored.rows[0]?.raw_text).toBe("Raw text 你好 🚀\nline a�b");
    expect(stored.rows[0]?.source_path).toBe("/tmp/a�b.jsonl");
    expect(stored.rows[0]?.metadata).toMatchObject({
      transcriptType: "agent_message",
      valid: "Cafe\u0301",
      koedSanitization: {
        nulCharacters: {
          replacement: "U+FFFD",
          replacementCount: 7
        },
        malformedUtf16: {
          replacement: "U+FFFD",
          replacementCount: 2
        }
      }
    });
    expect(storedTransport.rows[0]?.transport_chunk_text).toBe(
      "Transport a�b�c"
    );
    expect(storedTransport.rows[0]?.metadata).toMatchObject({
      koedSanitization: {
        nulCharacters: {
          replacement: "U+FFFD",
          replacementCount: 1
        },
        malformedUtf16: {
          replacement: "U+FFFD",
          replacementCount: 1
        }
      }
    });
    expect(JSON.stringify(stored.rows[0])).not.toContain("\u0000");
    expect(JSON.stringify(stored.rows[0])).not.toContain("\\u0000");
    expect(projection.memoryEventsCreated).toBe(1);
    expect(event.rows[0]?.content).toBe("Raw text 你好 🚀\nline a�b");
    expect(event.rows[0]?.content).not.toContain("\\u0000");
    expect(JSON.stringify(event.rows[0]?.metadata)).toContain(
      '"replacementCount":7'
    );
  });

  it("does not link memory events to raw source rows outside caller ownership", async () => {
    const workspaceId = randomUUID();
    const alice = await repo.createUser({
      email: `alice-source-link-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-source-link-${randomUUID()}@example.com`
    });
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Bob Source Link Project')
      `,
      [workspaceId, bob.id]
    );
    const bobSession = await repo.createCapturedSession(
      { userId: bob.id },
      {
        workspaceId,
        externalSessionId: `bob-source-link-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `bob-source-link-session-${randomUUID()}`
      }
    );
    const [bobRawItem] = await repo.createConversationItems(
      { userId: bob.id },
      {
        items: [
          {
            sessionId: bobSession.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            sourceRecordType: "hook_payload",
            rawJson: { owner: "bob" },
            sourceHash: `bob-private-raw-${randomUUID()}`,
            idempotencyKey: `bob-private-raw-${randomUUID()}`,
            projectionStatus: "pending"
          }
        ]
      }
    );

    const projected = await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId,
        actor: "assistant",
        eventType: "captured",
        rawEventType: "agent_message",
        visibility: "personal",
        content: "Alice projected event",
        idempotencyKey: `alice-projected-${randomUUID()}`,
        sourceHash: `alice-projected-source-${randomUUID()}`,
        metadata: { rawConversationItemId: bobRawItem!.id }
      }
    );
    const links = await pool.query<{ count: string }>(
      "select count(*)::text as count from memory_event_sources where memory_event_id = $1",
      [projected.id]
    );

    expect(links.rows[0]?.count).toBe("0");
  });

  it("rejects raw conversation items attached to sessions or turns outside caller scope", async () => {
    const workspaceId = randomUUID();
    const alice = await repo.createUser({
      email: `alice-raw-scope-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-raw-scope-${randomUUID()}@example.com`
    });
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Raw Scope Project')
      `,
      [workspaceId, bob.id]
    );
    const bobSession = await repo.createCapturedSession(
      { userId: bob.id },
      {
        workspaceId,
        externalSessionId: `bob-raw-scope-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `bob-raw-scope-session-${randomUUID()}`
      }
    );
    const [bobRawItem] = await repo.createConversationItems(
      { userId: bob.id },
      {
        items: [
          {
            sessionId: bobSession.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "bob-turn-1",
            sourceRecordType: "app_server_notification",
            rawJson: { owner: "bob" },
            sourceHash: `bob-raw-scope-${randomUUID()}`,
            idempotencyKey: `bob-raw-scope-${randomUUID()}`
          }
        ]
      }
    );
    const aliceSession = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `alice-raw-scope-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `alice-raw-scope-session-${randomUUID()}`
      }
    );

    await expect(
      repo.createConversationItems(
        { userId: alice.id },
        {
          items: [
            {
              sessionId: bobSession.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-app-server-v1",
              sourceTransport: "app_server",
              sourceRecordType: "app_server_notification",
              rawJson: { owner: "alice" },
              sourceHash: `alice-bob-session-${randomUUID()}`,
              idempotencyKey: `alice-bob-session-${randomUUID()}`
            }
          ]
        }
      )
    ).rejects.toThrow("Session not found or not visible");

    await expect(
      repo.createConversationItems(
        { userId: alice.id },
        {
          items: [
            {
              sessionId: aliceSession.id,
              turnId: bobRawItem!.turnId!,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-app-server-v1",
              sourceTransport: "app_server",
              sourceRecordType: "app_server_notification",
              rawJson: { owner: "alice" },
              sourceHash: `alice-bob-turn-${randomUUID()}`,
              idempotencyKey: `alice-bob-turn-${randomUUID()}`
            }
          ]
        }
      )
    ).rejects.toThrow("Turn not found or not visible");
  });

  it("rejects token usage linked to sources outside caller scope", async () => {
    const workspaceId = randomUUID();
    const alice = await repo.createUser({
      email: `alice-token-scope-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-token-scope-${randomUUID()}@example.com`
    });
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Token Scope Project')
      `,
      [workspaceId, bob.id]
    );
    const bobSession = await repo.createCapturedSession(
      { userId: bob.id },
      {
        workspaceId,
        externalSessionId: `bob-token-scope-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `bob-token-scope-session-${randomUUID()}`
      }
    );
    const [bobRawItem] = await repo.createConversationItems(
      { userId: bob.id },
      {
        items: [
          {
            sessionId: bobSession.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "bob-token-turn-1",
            sourceRecordType: "app_server_notification",
            rawJson: { owner: "bob" },
            sourceHash: `bob-token-scope-${randomUUID()}`,
            idempotencyKey: `bob-token-scope-${randomUUID()}`
          }
        ]
      }
    );

    await expect(
      repo.recordWorkflowTokenUsage(
        { userId: alice.id },
        {
          workflowType: "memory_question",
          sessionId: bobSession.id,
          totalTokens: 1
        }
      )
    ).rejects.toThrow("Session not found or not visible");

    await expect(
      repo.recordWorkflowTokenUsage(
        { userId: alice.id },
        {
          workflowType: "memory_question",
          turnId: bobRawItem!.turnId!,
          totalTokens: 1
        }
      )
    ).rejects.toThrow("Turn not found or not visible");

    await expect(
      repo.recordWorkflowTokenUsage(
        { userId: alice.id },
        {
          workflowType: "memory_question",
          conversationItemId: bobRawItem!.id,
          totalTokens: 1
        }
      )
    ).rejects.toThrow("Conversation item not found or not visible");

    const bobQuestion = await repo.createMemoryQuestion(
      { userId: bob.id },
      {
        query: "What did we decide?",
        searchDomain: "global"
      }
    );
    const bobNode = await repo.createMemoryNode(
      { userId: bob.id },
      {
        visibility: "personal",
        summaryText: "Bob private LCM node",
        captureMethod: "mcp"
      }
    );
    const bobEvent = await repo.createMemoryEvent(
      { userId: bob.id },
      {
        workspaceId: "bob-workspace",
        actor: "user",
        eventType: "captured",
        rawEventType: "message",
        visibility: "personal",
        content: "Bob private event",
        idempotencyKey: `bob-event-${randomUUID()}`,
        sourceHash: `bob-event-${randomUUID()}`
      }
    );
    const bobMessage = await pool.query<{ id: string }>(
      `
        insert into messages (
          session_id, turn_id, owner_user_id, visibility, role, content,
          source_runtime, capture_method, source_event_time
        )
        values ($1, $2, $3, 'personal', 'user', 'Bob private message', 'codex', 'hook', '2026-04-01T12:00:00.000Z')
        returning id
      `,
      [bobSession.id, bobRawItem!.turnId, bob.id]
    );
    const bobTool = await pool.query<{ id: string }>(
      `
        insert into tool_events (
          session_id, turn_id, owner_user_id, visibility, tool_name,
          source_runtime, capture_method, source_event_time
        )
        values ($1, $2, $3, 'personal', 'Bash', 'codex', 'hook', '2026-04-01T12:00:00.000Z')
        returning id
      `,
      [bobSession.id, bobRawItem!.turnId, bob.id]
    );

    for (const reference of [
      { type: "question" as const, id: bobQuestion.id },
      { type: "lcm_node" as const, id: bobNode.id },
      { type: "message" as const, id: bobMessage.rows[0]!.id },
      { type: "tool_event" as const, id: bobTool.rows[0]!.id },
      { type: "memory_event" as const, id: bobEvent.id }
    ]) {
      await expect(
        repo.recordWorkflowTokenUsage(
          { userId: alice.id },
          {
            workflowType: "memory_question",
            sourceReferences: [reference],
            totalTokens: 1
          }
        )
      ).rejects.toThrow(
        `${reference.type} source reference not found or not visible`
      );
    }
  });

  it("persists local memory agent settings per user and flow", async () => {
    const alice = await repo.createUser({
      email: `alice-local-agent-settings-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-local-agent-settings-${randomUUID()}@example.com`
    });

    const created = await repo.upsertLocalMemoryAgentSetting(
      { userId: alice.id },
      {
        flowKey: "mcp_memory_answer",
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
        timeoutMs: 180000,
        maxAttempts: 3
      }
    );
    const updated = await repo.upsertLocalMemoryAgentSetting(
      { userId: alice.id },
      {
        flowKey: "mcp_memory_answer",
        provider: "codex",
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        timeoutMs: 120000,
        maxAttempts: 2
      }
    );
    await repo.upsertLocalMemoryAgentSetting(
      { userId: alice.id },
      {
        flowKey: "lcm_summary",
        provider: "codex",
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
        timeoutMs: 90000,
        maxAttempts: 4
      }
    );

    expect(created.flowKey).toBe("mcp_memory_answer");
    expect(updated).toMatchObject({
      ownerUserId: alice.id,
      flowKey: "mcp_memory_answer",
      provider: "codex",
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      timeoutMs: 120000,
      maxAttempts: 2
    });
    expect(
      await repo.listLocalMemoryAgentSettings({ userId: alice.id })
    ).toHaveLength(2);
    expect(await repo.listLocalMemoryAgentSettings({ userId: bob.id })).toEqual(
      []
    );
  });

  it("resolves capture policy precedence, pause inheritance, and deletion", async () => {
    const alice = await repo.createUser({
      email: `alice-capture-policy-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-capture-policy-${randomUUID()}@example.com`
    });

    expect(await repo.getEffectiveCapturePolicy({ userId: alice.id })).toEqual({
      captureState: "enabled",
      visibility: "personal",
      paused: false,
      pauseUntil: null,
      source: "default",
      policy: null
    });

    const global = await repo.upsertCapturePolicy(
      { userId: alice.id },
      {
        targetType: "global",
        captureState: "disabled",
        visibility: "personal"
      }
    );
    const project = await repo.upsertCapturePolicy(
      { userId: alice.id },
      {
        targetType: "project",
        projectId: "repo-a",
        projectName: "Repo A",
        captureState: "enabled",
        visibility: "personal"
      }
    );
    const thread = await repo.upsertCapturePolicy(
      { userId: alice.id },
      {
        targetType: "thread",
        projectId: "repo-a",
        threadId: "thread-a",
        threadName: "Thread A",
        captureState: "disabled",
        visibility: "personal"
      }
    );

    expect(
      await repo.getEffectiveCapturePolicy(
        { userId: alice.id },
        { projectId: "repo-a" }
      )
    ).toMatchObject({
      captureState: "enabled",
      paused: false,
      source: "project",
      policy: { id: project.id, targetType: "project" }
    });
    expect(
      await repo.getEffectiveCapturePolicy(
        { userId: alice.id },
        { projectId: "repo-a", threadId: "thread-a" }
      )
    ).toMatchObject({
      captureState: "disabled",
      paused: false,
      source: "thread",
      policy: { id: thread.id, targetType: "thread" }
    });
    expect(await repo.listCapturePolicies({ userId: alice.id })).toEqual([
      global,
      project,
      thread
    ]);
    expect(await repo.listCapturePolicies({ userId: bob.id })).toEqual([]);

    const pauseUntil = new Date(Date.now() + 60_000);
    const pausedGlobal = await repo.upsertCapturePolicy(
      { userId: alice.id },
      {
        targetType: "global",
        captureState: "enabled",
        visibility: "personal",
        pauseUntil
      }
    );
    expect(pausedGlobal.id).toBe(global.id);

    expect(
      await repo.getEffectiveCapturePolicy(
        { userId: alice.id },
        { projectId: "repo-a" }
      )
    ).toMatchObject({
      captureState: "disabled",
      paused: true,
      pauseUntil: pauseUntil.toISOString(),
      source: "project",
      policy: { id: project.id }
    });

    expect(await repo.deleteCapturePolicy({ userId: bob.id }, thread.id)).toBe(
      false
    );
    expect(
      await repo.deleteCapturePolicy({ userId: alice.id }, thread.id)
    ).toBe(true);
    expect(
      await repo.getEffectiveCapturePolicy(
        { userId: alice.id },
        { projectId: "repo-a", threadId: "thread-a" }
      )
    ).toMatchObject({
      source: "project",
      policy: { id: project.id }
    });

    const auditEvents = await repo.listAuditEvents({ userId: alice.id });
    expect(auditEvents.map((event) => event.action).sort()).toEqual([
      "capture_policy.deleted",
      "capture_policy.upserted",
      "capture_policy.upserted",
      "capture_policy.upserted",
      "capture_policy.upserted"
    ]);
    expect(
      auditEvents.find(
        (event) =>
          event.action === "capture_policy.deleted" &&
          event.targetId === thread.id
      )
    ).toMatchObject({
      actorUserId: alice.id,
      ownerUserId: alice.id,
      visibility: "personal",
      targetTable: "capture_policies",
      metadata: {
        targetType: "thread",
        projectId: "repo-a",
        threadId: "thread-a",
        captureState: "disabled",
        visibility: "personal"
      }
    });
    expect(
      auditEvents.find(
        (event) =>
          event.targetId === pausedGlobal.id &&
          event.metadata.pauseUntil === pauseUntil.toISOString()
      )
    ).toMatchObject({
      action: "capture_policy.upserted",
      metadata: {
        targetType: "global",
        pauseUntil: pauseUntil.toISOString()
      }
    });
    expect(await repo.listAuditEvents({ userId: bob.id })).toEqual([]);
  });

  it("stores validated token usage source references", async () => {
    const alice = await repo.createUser({
      email: `alice-token-source-references-${randomUUID()}@example.com`
    });
    const question = await repo.createMemoryQuestion(
      { userId: alice.id },
      {
        query: "What did we decide?",
        searchDomain: "global"
      }
    );
    const node = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText: "Alice LCM node",
        captureMethod: "mcp"
      }
    );
    const event = await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId: "alice-workspace",
        actor: "user",
        eventType: "captured",
        rawEventType: "message",
        visibility: "personal",
        content: "Alice private event",
        idempotencyKey: `alice-event-${randomUUID()}`,
        sourceHash: `alice-event-${randomUUID()}`
      }
    );
    const usage = await repo.recordWorkflowTokenUsage(
      { userId: alice.id },
      {
        workflowType: "memory_question",
        workflowId: question.id,
        questionId: question.id,
        answerJobId: question.id,
        lcmNodeId: node.id,
        memoryEventId: event.id,
        totalTokens: 3,
        idempotencyKey: `source-refs-${randomUUID()}`
      }
    );
    const references = await pool.query<{
      source_type: string;
      source_id: string;
    }>(
      `
        select source_type, source_id
        from workflow_token_usage_source_references
        where workflow_token_usage_id = $1
        order by source_type
      `,
      [usage.id]
    );

    expect(references.rows).toEqual([
      { source_type: "answer_job", source_id: question.id },
      { source_type: "lcm_node", source_id: node.id },
      { source_type: "memory_event", source_id: event.id },
      { source_type: "question", source_id: question.id }
    ]);
  });

  it("reprojects pending raw conversation items into messages, semantic events, and token usage", async () => {
    const alice = await repo.createUser({
      email: `alice-reproject-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Reproject Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `reproject-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `reproject-session-${randomUUID()}`,
        metadata: { workspaceId }
      }
    );
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "turn-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 0,
            rawJson: {
              method: "item/completed",
              params: {
                item: { type: "agentMessage", text: "Projected answer" }
              }
            },
            sourceHash: `raw-message-${randomUUID()}`,
            idempotencyKey: `raw-message-${randomUUID()}`,
            metadata: { workspaceId, transcriptType: "agent_message" }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "turn-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "thread/tokenUsage/updated",
            sourceSequence: 1,
            rawJson: {
              method: "thread/tokenUsage/updated",
              params: {
                tokenUsage: {
                  modelContextWindow: 1000,
                  last: {
                    totalTokens: 7,
                    inputTokens: 4,
                    cachedInputTokens: 2,
                    outputTokens: 3,
                    reasoningOutputTokens: 1
                  }
                }
              }
            },
            sourceHash: `raw-token-${randomUUID()}`,
            idempotencyKey: `raw-token-${randomUUID()}`,
            metadata: { workflow: "memory_question", questionId: "question-1" }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalTurnId: "turn-1",
            sourceRecordType: "hook_payload",
            sourceEventType: "Stop",
            sourceSequence: 2,
            rawJson: { hook_event_name: "Stop", turn_id: "turn-1" },
            sourceHash: `raw-stop-${randomUUID()}`,
            idempotencyKey: `raw-stop-${randomUUID()}`,
            metadata: { workspaceId, hookEventName: "Stop" }
          },
          {
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 3,
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  type: "agentMessage",
                  text: "LCM summary worker output should not become a chat event"
                }
              }
            },
            sourceHash: `raw-lcm-output-${randomUUID()}`,
            idempotencyKey: `raw-lcm-output-${randomUUID()}`,
            metadata: {
              workflow: "lcm_summary",
              nodeId: randomUUID(),
              transcriptType: "agent_message"
            }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const secondProjection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const messages = await pool.query<{ content: string }>(
      "select content from messages order by created_at asc"
    );
    const events = await pool.query<{ id: string; content: string }>(
      "select id, payload ->> 'content' as content from memory_events order by created_at asc"
    );
    const links = await pool.query<{ count: string }>(
      "select count(*)::text as count from memory_event_sources"
    );
    const usage = await pool.query<{
      workflow_type: string;
      workflow_id: string | null;
      usage_source: string;
      usage_accuracy: string;
      usage_kind: string;
      total_tokens: number | null;
    }>(
      "select workflow_type, workflow_id, usage_source, usage_accuracy, usage_kind, total_tokens from workflow_token_usage"
    );
    const statuses = await pool.query<{
      projection_status: string;
      projection_version: string | null;
    }>(
      "select projection_status, projection_version from conversation_items order by source_sequence asc"
    );
    const embeddable = await repo.listSourcesNeedingEmbeddings(20);

    expect(projection.rawItemsProjected).toBe(4);
    expect(projection.messagesCreated).toBe(1);
    expect(projection.memoryEventsCreated).toBe(1);
    expect(projection.tokenUsageRowsCreated).toBe(1);
    expect(secondProjection.rawItemsScanned).toBe(0);
    expect(messages.rows.map((row) => row.content)).toEqual([
      "Projected answer"
    ]);
    expect(events.rows.map((row) => row.content)).toEqual(["Projected answer"]);
    expect(links.rows[0]?.count).toBe("1");
    expect(usage.rows).toEqual([
      {
        workflow_type: "conversation_projection",
        workflow_id: "question-1",
        usage_source: "app_server",
        usage_accuracy: "provider_reported",
        usage_kind: "turn_delta",
        total_tokens: 7
      }
    ]);
    expect(
      statuses.rows.map((row) => ({
        projection_status: row.projection_status,
        projection_version: row.projection_version
      }))
    ).toEqual([
      {
        projection_status: "projected",
        projection_version: "conversation-projection-v3"
      },
      {
        projection_status: "projected",
        projection_version: "conversation-projection-v3"
      },
      {
        projection_status: "projected",
        projection_version: "conversation-projection-v3"
      },
      {
        projection_status: "projected",
        projection_version: "conversation-projection-v3"
      }
    ]);
    expect(embeddable.some((source) => source.sourceType === "message")).toBe(
      false
    );
    expect(
      embeddable.some((source) => source.sourceType === "memory_event")
    ).toBe(true);
  });

  it("projects Codex transcript token_count rows into token usage without semantic memory", async () => {
    const alice = await repo.createUser({
      email: `alice-token-count-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Transcript Token Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `token-count-session-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        idempotencyKey: `token-count-session-${randomUUID()}`,
        metadata: {
          workspaceId,
          threadKind: "subagent",
          parentThreadId: "parent-thread",
          parentSessionId: "parent-session"
        }
      }
    );
    const [rawItem] = await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalTurnId: "token-count-turn",
            sourceRecordType: "token_count",
            sourceEventType: "token_count",
            sourcePath: "/tmp/codex/transcript.jsonl",
            sourceSequence: 9,
            rawJson: {
              type: "token_count",
              input_tokens: 11,
              cached_input_tokens: 3,
              output_tokens: 7,
              reasoning_output_tokens: 5,
              total_tokens: 26,
              model: "gpt-5-codex"
            },
            sourceHash: `raw-token-count-${randomUUID()}`,
            idempotencyKey: `raw-token-count-${randomUUID()}`,
            metadata: {
              threadKind: "subagent",
              parentThreadId: "parent-thread",
              parentSessionId: "parent-session"
            }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const usage = await pool.query<{
      workflow_type: string;
      workflow_id: string | null;
      conversation_item_id: string | null;
      usage_source: string;
      usage_accuracy: string;
      usage_kind: string;
      connector_client: string | null;
      model: string | null;
      input_tokens: number | null;
      cached_input_tokens: number | null;
      output_tokens: number | null;
      reasoning_output_tokens: number | null;
      total_tokens: number | null;
      metadata: Record<string, unknown>;
    }>(
      `
        select
          workflow_type, workflow_id, conversation_item_id, usage_source,
          usage_accuracy, usage_kind, connector_client, model, input_tokens,
          cached_input_tokens, output_tokens, reasoning_output_tokens,
          total_tokens, metadata
        from workflow_token_usage
      `
    );
    const events = await pool.query<{ count: string }>(
      "select count(*)::text as count from memory_events"
    );

    expect(projection.tokenUsageRowsCreated).toBe(1);
    expect(projection.memoryEventsCreated).toBe(0);
    expect(events.rows[0]?.count).toBe("0");
    expect(usage.rows).toEqual([
      expect.objectContaining({
        workflow_type: "subagent_turn",
        workflow_id: rawItem?.turnId,
        conversation_item_id: rawItem?.id,
        usage_source: "transcript",
        usage_accuracy: "provider_reported",
        usage_kind: "turn_delta",
        connector_client: "codex",
        model: "gpt-5-codex",
        input_tokens: 11,
        cached_input_tokens: 3,
        output_tokens: 7,
        reasoning_output_tokens: 5,
        total_tokens: 26
      })
    ]);
    expect(usage.rows[0]?.metadata).toMatchObject({
      threadKind: "subagent",
      parentThreadId: "parent-thread",
      parentSessionId: "parent-session",
      transcriptPath: "/tmp/codex/transcript.jsonl",
      sourceLineNumber: 9
    });
  });

  it("uses input plus output as transcript total fallback", async () => {
    const alice = await repo.createUser({
      email: `alice-token-count-fallback-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `token-count-fallback-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        captureMethod: "hook"
      }
    );
    const [rawItem] = await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            sourceRecordType: "token_count",
            sourceEventType: "token_count",
            rawJson: {
              type: "token_count",
              input_tokens: 11,
              cached_input_tokens: 3,
              output_tokens: 7,
              reasoning_output_tokens: 5
            },
            sourceHash: `raw-token-count-fallback-${randomUUID()}`,
            idempotencyKey: `raw-token-count-fallback-${randomUUID()}`
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const usage = await pool.query<{ total_tokens: number | null }>(
      "select total_tokens from workflow_token_usage where conversation_item_id = $1",
      [rawItem?.id]
    );

    expect(projection.tokenUsageRowsCreated).toBe(1);
    expect(usage.rows[0]?.total_tokens).toBe(18);
  });

  it("keeps estimate rows out of spend rollups unless requested", async () => {
    const alice = await repo.createUser({
      email: `alice-token-rollup-${randomUUID()}@example.com`
    });

    await repo.recordWorkflowTokenUsage(
      { userId: alice.id },
      {
        workflowType: "memory_question",
        workflowId: "question-provider",
        usageSource: "app_server",
        usageAccuracy: "provider_reported",
        usageKind: "turn_delta",
        connectorClient: "codex",
        model: "gpt-5-codex",
        inputTokens: 4,
        cachedInputTokens: 1,
        outputTokens: 2,
        totalTokens: 6,
        metadata: { appServerThreadId: "thread-provider" },
        idempotencyKey: `provider-${randomUUID()}`
      }
    );
    const estimate = await repo.recordWorkflowTokenUsage(
      { userId: alice.id },
      {
        workflowType: "memory_question",
        workflowId: "question-estimate",
        usageSource: "local_estimate",
        usageAccuracy: "local_estimate",
        usageKind: "estimate",
        connectorClient: "codex",
        tokenizerPackage: "js-tiktoken",
        tokenizerEncoding: "o200k_base",
        tokenizerModel: "gpt-5-codex",
        tokenizerExactModelMatch: true,
        tokenizerHeuristicFallback: false,
        tokenizerVersion: "test",
        model: "gpt-5-codex",
        inputTokens: 70,
        outputTokens: 30,
        totalTokens: 100,
        metadata: { executionThreadId: "thread-estimate" },
        idempotencyKey: `estimate-${randomUUID()}`
      }
    );

    const spendOnly = await repo.listWorkflowTokenUsageRollups(
      { userId: alice.id },
      { groupBy: ["workflow"], includeEstimates: false }
    );
    const estimateAware = await repo.listWorkflowTokenUsageRollups(
      { userId: alice.id },
      { groupBy: ["workflow"], includeEstimates: true }
    );
    const threadRollup = await repo.listWorkflowTokenUsageRollups(
      { userId: alice.id },
      { groupBy: ["thread"], includeEstimates: true }
    );

    expect(estimate.tokenizerPackage).toBe("js-tiktoken");
    expect(estimate.tokenizerEncoding).toBe("o200k_base");
    expect(estimate.tokenizerExactModelMatch).toBe(true);
    expect(estimate.tokenizerHeuristicFallback).toBe(false);
    expect(spendOnly).toEqual([
      expect.objectContaining({
        group: { workflow: "memory_question" },
        rowCount: 1,
        totalTokens: 6
      })
    ]);
    expect(estimateAware).toEqual([
      expect.objectContaining({
        group: { workflow: "memory_question" },
        rowCount: 2,
        totalTokens: 106
      })
    ]);
    expect(threadRollup).toEqual([
      expect.objectContaining({
        group: { thread: "thread-estimate" },
        totalTokens: 100
      }),
      expect.objectContaining({
        group: { thread: "thread-provider" },
        totalTokens: 6
      })
    ]);
  });

  it("does not automatically reproject stale projection-version rows", async () => {
    const alice = await repo.createUser({
      email: `alice-stale-projection-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Stale Projection Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `stale-projection-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `stale-projection-session-${randomUUID()}`
      }
    );
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "turn-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  type: "agentMessage",
                  text: "Already projected under an older derivation policy"
                }
              }
            },
            sourceHash: `stale-projection-raw-${randomUUID()}`,
            idempotencyKey: `stale-projection-raw-${randomUUID()}`,
            projectionStatus: "projected",
            projectionVersion: "conversation-projection-v1",
            metadata: { transcriptType: "agent_message" }
          }
        ]
      }
    );
    await pool.query(
      `
        update conversation_items
        set projection_status = 'projected',
            projection_version = 'conversation-projection-v1'
        where session_id = $1
      `,
      [session.id]
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const statuses = await pool.query<{
      projection_status: string;
      projection_version: string | null;
    }>("select projection_status, projection_version from conversation_items");

    expect(projection.rawItemsScanned).toBe(0);
    expect(statuses.rows).toEqual([
      {
        projection_status: "projected",
        projection_version: "conversation-projection-v1"
      }
    ]);
  });

  it("projects only allowlisted transcript records into semantic memory", async () => {
    const alice = await repo.createUser({
      email: `alice-projection-policy-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Projection Policy Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `projection-policy-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `projection-policy-session-${randomUUID()}`,
        metadata: { workspaceId }
      }
    );
    const rows = [
      {
        transcriptType: "user_message",
        text: "Please inspect the projection policy.",
        sourceHash: `projection-policy-user-${randomUUID()}`
      },
      {
        transcriptType: "agent_message",
        text: "The projection policy keeps raw audit data separate.",
        sourceHash: `projection-policy-agent-${randomUUID()}`
      },
      {
        transcriptType: "reasoning_summary",
        text: "Reasoning summary: compare transcript type against policy.",
        sourceHash: `projection-policy-reasoning-${randomUUID()}`
      },
      {
        transcriptType: "reasoning",
        text: "Raw reasoning content should not be projected.",
        sourceHash: `projection-policy-reasoning-item-${randomUUID()}`,
        rawJson: {
          method: "item/completed",
          params: {
            item: {
              type: "reasoning",
              summary: [
                {
                  type: "summary_text",
                  text: "Readable reasoning summary: choose the projection policy."
                }
              ],
              content: ["Raw reasoning content should not be projected."]
            }
          }
        }
      },
      {
        transcriptType: "reasoning_raw_content",
        text: "Raw reasoning content should stay raw-only.",
        sourceHash: `projection-policy-raw-reasoning-${randomUUID()}`
      },
      {
        transcriptType: "reasoning",
        text: "Unsummarized reasoning item should stay raw-only.",
        sourceHash: `projection-policy-unsummarized-reasoning-${randomUUID()}`,
        rawJson: {
          method: "item/completed",
          params: {
            item: {
              type: "reasoning",
              content: ["Unsummarized reasoning item should stay raw-only."]
            }
          }
        }
      },
      {
        transcriptType: "function_call",
        text: "Tool call: exec_command",
        sourceHash: `projection-policy-tool-${randomUUID()}`
      },
      {
        transcriptType: "system_message",
        text: "System instruction should stay raw-only.",
        sourceHash: `projection-policy-system-${randomUUID()}`
      },
      {
        transcriptType: "developer_message",
        text: "Developer instruction should stay raw-only.",
        sourceHash: `projection-policy-developer-${randomUUID()}`
      },
      {
        transcriptType: "rolling_context",
        text: "Rolling context package should stay raw-only.",
        sourceHash: `projection-policy-context-${randomUUID()}`
      }
    ];
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          ...rows.map((row, index) => ({
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "turn-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: index,
            rawJson: row.rawJson ?? {
              method: "item/completed",
              params: {
                item: {
                  type: row.transcriptType,
                  text: row.text
                }
              }
            },
            rawText: row.text,
            sourceHash: row.sourceHash,
            idempotencyKey: row.sourceHash,
            metadata: { workspaceId, transcriptType: row.transcriptType }
          })),
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalTurnId: "turn-1",
            sourceRecordType: "hook_payload",
            sourceEventType: "Stop",
            sourceSequence: rows.length,
            rawJson: { hook_event_name: "Stop", turn_id: "turn-1" },
            sourceHash: `projection-policy-stop-${randomUUID()}`,
            idempotencyKey: `projection-policy-stop-${randomUUID()}`,
            metadata: { workspaceId }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 20 }
    );
    const messages = await pool.query<{ content: string }>(
      "select content from messages order by created_at asc"
    );
    const events = await pool.query<{
      actor: string | null;
      content: string;
      semantic_unit_type: string | null;
    }>(
      `
        select
          payload ->> 'actor' as actor,
          payload ->> 'content' as content,
          payload #>> '{metadata,semanticUnitType}' as semantic_unit_type
        from memory_events
        order by created_at asc
      `
    );
    const toolEvents = await pool.query<{ count: string }>(
      "select count(*)::text as count from tool_events"
    );
    const rawStatuses = await pool.query<{
      projection_status: string;
      count: string;
    }>(
      `
        select projection_status, count(*)::text as count
        from conversation_items
        group by projection_status
      `
    );

    expect(projection.rawItemsProjected).toBe(rows.length + 1);
    expect(projection.memoryEventsCreated).toBe(3);
    expect(projection.messagesCreated).toBe(5);
    expect(projection.toolEventsCreated).toBe(1);
    expect(toolEvents.rows[0]?.count).toBe("1");
    expect(messages.rows.map((row) => row.content)).toEqual([
      "Please inspect the projection policy.",
      "The projection policy keeps raw audit data separate.",
      "Reasoning summary: compare transcript type against policy.",
      "Readable reasoning summary: choose the projection policy.",
      "Tool call: exec_command"
    ]);
    expect(
      events.rows.map((row) => ({
        actor: row.actor,
        semanticUnitType: row.semantic_unit_type,
        content: row.content
      }))
    ).toEqual([
      {
        actor: "user",
        semanticUnitType: "user_turn",
        content: "Please inspect the projection policy."
      },
      {
        actor: "agent",
        semanticUnitType: "agent_turn",
        content: [
          "The projection policy keeps raw audit data separate.",
          "",
          "Reasoning summary: compare transcript type against policy.",
          "",
          "Readable reasoning summary: choose the projection policy."
        ].join("\n")
      },
      {
        actor: "tool",
        semanticUnitType: "agent_turn",
        content: "Tool call: exec_command"
      }
    ]);
    expect(messages.rows.map((row) => row.content).join("\n")).not.toContain(
      "System instruction"
    );
    expect(events.rows.map((row) => row.content).join("\n")).not.toContain(
      "Developer instruction"
    );
    expect(events.rows.map((row) => row.content).join("\n")).not.toContain(
      "Raw reasoning content"
    );
    expect(events.rows.map((row) => row.content).join("\n")).not.toContain(
      "Unsummarized reasoning item"
    );
    expect(events.rows.map((row) => row.content).join("\n")).not.toContain(
      "Rolling context"
    );
    expect(rawStatuses.rows).toEqual([
      { projection_status: "projected", count: String(rows.length + 1) }
    ]);
  });

  it("derives generic response-message policy from the provider role", async () => {
    const owner = await repo.createUser({
      email: `provider-role-policy-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Provider Role Policy')
      `,
      [workspaceId, owner.id]
    );
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        workspaceId,
        externalSessionId: `provider-role-policy-${randomUUID()}`,
        sourceRuntime: "codex",
        metadata: { workspaceId }
      }
    );
    const sourceHash = `provider-role-policy-${randomUUID()}`;
    const contextSourceHash = `provider-role-context-${randomUUID()}`;
    const promptSourceHash = `provider-role-prompt-${randomUUID()}`;
    await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "transcript",
            externalTurnId: "provider-role-policy-turn",
            sourceRecordType: "response_item",
            sourceEventType: "message",
            sourceSequence: 0,
            rawJson: {
              type: "response_item",
              payload: {
                type: "message",
                role: "developer",
                content: [
                  {
                    type: "input_text",
                    text: "Provider developer instructions stay raw-only."
                  }
                ]
              }
            },
            rawText: "Provider developer instructions stay raw-only.",
            sourceHash,
            idempotencyKey: sourceHash,
            metadata: { workspaceId }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "transcript",
            externalTurnId: "provider-role-policy-turn",
            sourceRecordType: "response_item",
            sourceEventType: "message",
            sourceSequence: 1,
            rawJson: {
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "Injected application context stays raw-only."
                  }
                ]
              }
            },
            rawText: "Injected application context stays raw-only.",
            sourceHash: contextSourceHash,
            idempotencyKey: contextSourceHash,
            metadata: { workspaceId }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "transcript",
            externalTurnId: "provider-role-policy-turn",
            sourceRecordType: "event_msg",
            sourceEventType: "user_message",
            sourceSequence: 2,
            rawJson: {
              type: "event_msg",
              payload: {
                type: "user_message",
                message: "The authoritative user prompt is projected."
              }
            },
            rawText: "The authoritative user prompt is projected.",
            sourceHash: promptSourceHash,
            idempotencyKey: promptSourceHash,
            metadata: { workspaceId }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: owner.id },
      { limit: 10 }
    );
    const derivedRows = await pool.query<{
      source: string;
      content: string;
    }>(
      `
        select source, content
        from (
          select 'message'::text as source, content
          from messages
          where session_id = $1
          union all
          select 'memory_event'::text as source, payload ->> 'content' as content
          from memory_events
          where session_id = $1
        ) projected
        order by source
      `,
      [session.id]
    );
    expect(projection.rawItemsProjected).toBe(3);
    expect(projection.messagesCreated).toBe(1);
    expect(projection.memoryEventsCreated).toBe(1);
    expect(derivedRows.rows).toEqual([
      {
        source: "memory_event",
        content: "The authoritative user prompt is projected."
      },
      {
        source: "message",
        content: "The authoritative user prompt is projected."
      }
    ]);
  });

  it("preserves VS Code IDE context only as supporting evidence", async () => {
    const previousFreshTail = process.env.MEMORY_LCM_FRESH_EVENT_TAIL;
    const previousLeafEventThreshold =
      process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD;
    process.env.MEMORY_LCM_FRESH_EVENT_TAIL = "0";
    process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD = "1";
    try {
      const alice = await repo.createUser({
        email: `alice-ide-context-${randomUUID()}@example.com`
      });
      const workspaceId = randomUUID();
      await pool.query(
        `
	          insert into workspaces (id, owner_user_id, visibility, name)
	          values ($1, $2, 'personal', 'IDE Context Project')
	        `,
        [workspaceId, alice.id]
      );
      const session = await repo.createCapturedSession(
        { userId: alice.id },
        {
          workspaceId,
          externalSessionId: `ide-context-session-${randomUUID()}`,
          sourceRuntime: "codex",
          idempotencyKey: `ide-context-session-${randomUUID()}`,
          metadata: { workspaceId }
        }
      );
      const contextHash = `ide-context-${randomUUID()}`;
      const userHash = `ide-context-user-${randomUUID()}`;
      const agentHash = `ide-context-agent-${randomUUID()}`;
      const marker = `IDE_CONTEXT_ONLY_${randomUUID()}`;
      const primaryRowContextMarker = `PRIMARY_ROW_CONTEXT_ONLY_${randomUUID()}`;
      await repo.createConversationItems(
        { userId: alice.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "hook",
              externalTurnId: "turn-with-ide-context",
              sourceRecordType: "turn_start",
              sourceEventType: "turn_start",
              sourceSequence: 0,
              eventTime: "2026-04-01T12:00:00.000Z",
              rawJson: {
                type: "turn_start",
                payload: {
                  type: "turn_start",
                  additionalContext: {
                    vscode: {
                      kind: "application",
                      value: `Selected file contains ${marker}`
                    }
                  }
                }
              },
              sourceHash: contextHash,
              idempotencyKey: contextHash,
              metadata: {
                workspaceId,
                transcriptType: "ide_context",
                contextKind: "ide_client_context",
                contextSource: "vscode_codex",
                sourceRole: "supporting_context"
              }
            },
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "hook",
              externalTurnId: "turn-with-ide-context",
              sourceRecordType: "event_msg",
              sourceEventType: "user_message",
              sourceSequence: 1,
              eventTime: "2026-04-01T12:00:01.000Z",
              rawJson: {
                type: "event_msg",
                payload: {
                  type: "user_message",
                  message:
                    "Please explain why the capture path used editor context.",
                  additionalContext: {
                    vscode: {
                      kind: "application",
                      value: `Primary raw row retained ${primaryRowContextMarker}`
                    }
                  }
                }
              },
              rawText:
                "Please explain why the capture path used editor context.",
              sourceHash: userHash,
              idempotencyKey: userHash,
              metadata: { workspaceId, transcriptType: "user_message" }
            },
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "hook",
              externalTurnId: "turn-with-ide-context",
              sourceRecordType: "event_msg",
              sourceEventType: "agent_message",
              sourceSequence: 2,
              eventTime: "2026-04-01T12:00:02.000Z",
              rawJson: {
                type: "event_msg",
                payload: {
                  type: "agent_message",
                  message:
                    "The editor context explained the selected capture path."
                }
              },
              rawText:
                "The editor context explained the selected capture path.",
              sourceHash: agentHash,
              idempotencyKey: agentHash,
              metadata: { workspaceId, transcriptType: "agent_message" }
            },
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "hook",
              externalTurnId: "turn-with-ide-context",
              sourceRecordType: "event_msg",
              sourceEventType: "user_message",
              sourceSequence: 3,
              eventTime: "2026-04-01T12:00:03.000Z",
              rawJson: {
                type: "event_msg",
                payload: {
                  type: "user_message",
                  message:
                    "This normal prompt mentions additionalContext but is user-authored."
                }
              },
              rawText:
                "This normal prompt mentions additionalContext but is user-authored.",
              sourceHash: `ide-context-marker-prompt-${randomUUID()}`,
              idempotencyKey: `ide-context-marker-prompt-${randomUUID()}`,
              metadata: { workspaceId, transcriptType: "user_message" }
            }
          ]
        }
      );

      const projection = await repo.projectPendingConversationItems(
        { userId: alice.id },
        { limit: 10 }
      );
      const messages = await pool.query<{ content: string }>(
        "select content from messages order by created_at asc"
      );
      const events = await pool.query<{ id: string; content: string }>(
        "select id, payload ->> 'content' as content from memory_events order by created_at asc"
      );
      const supportingLinks = await pool.query<{
        source_role: string | null;
        raw_text: string | null;
      }>(
        `
	          select mes.source_role, ci.raw_text
	          from memory_event_sources mes
	          join conversation_items ci on ci.id = mes.conversation_item_id
	          where mes.source_role = 'supporting_context'
	        `
      );
      const contextSearch = await repo.searchMemoryNodes(
        { userId: alice.id },
        {
          query: marker,
          scope: "personal",
          searchDomain: "project",
          workspaceId,
          retrievalStage: "lexical_search"
        }
      );
      const embeddable = await repo.listSourcesNeedingEmbeddings(20);
      const compacted = await repo.createLcmNodes(
        { userId: alice.id },
        { visibility: "personal" }
      );
      const expandedLeaves = await Promise.all(
        compacted.leafNodeIds.map((nodeId) =>
          repo.expandMemoryNode(nodeId, { userId: alice.id })
        )
      );
      const expanded = expandedLeaves.find((leaf) =>
        leaf.sourceItems.some((item) => item.supportingContext?.length)
      );
      expect(expanded).toBeDefined();
      if (!expanded) {
        throw new Error("Expected an LCM leaf with IDE supporting context");
      }

      expect(projection.rawItemsProjected).toBe(4);
      expect(projection.messagesCreated).toBe(3);
      expect(projection.memoryEventsCreated).toBe(3);
      expect(messages.rows.map((row) => row.content).join("\n")).not.toContain(
        marker
      );
      expect(events.rows.map((row) => row.content).join("\n")).not.toContain(
        marker
      );
      expect(messages.rows.map((row) => row.content).join("\n")).not.toContain(
        primaryRowContextMarker
      );
      expect(events.rows.map((row) => row.content).join("\n")).not.toContain(
        primaryRowContextMarker
      );
      expect(messages.rows.map((row) => row.content)).toContain(
        "This normal prompt mentions additionalContext but is user-authored."
      );
      expect(supportingLinks.rows).toEqual([
        {
          source_role: "supporting_context",
          raw_text: null
        }
      ]);
      expect(contextSearch.results).toEqual([]);
      expect(embeddable.some((source) => source.text.includes(marker))).toBe(
        false
      );
      expect(
        embeddable.some((source) =>
          source.text.includes(primaryRowContextMarker)
        )
      ).toBe(false);
      expect(
        expanded.sourceItems
          .flatMap((item) => item.supportingContext ?? [])
          .map((item) => ({
            sourceRole: item.sourceRole,
            contextKind: item.contextKind,
            label: item.label,
            text: item.text
          }))
      ).toEqual([
        {
          sourceRole: "supporting_context",
          contextKind: "ide_client_context",
          label: "IDE/client context",
          text: `vscode application\nSelected file contains ${marker}`
        }
      ]);
      expect(
        expanded.sourceItems
          .flatMap((item) => item.supportingContext ?? [])
          .map((item) => item.text)
          .join("\n")
      ).not.toContain(primaryRowContextMarker);
      expect(
        expanded.sourceItems.map((item) => item.text ?? "").join("\n")
      ).not.toContain(marker);
    } finally {
      if (previousFreshTail === undefined) {
        delete process.env.MEMORY_LCM_FRESH_EVENT_TAIL;
      } else {
        process.env.MEMORY_LCM_FRESH_EVENT_TAIL = previousFreshTail;
      }
      if (previousLeafEventThreshold === undefined) {
        delete process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD;
      } else {
        process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD =
          previousLeafEventThreshold;
      }
    }
  });

  it("attaches IDE context after a pending agent turn to the following user turn", async () => {
    const alice = await repo.createUser({
      email: `alice-ide-context-after-agent-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `ide-context-after-agent-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `ide-context-after-agent-session-${randomUUID()}`
      }
    );
    const marker = `FOLLOWING_USER_CONTEXT_${randomUUID()}`;
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalTurnId: "turn-after-agent",
            sourceRecordType: "event_msg",
            sourceEventType: "agent_message",
            sourceSequence: 0,
            eventTime: "2026-04-01T12:00:00.000Z",
            rawJson: {
              type: "event_msg",
              payload: {
                type: "agent_message",
                message: "Previous assistant answer should not get context."
              }
            },
            rawText: "Previous assistant answer should not get context.",
            sourceHash: `ide-context-after-agent-reply-${randomUUID()}`,
            idempotencyKey: `ide-context-after-agent-reply-${randomUUID()}`,
            metadata: { transcriptType: "agent_message" }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalTurnId: "turn-after-agent",
            sourceRecordType: "event_msg",
            sourceEventType: "user_message",
            sourceSequence: 1,
            eventTime: "2026-04-01T12:00:01.000Z",
            rawJson: {
              type: "event_msg",
              payload: {
                type: "user_message"
              }
            },
            rawText: `vscode application\nSelected file contains ${marker}`,
            sourceHash: `ide-context-after-agent-context-${randomUUID()}`,
            idempotencyKey: `ide-context-after-agent-context-${randomUUID()}`,
            metadata: {
              transcriptType: "ide_context",
              contextKind: "ide_client_context",
              sourceRole: "supporting_context"
            }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalTurnId: "turn-after-agent",
            sourceRecordType: "event_msg",
            sourceEventType: "user_message",
            sourceSequence: 2,
            eventTime: "2026-04-01T12:00:02.000Z",
            rawJson: {
              type: "event_msg",
              payload: {
                type: "user_message",
                message: "Please review the selected file."
              }
            },
            rawText: "Please review the selected file.",
            sourceHash: `ide-context-after-agent-user-${randomUUID()}`,
            idempotencyKey: `ide-context-after-agent-user-${randomUUID()}`,
            metadata: { transcriptType: "user_message" }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const supportingLinks = await pool.query<{
      event_content: string;
      context_text: string | null;
    }>(
      `
        select me.payload ->> 'content' as event_content, ci.raw_text as context_text
        from memory_event_sources mes
        join memory_events me on me.id = mes.memory_event_id
        join conversation_items ci on ci.id = mes.conversation_item_id
        where mes.source_role = 'supporting_context'
      `
    );

    expect(projection.memoryEventsCreated).toBe(2);
    expect(projection.rawItemsProjected).toBe(3);
    expect(supportingLinks.rows).toEqual([
      {
        event_content: "Please review the selected file.",
        context_text: `vscode application\nSelected file contains ${marker}`
      }
    ]);
  });

  it("keeps unlinked IDE supporting context pending for retry", async () => {
    const alice = await repo.createUser({
      email: `alice-ide-context-pending-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `ide-context-pending-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `ide-context-pending-session-${randomUUID()}`
      }
    );
    const sourceHash = `ide-context-pending-context-${randomUUID()}`;
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalTurnId: "turn-pending-context",
            sourceRecordType: "event_msg",
            sourceEventType: "user_message",
            sourceSequence: 0,
            rawJson: {
              type: "event_msg",
              payload: {
                type: "user_message"
              }
            },
            rawText: "vscode application\nSelected file without prompt",
            sourceHash,
            idempotencyKey: sourceHash,
            metadata: {
              transcriptType: "ide_context",
              contextKind: "ide_client_context",
              sourceRole: "supporting_context"
            }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const statuses = await pool.query<{
      projection_status: string;
      projection_error: string | null;
    }>(
      `
        select projection_status, projection_error
        from conversation_items
        where source_hash = $1
      `,
      [sourceHash]
    );

    expect(projection.rawItemsScanned).toBe(1);
    expect(projection.rawItemsProjected).toBe(0);
    expect(statuses.rows).toEqual([
      { projection_status: "pending", projection_error: null }
    ]);
  });

  it("treats user interruptions as semantic boundaries inside an agent turn", async () => {
    const alice = await repo.createUser({
      email: `alice-projection-interrupt-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `projection-interrupt-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `projection-interrupt-session-${randomUUID()}`
      }
    );
    const items = [
      {
        transcriptType: "agent_message",
        text: "I am checking the original implementation.",
        sourceHash: `projection-interrupt-agent-before-${randomUUID()}`
      },
      {
        transcriptType: "user_message",
        text: "Actually treat this interruption as a new semantic break.",
        sourceHash: `projection-interrupt-user-${randomUUID()}`
      },
      {
        transcriptType: "agent_message",
        text: "I am continuing with the interruption in mind.",
        sourceHash: `projection-interrupt-agent-after-${randomUUID()}`
      },
      {
        sourceEventType: "Stop",
        sourceRecordType: "hook_payload",
        sourceTransport: "hook",
        rawJson: { hook_event_name: "Stop", turn_id: "turn-with-interrupt" },
        sourceHash: `projection-interrupt-stop-${randomUUID()}`
      }
    ];
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: items.map((item, index) => ({
          sessionId: session.id,
          sourceKind: "codex",
          sourceAdapterVersion:
            item.sourceRecordType === "hook_payload"
              ? "codex-hook-v1"
              : "codex-app-server-v1",
          sourceTransport: item.sourceTransport ?? "app_server",
          externalTurnId: "turn-with-interrupt",
          sourceRecordType: item.sourceRecordType ?? "app_server_notification",
          sourceEventType: item.sourceEventType ?? "item/completed",
          sourceSequence: index,
          rawJson: item.rawJson ?? {
            method: "item/completed",
            params: {
              item: {
                type: item.transcriptType,
                text: item.text
              }
            }
          },
          rawText: item.text,
          sourceHash: item.sourceHash,
          idempotencyKey: item.sourceHash,
          metadata: item.transcriptType
            ? { transcriptType: item.transcriptType }
            : {}
        }))
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const events = await pool.query<{
      content: string;
      semantic_unit_type: string | null;
    }>(
      `
        select
          payload ->> 'content' as content,
          payload #>> '{metadata,semanticUnitType}' as semantic_unit_type
        from memory_events
        order by created_at asc
      `
    );

    expect(projection.memoryEventsCreated).toBe(3);
    expect(events.rows).toEqual([
      {
        semantic_unit_type: "agent_turn",
        content: "I am checking the original implementation."
      },
      {
        semantic_unit_type: "user_turn",
        content: "Actually treat this interruption as a new semantic break."
      },
      {
        semantic_unit_type: "agent_turn",
        content: "I am continuing with the interruption in mind."
      }
    ]);
  });

  it("bundles tool spans with agent prose while preserving item metadata", async () => {
    const alice = await repo.createUser({
      email: `alice-projection-tool-bundle-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `projection-tool-bundle-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `projection-tool-bundle-session-${randomUUID()}`
      }
    );
    const callId = `projection-tool-bundle-call-${randomUUID()}`;
    const agentItems = [
      {
        transcriptType: "agent_message",
        text: "I will inspect the repository.",
        sourceHash: `projection-tool-agent-start-${randomUUID()}`
      },
      {
        transcriptType: "function_call",
        text: "Tool call: rg -n projection",
        sourceHash: `projection-tool-call-${randomUUID()}`,
        metadata: {
          toolName: "exec_command",
          toolCall: {
            kind: "call",
            id: callId,
            name: "exec_command",
            input: { cmd: "rg -n projection" }
          }
        }
      },
      {
        transcriptType: "function_call_output",
        text: "Tool output: projection entry point found",
        sourceHash: `projection-tool-output-${randomUUID()}`,
        metadata: {
          toolName: "exec_command",
          toolEventKind: "function_call_output",
          toolCall: {
            kind: "output",
            id: callId,
            name: "exec_command",
            output: "projection entry point found"
          }
        }
      },
      {
        transcriptType: "agent_message",
        text: "The search confirms the projection entry point.",
        sourceHash: `projection-tool-agent-final-${randomUUID()}`
      }
    ];
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          ...agentItems.map((item, index) => ({
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "tool-heavy-turn",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: index,
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  type: item.transcriptType,
                  text: item.text
                }
              }
            },
            rawText: item.text,
            sourceHash: item.sourceHash,
            idempotencyKey: item.sourceHash,
            metadata: {
              transcriptType: item.transcriptType,
              ...item.metadata
            }
          })),
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalTurnId: "tool-heavy-turn",
            sourceRecordType: "hook_payload",
            sourceEventType: "Stop",
            sourceSequence: agentItems.length,
            rawJson: { hook_event_name: "Stop", turn_id: "tool-heavy-turn" },
            sourceHash: `projection-tool-stop-${randomUUID()}`,
            idempotencyKey: `projection-tool-stop-${randomUUID()}`,
            metadata: {}
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const events = await pool.query<{
      id: string;
      actor: string | null;
      content: string;
      manifest: unknown;
      sealed_reason: string | null;
      seal_reason: string | null;
      token_count: number | null;
    }>(
      `
	        select
	          id,
	          payload ->> 'actor' as actor,
	          payload ->> 'content' as content,
	          payload #> '{metadata,semanticItemManifest}' as manifest,
	          payload #>> '{metadata,semanticBundleSealedReason}' as sealed_reason,
	          seal_reason,
	          token_count
	        from memory_events
        where payload #>> '{metadata,semanticUnitType}' = 'agent_turn'
        order by created_at asc
      `
    );
    const sourceLinks = await pool.query<{ count: string }>(
      "select count(*)::text as count from memory_event_sources where memory_event_id = $1",
      [events.rows[0]?.id]
    );
    const toolEvents = await pool.query<{
      tool_name: string;
      tool_input: unknown;
      tool_response: unknown;
      transcript_item_id: string | null;
    }>(
      `
        select tool_name, tool_input, tool_response, transcript_item_id
        from tool_events
        order by transcript_item_id asc nulls last, id asc
      `
    );

    expect(projection.memoryEventsCreated).toBe(1);
    expect(projection.toolEventsCreated).toBe(1);
    expect(events.rows.map((row) => row.actor)).toEqual(["agent"]);
    expect(events.rows.map((row) => row.content)).toEqual([
      [
        "I will inspect the repository.",
        "",
        "Tool call: rg -n projection",
        "",
        "Tool output: projection entry point found",
        "",
        "The search confirms the projection entry point."
      ].join("\n")
    ]);
    expect(events.rows[0]?.sealed_reason).toBe("stop_hook");
    expect(events.rows[0]?.seal_reason).toBe("stop_hook");
    expect(events.rows[0]?.token_count).toBe(
      estimateTokens(events.rows[0]?.content ?? "", {
        model: "gpt-5.4-mini"
      })
    );
    expect(
      Array.isArray(events.rows[0]?.manifest) ? events.rows[0]?.manifest : []
    ).toMatchObject([
      { actor: "agent", kind: "agent_message" },
      { actor: "tool", kind: "tool_call", toolName: "exec_command" },
      { actor: "tool", kind: "tool_result", toolName: "exec_command" },
      { actor: "agent", kind: "agent_message" }
    ]);
    expect(sourceLinks.rows[0]?.count).toBe("4");
    expect(toolEvents.rows).toHaveLength(1);
    expect(toolEvents.rows[0]?.tool_name).toBe("exec_command");
    expect(toolEvents.rows[0]?.tool_input).toEqual({ cmd: "rg -n projection" });
    expect(toolEvents.rows[0]?.tool_response).toBe(
      "projection entry point found"
    );
  });

  it("counts semantic bundle separators before token-limit rollover", async () => {
    const previousMaxTokens = process.env.MEMORY_EVENT_MAX_TOKENS;
    process.env.MEMORY_EVENT_MAX_TOKENS = "29";
    try {
      const alice = await repo.createUser({
        email: `alice-projection-separator-tokens-${randomUUID()}@example.com`
      });
      const session = await repo.createCapturedSession(
        { userId: alice.id },
        {
          externalSessionId: `projection-separator-tokens-${randomUUID()}`,
          sourceRuntime: "codex",
          idempotencyKey: `projection-separator-tokens-session-${randomUUID()}`
        }
      );
      const agentItems = [
        "I will inspect the repository.",
        "Tool call: rg -n projection",
        "Tool output: projection entry point found",
        "The search confirms the projection entry point."
      ];
      const firstContent = agentItems.slice(0, 3).join("\n\n");
      const joinedContent = agentItems.join("\n\n");
      expect(
        agentItems.reduce(
          (total, item) =>
            total + estimateTokens(item, { model: "gpt-5.4-mini" }),
          0
        )
      ).toBeLessThanOrEqual(29);
      expect(
        estimateTokens(joinedContent, { model: "gpt-5.4-mini" })
      ).toBeGreaterThan(29);

      await repo.createConversationItems(
        { userId: alice.id },
        {
          items: [
            ...agentItems.map((text, index) => ({
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-app-server-v1",
              sourceTransport: "app_server",
              externalTurnId: "separator-token-turn",
              sourceRecordType: "app_server_notification",
              sourceEventType: "item/completed",
              sourceSequence: index,
              rawJson: {
                method: "item/completed",
                params: {
                  item: {
                    type:
                      index === 1
                        ? "function_call"
                        : index === 2
                          ? "function_call_output"
                          : "agentMessage",
                    text
                  }
                }
              },
              rawText: text,
              sourceHash: `projection-separator-token-${index}-${randomUUID()}`,
              idempotencyKey: `projection-separator-token-${index}-${randomUUID()}`,
              metadata: {
                transcriptType:
                  index === 1
                    ? "function_call"
                    : index === 2
                      ? "function_call_output"
                      : "agent_message"
              }
            })),
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-hook-v1",
              sourceTransport: "hook",
              externalTurnId: "separator-token-turn",
              sourceRecordType: "hook_payload",
              sourceEventType: "Stop",
              sourceSequence: agentItems.length,
              rawJson: {
                hook_event_name: "Stop",
                turn_id: "separator-token-turn"
              },
              sourceHash: `projection-separator-stop-${randomUUID()}`,
              idempotencyKey: `projection-separator-stop-${randomUUID()}`,
              metadata: { hookEventName: "Stop" }
            }
          ]
        }
      );

      const projection = await repo.projectPendingConversationItems(
        { userId: alice.id },
        { limit: 10 }
      );
      const events = await pool.query<{
        content: string;
        token_count: number | null;
        metadata_token_count: string | null;
        sealed_reason: string | null;
      }>(
        `
          select
            payload ->> 'content' as content,
            token_count,
            payload #>> '{metadata,tokenCount}' as metadata_token_count,
            payload #>> '{metadata,semanticBundleSealedReason}' as sealed_reason
          from memory_events
          where session_id = $1
            and payload #>> '{metadata,semanticUnitType}' = 'agent_turn'
          order by source_sequence asc nulls last, created_at asc
        `,
        [session.id]
      );

      expect(projection.memoryEventsCreated).toBe(2);
      expect(events.rows.map((row) => row.content)).toEqual([
        firstContent,
        agentItems[3]
      ]);
      expect(events.rows.map((row) => row.sealed_reason)).toEqual([
        "token_limit",
        "stop_hook"
      ]);
      expect(events.rows.every((row) => (row.token_count ?? 0) <= 29)).toBe(
        true
      );
      expect(
        events.rows.every(
          (row) => row.metadata_token_count === String(row.token_count)
        )
      ).toBe(true);
    } finally {
      if (previousMaxTokens === undefined) {
        delete process.env.MEMORY_EVENT_MAX_TOKENS;
      } else {
        process.env.MEMORY_EVENT_MAX_TOKENS = previousMaxTokens;
      }
    }
  });

  it("seals same-scope transcript agent bundles when only a mismatched Stop hook control record is projected", async () => {
    const alice = await repo.createUser({
      email: `alice-projection-stop-metadata-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `projection-stop-metadata-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `projection-stop-metadata-session-${randomUUID()}`
      }
    );
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalTurnId: "transcript-assigned-turn",
            sourceRecordType: "event_msg",
            sourceEventType: "agent_message",
            sourceSequence: 0,
            eventTime: "2026-04-01T12:00:00.000Z",
            rawJson: {
              type: "event_msg",
              payload: {
                type: "agent_message",
                message: "Stop metadata should seal this bundle."
              }
            },
            rawText: "Stop metadata should seal this bundle.",
            sourceHash: `projection-stop-metadata-agent-${randomUUID()}`,
            idempotencyKey: `projection-stop-metadata-agent-${randomUUID()}`,
            metadata: {
              hookEventName: "UserPromptSubmit",
              transcriptType: "agent_message"
            }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalTurnId: "transcript-assigned-turn",
            sourceRecordType: "event_msg",
            sourceEventType: "token_count",
            sourceSequence: 1,
            eventTime: "2026-04-01T12:00:01.000Z",
            rawJson: {
              type: "event_msg",
              payload: {
                type: "token_count",
                info: {
                  last_token_usage: {
                    input_tokens: 1,
                    cached_input_tokens: 0,
                    output_tokens: 1,
                    reasoning_output_tokens: 0,
                    total_tokens: 2
                  }
                }
              }
            },
            rawText: "",
            sourceHash: `projection-stop-metadata-token-${randomUUID()}`,
            idempotencyKey: `projection-stop-metadata-token-${randomUUID()}`,
            metadata: { hookEventName: "UserPromptSubmit" }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalTurnId: "hook-payload-turn",
            sourceRecordType: "hook_payload",
            sourceEventType: "Stop",
            sourceSequence: 2,
            rawJson: {
              hook_event_name: "Stop",
              turn_id: "stop-metadata-turn"
            },
            sourceHash: `projection-stop-metadata-control-${randomUUID()}`,
            idempotencyKey: `projection-stop-metadata-control-${randomUUID()}`,
            metadata: { hookEventName: "Stop" }
          }
        ]
      }
    );
    const stopControl = await pool.query<{ id: string }>(
      `
        select id
        from conversation_items
        where session_id = $1
          and source_adapter_version = 'codex-hook-v1'
          and source_event_type = 'Stop'
      `,
      [session.id]
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { conversationItemIds: [stopControl.rows[0]!.id], limit: 1 }
    );
    const events = await pool.query<{
      content: string;
      sealed_reason: string | null;
      seal_reason: string | null;
      token_count: number | null;
    }>(
      `
	        select
	          payload ->> 'content' as content,
	          payload #>> '{metadata,semanticBundleSealedReason}' as sealed_reason,
	          seal_reason,
	          token_count
	        from memory_events
        where session_id = $1
      `,
      [session.id]
    );
    const statuses = await pool.query<{
      projection_status: string;
      count: string;
    }>(
      `
        select projection_status, count(*)::text as count
        from conversation_items
        where session_id = $1
        group by projection_status
      `,
      [session.id]
    );

    expect(projection.memoryEventsCreated).toBe(1);
    expect(projection.tokenUsageRowsCreated).toBe(1);
    expect(events.rows).toEqual([
      {
        content: "Stop metadata should seal this bundle.",
        sealed_reason: "stop_hook",
        seal_reason: "stop_hook",
        token_count: estimateTokens("Stop metadata should seal this bundle.", {
          model: "gpt-5.4-mini"
        })
      }
    ]);
    expect(statuses.rows).toEqual([
      { projection_status: "projected", count: "3" }
    ]);
  });

  it("seals incomplete agent bundles during stale catch-up", async () => {
    const previousStaleMs = process.env.MEMORY_AGENT_TURN_STALE_MS;
    process.env.MEMORY_AGENT_TURN_STALE_MS = "1";
    try {
      const alice = await repo.createUser({
        email: `alice-projection-stale-agent-${randomUUID()}@example.com`
      });
      const session = await repo.createCapturedSession(
        { userId: alice.id },
        {
          externalSessionId: `projection-stale-agent-session-${randomUUID()}`,
          sourceRuntime: "codex",
          idempotencyKey: `projection-stale-agent-session-${randomUUID()}`
        }
      );
      const staleEventTime = new Date(Date.now() - 60_000).toISOString();
      await repo.createConversationItems(
        { userId: alice.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-app-server-v1",
              sourceTransport: "app_server",
              externalTurnId: "stale-agent-turn",
              sourceRecordType: "app_server_notification",
              sourceEventType: "item/completed",
              sourceSequence: 0,
              eventTime: staleEventTime,
              rawJson: {
                method: "item/completed",
                params: {
                  item: {
                    type: "agentMessage",
                    text: "I started a long-running check."
                  }
                }
              },
              rawText: "I started a long-running check.",
              sourceHash: `projection-stale-agent-start-${randomUUID()}`,
              idempotencyKey: `projection-stale-agent-start-${randomUUID()}`,
              metadata: { transcriptType: "agent_message" }
            },
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-app-server-v1",
              sourceTransport: "app_server",
              externalTurnId: "stale-agent-turn",
              sourceRecordType: "app_server_notification",
              sourceEventType: "item/completed",
              sourceSequence: 1,
              eventTime: staleEventTime,
              rawJson: {
                method: "item/completed",
                params: {
                  item: {
                    type: "agentMessage",
                    text: "The system slept before the Stop hook arrived."
                  }
                }
              },
              rawText: "The system slept before the Stop hook arrived.",
              sourceHash: `projection-stale-agent-after-${randomUUID()}`,
              idempotencyKey: `projection-stale-agent-after-${randomUUID()}`,
              metadata: { transcriptType: "agent_message" }
            }
          ]
        }
      );

      const projection = await repo.projectPendingConversationItems(
        { userId: alice.id },
        { limit: 10 }
      );
      const events = await pool.query<{
        content: string;
        sealed_reason: string | null;
        seal_reason: string | null;
        token_count: number | null;
        manifest: unknown;
      }>(
        `
	          select
	            payload ->> 'content' as content,
	            payload #>> '{metadata,semanticBundleSealedReason}' as sealed_reason,
	            seal_reason,
	            token_count,
	            payload #> '{metadata,semanticItemManifest}' as manifest
          from memory_events
          where session_id = $1
          order by created_at asc
        `,
        [session.id]
      );
      const statuses = await pool.query<{
        projection_status: string;
        count: string;
      }>(
        `
          select projection_status, count(*)::text as count
          from conversation_items
          where session_id = $1
          group by projection_status
        `,
        [session.id]
      );

      expect(projection.memoryEventsCreated).toBe(1);
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]?.content).toBe(
        [
          "I started a long-running check.",
          "",
          "The system slept before the Stop hook arrived."
        ].join("\n")
      );
      expect(events.rows[0]?.sealed_reason).toBe("catch_up_stale");
      expect(events.rows[0]?.seal_reason).toBe("catch_up_stale");
      expect(events.rows[0]?.token_count).toBe(
        estimateTokens(events.rows[0]?.content ?? "", {
          model: "gpt-5.4-mini"
        })
      );
      expect(
        Array.isArray(events.rows[0]?.manifest) ? events.rows[0]?.manifest : []
      ).toMatchObject([
        { actor: "agent", kind: "agent_message" },
        { actor: "agent", kind: "agent_message" }
      ]);
      expect(statuses.rows).toEqual([
        { projection_status: "projected", count: "2" }
      ]);
    } finally {
      if (previousStaleMs === undefined) {
        delete process.env.MEMORY_AGENT_TURN_STALE_MS;
      } else {
        process.env.MEMORY_AGENT_TURN_STALE_MS = previousStaleMs;
      }
    }
  });

  it("seals a pending agent bundle when the next user turn arrives", async () => {
    const alice = await repo.createUser({
      email: `alice-projection-next-user-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `projection-next-user-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `projection-next-user-session-${randomUUID()}`
      }
    );
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "agent-before-next-user",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 0,
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  type: "agentMessage",
                  text: "I am waiting for the next user prompt."
                }
              }
            },
            rawText: "I am waiting for the next user prompt.",
            sourceHash: `projection-next-user-agent-${randomUUID()}`,
            idempotencyKey: `projection-next-user-agent-${randomUUID()}`,
            metadata: { transcriptType: "agent_message" }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "next-user-turn",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 1,
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  type: "userMessage",
                  text: "Here is the next prompt."
                }
              }
            },
            rawText: "Here is the next prompt.",
            sourceHash: `projection-next-user-user-${randomUUID()}`,
            idempotencyKey: `projection-next-user-user-${randomUUID()}`,
            metadata: { transcriptType: "user_message" }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const events = await pool.query<{
      content: string;
      semantic_unit_type: string | null;
      sealed_reason: string | null;
      seal_reason: string | null;
    }>(
      `
        select
          payload ->> 'content' as content,
          payload #>> '{metadata,semanticUnitType}' as semantic_unit_type,
          payload #>> '{metadata,semanticBundleSealedReason}' as sealed_reason,
          seal_reason
        from memory_events
        where session_id = $1
        order by source_sequence asc nulls last, created_at asc
      `,
      [session.id]
    );
    const statuses = await pool.query<{
      projection_status: string;
      count: string;
    }>(
      `
        select projection_status, count(*)::text as count
        from conversation_items
        where session_id = $1
        group by projection_status
      `,
      [session.id]
    );

    expect(projection.memoryEventsCreated).toBe(2);
    expect(events.rows).toEqual([
      {
        semantic_unit_type: "agent_turn",
        content: "I am waiting for the next user prompt.",
        sealed_reason: "next_user_turn",
        seal_reason: "next_user_turn"
      },
      {
        semantic_unit_type: "user_turn",
        content: "Here is the next prompt.",
        sealed_reason: "user_turn",
        seal_reason: "user_turn"
      }
    ]);
    expect(statuses.rows).toEqual([
      { projection_status: "projected", count: "2" }
    ]);
  });

  it("keeps delayed tool output names linked to the original call id", async () => {
    const alice = await repo.createUser({
      email: `alice-projection-delayed-tool-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `projection-delayed-tool-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `projection-delayed-tool-session-${randomUUID()}`
      }
    );
    const callId = `call-delayed-${randomUUID()}`;
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            sourceRecordType: "response_item",
            sourceEventType: "function_call",
            sourceSequence: 1,
            rawJson: {
              type: "response_item",
              payload: {
                type: "function_call",
                call_id: callId,
                name: "exec_command",
                arguments: { cmd: "date -u +%s" }
              }
            },
            rawText: "Tool call: exec_command",
            sourceHash: `projection-delayed-tool-call-${randomUUID()}`,
            idempotencyKey: `projection-delayed-tool-call-${randomUUID()}`,
            metadata: {
              transcriptType: "function_call",
              toolName: "exec_command",
              toolCall: {
                kind: "call",
                id: callId,
                name: "exec_command",
                input: { cmd: "date -u +%s" }
              }
            }
          }
        ]
      }
    );
    await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 1 }
    );

    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            sourceRecordType: "response_item",
            sourceEventType: "function_call_output",
            sourceSequence: 2,
            rawJson: {
              type: "response_item",
              payload: {
                type: "function_call_output",
                call_id: callId,
                output: "1780026861"
              }
            },
            rawText: "Tool output: 1780026861",
            sourceHash: `projection-delayed-tool-output-${randomUUID()}`,
            idempotencyKey: `projection-delayed-tool-output-${randomUUID()}`,
            metadata: {
              transcriptType: "function_call_output",
              toolCall: {
                kind: "output",
                id: callId,
                output: "1780026861"
              }
            }
          }
        ]
      }
    );
    await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 1 }
    );

    const toolEvents = await pool.query<{
      tool_name: string;
      tool_input: unknown;
      tool_response: unknown;
      transcript_item_id: string | null;
    }>(
      `
        select tool_name, tool_input, tool_response, transcript_item_id
        from tool_events
        where session_id = $1
        order by transcript_item_id asc nulls last, id asc
      `,
      [session.id]
    );

    expect(toolEvents.rows).toHaveLength(1);
    expect(toolEvents.rows[0]).toMatchObject({
      tool_name: "exec_command",
      tool_input: { cmd: "date -u +%s" },
      tool_response: "1780026861"
    });
    expect(toolEvents.rows[0]?.transcript_item_id).toBe("1");
  });

  it("merges tool outputs that arrive before the matching call", async () => {
    const alice = await repo.createUser({
      email: `alice-projection-output-first-tool-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `projection-output-first-tool-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `projection-output-first-tool-session-${randomUUID()}`
      }
    );
    const callId = `call-output-first-${randomUUID()}`;
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            sourceRecordType: "response_item",
            sourceEventType: "function_call_output",
            sourceSequence: 2,
            rawJson: {
              type: "response_item",
              payload: {
                type: "function_call_output",
                call_id: callId,
                output: "clean"
              }
            },
            rawText: "Tool output: clean",
            sourceHash: `projection-output-first-tool-output-${randomUUID()}`,
            idempotencyKey: `projection-output-first-tool-output-${randomUUID()}`,
            metadata: {
              transcriptType: "function_call_output",
              toolCall: {
                kind: "output",
                id: callId,
                output: "clean"
              }
            }
          }
        ]
      }
    );
    await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 1 }
    );

    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            sourceRecordType: "response_item",
            sourceEventType: "function_call",
            sourceSequence: 1,
            rawJson: {
              type: "response_item",
              payload: {
                type: "function_call",
                call_id: callId,
                name: "exec_command",
                arguments: { cmd: "git status --short" }
              }
            },
            rawText: "Tool call: exec_command",
            sourceHash: `projection-output-first-tool-call-${randomUUID()}`,
            idempotencyKey: `projection-output-first-tool-call-${randomUUID()}`,
            metadata: {
              transcriptType: "function_call",
              toolName: "exec_command",
              toolCall: {
                kind: "call",
                id: callId,
                name: "exec_command",
                input: { cmd: "git status --short" }
              }
            }
          }
        ]
      }
    );
    await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 1 }
    );

    const toolEvents = await pool.query<{
      tool_name: string;
      tool_input: unknown;
      tool_response: unknown;
      transcript_item_id: string | null;
    }>(
      `
        select tool_name, tool_input, tool_response, transcript_item_id
        from tool_events
        where session_id = $1
        order by transcript_item_id asc nulls last, id asc
      `,
      [session.id]
    );

    expect(toolEvents.rows).toHaveLength(1);
    expect(toolEvents.rows[0]).toMatchObject({
      tool_name: "exec_command",
      tool_input: { cmd: "git status --short" },
      tool_response: "clean",
      transcript_item_id: "1"
    });
  });

  it("keeps an oversized semantic item whole after reconstructing clean text", async () => {
    const previousMaxTokens = process.env.MEMORY_EVENT_MAX_TOKENS;
    process.env.MEMORY_EVENT_MAX_TOKENS = "25";
    try {
      const alice = await repo.createUser({
        email: `alice-projection-large-tool-${randomUUID()}@example.com`
      });
      const session = await repo.createCapturedSession(
        { userId: alice.id },
        {
          externalSessionId: `projection-large-tool-session-${randomUUID()}`,
          sourceRuntime: "codex",
          idempotencyKey: `projection-large-tool-session-${randomUUID()}`
        }
      );
      const text = `Tool output: ${"semantic projection boundary ".repeat(80).trim()}`;
      const sourceHash = `projection-large-tool-${randomUUID()}`;
      await repo.createConversationItems(
        { userId: alice.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-app-server-v1",
              sourceTransport: "app_server",
              externalTurnId: "large-tool-turn",
              sourceRecordType: "app_server_notification",
              sourceEventType: "item/completed",
              sourceSequence: 0,
              rawJson: {
                method: "item/completed",
                params: {
                  item: {
                    type: "function_call",
                    text
                  }
                }
              },
              rawText: text,
              sourceHash,
              idempotencyKey: sourceHash,
              metadata: { transcriptType: "function_call" }
            }
          ]
        }
      );

      const projection = await repo.projectPendingConversationItems(
        { userId: alice.id },
        { limit: 10 }
      );
      const events = await pool.query<{
        id: string;
        actor: string | null;
        content: string;
        manifest: unknown;
        token_count: number | null;
      }>(
        `
	        select
	          id,
	          payload ->> 'actor' as actor,
	          payload ->> 'content' as content,
	          payload #> '{metadata,semanticItemManifest}' as manifest,
	          token_count
	        from memory_events
	        order by created_at asc
	      `
      );
      const sourceLinks = await pool.query<{ count: string }>(
        "select count(*)::text as count from memory_event_sources"
      );

      expect(projection.memoryEventsCreated).toBe(1);
      expect(events.rows).toHaveLength(1);
      expect(new Set(events.rows.map((row) => row.actor))).toEqual(
        new Set(["tool"])
      );
      expect(events.rows[0]?.content).toBe(text);
      expect(events.rows[0]?.content.startsWith("Tool:")).toBe(false);
      expect(events.rows[0]?.token_count).toBe(
        estimateTokens(text, { model: "gpt-5.4-mini" })
      );
      expect(
        Array.isArray(events.rows[0]?.manifest) ? events.rows[0]?.manifest : []
      ).toMatchObject([
        {
          kind: "tool_call",
          offsetStart: 0,
          offsetEnd: text.length
        }
      ]);
      expect(sourceLinks.rows[0]?.count).toBe(String(events.rows.length));
    } finally {
      if (previousMaxTokens === undefined) {
        delete process.env.MEMORY_EVENT_MAX_TOKENS;
      } else {
        process.env.MEMORY_EVENT_MAX_TOKENS = previousMaxTokens;
      }
    }
  });

  it("keeps a single item whole between the memory target and embedding cap", async () => {
    const previousMaxTokens = process.env.MEMORY_EVENT_MAX_TOKENS;
    const previousEmbeddingMaxTokens = process.env.EMBEDDING_MAX_TOKENS;
    delete process.env.MEMORY_EVENT_MAX_TOKENS;
    delete process.env.EMBEDDING_MAX_TOKENS;
    try {
      const alice = await repo.createUser({
        email: `alice-projection-default-chunk-${randomUUID()}@example.com`
      });
      const session = await repo.createCapturedSession(
        { userId: alice.id },
        {
          externalSessionId: `projection-default-chunk-session-${randomUUID()}`,
          sourceRuntime: "codex",
          idempotencyKey: `projection-default-chunk-session-${randomUUID()}`
        }
      );
      const text = `Agent analysis: ${"default semantic split boundary ".repeat(700).trim()}`;
      const sourceHash = `projection-default-chunk-${randomUUID()}`;
      await repo.createConversationItems(
        { userId: alice.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-app-server-v1",
              sourceTransport: "app_server",
              externalTurnId: "default-chunk-turn",
              sourceRecordType: "app_server_notification",
              sourceEventType: "item/completed",
              sourceSequence: 0,
              rawJson: {
                method: "item/completed",
                params: {
                  item: {
                    type: "agentMessage",
                    text
                  }
                }
              },
              rawText: text,
              sourceHash,
              idempotencyKey: sourceHash,
              metadata: { transcriptType: "agent_message" }
            }
          ]
        }
      );

      const projection = await repo.projectPendingConversationItems(
        { userId: alice.id },
        { limit: 10 }
      );
      const events = await pool.query<{
        content: string;
        manifest: unknown;
        token_count: number | null;
      }>(
        `
          select
            payload ->> 'content' as content,
            payload #> '{metadata,semanticItemManifest}' as manifest,
            token_count
          from memory_events
          order by created_at asc
        `
      );

      expect(projection.memoryEventsCreated).toBe(1);
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]?.content).toBe(text);
      expect(events.rows[0]?.token_count).toBe(
        estimateTokens(text, { model: "gpt-5.4-mini" })
      );
      expect(
        Array.isArray(events.rows[0]?.manifest) ? events.rows[0]?.manifest : []
      ).toMatchObject([
        {
          kind: "agent_message",
          offsetStart: 0,
          offsetEnd: text.length
        }
      ]);
      expect(events.rows[0]?.token_count ?? 0).toBeGreaterThan(
        Number(process.env.MEMORY_EVENT_MAX_TOKENS ?? "2048")
      );
      expect(events.rows[0]?.token_count ?? 0).toBeLessThanOrEqual(
        Number(process.env.EMBEDDING_MAX_TOKENS ?? "4096")
      );
    } finally {
      if (previousMaxTokens === undefined) {
        delete process.env.MEMORY_EVENT_MAX_TOKENS;
      } else {
        process.env.MEMORY_EVENT_MAX_TOKENS = previousMaxTokens;
      }
      if (previousEmbeddingMaxTokens === undefined) {
        delete process.env.EMBEDDING_MAX_TOKENS;
      } else {
        process.env.EMBEDDING_MAX_TOKENS = previousEmbeddingMaxTokens;
      }
    }
  });

  it("splits a single item at the embedding hard cap even when the memory target is higher", async () => {
    const previousMaxTokens = process.env.MEMORY_EVENT_MAX_TOKENS;
    const previousEmbeddingMaxTokens = process.env.EMBEDDING_MAX_TOKENS;
    process.env.MEMORY_EVENT_MAX_TOKENS = "120";
    process.env.EMBEDDING_MAX_TOKENS = "80";
    try {
      const alice = await repo.createUser({
        email: `alice-projection-hard-cap-${randomUUID()}@example.com`
      });
      const session = await repo.createCapturedSession(
        { userId: alice.id },
        {
          externalSessionId: `projection-hard-cap-session-${randomUUID()}`,
          sourceRuntime: "codex",
          idempotencyKey: `projection-hard-cap-session-${randomUUID()}`
        }
      );
      const text = `Agent analysis: ${"embedding hard cap split boundary ".repeat(180).trim()}`;
      const sourceHash = `projection-hard-cap-${randomUUID()}`;
      await repo.createConversationItems(
        { userId: alice.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-app-server-v1",
              sourceTransport: "app_server",
              externalTurnId: "hard-cap-turn",
              sourceRecordType: "app_server_notification",
              sourceEventType: "item/completed",
              sourceSequence: 0,
              rawJson: {
                method: "item/completed",
                params: {
                  item: {
                    type: "agentMessage",
                    text
                  }
                }
              },
              rawText: text,
              sourceHash,
              idempotencyKey: sourceHash,
              metadata: { transcriptType: "agent_message" }
            }
          ]
        }
      );

      const projection = await repo.projectPendingConversationItems(
        { userId: alice.id },
        { limit: 10 }
      );
      const events = await pool.query<{
        content: string;
        manifest: Array<Record<string, unknown>>;
        token_count: number | null;
      }>(
        `
          select
            payload ->> 'content' as content,
            payload #> '{metadata,semanticItemManifest}' as manifest,
            token_count
          from memory_events
          order by source_sequence asc nulls last, created_at asc
        `
      );
      const sourceLinks = await pool.query<{ count: string }>(
        "select count(*)::text as count from memory_event_sources"
      );

      const originalItemTokenCount = estimateTokens(text, {
        model: "gpt-5.4-mini"
      });
      expect(originalItemTokenCount).toBeGreaterThan(80);
      expect(projection.memoryEventsCreated).toBeGreaterThan(1);
      expect(events.rows.length).toBeGreaterThan(1);
      expect(events.rows.every((row) => (row.token_count ?? 0) <= 80)).toBe(
        true
      );
      expect(sourceLinks.rows[0]?.count).toBe(String(events.rows.length));
      expect(
        events.rows.every((row, index) => {
          const manifestItem = Array.isArray(row.manifest)
            ? row.manifest[0]
            : null;
          return (
            manifestItem?.itemSplitReason === "embedding_token_limit" &&
            manifestItem?.itemSplitIndex === index &&
            manifestItem?.itemSplitCount === events.rows.length &&
            manifestItem?.originalItemTokenCount === originalItemTokenCount
          );
        })
      ).toBe(true);
    } finally {
      if (previousMaxTokens === undefined) {
        delete process.env.MEMORY_EVENT_MAX_TOKENS;
      } else {
        process.env.MEMORY_EVENT_MAX_TOKENS = previousMaxTokens;
      }
      if (previousEmbeddingMaxTokens === undefined) {
        delete process.env.EMBEDDING_MAX_TOKENS;
      } else {
        process.env.EMBEDDING_MAX_TOKENS = previousEmbeddingMaxTokens;
      }
    }
  }, 15_000);

  it("reconstructs oversized transport chunks before semantic projection", async () => {
    const alice = await repo.createUser({
      email: `alice-transport-chunks-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Transport Chunk Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `transport-chunk-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `transport-chunk-session-${randomUUID()}`,
        metadata: { workspaceId }
      }
    );
    const logicalSourceId = `transport-logical-${randomUUID()}`;
    const reconstructedText =
      "This clean reconstructed answer should be embedded without transport JSON.";
    const rawJson = {
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          text: reconstructedText
        }
      }
    };
    const envelope = JSON.stringify({
      rawJson,
      rawText: reconstructedText
    });
    const midpoint = Math.floor(envelope.length / 2);
    const chunks = [envelope.slice(0, midpoint), envelope.slice(midpoint)];

    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          ...chunks.map((chunk, index) => ({
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "turn-transport",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 100 + index,
            rawJson: {
              transportChunk: true,
              sourceItemHash: logicalSourceId,
              chunkIndex: index,
              chunkCount: chunks.length
            },
            logicalSourceId,
            transportChunkIndex: index,
            transportChunkCount: chunks.length,
            transportChunkText: chunk,
            transportChunkEncoding: "conversation-item-json-v1",
            sourceHash: `${logicalSourceId}-chunk-${index}`,
            idempotencyKey: `${logicalSourceId}-chunk-${index}`,
            metadata: {
              workspaceId,
              transcriptType: "agent_message",
              sourceItemHash: logicalSourceId,
              sourceChunkIndex: index,
              sourceChunkCount: chunks.length
            }
          })),
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalTurnId: "turn-transport",
            sourceRecordType: "hook_payload",
            sourceEventType: "Stop",
            sourceSequence: 100 + chunks.length,
            rawJson: { hook_event_name: "Stop", turn_id: "turn-transport" },
            sourceHash: `transport-stop-${randomUUID()}`,
            idempotencyKey: `transport-stop-${randomUUID()}`,
            metadata: {
              workspaceId,
              hookEventName: "Stop"
            }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 20 }
    );
    const secondProjection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 20 }
    );
    const messages = await pool.query<{ content: string }>(
      "select content from messages order by created_at asc"
    );
    const events = await pool.query<{ id: string; content: string }>(
      "select id, payload ->> 'content' as content from memory_events order by created_at asc"
    );
    const links = await pool.query<{ count: string }>(
      "select count(*)::text as count from memory_event_sources"
    );
    const statuses = await pool.query<{
      projection_status: string;
      projection_version: string | null;
    }>(
      "select projection_status, projection_version from conversation_items order by source_sequence asc"
    );

    expect(projection.rawItemsScanned).toBe(2);
    expect(projection.rawItemsProjected).toBe(3);
    expect(projection.messagesCreated).toBe(1);
    expect(projection.memoryEventsCreated).toBe(1);
    expect(secondProjection.rawItemsScanned).toBe(0);
    expect(messages.rows.map((row) => row.content)).toEqual([
      reconstructedText
    ]);
    expect(events.rows.map((row) => row.content)).toEqual([reconstructedText]);
    expect(events.rows[0]?.content).not.toContain("transportChunk");
    expect(events.rows[0]?.content).not.toContain("rawJson");
    expect(links.rows[0]?.count).toBe("2");
    expect(statuses.rows).toEqual([
      {
        projection_status: "projected",
        projection_version: "conversation-projection-v3"
      },
      {
        projection_status: "projected",
        projection_version: "conversation-projection-v3"
      },
      {
        projection_status: "projected",
        projection_version: "conversation-projection-v3"
      }
    ]);
  });

  it("ignores hook payload content when transcript sources are transport chunked", async () => {
    const alice = await repo.createUser({
      email: `alice-transport-hook-control-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: "transport-hook-control-thread",
        sourceRuntime: "codex",
        idempotencyKey: `transport-hook-control-session-${randomUUID()}`,
        metadata: { workspaceId }
      }
    );
    const logicalSourceId = `transport-hook-control-logical-${randomUUID()}`;
    const reconstructedText =
      "Chunked transcript text should be the only semantic content.";
    const envelope = JSON.stringify({
      rawJson: {
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            text: reconstructedText
          }
        }
      },
      rawText: reconstructedText
    });
    const midpoint = Math.floor(envelope.length / 2);
    const chunks = [envelope.slice(0, midpoint), envelope.slice(midpoint)];

    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          ...chunks.map((chunk, index) => ({
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalThreadId: "transport-hook-control-thread",
            externalTurnId: "transport-hook-control-turn",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: index,
            rawJson: {
              transportChunk: true,
              sourceItemHash: logicalSourceId,
              chunkIndex: index,
              chunkCount: chunks.length
            },
            logicalSourceId,
            transportChunkIndex: index,
            transportChunkCount: chunks.length,
            transportChunkText: chunk,
            transportChunkEncoding: "conversation-item-json-v1",
            sourceHash: `${logicalSourceId}-chunk-${index}`,
            idempotencyKey: `${logicalSourceId}-chunk-${index}`,
            metadata: {
              workspaceId,
              transcriptType: "agent_message",
              sourceItemHash: logicalSourceId,
              sourceChunkIndex: index,
              sourceChunkCount: chunks.length
            }
          })),
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalThreadId: "transport-hook-control-thread",
            externalTurnId: "transport-hook-control-turn",
            sourceRecordType: "hook_payload",
            sourceEventType: "PostToolUse",
            sourceSequence: chunks.length,
            rawJson: {
              hook_event_name: "PostToolUse",
              tool_name: "exec_command",
              tool_input: { cmd: "echo duplicate" },
              tool_response: "duplicate hook content response"
            },
            sourceHash: `transport-hook-control-hook-${randomUUID()}`,
            idempotencyKey: `transport-hook-control-hook-${randomUUID()}`,
            metadata: { workspaceId }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalThreadId: "transport-hook-control-thread",
            externalTurnId: "transport-hook-control-turn",
            sourceRecordType: "hook_payload",
            sourceEventType: "Stop",
            sourceSequence: chunks.length + 1,
            rawJson: {
              hook_event_name: "Stop",
              turn_id: "transport-hook-control-turn"
            },
            sourceHash: `transport-hook-control-stop-${randomUUID()}`,
            idempotencyKey: `transport-hook-control-stop-${randomUUID()}`,
            metadata: {
              workspaceId,
              hookEventName: "Stop"
            }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 20 }
    );
    const events = await pool.query<{
      content: string;
      source_count: string;
    }>(
      `
        select
          me.payload ->> 'content' as content,
          count(mes.conversation_item_id)::text as source_count
        from memory_events me
        join memory_event_sources mes
          on mes.memory_event_id = me.id
        where me.session_id = $1
          and me.payload #>> '{metadata,semanticUnitType}' = 'agent_turn'
        group by me.id
      `,
      [session.id]
    );
    const toolEvents = await pool.query<{ count: string }>(
      "select count(*)::text as count from tool_events where session_id = $1",
      [session.id]
    );
    const statuses = await pool.query<{
      projection_status: string;
      count: string;
    }>(
      `
        select projection_status, count(*)::text as count
        from conversation_items
        where session_id = $1
        group by projection_status
      `,
      [session.id]
    );

    expect(projection.memoryEventsCreated).toBe(1);
    expect(events.rows).toEqual([
      {
        content: reconstructedText,
        source_count: "2"
      }
    ]);
    expect(toolEvents.rows[0]?.count).toBe("0");
    expect(statuses.rows).toEqual([
      { projection_status: "projected", count: "4" }
    ]);
  });

  it("sanitizes storage-unsafe strings after decoding transport chunk envelopes", async () => {
    const alice = await repo.createUser({
      email: `alice-nul-transport-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'NUL Transport Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `nul-transport-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `nul-transport-session-${randomUUID()}`,
        metadata: { workspaceId }
      }
    );
    const logicalSourceId = `nul-transport-logical-${randomUUID()}`;
    const reconstructedText = `Chunked decoded text is 你好 c${"\u0000"}d${"\uD800"}e.`;
    const envelope = JSON.stringify({
      rawJson: {
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            text: reconstructedText
          }
        }
      },
      rawText: reconstructedText
    });
    const midpoint = Math.floor(envelope.length / 2);
    const chunks = [envelope.slice(0, midpoint), envelope.slice(midpoint)];

    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          ...chunks.map((chunk, index) => ({
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "turn-nul-transport",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 120 + index,
            rawJson: {
              transportChunk: true,
              sourceItemHash: logicalSourceId,
              chunkIndex: index,
              chunkCount: chunks.length
            },
            logicalSourceId,
            transportChunkIndex: index,
            transportChunkCount: chunks.length,
            transportChunkText: chunk,
            transportChunkEncoding: "conversation-item-json-v1",
            sourceHash: `${logicalSourceId}-chunk-${index}`,
            idempotencyKey: `${logicalSourceId}-chunk-${index}`,
            metadata: {
              workspaceId,
              transcriptType: "agent_message",
              sourceItemHash: logicalSourceId,
              sourceChunkIndex: index,
              sourceChunkCount: chunks.length
            }
          })),
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalTurnId: "turn-nul-transport",
            sourceRecordType: "hook_payload",
            sourceEventType: "Stop",
            sourceSequence: 120 + chunks.length,
            rawJson: {
              hook_event_name: "Stop",
              turn_id: "turn-nul-transport"
            },
            sourceHash: `nul-transport-stop-${randomUUID()}`,
            idempotencyKey: `nul-transport-stop-${randomUUID()}`,
            metadata: {
              workspaceId,
              hookEventName: "Stop"
            }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 20 }
    );
    const events = await pool.query<{ content: string; metadata: unknown }>(
      "select payload ->> 'content' as content, payload -> 'metadata' as metadata from memory_events order by created_at asc"
    );

    expect(projection.rawItemsProjected).toBe(3);
    expect(projection.memoryEventsCreated).toBe(1);
    expect(events.rows[0]?.content).toBe("Chunked decoded text is 你好 c�d�e.");
    expect(events.rows[0]?.content).not.toContain("\u0000");
    expect(events.rows[0]?.content).not.toContain("\\u0000");
    expect(events.rows[0]?.metadata).toMatchObject({
      koedSanitization: {
        nulCharacters: {
          replacement: "U+FFFD",
          replacementCount: 2
        },
        malformedUtf16: {
          replacement: "U+FFFD",
          replacementCount: 2
        }
      }
    });
  });

  it("keeps Personal Project overrides authoritative and preserves capture provenance", async () => {
    const alice = await repo.createUser({
      email: `alice-project-assignment-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-project-assignment-${randomUUID()}@example.com`
    });
    const idempotencyKey = `project-assignment-${randomUUID()}`;
    const capturedWorkspaceId = randomUUID();
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId: capturedWorkspaceId,
        externalSessionId: `project-assignment-thread-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        idempotencyKey,
        detectedProjects: [
          {
            id: "project-detected-a",
            name: "Detected A",
            path: "/work/detected-a"
          }
        ]
      }
    );
    const capturedProvenance = session.capturedProjectProvenance;

    const bobSession = await repo.createCapturedSession(
      { userId: bob.id },
      {
        externalSessionId: `other-owner-${randomUUID()}`,
        idempotencyKey,
        detectedProjects: [
          {
            id: "project-other-owner",
            name: "Other Owner Project",
            path: "/work/other-owner"
          }
        ]
      }
    );

    const moved = await repo.moveCapturedSessionToProject(
      { userId: alice.id },
      session.id,
      {
        id: "project-manual",
        name: "Manual Project",
        path: "/work/manual"
      }
    );
    const forbiddenMove = await repo.moveCapturedSessionToProject(
      { userId: bob.id },
      session.id,
      { id: "project-bob", name: "Bob Project", path: "/work/bob" }
    );
    const redetected = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId: capturedWorkspaceId,
        externalSessionId: session.externalSessionId ?? undefined,
        sourceRuntime: "codex-cli",
        idempotencyKey,
        detectedProjects: [
          {
            id: "project-detected-b",
            name: "Detected B",
            path: "/work/detected-b"
          }
        ]
      }
    );
    const latestCapturedSession = await repo.getLatestCapturedSessionForProject(
      { userId: alice.id },
      { workspaceId: capturedWorkspaceId }
    );
    const organizationalLookup = await repo.getLatestCapturedSessionForProject(
      { userId: alice.id },
      { workspaceId: "project-manual" }
    );
    await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId: capturedWorkspaceId,
        sessionId: session.id,
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        visibility: "personal",
        content: "Project assignment should drive grouping and filtering.",
        idempotencyKey: `project-assignment-event-${randomUUID()}`,
        sourceHash: `project-assignment-event-${randomUUID()}`
      }
    );
    const manualGraph = await repo.listLcmGraphThreads(
      { userId: alice.id },
      { projectId: "project-manual", limit: 10 }
    );
    const reset = await repo.resetCapturedSessionProject(
      { userId: alice.id },
      session.id
    );
    const automaticGraph = await repo.listLcmGraphThreads(
      { userId: alice.id },
      { projectId: "project-detected-b", limit: 10 }
    );

    expect(session).toMatchObject({
      workspaceId: capturedWorkspaceId,
      automaticProject: { id: "project-detected-a" },
      project: { id: "project-detected-a" },
      projectAssignmentSource: "detected"
    });
    expect(bobSession).toMatchObject({
      ownerUserId: bob.id,
      automaticProject: { id: "project-other-owner" },
      project: { id: "project-other-owner" },
      projectAssignmentSource: "detected"
    });
    expect(bobSession.id).not.toBe(session.id);
    expect(moved).toMatchObject({
      workspaceId: capturedWorkspaceId,
      projectOverride: { id: "project-manual" },
      project: { id: "project-manual" },
      projectAssignmentSource: "user_override",
      capturedProjectProvenance: capturedProvenance
    });
    expect(forbiddenMove).toBeNull();
    expect(redetected).toMatchObject({
      workspaceId: capturedWorkspaceId,
      automaticProject: { id: "project-detected-b" },
      projectOverride: { id: "project-manual" },
      project: { id: "project-manual" },
      projectAssignmentSource: "user_override",
      capturedProjectProvenance: capturedProvenance
    });
    expect(latestCapturedSession?.id).toBe(session.id);
    expect(organizationalLookup).toBeNull();
    expect(manualGraph[0]).toMatchObject({
      id: "project-manual",
      eventCount: 1,
      threads: [
        { sessionId: session.id, projectAssignmentSource: "user_override" }
      ]
    });
    expect(reset).toMatchObject({
      workspaceId: capturedWorkspaceId,
      projectOverride: null,
      project: { id: "project-detected-b" },
      projectAssignmentSource: "detected",
      capturedProjectProvenance: capturedProvenance
    });
    expect(automaticGraph[0]).toMatchObject({
      id: "project-detected-b",
      eventCount: 1,
      threads: [{ sessionId: session.id, projectAssignmentSource: "detected" }]
    });
  });

  it("leaves ambiguous detected Personal Projects unassigned", async () => {
    const alice = await repo.createUser({
      email: `alice-ambiguous-project-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `ambiguous-project-${randomUUID()}`,
        idempotencyKey: `ambiguous-project-${randomUUID()}`,
        detectedProjects: [
          { id: "project-a", name: "Project A", path: "/work/a" },
          { id: "project-b", name: "Project B", path: "/work/b" }
        ]
      }
    );
    const graph = await repo.listLcmGraphThreads(
      { userId: alice.id },
      { projectId: "unassigned", limit: 10 }
    );

    expect(session).toMatchObject({
      automaticProject: null,
      projectOverride: null,
      project: null,
      projectAssignmentSource: null,
      capturedProjectProvenance: { outcome: "ambiguous" }
    });
    expect(graph[0]).toMatchObject({ id: "unassigned", name: "Unassigned" });
  });

  it("preserves automatic Project assignment on incomplete idempotent replays", async () => {
    const owner = await repo.createUser({
      email: `project-replay-owner-${randomUUID()}@example.com`
    });
    const idempotencyKey = `project-replay-${randomUUID()}`;
    const created = await repo.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: `project-replay-thread-${randomUUID()}`,
        idempotencyKey,
        detectedProjects: [
          { id: "project-a", name: "Project A", path: "/work/project-a" }
        ]
      }
    );
    const incompleteReplay = await repo.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: created.externalSessionId ?? undefined,
        idempotencyKey
      }
    );
    const explicitNoSignalReplay = await repo.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: created.externalSessionId ?? undefined,
        idempotencyKey,
        detectedProjects: []
      }
    );

    expect(incompleteReplay).toMatchObject({
      id: created.id,
      automaticProject: { id: "project-a" },
      project: { id: "project-a" },
      projectAssignmentSource: "detected",
      capturedProjectProvenance: created.capturedProjectProvenance
    });
    expect(explicitNoSignalReplay).toMatchObject({
      id: created.id,
      automaticProject: null,
      project: null,
      projectAssignmentSource: null,
      capturedProjectProvenance: created.capturedProjectProvenance
    });
  });

  it("keeps Personal Project assignment mutable without changing capture or Team authority", async () => {
    const owner = await repo.createUser({
      email: `project-assignment-owner-${randomUUID()}@example.com`
    });
    const member = await repo.createUser({
      email: `project-assignment-member-${randomUUID()}@example.com`
    });
    const team = await repo.createTeam(
      { userId: owner.id },
      { name: "Project Assignment Team" }
    );
    await repo.upsertTeamMember(
      { userId: owner.id },
      { teamId: team.id, userId: member.id, role: "member" }
    );
    const teamWorkspace = await repo.createTeamWorkspace(
      { userId: owner.id },
      { teamId: team.id, name: "Project Assignment Workspace" }
    );
    await repo.setTeamWorkspaceAccess(
      { userId: owner.id },
      {
        teamWorkspaceId: teamWorkspace!.id,
        userId: member.id,
        access: "read"
      }
    );

    const idempotencyKey = `project-assignment-${randomUUID()}`;
    const captured = await repo.createCapturedSession(
      { userId: owner.id },
      {
        workspaceId: "source-project-a",
        externalSessionId: `project-assignment-thread-${randomUUID()}`,
        idempotencyKey,
        metadata: {
          projectName: "Source Project A",
          projectPath: "/work/source-a"
        },
        detectedProjects: [
          {
            id: "project-a",
            name: "Project A",
            path: "/work/source-a"
          }
        ]
      }
    );
    const event = await repo.createMemoryEvent(
      { userId: owner.id },
      {
        workspaceId: "source-project-a",
        sessionId: captured.id,
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        visibility: "personal",
        content: "Mutable assignment lexical sentinel",
        metadata: {
          projectName: "Source Project A",
          projectPath: "/work/source-a",
          externalSessionId: captured.externalSessionId
        }
      }
    );
    await repo.createTeamSessionShareGrant(
      { userId: owner.id },
      { teamWorkspaceId: teamWorkspace!.id, sessionId: captured.id }
    );

    const moved = await repo.moveCapturedSessionToProject(
      { userId: owner.id },
      captured.id,
      { id: "project-b", name: "Project B", path: "/work/manual-b" }
    );
    const redetected = await repo.createCapturedSession(
      { userId: owner.id },
      {
        workspaceId: "source-project-c",
        externalSessionId: captured.externalSessionId ?? undefined,
        idempotencyKey,
        metadata: {
          projectName: "Source Project C",
          projectPath: "/work/source-c"
        },
        detectedProjects: [
          {
            id: "project-c",
            name: "Project C",
            path: "/work/source-c"
          }
        ]
      }
    );
    const rejectedOtherOwner = await repo.moveCapturedSessionToProject(
      { userId: member.id },
      captured.id,
      { id: "project-c", name: "Project C", path: null }
    );
    const personalProjects = await repo.listLcmGraphThreads(
      { userId: owner.id },
      { projectId: "project-b", limit: 20 }
    );
    const teamProjects = await repo.listLcmGraphThreads(
      { userId: member.id },
      { teamWorkspaceId: teamWorkspace!.id, limit: 20 }
    );
    const engine = createMemoryEngine(repo);
    const movedRecall = await engine.searchMemory({
      requesterContext: { userId: owner.id },
      query: "Mutable assignment lexical sentinel",
      scope: "personal",
      searchDomain: "project",
      workspaceId: "project-b",
      retrievalStage: "lexical_search",
      strictLimit: true,
      limit: 1
    });
    const oldProjectRecall = await engine.searchMemory({
      requesterContext: { userId: owner.id },
      query: "Mutable assignment lexical sentinel",
      scope: "personal",
      searchDomain: "project",
      workspaceId: "project-a",
      retrievalStage: "lexical_search",
      strictLimit: false,
      limit: 1
    });
    const reset = await repo.resetCapturedSessionProject(
      { userId: owner.id },
      captured.id
    );
    const ambiguous = await repo.createCapturedSession(
      { userId: owner.id },
      {
        idempotencyKey: `ambiguous-project-${randomUUID()}`,
        detectedProjects: [
          { id: "project-a", name: "Project A", path: "/work/a" },
          { id: "project-b", name: "Project B", path: "/work/b" }
        ]
      }
    );

    expect(captured).toMatchObject({
      project: { id: "project-a" },
      projectAssignmentSource: "detected",
      capturedProjectProvenance: {
        outcome: "unambiguous",
        candidates: [{ id: "project-a" }]
      }
    });
    expect(moved).toMatchObject({
      project: { id: "project-b" },
      projectOverride: { id: "project-b" },
      projectAssignmentSource: "user_override"
    });
    expect(redetected).toMatchObject({
      id: captured.id,
      automaticProject: { id: "project-c" },
      project: { id: "project-b" },
      projectAssignmentSource: "user_override",
      capturedProjectProvenance: {
        candidates: [{ id: "project-a" }]
      }
    });
    expect(rejectedOtherOwner).toBeNull();
    expect(personalProjects).toEqual([
      expect.objectContaining({
        id: "project-b",
        eventCount: 1,
        threads: [
          expect.objectContaining({
            sessionId: captured.id,
            projectAssignmentSource: "user_override"
          })
        ]
      })
    ]);
    expect(movedRecall.results).toEqual([
      expect.objectContaining({ sourceId: event.id })
    ]);
    expect(oldProjectRecall.results).toHaveLength(0);
    expect(teamProjects).toEqual([
      expect.objectContaining({
        id: teamWorkspace!.id,
        name: "Team Workspace",
        path: null,
        threads: [
          expect.objectContaining({
            projectAssignmentSource: null,
            capturedProjectProvenance: {}
          })
        ]
      })
    ]);
    expect(reset).toMatchObject({
      automaticProject: { id: "project-c" },
      projectOverride: null,
      project: { id: "project-c" },
      projectAssignmentSource: "detected"
    });
    expect(ambiguous).toMatchObject({
      automaticProject: null,
      projectOverride: null,
      project: null,
      projectAssignmentSource: null,
      capturedProjectProvenance: { outcome: "ambiguous" }
    });
  });

  it("keeps projected app-server threads under the canonical session project", async () => {
    const alice = await repo.createUser({
      email: `alice-canonical-project-${randomUUID()}@example.com`
    });
    const cwd = "/workspace/koed";
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        cwd,
        externalSessionId: `canonical-project-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `canonical-project-session-${randomUUID()}`
      }
    );
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "turn-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 0,
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  type: "agentMessage",
                  text: "Canonical project message"
                }
              }
            },
            sourceHash: `canonical-project-raw-${randomUUID()}`,
            idempotencyKey: `canonical-project-raw-${randomUUID()}`,
            metadata: {
              workspaceId: session.id,
              transcriptType: "agent_message"
            }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "turn-1",
            sourceRecordType: "hook_payload",
            sourceEventType: "Stop",
            sourceSequence: 1,
            rawJson: { hook_event_name: "Stop", turn_id: "turn-1" },
            sourceHash: `canonical-project-stop-${randomUUID()}`,
            idempotencyKey: `canonical-project-stop-${randomUUID()}`,
            metadata: { workspaceId: session.id }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const projects = await repo.listLcmGraphThreads(
      { userId: alice.id },
      { limit: 10 }
    );

    expect(projection.memoryEventsCreated).toBe(1);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.id).toBe(cwd);
    expect(projects[0]?.threads).toHaveLength(1);
  });

  it("preserves manual session titles across idempotent capture upserts", async () => {
    const alice = await repo.createUser({
      email: `alice-manual-title-upsert-${randomUUID()}@example.com`
    });
    const idempotencyKey = `manual-title-session-${randomUUID()}`;
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `manual-title-thread-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        idempotencyKey,
        metadata: {
          threadName: "Original Hook Title",
          threadNameSource: "provisional"
        }
      }
    );
    await repo.updateCapturedSessionTitle({ userId: alice.id }, session.id, {
      title: "Manual Rename Wins"
    });

    const upserted = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: session.externalSessionId ?? undefined,
        sourceRuntime: "codex-cli",
        idempotencyKey,
        metadata: {
          threadName: "Original Hook Title",
          threadNameSource: "provisional",
          projectName: "Updated Project"
        }
      }
    );

    expect(upserted.id).toBe(session.id);
    expect(upserted.metadata).toMatchObject({
      projectName: "Updated Project",
      threadName: "Manual Rename Wins",
      threadNameSource: "manual"
    });
  });

  it("uses capture-hook subagent actors for generated title eligibility", async () => {
    const alice = await repo.createUser({
      email: `alice-subagent-title-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `subagent-title-thread-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        idempotencyKey: `subagent-title-session-${randomUUID()}`,
        metadata: {
          threadName: "subagent-title-thread",
          threadNameSource: "provisional",
          threadKind: "subagent"
        }
      }
    );
    await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId,
        sessionId: session.id,
        actor: "agent",
        eventType: "captured",
        rawEventType: "message",
        visibility: "personal",
        content: "Please inspect the session rename implementation.",
        idempotencyKey: `subagent-title-agent-${randomUUID()}`,
        sourceHash: `subagent-title-agent-${randomUUID()}`
      }
    );
    await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId,
        sessionId: session.id,
        actor: "subagent",
        eventType: "captured",
        rawEventType: "message",
        visibility: "personal",
        content: "The implementation should cover manual title precedence.",
        idempotencyKey: `subagent-title-reply-${randomUUID()}`,
        sourceHash: `subagent-title-reply-${randomUUID()}`
      }
    );

    const candidates = await repo.listCapturedSessionsNeedingTitles(
      { userId: alice.id },
      { minUserEvents: 1, limit: 5 }
    );
    const candidate = candidates.find((item) => item.id === session.id);

    expect(candidate).toMatchObject({
      id: session.id,
      eventCount: 1
    });
    expect(candidate?.sourceItems.map((item) => item.actor)).toEqual([
      "agent",
      "subagent"
    ]);
  });

  it("stores concrete parent session linkage for subagent sessions", async () => {
    const alice = await repo.createUser({
      email: `alice-subagent-parent-${randomUUID()}@example.com`
    });
    const parent = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `parent-thread-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        idempotencyKey: `parent-session-${randomUUID()}`
      }
    );
    const child = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `child-thread-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        idempotencyKey: `child-session-${randomUUID()}`,
        metadata: {
          threadKind: "subagent",
          parentThreadId: parent.externalSessionId
        }
      }
    );
    const row = await pool.query<{ parent_session_id: string | null }>(
      "select parent_session_id from sessions where id = $1",
      [child.id]
    );

    expect(row.rows[0]?.parent_session_id).toBe(parent.id);
  });

  it("fetches an exact LCM graph node when newer summaries mention the node id", async () => {
    const alice = await repo.createUser({
      email: `alice-exact-lcm-node-${randomUUID()}@example.com`
    });
    const target = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText: "Target LCM node summary",
        summaryModel: "codex:test"
      }
    );
    await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText: `Newer rollup summary mentions node ${target.id}`,
        summaryModel: "codex:test"
      }
    );

    const fetched = await repo.getLcmGraphNode({ userId: alice.id }, target.id);

    expect(fetched?.id).toBe(target.id);
    expect(fetched?.summaryText).toBe("Target LCM node summary");
  });

  it("expands session-backed memory event sources for exact LCM graph nodes", async () => {
    const alice = await repo.createUser({
      email: `alice-session-lcm-source-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Session Source Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `session-source-${randomUUID()}`,
        idempotencyKey: `session-source-${randomUUID()}`
      }
    );
    const event = await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId,
        sessionId: session.id,
        actor: "agent",
        eventType: "captured",
        rawEventType: "agent_turn",
        visibility: "personal",
        content:
          "Session-backed semantic source should expand from node detail",
        idempotencyKey: `session-backed-event-${randomUUID()}`,
        sourceHash: `session-backed-event-${randomUUID()}`
      }
    );
    const node = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText: "Node summary linked to session-backed semantic source",
        summaryModel: "codex:test"
      }
    );
    await pool.query(
      `
        insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
        values ($1, $2, 0)
      `,
      [node.id, event.id]
    );

    const displayEvents = await repo.listLcmGraphEvents(
      { userId: alice.id },
      { query: "Session-backed semantic source", limit: 10 }
    );
    const exactEvent = await repo.getLcmGraphEvent(
      { userId: alice.id },
      event.id
    );
    const graphNode = await repo.getLcmGraphNode({ userId: alice.id }, node.id);

    expect(displayEvents.map((item) => item.id)).not.toContain(event.id);
    expect(exactEvent?.id).toBe(event.id);
    expect(graphNode?.sources.map((source) => source.id)).toEqual([event.id]);
  });

  it("persists structured LCM summary data beside summary text", async () => {
    const alice = await repo.createUser({
      email: `alice-structured-lcm-${randomUUID()}@example.com`
    });
    const node = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText: "Pending placeholder"
      }
    );
    const structured = {
      summary_text: "Structured summary text",
      facts: ["The worker returned strict JSON."],
      unresolved_questions: []
    };

    await repo.updateLcmNodeSummary({
      nodeId: node.id,
      summaryText: "Structured summary text",
      summaryModel: "codex:test",
      summaryPromptVersion: "lcm-codex-summary-json-v2",
      summaryTokenEstimate: 17,
      summaryStructuredJson: structured,
      summaryStructuredSchemaVersion: "lcm-structured-summary-v1"
    });

    const fetched = await repo.getLcmNodeForSummarization(node.id);
    const visible = await repo.getVisibleLcmNodeForSummarization(
      { userId: alice.id },
      node.id
    );
    const graphNode = await repo.getLcmGraphNode({ userId: alice.id }, node.id);

    expect(fetched?.summaryText).toBe("Structured summary text");
    expect(fetched?.summaryStructuredJson).toEqual(structured);
    expect(fetched?.summaryStructuredSchemaVersion).toBe(
      "lcm-structured-summary-v1"
    );
    expect(visible?.summaryStructuredJson).toEqual(structured);
    expect(graphNode?.summaryStructuredJson).toEqual(structured);
    expect(graphNode?.summaryStructuredSchemaVersion).toBe(
      "lcm-structured-summary-v1"
    );
  });

  it("prefers idempotency key matches over source hash matches", async () => {
    const alice = await repo.createUser({
      email: `alice-duplicate-priority-${randomUUID()}@example.com`
    });
    const firstIdempotencyKey = `idempotency-${randomUUID()}`;
    const firstSourceHash = `source-hash-${randomUUID()}`;
    const secondIdempotencyKey = `idempotency-${randomUUID()}`;
    const secondSourceHash = `source-hash-${randomUUID()}`;
    const first = await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId: "workspace-duplicate-priority",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        visibility: "personal",
        content: "First duplicate priority event",
        idempotencyKey: firstIdempotencyKey,
        sourceHash: firstSourceHash
      }
    );
    await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId: "workspace-duplicate-priority",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        visibility: "personal",
        content: "Second duplicate priority event",
        idempotencyKey: secondIdempotencyKey,
        sourceHash: secondSourceHash
      }
    );

    const mismatchedRetry = await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId: "workspace-duplicate-priority",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        visibility: "personal",
        content: "Mismatched duplicate priority event",
        idempotencyKey: firstIdempotencyKey,
        sourceHash: secondSourceHash
      }
    );

    expect(mismatchedRetry.id).toBe(first.id);
  });

  it("returns a conflict for duplicate keys outside caller visibility", async () => {
    const alice = await repo.createUser({
      email: `alice-hidden-duplicate-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-hidden-duplicate-${randomUUID()}@example.com`
    });
    const sourceHash = `source-hash-${randomUUID()}`;
    await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId: "workspace-hidden-duplicate",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        visibility: "personal",
        content: "Hidden duplicate source",
        sourceHash
      }
    );

    await expect(
      repo.createMemoryEvent(
        { userId: bob.id },
        {
          workspaceId: "workspace-hidden-duplicate",
          actor: "user",
          eventType: "captured",
          rawEventType: "user_prompt",
          visibility: "personal",
          content: "Hidden duplicate retry",
          sourceHash
        }
      )
    ).rejects.toMatchObject({
      message:
        "Duplicate memory event conflicts with memory outside caller visibility",
      statusCode: 409
    });
  });

  it("handles concurrent duplicate capture submissions", async () => {
    const alice = await repo.createUser({
      email: `alice-concurrent-duplicate-${randomUUID()}@example.com`
    });
    const sourceHash = `source-hash-${randomUUID()}`;
    const idempotencyKey = `idempotency-${randomUUID()}`;
    const captures = await Promise.all(
      Array.from({ length: 8 }, () =>
        repo.createMemoryEvent(
          { userId: alice.id },
          {
            workspaceId: "workspace-concurrent-duplicate",
            actor: "user",
            eventType: "captured",
            rawEventType: "user_prompt",
            visibility: "personal",
            content: "Concurrent duplicate capture",
            idempotencyKey,
            sourceHash
          }
        )
      )
    );
    const events = await repo.listLcmGraphEvents(
      { userId: alice.id },
      { query: "Concurrent duplicate capture", includeInvalidated: false }
    );

    expect(new Set(captures.map((event) => event.id)).size).toBe(1);
    expect(events.map((event) => event.id)).toEqual([captures[0]!.id]);
  });

  it("stores canonical transport chunks under one canonical parent", async () => {
    const owner = await repo.createUser({
      email: `canonical-chunk-parent-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: `canonical-chunk-thread-${randomUUID()}`,
        sourceRuntime: "codex",
        captureMethod: "api"
      }
    );
    const threadId = session.externalSessionId!;
    const turnId = "canonical-chunk-turn";
    const stableItemId = "canonical-chunk-message";
    const canonicalItemKey = codexCanonicalConversationItemKey({
      externalThreadId: threadId,
      externalTurnId: turnId,
      stableItemId,
      component: "message"
    });
    const reconstructedText =
      "One oversized canonical message must retain one logical parent.";
    const envelope = JSON.stringify({
      rawJson: {
        type: "response_item",
        payload: {
          id: stableItemId,
          type: "message",
          role: "user",
          client_id: stableItemId,
          content: [{ type: "input_text", text: reconstructedText }]
        }
      },
      rawText: reconstructedText,
      metadata: { transcriptType: "user_message" }
    });
    const midpoint = Math.floor(envelope.length / 2);
    const chunkTexts = [envelope.slice(0, midpoint), envelope.slice(midpoint)];
    const items: ConversationItemInput[] = chunkTexts.map((chunk, index) => ({
      sessionId: session.id,
      sourceKind: "codex",
      sourceAdapterVersion: "codex-transcript-v1",
      sourceTransport: "transcript",
      externalSessionId: threadId,
      externalThreadId: threadId,
      externalTurnId: turnId,
      externalItemId: stableItemId,
      canonicalItemKey,
      canonicalStableItemId: stableItemId,
      observationComponent: "message",
      sourceRecordType: "response_item",
      sourceEventType: "message",
      sourcePath: "/tmp/canonical-chunk.jsonl",
      sourceLineNumber: 4,
      sourceSequence: 4 + index,
      rawJson: {
        transportChunk: true,
        sourceItemHash: stableItemId,
        chunkIndex: index,
        chunkCount: chunkTexts.length
      },
      logicalSourceId: canonicalItemKey,
      transportChunkIndex: index,
      transportChunkCount: chunkTexts.length,
      transportChunkText: chunk,
      transportChunkEncoding: "conversation-item-json-v2",
      sourceHash: `canonical-chunk-source-${index}`,
      idempotencyKey: `canonical-chunk-observation-${index}`,
      metadata: {
        transcriptType: "user_message",
        sourceItemHash: stableItemId,
        sourceChunkIndex: index,
        sourceChunkCount: chunkTexts.length
      }
    }));

    const created = await repo.createConversationItems(
      { userId: owner.id },
      { items }
    );
    const replayed = await repo.createConversationItems(
      { userId: owner.id },
      { items }
    );
    const projection = await repo.projectPendingConversationItems(
      { userId: owner.id },
      { limit: 10 }
    );
    const persisted = await pool.query<{
      parents: number;
      observations: number;
      parent_keys: number;
    }>(
      `
        select
          (select count(*)::int from conversation_items where owner_user_id = $1) as parents,
          (select count(*)::int from conversation_item_observations where owner_user_id = $1) as observations,
          (
            select count(distinct canonical_item_key)::int
            from conversation_items
            where owner_user_id = $1
          ) as parent_keys
      `,
      [owner.id]
    );
    const events = await pool.query<{ content: string }>(
      "select payload ->> 'content' as content from memory_events where session_id = $1",
      [session.id]
    );

    expect(new Set(created.map((item) => item.id)).size).toBe(1);
    expect(new Set(replayed.map((item) => item.id))).toEqual(
      new Set(created.map((item) => item.id))
    );
    expect(persisted.rows[0]).toEqual({
      parents: 1,
      observations: 2,
      parent_keys: 1
    });
    expect(projection.memoryEventsCreated).toBe(1);
    expect(events.rows).toEqual([{ content: reconstructedText }]);
  });

  it("never splices transport chunks from different source groups", async () => {
    const owner = await repo.createUser({
      email: `chunk-group-isolation-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: `chunk-group-thread-${randomUUID()}`,
        sourceRuntime: "codex",
        captureMethod: "api"
      }
    );
    const threadId = session.externalSessionId!;
    const turnId = "chunk-group-turn";
    const stableItemId = "chunk-group-message";
    const canonicalItemKey = codexCanonicalConversationItemKey({
      externalThreadId: threadId,
      externalTurnId: turnId,
      stableItemId,
      component: "message"
    });
    const envelopes = Object.fromEntries(
      (
        [
          ["group-a-source", "Complete source group A."],
          ["group-b-source", "Complete source group B."]
        ] as const
      ).map(([sourceItemHash, text]) => {
        const envelope = JSON.stringify({
          rawJson: {
            type: "response_item",
            payload: {
              id: stableItemId,
              client_id: stableItemId,
              type: "message",
              role: "user",
              content: [{ type: "input_text", text }]
            }
          },
          rawText: text,
          metadata: { transcriptType: "user_message" }
        });
        const midpoint = Math.floor(envelope.length / 2);
        const chunks = [envelope.slice(0, midpoint), envelope.slice(midpoint)];
        const groupId = rawConversationTransportChunkGroupId({
          sourceKind: "codex",
          sourceAdapterVersion: "codex-transcript-v1",
          sourceTransport: "transcript",
          logicalSourceId: canonicalItemKey,
          sourceItemHash,
          transportChunkCount: chunks.length,
          transportChunkEncoding: "conversation-item-json-v2"
        });
        return [sourceItemHash, { text, chunks, groupId }];
      })
    ) as Record<string, { text: string; chunks: string[]; groupId: string }>;
    const chunkItem = (
      sourceItemHash: string,
      chunkIndex: number,
      sourceSequence: number
    ): ConversationItemInput => {
      const source = envelopes[sourceItemHash]!;
      return {
        sessionId: session.id,
        sourceKind: "codex",
        sourceAdapterVersion: "codex-transcript-v1",
        sourceTransport: "transcript",
        externalSessionId: threadId,
        externalThreadId: threadId,
        externalTurnId: turnId,
        externalItemId: stableItemId,
        canonicalItemKey,
        canonicalStableItemId: stableItemId,
        observationKind: "reconciliation",
        observationComponent: "message",
        sourceRecordType: "response_item",
        sourceEventType: "message",
        sourcePath: "/tmp/chunk-group-isolation.jsonl",
        sourceLineNumber: sourceSequence,
        sourceSequence,
        rawJson: {
          transportChunk: true,
          transportChunkGroupId: source.groupId,
          sourceItemHash,
          chunkIndex,
          chunkCount: source.chunks.length
        },
        logicalSourceId: canonicalItemKey,
        transportChunkIndex: chunkIndex,
        transportChunkCount: source.chunks.length,
        transportChunkText: source.chunks[chunkIndex]!,
        transportChunkEncoding: "conversation-item-json-v2",
        sourceHash: `${sourceItemHash}:chunk:${chunkIndex}`,
        idempotencyKey: `${sourceItemHash}:observation:${chunkIndex}`,
        metadata: { transcriptType: "user_message" }
      };
    };

    await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          chunkItem("group-a-source", 0, 1),
          chunkItem("group-b-source", 1, 2)
        ]
      }
    );
    await repo.projectPendingConversationItems(
      { userId: owner.id },
      { limit: 10 }
    );
    const failedParent = await pool.query<{
      group_id: string;
      projection_error: string | null;
      projection_status: string;
    }>(
      `
        select
          metadata ->> 'transportChunkGroupId' as group_id,
          projection_error,
          projection_status
        from conversation_items
        where owner_user_id = $1
      `,
      [owner.id]
    );
    expect(failedParent.rows[0]).toMatchObject({
      projection_status: "error"
    });
    expect(failedParent.rows[0]?.projection_error).toContain(
      "Incomplete transport chunk group"
    );
    expect(
      await pool.query("select id from memory_events where session_id = $1", [
        session.id
      ])
    ).toHaveProperty("rowCount", 0);

    const selectedSourceItemHash = Object.entries(envelopes).find(
      ([, value]) => value.groupId === failedParent.rows[0]?.group_id
    )?.[0];
    expect(selectedSourceItemHash).toBeTruthy();
    const missingChunkIndex =
      selectedSourceItemHash === "group-a-source" ? 1 : 0;
    await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [chunkItem(selectedSourceItemHash!, missingChunkIndex, 3)]
      }
    );
    const recovered = await repo.projectPendingConversationItems(
      { userId: owner.id },
      { limit: 10 }
    );
    const projected = await pool.query<{ content: string }>(
      "select payload ->> 'content' as content from memory_events where session_id = $1",
      [session.id]
    );
    expect(recovered.memoryEventsCreated).toBe(1);
    expect(projected.rows).toEqual([
      { content: envelopes[selectedSourceItemHash!]!.text }
    ]);
  });

  it("keeps a higher-priority unchunked source canonical when transcript chunks reconcile", async () => {
    const owner = await repo.createUser({
      email: `canonical-unchunked-winner-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: `canonical-unchunked-thread-${randomUUID()}`,
        sourceRuntime: "codex",
        captureMethod: "api"
      }
    );
    const threadId = session.externalSessionId!;
    const turnId = "canonical-unchunked-turn";
    const stableItemId = "canonical-unchunked-message";
    const canonicalItemKey = codexCanonicalConversationItemKey({
      externalThreadId: threadId,
      externalTurnId: turnId,
      stableItemId,
      component: "message"
    });
    const text = "The app-server item remains the canonical unchunked payload.";

    await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-conversation-v1",
            sourceTransport: "app_server",
            externalSessionId: threadId,
            externalThreadId: threadId,
            externalTurnId: turnId,
            externalItemId: stableItemId,
            canonicalItemKey,
            canonicalStableItemId: stableItemId,
            canonicalSourcePriority: 300,
            observationKind: "lifecycle_completed",
            observationComponent: "message",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 1,
            rawJson: {
              method: "item/completed",
              params: {
                item: { id: stableItemId, type: "userMessage", text }
              }
            },
            rawText: text,
            sourceHash: `canonical-unchunked-app-${randomUUID()}`,
            idempotencyKey: `canonical-unchunked-app-${randomUUID()}`,
            metadata: { transcriptType: "user_message" }
          }
        ]
      }
    );

    const envelope = JSON.stringify({
      rawJson: {
        type: "response_item",
        payload: {
          id: stableItemId,
          type: "message",
          role: "user",
          client_id: stableItemId,
          content: [{ type: "input_text", text }]
        }
      },
      rawText: text,
      metadata: { transcriptType: "user_message" }
    });
    const midpoint = Math.floor(envelope.length / 2);
    const chunks = [envelope.slice(0, midpoint), envelope.slice(midpoint)];
    await repo.createConversationItems(
      { userId: owner.id },
      {
        items: chunks.map((chunk, index) => ({
          sessionId: session.id,
          sourceKind: "codex",
          sourceAdapterVersion: "codex-transcript-v1",
          sourceTransport: "transcript",
          externalSessionId: threadId,
          externalThreadId: threadId,
          externalTurnId: turnId,
          externalItemId: stableItemId,
          canonicalItemKey,
          canonicalStableItemId: stableItemId,
          canonicalSourcePriority: 200,
          observationKind: "reconciliation" as const,
          observationComponent: "message",
          sourceRecordType: "response_item",
          sourceEventType: "message",
          sourceSequence: 2 + index,
          rawJson: {
            transportChunk: true,
            sourceItemHash: stableItemId,
            chunkIndex: index,
            chunkCount: chunks.length
          },
          logicalSourceId: canonicalItemKey,
          transportChunkIndex: index,
          transportChunkCount: chunks.length,
          transportChunkText: chunk,
          transportChunkEncoding: "conversation-item-json-v2",
          sourceHash: `canonical-unchunked-transcript-${index}-${randomUUID()}`,
          idempotencyKey: `canonical-unchunked-transcript-${index}-${randomUUID()}`,
          metadata: {
            transcriptType: "user_message",
            sourceChunkIndex: index,
            sourceChunkCount: chunks.length
          }
        }))
      }
    );

    const canonical = await pool.query<{
      logical_source_id: string | null;
      transport_chunk_count: number;
      source_transport: string;
      observations: number;
    }>(
      `
        select
          ci.logical_source_id,
          ci.transport_chunk_count,
          ci.source_transport,
          count(cio.id)::int as observations
        from conversation_items ci
        join conversation_item_observations cio on cio.conversation_item_id = ci.id
        where ci.owner_user_id = $1 and ci.canonical_item_key = $2
        group by ci.id
      `,
      [owner.id, canonicalItemKey]
    );
    const projection = await repo.projectPendingConversationItems(
      { userId: owner.id },
      { limit: 10 }
    );
    const events = await pool.query<{ content: string }>(
      "select payload ->> 'content' as content from memory_events where session_id = $1",
      [session.id]
    );

    expect(canonical.rows).toEqual([
      {
        logical_source_id: null,
        transport_chunk_count: 1,
        source_transport: "app_server",
        observations: 3
      }
    ]);
    expect(projection.memoryEventsCreated).toBe(1);
    expect(events.rows).toEqual([{ content: text }]);
  });

  it("augments canonical app-server tool calls with richer transcript metadata", async () => {
    const owner = await repo.createUser({
      email: `canonical-tool-metadata-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: `canonical-tool-thread-${randomUUID()}`,
        sourceRuntime: "codex",
        captureMethod: "api",
        metadata: { managedConversation: true }
      }
    );
    const threadId = session.externalSessionId!;
    const turnId = "canonical-tool-turn";
    const callId = `canonical-tool-call-${randomUUID()}`;
    const canonicalItemKey = codexCanonicalConversationItemKey({
      externalThreadId: threadId,
      externalTurnId: turnId,
      stableItemId: callId,
      component: "tool_call"
    });
    const appItem: ConversationItemInput = {
      sessionId: session.id,
      sourceKind: "codex",
      sourceAdapterVersion: "codex-app-server-conversation-v1",
      sourceTransport: "app_server",
      externalSessionId: threadId,
      externalThreadId: threadId,
      externalTurnId: turnId,
      externalItemId: callId,
      canonicalItemKey,
      canonicalStableItemId: callId,
      canonicalSourcePriority: 300,
      observationKind: "lifecycle_completed",
      observationComponent: "tool_call",
      sourceRecordType: "app_server_notification",
      sourceEventType: "item/completed",
      sourceSequence: 1,
      rawJson: {
        method: "item/completed",
        params: { item: { id: callId, type: "commandExecution" } }
      },
      rawText: 'Tool call: exec_command\n\nInput:\n{"cmd":"pwd"}',
      sourceHash: `canonical-tool-app-${randomUUID()}`,
      idempotencyKey: `canonical-tool-app-${randomUUID()}`,
      metadata: {
        transcriptType: "function_call",
        toolName: "exec_command",
        toolCallId: callId,
        toolCall: {
          kind: "call",
          type: "function_call",
          id: callId,
          name: "exec_command",
          input: { cmd: "pwd" }
        }
      }
    };
    const transcriptItem: ConversationItemInput = {
      ...appItem,
      sourceAdapterVersion: "codex-transcript-v1",
      sourceTransport: "transcript",
      canonicalSourcePriority: 200,
      observationKind: "reconciliation",
      sourceRecordType: "response_item",
      sourceEventType: "function_call",
      sourceSequence: 2,
      sourcePath: "/tmp/canonical-tool.jsonl",
      sourceLineNumber: 2,
      rawJson: {
        type: "response_item",
        payload: {
          id: callId,
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"pwd"}'
        }
      },
      sourceHash: `canonical-tool-transcript-${randomUUID()}`,
      idempotencyKey: `canonical-tool-transcript-${randomUUID()}`,
      metadata: {
        transcriptType: "function_call",
        toolName: "exec_command",
        toolCallId: callId,
        toolCall: {
          kind: "call",
          type: "function_call",
          id: callId,
          name: "exec_command",
          input: { cmd: "pwd" },
          workdir: "/tmp/project",
          chunkId: "chunk-123",
          wallTimeSeconds: 0.25,
          originalTokenCount: 12
        }
      }
    };
    const terminalStableId = `turn:${turnId}:completed`;
    const terminalItem: ConversationItemInput = {
      sessionId: session.id,
      sourceKind: "codex",
      sourceAdapterVersion: "codex-transcript-v1",
      sourceTransport: "transcript",
      externalSessionId: threadId,
      externalThreadId: threadId,
      externalTurnId: turnId,
      canonicalItemKey: codexCanonicalConversationItemKey({
        externalThreadId: threadId,
        externalTurnId: turnId,
        stableItemId: terminalStableId,
        component: "control"
      }),
      canonicalStableItemId: terminalStableId,
      observationKind: "reconciliation",
      observationComponent: "control",
      sourceRecordType: "event_msg",
      sourceEventType: "task_complete",
      sourceSequence: 3,
      sourcePath: "/tmp/canonical-tool.jsonl",
      sourceLineNumber: 3,
      rawJson: {
        type: "event_msg",
        payload: { type: "task_complete", turn_id: turnId }
      },
      sourceHash: `canonical-tool-terminal-${randomUUID()}`,
      idempotencyKey: `canonical-tool-terminal-${randomUUID()}`,
      metadata: { transcriptType: "task_complete" }
    };
    await repo.createConversationItems(
      { userId: owner.id },
      { items: [appItem, transcriptItem, terminalItem] }
    );
    await repo.releaseConversationProjectionHold(
      { userId: owner.id },
      { sessionId: session.id, externalTurnId: turnId }
    );
    const projection = await repo.projectPendingConversationItems(
      { userId: owner.id },
      { limit: 10 }
    );
    const stored = await pool.query<{
      tool_call: Record<string, unknown>;
      observations: number;
    }>(
      `
        select
          ci.metadata -> 'toolCall' as tool_call,
          count(cio.id)::int as observations
        from conversation_items ci
        join conversation_item_observations cio on cio.conversation_item_id = ci.id
        where ci.owner_user_id = $1 and ci.canonical_item_key = $2
        group by ci.id
      `,
      [owner.id, canonicalItemKey]
    );
    const toolEvents = await pool.query<{
      tool_input: Record<string, unknown>;
      tool_name: string;
    }>("select tool_input, tool_name from tool_events where session_id = $1", [
      session.id
    ]);
    const events = await pool.query<{
      content: string;
      manifest: Array<Record<string, unknown>>;
    }>(
      `
        select
          payload ->> 'content' as content,
          payload #> '{metadata,semanticItemManifest}' as manifest
        from memory_events
        where session_id = $1
      `,
      [session.id]
    );

    expect(stored.rows[0]).toMatchObject({
      observations: 2,
      tool_call: {
        name: "exec_command",
        workdir: "/tmp/project",
        chunkId: "chunk-123",
        wallTimeSeconds: 0.25,
        originalTokenCount: 12
      }
    });
    expect(projection.toolEventsCreated).toBe(1);
    expect(toolEvents.rows).toEqual([
      { tool_input: { cmd: "pwd" }, tool_name: "exec_command" }
    ]);
    expect(events.rows[0]?.content).toContain("Tool call: exec_command");
    expect(events.rows[0]?.manifest[0]).toMatchObject({
      kind: "tool_call",
      toolName: "exec_command"
    });
  });

  it("derives conversation workspace metadata from the Captured Session", async () => {
    const owner = await repo.createUser({
      email: `conversation-workspace-authority-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      "insert into workspaces (id, owner_user_id, visibility, name) values ($1, $2, 'personal', 'Authoritative workspace')",
      [workspaceId, owner.id]
    );
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        workspaceId,
        externalSessionId: `workspace-authority-thread-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        captureMethod: "hook"
      }
    );
    const [item] = await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "transcript",
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "workspace-authority-turn",
            sourceRecordType: "event_msg",
            sourceEventType: "user_message",
            rawJson: {
              type: "event_msg",
              payload: { type: "user_message", message: "Workspace authority." }
            },
            rawText: "Workspace authority.",
            sourceHash: `workspace-authority-${randomUUID()}`,
            idempotencyKey: `workspace-authority-${randomUUID()}`,
            metadata: {
              workspaceId: "client-controlled-workspace",
              transcriptType: "user_message"
            }
          }
        ]
      }
    );
    const stored = await pool.query<{ workspace_id: string | null }>(
      "select metadata ->> 'workspaceId' as workspace_id from conversation_items where id = $1",
      [item!.id]
    );

    expect(stored.rows[0]?.workspace_id).toBe(workspaceId);
  });

  it("treats raw provider roles as authoritative over transcriptType metadata", async () => {
    const owner = await repo.createUser({
      email: `provider-role-policy-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: `provider-role-thread-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        captureMethod: "hook"
      }
    );
    const base = {
      sessionId: session.id,
      sourceKind: "codex",
      sourceAdapterVersion: "codex-transcript-v1",
      sourceTransport: "hook",
      externalThreadId: session.externalSessionId ?? undefined,
      externalTurnId: "provider-role-turn",
      sourceRecordType: "response_item",
      sourceEventType: "message",
      eventTime: "2026-07-12T01:00:00.000Z"
    } as const;

    await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          {
            ...base,
            externalItemId: "developer-message",
            sourceSequence: 1,
            rawJson: {
              type: "response_item",
              payload: {
                id: "developer-message",
                type: "message",
                role: "developer",
                content: [
                  {
                    type: "input_text",
                    text: "Developer instructions must remain raw provenance."
                  }
                ]
              }
            },
            rawText: "Developer instructions must remain raw provenance.",
            sourceHash: `provider-role-developer-${randomUUID()}`,
            idempotencyKey: `provider-role-developer-${randomUUID()}`,
            metadata: { transcriptType: "user_message" }
          },
          {
            ...base,
            externalItemId: "user-message",
            sourceSequence: 2,
            rawJson: {
              type: "response_item",
              payload: {
                id: "user-message",
                client_id: "user-message",
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "Provider user content remains user content."
                  }
                ]
              }
            },
            rawText: "Provider user content remains user content.",
            sourceHash: `provider-role-user-${randomUUID()}`,
            idempotencyKey: `provider-role-user-${randomUUID()}`,
            metadata: { transcriptType: "system_message" }
          }
        ]
      }
    );

    await repo.projectPendingConversationItems(
      { userId: owner.id },
      { limit: 10 }
    );
    const messages = await pool.query<{ role: string; content: string }>(
      "select role, content from messages where session_id = $1 order by content",
      [session.id]
    );
    const events = await pool.query<{ actor: string; content: string }>(
      `
        select payload ->> 'actor' as actor, payload ->> 'content' as content
        from memory_events
        where session_id = $1
      `,
      [session.id]
    );

    expect(messages.rows).toEqual([
      { role: "user", content: "Provider user content remains user content." }
    ]);
    expect(events.rows).toEqual([
      { actor: "user", content: "Provider user content remains user content." }
    ]);
  });

  it("keeps display-only Projection messages out of every recall source path", async () => {
    const owner = await repo.createUser({
      email: `display-only-recall-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    const transcriptType = `display_only_plan_${randomUUID().replaceAll("-", "_")}`;
    await pool.query(
      "insert into workspaces (id, owner_user_id, visibility, name) values ($1, $2, 'personal', 'Display only recall')",
      [workspaceId, owner.id]
    );
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        workspaceId,
        externalSessionId: `display-only-thread-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        captureMethod: "hook"
      }
    );
    await pool.query(
      `
        insert into projection_policy_rules (
          transcript_type, description, project_to_ui, create_message,
          create_tool_event, create_memory_event, include_in_embedding,
          include_in_lcm
        )
        values ($1, 'Display-only recall regression.', true, true, false, false, false, false)
      `,
      [transcriptType]
    );

    try {
      const [source] = await repo.createConversationItems(
        { userId: owner.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "hook",
              externalThreadId: session.externalSessionId ?? undefined,
              externalTurnId: "display-only-turn",
              sourceRecordType: "response_item",
              sourceEventType: transcriptType,
              sourceSequence: 1,
              eventTime: "2026-07-12T01:01:00.000Z",
              rawJson: {
                type: "response_item",
                payload: {
                  type: transcriptType,
                  content: "Display-only sentinel Indigo Parallax."
                }
              },
              rawText: "Display-only sentinel Indigo Parallax.",
              sourceHash: `display-only-${randomUUID()}`,
              idempotencyKey: `display-only-${randomUUID()}`,
              metadata: { transcriptType, workspaceId }
            }
          ]
        }
      );
      const projection = await repo.projectPendingConversationItems(
        { userId: owner.id },
        { limit: 10 }
      );
      const message = await pool.query<{
        id: string;
        recall_eligible: boolean;
        projection_policy_key: string | null;
      }>(
        `
          select id, recall_eligible, projection_policy_key
          from messages
          where session_id = $1
        `,
        [session.id]
      );
      const embeddable = await repo.listSourcesNeedingEmbeddings(100);
      const directSource = await repo.getEmbeddableSource(
        "message",
        message.rows[0]!.id
      );
      await expect(
        repo.upsertSourceEmbedding({
          source: {
            sourceType: "message",
            sourceId: message.rows[0]!.id,
            ownerUserId: owner.id,
            visibility: "personal",
            text: "Display-only sentinel Indigo Parallax.",
            sourceHash: `display-only-message-${message.rows[0]!.id}`
          },
          model: process.env.EMBEDDING_MODEL ?? "qwen3-0.6b",
          dimensions: 1024,
          version: process.env.EMBEDDING_MODEL ?? "qwen3-0.6b",
          vector: Array.from({ length: 1024 }, (_, index) =>
            index === 0 ? 1 : 0
          )
        })
      ).rejects.toThrow("display-only messages cannot be embedded for recall");
      const recall = await createMemoryEngine(repo).searchMemory({
        requesterContext: { userId: owner.id },
        query: "Indigo Parallax",
        scope: "personal",
        searchDomain: "project",
        workspaceId,
        retrievalStage: "lexical_search",
        limit: 10
      });

      expect(source).toBeTruthy();
      expect(projection.messagesCreated).toBe(1);
      expect(projection.memoryEventsCreated).toBe(0);
      expect(message.rows).toEqual([
        {
          id: message.rows[0]!.id,
          recall_eligible: false,
          projection_policy_key: transcriptType
        }
      ]);
      expect(
        embeddable.some(
          (candidate) =>
            candidate.sourceType === "message" &&
            candidate.sourceId === message.rows[0]!.id
        )
      ).toBe(false);
      expect(directSource).toBeNull();
      expect(recall.results).toEqual([]);
    } finally {
      await pool.query(
        "delete from projection_policy_rules where transcript_type = $1",
        [transcriptType]
      );
    }
  });

  it("loads Projection Policy only after acquiring the session rebuild lock", async () => {
    const owner = await repo.createUser({
      email: `projection-policy-lock-${randomUUID()}@example.com`
    });
    const transcriptType = `policy_lock_plan_${randomUUID().replaceAll("-", "_")}`;
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: `policy-lock-thread-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        captureMethod: "hook"
      }
    );
    await pool.query(
      `
        insert into projection_policy_rules (
          transcript_type, project_to_ui, create_message, create_tool_event,
          create_memory_event, include_in_embedding, include_in_lcm
        )
        values ($1, true, true, false, true, true, true)
      `,
      [transcriptType]
    );
    await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "policy-lock-turn",
            sourceRecordType: "response_item",
            sourceEventType: transcriptType,
            eventTime: "2026-07-12T01:02:00.000Z",
            rawJson: {
              type: "response_item",
              payload: {
                type: transcriptType,
                content: "Policy lock content."
              }
            },
            rawText: "Policy lock content.",
            sourceHash: `policy-lock-${randomUUID()}`,
            idempotencyKey: `policy-lock-${randomUUID()}`,
            metadata: { transcriptType }
          }
        ]
      }
    );
    const initial = await repo.projectPendingConversationItems(
      { userId: owner.id },
      { limit: 10 }
    );
    expect(initial.memoryEventsCreated).toBe(1);

    const blocker = await pool.connect();
    const lockKey = `conversation-projection-session:${owner.id}:${session.id}`;
    try {
      await blocker.query("select pg_advisory_lock(hashtextextended($1, 0))", [
        lockKey
      ]);
      const rebuilding = repo.resetConversationProjection(
        { userId: owner.id },
        { sessionId: session.id }
      );
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const waiting = await pool.query<{ count: number }>(
          `
            select count(*)::int as count
            from pg_stat_activity
            where datname = current_database()
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
              and wait_event = 'advisory'
          `
        );
        if ((waiting.rows[0]?.count ?? 0) > 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await pool.query(
        `
          update projection_policy_rules
          set create_memory_event = false,
              include_in_embedding = false,
              include_in_lcm = false,
              updated_at = now()
          where transcript_type = $1
        `,
        [transcriptType]
      );
      await blocker.query(
        "select pg_advisory_unlock(hashtextextended($1, 0))",
        [lockKey]
      );
      const reset = await rebuilding;
      const projected = await repo.projectPendingConversationItems(
        { userId: owner.id },
        {
          limit: 10,
          conversationItemIds: reset.conversationItemIds
        }
      );
      const active = await pool.query<{
        messages: number;
        events: number;
        policy_revision: number;
      }>(
        `
          select
            (select count(*)::int from messages where session_id = $1 and invalidated_at is null) as messages,
            (select count(*)::int from memory_events where session_id = $1 and invalidated_at is null) as events,
            (select revision::int from projection_policy_state where id = 1) as policy_revision
        `,
        [session.id]
      );

      expect(projected.memoryEventsCreated).toBe(0);
      expect(reset.projectionPolicyRevision).toBe(
        active.rows[0]?.policy_revision
      );
      expect(active.rows[0]).toEqual({
        messages: 1,
        events: 0,
        policy_revision: reset.projectionPolicyRevision
      });
    } finally {
      await blocker.query(
        "select pg_advisory_unlock(hashtextextended($1, 0))",
        [lockKey]
      );
      blocker.release();
      await pool.query(
        "delete from projection_policy_rules where transcript_type = $1",
        [transcriptType]
      );
    }
  });

  it("keeps identical token counts from distinct provider occurrences", async () => {
    const owner = await repo.createUser({
      email: `token-occurrences-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: `token-occurrences-thread-${randomUUID()}`,
        sourceRuntime: "codex",
        captureMethod: "api"
      }
    );
    const tokenUsage = {
      modelContextWindow: 200_000,
      last: {
        inputTokens: 20,
        cachedInputTokens: 4,
        outputTokens: 8,
        reasoningOutputTokens: 2,
        totalTokens: 28
      }
    };
    await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [0, 1].flatMap((index) => {
          const stableItemId = `token-occurrence-${index}`;
          const canonicalItemKey = codexCanonicalConversationItemKey({
            externalThreadId: session.externalSessionId!,
            externalTurnId: "same-count-turn",
            stableItemId,
            component: "control"
          });
          const canonical = {
            sessionId: session.id,
            sourceKind: "codex",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "same-count-turn",
            externalItemId: stableItemId,
            canonicalItemKey,
            canonicalStableItemId: stableItemId,
            observationComponent: "control"
          } as const;
          return [
            {
              ...canonical,
              sourceAdapterVersion: "codex-app-server-conversation-v1",
              sourceTransport: "app_server",
              sourceRecordType: "app_server_notification",
              sourceEventType: "thread/tokenUsage/updated",
              sourceSequence: index * 2,
              rawJson: {
                method: "thread/tokenUsage/updated",
                params: { tokenUsage }
              },
              sourceHash: `token-occurrence-app-${index}-${randomUUID()}`,
              idempotencyKey: `token-occurrence-app-${index}-${randomUUID()}`,
              metadata: { occurrenceId: `provider-occurrence-${index}` }
            },
            {
              ...canonical,
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "transcript",
              sourceRecordType: "token_count",
              sourceEventType: "token_count",
              sourceSequence: index * 2 + 1,
              rawJson: {
                type: "token_count",
                input_tokens: 20,
                cached_input_tokens: 4,
                output_tokens: 8,
                reasoning_output_tokens: 2,
                total_tokens: 28,
                model_context_window: 200_000
              },
              sourceHash: `token-occurrence-jsonl-${index}-${randomUUID()}`,
              idempotencyKey: `token-occurrence-jsonl-${index}-${randomUUID()}`,
              metadata: { occurrenceId: `provider-occurrence-${index}` }
            }
          ];
        })
      }
    );

    await repo.projectPendingConversationItems(
      { userId: owner.id },
      { limit: 10 }
    );
    const usage = await pool.query<{
      idempotency_key: string;
      total_tokens: number | null;
    }>(
      `
        select idempotency_key, total_tokens
        from workflow_token_usage
        where owner_user_id = $1
        order by idempotency_key
      `,
      [owner.id]
    );

    expect(usage.rows).toHaveLength(2);
    expect(usage.rows.map((row) => row.total_tokens)).toEqual([28, 28]);
    expect(new Set(usage.rows.map((row) => row.idempotency_key)).size).toBe(2);
    expect(
      (
        await pool.query<{ parents: number; observations: number }>(
          `
            select
              (select count(*)::int from conversation_items where owner_user_id = $1) as parents,
              (select count(*)::int from conversation_item_observations where owner_user_id = $1) as observations
          `,
          [owner.id]
        )
      ).rows[0]
    ).toEqual({ parents: 2, observations: 4 });
  });

  it("lists stable personal LCM dispatch reconciliation scopes", async () => {
    const owner = await repo.createUser({
      email: `lcm-dispatch-reconcile-${randomUUID()}@example.com`
    });
    const included = await Promise.all(
      ["A", "B"].map((suffix) =>
        repo.createMemoryEvent(
          { userId: owner.id },
          {
            workspaceId: "lcm-dispatch-project",
            actor: "user",
            eventType: "captured",
            rawEventType: "user_turn",
            visibility: "personal",
            content: `LCM dispatch event ${suffix}`,
            idempotencyKey: `lcm-dispatch-${suffix}-${randomUUID()}`,
            metadata: { includeInLcm: true }
          }
        )
      )
    );
    await repo.createMemoryEvent(
      { userId: owner.id },
      {
        workspaceId: "lcm-dispatch-project",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_turn",
        visibility: "personal",
        content: "LCM dispatch excluded event",
        idempotencyKey: `lcm-dispatch-excluded-${randomUUID()}`,
        metadata: { includeInLcm: false }
      }
    );

    const first = await repo.listPendingLcmDispatchScopes({ limit: 10 });
    const second = await repo.listPendingLcmDispatchScopes({ limit: 10 });
    const expectedIds = included.map((event) => event.id).sort();

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      ownerUserId: owner.id,
      visibility: "personal",
      pendingMemoryEventIds: expectedIds
    });
    expect(first[0]?.dispatchKey).toMatch(/^lcm-dispatch:/);
    expect(second).toEqual(first);

    const leafId = randomUUID();
    await pool.query(
      `
        insert into memory_nodes (
          id, owner_user_id, visibility, kind, depth, title, summary_text,
          body_text, source_event_count, source_token_estimate,
          summary_token_estimate, source_items_json, source_hash,
          idempotency_key, capture_method
        )
        values (
          $1, $2, 'personal', 'leaf', 0, 'LCM dispatch leaf',
          'LCM dispatch leaf', 'LCM dispatch leaf', 1, 4, 4, '[]'::jsonb,
          $3, $4, 'api'
        )
      `,
      [
        leafId,
        owner.id,
        `lcm-dispatch-leaf-source-${randomUUID()}`,
        `lcm-dispatch-leaf-${randomUUID()}`
      ]
    );
    await pool.query(
      "insert into memory_node_sources (memory_node_id, memory_event_id, source_order) values ($1, $2, 0)",
      [leafId, expectedIds[0]]
    );

    const afterLeaf = await repo.listPendingLcmDispatchScopes({ limit: 10 });
    expect(afterLeaf[0]?.pendingMemoryEventIds).toEqual([expectedIds[1]]);
    expect(afterLeaf[0]?.dispatchKey).not.toBe(first[0]?.dispatchKey);

    await pool.query(
      "update memory_nodes set invalidated_at = now(), invalidation_reason = 'test_refresh' where id = $1",
      [leafId]
    );
    const afterInvalidation = await repo.listPendingLcmDispatchScopes({
      limit: 10
    });
    expect(afterInvalidation[0]?.pendingMemoryEventIds).toEqual(expectedIds);
    expect(afterInvalidation[0]?.dispatchKey).not.toBe(first[0]?.dispatchKey);

    const previousMaxEvents = process.env.MEMORY_LCM_COMPACTION_MAX_EVENTS;
    process.env.MEMORY_LCM_COMPACTION_MAX_EVENTS = "1";
    try {
      const bounded = await repo.listPendingLcmDispatchScopes({ limit: 10 });
      expect(bounded[0]?.pendingMemoryEventIds).toHaveLength(1);
      expect(expectedIds).toContain(bounded[0]?.pendingMemoryEventIds[0]);
    } finally {
      if (previousMaxEvents === undefined) {
        delete process.env.MEMORY_LCM_COMPACTION_MAX_EVENTS;
      } else {
        process.env.MEMORY_LCM_COMPACTION_MAX_EVENTS = previousMaxEvents;
      }
    }
  });
});
