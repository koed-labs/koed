import { recallFeedbackSourceAssociationHash } from "@koed/db";
import type {
  ManagedConversationRepository,
  PersonalAgentRepository,
  RecallFeedbackAnswerKind,
  RecallFeedbackSourceReference
} from "@koed/db";
import {
  parsePersonalMemoryAttributionFooter,
  personalAgentExecutionContextSchema,
  personalMemoryTurnContextSchema,
  type PersonalMemoryTurnContext
} from "@koed/shared";

export type RecallFeedbackAttribution = {
  selectedEvidence: PersonalMemoryTurnContext["evidence"];
  sourceReferences: RecallFeedbackSourceReference[];
  sourceAssociationHash: string;
};

export const verifiedRecallFeedbackAttribution = (
  output: string,
  commandId: string,
  contextValue: unknown
): RecallFeedbackAttribution | null => {
  const parsedContext = personalMemoryTurnContextSchema.safeParse(contextValue);
  if (
    !parsedContext.success ||
    parsedContext.data.status !== "available" ||
    parsedContext.data.evidence.length === 0
  ) {
    return null;
  }
  const context: PersonalMemoryTurnContext = parsedContext.data;
  const parsedFooter = parsePersonalMemoryAttributionFooter(output, {
    commandId,
    nonce: context.attributionNonce
  });
  if (!parsedFooter.attribution?.used) return null;
  const evidenceByNodeId = new Map(
    context.evidence.map((item) => [item.nodeId, item])
  );
  const selected = parsedFooter.attribution.citationNodeIds
    .map((nodeId) => evidenceByNodeId.get(nodeId))
    .filter((item): item is PersonalMemoryTurnContext["evidence"][number] =>
      Boolean(item)
    );
  const sourceReferences = selected
    .map(
      (item): RecallFeedbackSourceReference => ({
        nodeId: item.nodeId,
        sourceType: item.sourceType ?? "memory_node",
        sourceId: item.sourceId ?? null,
        sourceChunkIndex:
          typeof item.citation.sourceChunkIndex === "number" &&
          Number.isInteger(item.citation.sourceChunkIndex) &&
          item.citation.sourceChunkIndex >= 0
            ? item.citation.sourceChunkIndex
            : null,
        visibility: item.visibility,
        teamWorkspaceId: item.teamWorkspaceId ?? null
      })
    )
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId, "en"));
  return {
    selectedEvidence: selected,
    sourceReferences,
    sourceAssociationHash: recallFeedbackSourceAssociationHash(sourceReferences)
  };
};

const commandAssignedJobIds = (
  payload: Record<string, unknown> | null
): string[] => {
  if (!payload) return [];
  const ids = new Set<string>();
  const personalAgent = payload.personalAgent;
  if (
    personalAgent &&
    typeof personalAgent === "object" &&
    !Array.isArray(personalAgent) &&
    typeof (personalAgent as Record<string, unknown>).jobId === "string"
  ) {
    ids.add((personalAgent as Record<string, unknown>).jobId as string);
  }
  const executionContext = personalAgentExecutionContextSchema.safeParse(
    payload.personalAgentContext
  );
  const activeJobId = executionContext.success
    ? executionContext.data.activeJob?.jobId
    : null;
  if (activeJobId) ids.add(activeJobId);
  return [...ids];
};

export type ManagedRecallFeedbackTarget = RecallFeedbackAttribution & {
  answerKind: RecallFeedbackAnswerKind;
  answerId: string;
};

export const resolveManagedRecallFeedbackTarget = async (
  repository: Pick<
    ManagedConversationRepository,
    | "getManagedConversationCommand"
    | "getManagedConversationExecution"
    | "getManagedConversationPromptHistoryAnswer"
  > &
    Pick<
      PersonalAgentRepository,
      | "getPersonalAgentExecutionJob"
      | "getPersonalAgentTurnOutput"
      | "getPersonalAgentVersion"
    >,
  actor: { userId: string },
  executionId: string,
  answerKind: RecallFeedbackAnswerKind,
  answerId: string
): Promise<ManagedRecallFeedbackTarget | null> => {
  const execution = await repository.getManagedConversationExecution(
    actor,
    executionId
  );
  if (!execution || execution.ownerUserId !== actor.userId) return null;

  if (answerKind === "provider") {
    const [command, historyAnswer] = await Promise.all([
      repository.getManagedConversationCommand(actor, answerId),
      repository.getManagedConversationPromptHistoryAnswer(actor, {
        executionId,
        commandId: answerId
      })
    ]);
    if (
      !command ||
      !historyAnswer ||
      !historyAnswer.assistantOutput ||
      command.ownerUserId !== actor.userId ||
      command.executionId !== executionId ||
      command.commandKind !== "prompt" ||
      command.state !== "completed"
    ) {
      return null;
    }
    const attribution = verifiedRecallFeedbackAttribution(
      historyAnswer.assistantOutput.text,
      command.id,
      historyAnswer.personalMemoryContext
    );
    return attribution
      ? { ...attribution, answerKind, answerId: command.id }
      : null;
  }

  const job = await repository.getPersonalAgentExecutionJob(actor, answerId);
  if (
    !job ||
    job.ownerUserId !== actor.userId ||
    job.conversationId !== executionId ||
    job.attribution.kind !== "agent" ||
    !job.commandId
  ) {
    return null;
  }
  const [command, output, version, historyAnswer] = await Promise.all([
    repository.getManagedConversationCommand(actor, job.commandId),
    repository.getPersonalAgentTurnOutput(actor, { jobId: job.id }),
    repository.getPersonalAgentVersion(actor, {
      agentId: job.attribution.agentId,
      version: job.attribution.agentVersion
    }),
    repository.getManagedConversationPromptHistoryAnswer(actor, {
      executionId,
      commandId: job.commandId
    })
  ]);
  if (
    !command ||
    !historyAnswer ||
    command.ownerUserId !== actor.userId ||
    command.executionId !== executionId ||
    command.commandKind !== "prompt" ||
    command.state !== "completed" ||
    !output ||
    !version
  ) {
    return null;
  }
  const providerOutput = historyAnswer.assistantOutput?.text ?? null;
  if (
    providerOutput &&
    commandAssignedJobIds(command.payload).includes(job.id)
  ) {
    return null;
  }
  const attribution = verifiedRecallFeedbackAttribution(
    output,
    command.id,
    historyAnswer.personalMemoryContext
  );
  return attribution ? { ...attribution, answerKind, answerId: job.id } : null;
};
