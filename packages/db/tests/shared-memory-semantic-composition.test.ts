import { describe, expect, it } from "vitest";
import { createDbPool } from "../src/connection.js";
import { runDbMigrations } from "../src/migrate.js";
import { composeSharedMemorySemanticText } from "../src/shared-memory-repository.js";

describe("Team semantic embedding composition", () => {
  it("uses plain redacted event text without routing or JSON scaffolding", () => {
    expect(
      composeSharedMemorySemanticText({
        itemType: "user_message",
        schemaVersion: 1,
        sourceId: "00000000-0000-4000-8000-000000000001",
        sourceLogicalMemoryId: "00000000-0000-4000-8000-000000000002",
        sourceRevision: 7,
        occurredAt: null,
        content: { text: "The launch window is Thursday." }
      })
    ).toBe("The launch window is Thursday.");
  });

  it("separates validated LCM anchors from semantic summary text", () => {
    expect(
      composeSharedMemorySemanticText({
        itemType: "lcm_rollup",
        schemaVersion: 1,
        sourceId: "00000000-0000-4000-8000-000000000003",
        sourceLogicalMemoryId: "00000000-0000-4000-8000-000000000004",
        sourceRevision: 8,
        occurredAt: null,
        content: {
          summaryText: "Release readiness was confirmed.",
          lexicalAnchors: ["KOED-42", "Thursday"],
          sourceIds: ["00000000-0000-4000-8000-000000000005"]
        }
      })
    ).toBe(
      "Release readiness was confirmed.\n\nLexical anchors:\nKOED-42\nThursday"
    );
  });

  it("indexes only the redacted Curated assertion content", () => {
    expect(
      composeSharedMemorySemanticText({
        itemType: "curated_assertion",
        schemaVersion: 1,
        sourceId: "00000000-0000-4000-8000-000000000006",
        sourceLogicalMemoryId: "00000000-0000-4000-8000-000000000007",
        sourceRevision: 9,
        occurredAt: null,
        content: {
          assertionText: "Deployments require an owner-approved rollback plan.",
          topicTitle: "Release policy",
          tags: ["decision", "deployment"],
          sourceCount: 2
        }
      })
    ).toBe(
      "Release policy\nDeployments require an owner-approved rollback plan.\ndecision deployment"
    );
  });
});

const semanticDatabaseUrl = process.env.SHARED_MEMORY_TEST_DATABASE_URL;
const describeDb = semanticDatabaseUrl ? describe : describe.skip;

describeDb("Team 3072-dimensional semantic storage", () => {
  it("migrates to indexed halfvec storage and supports cosine ordering", async () => {
    const pool = createDbPool({ connectionString: semanticDatabaseUrl });
    try {
      await runDbMigrations(pool);
      const catalog = await pool.query<{
        column_type: string;
        opclass: string;
      }>(
        `select format_type(attribute.atttypid,attribute.atttypmod) as column_type,
                opclass.opcname as opclass
           from pg_class table_class
           join pg_attribute attribute on attribute.attrelid=table_class.oid
             and attribute.attname='embedding'
           join pg_index index_row on index_row.indrelid=table_class.oid
           join pg_class index_class on index_class.oid=index_row.indexrelid
             and index_class.relname='team_memory_semantic_vectors_3072_hnsw_idx'
           join pg_opclass opclass on opclass.oid=index_row.indclass[0]
          where table_class.relname='team_memory_semantic_vectors_3072'`
      );
      expect(catalog.rows).toEqual([
        { column_type: "halfvec(3072)", opclass: "halfvec_cosine_ops" }
      ]);

      const ordered = await pool.query<{ score: number }>(
        `with value as (
           select ('[' || '1,' || repeat('0,',3070) || '0]')::halfvec(3072) embedding
         )
         select 1-(embedding <=> embedding) as score from value`
      );
      expect(Number(ordered.rows[0]?.score)).toBeCloseTo(1, 6);
    } finally {
      await pool.end();
    }
  });
});
