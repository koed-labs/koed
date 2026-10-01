import { randomBytes, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { afterAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { createEncryptedPayloadRepository } from "./encrypted-payload-repository.js";
import {
  createRecallFeedbackRepository,
  recallFeedbackSourceAssociationHash,
  RecallFeedbackSourceConflictError,
  type RecallFeedbackSourceReference
} from "./recall-feedback-repository.js";

const baseUrl = process.env.RECALL_FEEDBACK_TEST_DATABASE_URL;
const databaseName = `koed_recall_feedback_${randomUUID().replaceAll("-", "")}`;
const sourceMigrationsFolder = fileURLToPath(
  new URL("../drizzle/", import.meta.url)
);

describe.skipIf(!baseUrl)(
  "Managed recalled-answer feedback (PostgreSQL)",
  () => {
    const configuredUrl = baseUrl ? new URL(baseUrl) : null;
    const adminUrl = configuredUrl ? new URL(configuredUrl) : null;
    if (adminUrl) adminUrl.pathname = "/postgres";
    const testUrl = configuredUrl ? new URL(configuredUrl) : null;
    if (testUrl) testUrl.pathname = `/${databaseName}`;
    const admin = adminUrl
      ? new pg.Client({ connectionString: adminUrl.toString() })
      : null;
    const pool = testUrl
      ? new pg.Pool({ connectionString: testUrl.toString() })
      : null;
    let adminConnected = false;
    let prefixFolder: string | null = null;

    afterAll(async () => {
      await pool?.end();
      if (prefixFolder)
        await rm(prefixFolder, { recursive: true, force: true });
      if (!admin || !adminConnected) return;
      try {
        await admin.query(
          "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1",
          [databaseName]
        );
        await admin.query(`drop database if exists "${databaseName}"`);
      } finally {
        await admin.end();
      }
    });

    it("stores one owner-scoped answer record, encrypts comments and source refs, and updates fields independently", async () => {
      if (!admin || !pool) throw new Error("Test database URL is unavailable");
      await admin.connect();
      adminConnected = true;
      await admin.query(`create database "${databaseName}"`);

      const journal = JSON.parse(
        await readFile(
          join(sourceMigrationsFolder, "meta", "_journal.json"),
          "utf8"
        )
      ) as { entries: Array<{ idx: number; tag: string }> };
      const prefixEntries = journal.entries.filter((entry) => entry.idx < 63);
      prefixFolder = await mkdtemp(
        join(tmpdir(), "koed-recall-feedback-prefix-")
      );
      await mkdir(join(prefixFolder, "meta"), { recursive: true });
      for (const entry of prefixEntries) {
        await copyFile(
          join(sourceMigrationsFolder, `${entry.tag}.sql`),
          join(prefixFolder, `${entry.tag}.sql`)
        );
      }
      await writeFile(
        join(prefixFolder, "meta", "_journal.json"),
        `${JSON.stringify({ ...journal, entries: prefixEntries }, null, 2)}\n`
      );
      await runDbMigrations(pool, { migrationsFolder: prefixFolder });

      const ownerId = randomUUID();
      const otherId = randomUUID();
      const executionId = randomUUID();
      const commandId = randomUUID();
      await pool.query(
        "insert into users (id, email, display_name) values ($1, $2, $3), ($4, $5, $6)",
        [
          ownerId,
          `${ownerId}@feedback.invalid`,
          "Owner",
          otherId,
          `${otherId}@feedback.invalid`,
          "Other"
        ]
      );
      for (const sourceTable of ["team_agent_offers", "team_agent_requests"]) {
        await pool.query(
          `insert into encrypted_field_payloads (
             owner_user_id, visibility, encryption_scope, source_table, source_id,
             source_column, envelope_version, provider_mode, key_id, key_version,
             provenance, algorithm, ciphertext, nonce, tag, wrapped_dek,
             ciphertext_location, envelope_created_at
           ) values ($1, 'personal', 'personal', $2, $3, 'test', 1,
                    'local_test_key', 'fixture-key', 1, '{}', 'aes-256-gcm',
                    'ciphertext', 'nonce', 'tag', '{}', 'encrypted_field_payloads', now())`,
          [ownerId, sourceTable, randomUUID()]
        );
      }
      // Apply actual migration 0063 on populated rows allowed by migration 0062.
      await runDbMigrations(pool);
      expect(
        (
          await pool.query(
            `select source_table from encrypted_field_payloads
             where owner_user_id = $1 order by source_table`,
            [ownerId]
          )
        ).rows.map((row) => row.source_table)
      ).toEqual(["team_agent_offers", "team_agent_requests"]);

      await pool.query(
        `insert into managed_conversation_executions (
         id, owner_user_id, ai_client_instance_id, model, permission_mode,
         runner_kind, fencing_token_hash, runner_deployment_id, runner_device_id
       ) values ($1, $2, 'codex.default', 'test-model', 'supervised', 'local_device', $3, $4, $5)`,
        [executionId, ownerId, "a".repeat(64), randomUUID(), randomUUID()]
      );

      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64url")
      );
      const repository = createRecallFeedbackRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const references: RecallFeedbackSourceReference[] = [
        {
          nodeId: "node-1",
          sourceType: "memory_node",
          sourceId: "source-1",
          sourceChunkIndex: 2,
          visibility: "personal",
          teamWorkspaceId: null
        }
      ];
      const sourceAssociationHash =
        recallFeedbackSourceAssociationHash(references);
      const target = {
        executionId,
        answerKind: "provider" as const,
        answerId: commandId
      };

      await expect(
        repository.getRecallFeedback({ userId: otherId }, target)
      ).resolves.toBeNull();
      const first = await repository.putRecallFeedback(
        { userId: ownerId },
        {
          ...target,
          sourceAssociationHash,
          sourceReferences: references,
          rating: "down",
          comment: "Needs a citation check"
        }
      );
      expect(first).toMatchObject({
        rating: "down",
        comment: "Needs a citation check"
      });

      const persisted = await pool.query(
        `select rating, comment_marker from managed_conversation_recall_feedback
       where owner_user_id = $1 and execution_id = $2 and answer_id = $3`,
        [ownerId, executionId, commandId]
      );
      expect(persisted.rows).toEqual([
        {
          rating: "down",
          comment_marker: "[koed encrypted recall feedback comment]"
        }
      ]);
      const encryptedRows = await pool.query(
        `select source_column, ciphertext, visibility, encryption_scope, provenance
       from encrypted_field_payloads
       where owner_user_id = $1 and source_table = 'managed_conversation_recall_feedback'
         and invalidated_at is null order by source_column`,
        [ownerId]
      );
      expect(encryptedRows.rows.map((row) => row.source_column)).toEqual([
        "comment_marker",
        "source_association"
      ]);
      expect(
        encryptedRows.rows.every(
          (row) =>
            row.visibility === "personal" && row.encryption_scope === "personal"
        )
      ).toBe(true);
      expect(
        encryptedRows.rows.every(
          (row) => !String(row.ciphertext).includes("Needs a citation check")
        )
      ).toBe(true);
      const associationRecord = await createEncryptedPayloadRepository(
        pool
      ).decryptAuthorizedEncryptedField({ userId: ownerId }, provider, {
        sourceTable: "managed_conversation_recall_feedback",
        sourceId: (
          await pool.query<{ id: string }>(
            "select id from managed_conversation_recall_feedback where owner_user_id = $1 and answer_id = $2",
            [ownerId, commandId]
          )
        ).rows[0]!.id,
        sourceColumn: "source_association"
      });
      expect(associationRecord).not.toBeNull();
      expect(associationRecord!.plaintext).toEqual(references);

      const commentOnly = await repository.putRecallFeedback(
        { userId: ownerId },
        {
          ...target,
          sourceAssociationHash,
          sourceReferences: references,
          rating: "up"
        }
      );
      expect(commentOnly).toMatchObject({
        rating: "up",
        comment: "Needs a citation check"
      });
      const ratingOnly = await repository.putRecallFeedback(
        { userId: ownerId },
        {
          ...target,
          sourceAssociationHash,
          sourceReferences: references,
          comment: "Saved comment"
        }
      );
      expect(ratingOnly).toMatchObject({
        rating: "up",
        comment: "Saved comment"
      });
      const changedReferences = [
        {
          ...references[0]!,
          nodeId: "different-node"
        }
      ];
      await expect(
        repository.putRecallFeedback(
          { userId: ownerId },
          {
            ...target,
            sourceAssociationHash:
              recallFeedbackSourceAssociationHash(changedReferences),
            sourceReferences: changedReferences,
            rating: "down"
          }
        )
      ).rejects.toBeInstanceOf(RecallFeedbackSourceConflictError);
      expect(
        await repository.getRecallFeedback({ userId: ownerId }, target)
      ).toMatchObject({ rating: "up", comment: "Saved comment" });

      await repository.putRecallFeedback(
        { userId: ownerId },
        {
          ...target,
          sourceAssociationHash,
          sourceReferences: references,
          rating: null,
          comment: null
        }
      );
      expect(
        (
          await pool.query(
            "select 1 from managed_conversation_recall_feedback where owner_user_id = $1 and answer_id = $2",
            [ownerId, commandId]
          )
        ).rowCount
      ).toBe(0);
      expect(
        (
          await pool.query(
            `select count(*)::int as count from encrypted_field_payloads
         where owner_user_id = $1 and source_table = 'managed_conversation_recall_feedback'
           and invalidated_at is null`,
            [ownerId]
          )
        ).rows[0]!.count
      ).toBe(0);
      expect(
        (
          await pool.query(
            "select count(*)::int as count from memory_questions where owner_user_id = $1",
            [ownerId]
          )
        ).rows[0]!.count
      ).toBe(0);
    });
  }
);
