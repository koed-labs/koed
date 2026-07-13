#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
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

const appServerMigrationMarker =
  'CREATE TABLE "conversation_item_observations"';

const createPreAppServerMigrationFolder = async () => {
  const sourceFolder = resolve(packageDir, "drizzle");
  const targetFolder = await mkdtemp(
    resolve(tmpdir(), "koed-pre-app-server-migrations-")
  );
  const targetMetaFolder = resolve(targetFolder, "meta");
  await mkdir(targetMetaFolder, { recursive: true });
  const journal = JSON.parse(
    await readFile(resolve(sourceFolder, "meta", "_journal.json"), "utf8")
  );
  const migrationContents = await Promise.all(
    journal.entries.map((entry) =>
      readFile(resolve(sourceFolder, `${entry.tag}.sql`), "utf8")
    )
  );
  const appServerMigrationIndexes = migrationContents.flatMap(
    (contents, index) =>
      contents.includes(appServerMigrationMarker) ? [index] : []
  );
  if (appServerMigrationIndexes.length !== 1) {
    throw new Error(
      `Expected exactly one app-server ingestion migration, found ${appServerMigrationIndexes.length}`
    );
  }
  const entries = journal.entries.slice(0, appServerMigrationIndexes[0]);
  for (const entry of entries) {
    await copyFile(
      resolve(sourceFolder, `${entry.tag}.sql`),
      resolve(targetFolder, `${entry.tag}.sql`)
    );
  }
  await writeFile(
    resolve(targetMetaFolder, "_journal.json"),
    `${JSON.stringify({ ...journal, entries }, null, 2)}\n`
  );
  return targetFolder;
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
        source_hash, idempotency_key, projection_status, projection_version,
        metadata, transport_chunk_index, transport_chunk_count,
        transport_chunk_text, transport_chunk_encoding
      )
      values (
        $1, $2, 'personal', $3, 'codex', 'codex-transcript-v1',
        'transcript', $4, $4, $5, $6, 'response_item', 'message', $7,
        7, 7, '2026-07-01T01:02:03.000Z', '2026-07-01T01:02:04.000Z',
        $8, $9, $10, $11, 'projected', 'conversation-projection-v2',
        $12, 0, 1, null, null
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

  const encryptedRepository = createEncryptedPayloadRepository(pool);
  for (const sourceColumn of [
    "raw_json",
    "raw_text",
    "source_path",
    "metadata"
  ]) {
    const run = await encryptedRepository.createEncryptedFieldBackfillRun(
      { userId: ownerUserId },
      {
        sourceTable: "conversation_items",
        sourceColumn,
        providerMode: "local_test_key",
        totalRows: 1
      }
    );
    const result = await encryptedRepository.backfillEncryptedFieldBatch(
      { userId: ownerUserId },
      provider,
      {
        runId: run.id,
        sourceTable: "conversation_items",
        sourceColumn,
        batchSize: 10
      }
    );
    if (!result.done || result.encryptedRows !== 1 || result.failedRows !== 0) {
      throw new Error(
        `Pre-app-server encrypted fixture backfill failed for ${sourceColumn}`
      );
    }
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
          projection_status, projection_version, metadata
        )
        values (
          $1, $2, 'personal', $3, 'codex', 'codex-transcript-v1',
          'transcript', $4, $4, $5, $6, 'response_item', 'message', $7,
          11, $8, '2026-07-01T01:03:00.000Z',
          '2026-07-01T01:03:01.000Z', $9, $10, $11, $12, $13,
          'conversation-item-json-v2', $14, $15, 'pending',
          'conversation-projection-v2', $16
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
        {
          canonicalConversationItemKey: chunkCanonicalKey,
          canonicalConversationItemActor: "user",
          canonicalConversationItemKind: "message",
          canonicalStableItemId: chunkExternalItemId,
          sourceItemHash: chunkSourceItemHash,
          transcriptType: "user_message"
        }
      ]
    );
  }
  const chunkBackfillRun =
    await encryptedRepository.createEncryptedFieldBackfillRun(
      { userId: ownerUserId },
      {
        sourceTable: "conversation_items",
        sourceColumn: "transport_chunk_text",
        providerMode: "local_test_key",
        totalRows: chunkTexts.length
      }
    );
  const chunkBackfill = await encryptedRepository.backfillEncryptedFieldBatch(
    { userId: ownerUserId },
    provider,
    {
      runId: chunkBackfillRun.id,
      sourceTable: "conversation_items",
      sourceColumn: "transport_chunk_text",
      batchSize: 10
    }
  );
  if (
    !chunkBackfill.done ||
    chunkBackfill.encryptedRows !== chunkTexts.length ||
    chunkBackfill.failedRows !== 0
  ) {
    throw new Error("Pre-app-server encrypted transport chunk backfill failed");
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
      JSON.stringify({ parents: 2, active_parents: 1, retired_parents: 1 })
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
      parents: 4,
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

const admin = new Client({
  connectionString: withDatabase(databaseUrl, adminDatabase)
});
const targetUrl = withDatabase(databaseUrl, targetDatabase);

await admin.connect();

try {
  await admin.query(
    `drop database if exists ${quoteIdentifier(targetDatabase)} with (force)`
  );
  await admin.query(`create database ${quoteIdentifier(targetDatabase)}`);

  const pool = new Pool({ connectionString: targetUrl });
  let poolClosing = false;
  let unexpectedPoolError;

  pool.on("error", (error) => {
    if (poolClosing && isPostgresAdminTermination(error)) {
      return;
    }
    unexpectedPoolError ??= error;
  });

  const throwUnexpectedPoolError = () => {
    if (unexpectedPoolError) {
      throw unexpectedPoolError;
    }
  };

  try {
    const preAppServerMigrationFolder =
      await createPreAppServerMigrationFolder();
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 19).toString("base64")
    );
    try {
      await runDbMigrations(pool, {
        migrationsFolder: preAppServerMigrationFolder
      });
      const fixture = await seedPopulatedPreAppServerFixture(pool, provider);
      await runDbMigrations(pool);
      await verifyPopulatedAppServerUpgrade(pool, provider, fixture);
    } finally {
      await rm(preAppServerMigrationFolder, { recursive: true, force: true });
    }
    throwUnexpectedPoolError();

    const expectedLatestMigrationTimestamp =
      await getLatestMigrationTimestamp();
    const migrationResult = await pool.query(
      `
        select coalesce(max(created_at), 0)::bigint as latest_migration
        from drizzle.__drizzle_migrations
      `
    );
    const tableResult = await pool.query(
      `
        select
          to_regclass('public.users') as users_table,
          to_regclass('drizzle.__drizzle_migrations') as migrations_table
      `
    );
    throwUnexpectedPoolError();

    const actualLatestMigrationTimestamp = BigInt(
      migrationResult.rows[0]?.latest_migration ?? 0
    );
    if (
      actualLatestMigrationTimestamp < BigInt(expectedLatestMigrationTimestamp)
    ) {
      throw new Error(
        `Latest applied migration ${actualLatestMigrationTimestamp.toString()} is older than expected ${expectedLatestMigrationTimestamp}`
      );
    }

    const tables = tableResult.rows[0];
    if (tables?.users_table !== "users") {
      throw new Error("Migration smoke test did not create public.users");
    }
    if (tables?.migrations_table !== "drizzle.__drizzle_migrations") {
      throw new Error(
        "Migration smoke test did not create drizzle.__drizzle_migrations"
      );
    }

    console.log(
      JSON.stringify(
        {
          database: targetDatabase,
          latestMigration: actualLatestMigrationTimestamp.toString(),
          usersTable: tables.users_table,
          migrationsTable: tables.migrations_table
        },
        null,
        2
      )
    );
  } finally {
    poolClosing = true;
    await pool.end();
  }
} finally {
  await admin.query(
    `drop database if exists ${quoteIdentifier(targetDatabase)} with (force)`
  );
  await admin.end();
}
