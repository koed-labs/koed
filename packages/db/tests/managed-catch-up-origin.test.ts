import { randomBytes, randomUUID } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { describe, expect, it, vi } from "vitest";
import { codexCatchUpOrigin } from "../src/conversation-item-repository.js";

const ownerUserId = randomUUID();
const sessionId = randomUUID();
const executionId = randomUUID();
const commandId = randomUUID();
const messageId = randomUUID();
const turnId = "provider-turn-1";
const prompt = "Koed Project HQ catch-up. Summarize verified changes.";
const provider = createLocalTestKeyEnvelopeEncryptionProvider(
  randomBytes(32).toString("base64url")
);
const session = {
  id: sessionId,
  capture_method: "api",
  metadata: { managedConversation: true }
} as never;
const item = {
  sourceKind: "codex",
  sourceAdapterVersion: "codex-transcript-v1",
  sourceEventType: "item/completed",
  sourceTransport: "app_server",
  sourceRecordType: "user_message",
  canonicalStableItemId: `koed-user-message:${messageId}`,
  externalTurnId: turnId,
  externalThreadId: "provider-thread",
  rawText: prompt,
  rawJson: { text: prompt },
  sourceHash: "catch-up-origin-fixture",
  idempotencyKey: `catch-up-origin:${messageId}`,
  metadata: { transcriptType: "user_message" }
};

const commandRow = async () => ({
  id: commandId,
  execution_id: executionId,
  state: "dispatching",
  execution_generation: 2,
  current_generation: 2,
  current_state: "running",
  has_lease: true,
  lease_expires_at: new Date(Date.now() + 60_000),
  runner_lease_expires_at: new Date(Date.now() + 60_000),
  encrypted_payload: await provider.encrypt({
    plaintext: JSON.stringify({ prompt }),
    scope: {
      tenantId: ownerUserId,
      objectClass: "managed_conversation_prompt"
    },
    provenance: {
      rowFamily: "managed_conversation_commands",
      sourceId: commandId
    },
    ciphertextLocation: "managed_conversation_commands.encrypted_payload",
    aad: { ownerUserId, executionId, commandId }
  }),
  result: null,
  local_session_id: sessionId,
  provider_thread_id: "provider-thread"
});

describe("Codex Koed catch-up origin", () => {
  it("keeps a human literal marker as an ordinary User message", async () => {
    const query = vi.fn();
    expect(
      await codexCatchUpOrigin({
        client: { query } as never,
        ownerUserId,
        session,
        item: {
          ...item,
          canonicalStableItemId: "provider-user-1",
          rawText: `koed-user-message:${messageId}`
        } as never,
        encryptionProvider: provider
      })
    ).toEqual({ status: "ordinary" });
    expect(query).not.toHaveBeenCalled();
  });

  it("classifies only an active command-bound exact provider input", async () => {
    const row = await commandRow();
    const query = vi.fn(async (...args: unknown[]) => {
      expect(args).toHaveLength(2);
      return { rows: [row] };
    });
    const base = {
      client: { query } as never,
      ownerUserId,
      item,
      session,
      encryptionProvider: provider
    };
    expect(await codexCatchUpOrigin(base)).toEqual({
      status: "raw_only",
      commandId
    });
    expect(query.mock.calls[0]?.[1]).toEqual([
      ownerUserId,
      messageId,
      sessionId
    ]);
    expect(
      await codexCatchUpOrigin({
        ...base,
        item: { ...item, rawText: "Different human input" } as never
      })
    ).toEqual({ status: "ordinary" });
  });

  it("holds an exact input when its lease, generation, or captured session is stale", async () => {
    const row = await commandRow();
    for (const changed of [
      { has_lease: false },
      { current_generation: 3 },
      { local_session_id: randomUUID() },
      { provider_thread_id: "different-thread" }
    ]) {
      expect(
        await codexCatchUpOrigin({
          client: {
            query: async () => ({ rows: [{ ...row, ...changed }] })
          } as never,
          ownerUserId,
          item,
          session,
          encryptionProvider: provider
        })
      ).toEqual({ status: "held" });
    }
    expect(
      await codexCatchUpOrigin({
        client: { query: async () => ({ rows: [] }) } as never,
        ownerUserId,
        item,
        session,
        encryptionProvider: provider
      })
    ).toEqual({ status: "ordinary" });
  });
});
