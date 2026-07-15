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

const forbiddenKeys = new Set([
  "path",
  "cwd",
  "project",
  "workspace",
  "team",
  "vector",
  "embedding",
  "lcm",
  "credential",
  "token",
  "secret",
  "key",
  "database",
  "queue"
]);

const assertNoForbiddenField = (value: unknown): void => {
  if (Array.isArray(value)) {
    value.forEach(assertNoForbiddenField);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key.toLowerCase())) {
      throw new TypeError("PDS source contains forbidden field");
    }
    assertNoForbiddenField(child);
  }
};

const text = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/** Builds immutable protocol source records. No raw path or derived Memory field crosses boundary. */
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
      content: text(item.rawText ?? item.rawJson),
      metadata: {
        ...(typeof item.metadata.contentType === "string"
          ? { contentType: item.metadata.contentType }
          : {}),
        ...(typeof item.metadata.sourceRole === "string"
          ? { sourceRole: item.metadata.sourceRole }
          : {}),
        ...(typeof item.metadata.toolName === "string"
          ? { toolName: item.metadata.toolName }
          : {}),
        ...(typeof item.metadata.toolCallId === "string"
          ? { toolCallId: item.metadata.toolCallId }
          : {})
      }
    };
  });
