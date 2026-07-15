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
  getSourceContext(input: {
    userId: string;
    groupId: string;
  }): Promise<PdsSecureSourceKeyContext | null>;
}

const forbiddenField =
  /(?:api[_-]?token|credential|secret|password|authorization|cookie|path|cwd|project|workspace|team|derived|vector|embedding|lcm|database|queue|private[_-]?key|access[_-]?key)/i;
const exportedMetadata = new Set([
  "contentType",
  "sourceRole",
  "toolCallId",
  "toolName"
]);

const fieldName = (value: string): string =>
  value.replace(/[^a-z0-9]/gi, "").toLowerCase();

/** Reject sensitive data at every nesting level before adapter parsing. */
const assertNoForbiddenField = (value: unknown): void => {
  if (Array.isArray(value)) {
    value.forEach(assertNoForbiddenField);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenField.test(fieldName(key))) {
      throw new TypeError("PDS source contains forbidden field");
    }
    assertNoForbiddenField(child);
  }
};

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
  }
  throw new TypeError("PDS source adapter payload is not exportable");
};

const sourceMetadata = (metadata: Record<string, unknown>) =>
  Object.fromEntries(
    [...exportedMetadata]
      .map((key) => [key, metadata[key]] as const)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
  );

/** Builds immutable protocol source records. Never serializes arbitrary raw JSON. */
export const pdsConversationItemsForClosure = (
  source: PdsClosureSource
): PdsConversationSourceItem[] =>
  source.items.map((item, index) => {
    assertNoForbiddenField(item.rawJson);
    assertNoForbiddenField(item.metadata);
    return {
      sourceNativeItemId: item.externalItemId,
      sequence: String(index),
      sourceTimestamp: item.eventTime,
      observedAt: item.observedAt,
      actor: item.sourceKind,
      type: item.sourceRecordType,
      content: sourceContent(item),
      metadata: sourceMetadata(item.metadata)
    };
  });
