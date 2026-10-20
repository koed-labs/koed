#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  sharedMemoryGrantScopedSourceId
} from "@koed/shared";
import { loadRootEnv } from "../../../scripts/api-token-bootstrap-lib.mjs";
import {
  getLatestMigrationTimestamp,
  runDbMigrations
} from "../dist/migrate.js";

const { Client, Pool } = pg;

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = resolve(packageDir, "../..");

loadRootEnv(rootDir, process.env);

const databaseUrl =
  process.env.KOED_MIGRATION_SMOKE_DATABASE_URL ?? process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(
    "DATABASE_URL is required for the migration smoke test. Point it at a Postgres server whose user can create and drop databases."
  );
  process.exit(2);
}

const targetDatabase =
  process.env.KOED_MIGRATION_SMOKE_DATABASE ??
  `koed_migration_smoke_${process.pid}_${Date.now().toString(36)}`;

if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(targetDatabase)) {
  console.error(
    `Unsafe migration smoke database name: ${JSON.stringify(targetDatabase)}`
  );
  process.exit(2);
}

const adminDatabase =
  process.env.KOED_MIGRATION_SMOKE_ADMIN_DATABASE ?? "postgres";

const withDatabase = (connectionString, database) => {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
};

const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;

const migrationsFolder = resolve(packageDir, "drizzle");
const pre0020LastIndex = 19;
const current0020Index = 20;
const expectedPre0020Tag = "0019_tidy_rhino";
const expectedCurrent0020Tag = "0020_zippy_apocalypse";
const expectedLocalRuntimeCutoverTag = "0026_amused_zeigeist";
const expectedPreSelectivePiiTag = "0033_fixed_scarlet_witch";
const expectedSelectivePiiTag = "0034_young_silvermane";
const expectedGenericSharedMemoryTag = "0035_concerned_the_twelve";
const expectedPrivacyManifestTag = "0036_gifted_leader";
const expectedRemoteMcpOAuthTag = "0043_remote_mcp_oauth";
const expectedTeamAuthorityTag = "0044_memory_answer_team_authority";
const expectedLatestMigrationTag = "0052_free_ghost_rider";
const preMultiComponentSourceIndex = 29;
const expectedLatestMigrationIndex = 52;
const expectedPre0020Fingerprint =
  "0308ea8a58969a9dbbfd1fc480d32f71fd4507b2fcc130c73cf9c244af1a8598";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const loadMigrationJournal = async (folder = migrationsFolder) => {
  const journal = JSON.parse(
    await readFile(resolve(folder, "meta", "_journal.json"), "utf8")
  );
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error("Drizzle migration journal has no entries");
  }
  for (const [index, entry] of journal.entries.entries()) {
    if (
      entry.idx !== index ||
      typeof entry.tag !== "string" ||
      typeof entry.when !== "number" ||
      (index > 0 && entry.when <= journal.entries[index - 1].when)
    ) {
      throw new Error(
        `Drizzle migration journal is not sequential at entry ${index}`
      );
    }
  }
  return journal;
};

const migrationRecords = async (folder, entries) =>
  Promise.all(
    entries.map(async (entry) => {
      const sql = await readFile(resolve(folder, `${entry.tag}.sql`), "utf8");
      return { ...entry, hash: sha256(sql), sql };
    })
  );

const assertAlphaMigrationContract = async () => {
  const journal = await loadMigrationJournal();
  const pre0020Entries = journal.entries.slice(0, pre0020LastIndex + 1);
  const pre0020Records = await migrationRecords(
    migrationsFolder,
    pre0020Entries
  );
  const pre0020Fingerprint = sha256(
    JSON.stringify(
      pre0020Records.map(({ idx, when, tag, hash }) => ({
        idx,
        when,
        tag,
        hash
      }))
    )
  );
  if (
    pre0020Entries.at(-1)?.tag !== expectedPre0020Tag ||
    pre0020Fingerprint !== expectedPre0020Fingerprint
  ) {
    throw new Error(
      `Pre-0020 migration history is not the exact current-main baseline: ${pre0020Fingerprint}`
    );
  }
  const entriesAt0020 = journal.entries.filter(
    (entry) => entry.idx === current0020Index || entry.tag.startsWith("0020_")
  );
  if (
    entriesAt0020.length !== 1 ||
    entriesAt0020[0].idx !== current0020Index ||
    entriesAt0020[0].tag !== expectedCurrent0020Tag
  ) {
    throw new Error(
      `Expected one ${expectedCurrent0020Tag} migration at index ${current0020Index}`
    );
  }
  const current0020Sql = await readFile(
    resolve(migrationsFolder, `${expectedCurrent0020Tag}.sql`),
    "utf8"
  );
  if (
    current0020Sql.includes("team_chat_threads") ||
    current0020Sql.includes("team_chat_messages")
  ) {
    throw new Error(
      "Current 0020 migration contains discarded experimental Team Chat compatibility objects"
    );
  }
  const localRuntimeCutoverEntries = journal.entries.filter(
    (entry) => entry.tag === expectedLocalRuntimeCutoverTag
  );
  if (
    localRuntimeCutoverEntries.length !== 1 ||
    localRuntimeCutoverEntries[0].idx < 1
  ) {
    throw new Error(
      `Expected exactly one ${expectedLocalRuntimeCutoverTag} migration with a predecessor`
    );
  }
  if (
    journal.entries[42]?.tag !== "0042_owner_scoped_projection_identity" ||
    journal.entries[43]?.tag !== expectedRemoteMcpOAuthTag ||
    journal.entries[44]?.tag !== expectedTeamAuthorityTag ||
    journal.entries.at(-1)?.idx !== expectedLatestMigrationIndex ||
    journal.entries.at(-1)?.tag !== expectedLatestMigrationTag
  ) {
    throw new Error(
      `Expected ${expectedLatestMigrationTag} at migration index ${expectedLatestMigrationIndex} to be latest`
    );
  }
  return journal;
};

const createMigrationSlice = async (
  journal,
  lastIndex,
  { folderPrefix = "koed-migration-slice-", transformLastSql } = {}
) => {
  const targetFolder = await mkdtemp(resolve(tmpdir(), folderPrefix));
  const targetMetaFolder = resolve(targetFolder, "meta");
  await mkdir(targetMetaFolder, { recursive: true });
  const entries = journal.entries.slice(0, lastIndex + 1);
  if (entries.length !== lastIndex + 1) {
    throw new Error(`Migration journal does not reach index ${lastIndex}`);
  }
  for (const entry of entries) {
    const source = resolve(migrationsFolder, `${entry.tag}.sql`);
    const target = resolve(targetFolder, `${entry.tag}.sql`);
    if (entry.idx === lastIndex && transformLastSql) {
      await writeFile(target, transformLastSql(await readFile(source, "utf8")));
    } else {
      await copyFile(source, target);
    }
  }
  await writeFile(
    resolve(targetMetaFolder, "_journal.json"),
    `${JSON.stringify({ ...journal, entries }, null, 2)}\n`
  );
  return targetFolder;
};

const seedRemovedPathCompanion = async (
  pool,
  provider,
  { ownerUserId, sourceId, sourceTable, sourceColumn, plaintext }
) => {
  const aad = {
    ownerUserId,
    visibility: "personal",
    encryptionScope: "personal",
    teamId: null,
    teamWorkspaceId: null,
    sourceTable,
    sourceId,
    sourceColumn
  };
  const envelope = await provider.encrypt({
    plaintext,
    scope: {},
    provenance: {
      rowFamily: sourceTable,
      sourceTable,
      sourceColumn,
      sourceId
    },
    ciphertextLocation: "encrypted_field_payloads",
    aad
  });
  await pool.query(
    `
      insert into encrypted_field_payloads (
        owner_user_id, visibility, encryption_scope, source_table, source_id,
        source_column, plaintext_content_type, plaintext_encoding,
        envelope_version, provider_mode, key_id, key_version, scope,
        provenance, algorithm, ciphertext, nonce, tag, wrapped_dek,
        ciphertext_location, aad, envelope_created_at, envelope_reencrypted_at
      )
      values (
        $1, 'personal', 'personal', $2, $3, $4, 'text/plain', 'utf8',
        $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14,
        $15::jsonb, $16, $17::jsonb, $18, $19
      )
    `,
    [
      ownerUserId,
      sourceTable,
      sourceId,
      sourceColumn,
      envelope.version,
      envelope.providerMode,
      envelope.keyId,
      envelope.keyVersion,
      JSON.stringify(envelope.scope),
      JSON.stringify(envelope.provenance),
      envelope.algorithm,
      envelope.ciphertext,
      envelope.nonce,
      envelope.tag,
      JSON.stringify(envelope.wrappedDek),
      envelope.ciphertextLocation,
      JSON.stringify(envelope.aad),
      envelope.createdAt,
      envelope.reencryptedAt
    ]
  );
};

const seedAlphaResetFixture = async (pool, provider) => {
  const ownerUserId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const messageId = randomUUID();
  const toolEventId = randomUUID();
  const memoryEventId = randomUUID();
  const memoryNodeId = randomUUID();
  const conversationItemId = randomUUID();
  const importRunId = randomUUID();
  const importSourceId = randomUUID();
  const deploymentId = randomUUID();
  const logicalMemoryId = randomUUID();
  const sourceReplicaId = randomUUID();
  const targetReplicaId = randomUUID();
  const sourcePath = "/private/legacy/operator/transcript.jsonl";
  const retainedText = "Retained canonical conversation item.";
  const externalThreadId = `alpha-reset-${randomUUID()}`;

  await pool.query("insert into users (id, email) values ($1, $2)", [
    ownerUserId,
    `alpha-reset-${ownerUserId}@example.test`
  ]);
  await pool.query(
    `
      insert into workspaces (id, owner_user_id, visibility, name, root_path)
      values ($1, $2, 'personal', 'Obsolete Personal Workspace', '/private/project')
    `,
    [workspaceId, ownerUserId]
  );
  await pool.query(
    `
      insert into sessions (
        id, owner_user_id, workspace_id, visibility, external_session_id,
        external_thread_id, source_runtime, capture_method,
        codex_transcript_path, idempotency_key, source_hash
      )
      values (
        $1, $2, $3, 'personal', $4, $4, 'codex-cli', 'hook',
        $5, $6, $6
      )
    `,
    [
      sessionId,
      ownerUserId,
      workspaceId,
      externalThreadId,
      sourcePath,
      `alpha-reset-session-${sessionId}`
    ]
  );
  await pool.query(
    `
      insert into turns (
        id, session_id, owner_user_id, visibility, source_runtime,
        capture_method
      )
      values ($1, $2, $3, 'personal', 'codex-cli', 'hook')
    `,
    [turnId, sessionId, ownerUserId]
  );
  await pool.query(
    `
      insert into messages (
        id, session_id, turn_id, owner_user_id, visibility, role, content,
        source_runtime, capture_method
      )
      values (
        $1, $2, $3, $4, 'personal', 'assistant',
        'Legacy Capture Hook message.', 'codex-cli', 'hook'
      )
    `,
    [messageId, sessionId, turnId, ownerUserId]
  );
  await pool.query(
    `
      insert into tool_events (
        id, session_id, turn_id, message_id, owner_user_id, visibility,
        tool_name, source_runtime, capture_method
      )
      values (
        $1, $2, $3, $4, $5, 'personal',
        'legacy_hook_fixture', 'codex-cli', 'hook'
      )
    `,
    [toolEventId, sessionId, turnId, messageId, ownerUserId]
  );
  await pool.query(
    `
      insert into memory_events (
        id, owner_user_id, visibility, event_type, source_runtime,
        capture_method, session_id, turn_id, message_id, tool_event_id
      )
      values (
        $1, $2, 'personal', 'captured', 'codex-cli',
        'hook', $3, $4, $5, $6
      )
    `,
    [memoryEventId, ownerUserId, sessionId, turnId, messageId, toolEventId]
  );
  await pool.query(
    `
      insert into memory_nodes (
        id, owner_user_id, visibility, kind, summary_text,
        source_runtime, capture_method
      )
      values (
        $1, $2, 'personal', 'leaf',
        'Legacy Capture Hook summary.', 'codex-cli', 'hook'
      )
    `,
    [memoryNodeId, ownerUserId]
  );
  await pool.query(
    `
      insert into conversation_items (
        id, owner_user_id, visibility, session_id, source_kind,
        source_adapter_version, source_transport, external_session_id,
        external_thread_id, source_record_type, source_event_type,
        source_path, source_line_number, source_sequence, raw_json, raw_text,
        source_hash, idempotency_key, canonical_item_key
      )
      values (
        $1, $2, 'personal', $3, 'codex', 'codex-transcript-v1',
        'transcript', $4, $4, 'response_item', 'message', $5, 7, 7,
        $6::jsonb, $7, $8, $8, $8
      )
    `,
    [
      conversationItemId,
      ownerUserId,
      sessionId,
      externalThreadId,
      sourcePath,
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: retainedText }
      }),
      retainedText,
      `alpha-reset-item-${conversationItemId}`
    ]
  );
  await pool.query(
    `
      insert into historical_import_runs (id, owner_user_id, source_count)
      values ($1, $2, 1)
    `,
    [importRunId, ownerUserId]
  );
  await pool.query(
    `
      insert into historical_import_sources (
        id, run_id, owner_user_id, ai_client, source_kind, source_session_id,
        source_fingerprint, registration_prefix_hash, local_source_path,
        redacted_source_label
      )
      values (
        $1, $2, $3, 'codex', 'transcript', $4, $5, $5, $6, 'legacy.jsonl'
      )
    `,
    [
      importSourceId,
      importRunId,
      ownerUserId,
      externalThreadId,
      sha256(sourcePath),
      sourcePath
    ]
  );
  await pool.query(
    `
      insert into deployment_identities (
        id, protocol_deployment_id, locality, profile, display_name
      )
      values ($1, $1, 'local', 'local_personal', 'Alpha reset')
    `,
    [deploymentId]
  );
  await pool.query(
    `
      insert into logical_memories (
        id, owner_user_id, origin_deployment_identity_id, source_boundary,
        origin_source_id, local_session_id, logical_key
      )
      values ($1, $2, $3, 'captured_session', $4, $5, $6)
    `,
    [
      logicalMemoryId,
      ownerUserId,
      deploymentId,
      externalThreadId,
      sessionId,
      `logical-${sessionId}`
    ]
  );
  await pool.query(
    `
      insert into memory_replicas (
        id, logical_memory_id, deployment_identity_id, owner_user_id,
        replica_role, source_boundary, local_session_id
      )
      values
        ($1, $3, $4, $5, 'source', 'captured_session', $6),
        ($2, $3, $4, $5, 'target', 'captured_session', $6)
    `,
    [
      sourceReplicaId,
      targetReplicaId,
      logicalMemoryId,
      deploymentId,
      ownerUserId,
      sessionId
    ]
  );
  await seedRemovedPathCompanion(pool, provider, {
    ownerUserId,
    sourceId: conversationItemId,
    sourceTable: "conversation_items",
    sourceColumn: "source_path",
    plaintext: sourcePath
  });

  return {
    ownerUserId,
    workspaceId,
    sessionId,
    turnId,
    messageId,
    toolEventId,
    memoryEventId,
    memoryNodeId,
    conversationItemId,
    importRunId,
    importSourceId,
    sourceReplicaId,
    targetReplicaId,
    retainedText
  };
};

const verifyAlphaResetUpgrade = async (pool, fixture) => {
  const result = await pool.query(
    `
      select
        to_regclass('public.workspaces')::text as personal_workspaces_table,
        (
          select count(*)::int
          from information_schema.columns
          where table_schema = 'public'
            and column_name in ('source_path', 'codex_transcript_path')
        ) as removed_path_columns,
        (
          select count(*)::int
          from encrypted_field_payloads
          where (source_table in (
              'sessions', 'turns', 'messages', 'tool_events',
              'memory_events', 'memory_nodes'
            ) and source_column = 'codex_transcript_path')
             or (source_table in (
              'conversation_items', 'conversation_item_observations'
            ) and source_column = 'source_path')
        ) as removed_path_companions,
        (select count(*)::int from historical_import_runs) as import_runs,
        (select count(*)::int from historical_import_sources) as import_sources,
        (select count(*)::int from conversation_source_artifacts) as artifacts,
        (select count(*)::int from conversation_source_segments) as segments,
        (select count(*)::int from conversation_source_consumer_cursors) as cursors,
        (
          select raw_text
          from conversation_items
          where id = $1 and owner_user_id = $2 and session_id = $3
        ) as retained_text,
        jsonb_build_object(
          'sessions', (select capture_method::text from sessions where id = $3),
          'turns', (select capture_method::text from turns where id = $6),
          'messages', (select capture_method::text from messages where id = $7),
          'tool_events', (select capture_method::text from tool_events where id = $8),
          'memory_events', (select capture_method::text from memory_events where id = $9),
          'memory_nodes', (select capture_method::text from memory_nodes where id = $10)
        ) as upgraded_capture_methods,
        (
          select encryption_scope
          from memory_replicas
          where id = $4
        ) as source_encryption_scope,
        (
          select encryption_scope
          from memory_replicas
          where id = $5
        ) as target_encryption_scope
    `,
    [
      fixture.conversationItemId,
      fixture.ownerUserId,
      fixture.sessionId,
      fixture.sourceReplicaId,
      fixture.targetReplicaId,
      fixture.turnId,
      fixture.messageId,
      fixture.toolEventId,
      fixture.memoryEventId,
      fixture.memoryNodeId
    ]
  );
  const expected = {
    personal_workspaces_table: null,
    removed_path_columns: 0,
    removed_path_companions: 0,
    import_runs: 0,
    import_sources: 0,
    artifacts: 0,
    segments: 0,
    cursors: 0,
    retained_text: fixture.retainedText,
    upgraded_capture_methods: {
      sessions: "transcript",
      turns: "transcript",
      messages: "transcript",
      tool_events: "transcript",
      memory_events: "transcript",
      memory_nodes: "transcript"
    },
    source_encryption_scope: null,
    target_encryption_scope: null
  };
  if (!isDeepStrictEqual(result.rows[0], expected)) {
    throw new Error(
      `Alpha reset upgrade produced an unexpected boundary: ${JSON.stringify(result.rows[0])}`
    );
  }
};

const seedLocalRuntimeCutoverFixture = async (pool, provider) => {
  const ownerUserId = randomUUID();
  const explorerQuestionId = randomUUID();
  const pendingQuestionId = randomUUID();
  const retainedQuestionId = randomUUID();
  await pool.query("insert into users (id, email) values ($1, $2)", [
    ownerUserId,
    `local-runtime-cutover-${ownerUserId}@example.test`
  ]);
  await pool.query(
    `
      insert into memory_questions (
        id, owner_user_id, origin, search_domain, project_id, query,
        answer_markdown, status, answered_at
      )
      values
        ($1, $4, 'explorer', 'project', '/fixture', 'retired explorer question',
          'retired explorer answer', 'answered', now()),
        ($2, $4, 'mcp_memory_answer', 'project', '/fixture', 'unfinished MCP question',
          null, 'pending', null),
        ($3, $4, 'mcp_memory_answer', 'project', '/fixture', 'retained MCP question',
          'retained MCP answer', 'answered', now())
    `,
    [explorerQuestionId, pendingQuestionId, retainedQuestionId, ownerUserId]
  );
  await seedRemovedPathCompanion(pool, provider, {
    ownerUserId,
    sourceId: explorerQuestionId,
    sourceTable: "memory_questions",
    sourceColumn: "answer_markdown",
    plaintext: "retired explorer answer"
  });
  await seedRemovedPathCompanion(pool, provider, {
    ownerUserId,
    sourceId: retainedQuestionId,
    sourceTable: "memory_questions",
    sourceColumn: "answer_markdown",
    plaintext: "retained MCP answer"
  });
  return {
    explorerQuestionId,
    pendingQuestionId,
    retainedQuestionId
  };
};

const verifyLocalRuntimeCutover = async (pool, fixture) => {
  const result = await pool.query(
    `
      select
        exists(select 1 from memory_questions where id = $1) as explorer_retained,
        exists(select 1 from memory_questions where id = $2) as pending_retained,
        exists(select 1 from memory_questions where id = $3) as final_mcp_retained,
        (select idempotency_key from memory_questions where id = $3)
          as final_mcp_idempotency_key,
        exists(
          select 1 from encrypted_field_payloads
          where source_table = 'memory_questions' and source_id = $1
        ) as explorer_payload_retained,
        exists(
          select 1 from encrypted_field_payloads
          where source_table = 'memory_questions' and source_id = $3
        ) as final_mcp_payload_retained
    `,
    [
      fixture.explorerQuestionId,
      fixture.pendingQuestionId,
      fixture.retainedQuestionId
    ]
  );
  const expected = {
    explorer_retained: false,
    pending_retained: false,
    final_mcp_retained: true,
    final_mcp_idempotency_key: `alpha-final-memory-question:${fixture.retainedQuestionId}`,
    explorer_payload_retained: false,
    final_mcp_payload_retained: true
  };
  if (!isDeepStrictEqual(result.rows[0], expected)) {
    throw new Error(
      `Local AI Runtime cutover produced an unexpected boundary: ${JSON.stringify(result.rows[0])}`
    );
  }
};

const isPostgresAdminTermination = (error) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "57P01";

const assertMigrationLedger = async (pool, expectedRecords) => {
  const result = await pool.query(
    "select hash, created_at::text from drizzle.__drizzle_migrations order by id"
  );
  const expected = expectedRecords.map(({ hash, when }) => ({
    hash,
    created_at: String(when)
  }));
  if (!isDeepStrictEqual(result.rows, expected)) {
    throw new Error(
      `Migration ledger mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(result.rows)}`
    );
  }
  if (expectedRecords.at(-1)?.tag === expectedLatestMigrationTag) {
    await assertLatestSchema(pool);
  }
};

const assertLatestSchema = async (pool) => {
  const columnsByTable = {
    remote_mcp_oauth_clients: [
      ["id", "uuid", "NO"],
      ["metadata", "jsonb", "NO"],
      ["created_at", "timestamp with time zone", "NO"]
    ],
    remote_mcp_oauth_grants: [
      ["id", "uuid", "NO"],
      ["user_id", "uuid", "NO"],
      ["client_id", "uuid", "NO"],
      ["resource", "text", "NO"],
      ["scopes", "ARRAY", "NO"],
      ["expires_at", "timestamp with time zone", "NO"],
      ["revoked_at", "timestamp with time zone", "YES"],
      ["created_at", "timestamp with time zone", "NO"]
    ],
    remote_mcp_oauth_credentials: [
      ["secret_hash", "text", "NO"],
      ["grant_id", "uuid", "NO"],
      ["kind", "text", "NO"],
      ["data", "jsonb", "NO"],
      ["expires_at", "timestamp with time zone", "NO"],
      ["consumed_at", "timestamp with time zone", "YES"],
      ["created_at", "timestamp with time zone", "NO"]
    ],
    remote_mcp_oauth_requests: [
      ["secret_hash", "text", "NO"],
      ["client_id", "uuid", "NO"],
      ["data", "jsonb", "NO"],
      ["expires_at", "timestamp with time zone", "NO"],
      ["consumed_at", "timestamp with time zone", "YES"],
      ["created_at", "timestamp with time zone", "NO"]
    ],
    memory_answer_tasks: [
      ["team_workspace_id", "uuid", "YES"],
      ["team_authorization", "jsonb", "YES"]
    ],
    memory_questions: [["team_authorization", "jsonb", "YES"]],
    conversation_items: [
      ["agent_seal_waiting_at", "timestamp with time zone", "YES"]
    ],
    collaboration_messages: [["reply_to_message_id", "uuid", "YES"]],
    local_edge_collaboration_subscriptions: [
      ["message_contract_version", "integer", "NO"]
    ],
    project_activity: [
      ["owner_user_id", "uuid", "NO"],
      ["project_id", "uuid", "NO"],
      ["sequence", "bigint", "NO"],
      ["actor_user_id", "uuid", "NO"],
      ["kind", "text", "NO"],
      ["ref", "text", "NO"],
      ["at", "timestamp with time zone", "NO"]
    ],
    project_seen: [
      ["owner_user_id", "uuid", "NO"],
      ["project_id", "uuid", "NO"],
      ["seen_sequence", "bigint", "NO"],
      ["seen_at", "timestamp with time zone", "NO"]
    ],
    project_work_items: [
      ["id", "uuid", "NO"],
      ["owner_user_id", "uuid", "NO"],
      ["project_id", "uuid", "NO"],
      ["kind", "text", "NO"],
      ["title", "text", "NO"],
      ["goal", "text", "NO"],
      ["status", "text", "NO"],
      ["due_on", "date", "YES"],
      ["deleted_at", "timestamp with time zone", "YES"],
      ["creation_payload_hash", "text", "NO"],
      ["version", "integer", "NO"]
    ],
    agents: [
      ["id", "uuid", "NO"],
      ["owner_user_id", "uuid", "NO"],
      ["name", "text", "NO"],
      ["role", "text", "YES"],
      ["look", "jsonb", "NO"],
      ["ai_client_instance_id", "text", "NO"],
      ["default_permission_mode", "text", "NO"],
      ["default_model", "text", "YES"],
      ["is_chief_of_staff", "boolean", "NO"],
      ["created_at", "timestamp with time zone", "NO"]
    ]
  };
  const expectedColumns = Object.entries(columnsByTable)
    .flatMap(([table_name, columns]) =>
      columns.map(([column_name, data_type, is_nullable]) => ({
        table_name,
        column_name,
        data_type,
        is_nullable
      }))
    )
    .sort(
      (a, b) =>
        a.table_name.localeCompare(b.table_name) ||
        a.column_name.localeCompare(b.column_name)
    );
  const columns = await pool.query(
    `
    select required.table_name, required.column_name, actual.data_type, actual.is_nullable
    from jsonb_to_recordset($1::jsonb) as required(table_name text, column_name text)
    left join information_schema.columns actual on actual.table_schema = 'public'
      and actual.table_name = required.table_name and actual.column_name = required.column_name
    order by required.table_name, required.column_name`,
    [JSON.stringify(expectedColumns)]
  );
  if (!isDeepStrictEqual(columns.rows, expectedColumns)) {
    throw new Error(
      `Latest migration columns differ: ${JSON.stringify(columns.rows)}`
    );
  }
  const expectedConstraints = [
    ["remote_mcp_oauth_clients", "remote_mcp_oauth_clients_pkey", "p"],
    ["remote_mcp_oauth_credentials", "remote_mcp_oauth_credentials_pkey", "p"],
    ["remote_mcp_oauth_grants", "remote_mcp_oauth_grants_pkey", "p"],
    ["remote_mcp_oauth_requests", "remote_mcp_oauth_requests_pkey", "p"],
    [
      "remote_mcp_oauth_credentials",
      "remote_mcp_oauth_credentials_kind_check",
      "c"
    ],
    ["memory_answer_tasks", "memory_answer_tasks_team_authority_check", "c"],
    [
      "remote_mcp_oauth_credentials",
      "remote_mcp_oauth_credentials_grant_id_remote_mcp_oauth_grants_id_fk",
      "f",
      "remote_mcp_oauth_grants",
      "c"
    ],
    [
      "remote_mcp_oauth_grants",
      "remote_mcp_oauth_grants_user_id_users_id_fk",
      "f",
      "users",
      "c"
    ],
    [
      "remote_mcp_oauth_grants",
      "remote_mcp_oauth_grants_client_id_remote_mcp_oauth_clients_id_fk",
      "f",
      "remote_mcp_oauth_clients",
      "c"
    ],
    [
      "remote_mcp_oauth_requests",
      "remote_mcp_oauth_requests_client_id_remote_mcp_oauth_clients_id_fk",
      "f",
      "remote_mcp_oauth_clients",
      "c"
    ],
    [
      "memory_answer_tasks",
      "memory_answer_tasks_team_workspace_id_team_workspaces_id_fk",
      "f",
      "team_workspaces",
      "a"
    ],
    [
      "collaboration_messages",
      "collaboration_messages_reply_same_thread_fk",
      "f",
      "collaboration_messages",
      "r"
    ],
    [
      "local_edge_collaboration_subscriptions",
      "local_edge_collaboration_subscriptions_values_check",
      "c"
    ],
    [
      "project_work_items",
      "project_work_items_owner_project_fk",
      "f",
      "projects",
      "a"
    ],
    ["project_work_items", "project_work_items_kind_check", "c"],
    ["project_work_items", "project_work_items_status_check", "c"],
    ["project_work_items", "project_work_items_version_check", "c"],
    [
      "project_activity",
      "project_activity_owner_user_id_project_id_sequence_pk",
      "p"
    ],
    [
      "project_activity",
      "project_activity_owner_project_fk",
      "f",
      "projects",
      "c"
    ],
    ["project_activity", "project_activity_event_unique", "u"],
    ["project_activity", "project_activity_sequence_positive", "c"],
    ["project_activity", "project_activity_kind_check", "c"],
    ["project_seen", "project_seen_owner_user_id_project_id_pk", "p"],
    ["project_seen", "project_seen_owner_project_fk", "f", "projects", "c"],
    ["project_seen", "project_seen_sequence_nonnegative", "c"],
    ["agents", "agents_pkey", "p"],
    ["agents", "agents_owner_user_id_users_id_fk", "f", "users", "c"],
    ["agents", "agents_owner_instance_fk", "f", "ai_client_instances", "r"],
    ["agents", "agents_name_check", "c"],
    ["agents", "agents_role_check", "c"],
    ["agents", "agents_look_check", "c"],
    ["agents", "agents_permission_mode_check", "c"],
    ["agents", "agents_model_check", "c"]
  ].map(([table, name, ...contract]) => [
    table,
    name.slice(0, 63),
    ...contract
  ]);
  const constraints = await pool.query(
    `
    select relation.relname as table_name, constraint_row.conname, constraint_row.contype,
      constraint_row.convalidated, referenced.relname as referenced_table, constraint_row.confdeltype,
      pg_get_constraintdef(constraint_row.oid) as definition
    from pg_constraint constraint_row join pg_class relation on relation.oid = constraint_row.conrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    left join pg_class referenced on referenced.oid = constraint_row.confrelid
    where namespace.nspname = 'public' and constraint_row.conname = any($1::text[])`,
    [expectedConstraints.map(([, name]) => name)]
  );
  for (const [
    table,
    name,
    type,
    referencedTable,
    deleteAction
  ] of expectedConstraints) {
    const row = constraints.rows.find(
      (constraint) => constraint.conname === name
    );
    if (
      !row ||
      row.table_name !== table ||
      row.contype !== type ||
      !row.convalidated ||
      (type === "f" &&
        (row.referenced_table !== referencedTable ||
          row.confdeltype !== deleteAction))
    ) {
      throw new Error(
        `Latest migration constraint ${name} is missing or incorrect: ${JSON.stringify(row)}`
      );
    }
  }
  const replyConstraint = constraints.rows.find(
    (constraint) =>
      constraint.conname === "collaboration_messages_reply_same_thread_fk"
  );
  if (
    !replyConstraint?.definition?.includes(
      "FOREIGN KEY (thread_id, reply_to_message_id) REFERENCES collaboration_messages(thread_id, id) ON DELETE RESTRICT"
    )
  ) {
    throw new Error(
      `Team Chat reply constraint does not enforce same-thread references: ${JSON.stringify(replyConstraint)}`
    );
  }
  const messageContractColumn = await pool.query(
    `select column_default from information_schema.columns
     where table_schema = 'public' and table_name = 'local_edge_collaboration_subscriptions'
       and column_name = 'message_contract_version'`
  );
  if (messageContractColumn.rows[0]?.column_default !== "1") {
    throw new Error(
      `Local realtime message contract version must default to v1: ${JSON.stringify(messageContractColumn.rows[0])}`
    );
  }
  const messageContractConstraint = constraints.rows.find(
    (constraint) =>
      constraint.conname ===
      "local_edge_collaboration_subscriptions_values_check"
  );
  if (
    !messageContractConstraint?.definition?.includes(
      "message_contract_version = ANY (ARRAY[1, 2])"
    ) ||
    !messageContractConstraint.definition.includes(
      "(scope = 'team'::collaboration_scope) OR (message_contract_version = 1)"
    )
  ) {
    throw new Error(
      `Local realtime message contract version constraint is missing: ${JSON.stringify(messageContractConstraint)}`
    );
  }
  const indexes =
    await pool.query(`select indexname from pg_indexes where schemaname = 'public'
    and indexname in ('remote_mcp_oauth_credentials_grant_idx', 'remote_mcp_oauth_grants_user_idx')`);
  if (indexes.rows.length !== 2)
    throw new Error("Latest OAuth lookup indexes are missing");
  const workItemPageIndex = await pool.query(
    `select indexdef from pg_indexes where schemaname='public'
     and tablename='project_work_items' and indexname='project_work_items_page_idx'`
  );
  if (
    !/\(owner_user_id, project_id, created_at, id\)/.test(
      workItemPageIndex.rows[0]?.indexdef ?? ""
    )
  )
    throw new Error(
      "Work Item cursor pagination index is missing or has the wrong key order"
    );
  const chiefIndex = await pool.query(
    `select indexdef from pg_indexes where schemaname='public'
     and tablename='agents' and indexname='agents_one_chief_per_owner_idx'`
  );
  if (
    !/UNIQUE INDEX/.test(chiefIndex.rows[0]?.indexdef ?? "") ||
    !/WHERE \(is_chief_of_staff = true\)/.test(
      chiefIndex.rows[0]?.indexdef ?? ""
    )
  )
    throw new Error("One-Chief-per-owner unique index is missing");
  const eventFamily = await pool.query(
    `select enumlabel from pg_enum join pg_type on pg_type.oid=pg_enum.enumtypid
      where pg_type.typname='collaboration_event_family' and enumlabel='work_item_changed'`
  );
  if (eventFamily.rows.length !== 1)
    throw new Error("Work Item realtime event family is missing");
};

const assertCurrentSchema = async (pool) => {
  const result = await pool.query(
    `
      select
        to_regclass('public.users')::text as users_table,
        to_regclass('public.collaboration_threads')::text as collaboration_threads_table,
        to_regclass('public.collaboration_messages')::text as collaboration_messages_table,
        to_regclass('public.conversation_source_artifacts')::text as source_artifacts_table,
        to_regclass('public.conversation_source_segments')::text as source_segments_table,
        to_regclass('public.conversation_source_consumer_cursors')::text as source_cursors_table,
        to_regclass('public.workspaces')::text as removed_personal_workspaces_table,
        to_regclass('drizzle.__drizzle_migrations')::text as migrations_table,
        to_regclass('public.team_chat_threads')::text as discarded_team_chat_table,
        to_regprocedure('public.notify_koed_graph_update()')::text
          as graph_notify_function,
        to_regprocedure('public.pds_session_recall_ready(uuid)')::text
          as pds_recall_function,
        (
          select count(*)::int
          from information_schema.columns
          where table_schema = 'public'
            and column_name in ('source_path', 'codex_transcript_path')
        ) as removed_path_columns,
        (
          select count(*)::int
          from pg_trigger
          where not tgisinternal
            and tgname in (
              'collaboration_threads_participant_set_check',
              'collaboration_threads_participant_identity_check',
              'collaboration_participants_set_check'
            )
        ) as collaboration_participant_triggers
        ,
        (
          select count(*)::int
          from pg_trigger
          where not tgisinternal
            and tgname in (
              'pds_personal_sync_policy_enabled_at',
              'pds_session_closure_immutable',
              'pds_conversation_item_read_only',
              'pds_replica_session_read_only'
            )
        ) as pds_guard_triggers,
        (
          select count(*)::int
          from pg_trigger
          where not tgisinternal
            and tgname in (
              'retention_policy_shortening_preview_transition',
              'retention_policy_shortening_scope_immutable',
              'retention_policy_shortening_migration_immutable',
              'retention_policy_shortening_preview_aggregate',
              'retention_policy_shortening_scope_aggregate',
              'retention_policy_shortening_migration_aggregate'
            )
        ) as retention_policy_triggers
    `
  );
  const row = result.rows[0];
  if (
    row?.users_table !== "users" ||
    row?.collaboration_threads_table !== "collaboration_threads" ||
    row?.collaboration_messages_table !== "collaboration_messages" ||
    row?.source_artifacts_table !== "conversation_source_artifacts" ||
    row?.source_segments_table !== "conversation_source_segments" ||
    row?.source_cursors_table !== "conversation_source_consumer_cursors" ||
    row?.removed_personal_workspaces_table !== null ||
    row?.migrations_table !== "drizzle.__drizzle_migrations" ||
    row?.discarded_team_chat_table !== null ||
    row?.graph_notify_function !== "notify_koed_graph_update()" ||
    row?.pds_recall_function !== "pds_session_recall_ready(uuid)" ||
    row?.removed_path_columns !== 0 ||
    row?.collaboration_participant_triggers !== 3 ||
    row?.pds_guard_triggers !== 4 ||
    row?.retention_policy_triggers !== 6
  ) {
    throw new Error(
      `Current migration schema assertion failed: ${JSON.stringify(row)}`
    );
  }
};

const schemaFingerprint = async (pool) => {
  const [columns, constraints, indexes, triggers, enums] = await Promise.all([
    pool.query(
      `select table_name, ordinal_position, column_name, data_type, udt_name,
              is_nullable, coalesce(column_default, '') as column_default
         from information_schema.columns
        where table_schema = 'public'
        order by table_name, ordinal_position`
    ),
    pool.query(
      `select c.conname, c.contype, pg_get_constraintdef(c.oid, true) as definition
         from pg_constraint c
         join pg_namespace n on n.oid = c.connamespace
        where n.nspname = 'public'
        order by c.conname`
    ),
    pool.query(
      `select tablename, indexname, indexdef
         from pg_indexes
        where schemaname = 'public'
        order by tablename, indexname`
    ),
    pool.query(
      `select c.relname as table_name, t.tgname,
              pg_get_triggerdef(t.oid, true) as definition
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and not t.tgisinternal
        order by c.relname, t.tgname`
    ),
    pool.query(
      `select t.typname, e.enumsortorder, e.enumlabel
         from pg_type t
         join pg_enum e on e.enumtypid = t.oid
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public'
        order by t.typname, e.enumsortorder`
    )
  ]);
  return sha256(
    JSON.stringify(
      [columns, constraints, indexes, triggers, enums].map(
        (result) => result.rows
      )
    )
  );
};

const seedStablePre0020Fixture = async (pool, ownerUserId) => {
  let ownerId = ownerUserId;
  if (!ownerId) {
    ownerId = randomUUID();
    await pool.query(
      "insert into users (id, email, display_name) values ($1, $2, $3)",
      [ownerId, `stable-${ownerId}@example.test`, "Stable migration owner"]
    );
  }
  const teamId = randomUUID();
  const membershipId = randomUUID();
  const workspaceId = randomUUID();
  await pool.query("insert into teams (id, name) values ($1, $2)", [
    teamId,
    "Migration Acceptance Team"
  ]);
  await pool.query(
    `insert into team_memberships (id, team_id, user_id, role, status)
     values ($1, $2, $3, 'owner', 'enabled')`,
    [membershipId, teamId, ownerId]
  );
  await pool.query(
    "insert into team_workspaces (id, team_id, name) values ($1, $2, $3)",
    [workspaceId, teamId, "Migration Acceptance Workspace"]
  );
  await pool.query(
    `insert into team_workspace_access_grants
       (team_workspace_id, team_id, user_id, access, granted_by_user_id)
     values ($1, $2, $3, 'write', $3)`,
    [workspaceId, teamId, ownerId]
  );
  return { ownerId, teamId, membershipId, workspaceId };
};

const stableFixtureFingerprint = async (pool, fixture) => {
  const result = await pool.query(
    `
      select jsonb_build_object(
        'user', (select jsonb_build_array(id, email, display_name) from users where id = $1),
        'team', (select jsonb_build_array(id, name, archived_at) from teams where id = $2),
        'membership', (
          select jsonb_build_array(id, team_id, user_id, role, status)
          from team_memberships where id = $3
        ),
        'workspace', (
          select jsonb_build_array(id, team_id, name, archived_at)
          from team_workspaces where id = $4
        ),
        'access', (
          select jsonb_build_array(team_workspace_id, team_id, user_id, access, granted_by_user_id)
          from team_workspace_access_grants
          where team_workspace_id = $4 and user_id = $1
        )
      ) as fixture
    `,
    [fixture.ownerId, fixture.teamId, fixture.membershipId, fixture.workspaceId]
  );
  const value = result.rows[0]?.fixture;
  if (!value || Object.values(value).some((entry) => entry === null)) {
    throw new Error(
      `Stable pre-0020 fixture was not retained: ${JSON.stringify(value)}`
    );
  }
  return sha256(JSON.stringify(value));
};

const assertUpgradedStableDefaults = async (pool, fixture) => {
  const result = await pool.query(
    `
      select
        (select version from teams where id = $1) as team_version,
        (select lifecycle::text from teams where id = $1) as team_lifecycle,
        (select version from team_memberships where id = $2) as membership_version,
        (select version from team_workspaces where id = $3) as workspace_version,
        (select lifecycle::text from team_workspaces where id = $3) as workspace_lifecycle,
        (select version from team_workspace_access_grants
          where team_workspace_id = $3 and user_id = $4) as access_version,
        (select can_share_owned_memory from team_workspace_access_grants
          where team_workspace_id = $3 and user_id = $4) as can_share_owned_memory
    `,
    [fixture.teamId, fixture.membershipId, fixture.workspaceId, fixture.ownerId]
  );
  const expected = {
    team_version: 1,
    team_lifecycle: "active",
    membership_version: 1,
    workspace_version: 1,
    workspace_lifecycle: "active",
    access_version: 1,
    can_share_owned_memory: false
  };
  if (!isDeepStrictEqual(result.rows[0], expected)) {
    throw new Error(
      `Stable rows received unexpected 0020 defaults: ${JSON.stringify(result.rows[0])}`
    );
  }
};

const expectSqlState = async (
  pool,
  sql,
  expectedCode,
  description,
  params = []
) => {
  try {
    await pool.query(sql, params);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === expectedCode
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`${description} unexpectedly succeeded`);
};

const runPostgresTool = (command, args, connectionString) =>
  new Promise((resolvePromise, reject) => {
    const connection = new URL(connectionString);
    const postgresEnvironment = {
      PGHOST: connection.hostname,
      PGPORT: connection.port || "5432",
      PGUSER: decodeURIComponent(connection.username),
      PGPASSWORD: decodeURIComponent(connection.password),
      PGDATABASE: decodeURIComponent(connection.pathname.slice(1))
    };
    const sslMode = connection.searchParams.get("sslmode");
    if (sslMode) {
      postgresEnvironment.PGSSLMODE = sslMode;
    }
    const child = spawn(command, args, {
      cwd: rootDir,
      env: { ...process.env, ...postgresEnvironment },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(
        new Error(`${command} could not start: ${error.message}`, {
          cause: error
        })
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(
          new Error(
            `${command} failed closed with exit ${code}: ${stderr.trim()}`
          )
        );
      }
    });
  });

const waitForInterruptProbe = async (
  admin,
  database,
  applicationName,
  marker
) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await admin.query(
      `select pid
         from pg_stat_activity
        where datname = $1
          and application_name = $2
          and state = 'active'
          and query like $3`,
      [database, applicationName, `%${marker}%`]
    );
    if (result.rows[0]?.pid) {
      return result.rows[0].pid;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("Timed out waiting for interrupted migration probe");
};

const scenarioDatabaseName = (scenario) => {
  const suffix = scenario.replaceAll(/[^a-zA-Z0-9_]/g, "_");
  const digest = sha256(`${targetDatabase}:${scenario}`).slice(0, 8);
  return `${targetDatabase.slice(0, 42)}_${suffix.slice(0, 10)}_${digest}`;
};

const errorMessages = (error) => {
  const messages = [];
  let current = error;
  while (current && typeof current === "object") {
    if (typeof current.message === "string") messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
};

const admin = new Client({
  connectionString: withDatabase(databaseUrl, adminDatabase)
});
await admin.connect();

const disposableDatabases = new Set();
const results = [];
const temporaryFolders = new Set();

const createDisposableDatabase = async (scenario) => {
  const database = scenarioDatabaseName(scenario);
  if (
    database === adminDatabase ||
    database === new URL(databaseUrl).pathname.slice(1)
  ) {
    throw new Error(`Refusing to use non-disposable database ${database}`);
  }
  await admin.query(
    `drop database if exists ${quoteIdentifier(database)} with (force)`
  );
  await admin.query(`create database ${quoteIdentifier(database)}`);
  disposableDatabases.add(database);
  return { database, url: withDatabase(databaseUrl, database) };
};

const withPool = async (url, callback, options = {}) => {
  const pool = new Pool({ connectionString: url, ...options });
  pool.on("error", (error) => {
    if (!isPostgresAdminTermination(error)) {
      console.error(error);
    }
  });
  try {
    return await callback(pool);
  } finally {
    await pool.end();
  }
};

const runScenario = async (name, callback) => {
  const startedAt = Date.now();
  await callback();
  const result = { name, status: "passed", durationMs: Date.now() - startedAt };
  results.push(result);
  console.error(
    `[migration-acceptance] ${name}: passed (${result.durationMs}ms)`
  );
};

try {
  const journal = await assertAlphaMigrationContract();
  const pre0020Folder = await createMigrationSlice(journal, pre0020LastIndex, {
    folderPrefix: "koed-pre-0020-migrations-"
  });
  temporaryFolders.add(pre0020Folder);
  const through0020Folder = await createMigrationSlice(
    journal,
    current0020Index,
    { folderPrefix: "koed-through-0020-migrations-" }
  );
  temporaryFolders.add(through0020Folder);
  const preSelectivePiiIndex = journal.entries.findIndex(
    (entry) => entry.tag === expectedPreSelectivePiiTag
  );
  if (preSelectivePiiIndex < 0) {
    throw new Error(
      `Expected pre-selective-PII migration ${expectedPreSelectivePiiTag}`
    );
  }
  if (
    journal.entries[preSelectivePiiIndex + 1]?.tag !== expectedSelectivePiiTag
  ) {
    throw new Error(
      `Expected selective-PII migration ${expectedSelectivePiiTag} immediately after ${expectedPreSelectivePiiTag}`
    );
  }
  const preSelectivePiiFolder = await createMigrationSlice(
    journal,
    preSelectivePiiIndex,
    { folderPrefix: "koed-pre-selective-pii-migrations-" }
  );
  temporaryFolders.add(preSelectivePiiFolder);
  const localRuntimeCutoverIndex = journal.entries.findIndex(
    (entry) => entry.tag === expectedLocalRuntimeCutoverTag
  );
  if (localRuntimeCutoverIndex < 1) {
    throw new Error(
      `Expected ${expectedLocalRuntimeCutoverTag} after an upgradeable baseline`
    );
  }
  const preLocalRuntimeCutoverIndex = localRuntimeCutoverIndex - 1;
  const preLocalRuntimeCutoverFolder = await createMigrationSlice(
    journal,
    preLocalRuntimeCutoverIndex,
    { folderPrefix: "koed-pre-local-runtime-cutover-" }
  );
  temporaryFolders.add(preLocalRuntimeCutoverFolder);
  const fullRecords = await migrationRecords(migrationsFolder, journal.entries);
  const preAgentsFolder = await createMigrationSlice(journal, 51, {
    folderPrefix: "koed-pre-agents-"
  });
  temporaryFolders.add(preAgentsFolder);
  const preAgentsRecords = await migrationRecords(
    preAgentsFolder,
    journal.entries.slice(0, 52)
  );
  const preActivityFolder = await createMigrationSlice(journal, 50, {
    folderPrefix: "koed-pre-project-activity-"
  });
  temporaryFolders.add(preActivityFolder);
  const preActivityRecords = await migrationRecords(
    preActivityFolder,
    journal.entries.slice(0, 51)
  );
  const preProjectApiFolder = await createMigrationSlice(journal, 49, {
    folderPrefix: "koed-pre-project-api-"
  });
  temporaryFolders.add(preProjectApiFolder);
  const preProjectApiRecords = await migrationRecords(
    preProjectApiFolder,
    journal.entries.slice(0, 50)
  );
  const preWorkItemsFolder = await createMigrationSlice(journal, 48, {
    folderPrefix: "koed-pre-work-items-"
  });
  temporaryFolders.add(preWorkItemsFolder);
  const preWorkItemsRecords = await migrationRecords(
    preWorkItemsFolder,
    journal.entries.slice(0, 49)
  );
  const preFreezeFolder = await createMigrationSlice(journal, 47, {
    folderPrefix: "koed-pre-freeze-"
  });
  temporaryFolders.add(preFreezeFolder);
  const preFreezeRecords = await migrationRecords(
    preFreezeFolder,
    journal.entries.slice(0, 48)
  );
  const preProjectsFolder = await createMigrationSlice(journal, 46, {
    folderPrefix: "koed-pre-personal-projects-"
  });
  temporaryFolders.add(preProjectsFolder);
  const preProjectsRecords = await migrationRecords(
    preProjectsFolder,
    journal.entries.slice(0, 47)
  );
  const pre0020Records = await migrationRecords(
    pre0020Folder,
    journal.entries.slice(0, pre0020LastIndex + 1)
  );
  const through0020Records = await migrationRecords(
    through0020Folder,
    journal.entries.slice(0, current0020Index + 1)
  );
  const preSelectivePiiRecords = await migrationRecords(
    preSelectivePiiFolder,
    journal.entries.slice(0, preSelectivePiiIndex + 1)
  );
  const preLocalRuntimeCutoverRecords = await migrationRecords(
    preLocalRuntimeCutoverFolder,
    journal.entries.slice(0, preLocalRuntimeCutoverIndex + 1)
  );
  const preMultiComponentSourceFolder = await createMigrationSlice(
    journal,
    preMultiComponentSourceIndex,
    { folderPrefix: "koed-pre-multi-component-source-" }
  );
  temporaryFolders.add(preMultiComponentSourceFolder);
  const preMultiComponentSourceRecords = await migrationRecords(
    preMultiComponentSourceFolder,
    journal.entries.slice(0, preMultiComponentSourceIndex + 1)
  );
  const genericSharedMemoryIndex = journal.entries.findIndex(
    (entry) => entry.tag === expectedGenericSharedMemoryTag
  );
  if (genericSharedMemoryIndex < 1) {
    throw new Error(
      `Expected generic Shared Memory migration ${expectedGenericSharedMemoryTag}`
    );
  }
  const preGenericSharedMemoryIndex = genericSharedMemoryIndex - 1;
  const preGenericSharedMemoryFolder = await createMigrationSlice(
    journal,
    preGenericSharedMemoryIndex,
    { folderPrefix: "koed-pre-generic-shared-memory-" }
  );
  temporaryFolders.add(preGenericSharedMemoryFolder);
  const preGenericSharedMemoryRecords = await migrationRecords(
    preGenericSharedMemoryFolder,
    journal.entries.slice(0, preGenericSharedMemoryIndex + 1)
  );
  const privacyManifestIndex = journal.entries.findIndex(
    (entry) => entry.tag === expectedPrivacyManifestTag
  );
  if (privacyManifestIndex < 1) {
    throw new Error(
      `Expected privacy manifest migration ${expectedPrivacyManifestTag}`
    );
  }
  const prePrivacyManifestFolder = await createMigrationSlice(
    journal,
    privacyManifestIndex - 1,
    { folderPrefix: "koed-pre-privacy-manifest-" }
  );
  temporaryFolders.add(prePrivacyManifestFolder);
  const prePrivacyManifestRecords = await migrationRecords(
    prePrivacyManifestFolder,
    journal.entries.slice(0, privacyManifestIndex)
  );

  const preCodingFolder = await createMigrationSlice(journal, 36);
  temporaryFolders.add(preCodingFolder);
  const preCodingRecords = await migrationRecords(
    preCodingFolder,
    journal.entries.slice(0, 37)
  );

  await runScenario(
    "managed-launch-requires-explicit-alpha-reset",
    async () => {
      const target = await createDisposableDatabase("managed_reset");
      await withPool(target.url, async (pool) => {
        await runDbMigrations(pool, { migrationsFolder: preCodingFolder });
        const owner = randomUUID();
        const execution = randomUUID();
        await pool.query("insert into users (id,email) values ($1,$2)", [
          owner,
          `${owner}@example.test`
        ]);
        await pool.query(
          `insert into managed_conversation_executions
        (id,owner_user_id,project_id,provider,ai_client_instance_id,fencing_token_hash,runner_deployment_id,runner_device_id)
        values ($1,$2,'migration-fixture','codex','codex.default',$3,$4,$5)`,
          [execution, owner, "a".repeat(64), randomUUID(), randomUUID()]
        );
        const before = await schemaFingerprint(pool);
        const failure = await runDbMigrations(pool).then(
          () => null,
          (error) => error
        );
        if (
          !errorMessages(failure).includes(
            "Migration 0037 requires an explicit alpha managed Conversation reset"
          )
        ) {
          throw new Error(
            `Expected managed execution reset diagnostic: ${errorMessages(failure)}`
          );
        }
        await assertMigrationLedger(pool, preCodingRecords);
        if ((await schemaFingerprint(pool)) !== before)
          throw new Error("Rejected upgrade changed schema");
        const retained = await pool.query(
          "select id from managed_conversation_executions where id=$1",
          [execution]
        );
        if (retained.rowCount !== 1)
          throw new Error("Rejected upgrade changed execution history");
        // A remote runner can retain a binding without a local execution record.
        await pool.query(
          "delete from managed_conversation_executions where id=$1",
          [execution]
        );
        await pool.query(
          `insert into managed_conversation_runtime_bindings
        (execution_id,owner_user_id,deployment_id,device_id,execution_generation,project_path)
        values ($1,$2,$3,$4,1,'/migration-fixture')`,
          [execution, owner, randomUUID(), randomUUID()]
        );
        const bindingFailure = await runDbMigrations(pool).then(
          () => null,
          (error) => error
        );
        if (
          !errorMessages(bindingFailure).includes(
            "Migration 0037 requires an explicit alpha managed Conversation reset"
          )
        ) {
          throw new Error("Expected retained runner binding reset diagnostic");
        }
        await assertMigrationLedger(pool, preCodingRecords);
      });
    }
  );

  await runScenario("presentation-upgrade-preserves-visibility", async () => {
    const target = await createDisposableDatabase("presentation");
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool, { migrationsFolder: preCodingFolder });
      const cases = [
        [
          "visible-message",
          "user_message",
          true,
          true,
          true,
          true,
          "expanded",
          "message"
        ],
        [
          "disabled",
          "user_message",
          false,
          true,
          true,
          true,
          "hidden",
          "generic"
        ],
        [
          "hidden-message",
          "user_message",
          true,
          false,
          false,
          false,
          "hidden",
          "generic"
        ],
        [
          "no-message",
          "user_message",
          true,
          true,
          false,
          true,
          "hidden",
          "generic"
        ],
        [
          "visible-tool",
          "tool_call",
          true,
          true,
          true,
          true,
          "collapsed",
          "tool_call"
        ],
        ["no-tool", "tool_call", true, true, true, false, "hidden", "generic"]
      ];
      for (const [adapter, type, enabled, ui, message, tool] of cases) {
        await pool.query(
          `insert into projection_policy_rules
          (source_kind,source_adapter_version,transcript_type,enabled,project_to_ui,create_message,create_tool_event)
          values ('migration-fixture',$1,$2,$3,$4,$5,$6)`,
          [adapter, type, enabled, ui, message, tool]
        );
      }
      await runDbMigrations(pool);
      for (const [adapter, , enabled, , , , mode, renderer] of cases) {
        const result = await pool.query(
          `select enabled,presentation_mode,renderer_kind
          from conversation_presentation_policy_rules where source_kind='migration-fixture' and source_adapter_version=$1`,
          [adapter]
        );
        if (
          !isDeepStrictEqual(result.rows, [
            { enabled, presentation_mode: mode, renderer_kind: renderer }
          ])
        ) {
          throw new Error(
            `Presentation visibility changed for ${adapter}: ${JSON.stringify(result.rows)}`
          );
        }
      }
      await assertMigrationLedger(pool, fullRecords);
    });
  });

  await runScenario(
    "repair-recorded-conversation-start-authority",
    async () => {
      const earlierFolder = await createMigrationSlice(journal, 39);
      temporaryFolders.add(earlierFolder);
      const target = await createDisposableDatabase("start_authority_repair");
      await withPool(target.url, async (pool) => {
        await runDbMigrations(pool, { migrationsFolder: earlierFolder });
        // Reproduce an already-recorded development migration lacking the column.
        await pool.query(
          "alter table managed_conversation_runtime_bindings drop column start_authority_acknowledged_at"
        );
        const owner = randomUUID();
        const execution = randomUUID();
        await pool.query("insert into users (id,email) values ($1,$2)", [
          owner,
          `${owner}@example.test`
        ]);
        await pool.query(
          `insert into managed_conversation_runtime_bindings
          (execution_id,owner_user_id,deployment_id,device_id,execution_generation,project_path,source_project_path)
          values ($1,$2,$3,$4,1,'/retained-project','/retained-project')`,
          [execution, owner, randomUUID(), randomUUID()]
        );
        await runDbMigrations(pool);
        const retained = await pool.query(
          `select project_path, start_authority_acknowledged_at
          from managed_conversation_runtime_bindings where execution_id=$1`,
          [execution]
        );
        if (
          retained.rows[0]?.project_path !== "/retained-project" ||
          retained.rows[0]?.start_authority_acknowledged_at !== null
        )
          throw new Error(
            "Repair changed retained runtime binding or granted start authority"
          );
        await pool.query(
          `update managed_conversation_runtime_bindings set start_authority_acknowledged_at=now() where execution_id=$1`,
          [execution]
        );
        await runDbMigrations(pool);
        await assertMigrationLedger(pool, fullRecords);
        await assertCurrentSchema(pool);
      });
    }
  );

  await runScenario("clean-full-migration", async () => {
    const target = await createDisposableDatabase("clean_full");
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool);
      await assertMigrationLedger(pool, fullRecords);
      await assertCurrentSchema(pool);
    });
  });

  await runScenario("remote-mcp-task-authority-upgrade", async () => {
    const earlierFolder = await createMigrationSlice(journal, 42);
    temporaryFolders.add(earlierFolder);
    const target = await createDisposableDatabase(
      "remote_mcp_authority_upgrade"
    );
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool, { migrationsFolder: earlierFolder });
      const owner = randomUUID();
      const task = randomUUID();
      const question = randomUUID();
      await pool.query("insert into users (id,email) values ($1,$2)", [
        owner,
        `${owner}@example.test`
      ]);
      await pool.query(
        `insert into memory_questions (id,owner_user_id,idempotency_key,search_domain,query,answer_markdown,status,answered_at)
        values ($1,$2,$3,'global','retained question','retained answer','answered',now())`,
        [question, owner, randomUUID()]
      );
      await pool.query(
        `insert into memory_answer_tasks (id,owner_user_id,origin,invocation_key,request_snapshot,expires_at)
        values ($1,$2,'mcp',$3,$4::jsonb,now()+interval '1 day')`,
        [task, owner, randomUUID(), JSON.stringify({ contentEncrypted: true })]
      );
      const retainedRows = () =>
        pool.query(
          `select
        (select to_jsonb(task_row)-'team_workspace_id'-'team_authorization' from memory_answer_tasks task_row where id=$1) as task,
        (select to_jsonb(question_row)-'team_authorization' from memory_questions question_row where id=$2) as question`,
          [task, question]
        );
      const before = await retainedRows();
      await runDbMigrations(pool);
      await assertMigrationLedger(pool, fullRecords);
      if (!isDeepStrictEqual((await retainedRows()).rows, before.rows)) {
        throw new Error(
          "OAuth/Team authority migrations changed retained Personal task or question data"
        );
      }
      const authority = await pool.query(
        `select task_row.team_workspace_id, task_row.team_authorization,
        question_row.team_authorization as question_team_authorization from memory_answer_tasks task_row
        cross join memory_questions question_row where task_row.id=$1 and question_row.id=$2`,
        [task, question]
      );
      if (
        !isDeepStrictEqual(authority.rows, [
          {
            team_workspace_id: null,
            team_authorization: null,
            question_team_authorization: null
          }
        ])
      ) {
        throw new Error(
          "Migration granted Team authority to retained Personal rows"
        );
      }
      await expectSqlState(
        pool,
        `update memory_answer_tasks set team_authorization='{}'::jsonb where id='${task}'`,
        "23514",
        "Task authority without Team Workspace"
      );
      await expectSqlState(
        pool,
        `update memory_answer_tasks set team_workspace_id='${randomUUID()}' where id='${task}'`,
        "23514",
        "Team Workspace without task authority"
      );
      const team = randomUUID();
      const workspace = randomUUID();
      await pool.query(
        "insert into teams (id,name) values ($1,'Migration fixture Team')",
        [team]
      );
      await pool.query(
        "insert into team_workspaces (id,team_id,name) values ($1,$2,'Migration fixture Workspace')",
        [workspace, team]
      );
      await pool.query(
        `insert into memory_answer_tasks (id,owner_user_id,origin,request_snapshot,expires_at,team_workspace_id,team_authorization)
        values ($1,$2,'mcp','{}'::jsonb,now()+interval '1 day',$3,'{"version":1}'::jsonb)`,
        [randomUUID(), owner, workspace]
      );
      const client = randomUUID();
      const grant = randomUUID();
      await pool.query(
        `insert into remote_mcp_oauth_clients (id,metadata) values ($1,'{}'::jsonb)`,
        [client]
      );
      await pool.query(
        `insert into remote_mcp_oauth_grants (id,user_id,client_id,resource,scopes,expires_at)
        values ($1,$2,$3,'https://fixture.example/mcp',array['koed:memory:read'],now()+interval '1 day')`,
        [grant, owner, client]
      );
      for (const kind of ["code", "access", "refresh"]) {
        await pool.query(
          `insert into remote_mcp_oauth_credentials (secret_hash,grant_id,kind,data,expires_at)
          values ($1,$2,$3,'{}'::jsonb,now()+interval '1 day')`,
          [`fixture-${kind}`, grant, kind]
        );
      }
      await expectSqlState(
        pool,
        `insert into remote_mcp_oauth_credentials (secret_hash,grant_id,kind,data,expires_at)
        values ('fixture-invalid-kind','${grant}','unsupported','{}'::jsonb,now()+interval '1 day')`,
        "23514",
        "Invalid OAuth credential kind"
      );
      await runDbMigrations(pool);
      await assertMigrationLedger(pool, fullRecords);
      if (!isDeepStrictEqual((await retainedRows()).rows, before.rows)) {
        throw new Error(
          "Idempotent head migration rerun changed retained Personal rows"
        );
      }
    });
  });

  await runScenario("privacy-manifest-requires-alpha-reset", async () => {
    const target = await createDisposableDatabase("privacy_manifest_reset");
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool, {
        migrationsFolder: prePrivacyManifestFolder
      });
      await assertMigrationLedger(pool, prePrivacyManifestRecords);
      const values = Array.from({ length: 8 }, () => randomUUID());
      await pool.query("set session_replication_role = replica");
      try {
        await pool.query(
          `insert into shared_source_semantic_previews (
             source_preview_id, source_artifact_id, source_preview_revision,
             source_preview_hash, source_artifact_hash, source_manifest_hash,
             source_revision, source_hash, logical_memory_id, owner_user_id,
             owner_principal_id, team_id, team_workspace_id, representation,
             classifier_generation_id, classifier_version, classifier_hash,
             effective_privacy_policy_hash
           ) values (
             $1, $2, 1, $9, $9, $9, 0, $9, $3, $4, $5, $6, $7,
             'memory_events', $8, 1, $9, $9
           )`,
          [...values, "a".repeat(64)]
        );
      } finally {
        await pool.query("set session_replication_role = origin");
      }
      const migrationError = await runDbMigrations(pool).then(
        () => null,
        (error) => error
      );
      if (!migrationError) {
        throw new Error(
          "Populated pre-0036 privacy database unexpectedly upgraded"
        );
      }
      const messages = errorMessages(migrationError);
      if (
        !messages.includes(
          "Koed pre-release privacy manifest schema requires a disposable database reset before migration 0036"
        )
      ) {
        throw new Error(`Missing reset-required diagnostic: ${messages}`);
      }
      await assertMigrationLedger(pool, prePrivacyManifestRecords);
    });
  });

  await runScenario("generic-shared-memory-requires-alpha-reset", async () => {
    const target = await createDisposableDatabase("generic_memory_reset");
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool, {
        migrationsFolder: preGenericSharedMemoryFolder
      });
      await assertMigrationLedger(pool, preGenericSharedMemoryRecords);
      const ownerUserId = randomUUID();
      const deploymentIdentityId = randomUUID();
      await pool.query("insert into users (id, email) values ($1, $2)", [
        ownerUserId,
        `generic-memory-reset-${ownerUserId}@example.test`
      ]);
      await pool.query(
        `insert into deployment_identities
           (id,protocol_deployment_id,locality,profile)
         values ($1,$2,'local','local_personal')`,
        [deploymentIdentityId, randomUUID()]
      );
      await pool.query(
        `insert into logical_memories
           (owner_user_id,source_boundary,logical_key,
            origin_deployment_identity_id,origin_source_id,owner_principal_id)
         values ($1,'captured_session',$2,$3,$4,$1)`,
        [
          ownerUserId,
          `generic-memory-reset:${randomUUID()}`,
          deploymentIdentityId,
          `session:${randomUUID()}`
        ]
      );
      const migrationError = await runDbMigrations(pool).then(
        () => null,
        (error) => error
      );
      if (!migrationError) {
        throw new Error("Populated pre-0035 database unexpectedly upgraded");
      }
      const messages = errorMessages(migrationError);
      if (
        !messages.includes(
          "Koed alpha data reset required before enabling generic Shared Memory sources"
        )
      ) {
        throw new Error(`Missing reset-required diagnostic: ${messages}`);
      }
      await assertMigrationLedger(pool, preGenericSharedMemoryRecords);
    });
  });

  await runScenario("selective-pii-requires-explicit-team-reset", async () => {
    const target = await createDisposableDatabase("selective_pii_reset");
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool, {
        migrationsFolder: preSelectivePiiFolder
      });
      await assertMigrationLedger(pool, preSelectivePiiRecords);
      const personalUser = await pool.query(
        `insert into users (email, display_name)
         values ($1, 'Personal migration fixture') returning id`,
        [`personal-migration-${randomUUID()}@example.test`]
      );
      const team = await pool.query(
        `insert into teams (name) values ($1) returning id`,
        [`Pre-PII Team ${randomUUID()}`]
      );
      await pool.query(
        `insert into team_representation_policies (
           team_id, version, allowed_representations, policy_hash, effective_at
         ) values ($1, 1, array['memory_events']::shared_memory_representation[], $2, now())`,
        [team.rows[0].id, sha256("pre-pii-team-policy")]
      );

      let failure;
      try {
        await runDbMigrations(pool);
      } catch (error) {
        failure = error;
      }
      const messages = [];
      for (let current = failure; current; current = current.cause) {
        messages.push(
          current instanceof Error ? current.message : String(current)
        );
      }
      if (
        !messages.some((message) =>
          message.includes(
            "Migration 0034 requires a disposable-alpha Team sharing reset"
          )
        )
      ) {
        throw new Error(
          `0034 did not report its Team reset boundary: ${messages.join(" | ")}`
        );
      }
      await assertMigrationLedger(pool, preSelectivePiiRecords);
      const retained = await pool.query(
        "select count(*)::integer as count from users where id=$1",
        [personalUser.rows[0].id]
      );
      if (retained.rows[0]?.count !== 1) {
        throw new Error(
          "Rejected 0034 migration changed Personal canonical data"
        );
      }
    });
  });
  await runScenario(
    "multi-component-source-alpha-reset-diagnostic",
    async () => {
      const target = await createDisposableDatabase("source_reset");
      await withPool(target.url, async (pool) => {
        await runDbMigrations(pool, {
          migrationsFolder: preMultiComponentSourceFolder
        });
        await assertMigrationLedger(pool, preMultiComponentSourceRecords);
        const ownerUserId = randomUUID();
        const sessionId = randomUUID();
        await pool.query("insert into users (id, email) values ($1, $2)", [
          ownerUserId,
          `source-reset-${ownerUserId}@example.test`
        ]);
        await pool.query(
          `insert into sessions
           (id, owner_user_id, source_runtime, capture_method)
         values ($1, $2, 'codex', 'transcript')`,
          [sessionId, ownerUserId]
        );
        await pool.query(
          `insert into conversation_source_artifacts
           (owner_user_id, session_id, logical_source_id,
            source_generation_id, replica_role, source_kind, source_runtime,
            external_session_id, source_fingerprint, artifact_format,
            artifact_format_version, source_adapter_version, lifecycle,
            source_created_at, storage_provider, storage_prefix, closure_hash,
            closure_manifest, closure_signature, origin_deployment_id,
            origin_device_id, origin_key_id, origin_public_key,
            redacted_source_label, finalized_at)
         values
           ($1, $2, $3, $4, 'origin_local', 'codex', 'codex', $5,
            $6, 'jsonl', 1, 'codex-transcript-v1', 'finalized', now(),
            'filesystem', $7, $8, $9::jsonb, $10, 'migration-test',
            'migration-device', 'migration-key', $11,
            'Finalized alpha source', now())`,
          [
            ownerUserId,
            sessionId,
            randomUUID(),
            randomUUID(),
            `source-reset-${randomUUID()}`,
            "a".repeat(64),
            `source-reset/${sessionId}`,
            "b".repeat(64),
            JSON.stringify({ version: 1 }),
            "c".repeat(86),
            "d".repeat(43)
          ]
        );
        const migrationError = await runDbMigrations(pool).then(
          () => null,
          (error) => error
        );
        if (!migrationError) {
          throw new Error("Finalized alpha source unexpectedly upgraded");
        }
        const messages = errorMessages(migrationError);
        if (
          !messages.includes(
            "Koed alpha data reset required before enabling multi-component Conversation Sources"
          )
        ) {
          throw new Error(`Missing reset-required diagnostic: ${messages}`);
        }
        await assertMigrationLedger(pool, preMultiComponentSourceRecords);
      });
    }
  );

  await runScenario("local-runtime-alpha-question-cutover", async () => {
    const target = await createDisposableDatabase("local_runtime_cutover");
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 23).toString("base64")
    );
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool, {
        migrationsFolder: preLocalRuntimeCutoverFolder
      });
      await assertMigrationLedger(pool, preLocalRuntimeCutoverRecords);
      const fixture = await seedLocalRuntimeCutoverFixture(pool, provider);
      await runDbMigrations(pool);
      await assertMigrationLedger(pool, fullRecords);
      await verifyLocalRuntimeCutover(pool, fixture);
      await assertCurrentSchema(pool);
    });
  });

  await runScenario("hq715-freeze-0047-upgrade", async () => {
    const target = await createDisposableDatabase("freeze_upgrade");
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool, { migrationsFolder: preFreezeFolder });
      await assertMigrationLedger(pool, preFreezeRecords);
      const before = await pool.query(
        "select to_regclass('public.team_memory_grant_freeze_sources') as closure"
      );
      if (before.rows[0]?.closure !== null) {
        throw new Error("Frozen closure unexpectedly exists before 0048");
      }
      await runDbMigrations(pool);
      await assertMigrationLedger(pool, fullRecords);
      const capability = await pool.query(
        `select state,to_regclass('public.workspace_projects') as project_relation
           from project_lifecycle_schema_capabilities
          where capability='workspace_projects'`
      );
      if (
        capability.rows[0]?.state !== "absent" ||
        capability.rows[0]?.project_relation !== null
      ) {
        throw new Error(
          "Workspace Project capability is not explicitly absent"
        );
      }
      const closure = await pool.query(
        `select to_regclass('public.team_memory_grant_freeze_sources') as header,
                to_regclass('public.team_memory_grant_freeze_source_payloads') as payloads,
                to_regclass('public.team_memory_curated_item_eligibility') as curated_eligibility,
                to_regclass('public.shared_memory_publication_fences') as memory_fence,
                to_regclass('public.conversation_source_publication_fences') as source_fence`
      );
      if (
        Object.values(closure.rows[0] ?? {}).some((value) => value === null)
      ) {
        throw new Error(
          "Frozen closure or publication fence missing after 0048"
        );
      }
      const grantId = randomUUID();
      const assertionId = randomUUID();
      const pseudonym = await pool.query(
        `select koed_grant_scoped_curated_source_id($1::uuid,$2::uuid) as id`,
        [grantId, assertionId]
      );
      if (
        pseudonym.rows[0]?.id !==
        sharedMemoryGrantScopedSourceId(grantId, assertionId)
      ) {
        throw new Error(
          "Curated marker pseudonym differs from Team item identity"
        );
      }
      await assertCurrentSchema(pool);
    });
  });

  await runScenario("populated-current-main-through-alpha-reset", async () => {
    const target = await createDisposableDatabase("populated");
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 19).toString("base64")
    );
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool, {
        migrationsFolder: pre0020Folder
      });
      await assertMigrationLedger(pool, pre0020Records);
      const fixture = await seedAlphaResetFixture(pool, provider);
      const stableFixture = await seedStablePre0020Fixture(
        pool,
        fixture.ownerUserId
      );
      const beforeFingerprint = await stableFixtureFingerprint(
        pool,
        stableFixture
      );
      await runDbMigrations(pool, { migrationsFolder: through0020Folder });
      await assertMigrationLedger(pool, through0020Records);
      const afterFingerprint = await stableFixtureFingerprint(
        pool,
        stableFixture
      );
      if (beforeFingerprint !== afterFingerprint) {
        throw new Error("Stable current-main rows changed while applying 0020");
      }
      await assertUpgradedStableDefaults(pool, stableFixture);
      await verifyAlphaResetUpgrade(pool, fixture);
      await assertCurrentSchema(pool);
    });
  });

  await runScenario("interrupted-transaction-recovery", async () => {
    const target = await createDisposableDatabase("interrupted");
    let stableFixture;
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool, { migrationsFolder: pre0020Folder });
      stableFixture = await seedStablePre0020Fixture(pool);
    });
    const beforeFingerprint = await withPool(target.url, (pool) =>
      stableFixtureFingerprint(pool, stableFixture)
    );
    const marker = `koed_interrupt_${randomUUID()}`;
    const interruptedFolder = await createMigrationSlice(
      journal,
      current0020Index,
      {
        folderPrefix: "koed-interrupted-0020-migrations-",
        transformLastSql: (sql) =>
          sql.replace(
            "--> statement-breakpoint",
            `--> statement-breakpoint\nselect pg_sleep(30) /* ${marker} */;--> statement-breakpoint`
          )
      }
    );
    temporaryFolders.add(interruptedFolder);
    const applicationName = `koed-migration-interrupt-${process.pid}`;
    const interruptedPool = new Pool({
      connectionString: target.url,
      application_name: applicationName,
      max: 1
    });
    interruptedPool.on("error", () => {});
    const interruptedRun = runDbMigrations(interruptedPool, {
      migrationsFolder: interruptedFolder
    }).then(
      () => null,
      (error) => error
    );
    const backendPid = await waitForInterruptProbe(
      admin,
      target.database,
      applicationName,
      marker
    );
    const cancelled = await admin.query(
      "select pg_cancel_backend($1) as cancelled",
      [backendPid]
    );
    if (cancelled.rows[0]?.cancelled !== true) {
      throw new Error("Postgres refused to cancel the migration statement");
    }
    const interruptionError = await interruptedRun;
    await interruptedPool.end();
    if (!interruptionError) {
      throw new Error("Interrupted migration unexpectedly committed");
    }
    await withPool(target.url, async (pool) => {
      await assertMigrationLedger(pool, pre0020Records);
      const rollbackState = await pool.query(
        `select
           to_regtype('public.collaboration_event_family')::text as first_type,
           to_regclass('public.collaboration_threads')::text as collaboration_table`
      );
      if (
        rollbackState.rows[0]?.first_type !== null ||
        rollbackState.rows[0]?.collaboration_table !== null
      ) {
        throw new Error(
          `Interrupted migration left partial schema: ${JSON.stringify(rollbackState.rows[0])}`
        );
      }
      if (
        (await stableFixtureFingerprint(pool, stableFixture)) !==
        beforeFingerprint
      ) {
        throw new Error("Interrupted migration changed retained data");
      }
      await runDbMigrations(pool, { migrationsFolder: through0020Folder });
      await assertMigrationLedger(pool, through0020Records);
      await assertCurrentSchema(pool);
    });
  });

  await runScenario("backup-before-upgrade-restore", async () => {
    const source = await createDisposableDatabase("backup_source");
    let stableFixture;
    await withPool(source.url, async (pool) => {
      await runDbMigrations(pool, { migrationsFolder: pre0020Folder });
      stableFixture = await seedStablePre0020Fixture(pool);
    });
    const beforeFingerprint = await withPool(source.url, (pool) =>
      stableFixtureFingerprint(pool, stableFixture)
    );
    const backupFolder = await mkdtemp(
      resolve(tmpdir(), "koed-migration-backup-")
    );
    temporaryFolders.add(backupFolder);
    const backupPath = resolve(backupFolder, "pre-0020.dump");
    await runPostgresTool(
      process.env.PG_DUMP_BIN ?? "pg_dump",
      [
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--file",
        backupPath
      ],
      source.url
    );
    await withPool(source.url, async (pool) => {
      await runDbMigrations(pool, { migrationsFolder: through0020Folder });
      await assertCurrentSchema(pool);
    });
    const restored = await createDisposableDatabase("backup_restore");
    await runPostgresTool(
      process.env.PG_RESTORE_BIN ?? "pg_restore",
      [
        "--exit-on-error",
        "--single-transaction",
        "--no-owner",
        "--no-privileges",
        "--dbname",
        restored.database,
        backupPath
      ],
      restored.url
    );
    await withPool(restored.url, async (pool) => {
      await assertMigrationLedger(pool, pre0020Records);
      if (
        (await stableFixtureFingerprint(pool, stableFixture)) !==
        beforeFingerprint
      ) {
        throw new Error(
          "Restored pre-upgrade backup did not retain fixture data"
        );
      }
      const boundary = await pool.query(
        "select to_regclass('public.collaboration_threads')::text as collaboration_table"
      );
      if (boundary.rows[0]?.collaboration_table !== null) {
        throw new Error(
          "Pre-0020 backup unexpectedly restored post-0020 schema"
        );
      }
      await runDbMigrations(pool, { migrationsFolder: through0020Folder });
      await assertMigrationLedger(pool, through0020Records);
      await assertCurrentSchema(pool);
    });
  });

  await runScenario("idempotent-rerun", async () => {
    const target = await createDisposableDatabase("idempotent");
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool, { migrationsFolder: pre0020Folder });
      const stableFixture = await seedStablePre0020Fixture(pool);
      await runDbMigrations(pool, { migrationsFolder: through0020Folder });
      const before = {
        schema: await schemaFingerprint(pool),
        data: await stableFixtureFingerprint(pool, stableFixture)
      };
      await runDbMigrations(pool, { migrationsFolder: through0020Folder });
      const after = {
        schema: await schemaFingerprint(pool),
        data: await stableFixtureFingerprint(pool, stableFixture)
      };
      await assertMigrationLedger(pool, through0020Records);
      if (!isDeepStrictEqual(after, before)) {
        throw new Error(
          `Idempotent rerun changed database state: ${JSON.stringify({ before, after })}`
        );
      }
    });
  });

  await runScenario("alpha-old-new-forward-boundaries", async () => {
    const target = await createDisposableDatabase("boundaries");
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool, { migrationsFolder: pre0020Folder });
      await expectSqlState(
        pool,
        "select id from collaboration_threads limit 1",
        "42P01",
        "Current collaboration query against pre-0020"
      );
      await runDbMigrations(pool, { migrationsFolder: through0020Folder });
      await expectSqlState(
        pool,
        "select id from team_chat_threads limit 1",
        "42P01",
        "Discarded experimental Team Chat query against current 0020"
      );
      const oldShapeFixture = await seedStablePre0020Fixture(pool);
      await stableFixtureFingerprint(pool, oldShapeFixture);
      await assertUpgradedStableDefaults(pool, oldShapeFixture);
      await assertMigrationLedger(pool, through0020Records);
    });
  });

  await runScenario("agents-0052-upgrade-rollback-idempotence", async () => {
    const target = await createDisposableDatabase("agents_upgrade");
    const ownerId = randomUUID();
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool, { migrationsFolder: preAgentsFolder });
      await assertMigrationLedger(pool, preAgentsRecords);
      await pool.query("insert into users(id,email) values ($1,$2)", [
        ownerId,
        `${ownerId}@example.test`
      ]);
      await pool.query(
        `insert into ai_client_instances(owner_user_id,instance_id,driver_id,display_name)
         values ($1,'codex.default','codex','Codex')`,
        [ownerId]
      );
    });
    const interrupted = await createMigrationSlice(journal, 52, {
      folderPrefix: "koed-agents-interrupted-",
      transformLastSql: (sql) => `${sql}--> statement-breakpoint\nselect 1/0;`
    });
    temporaryFolders.add(interrupted);
    await withPool(target.url, async (pool) => {
      let failed = false;
      try {
        await runDbMigrations(pool, { migrationsFolder: interrupted });
      } catch {
        failed = true;
      }
      if (!failed)
        throw new Error("Interrupted Agents migration unexpectedly succeeded");
      const rollback = await pool.query(
        `select to_regclass('public.agents')::text as agents,
          exists(select 1 from ai_client_instances where owner_user_id=$1 and instance_id='codex.default') as retained`,
        [ownerId]
      );
      if (
        rollback.rows[0]?.agents !== null ||
        rollback.rows[0]?.retained !== true
      )
        throw new Error(
          "Interrupted Agents migration changed retained instance data"
        );
      await assertMigrationLedger(pool, preAgentsRecords);
      await runDbMigrations(pool);
      await assertMigrationLedger(pool, fullRecords);
      const agentId = randomUUID();
      await pool.query(
        `insert into agents(id,owner_user_id,name,look,ai_client_instance_id,is_chief_of_staff)
         values ($1,$2,'Chief','{}'::jsonb,'codex.default',true)`,
        [agentId, ownerId]
      );
      await runDbMigrations(pool);
      await assertMigrationLedger(pool, fullRecords);
      const retained = await pool.query(
        "select name from agents where id=$1 and owner_user_id=$2",
        [agentId, ownerId]
      );
      if (retained.rows[0]?.name !== "Chief")
        throw new Error("Agents migration rerun lost the retained Chief");
    });
  });

  await runScenario("project-activity-0051-upgrade-and-rollback", async () => {
    const target = await createDisposableDatabase("project_activity_upgrade");
    const ownerId = randomUUID();
    const projectId = randomUUID();
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool, { migrationsFolder: preActivityFolder });
      await assertMigrationLedger(pool, preActivityRecords);
      await pool.query("insert into users(id,email) values ($1,$2)", [
        ownerId,
        `${ownerId}@example.test`
      ]);
      await pool.query(
        "insert into projects(id,owner_user_id,name,key) values ($1,$2,'Retained','RETAINED')",
        [projectId, ownerId]
      );
    });
    const interrupted = await createMigrationSlice(journal, 51, {
      folderPrefix: "koed-project-activity-interrupted-",
      transformLastSql: (sql) => `${sql}--> statement-breakpoint\nselect 1/0;`
    });
    temporaryFolders.add(interrupted);
    await withPool(target.url, async (pool) => {
      let failed = false;
      try {
        await runDbMigrations(pool, { migrationsFolder: interrupted });
      } catch {
        failed = true;
      }
      if (!failed)
        throw new Error(
          "Interrupted Project activity migration unexpectedly succeeded"
        );
      const rollback = await pool.query(
        `select to_regclass('public.project_activity')::text as activity,
        to_regclass('public.project_seen')::text as seen,
        exists(select 1 from projects where id=$1 and owner_user_id=$2) as retained`,
        [projectId, ownerId]
      );
      if (
        rollback.rows[0]?.activity !== null ||
        rollback.rows[0]?.seen !== null ||
        rollback.rows[0]?.retained !== true
      )
        throw new Error(
          "Interrupted Project activity migration changed retained state"
        );
      await assertMigrationLedger(pool, preActivityRecords);
      await runDbMigrations(pool);
      await assertMigrationLedger(pool, fullRecords);
      await pool.query(
        `insert into project_activity(owner_user_id,project_id,sequence,actor_user_id,kind,ref)
        values ($1,$2,1,$1,'work_item_created',$3)`,
        [ownerId, projectId, randomUUID()]
      );
      await pool.query(
        `insert into project_seen(owner_user_id,project_id,seen_sequence) values ($1,$2,1)`,
        [ownerId, projectId]
      );
      await runDbMigrations(pool);
      await assertMigrationLedger(pool, fullRecords);
      const retained = await pool.query(
        `select a.sequence,s.seen_sequence from project_activity a
        join project_seen s using(owner_user_id,project_id) where a.owner_user_id=$1 and a.project_id=$2`,
        [ownerId, projectId]
      );
      if (
        retained.rows[0]?.sequence !== "1" ||
        retained.rows[0]?.seen_sequence !== "1"
      )
        throw new Error("Project activity migration rerun lost retained rows");
    });
  });

  await runScenario("project-api-0050-upgrade-and-rollback", async () => {
    const target = await createDisposableDatabase("project_api_upgrade");
    const ownerId = randomUUID();
    const projectId = randomUUID();
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool, { migrationsFolder: preProjectApiFolder });
      await assertMigrationLedger(pool, preProjectApiRecords);
      await pool.query("insert into users(id,email) values ($1,$2)", [
        ownerId,
        `${ownerId}@example.test`
      ]);
      await pool.query(
        `insert into projects(id,owner_user_id,name,key,lifecycle,deleted_at)
        values ($1,$2,'Legacy deleted','LEGACY','deleted',now())`,
        [projectId, ownerId]
      );
    });
    const interrupted = await createMigrationSlice(journal, 50, {
      folderPrefix: "koed-project-api-interrupted-",
      transformLastSql: (sql) => `${sql}--> statement-breakpoint\nselect 1/0;`
    });
    temporaryFolders.add(interrupted);
    await withPool(target.url, async (pool) => {
      let failed = false;
      try {
        await runDbMigrations(pool, { migrationsFolder: interrupted });
      } catch {
        failed = true;
      }
      if (!failed)
        throw new Error(
          "Interrupted Project API migration unexpectedly succeeded"
        );
      const rollback = await pool.query(
        `select
        to_regclass('public.project_delete_operations')::text as operations,
        exists(select 1 from information_schema.columns where table_name='projects'
          and column_name='deletion_phase') as phase,
        exists(select 1 from projects where id=$1 and lifecycle='deleted') as retained`,
        [projectId]
      );
      if (
        rollback.rows[0]?.operations !== null ||
        rollback.rows[0]?.phase !== false ||
        rollback.rows[0]?.retained !== true
      )
        throw new Error(
          "Interrupted Project API migration changed retained state"
        );
      await assertMigrationLedger(pool, preProjectApiRecords);
      await runDbMigrations(pool);
      await assertMigrationLedger(pool, fullRecords);
      const upgraded = await pool.query(
        `select lifecycle,deletion_phase,delete_batch_id
        from projects where id=$1`,
        [projectId]
      );
      if (
        upgraded.rows[0]?.lifecycle !== "deleted" ||
        upgraded.rows[0]?.deletion_phase !== "complete" ||
        upgraded.rows[0]?.delete_batch_id !== null
      )
        throw new Error(
          "Legacy deleted Project was assigned a restorable batch"
        );
    });
  });

  await runScenario("personal-projects-upgrade-and-rollback", async () => {
    const target = await createDisposableDatabase("personal_projects");
    const ownerId = randomUUID();
    const sessionId = randomUUID();
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool, { migrationsFolder: preProjectsFolder });
      await assertMigrationLedger(pool, preProjectsRecords);
      await pool.query("insert into users (id,email) values ($1,$2)", [
        ownerId,
        `${ownerId}@example.test`
      ]);
      await pool.query(
        `insert into sessions
           (id,owner_user_id,source_runtime,capture_method,external_session_id,
            automatic_project_id,automatic_project_name,automatic_project_detected_at)
         values ($1,$2,'codex-cli','api','hq201-old-session','lp_previous','Previous',now())`,
        [sessionId, ownerId]
      );
    });
    const interrupted = await createMigrationSlice(journal, 47, {
      folderPrefix: "koed-personal-projects-interrupted-",
      transformLastSql: (sql) => `${sql}--> statement-breakpoint\nselect 1/0;`
    });
    temporaryFolders.add(interrupted);
    await withPool(target.url, async (pool) => {
      let failed = false;
      try {
        await runDbMigrations(pool, { migrationsFolder: interrupted });
      } catch {
        failed = true;
      }
      if (!failed)
        throw new Error(
          "Personal Project migration rollback probe unexpectedly succeeded"
        );
      const rollback = await pool.query(
        `select to_regclass('public.projects')::text as projects,
                to_regclass('public.project_local_contexts')::text as contexts,
                exists (select 1 from information_schema.columns
                         where table_name='sessions' and column_name='automatic_personal_project_id') as added_column`
      );
      if (
        rollback.rows[0]?.projects !== null ||
        rollback.rows[0]?.contexts !== null ||
        rollback.rows[0]?.added_column !== false
      ) {
        throw new Error(
          "Interrupted Personal Project migration left partial schema"
        );
      }
      await assertMigrationLedger(pool, preProjectsRecords);
      await runDbMigrations(pool);
      await assertMigrationLedger(pool, fullRecords);
      const retained = await pool.query(
        `select automatic_project_id, automatic_personal_project_id from sessions where id=$1`,
        [sessionId]
      );
      if (
        retained.rows[0]?.automatic_project_id !== "lp_previous" ||
        retained.rows[0]?.automatic_personal_project_id !== null
      ) {
        throw new Error(
          "Personal Project upgrade changed retained Session assignment"
        );
      }
      const projectId = randomUUID();
      await pool.query(
        `insert into projects (id,owner_user_id,name,key) values ($1,$2,'Same name','SAME')`,
        [projectId, ownerId]
      );
      await pool.query("begin");
      await pool.query(
        `update sessions set automatic_personal_project_id=$2 where id=$1`,
        [sessionId, projectId]
      );
      await pool.query("rollback");
      const reverted = await pool.query(
        `select automatic_personal_project_id from sessions where id=$1`,
        [sessionId]
      );
      if (reverted.rows[0]?.automatic_personal_project_id !== null) {
        throw new Error("Personal Project assignment did not roll back");
      }
    });
  });

  await runScenario(
    "work-items-0049-upgrade-rollback-restore-idempotence",
    async () => {
      const target = await createDisposableDatabase("work_items_upgrade");
      const ownerId = randomUUID();
      const projectId = randomUUID();
      await withPool(target.url, async (pool) => {
        await runDbMigrations(pool, { migrationsFolder: preWorkItemsFolder });
        await assertMigrationLedger(pool, preWorkItemsRecords);
        await pool.query("insert into users(id,email) values ($1,$2)", [
          ownerId,
          `${ownerId}@example.test`
        ]);
        await pool.query(
          "insert into projects(id,owner_user_id,name,key) values ($1,$2,'Work','WORK')",
          [projectId, ownerId]
        );
      });
      const interrupted = await createMigrationSlice(journal, 49, {
        folderPrefix: "koed-work-items-interrupted-",
        transformLastSql: (sql) => `${sql}--> statement-breakpoint\nselect 1/0;`
      });
      temporaryFolders.add(interrupted);
      await withPool(target.url, async (pool) => {
        let failed = false;
        try {
          await runDbMigrations(pool, { migrationsFolder: interrupted });
        } catch {
          failed = true;
        }
        if (!failed)
          throw new Error(
            "Interrupted Work Item migration unexpectedly succeeded"
          );
        const rollback = await pool.query(
          `select to_regclass('public.project_work_items')::text as items,
        exists(select 1 from pg_enum join pg_type on pg_type.oid=pg_enum.enumtypid
          where pg_type.typname='collaboration_event_family' and enumlabel='work_item_changed') as family,
        exists(select 1 from projects where id=$1 and owner_user_id=$2) as project`,
          [projectId, ownerId]
        );
        if (
          rollback.rows[0]?.items !== null ||
          rollback.rows[0]?.family !== false ||
          rollback.rows[0]?.project !== true
        )
          throw new Error(
            `Interrupted Work Item migration changed retained state: ${JSON.stringify(rollback.rows[0])}`
          );
        await assertMigrationLedger(pool, preWorkItemsRecords);
      });
      const backupFolder = await mkdtemp(
        resolve(tmpdir(), "koed-work-items-backup-")
      );
      temporaryFolders.add(backupFolder);
      const backupPath = resolve(backupFolder, "pre-0049.dump");
      await runPostgresTool(
        process.env.PG_DUMP_BIN ?? "pg_dump",
        [
          "--format=custom",
          "--no-owner",
          "--no-privileges",
          "--file",
          backupPath
        ],
        target.url
      );
      await withPool(target.url, async (pool) => {
        await runDbMigrations(pool);
        await assertMigrationLedger(pool, fullRecords);
        const insert = `insert into project_work_items
        (owner_user_id,project_id,kind,title,goal,origin,creation_payload_hash,created_by,due_on,status,version)
        values ($1,$2,$3,'Call','Call Sam','manual','fixture',$1,$4,$5,$6) returning id,due_on::text as due_on`;
        const valid = await pool.query(insert, [
          ownerId,
          projectId,
          "todo",
          "2026-10-22",
          "todo",
          1
        ]);
        if (valid.rows[0]?.due_on !== "2026-10-22")
          throw new Error("Work Item DATE did not round-trip");
        await pool.query(
          `update project_work_items set idempotency_key='fixture-key',deleted_at=now()
           where id=$1`,
          [valid.rows[0].id]
        );
        const tombstone = await pool.query(
          `select deleted_at is not null as retained from project_work_items where id=$1`,
          [valid.rows[0].id]
        );
        if (tombstone.rows[0]?.retained !== true)
          throw new Error(
            "Deleted Work Item idempotency tombstone was not retained"
          );
        await expectSqlState(
          pool,
          `insert into project_work_items
           (owner_user_id,project_id,kind,title,goal,origin,creation_payload_hash,created_by,idempotency_key)
           values ($1,$2,'todo','Delayed','Delayed','manual','fixture',$1,'fixture-key')`,
          "23505",
          "Deleted Work Item idempotency identity",
          [ownerId, projectId]
        );
        await expectSqlState(pool, insert, "23514", "Invalid Work Item kind", [
          ownerId,
          projectId,
          "bad",
          "2026-10-22",
          "todo",
          1
        ]);
        await expectSqlState(
          pool,
          insert,
          "23514",
          "Invalid Work Item status",
          [ownerId, projectId, "todo", "2026-10-22", "bad", 1]
        );
        await expectSqlState(
          pool,
          insert,
          "23514",
          "Invalid Work Item version",
          [ownerId, projectId, "todo", "2026-10-22", "todo", 0]
        );
        await expectSqlState(pool, insert, "22008", "Invalid Work Item date", [
          ownerId,
          projectId,
          "todo",
          "2026-02-30",
          "todo",
          1
        ]);
        await expectSqlState(
          pool,
          insert,
          "23503",
          "Cross-owner Work Item Project",
          [randomUUID(), projectId, "todo", "2026-10-22", "todo", 1]
        );
        const before = {
          schema: await schemaFingerprint(pool),
          count: (
            await pool.query(
              `select count(*)::integer as count from project_work_items where project_id=$1`,
              [projectId]
            )
          ).rows[0]?.count
        };
        await runDbMigrations(pool);
        await assertMigrationLedger(pool, fullRecords);
        const after = {
          schema: await schemaFingerprint(pool),
          count: (
            await pool.query(
              `select count(*)::integer as count from project_work_items where project_id=$1`,
              [projectId]
            )
          ).rows[0]?.count
        };
        if (!isDeepStrictEqual(after, before))
          throw new Error("Work Item migration rerun changed schema or data");
      });
      const restored = await createDisposableDatabase("work_items_restore");
      await runPostgresTool(
        process.env.PG_RESTORE_BIN ?? "pg_restore",
        [
          "--exit-on-error",
          "--single-transaction",
          "--no-owner",
          "--no-privileges",
          "--dbname",
          restored.database,
          backupPath
        ],
        restored.url
      );
      await withPool(restored.url, async (pool) => {
        await assertMigrationLedger(pool, preWorkItemsRecords);
        const retained = await pool.query(
          `select exists(select 1 from projects where id=$1 and owner_user_id=$2) as project,
        to_regclass('public.project_work_items')::text as items`,
          [projectId, ownerId]
        );
        if (
          retained.rows[0]?.project !== true ||
          retained.rows[0]?.items !== null
        )
          throw new Error(
            "Restored pre-0049 backup lost Project or gained Work Items"
          );
        await runDbMigrations(pool);
        await assertMigrationLedger(pool, fullRecords);
      });
    }
  );

  const latestMigration = await getLatestMigrationTimestamp();
  console.log(
    JSON.stringify(
      {
        status: "passed",
        baseline: {
          lastTag: expectedPre0020Tag,
          fingerprint: expectedPre0020Fingerprint
        },
        current0020: expectedCurrent0020Tag,
        latestMigration: String(latestMigration),
        scenarios: results
      },
      null,
      2
    )
  );
} finally {
  for (const database of disposableDatabases) {
    await admin.query(
      `drop database if exists ${quoteIdentifier(database)} with (force)`
    );
  }
  await admin.end();
  for (const folder of temporaryFolders) {
    await rm(folder, { recursive: true, force: true });
  }
}
