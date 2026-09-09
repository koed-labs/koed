import { describe, expect, it } from "vitest";

import type { ManagedConversationRuntimeItem } from "../../ipc/managed-conversation-protocol.js";
import {
  managedConversationRuntimeStateFromSnapshot,
  reduceManagedConversationRuntime,
  type ManagedConversationRealtimeUpdate
} from "./managed-conversation-runtime.js";

const executionId = "11111111-1111-4111-8111-111111111111";
const commandId = "22222222-2222-4222-8222-222222222222";
const itemId = "33333333-3333-4333-8333-333333333333";
const now = "2026-08-21T00:00:00.000Z";

const item = (revision = 1): ManagedConversationRuntimeItem => ({
  id: itemId,
  executionGeneration: 1,
  providerTurnId: "turn-1",
  providerItemId: "item-1",
  itemKind: "transient_output",
  presentation: {
    mode: "expanded",
    renderer: "message",
    policyKey: "agent_message",
    policyRevision: 1,
    reason: "presentation-policy:agent_message"
  },
  state: "pending",
  payload: { text: `revision ${revision}` },
  revision,
  createdAt: now,
  updatedAt: now,
  answered: false
});

const update = (
  overrides: Partial<ManagedConversationRealtimeUpdate> = {}
): ManagedConversationRealtimeUpdate => ({
  type: "managed_conversation_upserted",
  execution: {
    id: executionId,
    projectId: "/tmp/project",
    provider: "codex",
    state: "running",
    stateVersion: 2,
    executionGeneration: 1,
    logicalSessionId: null,
    sessionId: null,
    providerThreadId: null,
    providerCliVersion: null,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    quiescedAt: null,
    stoppedAt: null
  },
  latestCommand: {
    clientUserMessageId: null,
    id: commandId,
    sequence: 2,
    executionGeneration: 1,
    commandKind: "prompt",
    state: "dispatching",
    lastErrorCode: null,
    updatedAt: now
  },
  runtimeItemChange: null,
  ...overrides
});

const snapshot = () =>
  managedConversationRuntimeStateFromSnapshot({
    operation: "runtime",
    executionId,
    executionGeneration: 1,
    executionStateVersion: 1,
    executionState: "starting",
    executionLastErrorCode: null,
    latestCommand: null,
    items: []
  });

describe("managed Conversation runtime materialisation", () => {
  it("applies command and item deltas without requiring a snapshot", () => {
    const changed = update({
      runtimeItemChange: { kind: "upsert", item: item() }
    });
    const result = reduceManagedConversationRuntime(snapshot(), changed);

    expect(result.requiresSnapshot).toBe(false);
    expect(result.state.executionState).toBe("running");
    expect(result.state.latestCommand?.sequence).toBe(2);
    expect(result.state.items).toEqual([item()]);
  });

  it("ignores duplicate and stale item revisions", () => {
    const first = reduceManagedConversationRuntime(
      snapshot(),
      update({ runtimeItemChange: { kind: "upsert", item: item(2) } })
    ).state;
    const duplicate = reduceManagedConversationRuntime(
      first,
      update({ runtimeItemChange: { kind: "upsert", item: item(2) } })
    ).state;
    const stale = reduceManagedConversationRuntime(
      duplicate,
      update({ runtimeItemChange: { kind: "upsert", item: item(1) } })
    ).state;

    expect(stale.items[0]?.revision).toBe(2);
  });

  it("removes resolved items idempotently", () => {
    const populated = reduceManagedConversationRuntime(
      snapshot(),
      update({ runtimeItemChange: { kind: "upsert", item: item() } })
    ).state;
    const removed = reduceManagedConversationRuntime(
      populated,
      update({
        runtimeItemChange: {
          kind: "remove",
          itemId,
          executionGeneration: 1,
          revision: 2
        }
      })
    );
    const duplicate = reduceManagedConversationRuntime(
      removed.state,
      update({
        runtimeItemChange: {
          kind: "remove",
          itemId,
          executionGeneration: 1,
          revision: 2
        }
      })
    );
    const staleUpsert = reduceManagedConversationRuntime(
      duplicate.state,
      update({ runtimeItemChange: { kind: "upsert", item: item(1) } })
    );

    expect(removed.requiresSnapshot).toBe(false);
    expect(duplicate.state.items).toEqual([]);
    expect(staleUpsert.state.items).toEqual([]);
  });

  it("requires authoritative recovery for generation changes and resets", () => {
    const generationChange = update({
      execution: {
        ...update().execution,
        stateVersion: 1,
        executionGeneration: 2
      },
      latestCommand: null
    });
    const changed = reduceManagedConversationRuntime(
      snapshot(),
      generationChange
    );
    const reset = reduceManagedConversationRuntime(
      changed.state,
      update({
        execution: { ...update().execution, executionGeneration: 2 },
        latestCommand: null,
        runtimeItemChange: { kind: "reset" }
      })
    );

    expect(changed.requiresSnapshot).toBe(true);
    expect(changed.state.executionGeneration).toBe(2);
    expect(reset.requiresSnapshot).toBe(true);
  });
});
