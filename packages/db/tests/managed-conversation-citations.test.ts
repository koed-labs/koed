import { randomBytes, randomUUID } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";
import { createMemoryQuestionRepository } from "../src/memory-question-repository.js";
import { createManagedConversationCitationRepository } from "../src/managed-conversation-citation-repository.js";

const databaseUrl = process.env.HQ306_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  "managed Conversation citation persistence",
  () => {
    let pool: pg.Pool;
    const encryptionProvider = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64url")
    );
    const options = { envelopeEncryptionProvider: encryptionProvider };
    beforeAll(async () => {
      pool = createDbPool({ connectionString: databaseUrl });
      await runDbMigrations(pool);
    });
    afterAll(async () => {
      await pool.end();
    });

    it("binds two trusted recalls to one durable turn and reloads after transient output deletion", async () => {
      const repository = createMemorySourceRepository(pool, options);
      const questions = createMemoryQuestionRepository(pool, options);
      const citations = createManagedConversationCitationRepository(
        pool,
        options
      );
      const owner = await repository.createUser({
        email: `hq306-${randomUUID()}@example.test`
      });
      const stranger = await repository.createUser({
        email: `hq306-other-${randomUUID()}@example.test`
      });
      const actor = { userId: owner.id };
      const executionId = randomUUID();
      const logicalSessionId = randomUUID();
      const sessionId = randomUUID();
      const deploymentId = randomUUID();
      const deviceId = randomUUID();
      const runnerId = randomUUID();
      const commandId = randomUUID();
      const leaseToken = randomUUID();
      const sourceDeploymentId = randomUUID();
      const turnId = `turn-${randomUUID()}`;
      const recalled: Array<{
        id: string;
        receiptId: string;
        source: Record<string, string>;
        alias: string;
      }> = [];
      try {
        await pool.query(
          `insert into sessions(id,logical_session_id,owner_user_id,source_runtime,capture_method)
         values($1,$2,$3,'codex','api')`,
          [sessionId, logicalSessionId, owner.id]
        );
        await pool.query(
          `insert into managed_conversation_executions
          (id,owner_user_id,project_id,ai_client_instance_id,model,permission_mode,runner_kind,state,
           fencing_token_hash,runner_deployment_id,runner_device_id,runner_id,runner_lease_expires_at,logical_session_id,provider_thread_id)
         values ($1,$2,'/fixture','codex','test','auto','local_device','running',$3,$4,$5,$6,now()+interval '1 hour',$7,'provider-thread')`,
          [
            executionId,
            owner.id,
            "a".repeat(64),
            deploymentId,
            deviceId,
            runnerId,
            logicalSessionId
          ]
        );
        await pool.query(
          `insert into managed_conversation_commands
          (id,owner_user_id,execution_id,idempotency_key,sequence,command_kind,
           request_digest,execution_generation,encrypted_payload,state,lease_token,lease_expires_at)
         values ($1,$2,$3,$4,1,'start',$5,1,'{}'::jsonb,'dispatching',$6,now()+interval '1 hour')`,
          [
            commandId,
            owner.id,
            executionId,
            randomUUID(),
            "c".repeat(64),
            leaseToken
          ]
        );
        for (let ordinal = 0; ordinal < 2; ordinal++) {
          const sourceId = randomUUID();
          const source = {
            sourceType: "memory_node",
            sourceId,
            visibility: "personal",
            title: `Source ${ordinal + 1}`
          };
          const question = await questions.createFinalMemoryQuestion(actor, {
            idempotencyKey: `hq306-${randomUUID()}`,
            query: `Recall ${ordinal + 1}`,
            searchDomain: "global",
            status: "answered",
            answerMarkdown: `Answer ${ordinal + 1}`,
            citations: [source],
            evidence: [{ sourceId, summaryText: `Evidence ${ordinal + 1}` }]
          });
          const receiptId = randomUUID();
          const alias = `r${receiptId.replaceAll("-", "")}c1`;
          recalled.push({ id: question.id, receiptId, source, alias });
          const recorded =
            await citations.recordManagedConversationToolCitations(actor, {
              executionId,
              executionGeneration: 1,
              commandId,
              leaseToken,
              providerTurnId: turnId,
              toolCallId: `call-${ordinal + 1}`,
              questionId: question.id,
              receiptId,
              observedCitations: [{ ...source, citationId: alias }],
              verifiedPersonalSources: [
                {
                  sourceType: "memory_node",
                  sourceId,
                  sourceDeploymentId,
                  sourceOwnerPrincipalId: owner.id,
                  title: `Source ${ordinal + 1}`,
                  summary: `Evidence ${ordinal + 1}`
                }
              ]
            });
          expect(recorded).toHaveLength(ordinal + 1);
        }
        await expect(
          citations.recordManagedConversationToolCitations(actor, {
            executionId,
            executionGeneration: 1,
            commandId,
            leaseToken,
            providerTurnId: turnId,
            toolCallId: "call-3",
            questionId: recalled[0]!.id,
            receiptId: recalled[0]!.receiptId,
            observedCitations: [
              { ...recalled[0]!.source, citationId: recalled[0]!.alias }
            ],
            verifiedPersonalSources: [
              {
                sourceType: "memory_node",
                sourceId: recalled[0]!.source.sourceId!,
                sourceDeploymentId,
                sourceOwnerPrincipalId: owner.id,
                title: "Source 1",
                summary: "Evidence 1"
              }
            ]
          })
        ).rejects.toThrow("immutable alias");
        await expect(
          citations.recordManagedConversationToolCitations(actor, {
            executionId,
            executionGeneration: 1,
            commandId,
            leaseToken,
            providerTurnId: turnId,
            toolCallId: "call-1",
            questionId: recalled[1]!.id,
            receiptId: recalled[1]!.receiptId,
            observedCitations: [
              { ...recalled[1]!.source, citationId: recalled[1]!.alias }
            ],
            verifiedPersonalSources: [
              {
                sourceType: "memory_node",
                sourceId: recalled[1]!.source.sourceId!,
                sourceDeploymentId,
                sourceOwnerPrincipalId: owner.id,
                title: "Source 2",
                summary: "Evidence 2"
              }
            ]
          })
        ).rejects.toThrow("immutable alias");
        const pending = await pool.query<{
          source_generation_id: string | null;
        }>(
          "select source_generation_id from managed_conversation_turn_citations where execution_id=$1",
          [executionId]
        );
        expect(
          pending.rows.every((row) => row.source_generation_id === null)
        ).toBe(true);
        const sourceGenerationId = randomUUID();
        await repository.bindManagedConversationSourceGeneration(actor, {
          executionId,
          executionGeneration: 1,
          runnerId,
          sourceGenerationId,
          providerTurnId: turnId
        });
        const bound = await pool.query<{ source_generation_id: string | null }>(
          "select source_generation_id from managed_conversation_turn_citations where execution_id=$1",
          [executionId]
        );
        expect(bound.rows).toHaveLength(2);
        expect(
          bound.rows.every(
            (row) => row.source_generation_id === sourceGenerationId
          )
        ).toBe(true);
        await pool.query(
          `insert into managed_conversation_runtime_items
          (owner_user_id,execution_id,execution_generation,provider_request_id,provider_turn_id,item_kind,state,request_digest,encrypted_payload,resolved_at)
         values ($1,$2,1,'transient', $3,'transient_output','resolved',$4,'{}'::jsonb,now())`,
          [owner.id, executionId, turnId, "b".repeat(64)]
        );
        await pool.query(
          "delete from managed_conversation_runtime_items where execution_id=$1",
          [executionId]
        );
        const reloaded = createManagedConversationCitationRepository(
          pool,
          options
        );
        const list = await reloaded.listManagedConversationTurnCitations(
          actor,
          { executionId, providerTurnId: turnId }
        );
        expect(list.map((item) => item.title)).toEqual([
          "Source 1",
          "Source 2"
        ]);
        expect(list.map((item) => item.summary)).toEqual([
          "Evidence 1",
          "Evidence 2"
        ]);
        // Claude and Pi captured history may contain the model-visible tag but
        // omit the worker's provider turn id after transient output deletion.
        const capturedAnswer = `A supported claim [m:${recalled[1]!.alias}].`;
        const capturedAliases = [
          ...capturedAnswer.matchAll(/\[m:([^\]]+)\]/g)
        ].map((match) => match[1]!);
        expect(
          (
            await reloaded.listManagedConversationCitationsByAliases(actor, {
              executionId,
              aliases: capturedAliases
            })
          ).map((item) => item.alias)
        ).toEqual([recalled[1]!.alias]);
        expect(
          await reloaded.listManagedConversationCitationsByAliases(actor, {
            executionId,
            aliases: ["r00000000000000000000000000000000c1"]
          })
        ).toEqual([]);
        expect(
          await reloaded.getManagedConversationCitationLocator(actor, {
            executionId,
            providerTurnId: turnId,
            alias: "rforgedc1"
          })
        ).toBeNull();
        expect(
          await reloaded.listManagedConversationTurnCitations(
            { userId: stranger.id },
            { executionId, providerTurnId: turnId }
          )
        ).toEqual([]);
        const raw = await pool.query<{ encrypted_detail: string }>(
          "select encrypted_detail::text from managed_conversation_turn_citations where execution_id=$1",
          [executionId]
        );
        expect(
          raw.rows.every((row) => !row.encrypted_detail.includes("Evidence"))
        ).toBe(true);
        const rows = await pool.query<{
          id: string;
          encrypted_detail: Record<string, unknown>;
        }>(
          "select id,encrypted_detail from managed_conversation_turn_citations where execution_id=$1 order by ordinal,tool_call_id",
          [executionId]
        );
        await pool.query(
          "update managed_conversation_turn_citations set encrypted_detail=$2::jsonb where id=$1",
          [rows.rows[0]!.id, JSON.stringify(rows.rows[1]!.encrypted_detail)]
        );
        await expect(
          reloaded.listManagedConversationTurnCitations(actor, {
            executionId,
            providerTurnId: turnId
          })
        ).rejects.toThrow("custody mismatch");
        await pool.query(
          "update managed_conversation_turn_citations set encrypted_detail=$2::jsonb where id=$1",
          [rows.rows[0]!.id, JSON.stringify(rows.rows[0]!.encrypted_detail)]
        );
        await pool.query(
          "update managed_conversation_turn_citations set source_id=$2 where id=$1",
          [rows.rows[0]!.id, randomUUID()]
        );
        await expect(
          reloaded.listManagedConversationTurnCitations(actor, {
            executionId,
            providerTurnId: turnId
          })
        ).rejects.toThrow("custody mismatch");
        await pool.query(
          "update managed_conversation_turn_citations set source_id=$2 where id=$1",
          [rows.rows[0]!.id, recalled[0]!.source.sourceId]
        );

        const teamReceipt = randomUUID();
        const teamAlias = `r${teamReceipt.replaceAll("-", "")}c1`;
        const teamSourceId = randomUUID();
        const teamSource = {
          sourceType: "memory_node",
          sourceId: teamSourceId,
          representation: "lcm_leaves",
          visibility: "team"
        };
        await citations.recordManagedConversationToolCitations(actor, {
          executionId,
          executionGeneration: 1,
          commandId,
          leaseToken,
          providerTurnId: turnId,
          toolCallId: "call-team",
          questionId: randomUUID(),
          receiptId: teamReceipt,
          questionBackendId: "team-vps",
          observedCitations: [{ ...teamSource, citationId: teamAlias }],
          verifiedTeamSources: [
            {
              sourceType: "memory_node",
              sourceId: teamSourceId,
              teamWorkspaceId: randomUUID(),
              sourceOwnerPrincipalId: randomUUID()
            }
          ]
        });
        const teamListed = await reloaded.listManagedConversationTurnCitations(
          actor,
          { executionId, providerTurnId: turnId }
        );
        expect(
          teamListed.find((item) => item.alias === teamAlias)
        ).toMatchObject({
          detailAvailable: false,
          title: "Team memory unavailable",
          summary: null
        });
        await pool.query(
          "update managed_conversation_turn_citations set question_backend_id='team-other' where alias=$1",
          [teamAlias]
        );
        await expect(
          reloaded.listManagedConversationTurnCitations(actor, {
            executionId,
            providerTurnId: turnId
          })
        ).rejects.toThrow("custody mismatch");
        await pool.query(
          "update managed_conversation_turn_citations set question_backend_id='team:team-vps' where alias=$1",
          [teamAlias]
        );
        await repository.bindManagedConversationSourceGeneration(actor, {
          executionId,
          executionGeneration: 1,
          runnerId,
          expectedSourceGenerationId: sourceGenerationId,
          sourceGenerationId,
          providerTurnId: turnId
        });

        const staleReceipt = randomUUID();
        const staleInput = {
          executionId,
          executionGeneration: 1,
          commandId,
          leaseToken,
          providerTurnId: turnId,
          toolCallId: "call-stale",
          questionId: recalled[0]!.id,
          receiptId: staleReceipt,
          observedCitations: [
            {
              ...recalled[0]!.source,
              citationId: `r${staleReceipt.replaceAll("-", "")}c1`
            }
          ],
          verifiedPersonalSources: [
            {
              sourceType: "memory_node",
              sourceId: recalled[0]!.source.sourceId!,
              sourceDeploymentId,
              sourceOwnerPrincipalId: owner.id,
              title: "Source 1",
              summary: "Evidence 1"
            }
          ]
        };
        await expect(
          citations.recordManagedConversationToolCitations(actor, {
            ...staleInput,
            leaseToken: randomUUID()
          })
        ).rejects.toThrow("command lease");
        await pool.query(
          "update managed_conversation_commands set lease_expires_at=now()-interval '1 second' where id=$1",
          [commandId]
        );
        await expect(
          citations.recordManagedConversationToolCitations(actor, staleInput)
        ).rejects.toThrow("command lease");
        await pool.query(
          "update managed_conversation_commands set lease_expires_at=now()+interval '1 hour',state='completed' where id=$1",
          [commandId]
        );
        await expect(
          citations.recordManagedConversationToolCitations(actor, staleInput)
        ).rejects.toThrow("command lease");
        expect(
          (
            await pool.query(
              "select id from managed_conversation_turn_citations where tool_call_id='call-stale' and execution_id=$1",
              [executionId]
            )
          ).rowCount
        ).toBe(0);

        const dry = await reloaded.rewrapManagedConversationCitationBatch(
          encryptionProvider,
          {
            ownerUserId: owner.id,
            batchSize: 1,
            force: true,
            dryRun: true
          }
        );
        expect(dry).toMatchObject({
          processedRows: 1,
          rewrappedRows: 0,
          done: false
        });
        let cursor: string | undefined;
        let rewrapped = 0;
        for (let page = 0; page < 4; page++) {
          const batch = await reloaded.rewrapManagedConversationCitationBatch(
            encryptionProvider,
            {
              ownerUserId: owner.id,
              batchSize: 1,
              force: true,
              afterId: cursor
            }
          );
          rewrapped += batch.rewrappedRows;
          cursor = batch.nextCursorId ?? undefined;
          if (batch.done) break;
        }
        expect(rewrapped).toBe(3);
        expect(
          await reloaded.listManagedConversationTurnCitations(actor, {
            executionId,
            providerTurnId: turnId
          })
        ).toHaveLength(3);

        await pool.query(
          "update managed_conversation_commands set state='dispatching' where id=$1",
          [commandId]
        );
        const nextTurnId = `turn-${randomUUID()}`;
        const nextReceipt = randomUUID();
        await citations.recordManagedConversationToolCitations(actor, {
          executionId,
          executionGeneration: 1,
          commandId,
          leaseToken,
          providerTurnId: nextTurnId,
          toolCallId: "call-next-turn",
          questionId: recalled[0]!.id,
          receiptId: nextReceipt,
          observedCitations: [
            {
              ...recalled[0]!.source,
              citationId: `r${nextReceipt.replaceAll("-", "")}c1`
            }
          ],
          verifiedPersonalSources: [
            {
              sourceType: "memory_node",
              sourceId: recalled[0]!.source.sourceId!,
              sourceDeploymentId,
              sourceOwnerPrincipalId: owner.id,
              title: "Source 1",
              summary: "Evidence 1"
            }
          ]
        });
        const beforeNextBind = await pool.query<{
          source_generation_id: string | null;
        }>(
          "select source_generation_id from managed_conversation_turn_citations where execution_id=$1 and provider_turn_id=$2",
          [executionId, nextTurnId]
        );
        expect(beforeNextBind.rows[0]!.source_generation_id).toBeNull();
        const nextSourceGenerationId = randomUUID();
        await repository.bindManagedConversationSourceGeneration(actor, {
          executionId,
          executionGeneration: 1,
          runnerId,
          expectedSourceGenerationId: sourceGenerationId,
          sourceGenerationId: nextSourceGenerationId,
          providerTurnId: nextTurnId
        });
        const generations = await pool.query<{
          provider_turn_id: string;
          source_generation_id: string;
        }>(
          "select provider_turn_id,source_generation_id from managed_conversation_turn_citations where execution_id=$1",
          [executionId]
        );
        expect(
          generations.rows
            .filter((row) => row.provider_turn_id === turnId)
            .every((row) => row.source_generation_id === sourceGenerationId)
        ).toBe(true);
        expect(
          generations.rows
            .filter((row) => row.provider_turn_id === nextTurnId)
            .every((row) => row.source_generation_id === nextSourceGenerationId)
        ).toBe(true);

        await pool.query("update sessions set forget_batch_id=$2 where id=$1", [
          sessionId,
          randomUUID()
        ]);
        expect(
          await reloaded.listManagedConversationTurnCitations(actor, {
            executionId,
            providerTurnId: turnId
          })
        ).toEqual([]);
        expect(
          await reloaded.getManagedConversationCitationLocator(actor, {
            executionId,
            providerTurnId: turnId,
            alias: recalled[0]!.alias
          })
        ).toBeNull();
        await pool.query(
          "update sessions set forget_batch_id=null, personal_deleted_at=now() where id=$1",
          [sessionId]
        );
        expect(
          await reloaded.listManagedConversationTurnCitations(actor, {
            executionId,
            providerTurnId: turnId
          })
        ).toEqual([]);
        await pool.query(
          "update sessions set personal_deleted_at=null where id=$1",
          [sessionId]
        );
        expect(
          (
            await reloaded.listManagedConversationTurnCitations(actor, {
              executionId,
              providerTurnId: turnId
            })
          ).map((item) => item.alias)
        ).toContain(recalled[0]!.alias);
        await pool.query("update sessions set trashed_at=now() where id=$1", [
          sessionId
        ]);
        expect(
          await reloaded.listManagedConversationTurnCitations(actor, {
            executionId,
            providerTurnId: turnId
          })
        ).toEqual([]);
        await pool.query("update sessions set trashed_at=null where id=$1", [
          sessionId
        ]);
        expect(
          await reloaded.getManagedConversationCitationLocator(actor, {
            executionId,
            providerTurnId: turnId,
            alias: recalled[0]!.alias
          })
        ).toMatchObject({
          backendId: sourceDeploymentId,
          questionId: recalled[0]!.id
        });
      } finally {
        // Unique fixture owners live only in the dedicated HQ306 test database.
      }
    });
  }
);
