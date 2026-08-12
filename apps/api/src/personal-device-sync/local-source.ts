import type {
  PdsConversationSourceItem,
  PdsSessionPackage
} from "@koed/shared";
import type { PdsClosureSource } from "@koed/db";

export interface PdsSecureSourceKeyContext {
  /** Opaque references only. Never serialize, log, persist, or derive from API Tokens. */
  deviceSigningPrivateKeyRef: string;
  deviceKemPrivateKeyRef: string;
  groupSecretSetRef: string;
  originDeploymentId: string;
  originDeviceId: string;
  buildClosedSessionPackage(input: {
    source: PdsClosureSource;
    sourceSequence: string;
    items: PdsConversationSourceItem[];
    closedAt: Date;
  }): Promise<{
    package: PdsSessionPackage;
    sourceClosureHash: string;
    sourceManifestHash: string;
    sourceFingerprint: string;
    logicalMemoryId: string;
    deletionFloorToken: string;
  }>;
}

/**
 * Secure-runtime boundary. Implementations resolve hardware/OS-secret references
 * internally; no API config, DB record, API Token, upstream credential, or log
 * can provide PDS signing/KEM/group key material.
 */
export interface PdsSecureKeyProvider {
  isReady?(): Promise<boolean>;
  getSourceContext(input: {
    userId: string;
    groupId: string;
  }): Promise<PdsSecureSourceKeyContext | null>;
}

const exportedMetadata = new Set([
  "contentType",
  "parentSourceComponentId",
  "sourceComponentId",
  "sourceComponentRole",
  "sourceRole",
  "toolCallId",
  "toolName"
]);

const semanticActors = new Set([
  "user",
  "agent",
  "assistant",
  "subagent",
  "tool",
  "system"
]);

const contentlessControlTypes = new Set([
  "session_meta",
  "task_started",
  "task_complete",
  "turn_aborted",
  "turn_context",
  "thread/start",
  "thread/started",
  "thread/resume",
  "thread/fork",
  "turn/started",
  "turn/completed",
  "pds_session_closed"
]);

const boundedText = (value: unknown): string | null =>
  typeof value === "string" && Buffer.byteLength(value, "utf8") <= 512 * 1024
    ? value
    : null;

/**
 * PDS source payload is adapter data, not an export of raw_json. Keep this
 * allowlist deliberately small; adding a field changes wire privacy surface.
 */
const codexContent = (raw: unknown): string | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const direct = boundedText(value.content) ?? boundedText(value.text);
  if (direct !== null) return direct;
  const params = value.params;
  if (!params || typeof params !== "object" || Array.isArray(params))
    return null;
  const item = (params as Record<string, unknown>).item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  return (
    boundedText((item as Record<string, unknown>).text) ??
    boundedText((item as Record<string, unknown>).content)
  );
};

const sourceContent = (item: PdsClosureSource["items"][number]): string => {
  const rawText = boundedText(item.rawText);
  if (rawText !== null) return rawText;
  if (item.sourceKind === "codex" || item.sourceKind === "codex-cli") {
    const content = codexContent(item.rawJson);
    if (content !== null) return content;
    const sourceType = item.sourceEventType ?? item.sourceRecordType;
    if (
      contentlessControlTypes.has(sourceType) ||
      item.metadata.semanticControl === "turn_completed"
    ) {
      return "";
    }
  }
  throw new TypeError("PDS source adapter payload is not exportable");
};

const semanticActor = (item: PdsClosureSource["items"][number]): string => {
  const canonicalActor = item.metadata.canonicalConversationItemActor;
  if (
    typeof canonicalActor === "string" &&
    semanticActors.has(canonicalActor)
  ) {
    return canonicalActor;
  }
  const sourceRole = item.metadata.sourceRole;
  if (typeof sourceRole === "string" && semanticActors.has(sourceRole)) {
    return sourceRole;
  }
  const label = `${item.sourceEventType ?? ""} ${item.sourceRecordType}`;
  if (/user/i.test(label)) return "user";
  if (/subagent/i.test(label)) return "subagent";
  if (/agent|assistant|reasoning|thought/i.test(label)) return "agent";
  if (/tool|function_call|custom_tool/i.test(label)) return "tool";
  return "system";
};

const sourceMetadata = (metadata: Record<string, unknown>, actor: string) => {
  const sourceComponentId =
    typeof metadata.sourceComponentId === "string"
      ? metadata.sourceComponentId
      : undefined;
  const sourceComponentRole =
    metadata.sourceComponentRole === "primary" ||
    metadata.sourceComponentRole === "auxiliary"
      ? metadata.sourceComponentRole
      : sourceComponentId
        ? sourceComponentId === "main"
          ? "primary"
          : "auxiliary"
        : undefined;
  const parentSourceComponentId =
    typeof metadata.parentSourceComponentId === "string"
      ? metadata.parentSourceComponentId
      : sourceComponentRole === "auxiliary"
        ? "main"
        : undefined;
  return {
    ...Object.fromEntries(
      [...exportedMetadata]
        .map((key) => [key, metadata[key]] as const)
        .filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
    ),
    sourceRole: actor,
    ...(sourceComponentId ? { sourceComponentId } : {}),
    ...(sourceComponentRole ? { sourceComponentRole } : {}),
    ...(parentSourceComponentId ? { parentSourceComponentId } : {})
  };
};

/** Builds immutable protocol source records. Never serializes arbitrary raw JSON. */
export const pdsConversationItemsForClosure = (
  source: PdsClosureSource
): PdsConversationSourceItem[] =>
  source.items.map((item, index) => {
    const actor = semanticActor(item);
    return {
      sourceNativeItemId: item.externalItemId,
      sequence: String(index),
      sourceTimestamp: item.eventTime,
      observedAt: item.observedAt,
      actor,
      type: item.sourceEventType ?? item.sourceRecordType,
      content: sourceContent(item),
      metadata: sourceMetadata(item.metadata, actor)
    };
  });
