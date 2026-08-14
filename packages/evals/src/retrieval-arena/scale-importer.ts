import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createDbPool, type DbPool } from "@koed/db";
import {
  generateRetrievalScaleLoad,
  retrievalScaleLoadRecordSchema,
  retrievalScaleScopeAttestationSchema,
  scaleLoadIdentity,
  type RetrievalScaleLoadRecord,
  type RetrievalScaleProfile,
  type RetrievalScaleScopeAttestation
} from "./scale-runner.js";

export const SCALE_EMBEDDING_COMPATIBILITY_MODEL = "qwen3-0.6b";
export const SCALE_SYNTHETIC_VECTOR_LABEL =
  "koed-scale-synthetic-deterministic-v1";
export const SCALE_SYNTHETIC_EMBEDDING_DIMENSIONS = 1024;
const MARKER = "retrieval-scale-v1";
const BATCH_SIZE = 100;

type Queryable = Pick<DbPool, "query">;

const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const uuid = (hex: string): string =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

const derivedUuid = (value: string): string => uuid(digest(value).slice(0, 32));

const identifier = (value: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(value))
    throw new Error(`invalid PostgreSQL identifier ${JSON.stringify(value)}`);
  return `"${value}"`;
};

const table = (schema: string, name: string): string =>
  `${identifier(schema)}.${identifier(name)}`;

export const assertExplicitScaleTestTarget = (input: {
  databaseUrl: string;
  expectedDatabase: string;
  expectedSchema: string;
}): void => {
  const url = new URL(input.databaseUrl);
  if (
    process.env.NODE_ENV === "production" ||
    !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
  )
    throw new Error(
      "retrieval scale import is test-only and requires a loopback PostgreSQL target"
    );
  if (!/^[a-zA-Z0-9_.-]+$/.test(input.expectedDatabase))
    throw new Error("invalid expected PostgreSQL database name");
  identifier(input.expectedSchema);
  if (
    input.expectedSchema === "public" ||
    !/(test|eval|isolated|scale|arena)/.test(
      `${input.expectedDatabase}_${input.expectedSchema}`
    )
  )
    throw new Error(
      "retrieval scale import requires an explicit non-public test/eval/isolated schema"
    );
};

export const deterministicSyntheticVector = (id: string): string => {
  const position =
    createHash("sha256").update(id, "utf8").digest().readUInt32BE(0) %
    SCALE_SYNTHETIC_EMBEDDING_DIMENSIONS;
  return `[${Array.from(
    { length: SCALE_SYNTHETIC_EMBEDDING_DIMENSIONS },
    (_, index) => (index === position ? "1" : "0")
  ).join(",")}]`;
};

const deterministicSyntheticVectorPosition = (id: string): number =>
  (createHash("sha256").update(id, "utf8").digest().readUInt32BE(0) %
    SCALE_SYNTHETIC_EMBEDDING_DIMENSIONS) +
  1;

async function* readLoad(
  path: string
): AsyncGenerator<RetrievalScaleLoadRecord> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim())
      throw new Error(`scale JSONL line ${lineNumber} is empty`);
    try {
      yield retrievalScaleLoadRecordSchema.parse(JSON.parse(line));
    } catch (error) {
      throw new Error(
        `invalid scale JSONL line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
}

export const verifyRetrievalScaleLoadFile = async (input: {
  path: string;
  profile: RetrievalScaleProfile;
  seed: string;
}): Promise<number> => {
  const expected = generateRetrievalScaleLoad(input.profile, input.seed);
  let count = 0;
  for await (const record of readLoad(input.path)) {
    const next = expected.next();
    if (next.done || JSON.stringify(record) !== JSON.stringify(next.value))
      throw new Error(
        `scale JSONL record ${count} does not match the deterministic generated load`
      );
    count += 1;
  }
  if (!expected.next().done)
    throw new Error(`scale JSONL ended early after ${count} records`);
  return count;
};

const verifyTarget = async (
  db: Queryable,
  expectedDatabase: string,
  expectedSchema: string
): Promise<void> => {
  const result = await db.query<{
    database_name: string;
    schema_exists: boolean;
  }>(
    `select current_database() as database_name,
            exists(select 1 from pg_namespace where nspname = $1) as schema_exists`,
    [expectedSchema]
  );
  const observed = result.rows[0];
  if (!observed || observed.database_name !== expectedDatabase)
    throw new Error(
      "connected PostgreSQL database does not match --expected-database"
    );
  if (!observed.schema_exists)
    throw new Error(
      "the explicit retrieval scale schema does not exist or is not migrated"
    );
};

const marker = (loadIdentity: string): string => `${MARKER}:${loadIdentity}`;
const userId = (identity: string, ordinal: number): string =>
  derivedUuid(`${marker(identity)}:user:${ordinal}`);
const sessionId = (identity: string, ordinal: number): string =>
  derivedUuid(`${marker(identity)}:session:${ordinal}`);
const workspaceId = (identity: string, ordinal: number): string =>
  derivedUuid(`${marker(identity)}:workspace:${ordinal}`);
const teamId = (identity: string): string =>
  derivedUuid(`${marker(identity)}:team`);

const executeRows = async (
  db: Queryable,
  prefix: string,
  rows: unknown[][],
  casts: string[] = []
): Promise<void> => {
  if (rows.length === 0) return;
  const values: string[] = [];
  const parameters: unknown[] = [];
  for (const row of rows) {
    values.push(
      `(${row
        .map((value, index) => {
          parameters.push(value);
          return `$${parameters.length}${casts[index] ?? ""}`;
        })
        .join(",")})`
    );
  }
  await db.query(`${prefix} values ${values.join(",")}`, parameters);
};

const deleteScaleRows = async (
  db: Queryable,
  schema: string,
  identity: string
): Promise<void> => {
  const loadMarker = marker(identity);
  await db.query(
    `delete from ${table(schema, "curated_memory_assertions")} where metadata->>'scaleLoadIdentity' = $1`,
    [identity]
  );
  await db.query(
    `delete from ${table(schema, "memory_nodes")} where idempotency_key like $1`,
    [`${loadMarker}:node:%`]
  );
  await db.query(
    `delete from ${table(schema, "memory_events")} where idempotency_key like $1`,
    [`${loadMarker}:event:%`]
  );
  await db.query(
    `delete from ${table(schema, "sessions")} where idempotency_key like $1`,
    [`${loadMarker}:session:%`]
  );
  await db.query(`delete from ${table(schema, "teams")} where name = $1`, [
    `Scale ${identity.slice(0, 16)}`
  ]);
  await db.query(
    `delete from ${table(schema, "users")} where display_name = $1`,
    [loadMarker]
  );
};

const insertShells = async (
  db: Queryable,
  schema: string,
  profile: RetrievalScaleProfile,
  identity: string
): Promise<void> => {
  const loadMarker = marker(identity);
  const users = Array.from({ length: profile.scope.users }, (_, ordinal) => [
    userId(identity, ordinal),
    `scale-${identity.slice(0, 12)}-${ordinal}@retrieval-scale.invalid`,
    loadMarker
  ]);
  await executeRows(
    db,
    `insert into ${table(schema, "users")} (id,email,display_name)`,
    users
  );
  const owner = userId(identity, 0);
  await db.query(
    `insert into ${table(schema, "teams")} (id,name,created_by_user_id) values ($1,$2,$3)`,
    [teamId(identity), `Scale ${identity.slice(0, 16)}`, owner]
  );
  await executeRows(
    db,
    `insert into ${table(schema, "team_memberships")} (id,team_id,user_id,role,status,accepted_at)`,
    users.map((_, ordinal) => [
      derivedUuid(`${loadMarker}:membership:${ordinal}`),
      teamId(identity),
      userId(identity, ordinal),
      ordinal === 0 ? "owner" : "member",
      "enabled",
      new Date(0)
    ])
  );
  await executeRows(
    db,
    `insert into ${table(schema, "team_workspaces")} (id,team_id,name)`,
    Array.from({ length: profile.scope.teamWorkspaces }, (_, ordinal) => [
      workspaceId(identity, ordinal),
      teamId(identity),
      `Scale Workspace ${ordinal}`
    ])
  );
  const grants = Array.from(
    { length: profile.scope.teamWorkspaces * profile.scope.users },
    (_, ordinal) => {
      const workspaceOrdinal = Math.floor(ordinal / profile.scope.users);
      const ordinalUser = ordinal % profile.scope.users;
      return [
        workspaceId(identity, workspaceOrdinal),
        teamId(identity),
        userId(identity, ordinalUser),
        "read",
        false,
        owner
      ];
    }
  );
  await executeRows(
    db,
    `insert into ${table(schema, "team_workspace_access_grants")} (team_workspace_id,team_id,user_id,access,can_share_owned_memory,granted_by_user_id)`,
    grants
  );
  await executeRows(
    db,
    `insert into ${table(schema, "sessions")} (id,logical_session_id,owner_user_id,visibility,external_session_id,source_runtime,capture_method,idempotency_key,automatic_project_id,automatic_project_name,automatic_project_path,automatic_project_detected_at,metadata)`,
    Array.from({ length: profile.scope.sessions }, (_, ordinal) => {
      const projectOrdinal = ordinal % profile.scope.projects;
      return [
        sessionId(identity, ordinal),
        derivedUuid(`${loadMarker}:logical-session:${ordinal}`),
        userId(identity, ordinal % profile.scope.users),
        "personal",
        `scale-${identity.slice(0, 12)}-${ordinal}`,
        "codex",
        "api",
        `${loadMarker}:session:${ordinal}`,
        `scale-project-${projectOrdinal}`,
        `Scale Project ${projectOrdinal}`,
        `/retrieval-scale/${identity.slice(0, 12)}/project-${projectOrdinal}`,
        new Date(0),
        JSON.stringify({ scaleLoadIdentity: identity, sessionOrdinal: ordinal })
      ];
    })
  );
};

const embeddingRows = (record: RetrievalScaleLoadRecord, identity: string) => {
  const entityId = uuid(record.id);
  const embeddingId = derivedUuid(`${marker(identity)}:embedding:${record.id}`);
  const sourceHash = digest(record.text);
  return {
    metadata: [
      embeddingId,
      record.kind === "memory_node" ? entityId : null,
      record.kind === "memory_event" ? entityId : null,
      record.kind === "curated_memory" ? entityId : null,
      userId(identity, record.userOrdinal),
      "personal",
      SCALE_EMBEDDING_COMPATIBILITY_MODEL,
      digest(SCALE_SYNTHETIC_VECTOR_LABEL),
      SCALE_SYNTHETIC_EMBEDDING_DIMENSIONS,
      SCALE_EMBEDDING_COMPATIBILITY_MODEL,
      "synthetic_deterministic_hash_vector_not_qwen",
      "synthetic_hash_expansion",
      "l2",
      sourceHash,
      record.text
    ],
    vector: [embeddingId, deterministicSyntheticVectorPosition(record.id)] as [
      string,
      number
    ]
  };
};

const insertSyntheticVectors = async (
  db: Queryable,
  schema: string,
  rows: Array<[string, number]>
): Promise<void> => {
  if (rows.length === 0) return;
  const parameters = rows.flat();
  const values = rows
    .map((_, index) => `($${index * 2 + 1}::uuid,$${index * 2 + 2}::int)`)
    .join(",");
  await db.query(
    `insert into ${table(schema, "memory_embeddings_1024")} (memory_embedding_id,embedding)
     select generated.memory_embedding_id,
            (select array_agg(case when dimension = generated.one_position then 1::real else 0::real end order by dimension)::vector
               from generate_series(1,${SCALE_SYNTHETIC_EMBEDDING_DIMENSIONS}) dimension)
       from (values ${values}) generated(memory_embedding_id,one_position)`,
    parameters
  );
};

const flushRecords = async (
  db: Queryable,
  schema: string,
  identity: string,
  records: RetrievalScaleLoadRecord[]
): Promise<void> => {
  const kind = records[0]?.kind;
  if (!kind) return;
  const loadMarker = marker(identity);
  if (kind === "memory_event") {
    await executeRows(
      db,
      `insert into ${table(schema, "memory_events")} (id,actor_user_id,owner_user_id,visibility,event_type,source_runtime,capture_method,session_id,idempotency_key,source_hash,payload,include_in_embedding,include_in_lcm)`,
      records.map((record) => [
        uuid(record.id),
        userId(identity, record.userOrdinal),
        userId(identity, record.userOrdinal),
        "personal",
        "captured",
        "codex",
        "api",
        sessionId(identity, record.sessionOrdinal),
        `${loadMarker}:event:${record.id}`,
        digest(`${loadMarker}:event:${record.id}`),
        JSON.stringify({
          content: record.text,
          text: record.text,
          projectId: `scale-project-${record.projectOrdinal}`,
          scale: {
            generatorVersion: record.generatorVersion,
            profileId: record.profileId,
            seed: record.seed,
            id: record.id,
            ordinal: record.ordinal,
            teamWorkspaceOrdinal: record.teamWorkspaceOrdinal,
            teamWorkspaceId:
              record.teamWorkspaceOrdinal === null
                ? null
                : workspaceId(identity, record.teamWorkspaceOrdinal),
            workspaceContextOnly: true,
            relevanceJudgment: null
          }
        }),
        true,
        false
      ])
    );
  } else if (kind === "memory_node") {
    await executeRows(
      db,
      `insert into ${table(schema, "memory_nodes")} (id,owner_user_id,session_id,created_by_user_id,visibility,kind,depth,title,summary_text,source_runtime,capture_method,idempotency_key,source_hash,source_event_count,summary_structured_json,summary_structured_schema_version)`,
      records.map((record) => [
        uuid(record.id),
        userId(identity, record.userOrdinal),
        sessionId(identity, record.sessionOrdinal),
        userId(identity, record.userOrdinal),
        "personal",
        record.parentMemoryNodeOrdinal === null ? "rollup" : "leaf",
        record.parentMemoryNodeOrdinal === null ? 1 : 0,
        `Synthetic scale node ${record.id}`,
        record.text,
        "codex",
        "api",
        `${loadMarker}:node:${record.id}`,
        digest(`${loadMarker}:node:${record.id}`),
        1,
        JSON.stringify({
          scaleLoadIdentity: identity,
          generatorVersion: record.generatorVersion,
          profileId: record.profileId,
          seed: record.seed,
          id: record.id,
          ordinal: record.ordinal,
          projectId: `scale-project-${record.projectOrdinal}`,
          teamWorkspaceOrdinal: record.teamWorkspaceOrdinal,
          relevanceJudgment: null
        }),
        "koed-retrieval-scale-synthetic-v1"
      ])
    );
    await executeRows(
      db,
      `insert into ${table(schema, "memory_node_sources")} (memory_node_id,memory_event_id,source_order,source_hash)`,
      records.map((record) => [
        uuid(record.id),
        uuid(
          digest(
            `${record.generatorVersion}:${record.profileId}:${record.seed}:memory_event:${record.sourceMemoryEventOrdinal}`
          ).slice(0, 32)
        ),
        0,
        digest(`${loadMarker}:node-source:${record.id}`)
      ])
    );
    await executeRows(
      db,
      `insert into ${table(schema, "memory_node_children")} (parent_memory_node_id,child_memory_node_id,child_order)`,
      records
        .filter((record) => record.parentMemoryNodeOrdinal !== null)
        .map((record) => [
          uuid(
            digest(
              `${record.generatorVersion}:${record.profileId}:${record.seed}:memory_node:${record.parentMemoryNodeOrdinal}`
            ).slice(0, 32)
          ),
          uuid(record.id),
          record.ordinal
        ])
    );
  } else {
    await executeRows(
      db,
      `insert into ${table(schema, "curated_memory_assertions")} (id,owner_user_id,visibility,assertion_text,normalized_assertion,status,confidence,metadata,reconciliation_status)`,
      records.map((record) => [
        uuid(record.id),
        userId(identity, record.userOrdinal),
        "personal",
        record.text,
        record.text.toLowerCase(),
        "current",
        80,
        JSON.stringify({
          scaleLoadIdentity: identity,
          generatorVersion: record.generatorVersion,
          profileId: record.profileId,
          seed: record.seed,
          id: record.id,
          ordinal: record.ordinal,
          projectId: `scale-project-${record.projectOrdinal}`,
          sessionId: sessionId(identity, record.sessionOrdinal),
          teamWorkspaceOrdinal: record.teamWorkspaceOrdinal,
          relevanceJudgment: null
        }),
        "current"
      ])
    );
    await executeRows(
      db,
      `insert into ${table(schema, "curated_memory_sources")} (id,assertion_id,source_type,source_role,memory_event_id,metadata)`,
      records.map((record) => [
        derivedUuid(`${loadMarker}:curated-source:${record.id}`),
        uuid(record.id),
        "memory_event",
        "primary_evidence",
        uuid(
          digest(
            `${record.generatorVersion}:${record.profileId}:${record.seed}:memory_event:${record.sourceMemoryEventOrdinal}`
          ).slice(0, 32)
        ),
        JSON.stringify({ scaleLoadIdentity: identity })
      ])
    );
  }
  const embeddings = records.map((record) => embeddingRows(record, identity));
  await executeRows(
    db,
    `insert into ${table(schema, "memory_embeddings")} (id,memory_node_id,memory_event_id,curated_memory_assertion_id,owner_user_id,visibility,embedding_model,model_artifact_hash,embedding_dimensions,embedding_version,input_transform,pooling,normalization,source_hash,source_text)`,
    embeddings.map((row) => row.metadata)
  );
  await insertSyntheticVectors(
    db,
    schema,
    embeddings.map((row) => row.vector)
  );
};

const scopeQuery = (schema: string): string => `
  select
    (select count(*) from ${table(schema, "users")} where display_name = $1)::int as users,
    (select count(*) from ${table(schema, "team_workspaces")} tw join ${table(schema, "teams")} t on t.id=tw.team_id where t.name=$2)::int as team_workspaces,
    (select count(distinct automatic_project_id) from ${table(schema, "sessions")} where idempotency_key like $3)::int as projects,
    (select count(*) from ${table(schema, "sessions")} where idempotency_key like $3)::int as sessions,
    (select count(*) from ${table(schema, "memory_events")} where idempotency_key like $4)::int as memory_events,
    (select count(*) from ${table(schema, "memory_nodes")} where idempotency_key like $5)::int as memory_nodes,
    (select count(*) from ${table(schema, "curated_memory_assertions")} where metadata->>'scaleLoadIdentity'=$6)::int as curated_memories,
    (select count(*) from ${table(schema, "memory_embeddings")} e
       where e.embedding_model=$7 and e.embedding_version=$7 and e.input_transform=$8
         and (exists(select 1 from ${table(schema, "memory_events")} me where me.id=e.memory_event_id and me.idempotency_key like $4)
           or exists(select 1 from ${table(schema, "memory_nodes")} mn where mn.id=e.memory_node_id and mn.idempotency_key like $5)
           or exists(select 1 from ${table(schema, "curated_memory_assertions")} ca where ca.id=e.curated_memory_assertion_id and ca.metadata->>'scaleLoadIdentity'=$6)))::int as embeddings,
    (select count(*) from ${table(schema, "memory_embeddings")} e join ${table(schema, "memory_embeddings_1024")} v on v.memory_embedding_id=e.id
       where e.embedding_model=$7 and e.embedding_version=$7 and e.input_transform=$8
         and (exists(select 1 from ${table(schema, "memory_events")} me where me.id=e.memory_event_id and me.idempotency_key like $4)
           or exists(select 1 from ${table(schema, "memory_nodes")} mn where mn.id=e.memory_node_id and mn.idempotency_key like $5)
           or exists(select 1 from ${table(schema, "curated_memory_assertions")} ca where ca.id=e.curated_memory_assertion_id and ca.metadata->>'scaleLoadIdentity'=$6)))::int as queryable_vectors,
    (select count(*) from (
       select me.id from ${table(schema, "memory_events")} me
         join ${table(schema, "sessions")} s on s.id=me.session_id
        where me.idempotency_key like $4
          and (me.owner_user_id is distinct from s.owner_user_id
            or me.actor_user_id is distinct from me.owner_user_id
            or nullif(me.payload->>'projectId','') is null)
       union all
       select mn.id from ${table(schema, "memory_nodes")} mn
         join ${table(schema, "sessions")} s on s.id=mn.session_id
         join ${table(schema, "memory_node_sources")} mns on mns.memory_node_id=mn.id
         join ${table(schema, "memory_events")} me on me.id=mns.memory_event_id
        where mn.idempotency_key like $5
          and (mn.owner_user_id is distinct from s.owner_user_id
            or mn.owner_user_id is distinct from me.owner_user_id
            or mn.summary_structured_json->>'projectId' is distinct from me.payload->>'projectId')
       union all
       select ca.id from ${table(schema, "curated_memory_assertions")} ca
         join ${table(schema, "curated_memory_sources")} cs on cs.assertion_id=ca.id
         join ${table(schema, "memory_events")} me on me.id=cs.memory_event_id
        where ca.metadata->>'scaleLoadIdentity'=$6
          and (ca.owner_user_id is distinct from me.owner_user_id
            or ca.metadata->>'sessionId' is distinct from me.session_id::text
            or ca.metadata->>'projectId' is distinct from me.payload->>'projectId')
       union all
       select e.id from ${table(schema, "memory_embeddings")} e
        where e.embedding_model=$7 and e.embedding_version=$7 and e.input_transform=$8
          and ((e.memory_event_id is not null and exists(select 1 from ${table(schema, "memory_events")} me where me.id=e.memory_event_id and me.idempotency_key like $4 and me.owner_user_id is distinct from e.owner_user_id))
            or (e.memory_node_id is not null and exists(select 1 from ${table(schema, "memory_nodes")} mn where mn.id=e.memory_node_id and mn.idempotency_key like $5 and mn.owner_user_id is distinct from e.owner_user_id))
            or (e.curated_memory_assertion_id is not null and exists(select 1 from ${table(schema, "curated_memory_assertions")} ca where ca.id=e.curated_memory_assertion_id and ca.metadata->>'scaleLoadIdentity'=$6 and ca.owner_user_id is distinct from e.owner_user_id)))
     ) ownership_errors)::int as ownership_mismatches`;

export const observeRetrievalScaleScope = async (input: {
  db: Queryable;
  schema: string;
  profile: RetrievalScaleProfile;
  seed: string;
  runtimeIdentity: string;
  databaseIdentity: string;
  observedAt?: string;
}): Promise<RetrievalScaleScopeAttestation> => {
  const identity = scaleLoadIdentity(input.profile, input.seed);
  const loadMarker = marker(identity);
  const result = await input.db.query<Record<string, number>>(
    scopeQuery(input.schema),
    [
      loadMarker,
      `Scale ${identity.slice(0, 16)}`,
      `${loadMarker}:session:%`,
      `${loadMarker}:event:%`,
      `${loadMarker}:node:%`,
      identity,
      SCALE_EMBEDDING_COMPATIBILITY_MODEL,
      "synthetic_deterministic_hash_vector_not_qwen"
    ]
  );
  const row = result.rows[0];
  if (!row || row.queryable_vectors !== row.embeddings)
    throw new Error(
      "scale scope does not have one queryable synthetic vector per embedding"
    );
  if (row.ownership_mismatches !== 0)
    throw new Error(
      `scale scope has ${row.ownership_mismatches} production ownership mismatch(es)`
    );
  const observedScope = {
    users: row.users,
    teamWorkspaces: row.team_workspaces,
    projects: row.projects,
    sessions: row.sessions,
    memoryEvents: row.memory_events,
    memoryNodes: row.memory_nodes,
    curatedMemories: row.curated_memories,
    embeddings: row.embeddings
  };
  for (const [key, expected] of Object.entries(input.profile.scope)) {
    if (observedScope[key as keyof typeof observedScope] !== expected)
      throw new Error(
        `database scale scope ${key} mismatch: expected ${expected}, observed ${observedScope[key as keyof typeof observedScope]}`
      );
  }
  return retrievalScaleScopeAttestationSchema.parse({
    schemaVersion: "koed-retrieval-scale-scope-v1",
    profileId: input.profile.id,
    generatorVersion: "koed-retrieval-scale-load-v1",
    seed: input.seed,
    loadIdentity: identity,
    runtimeIdentity: input.runtimeIdentity,
    databaseIdentity: input.databaseIdentity,
    observedAt: input.observedAt ?? new Date().toISOString(),
    observedScope
  });
};

export const withScaleDatabase = async <T>(input: {
  databaseUrl: string;
  expectedDatabase: string;
  expectedSchema: string;
  operation: (db: DbPool) => Promise<T>;
}): Promise<T> => {
  assertExplicitScaleTestTarget(input);
  const pool = createDbPool({ connectionString: input.databaseUrl });
  try {
    await verifyTarget(pool, input.expectedDatabase, input.expectedSchema);
    return await input.operation(pool);
  } finally {
    await pool.end();
  }
};

export const importRetrievalScaleLoad = async (input: {
  db: DbPool;
  expectedDatabase: string;
  schema: string;
  path: string;
  profile: RetrievalScaleProfile;
  seed: string;
  runtimeIdentity: string;
  databaseIdentity: string;
}): Promise<RetrievalScaleScopeAttestation> => {
  await verifyTarget(input.db, input.expectedDatabase, input.schema);
  await verifyRetrievalScaleLoadFile(input);
  const identity = scaleLoadIdentity(input.profile, input.seed);
  const client = await input.db.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('search_path', $1, true)", [
      input.schema
    ]);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      marker(identity)
    ]);
    await deleteScaleRows(client, input.schema, identity);
    await insertShells(client, input.schema, input.profile, identity);
    let batch: RetrievalScaleLoadRecord[] = [];
    for await (const record of readLoad(input.path)) {
      if (
        batch.length > 0 &&
        (batch[0]!.kind !== record.kind || batch.length >= BATCH_SIZE)
      ) {
        await flushRecords(client, input.schema, identity, batch);
        batch = [];
      }
      batch.push(record);
    }
    await flushRecords(client, input.schema, identity, batch);
    const attestation = await observeRetrievalScaleScope({
      db: client as unknown as Queryable,
      schema: input.schema,
      profile: input.profile,
      seed: input.seed,
      runtimeIdentity: input.runtimeIdentity,
      databaseIdentity: input.databaseIdentity
    });
    await client.query("commit");
    return attestation;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};

export const cleanupRetrievalScaleLoad = async (input: {
  db: DbPool;
  expectedDatabase: string;
  schema: string;
  profile: RetrievalScaleProfile;
  seed: string;
}): Promise<void> => {
  await verifyTarget(input.db, input.expectedDatabase, input.schema);
  const identity = scaleLoadIdentity(input.profile, input.seed);
  const client = await input.db.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('search_path', $1, true)", [
      input.schema
    ]);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      marker(identity)
    ]);
    await deleteScaleRows(client, input.schema, identity);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};
