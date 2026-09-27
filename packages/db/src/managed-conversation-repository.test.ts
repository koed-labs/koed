import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

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
