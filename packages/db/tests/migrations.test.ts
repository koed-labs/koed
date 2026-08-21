import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const drizzleDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle"
);

const readDrizzleFile = (path: string) =>
  readFile(resolve(drizzleDir, path), "utf8");

describe("historical priority migration chain", () => {
  it("keeps the Project migration before priority migrations", async () => {
    const [journalText, initialPrioritySql, upgradeSql] = await Promise.all([
      readDrizzleFile("meta/_journal.json"),
      readDrizzleFile("0013_brave_black_widow.sql"),
      readDrizzleFile("0014_warm_doorman.sql")
    ]);
    const journal = JSON.parse(journalText) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(journal.entries.slice(12, 15)).toEqual([
      expect.objectContaining({ idx: 12, tag: "0012_cuddly_luke_cage" }),
      expect.objectContaining({ idx: 13, tag: "0013_brave_black_widow" }),
      expect.objectContaining({ idx: 14, tag: "0014_warm_doorman" })
    ]);
    expect(initialPrioritySql).toContain(
      'ADD COLUMN "priority" integer DEFAULT 0 NOT NULL'
    );
    expect(upgradeSql).toContain('ALTER COLUMN "priority" SET DEFAULT 10');
    expect(upgradeSql).toContain(
      `SET "priority" = 10 WHERE "priority" = 0 AND "status" IN ('pending', 'active')`
    );
  });

  it("adds durable historical import state after priority migrations", async () => {
    const [journalText, migrationSql] = await Promise.all([
      readDrizzleFile("meta/_journal.json"),
      readDrizzleFile("0015_curly_the_order.sql")
    ]);
    const journal = JSON.parse(journalText) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(journal.entries[15]).toEqual(
      expect.objectContaining({ idx: 15, tag: "0015_curly_the_order" })
    );
    expect(migrationSql).toContain('CREATE TABLE "historical_import_runs"');
    expect(migrationSql).toContain('CREATE TABLE "historical_import_sources"');
    expect(migrationSql).toContain('"local_source_path" text NOT NULL');
    expect(migrationSql).toContain(
      'ADD COLUMN "import_observed_at" timestamp with time zone'
    );
  });

  it("adds checkpoint integrity before owner-consistent source foreign key", async () => {
    const migrationSql = await readDrizzleFile("0016_wandering_gauntlet.sql");
    const uniqueConstraint = migrationSql.indexOf(
      "historical_import_runs_id_owner_unique"
    );
    const foreignKey = migrationSql.indexOf(
      "historical_import_sources_run_owner_fk"
    );

    expect(uniqueConstraint).toBeGreaterThan(-1);
    expect(foreignKey).toBeGreaterThan(uniqueConstraint);
    expect(migrationSql).toContain('ADD COLUMN "checkpoint_hash" text');
  });

  it("persists and backfills explicit LCM node work-class lineage", async () => {
    const migrationSql = await readDrizzleFile("0018_rainy_santa_claus.sql");

    expect(migrationSql).toContain(
      "ADD COLUMN \"work_class\" text DEFAULT 'normal_embedding_lcm' NOT NULL"
    );
    expect(migrationSql).toContain(
      'JOIN "conversation_projection_processing_outbox" processing'
    );
    expect(migrationSql).toContain(
      "HAVING min(processing.work_class) = max(processing.work_class)"
    );
    expect(migrationSql).toContain("memory_nodes_work_class_check");
  });
});

describe("collaboration receipt migration", () => {
  it("keeps legacy message audiences unknown instead of inferring current access", async () => {
    const migrationSql = await readDrizzleFile(
      "0021_workable_the_renegades.sql"
    );
    const audienceBackfill = migrationSql.slice(
      migrationSql.indexOf("INSERT INTO collaboration_thread_audiences"),
      migrationSql.indexOf("UPDATE collaboration_receipt_states")
    );

    expect(audienceBackfill).toContain(
      "koed:collaboration:audience-members:v1\\n[]"
    );
    expect(audienceBackfill).not.toContain("team_memberships");
    expect(audienceBackfill).not.toContain("team_workspace_access_grants");
    expect(audienceBackfill).not.toContain(
      "collaboration_thread_audience_members"
    );
  });
});

describe("Pi AI Client migration", () => {
  it("adds Pi to the persisted source runtime enum idempotently", async () => {
    const [journalText, migrationSql] = await Promise.all([
      readDrizzleFile("meta/_journal.json"),
      readDrizzleFile("0032_pi_source_runtime.sql")
    ]);
    const journal = JSON.parse(journalText) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(journal.entries[32]).toEqual(
      expect.objectContaining({ idx: 32, tag: "0032_pi_source_runtime" })
    );
    expect(migrationSql).toContain(
      `ALTER TYPE "public"."source_runtime" ADD VALUE IF NOT EXISTS 'pi'`
    );
    for (const transcriptType of [
      "user_message",
      "agent_message",
      "tool_call",
      "tool_result",
      "bash_execution",
      "agent_reasoning",
      "compaction",
      "branch_summary",
      "unknown"
    ]) {
      expect(migrationSql).toContain(
        `'pi', 'pi-session-v1', '${transcriptType}'`
      );
    }
    expect(migrationSql).toContain(
      "Pi reasoning, compaction, and branch summaries are retained as raw provenance only."
    );
    expect(migrationSql).toContain("ON CONFLICT DO NOTHING;");
  });
});

describe("managed Conversation execution owner migration", () => {
  it("backfills safe provider identities without adding a foreign key", async () => {
    const [journalText, migrationSql] = await Promise.all([
      readDrizzleFile("meta/_journal.json"),
      readDrizzleFile("0033_fixed_scarlet_witch.sql")
    ]);
    const journal = JSON.parse(journalText) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(journal.entries[33]).toEqual(
      expect.objectContaining({ idx: 33, tag: "0033_fixed_scarlet_witch" })
    );
    expect(migrationSql).toContain('ADD COLUMN "ai_client_instance_id" text');
    expect(migrationSql).toContain('SET "ai_client_instance_id" = CASE');
    expect(migrationSql).toContain("THEN \"provider\" || '.default'");
    expect(migrationSql).toContain('THEN "provider"');
    expect(migrationSql).toContain("ELSE 'legacy.' || md5(\"provider\")");
    expect(migrationSql).toContain(
      'char_length("managed_conversation_executions"."ai_client_instance_id") <= 128'
    );
    expect(migrationSql).toContain(
      'ALTER COLUMN "ai_client_instance_id" SET NOT NULL'
    );
    expect(migrationSql).toContain(
      "managed_conversation_executions_ai_client_instance_check"
    );
    expect(migrationSql).not.toContain("FOREIGN KEY");
  });
});

describe("Claude AI Client migration", () => {
  it("seeds explicit semantic and raw-only Claude projection policies", async () => {
    const migrationSql = await readDrizzleFile("0030_blue_maddog.sql");

    for (const transcriptType of [
      "user_message",
      "agent_message",
      "subagent_message",
      "tool_call",
      "tool_result"
    ]) {
      expect(migrationSql).toContain(
        `'claude-code', 'claude-code-transcript-v1', '${transcriptType}'`
      );
    }
    for (const transcriptType of [
      "agent_reasoning",
      "system_message",
      "unknown"
    ]) {
      expect(migrationSql).toContain(
        `'claude-code', 'claude-code-transcript-v1', '${transcriptType}'`
      );
    }
    expect(migrationSql).toContain(
      "Full Claude reasoning is retained as raw provenance only."
    );
    expect(migrationSql).toContain("ON CONFLICT DO NOTHING;");
  });

  it("fails clearly before upgrading source rows without signed source-set closure", async () => {
    const migrationSql = await readDrizzleFile("0030_blue_maddog.sql");
    const resetGuard = migrationSql.indexOf(
      "Koed alpha data reset required before enabling multi-component Conversation Sources"
    );
    const sourceSetColumns = migrationSql.indexOf(
      'ADD COLUMN "source_set_closure_hash"'
    );

    expect(resetGuard).toBeGreaterThan(-1);
    expect(sourceSetColumns).toBeGreaterThan(resetGuard);
    expect(migrationSql).toContain(`WHERE "lifecycle" = 'finalized'`);
    expect(migrationSql).toContain('FROM "team_conversation_source_grants"');
    expect(migrationSql).toContain(
      "existing finalized sources and Team source grants cannot be upgraded without a signed source-set closure"
    );
  });
});

describe("Personal Note Share Grant migrations", () => {
  it("backfills existing grants as Captured Session sources and constrains both source shapes", async () => {
    const migrationSql = await readDrizzleFile("0034_broken_morlocks.sql");

    expect(migrationSql).toContain("ENUM('captured_session', 'personal_note')");
    expect(migrationSql).toContain(
      '"source_kind" "shared_memory_source_kind" DEFAULT \'captured_session\' NOT NULL'
    );
    expect(migrationSql).toContain(
      '"shared_source_artifacts"."remote_replica_id" is null'
    );
    expect(migrationSql).toContain(
      '"team_session_share_grants"."session_id" is null'
    );
    expect(migrationSql).toContain(
      '"shared_memory_candidate_previews"."item_count" = 1'
    );
  });

  it("preserves historical source work and fails ambiguous in-flight work for re-review", async () => {
    const migrationSql = await readDrizzleFile("0034_broken_morlocks.sql");
    const addNullable = migrationSql.indexOf(
      'ADD COLUMN "logical_memory_id" uuid;'
    );
    const backfill = migrationSql.indexOf(
      'SET "logical_memory_id" = "local_session_id"'
    );
    const enforceNotNull = migrationSql.indexOf(
      'ALTER COLUMN "logical_memory_id" SET NOT NULL'
    );

    expect(addNullable).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(addNullable);
    expect(enforceNotNull).toBeGreaterThan(backfill);
    expect(migrationSql).toContain("source_binding_migration_review_required");
  });

  it("does not constrain cross-deployment source identities to local rows", async () => {
    const migrationSql = await readDrizzleFile("0034_broken_morlocks.sql");

    expect(migrationSql).toContain(
      'ALTER TABLE "shared_source_artifacts" ADD COLUMN "source_memory_event_id" uuid'
    );
    expect(migrationSql).not.toContain(
      "shared_source_artifacts_source_memory_event_id_memory_events_id_fk"
    );
    expect(migrationSql).not.toContain(
      "team_session_share_grants_source_memory_event_id_memory_events_id_fk"
    );
    expect(migrationSql).not.toContain(
      "shared_memory_candidate_previews_source_session_id_sessions_id_fk"
    );
  });
});
