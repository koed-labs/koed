export type ConversationSourceObservationKind =
  | "snapshot"
  | "lifecycle_started"
  | "lifecycle_completed"
  | "control"
  | "reconciliation";

export const KOED_MANAGED_CONVERSATION_ENV = "KOED_MANAGED_CONVERSATION";

export interface RawConversationItemRequest extends Record<string, unknown> {
  id?: string;
  observationOnly?: boolean;
  sourceKind: string;
  sourceAdapterVersion: string;
  sourceTransport: string;
  sessionId?: string;
  externalSessionId?: string;
  externalThreadId?: string;
  externalTurnId?: string;
  externalItemId?: string;
  parentExternalItemId?: string;
  sourceRecordType: string;
  sourceEventType?: string;
  sourceLineNumber?: number;
  sourceSequence?: number;
  eventTime?: string;
  observedAt?: string;
  rawJson: unknown;
  rawText?: string;
  logicalSourceId?: string;
  transportChunkIndex?: number;
  transportChunkCount?: number;
  transportChunkText?: string;
  transportChunkEncoding?: string;
  sourceHash: string;
  idempotencyKey: string;
  canonicalItemKey?: string;
  canonicalStableItemId?: string;
  canonicalSourcePriority?: number;
  observationKind?: ConversationSourceObservationKind;
  observationComponent?: string;
  projectionStatus: string;
  projectionVersion: string;
  metadata: Record<string, unknown>;
}
