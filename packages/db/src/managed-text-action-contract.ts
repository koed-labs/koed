import type { KoedTextActionName } from "@koed/shared";

export type ManagedTextActionState =
  | "awaiting_review"
  | "ready"
  | "claimed"
  | "applied"
  | "declined"
  | "uncertain"
  | "unavailable";

export type ManagedTextActionRecord = {
  id: string;
  ownerUserId: string;
  logicalSessionId: string;
  executionId: string;
  commandId: string;
  executionGeneration: number;
  providerTurnId: string;
  toolCallId: string;
  name: KoedTextActionName;
  arguments: Record<string, unknown>;
  /** Immutable owner-private target IDs, expected versions, and effect key. */
  snapshot: Record<string, unknown>;
  state: ManagedTextActionState;
  revision: number;
  reviewKind: "none" | "ask_first" | "native";
  createdAt: string;
  decidedAt: string | null;
  /** Stable key the owned button service must use for an effect. */
  effectKey: string;
};

export interface ManagedTextActionRepository {
  enqueueManagedTextAction(
    actor: { userId: string },
    input: {
      executionId: string;
      commandId: string;
      leaseToken: string;
      executionGeneration: number;
      providerTurnId: string;
      toolCallId: string;
      name: KoedTextActionName;
      arguments: Record<string, unknown>;
    }
  ): Promise<ManagedTextActionRecord | null>;
  listManagedTextActions(
    actor: { userId: string },
    executionId: string
  ): Promise<ManagedTextActionRecord[]>;
  decideManagedTextAction(
    actor: { userId: string },
    input: {
      executionId: string;
      actionId: string;
      expectedRevision: number;
      decision: "approve" | "decline";
    }
  ): Promise<ManagedTextActionRecord | null>;
  claimManagedTextAction(
    actor: { userId: string },
    input: { executionId: string; actionId: string; expectedRevision: number }
  ): Promise<ManagedTextActionRecord | null>;
  completeManagedTextAction(
    actor: { userId: string },
    input: { executionId: string; actionId: string; expectedRevision: number }
  ): Promise<ManagedTextActionRecord | null>;
  prepareManagedTextTeamTodoAdd(
    actor: { userId: string },
    input: { executionId: string; actionId: string; expectedRevision: number }
  ): Promise<{ action: ManagedTextActionRecord; effectNonce: string } | null>;
  reconcileManagedTextAction(
    actor: { userId: string },
    input: { executionId: string; actionId: string }
  ): Promise<ManagedTextActionRecord | null>;
}
