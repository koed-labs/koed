import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import {
  createManagedMemoryActionRepository,
  createMemorySourceRepository,
  createProjectActivityRepository,
  createProjectSourceRepository,
  runDbMigrations,
  verifyManagedJournalTerminal
} from "../src/index.js";
import { parseClaudeTranscriptJournalBytes } from "../../mcp-server/src/claude-transcript-parser.js";
import { turnBoundaryControl } from "../../mcp-server/src/claude-transcript-adapter.js";
import { parsePiSessionJournalBytes } from "../../mcp-server/src/pi-session-parser.js";
import {
  buildCodexTranscriptConversationItems,
  parseTranscriptJournalBytes
} from "../../mcp-server/src/codex-transcript-parser.js";

const adminUrl = process.env.KOED_HQ505_TEST_DATABASE_URL;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

describe.skipIf(!adminUrl)(
  "Project HQ trusted catch-up on real Postgres",
  () => {
    let admin: pg.Pool;
    let pool: pg.Pool;
    let database: string;
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: adminUrl });
      database = `hq505_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`create database ${quote(database)}`);
      const url = new URL(adminUrl!);
      url.pathname = `/${database}`;
      pool = new pg.Pool({ connectionString: url.toString() });
      await runDbMigrations(pool);
    }, 120_000);
    afterAll(async () => {
      await pool?.end();
      if (admin && database)
        await admin.query(`drop database if exists ${quote(database)}`);
      await admin?.end();
    });

    const setup = async (providerKind: "codex" | "claude" | "pi" = "codex") => {
      const owner = randomUUID();
      const other = randomUUID();
      const projectId = randomUUID();
      const executionId = randomUUID();
      const sessionId = randomUUID();
      const logicalSessionId = randomUUID();
      const generationId = randomUUID();
      const deploymentId = randomUUID();
      const deviceId = randomUUID();
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64url")
      );
      const managed = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const sources = createProjectSourceRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const activity = createProjectActivityRepository(pool);
      await pool.query(`insert into users(id,email) values($1,$2),($3,$4)`, [
        owner,
        `${owner}@example.test`,
        other,
        `${other}@example.test`
      ]);
      await pool.query(
        `insert into projects(id,owner_user_id,name,key)
       values($1,$2,'Catch-up','CATCH')`,
        [projectId, owner]
      );
      await pool.query(
        `insert into sessions(id,logical_session_id,owner_user_id,
         source_runtime,capture_method,external_session_id,metadata)
       values($1,$2,$3,$4,'api','provider-thread',
         '{"managedConversation":true}'::jsonb)`,
        [
          sessionId,
          logicalSessionId,
          owner,
          providerKind === "claude" ? "claude-code" : providerKind
        ]
      );
      await pool.query(
        `insert into managed_conversation_executions
       (id,owner_user_id,project_id,is_project_hq,hq_private_path,provider,
        ai_client_instance_id,model,permission_mode,runner_kind,state,
        fencing_token_hash,runner_deployment_id,runner_device_id,
        logical_session_id,provider_thread_id,source_generation_id)
       values($1,$2,$3,true,'/private/hq',$4,$5,'gpt-test',
         'supervised','local_device','running',$6,$7,$8,$9,'provider-thread',$10)`,
        [
          executionId,
          owner,
          projectId,
          providerKind,
          `${providerKind}.default`,
          "a".repeat(64),
          deploymentId,
          deviceId,
          logicalSessionId,
          generationId
        ]
      );
      await pool.query(
        `insert into project_hq_conversations
       (project_id,owner_user_id,managed_execution_id) values($1,$2,$3)`,
        [projectId, owner, executionId]
      );
      await pool.query(
        `insert into managed_conversation_runtime_bindings
       (execution_id,owner_user_id,deployment_id,device_id,
        execution_generation,source_project_path,project_path,
        local_session_id,provider_thread_id,transcript_path,managed_home,
        source_generation_id)
       values($1,$2,$3,$4,1,'/private/hq','/private/hq',$5,
         'provider-thread','/private/hq/transcript.jsonl','/private/hq',$6)`,
        [executionId, owner, deploymentId, deviceId, sessionId, generationId]
      );
      const uploaded = await sources.uploadDocument(owner, projectId, {
        name: "Unparsed syllabus.txt",
        mediaType: "text/plain",
        bytesBase64: Buffer.from("no text layer").toString("base64"),
        idempotencyKey: randomUUID()
      });
      const claim = await sources.claimDocumentAttempt();
      expect(claim?.id).toBe(uploaded.attempt.id);
      await sources.finishDocumentAttempt({
        ownerUserId: owner,
        attemptId: claim!.id,
        leaseGeneration: claim!.leaseGeneration,
        failureReason: "parse_error"
      });
      const seen = await activity.seen(owner, projectId);
      const page = await activity.list(owner, projectId, {
        after: seen.cursor,
        limit: 100
      });
      const failed = page.items.find((item) => item.kind === "source_failed");
      expect(failed?.ref).toBe(claim!.id);
      const events = [
        {
          cursor: failed!.cursor,
          kind: "source_failed" as const,
          attemptId: claim!.id,
          sourceId: uploaded.source.id,
          name: uploaded.source.name,
          at: failed!.at
        }
      ];
      const highWater = page.items.at(-1)!.cursor;
      const input = {
        projectId,
        executionId,
        executionGeneration: 1,
        seenCursor: seen.cursor,
        highWater,
        events,
        prompt: "Koed Project HQ catch-up: report verified Source outcome.",
        inputDigest: createHash("sha256")
          .update(
            JSON.stringify({
              ownerUserId: owner,
              projectId,
              seenCursor: seen.cursor,
              highWater,
              events
            })
          )
          .digest("hex")
      };
      return {
        owner,
        other,
        projectId,
        executionId,
        sessionId,
        generationId,
        deploymentId,
        deviceId,
        provider,
        managed,
        sources,
        activity,
        input
      };
    };

    const persistProviderTurn = async (
      f: Awaited<ReturnType<typeof setup>>,
      command: { id: string; clientUserMessageId: string | null },
      sourceKind: "codex" | "claude-code" | "pi",
      options: {
        assistant?: boolean;
        originCommandId?: string;
        generationId?: string;
      } = {}
    ) => {
      const fingerprint = "b".repeat(64);
      const turnId = randomUUID();
      const assistantKey = randomUUID();
      await pool.query(
        `insert into conversation_source_artifacts
       (owner_user_id,session_id,logical_source_id,source_generation_id,
        replica_role,source_kind,source_runtime,external_session_id,
        source_fingerprint,artifact_format,artifact_format_version,
        source_adapter_version,source_created_at,storage_provider,storage_prefix,
        origin_deployment_id,origin_device_id,origin_key_id,origin_public_key,
        redacted_source_label,provider_cursor_line,current_source_length)
       values($1,$2,$3,$4,'origin_local',$5,$6,'provider-thread',$7,
        'jsonl',1,'test-v1',now(),'local','test',$8,$9,'test-key',$10,
        'Test provider capture',4,100)`,
        [
          f.owner,
          f.sessionId,
          randomUUID(),
          options.generationId ?? f.generationId,
          sourceKind,
          sourceKind,
          fingerprint,
          f.deploymentId,
          f.deviceId,
          "A".repeat(43)
        ]
      );
      await pool.query(
        `insert into conversation_items
       (owner_user_id,session_id,source_kind,source_adapter_version,
        source_transport,external_session_id,external_turn_id,
        canonical_stable_item_id,source_record_type,source_event_type,
        source_line_number,source_fingerprint,raw_json,source_hash,
        idempotency_key,canonical_item_key,projection_status,metadata)
       values($1,$2,$3,'test-v1','local','provider-thread',$4,$5,
        'message','user_message',1,$6,'{}'::jsonb,$7,$8,$9,'raw_only',$10::jsonb)`,
        [
          f.owner,
          f.sessionId,
          sourceKind,
          turnId,
          sourceKind === "codex"
            ? `koed-user-message:${command.clientUserMessageId}`
            : randomUUID(),
          fingerprint,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          JSON.stringify({
            transcriptType: "user_message",
            managedKoedCatchUpCommandId: options.originCommandId ?? command.id,
            managedClientUserMessageId: command.clientUserMessageId
          })
        ]
      );
      if (options.assistant !== false) {
        await pool.query(
          `insert into conversation_items
         (owner_user_id,session_id,source_kind,source_adapter_version,
          source_transport,external_session_id,external_turn_id,
          source_record_type,source_event_type,source_line_number,
          source_fingerprint,raw_json,source_hash,idempotency_key,
          canonical_item_key,projection_status,metadata)
         values($1,$2,$3,'test-v1','local','provider-thread',$4,
          'message','assistant_message',2,$5,'{}'::jsonb,$6,$7,$8,
          'projected',$9::jsonb)`,
          [
            f.owner,
            f.sessionId,
            sourceKind,
            turnId,
            fingerprint,
            randomUUID(),
            randomUUID(),
            assistantKey,
            JSON.stringify({ canonicalConversationItemKey: assistantKey })
          ]
        );
        await pool.query(
          `insert into messages
         (session_id,owner_user_id,visibility,role,content,source_runtime,
          capture_method,idempotency_key)
         values($1,$2,'personal','assistant','Persisted reply',$3,'api',$4)`,
          [f.sessionId, f.owner, sourceKind, `message:${assistantKey}`]
        );
      }
      return { turnId };
    };

    it("atomically records a current Project decision and rolls back review if Project is locked", async () => {
      const f = await setup();
      const evidenceSession = await f.managed.createCapturedSession(
        { userId: f.owner },
        {
          externalSessionId: `decision-${randomUUID()}`,
          sourceRuntime: "codex",
          captureMethod: "api"
        }
      );
      await pool.query(
        `update sessions set automatic_project_id=$2,
           automatic_project_name='Local project',
           automatic_project_detected_at=now(),
           automatic_personal_project_id=$3 where id=$1`,
        [evidenceSession.id, `local-${randomUUID()}`, f.projectId]
      );
      const [item] = await f.managed.createConversationItems(
        { userId: f.owner },
        {
          items: [
            {
              sessionId: evidenceSession.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "transcript",
              sourceRecordType: "event_msg",
              sourceEventType: "user_message",
              rawJson: {
                type: "event_msg",
                payload: { content: "Use the smaller release." }
              },
              rawText: "Use the smaller release.",
              sourceHash: `decision-${randomUUID()}`,
              idempotencyKey: `decision-${randomUUID()}`,
              metadata: { transcriptType: "user_message" }
            }
          ]
        }
      );
      const proposal = await f.managed.createCuratedMemoryProposal(
        { userId: f.owner },
        {
          proposedClaim: "Use the smaller release.",
          projectContextId: f.projectId,
          evidenceConversationItemIds: [item!.id]
        }
      );
      const [claimed] = await f.managed.claimPendingCuratedMemoryProposals(
        { userId: f.owner },
        { proposalId: proposal.id, leaseSeconds: 60 }
      );
      const input = {
        proposalId: proposal.id,
        decision: "store" as const,
        expectedAttemptCount: claimed!.proposal.attemptCount,
        evidenceRevisions: claimed!.evidence.map((evidence) => ({
          sourceType: evidence.sourceType,
          sourceId: evidence.sourceId,
          sourceHash: evidence.sourceHash
        })),
        selectedEvidenceIds: [item!.id],
        candidateAssertionIds: [],
        assertion: {
          assertionText: "Use the smaller release.",
          kind: "decision" as const,
          scope: "project" as const,
          sources: [
            {
              sourceType: "conversation_item" as const,
              sourceRole: "primary_evidence" as const,
              conversationItemId: item!.id
            }
          ]
        }
      };
      const blocker = await pool.connect();
      try {
        await blocker.query("begin");
        await blocker.query("select 1 from projects where id=$1 for update", [
          f.projectId
        ]);
        await expect(
          f.managed.processCuratedMemoryProposal({ userId: f.owner }, input)
        ).rejects.toMatchObject({ statusCode: 409 });
      } finally {
        await blocker.query("rollback");
        blocker.release();
      }
      const rolledBack = await pool.query(
        `select id from curated_memory_assertions where owner_user_id=$1
         and project_id=$2`,
        [f.owner, f.projectId]
      );
      expect(rolledBack.rowCount).toBe(0);
      const stored = await f.managed.processCuratedMemoryProposal(
        { userId: f.owner },
        input
      );
      expect(stored.status).toBe("stored");
      await f.managed.processCuratedMemoryProposal({ userId: f.owner }, input);
      const activities = await pool.query(
        `select ref from project_activity where owner_user_id=$1
         and project_id=$2 and kind='assertion_created'`,
        [f.owner, f.projectId]
      );
      expect(activities.rows).toEqual([{ ref: stored.assertionId }]);
      const resolved = await f.managed.resolveActivityDecisions(
        { userId: f.owner },
        f.projectId,
        [stored.assertionId!]
      );
      expect(resolved).toMatchObject([
        { assertionId: stored.assertionId, text: "Use the smaller release." }
      ]);
      const page = await f.activity.list(f.owner, f.projectId, {
        after: f.input.seenCursor,
        limit: 100
      });
      const decisionActivity = page.items.find(
        (item) =>
          item.kind === "assertion_created" && item.ref === stored.assertionId
      );
      expect(decisionActivity).toBeDefined();
      const decisionEvents = [
        {
          cursor: decisionActivity!.cursor,
          kind: "assertion_created" as const,
          assertionId: resolved[0]!.assertionId,
          text: resolved[0]!.text,
          classificationVersion: resolved[0]!.classificationVersion,
          updatedAt: resolved[0]!.updatedAt,
          at: decisionActivity!.at
        }
      ];
      const highWater = decisionActivity!.cursor;
      const inputDigest = createHash("sha256")
        .update(
          JSON.stringify({
            ownerUserId: f.owner,
            projectId: f.projectId,
            seenCursor: f.input.seenCursor,
            highWater,
            events: decisionEvents
          })
        )
        .digest("hex");
      expect(resolved[0]!.updatedAt).toMatch(/\.\d{6}Z$/);
      const command = await f.managed.enqueueManagedConversationCatchUp(
        { userId: f.owner },
        {
          projectId: f.projectId,
          executionId: f.executionId,
          executionGeneration: 1,
          seenCursor: f.input.seenCursor,
          highWater,
          events: decisionEvents,
          prompt: "Koed verified Project decision catch-up.",
          inputDigest
        }
      );
      expect(command.commandKind).toBe("hq_catch_up");
      const [turnClaim] = await f.managed.claimManagedConversationCommands({
        ownerUserId: f.owner,
        runnerId: "hq505-decision-terminal",
        deploymentId: f.deploymentId,
        deviceId: f.deviceId,
        leaseMs: 60_000
      });
      expect(turnClaim?.id).toBe(command.id);
      const decisionCapture = await persistProviderTurn(f, command, "codex");
      expect(
        await f.managed.completeManagedConversationCatchUp({
          commandId: command.id,
          leaseToken: turnClaim!.leaseToken!,
          localSessionId: f.sessionId,
          sourceKind: "codex",
          externalSessionId: "provider-thread",
          sourceGenerationId: f.generationId,
          sourceToLine: 4,
          providerTurnId: decisionCapture.turnId
        })
      ).toBe(true);
      expect((await f.activity.seen(f.owner, f.projectId)).cursor).toBe(
        highWater
      );
      expect(
        await f.managed.resolveActivityDecisions(
          { userId: f.other },
          f.projectId,
          [stored.assertionId!]
        )
      ).toEqual([]);
      await pool.query(
        `update curated_memory_assertions set scope='me', project_id=null
         where id=$1`,
        [stored.assertionId]
      );
      expect(
        await f.managed.resolveActivityDecisions(
          { userId: f.owner },
          f.projectId,
          [stored.assertionId!]
        )
      ).toEqual([]);
    });

    it("never replays an expired pre-send turn and retries once on the same HQ", async () => {
      const f = await setup();
      const actor = { userId: f.owner };
      const command = await f.managed.enqueueManagedConversationCatchUp(
        actor,
        f.input
      );
      expect(command.commandKind).toBe("hq_catch_up");
      expect(
        (await f.managed.enqueueManagedConversationCatchUp(actor, f.input)).id
      ).toBe(command.id);
      await expect(
        f.managed.enqueueManagedConversationCatchUp(
          { userId: f.other },
          f.input
        )
      ).rejects.toThrow();
      const [claimed] = await f.managed.claimManagedConversationCommands({
        ownerUserId: f.owner,
        runnerId: "hq505-runner",
        deploymentId: f.deploymentId,
        deviceId: f.deviceId,
        leaseMs: 60_000
      });
      expect(claimed?.id).toBe(command.id);
      await pool.query(
        `update managed_conversation_commands
          set lease_expires_at=now()-interval '1 second' where id=$1`,
        [command.id]
      );
      expect(
        await f.managed.reconcileAbandonedManagedConversationCommands({
          ownerUserId: f.owner,
          deploymentId: f.deploymentId,
          deviceId: f.deviceId
        })
      ).toBe(1);
      expect(
        (
          await f.managed.inspectProjectHqCatchUp(actor, {
            projectId: f.projectId,
            executionId: f.executionId
          })
        ).disposition
      ).toBe("proven_no_send");
      expect(
        await f.managed.claimManagedConversationCommands({
          ownerUserId: f.owner,
          runnerId: "hq505-runner",
          deploymentId: f.deploymentId,
          deviceId: f.deviceId,
          leaseMs: 60_000
        })
      ).toEqual([]);
      const retryRequestId = randomUUID();
      const restarted = await f.managed.retryProjectHqCatchUp(actor, {
        ...f.input,
        failedCommandId: command.id,
        retryRequestId
      });
      expect(restarted.execution.id).toBe(f.executionId);
      expect(restarted.execution.executionGeneration).toBe(2);
      expect(restarted.command.commandKind).toBe("hq_catch_up");
      expect(
        (
          await f.managed.getProjectHqCatchUpRetry(actor, {
            projectId: f.projectId,
            executionId: f.executionId,
            failedCommandId: command.id,
            retryRequestId
          })
        )?.id
      ).toBe(restarted.command.id);
      expect(
        (
          await f.managed.retryProjectHqCatchUp(actor, {
            ...f.input,
            failedCommandId: command.id,
            retryRequestId
          })
        ).command.id
      ).toBe(restarted.command.id);
      expect(
        (
          await pool.query<{ count: number }>(
            `select count(*)::integer as count from project_hq_conversations
        where project_id=$1 and managed_execution_id=$2`,
            [f.projectId, f.executionId]
          )
        ).rows[0]?.count
      ).toBe(1);
    }, 120_000);

    it("keeps an expired send-started turn in reconciliation without replay or Retry", async () => {
      const f = await setup();
      const actor = { userId: f.owner };
      const command = await f.managed.enqueueManagedConversationCatchUp(
        actor,
        f.input
      );
      const [claimed] = await f.managed.claimManagedConversationCommands({
        ownerUserId: f.owner,
        runnerId: "hq505-uncertain",
        deploymentId: f.deploymentId,
        deviceId: f.deviceId,
        leaseMs: 60_000
      });
      expect(claimed?.id).toBe(command.id);
      expect(
        await f.managed.markManagedConversationCatchUpSendStarted({
          commandId: command.id,
          leaseToken: claimed!.leaseToken!,
          executionGeneration: 1
        })
      ).toBe(true);
      await pool.query(
        `update managed_conversation_commands
          set lease_expires_at=now()-interval '1 second' where id=$1`,
        [command.id]
      );
      expect(
        await f.managed.reconcileAbandonedManagedConversationCommands({
          ownerUserId: f.owner,
          deploymentId: f.deploymentId,
          deviceId: f.deviceId
        })
      ).toBe(1);
      expect(
        (
          await f.managed.inspectProjectHqCatchUp(actor, {
            projectId: f.projectId,
            executionId: f.executionId
          })
        ).disposition
      ).toBe("needs_reconciliation");
      expect(
        await f.managed.recoverProjectHqCatchUp(actor, {
          projectId: f.projectId,
          executionId: f.executionId,
          commandId: command.id
        })
      ).toBe(false);
      await expect(
        f.managed.retryProjectHqCatchUp(actor, {
          ...f.input,
          failedCommandId: command.id,
          retryRequestId: randomUUID()
        })
      ).rejects.toThrow();
      expect(
        await f.managed.claimManagedConversationCommands({
          ownerUserId: f.owner,
          runnerId: "hq505-uncertain",
          deploymentId: f.deploymentId,
          deviceId: f.deviceId,
          leaseMs: 60_000
        })
      ).toEqual([]);
      expect((await f.activity.seen(f.owner, f.projectId)).cursor).toBe(
        f.input.seenCursor
      );
    }, 120_000);

    it("returns a bounded conflict instead of waiting on held Project or Session parents", async () => {
      const f = await setup();
      const actor = { userId: f.owner };
      const holder = await pool.connect();
      try {
        await holder.query("begin");
        await holder.query("select id from projects where id=$1 for update", [
          f.projectId
        ]);
        await expect(
          f.managed.enqueueManagedConversationCatchUp(actor, f.input)
        ).rejects.toMatchObject({ statusCode: 409 });
        await holder.query("rollback");
        await holder.query("begin");
        await holder.query("select id from sessions where id=$1 for update", [
          f.sessionId
        ]);
        await expect(
          f.managed.enqueueManagedConversationCatchUp(actor, f.input)
        ).rejects.toMatchObject({ statusCode: 409 });
        await holder.query("rollback");
        expect(
          (await f.managed.enqueueManagedConversationCatchUp(actor, f.input))
            .commandKind
        ).toBe("hq_catch_up");
      } finally {
        await holder.query("rollback").catch(() => undefined);
        holder.release();
      }
    }, 120_000);

    it("acks only the exact persisted Codex assistant turn and rejects changed capture identity", async () => {
      const f = await setup();
      const actor = { userId: f.owner };
      const command = await f.managed.enqueueManagedConversationCatchUp(
        actor,
        f.input
      );
      const [claimed] = await f.managed.claimManagedConversationCommands({
        ownerUserId: f.owner,
        runnerId: "hq505-terminal",
        deploymentId: f.deploymentId,
        deviceId: f.deviceId,
        leaseMs: 60_000
      });
      expect(claimed?.id).toBe(command.id);
      expect(claimed?.clientUserMessageId).toBeTruthy();
      expect(
        await f.managed.markManagedConversationCatchUpSendStarted({
          commandId: command.id,
          leaseToken: claimed!.leaseToken!,
          executionGeneration: 1
        })
      ).toBe(true);
      const capture = await persistProviderTurn(f, command, "codex");
      const input = {
        commandId: command.id,
        leaseToken: claimed!.leaseToken!,
        localSessionId: f.sessionId,
        sourceKind: "codex" as const,
        externalSessionId: "provider-thread",
        sourceGenerationId: f.generationId,
        sourceToLine: 4,
        providerTurnId: capture.turnId
      };
      expect(
        await f.managed.completeManagedConversationCatchUp({
          ...input,
          sourceGenerationId: randomUUID()
        })
      ).toBe(false);
      expect((await f.activity.seen(f.owner, f.projectId)).cursor).toBe(
        f.input.seenCursor
      );
      await expect(
        f.managed.completeManagedConversationCatchUp({
          ...input,
          providerTurnId: randomUUID()
        })
      ).rejects.toThrow();
      expect((await f.activity.seen(f.owner, f.projectId)).cursor).toBe(
        f.input.seenCursor
      );
      expect(await f.managed.completeManagedConversationCatchUp(input)).toBe(
        true
      );
      expect((await f.activity.seen(f.owner, f.projectId)).cursor).toBe(
        f.input.highWater
      );
      expect(
        (
          await f.managed.inspectProjectHqCatchUp(actor, {
            projectId: f.projectId,
            executionId: f.executionId
          })
        ).command?.state
      ).toBe("completed");
    }, 120_000);

    it("retains a Team-only welcome receipt until a persisted HQ reply and exact acknowledgment", async () => {
      const f = await setup();
      const teamProjectId = randomUUID();
      const teamPrincipalUserId = randomUUID();
      const backendId = `team-${randomUUID()}`;
      await pool.query(
        `update projects set team_backend_id=$3,team_workspace_id=$4,
             workspace_project_id=$5 where id=$1 and owner_user_id=$2`,
        [f.projectId, f.owner, backendId, randomUUID(), teamProjectId]
      );
      await pool.query(
        `insert into personal_workspace_project_principal_bindings
           (local_user_id,team_backend_id,team_principal_user_id,
            local_credential_key_id,team_credential_key_id)
         values($1,$2,$3,'local-key','team-key')`,
        [f.owner, backendId, teamPrincipalUserId]
      );
      const teamWindow = {
        teamBackendId: backendId,
        workspaceProjectId: teamProjectId,
        teamPrincipalUserId,
        memberId: randomUUID(),
        projectVersion: 3,
        memberVersion: 1,
        seenCursor: "member-bound:0",
        highCursor: "member-bound:0",
        welcomeDue: true,
        events: []
      };
      const input = {
        ...f.input,
        highWater: f.input.seenCursor,
        events: [],
        teamWindow,
        inputDigest: createHash("sha256")
          .update(
            JSON.stringify({
              ownerUserId: f.owner,
              projectId: f.projectId,
              seenCursor: f.input.seenCursor,
              highWater: f.input.seenCursor,
              events: [],
              teamWindow
            })
          )
          .digest("hex")
      };
      await pool.query(
        `update personal_workspace_project_principal_bindings
            set team_principal_user_id=$3
          where local_user_id=$1 and team_backend_id=$2`,
        [f.owner, backendId, randomUUID()]
      );
      await expect(
        f.managed.enqueueManagedConversationCatchUp({ userId: f.owner }, input)
      ).rejects.toThrow(/principal changed/);
      await pool.query(
        `update personal_workspace_project_principal_bindings
            set team_principal_user_id=$3
          where local_user_id=$1 and team_backend_id=$2`,
        [f.owner, backendId, teamPrincipalUserId]
      );
      const command = await f.managed.enqueueManagedConversationCatchUp(
        { userId: f.owner },
        input
      );
      expect(command.payload?.teamWindow).toEqual(teamWindow);
      expect(
        await f.managed.pendingProjectHqTeamAck(
          { userId: f.owner },
          { projectId: f.projectId, executionId: f.executionId }
        )
      ).toBeNull();
      const [claimed] = await f.managed.claimManagedConversationCommands({
        ownerUserId: f.owner,
        runnerId: "hq505-team-welcome",
        deploymentId: f.deploymentId,
        deviceId: f.deviceId,
        leaseMs: 60_000
      });
      expect(claimed?.id).toBe(command.id);
      const capture = await persistProviderTurn(f, command, "codex");
      expect(
        await f.managed.completeManagedConversationCatchUp({
          commandId: command.id,
          leaseToken: claimed!.leaseToken!,
          localSessionId: f.sessionId,
          sourceKind: "codex",
          externalSessionId: "provider-thread",
          sourceGenerationId: f.generationId,
          sourceToLine: 4,
          providerTurnId: capture.turnId
        })
      ).toBe(true);
      expect(
        await f.managed.pendingProjectHqTeamAck(
          { userId: f.owner },
          { projectId: f.projectId, executionId: f.executionId }
        )
      ).toEqual({ commandId: command.id, teamWindow });
      expect(
        await f.managed.markProjectHqTeamAck(
          { userId: f.owner },
          {
            projectId: f.projectId,
            executionId: f.executionId,
            commandId: command.id,
            teamWindow: { ...teamWindow, memberId: randomUUID() }
          }
        )
      ).toBe(false);
      expect(
        await f.managed.markProjectHqTeamAck(
          { userId: f.owner },
          {
            projectId: f.projectId,
            executionId: f.executionId,
            commandId: command.id,
            teamWindow
          }
        )
      ).toBe(true);
      expect(
        await f.managed.pendingProjectHqTeamAck(
          { userId: f.owner },
          { projectId: f.projectId, executionId: f.executionId }
        )
      ).toBeNull();
      expect((await f.activity.seen(f.owner, f.projectId)).cursor).toBe(
        f.input.seenCursor
      );
    }, 120_000);

    it.each([
      ["claude", "claude-code"],
      ["pi", "pi"]
    ] as const)(
      "acks a verified %s assistant only after projection",
      async (provider, sourceKind) => {
        const f = await setup(provider);
        const command = await f.managed.enqueueManagedConversationCatchUp(
          { userId: f.owner },
          f.input
        );
        const [claimed] = await f.managed.claimManagedConversationCommands({
          ownerUserId: f.owner,
          runnerId: `hq505-${provider}`,
          deploymentId: f.deploymentId,
          deviceId: f.deviceId,
          leaseMs: 60_000
        });
        expect(claimed?.id).toBe(command.id);
        const capture = await persistProviderTurn(f, command, sourceKind, {
          assistant: false
        });
        const input = {
          commandId: command.id,
          leaseToken: claimed!.leaseToken!,
          localSessionId: f.sessionId,
          sourceKind,
          externalSessionId: "provider-thread",
          sourceGenerationId: f.generationId,
          sourceToLine: 4,
          providerTurnId: provider === "pi" ? null : capture.turnId
        };
        await expect(
          f.managed.completeManagedConversationCatchUp(input)
        ).rejects.toThrow(/reply is not persisted/);
        expect((await f.activity.seen(f.owner, f.projectId)).cursor).toBe(
          f.input.seenCursor
        );
        const assistantKey = randomUUID();
        await pool.query(
          `insert into conversation_items
       (owner_user_id,session_id,source_kind,source_adapter_version,
        source_transport,external_session_id,external_turn_id,
        source_record_type,source_event_type,source_line_number,
        source_fingerprint,raw_json,source_hash,idempotency_key,
        canonical_item_key,projection_status,metadata)
       values($1,$2,$3,'test-v1','local','provider-thread',$4,
        'message','assistant_message',2,$5,'{}'::jsonb,$6,$7,$8,
        'projected',$9::jsonb)`,
          [
            f.owner,
            f.sessionId,
            sourceKind,
            capture.turnId,
            "b".repeat(64),
            randomUUID(),
            randomUUID(),
            assistantKey,
            JSON.stringify({ canonicalConversationItemKey: assistantKey })
          ]
        );
        await pool.query(
          `insert into messages
       (session_id,owner_user_id,visibility,role,content,source_runtime,
        capture_method,idempotency_key)
       values($1,$2,'personal','assistant','Persisted reply',$3,'api',$4)`,
          [f.sessionId, f.owner, sourceKind, `message:${assistantKey}`]
        );
        expect(await f.managed.completeManagedConversationCatchUp(input)).toBe(
          true
        );
        expect((await f.activity.seen(f.owner, f.projectId)).cursor).toBe(
          f.input.highWater
        );
      },
      120_000
    );

    it("recovers an uncertain send from its captured assistant without replay", async () => {
      const f = await setup();
      const actor = { userId: f.owner };
      const command = await f.managed.enqueueManagedConversationCatchUp(
        actor,
        f.input
      );
      const [claimed] = await f.managed.claimManagedConversationCommands({
        ownerUserId: f.owner,
        runnerId: "hq505-recovery",
        deploymentId: f.deploymentId,
        deviceId: f.deviceId,
        leaseMs: 60_000
      });
      expect(claimed?.id).toBe(command.id);
      expect(
        await f.managed.markManagedConversationCatchUpSendStarted({
          commandId: command.id,
          leaseToken: claimed!.leaseToken!,
          executionGeneration: 1
        })
      ).toBe(true);
      const capture = await persistProviderTurn(f, command, "codex");
      await pool.query(
        `update managed_conversation_commands
          set lease_expires_at=now()-interval '1 second' where id=$1`,
        [command.id]
      );
      await pool.query(
        `update managed_conversation_executions
          set runner_lease_expires_at=now()-interval '1 second' where id=$1`,
        [f.executionId]
      );
      expect(
        await f.managed.reconcileAbandonedManagedConversationCommands({
          ownerUserId: f.owner,
          deploymentId: f.deploymentId,
          deviceId: f.deviceId
        })
      ).toBe(1);
      await expect(
        f.managed.recoverProjectHqCatchUp(
          { userId: f.other },
          {
            projectId: f.projectId,
            executionId: f.executionId,
            commandId: command.id
          }
        )
      ).rejects.toThrow();
      expect((await f.activity.seen(f.owner, f.projectId)).cursor).toBe(
        f.input.seenCursor
      );
      expect(
        await f.managed.recoverProjectHqCatchUp(actor, {
          projectId: f.projectId,
          executionId: f.executionId,
          commandId: command.id
        })
      ).toBe(true);
      expect((await f.activity.seen(f.owner, f.projectId)).cursor).toBe(
        f.input.highWater
      );
      expect(
        await f.managed.recoverProjectHqCatchUp(actor, {
          projectId: f.projectId,
          executionId: f.executionId,
          commandId: command.id
        })
      ).toBe(true);
      expect(
        (
          await pool.query<{ turn_id: string }>(
            `select result->>'turnId' as turn_id from managed_conversation_commands where id=$1`,
            [command.id]
          )
        ).rows[0]?.turn_id
      ).toBe(capture.turnId);
      expect(
        await f.managed.claimManagedConversationCommands({
          ownerUserId: f.owner,
          runnerId: "hq505-recovery",
          deploymentId: f.deploymentId,
          deviceId: f.deviceId,
          leaseMs: 60_000
        })
      ).toEqual([]);
    }, 120_000);

    it("does not acknowledge a reply when its cited Source changed after enqueue", async () => {
      const f = await setup();
      const command = await f.managed.enqueueManagedConversationCatchUp(
        { userId: f.owner },
        f.input
      );
      const [claimed] = await f.managed.claimManagedConversationCommands({
        ownerUserId: f.owner,
        runnerId: "hq505-source-fence",
        deploymentId: f.deploymentId,
        deviceId: f.deviceId,
        leaseMs: 60_000
      });
      const capture = await persistProviderTurn(f, command, "codex");
      await pool.query(
        `update project_sources set name='Renamed after send'
        where owner_user_id=$1 and id=$2`,
        [f.owner, f.input.events[0]!.sourceId]
      );
      await expect(
        f.managed.completeManagedConversationCatchUp({
          commandId: command.id,
          leaseToken: claimed!.leaseToken!,
          localSessionId: f.sessionId,
          sourceKind: "codex",
          externalSessionId: "provider-thread",
          sourceGenerationId: f.generationId,
          sourceToLine: 4,
          providerTurnId: capture.turnId
        })
      ).rejects.toThrow(/Source changed/);
      expect((await f.activity.seen(f.owner, f.projectId)).cursor).toBe(
        f.input.seenCursor
      );
    }, 120_000);

    it("does not treat an unrelated raw User marker as its trusted origin", async () => {
      const f = await setup();
      const command = await f.managed.enqueueManagedConversationCatchUp(
        { userId: f.owner },
        f.input
      );
      const [claimed] = await f.managed.claimManagedConversationCommands({
        ownerUserId: f.owner,
        runnerId: "hq505-origin-fence",
        deploymentId: f.deploymentId,
        deviceId: f.deviceId,
        leaseMs: 60_000
      });
      const capture = await persistProviderTurn(f, command, "codex", {
        originCommandId: randomUUID()
      });
      await expect(
        f.managed.completeManagedConversationCatchUp({
          commandId: command.id,
          leaseToken: claimed!.leaseToken!,
          localSessionId: f.sessionId,
          sourceKind: "codex",
          externalSessionId: "provider-thread",
          sourceGenerationId: f.generationId,
          sourceToLine: 4,
          providerTurnId: capture.turnId
        })
      ).rejects.toThrow(/origin is unverified/);
      expect((await f.activity.seen(f.owner, f.projectId)).cursor).toBe(
        f.input.seenCursor
      );
    }, 120_000);

    it.each([
      ["claude", "claude-code"],
      ["pi", "pi"]
    ] as const)(
      "binds %s journal bytes before projecting and acknowledging",
      async (provider, sourceKind) => {
        const f = await setup(provider);
        const actor = { userId: f.owner };
        const command = await f.managed.enqueueManagedConversationCatchUp(
          actor,
          f.input
        );
        const [claimed] = await f.managed.claimManagedConversationCommands({
          ownerUserId: f.owner,
          runnerId: `hq505-native-${provider}`,
          deploymentId: f.deploymentId,
          deviceId: f.deviceId,
          leaseMs: 60_000
        });
        expect(claimed?.id).toBe(command.id);
        const timestamp = new Date().toISOString();
        const entries =
          provider === "pi"
            ? [
                {
                  type: "session",
                  version: 3,
                  id: "provider-thread",
                  cwd: "/private/hq"
                },
                {
                  type: "message",
                  id: "user",
                  parentId: null,
                  timestamp,
                  message: {
                    role: "user",
                    content: [{ type: "text", text: f.input.prompt }]
                  }
                },
                {
                  type: "message",
                  id: "answer",
                  parentId: "user",
                  timestamp,
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Verified update" }],
                    stopReason: "stop"
                  }
                }
              ]
            : [
                {
                  type: "user",
                  uuid: "user",
                  sessionId: "provider-thread",
                  timestamp,
                  message: {
                    role: "user",
                    content: [{ type: "text", text: f.input.prompt }]
                  }
                },
                {
                  type: "assistant",
                  uuid: "answer",
                  sessionId: "provider-thread",
                  timestamp,
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Verified update" }],
                    stop_reason: "end_turn"
                  }
                }
              ];
        const bytes = Buffer.from(
          entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
        );
        const fingerprint = "c".repeat(64);
        const artifact = await f.managed.ensureConversationSourceArtifact(
          actor,
          {
            sessionId: f.sessionId,
            logicalSourceId: randomUUID(),
            sourceGenerationId: f.generationId,
            replicaRole: "origin_local",
            sourceKind,
            sourceRuntime: sourceKind,
            externalSessionId: "provider-thread",
            sourceFingerprint: fingerprint,
            artifactFormat:
              provider === "pi" ? "pi_session_jsonl" : "claude_session_jsonl",
            artifactFormatVersion: 1,
            sourceAdapterVersion:
              provider === "pi" ? "pi-session-v1" : "claude-code-transcript-v1",
            journalStartOffset: 0,
            journalStartLine: 0,
            liveStartOffset: 0,
            liveStartLine: 0,
            currentSourceLength: bytes.length,
            sourceCreatedAt: timestamp,
            storageProvider: "filesystem",
            storagePrefix: randomUUID(),
            originDeploymentId: f.deploymentId,
            originDeviceId: f.deviceId,
            originKeyId: "hq505-test-key",
            originPublicKey: Buffer.alloc(32, 7).toString("base64url"),
            redactedSourceLabel: "HQ catch-up fixture"
          }
        );
        await pool.query(
          `update conversation_source_artifacts set provider_cursor_offset=$2,
         provider_cursor_line=$3 where id=$1`,
          [artifact.id, bytes.length, entries.length]
        );
        const parsed =
          provider === "pi"
            ? parsePiSessionJournalBytes({
                bytes,
                absoluteStartOffset: 0,
                lineIndexOffset: 0,
                sessionId: f.sessionId,
                externalSessionId: "provider-thread",
                sourceFingerprint: fingerprint
              }).items
            : parseClaudeTranscriptJournalBytes({
                bytes,
                absoluteStartOffset: 0,
                lineIndexOffset: 0,
                sessionId: f.sessionId,
                externalSessionId: "provider-thread",
                sourceFingerprint: fingerprint
              }).items;
        const ingested = await f.managed.createConversationItems(actor, {
          items: [
            ...parsed.filter((item) => item.projectionStatus === "pending"),
            ...(provider === "claude"
              ? [
                  turnBoundaryControl({
                    signal: {
                      sourceSessionId: "provider-thread",
                      transcriptPath: "/private/hq/transcript.jsonl",
                      cwd: "/private/hq"
                    },
                    capturedSessionId: f.sessionId,
                    externalTurnId: "user",
                    frontierOffset: bytes.length,
                    frontierLine: entries.length,
                    sourceSequence: entries.length * 1000 + 999
                  })
                ]
              : [])
          ].map((item) => ({
            ...item,
            sourceFingerprint: fingerprint,
            projectionStatus: "pending" as const
          }))
        });
        const userItem = parsed.find(
          (item) => item.sourceEventType === "user_message"
        );
        expect(userItem?.rawText).toBe(f.input.prompt);
        const capturedUser = async () =>
          (
            await pool.query<{
              projection_status: string;
              metadata: Record<string, unknown>;
            }>(
              `select projection_status,metadata from conversation_items
              where owner_user_id=$1 and session_id=$2
                and source_event_type='user_message'`,
              [f.owner, f.sessionId]
            )
          ).rows[0];
        expect((await capturedUser())?.projection_status).toBe("held");
        expect(
          (await capturedUser())?.metadata.managedKoedCatchUpCommandId
        ).toBeUndefined();
        const binder = createManagedMemoryActionRepository(pool, f.provider);
        const binding = {
          commandId: command.id,
          executionId: f.executionId,
          executionGeneration: 1,
          leaseToken: claimed!.leaseToken!,
          localSessionId: f.sessionId,
          clientUserMessageId: command.clientUserMessageId!,
          sourceKind,
          externalSessionId: "provider-thread",
          sourceGenerationId: f.generationId,
          fromLine: userItem!.sourceLineNumber!,
          toLine: entries.length,
          providerPrompt: f.input.prompt
        };
        expect(
          await binder.bindManagedMemoryActionUserSource(actor, {
            ...binding,
            fromLine: userItem!.sourceLineNumber! + 1
          })
        ).toBeNull();
        expect(
          await binder.bindManagedMemoryActionUserSource(actor, {
            ...binding,
            sourceGenerationId: randomUUID()
          })
        ).toBeNull();
        expect(
          await binder.bindManagedMemoryActionUserSource(actor, {
            ...binding,
            leaseToken: randomUUID()
          })
        ).toBeNull();
        expect(
          await binder.bindManagedMemoryActionUserSource(actor, binding)
        ).toBeTruthy();
        expect(await capturedUser()).toMatchObject({
          projection_status: "raw_only",
          metadata: { managedKoedCatchUpCommandId: command.id }
        });
        const proof = verifyManagedJournalTerminal({
          artifact: { ...artifact, providerCursorOffset: bytes.length },
          sourceOffset: bytes.length,
          bytes
        });
        const released = await f.managed.releaseConversationProjectionHold(
          actor,
          {
            sessionId: f.sessionId,
            externalTurnId: "journal",
            verifiedJournal: proof
          }
        );
        expect(released.conversationItemIds.length).toBeGreaterThan(0);
        expect(ingested.length).toBeGreaterThan(0);
        await f.managed.projectPendingConversationItems(actor, { limit: 100 });
        expect(
          await f.managed.completeManagedConversationCatchUp({
            commandId: command.id,
            leaseToken: claimed!.leaseToken!,
            localSessionId: f.sessionId,
            sourceKind,
            externalSessionId: "provider-thread",
            sourceGenerationId: f.generationId,
            sourceToLine: entries.length,
            providerTurnId: null
          })
        ).toBe(true);
        expect((await f.activity.seen(f.owner, f.projectId)).cursor).toBe(
          f.input.highWater
        );
        await f.managed.projectPendingConversationItems(actor, { limit: 100 });
        expect(
          (
            await pool.query(
              `select role,count(*)::integer as count from messages
        where session_id=$1 and owner_user_id=$2 group by role`,
              [f.sessionId, f.owner]
            )
          ).rows
        ).toEqual([{ role: "assistant", count: 1 }]);
      },
      120_000
    );

    it("recognizes a Codex journal origin through trusted ingestion, then projects the reply", async () => {
      const f = await setup();
      const actor = { userId: f.owner };
      const command = await f.managed.enqueueManagedConversationCatchUp(
        actor,
        f.input
      );
      const [claimed] = await f.managed.claimManagedConversationCommands({
        ownerUserId: f.owner,
        runnerId: "hq505-codex-journal",
        deploymentId: f.deploymentId,
        deviceId: f.deviceId,
        leaseMs: 60_000
      });
      expect(claimed?.id).toBe(command.id);
      const turnId = randomUUID();
      const timestamp = new Date().toISOString();
      const entries = [
        { timestamp, type: "session_meta", payload: { id: "provider-thread" } },
        {
          timestamp,
          type: "event_msg",
          payload: { type: "task_started", turn_id: turnId }
        },
        {
          timestamp,
          type: "event_msg",
          payload: {
            type: "user_message",
            client_id: `koed-user-message:${command.clientUserMessageId}`,
            message: f.input.prompt
          }
        },
        {
          timestamp,
          type: "event_msg",
          payload: {
            type: "item_completed",
            thread_id: "provider-thread",
            turn_id: turnId,
            item: {
              id: "answer",
              type: "AgentMessage",
              content: [{ type: "Text", text: "Verified update" }]
            }
          }
        },
        {
          timestamp,
          type: "event_msg",
          payload: { type: "task_complete", turn_id: turnId }
        }
      ];
      const bytes = Buffer.from(
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
      );
      const fingerprint = "d".repeat(64);
      await f.managed.ensureConversationSourceArtifact(actor, {
        sessionId: f.sessionId,
        logicalSourceId: randomUUID(),
        sourceGenerationId: f.generationId,
        replicaRole: "origin_local",
        sourceKind: "codex",
        sourceRuntime: "codex",
        externalSessionId: "provider-thread",
        sourceFingerprint: fingerprint,
        artifactFormat: "codex_rollout_jsonl",
        artifactFormatVersion: 1,
        sourceAdapterVersion: "codex-transcript-v1",
        journalStartOffset: 0,
        journalStartLine: 0,
        liveStartOffset: 0,
        liveStartLine: 0,
        currentSourceLength: bytes.length,
        sourceCreatedAt: timestamp,
        storageProvider: "filesystem",
        storagePrefix: randomUUID(),
        originDeploymentId: f.deploymentId,
        originDeviceId: f.deviceId,
        originKeyId: "hq505-test-key",
        originPublicKey: Buffer.alloc(32, 7).toString("base64url"),
        redactedSourceLabel: "HQ catch-up Codex fixture"
      });
      const journal = parseTranscriptJournalBytes({
        bytes,
        absoluteStartOffset: 0,
        lineIndexOffset: 0
      });
      const parsed = buildCodexTranscriptConversationItems({
        records: journal.records,
        sessionId: f.sessionId,
        sourceSessionId: "provider-thread",
        sourceTransport: "transcript",
        sourceFingerprint: fingerprint,
        threadKind: "conversation"
      });
      expect(
        parsed.find((item) => item.sourceEventType === "user_message")
          ?.canonicalStableItemId
      ).toBe(`koed-user-message:${command.clientUserMessageId}`);
      await f.managed.createConversationItems(actor, {
        items: parsed.map((item) => ({
          ...item,
          sourceFingerprint: fingerprint,
          projectionStatus: item.projectionStatus as "pending" | "raw_only"
        }))
      });
      const origin = await pool.query<{
        projection_status: string;
        metadata: Record<string, unknown>;
      }>(
        `select projection_status,metadata from conversation_items
        where owner_user_id=$1 and session_id=$2 and canonical_stable_item_id=$3`,
        [
          f.owner,
          f.sessionId,
          `koed-user-message:${command.clientUserMessageId}`
        ]
      );
      expect(origin.rows).toHaveLength(1);
      expect(origin.rows[0]).toMatchObject({
        projection_status: "raw_only",
        metadata: { managedKoedCatchUpCommandId: command.id }
      });
      await f.managed.releaseConversationProjectionHold(actor, {
        sessionId: f.sessionId,
        externalTurnId: turnId
      });
      await f.managed.projectPendingConversationItems(actor, { limit: 100 });
      expect(
        await f.managed.completeManagedConversationCatchUp({
          commandId: command.id,
          leaseToken: claimed!.leaseToken!,
          localSessionId: f.sessionId,
          sourceKind: "codex",
          externalSessionId: "provider-thread",
          sourceGenerationId: f.generationId,
          sourceToLine: entries.length,
          providerTurnId: turnId
        })
      ).toBe(true);
      expect((await f.activity.seen(f.owner, f.projectId)).cursor).toBe(
        f.input.highWater
      );
      await f.managed.projectPendingConversationItems(actor, { limit: 100 });
      expect(
        (
          await pool.query(
            `select role,count(*)::integer as count from messages
        where session_id=$1 and owner_user_id=$2 group by role`,
            [f.sessionId, f.owner]
          )
        ).rows
      ).toEqual([{ role: "assistant", count: 1 }]);
    }, 120_000);

    it("strips a supplied Koed-origin marker and keeps literal human text ordinary", async () => {
      const f = await setup();
      const actor = { userId: f.owner };
      const command = await f.managed.enqueueManagedConversationCatchUp(
        actor,
        f.input
      );
      const [claimed] = await f.managed.claimManagedConversationCommands({
        ownerUserId: f.owner,
        runnerId: "hq505-human-marker",
        deploymentId: f.deploymentId,
        deviceId: f.deviceId,
        leaseMs: 60_000
      });
      expect(claimed?.id).toBe(command.id);
      await f.managed.createConversationItems(actor, {
        items: [
          {
            sessionId: f.sessionId,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "transcript",
            externalSessionId: "provider-thread",
            externalThreadId: "provider-thread",
            externalTurnId: randomUUID(),
            canonicalStableItemId: "human-user-1",
            sourceRecordType: "event_msg",
            sourceEventType: "user_message",
            sourceLineNumber: 0,
            sourceSequence: 0,
            rawJson: {
              type: "event_msg",
              payload: {
                type: "user_message",
                message: `koed-user-message:${command.clientUserMessageId}`
              }
            },
            rawText: `koed-user-message:${command.clientUserMessageId}`,
            sourceHash: randomUUID(),
            idempotencyKey: randomUUID(),
            metadata: {
              transcriptType: "user_message",
              managedKoedCatchUpCommandId: command.id
            }
          }
        ]
      });
      const rows = await pool.query<{
        projection_status: string;
        metadata: Record<string, unknown>;
      }>(
        `select projection_status,metadata from conversation_items
        where owner_user_id=$1 and session_id=$2
          and canonical_stable_item_id='human-user-1'`,
        [f.owner, f.sessionId]
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.projection_status).not.toBe("raw_only");
      expect(
        rows.rows[0]!.metadata.managedKoedCatchUpCommandId
      ).toBeUndefined();
      expect((await f.activity.seen(f.owner, f.projectId)).cursor).toBe(
        f.input.seenCursor
      );
    }, 120_000);
  }
);
