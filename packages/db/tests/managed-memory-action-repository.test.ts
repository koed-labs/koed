import { randomBytes, randomUUID } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "../src/connection.js";
import { runDbMigrations } from "../src/migrate.js";
import { createManagedMemoryActionRepository } from "../src/managed-memory-action-repository.js";
import { createCuratedMemoryRepository } from "../src/curated-memory-repository.js";
import { createManagedMemoryActionProcessor } from "../../../apps/worker/src/memory-action-observer.js";

const databaseUrl = process.env.KOED_HQ307_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("managed memory action custody", () => {
  let pool: pg.Pool;
  const provider = createLocalTestKeyEnvelopeEncryptionProvider(
    randomBytes(32).toString("base64url")
  );
  const owner = randomUUID();
  const other = randomUUID();
  const logicalSession = randomUUID();
  const localSession = randomUUID();
  const execution = randomUUID();
  const command = randomUUID();
  const userMessage = randomUUID();
  const lease = randomUUID();
  const actor = { userId: owner };
  let repo: ReturnType<typeof createManagedMemoryActionRepository>;

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
    repo = createManagedMemoryActionRepository(pool, provider);
    await pool.query("insert into users(id,email) values($1,$2),($3,$4)", [
      owner,
      `${owner}@example.test`,
      other,
      `${other}@example.test`
    ]);
    await pool.query(
      `insert into sessions(id,logical_session_id,owner_user_id,source_runtime,capture_method)
       values($1,$2,$3,'codex','api')`,
      [localSession, logicalSession, owner]
    );
    await pool.query(
      `insert into managed_conversation_executions
       (id,owner_user_id,project_id,ai_client_instance_id,model,permission_mode,runner_kind,state,
        fencing_token_hash,runner_deployment_id,runner_device_id,runner_id,runner_lease_expires_at,
        logical_session_id,provider_thread_id)
       values($1,$2,'/fixture','codex','test','auto','local_device','running',$3,$4,$5,$6,
              now()+interval '1 hour',$7,'provider-thread')`,
      [
        execution,
        owner,
        "a".repeat(64),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        logicalSession
      ]
    );
    await pool.query(
      `insert into managed_conversation_runtime_bindings
       (execution_id,owner_user_id,deployment_id,device_id,execution_generation,
        project_path,source_project_path,local_session_id,provider_thread_id,transcript_path,managed_home)
       values($1,$2,$3,$4,1,'/fixture','/fixture',$5,'provider-thread','/fixture/transcript','/fixture/home')`,
      [execution, owner, randomUUID(), randomUUID(), localSession]
    );
    await pool.query(
      `insert into managed_conversation_commands
       (id,owner_user_id,execution_id,idempotency_key,sequence,command_kind,request_digest,
        client_user_message_id,execution_generation,encrypted_payload,state,lease_token,lease_expires_at)
       values($1,$2,$3,$4,1,'prompt',$5,$6,1,'{}'::jsonb,'dispatching',$7,now()+interval '1 hour')`,
      [
        command,
        owner,
        execution,
        randomUUID(),
        "b".repeat(64),
        userMessage,
        lease
      ]
    );
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("requires the exact owner, command lease, and generation and de-duplicates a tool call", async () => {
    const input = {
      executionId: execution,
      commandId: command,
      leaseToken: lease,
      executionGeneration: 1,
      providerTurnId: "turn-1",
      toolCallId: "tool-1",
      actionKind: "forget" as const,
      request: { userPrompt: "Forget that" }
    };
    expect(
      await repo.enqueueManagedMemoryAction({ userId: other }, input)
    ).toBeNull();
    expect(
      await repo.enqueueManagedMemoryAction(actor, {
        ...input,
        leaseToken: randomUUID()
      })
    ).toBeNull();
    const first = await repo.enqueueManagedMemoryAction(actor, input);
    expect(first?.request.userPrompt).toBe("Forget that");
    const reopened = createManagedMemoryActionRepository(pool, provider);
    expect(
      (await reopened.listManagedMemoryActionsForCommand(actor, command))[0]
        ?.state
    ).toBe("pending");
    expect((await repo.enqueueManagedMemoryAction(actor, input))?.id).toBe(
      first?.id
    );
    expect(
      await repo.enqueueManagedMemoryAction(actor, {
        ...input,
        request: { userPrompt: "Forget citation 2" }
      })
    ).toBeNull();
    const completed = await repo.withManagedMemoryActionLease(
      actor,
      {
        actionId: first!.id,
        commandId: command,
        leaseToken: lease
      },
      async (_action, authority) => {
        expect(authority).toEqual({
          localSessionId: localSession,
          clientUserMessageId: userMessage
        });
        return { outcome: "ask_reference", message: "Which citation?" };
      }
    );
    expect(completed?.result?.outcome).toBe("ask_reference");
    expect(
      (await repo.listManagedMemoryActionResults(actor, execution)).map(
        (item) => item.id
      )
    ).toContain(first!.id);
    expect(
      await repo.listManagedMemoryActionResults({ userId: other }, execution)
    ).toEqual([]);
  });

  it("rejects encrypted request or result transplantation before presenting a row", async () => {
    const first = await repo.enqueueManagedMemoryAction(actor, {
      executionId: execution,
      commandId: command,
      leaseToken: lease,
      executionGeneration: 1,
      providerTurnId: "turn-2",
      toolCallId: "tool-2",
      actionKind: "correct",
      request: {
        userPrompt: "Correct that to new wording",
        correction: "new wording",
        userStatement: "Correct that to new wording"
      }
    });
    const original = await pool.query<{
      encrypted_request: unknown;
      request_digest: string;
    }>(
      "select encrypted_request,request_digest from managed_conversation_memory_actions where id=$1",
      [first!.id]
    );
    await pool.query(
      "update managed_conversation_memory_actions set request_digest=$2 where id=$1",
      [first!.id, "c".repeat(64)]
    );
    await expect(
      repo.listManagedMemoryActionsForCommand(actor, command)
    ).rejects.toThrow("custody mismatch");
    await pool.query(
      "update managed_conversation_memory_actions set request_digest=$2,encrypted_request=$3::jsonb where id=$1",
      [
        first!.id,
        original.rows[0]!.request_digest,
        JSON.stringify(original.rows[0]!.encrypted_request)
      ]
    );
    const otherEnvelope = await pool.query<{ encrypted_request: unknown }>(
      "select encrypted_request from managed_conversation_memory_actions where command_id=$1 and tool_call_id='tool-1'",
      [command]
    );
    await pool.query(
      "update managed_conversation_memory_actions set encrypted_request=$2::jsonb where id=$1",
      [first!.id, JSON.stringify(otherEnvelope.rows[0]!.encrypted_request)]
    );
    await expect(
      repo.listManagedMemoryActionsForCommand(actor, command)
    ).rejects.toThrow("custody mismatch");
    await pool.query(
      "update managed_conversation_memory_actions set encrypted_request=$2::jsonb where id=$1",
      [first!.id, JSON.stringify(original.rows[0]!.encrypted_request)]
    );
  });

  it("rewraps only the requested encrypted column", async () => {
    const before = await pool.query<{
      encrypted_request: unknown;
      encrypted_result: unknown;
    }>(
      "select encrypted_request,encrypted_result from managed_conversation_memory_actions where command_id=$1 and tool_call_id='tool-1'",
      [command]
    );
    const count = await repo.countManagedMemoryActionsForRewrap({
      ownerUserId: owner,
      sourceColumn: "encrypted_result"
    });
    expect(count).toBeGreaterThan(0);
    await repo.rewrapManagedMemoryActionBatch(provider, {
      ownerUserId: owner,
      sourceColumn: "encrypted_result",
      force: true
    });
    const after = await pool.query<{
      encrypted_request: unknown;
      encrypted_result: unknown;
    }>(
      "select encrypted_request,encrypted_result from managed_conversation_memory_actions where command_id=$1 and tool_call_id='tool-1'",
      [command]
    );
    expect(after.rows[0]!.encrypted_request).toEqual(
      before.rows[0]!.encrypted_request
    );
    expect(after.rows[0]!.encrypted_result).not.toEqual(
      before.rows[0]!.encrypted_result
    );
  });

  it("offers only the exact active source chat for a personal message", async () => {
    const messageId = randomUUID();
    await pool.query(
      `insert into messages(id,session_id,owner_user_id,visibility,role,content,source_runtime,capture_method)
       values($1,$2,$3,'personal','user','Source','codex','api')`,
      [messageId, localSession, owner]
    );
    expect(
      await repo.resolveManagedMemorySourceSession(actor, {
        sourceType: "message",
        sourceId: messageId
      })
    ).toBe(localSession);
    expect(
      await repo.resolveManagedMemorySourceSession(
        { userId: other },
        { sourceType: "message", sourceId: messageId }
      )
    ).toBeNull();
    await pool.query("update sessions set trashed_at=now() where id=$1", [
      localSession
    ]);
    expect(
      await repo.resolveManagedMemorySourceSession(actor, {
        sourceType: "message",
        sourceId: messageId
      })
    ).toBeNull();
    await pool.query("update sessions set trashed_at=null where id=$1", [
      localSession
    ]);
  });

  it("requires the command's exact captured User-message identity for correction evidence", async () => {
    const itemId = randomUUID();
    await pool.query(
      `insert into conversation_items
       (id,owner_user_id,visibility,session_id,source_kind,source_adapter_version,
        source_transport,source_record_type,source_event_type,canonical_stable_item_id,raw_json,metadata,
        source_hash,idempotency_key,canonical_item_key)
       values($1,$2,'personal',$3,'codex','test','api','message','user_message',$4,'{}'::jsonb,'{"transcriptType":"user_message"}'::jsonb,$5,$6,$7)`,
      [
        itemId,
        owner,
        localSession,
        `koed-user-message:${userMessage}`,
        "a".repeat(64),
        randomUUID(),
        randomUUID()
      ]
    );
    expect(
      await repo.getManagedMemoryActionUserSource(actor, {
        commandId: command,
        clientUserMessageId: userMessage,
        localSessionId: localSession
      })
    ).toBe(itemId);
    expect(
      await repo.getManagedMemoryActionUserSource(
        { userId: other },
        {
          commandId: command,
          clientUserMessageId: userMessage,
          localSessionId: localSession
        }
      )
    ).toBeNull();
    expect(
      await repo.getManagedMemoryActionUserSource(actor, {
        commandId: command,
        clientUserMessageId: randomUUID(),
        localSessionId: localSession
      })
    ).toBeNull();
  });

  it("binds only the uniquely captured provider User record after the trusted frontier", async () => {
    const generation = randomUUID();
    const fingerprint = "d".repeat(64);
    const sourceKind = "pi" as const;
    const externalSessionId = "provider-thread";
    await pool.query(
      `insert into conversation_source_artifacts
       (owner_user_id,session_id,logical_source_id,source_generation_id,replica_role,
        source_kind,source_runtime,external_session_id,source_fingerprint,
        artifact_format,artifact_format_version,source_adapter_version,
        provider_cursor_line,source_created_at,storage_provider,storage_prefix,
        origin_deployment_id,origin_device_id,origin_key_id,origin_public_key,redacted_source_label)
       values($1,$2,$3,$4,'origin_local','pi','pi',$5,$6,'jsonl',1,'pi-session-v1',
              8,now(),'local','fixture',$7,$8,'key',$9,'fixture')`,
      [
        owner,
        localSession,
        randomUUID(),
        generation,
        externalSessionId,
        fingerprint,
        randomUUID(),
        randomUUID(),
        "a".repeat(43)
      ]
    );
    const addItem = async (line: number, text: string, record: unknown) => {
      const id = randomUUID();
      await pool.query(
        `insert into conversation_items
         (id,owner_user_id,visibility,session_id,source_kind,source_adapter_version,
          source_transport,external_session_id,source_record_type,source_event_type,
          source_line_number,source_sequence,canonical_stable_item_id,raw_json,
          raw_text,source_hash,source_fingerprint,idempotency_key,canonical_item_key,metadata)
         values($1,$2,'personal',$3,'pi','pi-session-v1','transcript',$4,'message',
                'user_message',$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,
                '{"actor":"user"}'::jsonb)`,
        [
          id,
          owner,
          localSession,
          externalSessionId,
          line,
          line * 1000,
          `entry-${line}:0`,
          JSON.stringify({ sourceRecord: record }),
          text,
          "e".repeat(64),
          fingerprint,
          randomUUID(),
          randomUUID()
        ]
      );
      return id;
    };
    await addItem(2, "Correct that to blue", {
      type: "message",
      message: { role: "user" }
    });
    await addItem(6, "Correct that to blue", {
      type: "message",
      message: { role: "user" },
      isSidechain: true
    });
    const current = await addItem(7, "Correct that to blue", {
      type: "message",
      message: { role: "user" }
    });
    const input = {
      commandId: command,
      executionId: execution,
      executionGeneration: 1,
      leaseToken: lease,
      localSessionId: localSession,
      clientUserMessageId: userMessage,
      sourceKind,
      externalSessionId,
      sourceGenerationId: generation,
      fromLine: 5,
      toLine: 8,
      providerPrompt: "Correct that to blue"
    };
    expect(await repo.bindManagedMemoryActionUserSource(actor, input)).toBe(
      current
    );
    expect(await repo.bindManagedMemoryActionUserSource(actor, input)).toBe(
      current
    );
    expect(
      await repo.bindManagedMemoryActionUserSource({ userId: other }, input)
    ).toBeNull();
    expect(
      await repo.bindManagedMemoryActionUserSource(actor, {
        ...input,
        leaseToken: randomUUID()
      })
    ).toBeNull();
    expect(
      await repo.bindManagedMemoryActionUserSource(actor, {
        ...input,
        fromLine: 2
      })
    ).toBeNull();
  });

  it("commits real Curated suppression and a source-linked supersede proposal through an action lease", async () => {
    const curated = createCuratedMemoryRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const itemId = randomUUID();
    const assertionId = randomUUID();
    await pool.query(
      `insert into conversation_items
       (id,owner_user_id,visibility,session_id,source_kind,source_adapter_version,
        source_transport,source_record_type,source_event_type,raw_json,raw_text,
        source_hash,idempotency_key,canonical_item_key,metadata)
       values($1,$2,'personal',$3,'codex','test','api','message','user_message',
              '{}'::jsonb,'The value is blue',$4,$5,$6,'{"transcriptType":"user_message"}'::jsonb)`,
      [itemId, owner, localSession, "a".repeat(64), randomUUID(), randomUUID()]
    );
    await pool.query(
      `insert into curated_memory_assertions
       (id,owner_user_id,visibility,assertion_text,normalized_assertion,status,kind)
       values($1,$2,'personal','The processor value is red','the processor value is red','current','fact')`,
      [assertionId, owner]
    );
    await pool.query(
      `insert into curated_memory_sources
       (assertion_id,source_type,source_role,conversation_item_id)
       values($1,'conversation_item','primary_evidence',$2)`,
      [assertionId, itemId]
    );
    const forget = await repo.enqueueManagedMemoryAction(actor, {
      executionId: execution,
      commandId: command,
      leaseToken: lease,
      executionGeneration: 1,
      providerTurnId: "real-turn",
      toolCallId: "real-forget",
      actionKind: "forget",
      request: { userPrompt: "Forget that" }
    });
    const forgot = await repo.withManagedMemoryActionLease(
      actor,
      { actionId: forget!.id, commandId: command, leaseToken: lease },
      async () => {
        const assertion = await curated.suppressCuratedMemoryAssertion(
          actor,
          assertionId,
          { reason: `managed-memory-action:${forget!.id}` }
        );
        expect(assertion?.status).toBe("suppressed");
        return {
          outcome: "forgotten" as const,
          message: "Forgotten",
          assertionId
        };
      }
    );
    expect(forgot?.result?.outcome).toBe("forgotten");
    const token = await pool.query<{ token: string }>(
      `select ((extract(epoch from suppressed_at) * 1000000)::bigint)::text as token
       from curated_memory_assertions where id=$1`,
      [assertionId]
    );
    const restored = await curated.unsuppressCuratedMemoryAssertion(
      actor,
      assertionId,
      { suppressionToken: token.rows[0]!.token }
    );
    expect(restored?.status).toBe("current");
    const correct = await repo.enqueueManagedMemoryAction(actor, {
      executionId: execution,
      commandId: command,
      leaseToken: lease,
      executionGeneration: 1,
      providerTurnId: "real-turn",
      toolCallId: "real-correct",
      actionKind: "correct",
      request: {
        userPrompt: "Correct that to blue",
        correction: "blue",
        userStatement: "Correct that to blue"
      }
    });
    const corrected = await repo.withManagedMemoryActionLease(
      actor,
      { actionId: correct!.id, commandId: command, leaseToken: lease },
      async () => {
        const proposal = await curated.createCuratedMemoryProposal(actor, {
          proposedClaim: "The value is blue",
          evidenceConversationItemIds: [itemId],
          operation: "supersede",
          targetAssertionId: assertionId,
          createdByModel: "managed-memory-correct",
          createdByPromptVersion: `memory-correct-v1:${correct!.id}`
        });
        return {
          outcome: "proposal_created" as const,
          message: "Queued",
          proposalId: proposal.id
        };
      }
    );
    expect(corrected?.result?.outcome, corrected?.result?.message).toBe(
      "proposal_created"
    );
  }, 20_000);

  it("runs the managed processor through actual suppression and correction proposal writes", async () => {
    const curated = createCuratedMemoryRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const itemId = randomUUID();
    const assertionId = randomUUID();
    const alias = `r${"f".repeat(32)}c1`;
    await pool.query(
      `update conversation_items set canonical_stable_item_id=null
       where owner_user_id=$1 and session_id=$2
         and canonical_stable_item_id=$3`,
      [owner, localSession, `koed-user-message:${userMessage}`]
    );
    await pool.query(
      `update conversation_items set metadata=metadata-'managedClientUserMessageId'
       where owner_user_id=$1 and session_id=$2
         and metadata->>'managedClientUserMessageId'=$3`,
      [owner, localSession, userMessage]
    );
    await pool.query(
      `insert into conversation_items
       (id,owner_user_id,visibility,session_id,source_kind,source_adapter_version,
        source_transport,source_record_type,source_event_type,canonical_stable_item_id,
        raw_json,raw_text,source_hash,idempotency_key,canonical_item_key,metadata)
       values($1,$2,'personal',$3,'codex','test','api','message','user_message',$4,
         '{}'::jsonb,'Correct that to blue',$5,$6,$7,'{"transcriptType":"user_message"}'::jsonb)`,
      [
        itemId,
        owner,
        localSession,
        `koed-user-message:${userMessage}`,
        "a".repeat(64),
        randomUUID(),
        randomUUID()
      ]
    );
    await pool.query(
      `insert into curated_memory_assertions
       (id,owner_user_id,visibility,assertion_text,normalized_assertion,status,kind)
       values($1,$2,'personal','The processor second value is red','the processor second value is red','current','fact')`,
      [assertionId, owner]
    );
    await pool.query(
      `insert into curated_memory_sources
       (assertion_id,source_type,source_role,conversation_item_id)
       values($1,'conversation_item','primary_evidence',$2)`,
      [assertionId, itemId]
    );
    const makeProcessor = (
      actionId: string,
      prompt: string,
      currentAvailable = true
    ) =>
      createManagedMemoryActionProcessor(
        {
          getManagedConversationCommand: async () => ({
            id: command,
            executionId: execution,
            leaseToken: lease,
            state: "dispatching",
            executionGeneration: 1,
            clientUserMessageId: userMessage,
            payload: { prompt },
            createdAt: "2026-10-20T10:02:00Z"
          }),
          getManagedConversationExecution: async () => ({
            id: execution,
            executionGeneration: 1,
            providerThreadId: "provider-thread"
          }),
          getManagedConversationRuntimeBinding: async () => ({
            localSessionId: localSession,
            executionGeneration: 1
          }),
          listManagedMemoryActionsForCommand: async () =>
            (
              await repo.listManagedMemoryActionsForCommand(actor, command)
            ).filter((item) => item.id === actionId),
          withManagedMemoryActionLease: repo.withManagedMemoryActionLease,
          listLcmGraphEvents: async () => [
            {
              actor: "agent",
              content: `Earlier claim [m:${alias}]`,
              timestamp: "2026-10-20T10:01:00Z",
              sourceSequence: 1,
              sessionId: localSession
            }
          ],
          listManagedConversationCitationsByAliases: async () => [
            {
              alias,
              visibility: "personal",
              sourceType: "curated_memory",
              sourceId: assertionId,
              providerTurnId: "prior-turn"
            }
          ],
          getManagedConversationCitationLocator: async () => ({
            alias,
            visibility: "personal",
            backendId: "fixture-deployment",
            sourceNamespace: "fixture-deployment",
            sourceOwnerPrincipalId: owner,
            sourceType: "curated_memory",
            sourceId: assertionId,
            questionId: randomUUID(),
            ordinal: 1
          }),
          getManagedPersonalQuestionCitation: async () =>
            currentAvailable
              ? {
                  sourceType: "curated_memory",
                  sourceId: assertionId,
                  sourceOwnerPrincipalId: owner
                }
              : null,
          getCuratedMemoryAssertion: curated.getCuratedMemoryAssertion,
          suppressCuratedMemoryAssertion:
            curated.suppressCuratedMemoryAssertion,
          getManagedMemoryActionUserSource:
            repo.getManagedMemoryActionUserSource,
          findManagedMemoryCorrectionProposal:
            repo.findManagedMemoryCorrectionProposal,
          createCuratedMemoryProposal: curated.createCuratedMemoryProposal,
          putManagedConversationRuntimeItem: async () => ({})
        } as never,
        "fixture-deployment"
      );
    const runAction = async (
      kind: "forget" | "correct",
      prompt: string,
      request: Record<string, string>
    ) => {
      const action = await repo.enqueueManagedMemoryAction(actor, {
        executionId: execution,
        commandId: command,
        leaseToken: lease,
        executionGeneration: 1,
        providerTurnId: "processor-turn",
        toolCallId: randomUUID(),
        actionKind: kind,
        request: { userPrompt: prompt, ...request }
      });
      await makeProcessor(
        action!.id,
        prompt
      )({
        ownerUserId: owner,
        executionId: execution,
        commandId: command,
        leaseToken: lease,
        executionGeneration: 1
      });
      return (await repo.listManagedMemoryActionResults(actor, execution)).find(
        (item) => item.id === action!.id
      );
    };
    const forgotten = await runAction("forget", "Forget that", {});
    expect(forgotten?.result?.outcome).toBe("forgotten");
    const token = forgotten?.result?.suppressionToken;
    expect(token).toBeTruthy();
    await curated.unsuppressCuratedMemoryAssertion(actor, assertionId, {
      suppressionToken: token!
    });
    const matching = await pool.query(
      `select id,source_kind,source_event_type,metadata,canonical_stable_item_id,
              personal_deleted_at,memory_excluded_at
       from conversation_items where owner_user_id=$1 and session_id=$2
         and canonical_stable_item_id=$3`,
      [owner, localSession, `koed-user-message:${userMessage}`]
    );
    expect(matching.rows).toHaveLength(1);
    expect(matching.rows[0]).toMatchObject({
      source_kind: "codex",
      source_event_type: "user_message",
      metadata: { transcriptType: "user_message" },
      personal_deleted_at: null,
      memory_excluded_at: null
    });
    expect(
      await repo.getManagedMemoryActionUserSource(actor, {
        commandId: command,
        clientUserMessageId: userMessage,
        localSessionId: localSession
      })
    ).toBe(itemId);
    const corrected = await runAction("correct", "Correct that to blue", {
      correction: "blue",
      userStatement: "Correct that to blue"
    });
    expect(corrected?.result?.outcome, corrected?.result?.message).toBe(
      "proposal_created"
    );
    expect(corrected?.result?.proposalId).toBeTruthy();
    const recovery = await repo.enqueueManagedMemoryAction(actor, {
      executionId: execution,
      commandId: command,
      leaseToken: lease,
      executionGeneration: 1,
      providerTurnId: "recovery-turn",
      toolCallId: randomUUID(),
      actionKind: "forget",
      request: { userPrompt: "Forget that" }
    });
    const committed = await curated.suppressCuratedMemoryAssertion(
      actor,
      assertionId,
      { reason: `managed-memory-action:${recovery!.id}` }
    );
    expect(committed?.suppressionToken).toBeTruthy();
    await makeProcessor(
      recovery!.id,
      "Forget that",
      false
    )({
      ownerUserId: owner,
      executionId: execution,
      commandId: command,
      leaseToken: lease,
      executionGeneration: 1
    });
    const recovered = (
      await repo.listManagedMemoryActionResults(actor, execution)
    ).find((item) => item.id === recovery!.id);
    expect(recovered?.result?.outcome).toBe("forgotten");
    expect(recovered?.result?.suppressionToken).toBe(
      committed?.suppressionToken
    );
  }, 20_000);
});
