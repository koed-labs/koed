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
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
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
const expectedLatestMigrationTag = "0030_blue_maddog";
const preMultiComponentSourceIndex = 29;
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
  if (journal.entries.at(-1)?.tag !== expectedLatestMigrationTag) {
    throw new Error(
      `Expected ${expectedLatestMigrationTag} to be the latest migration`
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

const expectSqlState = async (pool, sql, expectedCode, description) => {
  try {
    await pool.query(sql);
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
  const pre0020Records = await migrationRecords(
    pre0020Folder,
    journal.entries.slice(0, pre0020LastIndex + 1)
  );
  const through0020Records = await migrationRecords(
    through0020Folder,
    journal.entries.slice(0, current0020Index + 1)
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

  await runScenario("clean-full-migration", async () => {
    const target = await createDisposableDatabase("clean_full");
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool);
      await assertMigrationLedger(pool, fullRecords);
      await assertCurrentSchema(pool);
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
