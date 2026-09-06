import type { CollaborationRendererEvent } from "@koed/shared/collaboration";

import type {
  ManagedConversationResult,
  ManagedConversationRuntimeItem
} from "../../ipc/managed-conversation-protocol.js";

export type ManagedConversationRealtimeUpdate = Extract<
  Extract<CollaborationRendererEvent, { type: "update" }>["update"],
  { type: "managed_conversation_upserted" }
>;

export type ManagedConversationRuntimeSnapshot = Extract<
  ManagedConversationResult,
  { operation: "runtime" }
>;

export type ManagedConversationRuntimeState = {
  executionGeneration: number;
  executionStateVersion: number;
  executionState: string;
  executionLastErrorCode: string | null;
  latestCommand: ManagedConversationRuntimeSnapshot["latestCommand"];
  items: ManagedConversationRuntimeItem[];
  itemRevisions: ReadonlyMap<string, number>;
};

export type ManagedConversationRuntimeReduction = {
  state: ManagedConversationRuntimeState;
  requiresSnapshot: boolean;
};

export const managedConversationRuntimeStateFromSnapshot = (
  snapshot: ManagedConversationRuntimeSnapshot
): ManagedConversationRuntimeState => ({
  executionGeneration: snapshot.executionGeneration,
  executionStateVersion: snapshot.executionStateVersion,
  executionState: snapshot.executionState,
  executionLastErrorCode: snapshot.executionLastErrorCode,
  latestCommand: snapshot.latestCommand,
  items: snapshot.items,
  itemRevisions: new Map(snapshot.items.map((item) => [item.id, item.revision]))
});

const commandIsNewer = (
  candidate: NonNullable<ManagedConversationRuntimeState["latestCommand"]>,
  current: ManagedConversationRuntimeState["latestCommand"]
): boolean =>
  !current ||
  candidate.executionGeneration > current.executionGeneration ||
  (candidate.executionGeneration === current.executionGeneration &&
    (candidate.sequence > current.sequence ||
      (candidate.sequence === current.sequence &&
        Date.parse(candidate.updatedAt) >= Date.parse(current.updatedAt))));

const upsertRuntimeItem = (
  items: ManagedConversationRuntimeItem[],
  candidate: ManagedConversationRuntimeItem
): ManagedConversationRuntimeItem[] => {
  const index = items.findIndex((item) => item.id === candidate.id);
  if (index === -1) return [...items, candidate];
  const current = items[index]!;
  if (
    candidate.executionGeneration < current.executionGeneration ||
    (candidate.executionGeneration === current.executionGeneration &&
      candidate.revision < current.revision)
  ) {
    return items;
  }
  if (candidate === current) return items;
  const next = [...items];
  next[index] = candidate;
  return next;
};

export const reduceManagedConversationRuntime = (
  current: ManagedConversationRuntimeState,
  update: ManagedConversationRealtimeUpdate
): ManagedConversationRuntimeReduction => {
  const generation = update.execution.executionGeneration;
  if (generation < current.executionGeneration) {
    return { state: current, requiresSnapshot: false };
  }

  const generationChanged = generation > current.executionGeneration;
  let next: ManagedConversationRuntimeState = generationChanged
    ? {
        executionGeneration: generation,
        executionStateVersion: update.execution.stateVersion,
        executionState: update.execution.state,
        executionLastErrorCode: update.execution.lastErrorCode,
        latestCommand: null,
        items: [],
        itemRevisions: new Map()
      }
    : current;

  if (update.execution.stateVersion >= next.executionStateVersion) {
    next = {
      ...next,
      executionStateVersion: update.execution.stateVersion,
      executionState: update.execution.state,
      executionLastErrorCode: update.execution.lastErrorCode
    };
  }

  const command = update.latestCommand;
  if (
    command &&
    command.executionGeneration === generation &&
    commandIsNewer(command, next.latestCommand)
  ) {
    next = { ...next, latestCommand: command };
  }

  const change = update.runtimeItemChange;
  if (change?.kind === "upsert") {
    if (change.item.executionGeneration === generation) {
      const currentRevision = next.itemRevisions.get(change.item.id) ?? 0;
      if (change.item.revision >= currentRevision) {
        const items = upsertRuntimeItem(next.items, change.item);
        const itemRevisions = new Map(next.itemRevisions).set(
          change.item.id,
          change.item.revision
        );
        next = { ...next, items, itemRevisions };
      }
    }
  } else if (
    change?.kind === "remove" &&
    change.executionGeneration === generation
  ) {
    const currentRevision = next.itemRevisions.get(change.itemId) ?? 0;
    if (change.revision >= currentRevision) {
      const items = next.items.filter((item) => item.id !== change.itemId);
      const itemRevisions = new Map(next.itemRevisions).set(
        change.itemId,
        change.revision
      );
      next = { ...next, items, itemRevisions };
    }
  }

  return {
    state: next,
    requiresSnapshot: generationChanged || change?.kind === "reset"
  };
};
