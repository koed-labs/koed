import type {
  PdsConversationSourceItem,
  PdsSessionCheckpointManifest,
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
  buildCompletedTurnCheckpointPackage(input: {
    source: PdsClosureSource;
    sourceSequence: string;
    items: PdsConversationSourceItem[];
    checkpoint: {
      version: "1";
      ordinal: string;
      previousClosureHash: string | null;
    };
  }): Promise<{
    manifest: PdsSessionCheckpointManifest;
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
  "turn_completed",
  "hook_signal",
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
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const textValue = (value: unknown): string | null => {
  const direct = boundedText(value);
  if (direct !== null) return direct;
  if (!Array.isArray(value)) return null;
  const blocks = value.map((block) => {
    const item = record(block);
    return (
      boundedText(item?.text) ??
      boundedText(item?.inputText) ??
      boundedText(item?.outputText)
    );
  });
  if (blocks.some((block) => block === null)) return null;
  const joined = blocks.join("");
  return Buffer.byteLength(joined, "utf8") <= 512 * 1024 ? joined : null;
};

const codexContent = (raw: unknown): string | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const direct = textValue(value.content) ?? boundedText(value.text);
  if (direct !== null) return direct;
  const params = record(value.params);
  const item = record(params?.item);
  if (!item) return null;
  return (
    boundedText(item.text) ??
    textValue(item.content) ??
    boundedText(item.summary)
  );
};

const piContent = (item: PdsClosureSource["items"][number]): string | null => {
  const raw = record(item.rawJson);
  if (raw?.type !== "pi_session_record") return null;
  const block = record(raw.contentBlock);
  if (block?.type === "text") return boundedText(block.text);
  if (block?.type === "toolCall") {
    const name = boundedText(block.name);
    const args = block.arguments;
    if (name === null || !record(args)) return null;
    const content = `Tool call: ${name}\n\nInput: ${JSON.stringify(args)}`;
    return Buffer.byteLength(content, "utf8") <= 512 * 1024 ? content : null;
  }
  if (block?.type === "thinking") return boundedText(block.thinking);
  const message = record(record(raw.sourceRecord)?.message);
  if (message?.role === "toolResult") {
    const content = textValue(message.content);
    if (content !== null)
      return content || "Tool completed without text output.";
  }
  if (message?.role === "bashExecution") {
    const command = boundedText(message.command);
    const output = boundedText(message.output);
    if (command !== null && output !== null) {
      const content = `Command: ${command}\n\n${output}`;
      return Buffer.byteLength(content, "utf8") <= 512 * 1024 ? content : null;
    }
  }
  return null;
};

const sourceContent = (
  item: PdsClosureSource["items"][number],
  sourceRuntime?: string
): string => {
  const rawText = boundedText(item.rawText);
  if (rawText !== null) return rawText;
  const sourceType = item.sourceEventType ?? item.sourceRecordType;
  if (
    contentlessControlTypes.has(sourceType) ||
    item.metadata.semanticControl === "turn_completed"
  ) {
    return "";
  }
  if (sourceRuntime === "pi" || item.sourceKind === "pi") {
    const content = piContent(item);
    if (content !== null) return content;
    const sourceRecordType = record(item.rawJson);
    const entry = record(sourceRecordType?.sourceRecord);
    if (
      entry &&
      (item.sourceEventType === "unknown" ||
        [
          "session",
          "compaction",
          "branch_summary",
          "custom",
          "model_change",
          "thinking_level"
        ].includes(String(entry.type)))
    ) {
      return "";
    }
  }
  if (
    sourceRuntime === "codex" ||
    sourceRuntime === "codex-cli" ||
    item.sourceKind === "codex" ||
    item.sourceKind === "codex-cli"
  ) {
    const content = codexContent(item.rawJson);
    if (content !== null) return content;
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
      content: sourceContent(
        item,
        typeof item.metadata.sourceRuntime === "string"
          ? item.metadata.sourceRuntime
          : source.sourceRuntime
      ),
      metadata: sourceMetadata(item.metadata, actor)
    };
  });
