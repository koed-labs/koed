import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const { Client } = createRequire(
  resolve(import.meta.dirname, "../../../packages/db/package.json")
)("pg");

// Only the isolated packaged smoke calls this helper. Each connection is short
// lived so the real Desktop controller can stop and restart its Postgres service.
export async function seedAccelerationStorageProbe(koedHome, embedding) {
  const query = async (text, values = []) => {
    const ports = JSON.parse(
      readFileSync(resolve(koedHome, "config/local-ports.json"), "utf8")
    );
    const secrets = JSON.parse(
      readFileSync(
        resolve(koedHome, "config/local-service-secrets.json"),
        "utf8"
      )
    );
    assert.match(ports.postgres, /^\d+$/);
    const client = new Client({
      host: "127.0.0.1",
      port: Number(ports.postgres),
      database: "koed",
      user: "koed",
      password: secrets.POSTGRES_PASSWORD,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 10_000
    });
    try {
      await client.connect();
      return (await client.query(text, values)).rows;
    } finally {
      await client.end();
    }
  };
  const owner = randomUUID();
  const assertion = randomUUID();
  const id = randomUUID();
  const source = "Synthetic acceleration qualification: the notebook is blue.";
  const hash = createHash("sha256").update(source).digest("hex");
  assert.equal(embedding.vector.length, 1024);
  await query(
    `WITH owner AS (
       INSERT INTO users (id, email, display_name)
       VALUES ($1::uuid, $9::text, 'Synthetic acceleration check')
       RETURNING id
     ), assertion AS (
       INSERT INTO curated_memory_assertions
         (id, owner_user_id, assertion_text, normalized_assertion)
       SELECT $2, owner.id, $4, $4 FROM owner RETURNING id, owner_user_id
     ), metadata AS (
       INSERT INTO memory_embeddings
         (id, curated_memory_assertion_id, owner_user_id, visibility,
          embedding_model, model_artifact_hash, embedding_dimensions,
          embedding_version, source_hash, source_text,
          embedding_source_content_hash, embedding_input_hash)
       SELECT $3, assertion.id, assertion.owner_user_id, 'personal',
              $5, $6, 1024, $5, $7, $4, $7, $7 FROM assertion RETURNING id
     )
     INSERT INTO memory_embeddings_1024 (memory_embedding_id, embedding)
     SELECT metadata.id, $8::vector FROM metadata`,
    [
      owner,
      assertion,
      id,
      source,
      embedding.modelKey,
      embedding.artifactHash,
      hash,
      JSON.stringify(embedding.vector),
      `${owner}@acceleration.invalid`
    ]
  );
  const read = async () => ({
    rows: await query(
      `SELECT to_jsonb(e)::text AS metadata, v.embedding::text AS vector
       FROM memory_embeddings e JOIN memory_embeddings_1024 v
         ON v.memory_embedding_id = e.id
       WHERE e.curated_memory_assertion_id = $1 ORDER BY e.id`,
      [assertion]
    ),
    work: await query(
      `SELECT
        (SELECT count(*)::integer FROM semantic_memory_rebuild_jobs) AS rebuilds,
        (SELECT count(*)::integer FROM local_work_queue
          WHERE queue_name IN ('memory-embed', 'lcm-embed')) AS embedding_jobs`
    )
  });
  const before = await read();
  assert.equal(before.rows.length, 1);
  return async () => {
    const after = await read();
    assert.deepEqual(
      after,
      before,
      "Backend switching retains vectors and generation metadata without reindex work"
    );
    return {
      retainedRows: after.rows.length,
      storedVectorSha256: createHash("sha256")
        .update(after.rows[0].vector)
        .digest("hex"),
      generationMetadataUnchanged: true,
      reindexWorkUnchanged: true
    };
  };
}
