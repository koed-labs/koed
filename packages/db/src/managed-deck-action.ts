import { createHash } from "node:crypto";
import {
  createDeckSchema,
  createTeamDeckSchema,
  koedTextActionInputSchemas,
  type CreateDeck,
  type CreateTeamDeck,
  type Deck
} from "@koed/shared";

/** The journal ID, not a model argument, is the Deck creation key. */
export const deckCreateFromTextAction = (
  actionId: string,
  argumentsValue: Record<string, unknown>,
  agentId: string | null
): CreateDeck => {
  const args = koedTextActionInputSchemas.koed_deck_make.parse(argumentsValue);
  return createDeckSchema.parse({
    idempotencyKey: actionId,
    title: args.title,
    scope: args.scope,
    madeFrom: args.madeFrom,
    ...(agentId ? { createdByAgentId: agentId } : {}),
    cards: args.cards
  });
};

/** Team creation deliberately has no owner-local Agent ID. */
export const teamDeckCreateFromTextAction = (
  actionId: string,
  argumentsValue: Record<string, unknown>
): CreateTeamDeck => {
  const args = koedTextActionInputSchemas.koed_deck_make.parse(argumentsValue);
  return createTeamDeckSchema.parse({
    idempotencyKey: actionId,
    title: args.title,
    scope: args.scope,
    madeFrom: args.madeFrom,
    cards: args.cards
  });
};

/** A display sourceRef is compared as content, never treated as authority. */
export const deckMatchesTextAction = (
  deck: Deck,
  payload: CreateDeck,
  projectId: string,
  shared: boolean
): boolean =>
  deck.projectId === projectId &&
  deck.title === payload.title &&
  deck.scope === payload.scope &&
  deck.madeFrom === payload.madeFrom &&
  deck.createdByAgentId ===
    (shared ? null : (payload.createdByAgentId ?? null)) &&
  deck.cards.length === payload.cards.length &&
  deck.cards.every((card, index) => {
    const requested = payload.cards[index];
    return (
      Boolean(requested) &&
      card.question === requested!.question &&
      card.answer === requested!.answer &&
      card.sourceRef === (requested!.sourceRef ?? null) &&
      card.topicLabel === (requested!.topicLabel ?? null)
    );
  });

/** Private Team creation proof. The nonce is persisted only in the owner-local journal. */
export const teamDeckTextActionHash = (input: {
  actionId: string;
  teamBackendId: string;
  workspaceProjectId: string;
  teamUserId: string;
  runnerDeviceId: string;
  deviceCredentialKeyId: string;
  operationFamily: "team_workspace_write";
  payload: CreateTeamDeck;
  nonce: string;
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        kind: "koed_deck_make",
        actionId: input.actionId,
        teamBackendId: input.teamBackendId,
        workspaceProjectId: input.workspaceProjectId,
        teamUserId: input.teamUserId,
        runnerDeviceId: input.runnerDeviceId,
        deviceCredentialKeyId: input.deviceCredentialKeyId,
        operationFamily: input.operationFamily,
        payload: input.payload,
        nonce: input.nonce
      })
    )
    .digest("hex");
