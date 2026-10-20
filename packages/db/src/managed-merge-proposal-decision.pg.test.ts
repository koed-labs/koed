import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { runDbMigrations } from "./migrate.js";
import { createManagedConversationRepository } from "./managed-conversation-repository.js";

const testUrl = process.env.KOED_HQ405_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("HQ-405 durable proposal decline", () => {
  const owner = randomUUID();
  const project = randomUUID();
  const session = randomUUID();
  const logical = randomUUID();
  const execution = randomUUID();
  const actor = { userId: owner };
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  let repository: ReturnType<typeof createManagedConversationRepository>;
  let proposalId: string;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq405_decision_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database "${database}"`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    repository = createManagedConversationRepository(pool, {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64")
      )
    });
    await pool.query("insert into users(id,email) values($1,$2)", [
      owner,
      `${owner}@example.test`
    ]);
    await pool.query(
      "insert into projects(id,owner_user_id,name,key) values($1,$2,'PR review','PR')",
      [project, owner]
    );
    await pool.query(
      "insert into sessions(id,logical_session_id,owner_user_id,source_runtime,capture_method) values($1,$2,$3,'codex','api')",
      [session, logical, owner]
    );
    await pool.query(
      `insert into managed_conversation_executions
      (id,owner_user_id,project_id,ai_client_instance_id,model,permission_mode,runner_kind,state,fencing_token_hash,runner_deployment_id,runner_device_id,logical_session_id,provider_thread_id)
      values($1,$2,$3,'codex','test','auto','local_device','quiesced',$4,$5,$6,$7,'provider-thread')`,
      [
        execution,
        owner,
        project,
        "a".repeat(64),
        randomUUID(),
        randomUUID(),
        logical
      ]
    );
    proposalId = (
      await repository.putManagedConversationRuntimeItem(actor, {
        executionId: execution,
        executionGeneration: 1,
        providerRequestId: `review-request-merge-propose:${randomUUID()}:tool`,
        itemKind: "transient_output",
        payload: {
          text: "Merge proposed",
          mergeProposal: { reviewRequestNumber: 212 }
        }
      })
    ).id;
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists "${database}" with (force)`);
    await admin?.end();
  });
  it("retains a stopped proposal, records one decline and reports it only to the same generation", async () => {
    await repository.cancelManagedConversationRuntimeItems(actor, {
      executionId: execution,
      executionGeneration: 1
    });
    expect(
      await repository.getManagedConversationRuntimeItem(actor, proposalId)
    ).not.toBeNull();
    await pool.query(
      "update managed_conversation_executions set state='stopped' where id=$1",
      [execution]
    );
    expect(
      await repository.declineManagedMergeProposal(actor, {
        executionId: execution,
        itemId: proposalId,
        executionGeneration: 1
      })
    ).toBe(true);
    expect(
      await repository.declineManagedMergeProposal(actor, {
        executionId: execution,
        itemId: proposalId,
        executionGeneration: 1
      })
    ).toBe(true);
    expect(
      await repository.listManagedMergeDecisionContext(actor, {
        executionId: execution,
        executionGeneration: 1
      })
    ).toEqual([
      "Koed status: the prior Native review for PR #212 was declined; that proposal grants no approval. A later User request requires a fresh Native review."
    ]);
    expect(
      await repository.declineManagedMergeProposal(actor, {
        executionId: execution,
        itemId: randomUUID(),
        executionGeneration: 1
      })
    ).toBe(false);
    expect(
      await repository.declineManagedMergeProposal(actor, {
        executionId: execution,
        itemId: proposalId,
        executionGeneration: 2
      })
    ).toBe(false);
    expect(
      await repository.listManagedMergeDecisionContext(actor, {
        executionId: execution,
        executionGeneration: 2
      })
    ).toEqual([]);
  });
  it("rejects writes and feedback after Project or session lifecycle closes", async () => {
    await pool.query("update projects set deletion_phase='preparing', delete_batch_id=$2 where id=$1", [project, randomUUID()]);
    await expect(
      repository.declineManagedMergeProposal(actor, {
        executionId: execution,
        itemId: proposalId,
        executionGeneration: 1
      })
    ).rejects.toThrow();
    await expect(
      repository.listManagedMergeDecisionContext(actor, {
        executionId: execution,
        executionGeneration: 1
      })
    ).rejects.toThrow();
    await pool.query("update projects set deletion_phase=null, delete_batch_id=null where id=$1", [project]);
    await pool.query("update sessions set trashed_at=now() where id=$1", [
      session
    ]);
    await expect(
      repository.declineManagedMergeProposal(actor, {
        executionId: execution,
        itemId: proposalId,
        executionGeneration: 1
      })
    ).rejects.toThrow();
    await expect(
      repository.listManagedMergeDecisionContext(actor, {
        executionId: execution,
        executionGeneration: 1
      })
    ).rejects.toThrow();
  });
});
