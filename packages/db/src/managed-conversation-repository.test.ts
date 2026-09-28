import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  decryptEnvelopeToUtf8,
  type EncryptedPayloadEnvelope
} from "@koed/shared";

import { createManagedConversationRepository } from "./managed-conversation-repository.js";

describe("managed Conversation recovery lookup", () => {
  it("returns absent from an owner, kind, and prompt identity scoped query", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repository = createManagedConversationRepository(
      { query } as unknown as pg.Pool,
      {}
    );
    const identity = {
      commandKind: "prompt" as const,
      idempotencyKey: "prompt:stable-key",
      clientUserMessageId: "0ebcc84e-1028-493b-8c54-e41f61f76818",
      executionId: "d5fe6081-1d6c-4b5a-93c3-5f41d39a25fa",
      executionGeneration: 4
    };

    await expect(
      repository.getManagedConversationCommandByRecoveryIdentity(
        { userId: "owner-user-id" },
        identity
      )
    ).resolves.toBeNull();

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("command.owner_user_id = $1"),
      [
        "owner-user-id",
        identity.idempotencyKey,
        "prompt",
        identity.clientUserMessageId,
        identity.executionId,
        identity.executionGeneration
      ]
    );
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("command.idempotency_key = $2");
    expect(sql).toContain("command.command_kind = $3");
    expect(sql).toContain("command.client_user_message_id = $4");
    expect(sql).toContain("command.execution_id = $5");
    expect(sql).toContain("command.execution_generation = $6");
  });
});

describe("managed Conversation start prompt dispatch", () => {
  const ownerUserId = "owner-user-id";
  const executionId = "d5fe6081-1d6c-4b5a-93c3-5f41d39a25fa";
  const startCommandId = "5224b37d-08b3-48f4-84d7-c4ba29ff63f7";
  const leaseToken = "lease-token";
  const clientUserMessageId = "0ebcc84e-1028-493b-8c54-e41f61f76818";
  const provider = createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 7).toString("base64")
  );

  it("queues one encrypted child prompt with the caller recovery identity", async () => {
    const encryptedPayload = await provider.encrypt({
      plaintext: JSON.stringify({
        prompt: "  Say hello  ",
        clientUserMessageId,
        settings: {
          model: "claude-test",
          reasoningEffort: null,
          permissionMode: "supervised"
        }
      }),
      scope: { tenantId: ownerUserId, objectClass: "managed_conversation_prompt" },
      provenance: {
        rowFamily: "managed_conversation_commands",
        sourceId: startCommandId
      },
      ciphertextLocation: "managed_conversation_commands.encrypted_payload",
      aad: { ownerUserId, executionId, commandId: startCommandId }
    });
    let completed = false;
    let childInsertParams: unknown[] | undefined;
    const outboxRow = {
      id: "outbox-id",
      cursor: "1",
      protocol_version: 1,
      family: "managed_conversation_changed",
      scope: "personal",
      personal_owner_user_id: ownerUserId,
      team_id: null,
      team_workspace_id: null,
      thread_id: null,
      message_id: null,
      share_grant_id: null,
      logical_memory_id: null,
      resource_type: "managed_conversation_execution",
      resource_id: executionId,
      actor_principal_id: ownerUserId,
      mutation_id: "mutation-id",
      occurred_at: new Date()
    };
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("update managed_conversation_commands")) {
        if (completed) return { rows: [] };
        completed = true;
        return {
          rows: [
            {
              id: startCommandId,
              owner_user_id: ownerUserId,
              execution_id: executionId,
              execution_generation: 2,
              command_kind: "start",
              encrypted_payload: encryptedPayload
            }
          ]
        };
      }
      if (sql.includes("from managed_conversation_executions") && sql.includes("for update")) {
        return {
          rows: [
            {
              execution_generation: 2,
              state: "running",
              model: "claude-current",
              reasoning_effort: "high",
              permission_mode: "auto_edit"
            }
          ]
        };
      }
      if (sql.includes("coalesce(max(sequence)")) return { rows: [{ sequence: 4 }] };
      if (sql.includes("insert into managed_conversation_commands")) {
        childInsertParams = params;
        return { rows: [{ id: "child-command-id" }] };
      }
      if (sql.includes("insert into collaboration_outbox")) {
        return { rows: [outboxRow] };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) };
    const repository = createManagedConversationRepository(
      pool as unknown as pg.Pool,
      { envelopeEncryptionProvider: provider }
    );

    await expect(
      repository.completeManagedConversationCommand({
        commandId: startCommandId,
        leaseToken
      })
    ).resolves.toBe(true);
    await expect(
      repository.completeManagedConversationCommand({
        commandId: startCommandId,
        leaseToken
      })
    ).resolves.toBe(false);

    expect(query.mock.calls.filter(([sql]) => sql.includes("insert into managed_conversation_commands"))).toHaveLength(1);
    expect(childInsertParams?.[3]).toBe(`managed-conversation-start-prompt:${startCommandId}`);
    expect(childInsertParams?.[4]).toBe(4);
    expect(childInsertParams?.[6]).toBe(clientUserMessageId);
    expect(childInsertParams?.[7]).toBe(2);
    const childPayload = JSON.parse(
      await decryptEnvelopeToUtf8(provider, childInsertParams?.[8] as EncryptedPayloadEnvelope)
    );
    expect(childPayload).toMatchObject({
      prompt: "Say hello",
      clientUserMessageId,
      settings: {
        model: "claude-current",
        reasoningEffort: "high",
        permissionMode: "auto_edit"
      }
    });
  });

  it("does not dispatch the prompt when a pending start was canceled", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const client = { query, release: vi.fn() };
    const repository = createManagedConversationRepository(
      { connect: vi.fn(async () => client) } as unknown as pg.Pool,
      { envelopeEncryptionProvider: provider }
    );

    await expect(
      repository.completeManagedConversationCommand({
        commandId: startCommandId,
        leaseToken
      })
    ).resolves.toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into managed_conversation_commands"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes("from managed_conversation_executions"))).toBe(false);
  });
});


describe("managed provider encrypted history", () => {
  const owner = "owner";
  const executionId = "d5fe6081-1d6c-4b5a-93c3-5f41d39a25fa";
  const commandId = "5224b37d-08b3-48f4-84d7-c4ba29ff63f7";
  const provider = createLocalTestKeyEnvelopeEncryptionProvider(Buffer.alloc(32, 8).toString("base64"));
  const envelope = (value: Record<string, unknown>) => provider.encrypt({
    plaintext: JSON.stringify(value), scope: { tenantId: owner, objectClass: "managed_conversation_prompt" },
    provenance: { rowFamily: "managed_conversation_commands", sourceId: commandId },
    ciphertextLocation: "managed_conversation_commands.encrypted_payload",
    aad: { ownerUserId: owner, executionId, commandId }
  });

  it("encrypts final output in the same completion transaction and never plaintext result", async () => {
    const encrypted = await envelope({ prompt: "Private prompt", settings: {} });
    let saved: unknown;
    const outboxRow = {
      id: "outbox-id",
      cursor: "1",
      protocol_version: 1,
      family: "managed_conversation_changed",
      scope: "personal",
      personal_owner_user_id: owner,
      team_id: null,
      team_workspace_id: null,
      thread_id: null,
      message_id: null,
      share_grant_id: null,
      logical_memory_id: null,
      resource_type: "managed_conversation_execution",
      resource_id: executionId,
      actor_principal_id: owner,
      mutation_id: "mutation-id",
      occurred_at: new Date()
    };

    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("returning id, owner_user_id")) return { rows: [{ id: commandId, owner_user_id: owner, execution_id: executionId, execution_generation: 1, command_kind: "prompt", encrypted_payload: encrypted }] };
      if (sql.includes("set encrypted_payload")) saved = params[1];
      if (sql.includes("insert into collaboration_outbox")) return { rows: [outboxRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const repository = createManagedConversationRepository({ connect: async () => ({ query, release() {} }) } as unknown as pg.Pool, { envelopeEncryptionProvider: provider });
    await expect(repository.completeManagedConversationCommand({ commandId, leaseToken: "lease", result: { turnId: "turn" }, assistantOutput: { text: "Private final reply", truncated: false } })).resolves.toBe(true);
    expect(JSON.stringify(saved)).not.toContain("Private final reply");
    expect(JSON.parse(await decryptEnvelopeToUtf8(provider, saved as EncryptedPayloadEnvelope))).toMatchObject({ prompt: "Private prompt", assistantOutput: { text: "Private final reply", truncated: false } });
    expect(query.mock.calls.find(([sql]) => sql.includes("returning id, owner_user_id"))?.[1]?.[2]).toEqual({ turnId: "turn" });
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
  });

  it("returns bounded decrypted turns scoped to owner and execution, and rejects invalid cursors", async () => {
    const encrypted = await envelope({ prompt: "Prompt", assistantOutput: { text: "Final", truncated: false } });
    const now = new Date();
    const row = { id: commandId, client_user_message_id: commandId, sequence: 4, created_at: now, completed_at: now, updated_at: now, encrypted_payload: encrypted };
    const query = vi.fn(async (_sql: string, _params: unknown[] = []) => ({ rows: [row, { ...row, sequence: 3 }] }));
    const repository = createManagedConversationRepository({ query } as unknown as pg.Pool, { envelopeEncryptionProvider: provider });
    const history = await repository.listManagedConversationPromptHistory({ userId: owner }, { executionId, limit: 1, before: "prompt:5" });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("owner_user_id = $1 and execution_id = $2"), [owner, executionId, 5, 2]);
    expect(query.mock.calls[0]?.[0]).toContain("state = 'completed'");
    expect(history).toMatchObject({ turns: [{ commandId, prompt: "Prompt", assistantOutput: { text: "Final", truncated: false } }], hasMore: true, nextCursor: "prompt:4" });
    await expect(repository.listManagedConversationPromptHistory({ userId: owner }, { executionId, before: "foreign-cursor" })).rejects.toMatchObject({ statusCode: 400 });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
