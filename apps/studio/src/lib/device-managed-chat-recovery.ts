/**
 * Device-local recovery for Studio managed chats. The record is never sent to
 * a managed-conversation API; callers must first resolve the current owner.
 * Scope every store by backend, owner, and execution (or `new` before a start
 * has returned an execution ID) so account or backend changes cannot restore
 * another chat's local state.
 */
export type DeviceManagedChatPendingOperation = Readonly<{
  kind: "start" | "prompt";
  startIdempotencyKey: string;
  promptIdempotencyKey: string;
  clientUserMessageId: string;
  executionGeneration?: number;
  prompt: string;
  state: "pending" | "reconciling" | "accepted" | "rejected";
  commandId?: string;
}>;

export type DeviceManagedChatRecoveryRecord = Readonly<{
  schemaVersion: 1;
  draft: string;
  pendingOperation?: DeviceManagedChatPendingOperation;
}>;

export type DeviceManagedChatRecoveryStore = Readonly<{
  read: () => DeviceManagedChatRecoveryRecord | null;
  write: (record: DeviceManagedChatRecoveryRecord) => void;
  clear: () => void;
}>;

export type DeviceManagedChatStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const prefix = "koed.studio.managed-chat-recovery.v1";
const maxRecordLength = 300_000;
const identityPart = (value: string) => encodeURIComponent(value.trim());

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRecoveryRecord(value: string | null): DeviceManagedChatRecoveryRecord | null {
  if (!value || value.length > maxRecordLength) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.draft !== "string") return null;
    const candidate = parsed.pendingOperation;
    if (candidate === undefined) return { schemaVersion: 1, draft: parsed.draft };
    if (
      !isRecord(candidate) ||
      (candidate.kind !== "start" && candidate.kind !== "prompt") ||
      typeof candidate.startIdempotencyKey !== "string" ||
      typeof candidate.promptIdempotencyKey !== "string" ||
      typeof candidate.clientUserMessageId !== "string" ||
      (candidate.executionGeneration !== undefined &&
        (typeof candidate.executionGeneration !== "number" ||
          !Number.isSafeInteger(candidate.executionGeneration) ||
          candidate.executionGeneration < 0)) ||
      typeof candidate.prompt !== "string" ||
      !["pending", "reconciling", "accepted", "rejected"].includes(String(candidate.state)) ||
      (candidate.commandId !== undefined && typeof candidate.commandId !== "string")
    ) return null;
    return {
      schemaVersion: 1,
      draft: parsed.draft,
      pendingOperation: {
        kind: candidate.kind,
        startIdempotencyKey: candidate.startIdempotencyKey,
        promptIdempotencyKey: candidate.promptIdempotencyKey,
        clientUserMessageId: candidate.clientUserMessageId,
        ...(typeof candidate.executionGeneration === "number"
          ? { executionGeneration: candidate.executionGeneration }
          : {}),
        prompt: candidate.prompt,
        state: candidate.state as DeviceManagedChatPendingOperation["state"],
        ...(typeof candidate.commandId === "string" ? { commandId: candidate.commandId } : {})
      }
    };
  } catch {
    return null;
  }
}

/**
 * Create a device-only recovery store. Pass a Storage implementation in tests;
 * the default touches localStorage only when called in a browser. A null
 * execution ID selects the single pending new-chat slot for this owner/backend.
 */
export function createDeviceManagedChatRecoveryStore(input: {
  ownerId: string;
  backendId: string;
  executionId: string | null;
  storage?: DeviceManagedChatStorage;
}): DeviceManagedChatRecoveryStore | null {
  const ownerId = input.ownerId.trim();
  const backendId = input.backendId.trim();
  if (!ownerId || !backendId) return null;
  const storage = input.storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
  if (!storage) return null;
  const conversation = input.executionId?.trim() || "new";
  const key = `${prefix}:${identityPart(backendId)}:${identityPart(ownerId)}:${identityPart(conversation)}`;
  return {
    read: () => {
      try {
        return parseRecoveryRecord(storage.getItem(key));
      } catch {
        return null;
      }
    },
    write: (record) => {
      const serialized = JSON.stringify(record);
      if (serialized.length > maxRecordLength) throw new Error("Chat recovery record is too large.");
      try {
        storage.setItem(key, serialized);
      } catch {
        // Storage may be disabled or full. Recovery is best-effort and must not
        // block a send whose authority is the managed conversation service.
      }
    },
    clear: () => {
      try {
        storage.removeItem(key);
      } catch {
        // Clearing recovery must not block navigation or a confirmed send.
      }
    }
  };
}
