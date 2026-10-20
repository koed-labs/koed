import type {
  MemorySourceRepository,
  ManagedMemoryActionResult
} from "@koed/db";
import {
  memoryActionRequestText,
  memoryCorrectInputSchema,
  memoryForgetInputSchema
} from "@koed/mcp-server";
import { selectManagedMemoryCitation } from "./memory-action-selection.js";

export type ManagedMemoryActionEvent = {
  execution: { id: string; ownerUserId: string; executionGeneration: number };
  command: { id: string; leaseToken: string | null };
  providerTurnId: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  result: unknown;
};

type Repository = Pick<
  MemorySourceRepository,
  | "getManagedConversationCommand"
  | "getManagedConversationExecution"
  | "getManagedConversationRuntimeBinding"
  | "enqueueManagedMemoryAction"
  | "listManagedMemoryActionsForCommand"
  | "withManagedMemoryActionLease"
  | "listLcmGraphEvents"
  | "listManagedConversationCitationsByAliases"
  | "getManagedConversationCitationLocator"
  | "getManagedPersonalQuestionCitation"
  | "getCuratedMemoryAssertion"
  | "suppressCuratedMemoryAssertion"
  | "resolveCuratedMemoryProposalEvidence"
  | "getManagedMemoryActionUserSource"
  | "findManagedMemoryCorrectionProposal"
  | "resolveManagedMemorySourceSession"
  | "createCuratedMemoryProposal"
  | "putManagedConversationRuntimeItem"
>;

const aliasesIn = (content: string): string[] =>
  [...content.matchAll(/\[m:(r[0-9a-f]{32}c[1-9][0-9]*)\]/g)].map(
    (match) => match[1]!
  );

const validReceipt = (event: ManagedMemoryActionEvent): boolean => {
  if (event.toolName !== "memory_forget" && event.toolName !== "memory_correct")
    return false;
  const value = event.result;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as {
    isError?: unknown;
    structuredContent?: unknown;
    details?: unknown;
    content?: unknown;
  };
  if (result.isError === true) return false;
  const structured = result.structuredContent ?? result.details;
  if (structured !== undefined)
    return (
      !!structured &&
      typeof structured === "object" &&
      !Array.isArray(structured) &&
      (structured as { status?: unknown }).status === "requested"
    );
  const block: unknown = Array.isArray(result.content)
    ? result.content[0]
    : null;
  return (
    Array.isArray(result.content) &&
    result.content.length === 1 &&
    !!block &&
    typeof block === "object" &&
    !Array.isArray(block) &&
    (block as { type?: unknown }).type === "text" &&
    (block as { text?: unknown }).text ===
      memoryActionRequestText(event.toolName)
  );
};

const promptAllows = (kind: "forget" | "correct", prompt: string): boolean => {
  const normalized = prompt.trim();
  if (/^["'“‘`]/.test(normalized)) return false;
  if (/^(?:please\s+)?(?:do not|don't|never|avoid)\b/i.test(normalized))
    return false;
  if (
    /\b(?:do not|don't|never|avoid)\s+(?:forget|remove|erase|correct|update|replace)\b/i.test(
      normalized
    )
  )
    return false;
  const polite = /^(?:can|could|would)\s+you\s+(?:please\s+)?/i;
  const imperative = /^(?:please\s+)?/i;
  const action = normalized.replace(
    polite.test(normalized) ? polite : imperative,
    ""
  );
  if (kind === "forget")
    return (
      /^(?:forget|remove|erase)\b/i.test(action) &&
      (!normalized.includes("?") || polite.test(normalized))
    );
  return (
    (/^(?:correct|update|replace)\b/i.test(action) ||
      /^(?:that(?:'s| is)|this is)\s+(?:outdated|wrong|no longer true)\b/i.test(
        normalized
      )) &&
    (!normalized.includes("?") || polite.test(normalized))
  );
};

export const createManagedMemoryActionObserver =
  (repository: Repository) =>
  async (event: ManagedMemoryActionEvent): Promise<boolean> => {
    if (!validReceipt(event) || !event.command.leaseToken) return false;
    const actor = { userId: event.execution.ownerUserId };
    const command = await repository.getManagedConversationCommand(
      actor,
      event.command.id
    );
    if (
      !command ||
      command.executionId !== event.execution.id ||
      command.commandKind !== "prompt" ||
      command.leaseToken !== event.command.leaseToken ||
      command.state !== "dispatching" ||
      command.executionGeneration !== event.execution.executionGeneration ||
      typeof command.payload?.prompt !== "string"
    )
      return false;
    const kind = event.toolName === "memory_forget" ? "forget" : "correct";
    const prompt = command.payload.prompt.trim();
    if (!promptAllows(kind, prompt)) return false;
    const forgetInput =
      kind === "forget"
        ? memoryForgetInputSchema.safeParse(event.arguments)
        : null;
    const correctInput =
      kind === "correct"
        ? memoryCorrectInputSchema.safeParse(event.arguments)
        : null;
    if (forgetInput?.success === false || correctInput?.success === false)
      return false;
    const parsed = forgetInput?.success
      ? forgetInput.data
      : correctInput?.success
        ? correctInput.data
        : null;
    if (!parsed) return false;
    const request = {
      userPrompt: prompt,
      ...(parsed.citation_alias
        ? { requestedAlias: parsed.citation_alias }
        : {}),
      ...(parsed.reference ? { reference: parsed.reference } : {}),
      ...(correctInput?.success
        ? {
            correction: correctInput.data.correction,
            userStatement: correctInput.data.user_statement
          }
        : {})
    };
    return Boolean(
      await repository.enqueueManagedMemoryAction(actor, {
        executionId: event.execution.id,
        commandId: command.id,
        leaseToken: event.command.leaseToken,
        executionGeneration: event.execution.executionGeneration,
        providerTurnId: event.providerTurnId,
        toolCallId: event.toolCallId,
        actionKind: kind,
        request
      })
    );
  };

export const createManagedMemoryActionProcessor =
  (repository: Repository, deploymentId: string) =>
  async (input: {
    ownerUserId: string;
    executionId: string;
    commandId: string;
    leaseToken: string;
    executionGeneration: number;
  }): Promise<void> => {
    const actor = { userId: input.ownerUserId };
    const [command, execution, binding, actions] = await Promise.all([
      repository.getManagedConversationCommand(actor, input.commandId),
      repository.getManagedConversationExecution(actor, input.executionId),
      repository.getManagedConversationRuntimeBinding(actor, input.executionId),
      repository.listManagedMemoryActionsForCommand(actor, input.commandId)
    ]);
    if (
      !command ||
      !execution ||
      !binding?.localSessionId ||
      command.executionId !== execution.id ||
      command.leaseToken !== input.leaseToken ||
      command.state !== "dispatching" ||
      command.executionGeneration !== input.executionGeneration ||
      execution.executionGeneration !== input.executionGeneration ||
      binding.executionGeneration !== input.executionGeneration ||
      !execution.providerThreadId ||
      !command.clientUserMessageId
    )
      return;
    for (const action of actions) {
      if (action.state !== "pending") continue;
      const finished = await repository.withManagedMemoryActionLease(
        actor,
        {
          actionId: action.id,
          commandId: command.id,
          leaseToken: input.leaseToken
        },
        async (lockedAction, authority): Promise<ManagedMemoryActionResult> => {
          const ask = (message: string): ManagedMemoryActionResult => ({
            outcome: "ask_reference",
            message
          });
          if (
            authority.localSessionId !== binding.localSessionId ||
            authority.clientUserMessageId !== command.clientUserMessageId
          )
            return {
              outcome: "unavailable",
              message: "Conversation authority changed. Please try again."
            };
          const prompt = lockedAction.request.userPrompt;
          if (
            !promptAllows(lockedAction.actionKind, prompt) ||
            typeof command.payload?.prompt !== "string" ||
            prompt !== command.payload.prompt.trim()
          )
            return {
              outcome: "unavailable",
              message: "The original User request cannot be verified."
            };
          const visible = await repository.listLcmGraphEvents(actor, {
            threadId: execution.providerThreadId!,
            visibility: "personal",
            includeContent: true,
            limit: 500
          });
          const events = visible.filter(
            (item) => item.sessionId === authority.localSessionId
          );
          const aliases = [
            ...new Set(
              events
                .filter(
                  (item) =>
                    (item.actor === "assistant" || item.actor === "agent") &&
                    Date.parse(item.timestamp) < Date.parse(command.createdAt)
                )
                .flatMap((item) => aliasesIn(item.content ?? ""))
            )
          ].slice(0, 64);
          const citations = aliases.length
            ? await repository.listManagedConversationCitationsByAliases(
                actor,
                {
                  executionId: execution.id,
                  aliases
                }
              )
            : [];
          const selected = selectManagedMemoryCitation({
            assistantEvents: events,
            citations,
            userPrompt: prompt,
            requestedAlias: lockedAction.request.requestedAlias,
            commandCreatedAt: command.createdAt
          });
          if (selected.kind !== "selected")
            return ask(
              "Which cited memory do you mean? Please use its citation number."
            );
          const citation = selected.citation;
          if (citation.visibility === "team")
            return {
              outcome: "ask_owner",
              message:
                "That memory belongs to a teammate. Ask its owner to change it.",
              citationAlias: citation.alias
            };
          const locator =
            await repository.getManagedConversationCitationLocator(actor, {
              executionId: execution.id,
              providerTurnId: citation.providerTurnId,
              alias: citation.alias
            });
          if (
            !locator ||
            locator.visibility !== "personal" ||
            locator.backendId !== deploymentId ||
            locator.sourceNamespace !== deploymentId ||
            locator.sourceOwnerPrincipalId !== actor.userId ||
            locator.sourceType !== citation.sourceType ||
            locator.sourceId !== citation.sourceId
          )
            return {
              outcome: "unavailable",
              message: "This memory source is unavailable."
            };
          const ownedAssertion =
            citation.sourceType === "curated_memory"
              ? await repository.getCuratedMemoryAssertion(
                  actor,
                  citation.sourceId
                )
              : null;
          if (
            lockedAction.actionKind === "forget" &&
            ownedAssertion &&
            ownedAssertion.ownerUserId === actor.userId &&
            ownedAssertion.visibility === "personal" &&
            ownedAssertion.suppressedAt &&
            ownedAssertion.suppressionReason ===
              `managed-memory-action:${lockedAction.id}` &&
            ownedAssertion.suppressionToken
          )
            return {
              outcome: "forgotten",
              message: "Forgot this memory. Undo is available for seven days.",
              assertionId: ownedAssertion.id,
              suppressionToken: ownedAssertion.suppressionToken,
              citationAlias: citation.alias
            };
          const current = await repository.getManagedPersonalQuestionCitation(
            { ...actor, allowTeam: false },
            { questionId: locator.questionId, ordinal: locator.ordinal }
          );
          if (
            !current ||
            current.sourceType !== locator.sourceType ||
            current.sourceId !== locator.sourceId ||
            current.sourceOwnerPrincipalId !== actor.userId
          )
            return {
              outcome: "unavailable",
              message: "This memory source is unavailable."
            };
          if (citation.sourceType !== "curated_memory") {
            const sourceSessionId =
              await repository.resolveManagedMemorySourceSession(actor, {
                sourceType: citation.sourceType,
                sourceId: citation.sourceId
              });
            return sourceSessionId
              ? {
                  outcome: "offer_chat_forget",
                  message:
                    "Forget the chat this came from? Confirm in the chat controls first.",
                  citationAlias: citation.alias,
                  sourceSessionId
                }
              : ask(
                  "This memory is linked to more than one chat or its chat is unavailable. Which chat do you mean?"
                );
          }
          const assertion = ownedAssertion;
          if (
            !assertion ||
            assertion.ownerUserId !== actor.userId ||
            assertion.visibility !== "personal"
          )
            return {
              outcome: "unavailable",
              message: "This assertion is unavailable."
            };
          if (lockedAction.actionKind === "forget") {
            if (assertion.suppressedAt) {
              return {
                outcome: "unavailable",
                message: "This assertion was already changed."
              };
            }
            if (assertion.status !== "current")
              return {
                outcome: "unavailable",
                message: "This assertion is no longer current."
              };
            const suppressed = await repository.suppressCuratedMemoryAssertion(
              actor,
              assertion.id,
              {
                reason: `managed-memory-action:${lockedAction.id}`
              }
            );
            if (!suppressed?.suppressionToken)
              return {
                outcome: "unavailable",
                message: "This assertion could not be forgotten."
              };
            return {
              outcome: "forgotten",
              message: "Forgot this memory. Undo is available for seven days.",
              assertionId: assertion.id,
              suppressionToken: suppressed.suppressionToken,
              citationAlias: citation.alias
            };
          }
          const correction = lockedAction.request.correction?.trim();
          if (
            !correction ||
            lockedAction.request.userStatement?.trim() !== prompt ||
            !prompt.toLocaleLowerCase().includes(correction.toLocaleLowerCase())
          )
            return {
              outcome: "ask_reference",
              message: "Please state the exact correction in your own words."
            };
          const sourceId = await repository.getManagedMemoryActionUserSource(
            actor,
            {
              commandId: command.id,
              clientUserMessageId: authority.clientUserMessageId,
              localSessionId: authority.localSessionId
            }
          );
          if (!sourceId)
            return {
              outcome: "unavailable",
              message:
                "The current User statement was not captured as source evidence."
            };
          const existingProposalId =
            await repository.findManagedMemoryCorrectionProposal(
              actor,
              lockedAction.id
            );
          if (existingProposalId)
            return {
              outcome: "proposal_created",
              message: "Your correction is queued for source-backed review.",
              proposalId: existingProposalId,
              citationAlias: citation.alias
            };
          const proposal = await repository.createCuratedMemoryProposal(actor, {
            proposedClaim: correction,
            evidenceConversationItemIds: [sourceId],
            operation: "supersede",
            targetAssertionId: assertion.id,
            createdByModel: "managed-memory-correct",
            createdByPromptVersion: `memory-correct-v1:${lockedAction.id}`
          });
          return {
            outcome: "proposal_created",
            message: "Your correction is queued for source-backed review.",
            proposalId: proposal.id,
            citationAlias: citation.alias
          };
        }
      );
      if (finished?.result) {
        await repository.putManagedConversationRuntimeItem(actor, {
          executionId: execution.id,
          executionGeneration: execution.executionGeneration,
          providerRequestId: `memory-action:${action.id}`,
          providerTurnId: action.providerTurnId,
          providerItemId: action.toolCallId,
          itemKind: "transient_output",
          payload: {
            text: finished.result.message,
            actionId: action.id,
            outcome: finished.result.outcome
          }
        });
      }
    }
  };
