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
  rawConversationTransportChunkGroupId
} from "@koed/shared";
import { loadRootEnv } from "../../../scripts/api-token-bootstrap-lib.mjs";
import {
  getLatestMigrationTimestamp,
  runDbMigrations
} from "../dist/migrate.js";
import {
  createEncryptedPayloadRepository,
  createMemorySourceRepository
} from "../dist/index.js";

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
const expectedCurrent0020Tag = "0020_whole_silver_sable";
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

const legacyConversationItemRedaction = (sourceColumn) =>
  sourceColumn === "raw_json" || sourceColumn === "metadata"
    ? {
        cast: "jsonb",
        value: {
          contentEncrypted: true,
          encryptedSourceTable: "conversation_items",
          encryptedSourceColumn: sourceColumn
        }
      }
    : { cast: "text", value: "[koed encrypted conversation item]" };

const seedLegacyEncryptedConversationField = async (
  pool,
  provider,
  { ownerUserId, sourceId, sourceColumn, plaintext }
) => {
  const provenance = {
    rowFamily: "conversation_items",
    sourceTable: "conversation_items",
    sourceColumn,
    sourceId
  };
  const aad = {
    ownerUserId,
    visibility: "personal",
    encryptionScope: "personal",
    teamId: null,
    teamWorkspaceId: null,
    sourceTable: "conversation_items",
    sourceId,
    sourceColumn
  };
  const envelope = await provider.encrypt({
    plaintext:
      typeof plaintext === "string" ? plaintext : JSON.stringify(plaintext),
    scope: {},
    provenance,
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
        $1, 'personal', 'personal', 'conversation_items', $2, $3, $4, 'utf8',
        $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14,
        $15::jsonb, $16, $17::jsonb, $18, $19
      )
    `,
    [
      ownerUserId,
      sourceId,
      sourceColumn,
      typeof plaintext === "string" ? "text/plain" : "application/json",
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
  const redaction = legacyConversationItemRedaction(sourceColumn);
  await pool.query(
    `update conversation_items set ${sourceColumn}=$2::${redaction.cast} where id=$1`,
    [
      sourceId,
      redaction.cast === "jsonb"
        ? JSON.stringify(redaction.value)
        : redaction.value
    ]
  );
};

const seedPopulatedPreAppServerFixture = async (pool, provider) => {
  const ownerUserId = randomUUID();
  const sessionId = randomUUID();
  const conversationItemId = randomUUID();
  const messageId = randomUUID();
  const memoryEventId = randomUUID();
  const externalThreadId = `legacy-thread-${randomUUID()}`;
  const externalTurnId = "legacy-turn";
  const externalItemId = "legacy-message";
  const sourcePath = "/private/legacy/operator/transcript.jsonl";
  const sourceHash = `legacy-source-${randomUUID()}`;
  const legacyCanonicalKey = `conversation-item:legacy-${randomUUID()}`;
  const rawText = "Legacy encrypted replay sentinel.";
  const rawJson = {
    timestamp: "2026-07-01T01:02:03.000Z",
    type: "response_item",
    payload: {
      id: externalItemId,
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: rawText }]
    }
  };
  const metadata = {
    canonicalConversationItemKey: legacyCanonicalKey,
    canonicalConversationItemActor: "user",
    canonicalConversationItemKind: "message",
    transcriptType: "user_message",
    sensitiveLegacyMetadata: "must remain encrypted"
  };
  const chunkConversationItemIds = [randomUUID(), randomUUID()];
  const chunkExternalTurnId = "legacy-chunk-turn";
  const chunkExternalItemId = "legacy-chunk-message";
  const chunkCanonicalKey = `conversation-item:${createHash("sha256")
    .update(
      JSON.stringify({
        version: 3,
        provider: "codex",
        externalThreadId,
        externalTurnId: chunkExternalTurnId,
        stableItemId: chunkExternalItemId,
        component: "message"
      })
    )
    .digest("hex")}`;
  const chunkLogicalSourceId = chunkCanonicalKey;
  const chunkSourceItemHash = `legacy-chunk-source-${randomUUID()}`;
  const chunkText = "Legacy encrypted transport chunks reconstruct safely.";
  const chunkEnvelope = JSON.stringify({
    rawJson: {
      type: "response_item",
      payload: {
        id: chunkExternalItemId,
        client_id: chunkExternalItemId,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: chunkText }]
      }
    },
    rawText: chunkText,
    metadata: { transcriptType: "user_message" }
  });
  const chunkMidpoint = Math.floor(chunkEnvelope.length / 2);
  const chunkTexts = [
    chunkEnvelope.slice(0, chunkMidpoint),
    chunkEnvelope.slice(chunkMidpoint)
  ];
  const chunkTransportGroupId = rawConversationTransportChunkGroupId({
    sourceKind: "codex",
    sourceAdapterVersion: "codex-transcript-v1",
    sourceTransport: "transcript",
    logicalSourceId: chunkLogicalSourceId,
    sourceItemHash: chunkSourceItemHash,
    transportChunkCount: chunkTexts.length,
    transportChunkEncoding: "conversation-item-json-v2"
  });
  const chunkSourceHashes = chunkTexts.map(
    (_, index) => `legacy-chunk-observation-${index}-${randomUUID()}`
  );

  await pool.query("insert into users (id, email) values ($1, $2)", [
    ownerUserId,
    `migration-smoke-${ownerUserId}@example.com`
  ]);
  await pool.query(
    `
      insert into sessions (
        id, owner_user_id, visibility, external_session_id, external_thread_id,
        source_runtime, capture_method, codex_transcript_path,
        idempotency_key, source_hash, metadata
      )
      values ($1, $2, 'personal', $3, $3, 'codex-cli', 'hook', $4, $5, $5, $6)
    `,
    [
      sessionId,
      ownerUserId,
      externalThreadId,
      sourcePath,
      `legacy-session-${sessionId}`,
      { managedConversation: false }
    ]
  );
  await pool.query(
    `
      insert into conversation_items (
        id, owner_user_id, visibility, session_id, source_kind,
        source_adapter_version, source_transport, external_session_id,
        external_thread_id, external_turn_id, external_item_id,
        source_record_type, source_event_type, source_path, source_line_number,
        source_sequence, event_time, observed_at, raw_json, raw_text,
        source_hash, idempotency_key, canonical_item_key, projection_status,
        projection_version, metadata, transport_chunk_index, transport_chunk_count,
        transport_chunk_text, transport_chunk_encoding
      )
      values (
        $1, $2, 'personal', $3, 'codex', 'codex-transcript-v1',
        'transcript', $4, $4, $5, $6, 'response_item', 'message', $7,
        7, 7, '2026-07-01T01:02:03.000Z', '2026-07-01T01:02:04.000Z',
        $8, $9, $10, $11, $12, 'projected', 'conversation-projection-v2',
        $13, 0, 1, null, null
      )
    `,
    [
      conversationItemId,
      ownerUserId,
      sessionId,
      externalThreadId,
      externalTurnId,
      externalItemId,
      sourcePath,
      rawJson,
      rawText,
      sourceHash,
      legacyCanonicalKey,
      legacyCanonicalKey,
      metadata
    ]
  );
  await pool.query(
    `
      insert into messages (
        id, session_id, owner_user_id, visibility, role, content,
        source_runtime, capture_method, codex_transcript_path,
        transcript_item_id, idempotency_key, source_hash
      )
      values ($1, $2, $3, 'personal', 'user', $4, 'codex-cli', 'hook',
        $5, '7', $6, $6)
    `,
    [
      messageId,
      sessionId,
      ownerUserId,
      rawText,
      sourcePath,
      `message:${legacyCanonicalKey}`
    ]
  );
  await pool.query(
    `
      insert into memory_events (
        id, actor_user_id, owner_user_id, visibility, event_type,
        source_runtime, capture_method, codex_transcript_path, session_id,
        idempotency_key, source_hash, payload
      )
      values ($1, $2, $2, 'personal', 'captured', 'codex-cli', 'hook',
        $3, $4, $5, $5, $6)
    `,
    [
      memoryEventId,
      ownerUserId,
      sourcePath,
      sessionId,
      `projection:user_turn:${legacyCanonicalKey}`,
      {
        actor: "user",
        content: rawText,
        metadata: { includeInEmbedding: true, includeInLcm: true }
      }
    ]
  );
  await pool.query(
    `
      insert into memory_event_sources (
        memory_event_id, conversation_item_id, source_order, source_role
      )
      values ($1, $2, 0, 'derived')
    `,
    [memoryEventId, conversationItemId]
  );

  for (const sourceColumn of [
    "raw_json",
    "raw_text",
    "source_path",
    "metadata"
  ]) {
    await seedLegacyEncryptedConversationField(pool, provider, {
      ownerUserId,
      sourceId: conversationItemId,
      sourceColumn,
      plaintext: {
        raw_json: rawJson,
        raw_text: rawText,
        source_path: sourcePath,
        metadata
      }[sourceColumn]
    });
  }
  for (const [index, chunk] of chunkTexts.entries()) {
    await pool.query(
      `
        insert into conversation_items (
          id, owner_user_id, visibility, session_id, source_kind,
          source_adapter_version, source_transport, external_session_id,
          external_thread_id, external_turn_id, external_item_id,
          source_record_type, source_event_type, source_path,
          source_line_number, source_sequence, event_time, observed_at,
          raw_json, logical_source_id, transport_chunk_index,
          transport_chunk_count, transport_chunk_text,
          transport_chunk_encoding, source_hash, idempotency_key,
          canonical_item_key, projection_status, projection_version, metadata
        )
        values (
          $1, $2, 'personal', $3, 'codex', 'codex-transcript-v1',
          'transcript', $4, $4, $5, $6, 'response_item', 'message', $7,
          11, $8, '2026-07-01T01:03:00.000Z',
          '2026-07-01T01:03:01.000Z', $9, $10, $11, $12, $13,
          'conversation-item-json-v2', $14, $15, $16, 'pending',
          'conversation-projection-v2', $17
        )
      `,
      [
        chunkConversationItemIds[index],
        ownerUserId,
        sessionId,
        externalThreadId,
        chunkExternalTurnId,
        chunkExternalItemId,
        sourcePath,
        11 + index,
        {
          transportChunk: true,
          transportChunkGroupId: chunkTransportGroupId,
          sourceItemHash: chunkSourceItemHash,
          chunkIndex: index,
          chunkCount: chunkTexts.length
        },
        chunkLogicalSourceId,
        index,
        chunkTexts.length,
        chunk,
        chunkSourceHashes[index],
        `legacy-chunk-idempotency-${index}-${randomUUID()}`,
        `conversation-item:legacy:${chunkConversationItemIds[index]}`,
        {
          canonicalConversationItemKey: chunkCanonicalKey,
          canonicalConversationItemActor: "user",
          canonicalConversationItemKind: "message",
          canonicalStableItemId: chunkExternalItemId,
          transportChunkGroupId: chunkTransportGroupId,
          sourceItemHash: chunkSourceItemHash,
          transcriptType: "user_message"
        }
      ]
    );
  }
  for (const [index, sourceId] of chunkConversationItemIds.entries()) {
    await seedLegacyEncryptedConversationField(pool, provider, {
      ownerUserId,
      sourceId,
      sourceColumn: "transport_chunk_text",
      plaintext: chunkTexts[index]
    });
  }

  return {
    ownerUserId,
    sessionId,
    conversationItemId,
    messageId,
    memoryEventId,
    externalThreadId,
    externalTurnId,
    externalItemId,
    sourcePath,
    sourceHash,
    rawText,
    rawJson,
    metadata,
    chunkConversationItemIds,
    chunkExternalTurnId,
    chunkExternalItemId,
    chunkCanonicalKey,
    chunkLogicalSourceId,
    chunkSourceItemHash,
    chunkSourceHashes,
    chunkText,
    chunkTexts,
    chunkTransportGroupId
  };
};

const verifyPopulatedAppServerUpgrade = async (pool, provider, fixture) => {
  const encryptedRepository = createEncryptedPayloadRepository(pool);
  const observationCount = await pool.query(
    "select count(*)::int as count from conversation_item_observations"
  );
  const copiedCompanions = await pool.query(
    `
      select count(*)::int as count
      from encrypted_field_payloads
      where source_table = 'conversation_item_observations'
    `
  );
  if (observationCount.rows[0]?.count !== 0) {
    throw new Error(
      "App-server migration synthesized historical conversation observations"
    );
  }
  if (copiedCompanions.rows[0]?.count !== 0) {
    throw new Error(
      "App-server migration copied encrypted companions without rebinding"
    );
  }

  for (const [sourceColumn, expected] of [
    ["raw_json", fixture.rawJson],
    ["raw_text", fixture.rawText],
    ["source_path", fixture.sourcePath],
    ["metadata", fixture.metadata]
  ]) {
    const decrypted = await encryptedRepository.decryptAuthorizedEncryptedField(
      { userId: fixture.ownerUserId },
      provider,
      {
        sourceTable: "conversation_items",
        sourceId: fixture.conversationItemId,
        sourceColumn
      }
    );
    if (!isDeepStrictEqual(decrypted?.plaintext, expected)) {
      throw new Error(
        `Populated app-server upgrade could not decrypt legacy ${sourceColumn}`
      );
    }
  }

  const canonicalItemKey = `conversation-item:${createHash("sha256")
    .update(
      JSON.stringify({
        version: 3,
        provider: "codex",
        externalThreadId: fixture.externalThreadId,
        externalTurnId: fixture.externalTurnId,
        stableItemId: fixture.externalItemId,
        component: "message"
      })
    )
    .digest("hex")}`;
  const previousProfile = process.env.KOED_DEPLOYMENT_PROFILE;
  process.env.KOED_DEPLOYMENT_PROFILE = "private_vps";
  try {
    const repository = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const replayed = await repository.createConversationItems(
      { userId: fixture.ownerUserId },
      {
        items: [
          {
            sessionId: fixture.sessionId,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "transcript",
            externalSessionId: fixture.externalThreadId,
            externalThreadId: fixture.externalThreadId,
            externalTurnId: fixture.externalTurnId,
            externalItemId: fixture.externalItemId,
            canonicalItemKey,
            canonicalStableItemId: fixture.externalItemId,
            observationComponent: "message",
            sourceRecordType: "response_item",
            sourceEventType: "message",
            sourcePath: fixture.sourcePath,
            sourceLineNumber: 7,
            sourceSequence: 7,
            eventTime: "2026-07-01T01:02:03.000Z",
            rawJson: fixture.rawJson,
            rawText: fixture.rawText,
            sourceHash: fixture.sourceHash,
            idempotencyKey: `post-app-server-replay-${randomUUID()}`,
            metadata: { transcriptType: "user_message" }
          }
        ]
      }
    );
    if (!replayed[0]?.id) {
      throw new Error(
        "App-server migration legacy replay did not create a canonical parent"
      );
    }
    const legacyReplayConvergence = await pool.query(
      `
        select
          count(*) filter (
            where canonical_item_key = $2
              and memory_excluded_at is null
          )::int as active_canonical_parents,
          count(*) filter (
            where id = $1
              and memory_exclusion_reason = 'canonical_observation_migrated'
          )::int as retired_legacy_parents
        from conversation_items
        where owner_user_id = $3
      `,
      [fixture.conversationItemId, canonicalItemKey, fixture.ownerUserId]
    );
    if (
      JSON.stringify(legacyReplayConvergence.rows[0]) !==
      JSON.stringify({
        active_canonical_parents: 1,
        retired_legacy_parents: 1
      })
    ) {
      throw new Error(
        `App-server migration legacy replay did not converge safely: ${JSON.stringify(legacyReplayConvergence.rows[0])}`
      );
    }

    for (const [index, expected] of fixture.chunkTexts.entries()) {
      const decrypted =
        await encryptedRepository.decryptAuthorizedEncryptedField(
          { userId: fixture.ownerUserId },
          provider,
          {
            sourceTable: "conversation_items",
            sourceId: fixture.chunkConversationItemIds[index],
            sourceColumn: "transport_chunk_text"
          }
        );
      if (decrypted?.plaintext !== expected) {
        throw new Error(
          `App-server migration could not decrypt legacy transport chunk ${index}`
        );
      }
    }
    const chunkProjection = await repository.projectPendingConversationItems(
      { userId: fixture.ownerUserId },
      { limit: 10 }
    );
    if (chunkProjection.memoryEventsCreated !== 1) {
      throw new Error(
        `App-server migration legacy chunk Projection created ${chunkProjection.memoryEventsCreated} Memory Events`
      );
    }
    const replayedChunks = await repository.createConversationItems(
      { userId: fixture.ownerUserId },
      {
        items: fixture.chunkTexts.map((chunk, index) => ({
          sessionId: fixture.sessionId,
          sourceKind: "codex",
          sourceAdapterVersion: "codex-transcript-v1",
          sourceTransport: "transcript",
          externalSessionId: fixture.externalThreadId,
          externalThreadId: fixture.externalThreadId,
          externalTurnId: fixture.chunkExternalTurnId,
          externalItemId: fixture.chunkExternalItemId,
          canonicalItemKey: fixture.chunkCanonicalKey,
          canonicalStableItemId: fixture.chunkExternalItemId,
          observationKind: "reconciliation",
          observationComponent: "message",
          sourceRecordType: "response_item",
          sourceEventType: "message",
          sourcePath: fixture.sourcePath,
          sourceLineNumber: 11,
          sourceSequence: 11 + index,
          eventTime: "2026-07-01T01:03:00.000Z",
          rawJson: {
            transportChunk: true,
            transportChunkGroupId: fixture.chunkTransportGroupId,
            sourceItemHash: fixture.chunkSourceItemHash,
            chunkIndex: index,
            chunkCount: fixture.chunkTexts.length
          },
          logicalSourceId: fixture.chunkLogicalSourceId,
          transportChunkIndex: index,
          transportChunkCount: fixture.chunkTexts.length,
          transportChunkText: chunk,
          transportChunkEncoding: "conversation-item-json-v2",
          sourceHash: fixture.chunkSourceHashes[index],
          idempotencyKey: `post-app-server-chunk-replay-${index}-${randomUUID()}`,
          metadata: {
            canonicalConversationItemActor: "user",
            canonicalConversationItemKind: "message",
            transcriptType: "user_message"
          }
        }))
      }
    );
    if (new Set(replayedChunks.map((item) => item.id)).size !== 1) {
      throw new Error(
        "App-server migration legacy chunk replay did not converge on one parent"
      );
    }
    const convergence = await pool.query(
      `
        select
          count(*)::int as parents,
          count(*) filter (where memory_excluded_at is null)::int as active_parents,
          count(*) filter (
            where memory_exclusion_reason = 'canonical_observation_migrated'
          )::int as retired_parents
        from conversation_items
        where logical_source_id = $1
      `,
      [fixture.chunkLogicalSourceId]
    );
    if (
      JSON.stringify(convergence.rows[0]) !==
      JSON.stringify({ parents: 3, active_parents: 1, retired_parents: 2 })
    ) {
      throw new Error(
        `App-server migration legacy chunk convergence failed: ${JSON.stringify(convergence.rows[0])}`
      );
    }
    const chunkMemoryEvents = await pool.query(
      "select id from memory_events where session_id = $1 order by created_at asc",
      [fixture.sessionId]
    );
    const embeddableTexts = (
      await Promise.all(
        chunkMemoryEvents.rows.map((event) =>
          repository.getEmbeddableSource("memory_event", event.id)
        )
      )
    ).map((source) => source?.text);
    if (!embeddableTexts.includes(fixture.chunkText)) {
      throw new Error(
        "App-server migration encrypted legacy chunks projected the wrong text"
      );
    }
  } finally {
    if (previousProfile === undefined) {
      delete process.env.KOED_DEPLOYMENT_PROFILE;
    } else {
      process.env.KOED_DEPLOYMENT_PROFILE = previousProfile;
    }
  }

  const counts = await pool.query(
    `
      select
        (select count(*)::int from conversation_items) as parents,
        (select count(*)::int from conversation_item_observations) as observations,
        (select count(*)::int from messages) as messages,
        (select count(*)::int from memory_events) as memory_events,
        (
          select count(*)::int
          from encrypted_field_payloads
          where source_table = 'conversation_item_observations'
        ) as observation_companions
    `
  );
  if (
    JSON.stringify(counts.rows[0]) !==
    JSON.stringify({
      parents: 5,
      observations: 3,
      messages: 2,
      memory_events: 2,
      observation_companions: 12
    })
  ) {
    throw new Error(
      `App-server migration replay integrity counts were unexpected: ${JSON.stringify(counts.rows[0])}`
    );
  }

  const observation = await pool.query(
    `
      select id, source_path, metadata
      from conversation_item_observations
      where canonical_item_key = $1
      limit 1
    `,
    [canonicalItemKey]
  );
  const observationJson = JSON.stringify(observation.rows[0]);
  if (
    observationJson.includes(fixture.sourcePath) ||
    observationJson.includes("must remain encrypted")
  ) {
    throw new Error(
      "App-server migration replay persisted sensitive observation plaintext"
    );
  }
  for (const [sourceColumn, expected] of [
    ["raw_json", fixture.rawJson],
    ["raw_text", fixture.rawText],
    ["source_path", fixture.sourcePath]
  ]) {
    const decrypted = await encryptedRepository.decryptAuthorizedEncryptedField(
      { userId: fixture.ownerUserId },
      provider,
      {
        sourceTable: "conversation_item_observations",
        sourceId: observation.rows[0].id,
        sourceColumn
      }
    );
    if (!isDeepStrictEqual(decrypted?.plaintext, expected)) {
      throw new Error(
        `App-server migration replay observation ${sourceColumn} did not decrypt`
      );
    }
  }
  const decryptedObservationMetadata =
    await encryptedRepository.decryptAuthorizedEncryptedField(
      { userId: fixture.ownerUserId },
      provider,
      {
        sourceTable: "conversation_item_observations",
        sourceId: observation.rows[0].id,
        sourceColumn: "metadata"
      }
    );
  const observationMetadata = decryptedObservationMetadata?.plaintext;
  if (
    typeof observationMetadata !== "object" ||
    observationMetadata === null ||
    observationMetadata.transcriptType !== "user_message" ||
    observationMetadata.canonicalConversationItemKey !== canonicalItemKey ||
    JSON.stringify(observationMetadata).includes("must remain encrypted")
  ) {
    throw new Error(
      "App-server migration replay observation metadata did not decrypt safely"
    );
  }

  const redactionClient = await pool.connect();
  let arbitraryRedactionBlocked = false;
  try {
    await redactionClient.query("begin");
    await redactionClient.query(
      "select set_config('koed.observation_redaction_source_id', $1, true)",
      [observation.rows[0].id]
    );
    await redactionClient.query(
      "select set_config('koed.observation_redaction_source_column', 'raw_text', true)"
    );
    try {
      await redactionClient.query(
        "update conversation_item_observations set raw_text = 'attacker plaintext' where id = $1",
        [observation.rows[0].id]
      );
    } catch (error) {
      arbitraryRedactionBlocked =
        typeof error === "object" && error !== null && error.code === "55000";
    }
  } finally {
    await redactionClient.query("rollback");
    redactionClient.release();
  }
  if (!arbitraryRedactionBlocked) {
    throw new Error(
      "Conversation observation immutability accepted an arbitrary redaction write"
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
        to_regclass('drizzle.__drizzle_migrations')::text as migrations_table,
        to_regclass('public.team_chat_threads')::text as discarded_team_chat_table,
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
    `
  );
  const row = result.rows[0];
  if (
    row?.users_table !== "users" ||
    row?.collaboration_threads_table !== "collaboration_threads" ||
    row?.collaboration_messages_table !== "collaboration_messages" ||
    row?.migrations_table !== "drizzle.__drizzle_migrations" ||
    row?.discarded_team_chat_table !== null ||
    row?.collaboration_participant_triggers !== 3
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
  const fullRecords = await migrationRecords(migrationsFolder, journal.entries);
  const pre0020Records = await migrationRecords(
    pre0020Folder,
    journal.entries.slice(0, pre0020LastIndex + 1)
  );
  const through0020Records = await migrationRecords(
    through0020Folder,
    journal.entries.slice(0, current0020Index + 1)
  );

  await runScenario("clean-full-migration", async () => {
    const target = await createDisposableDatabase("clean_full");
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool);
      await assertMigrationLedger(pool, fullRecords);
      await assertCurrentSchema(pool);
    });
  });

  await runScenario("populated-current-main-through-single-0020", async () => {
    const target = await createDisposableDatabase("populated");
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 19).toString("base64")
    );
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool, {
        migrationsFolder: pre0020Folder
      });
      await assertMigrationLedger(pool, pre0020Records);
      const fixture = await seedPopulatedPreAppServerFixture(pool, provider);
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
      await verifyPopulatedAppServerUpgrade(pool, provider, fixture);
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
