import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

import { MemoryApiClient } from "./index.js";
import {
  adaptMessages,
  isHumanUserMessage,
  turnBoundaryControl
} from "./claude-transcript-adapter.js";
import {
  transcriptIndex,
  verifiedTranscriptPath
} from "./claude-transcript-discovery.js";
import {
  coordinateClaudeSuccessorGeneration,
  journalClaudeTranscript,
  lookupClaudeArtifact,
  stableClaudeSourceComponents,
  type SourceArtifact
} from "./claude-transcript-source.js";
import type { RawConversationItemRequest } from "./conversation-source-types.js";
import {
  persistRawConversationItems,
  projectRawConversationItems
} from "./raw-conversation-items.js";
import type { ClaudeTranscriptWatcherSignal } from "./claude-transcript-watcher-signal.js";
import type { ClaudeWatcherState } from "./claude-transcript-types.js";

const componentCursorKey = (sessionId: string, componentId: string): string =>
  `${sessionId}\u0000${componentId}`;

export const processClaudeTranscriptSignal = async (
  client: MemoryApiClient,
  state: ClaudeWatcherState,
  signal: ClaudeTranscriptWatcherSignal,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> => {
  const transcriptPath = await verifiedTranscriptPath(
    signal.transcriptPath,
    signal.sourceSessionId,
    env
  );
  const mainCursor =
    state.cursors[componentCursorKey(signal.sourceSessionId, "main")]
      ?.messageCount ?? 0;
  const components = await stableClaudeSourceComponents({
    signal,
    mainTranscriptPath: transcriptPath,
    env
  });
  const mainIndex = await transcriptIndex(transcriptPath, state.activatedAt);
  if (mainCursor === 0 && mainIndex.activationTimestamp === null) return;
  const activation = Date.parse(state.activatedAt);
  const initialArtifacts = new Map<string, SourceArtifact | null>();
  for (const component of components) {
    initialArtifacts.set(
      component.componentId,
      await lookupClaudeArtifact(
        client,
        signal.sourceSessionId,
        component.componentId
      )
    );
  }
  const artifactsByComponent = await coordinateClaudeSuccessorGeneration({
    client,
    sourceSessionId: signal.sourceSessionId,
    components,
    artifacts: initialArtifacts
  });
  const allItems: RawConversationItemRequest[] = [];
  const cursorUpdates: Array<{
    key: string;
    value: { messageCount: number; updatedAt: string };
  }> = [];
  let capturedSessionId: string | null = null;
  let mainMessages: SessionMessage[] = [];
  for (const component of components) {
    const cursorKey = componentCursorKey(
      signal.sourceSessionId,
      component.componentId
    );
    const cursor = state.cursors[cursorKey]?.messageCount ?? 0;
    const index =
      component.componentId === "main"
        ? mainIndex
        : await transcriptIndex(component.transcriptPath, state.activatedAt);
    if (cursor === 0 && index.activationTimestamp === null) continue;
    const artifact = await journalClaudeTranscript({
      client,
      signal,
      transcriptPath: component.transcriptPath,
      index,
      componentId: component.componentId,
      componentRole: component.role,
      parentComponentId: component.parentComponentId,
      artifact: artifactsByComponent.get(component.componentId) ?? null
    });
    if (!artifact.sessionId) {
      throw new Error("Claude journal did not resolve its Captured Session");
    }
    if (capturedSessionId && capturedSessionId !== artifact.sessionId) {
      throw new Error("Claude source components resolved different sessions");
    }
    capturedSessionId = artifact.sessionId;
    artifactsByComponent.set(component.componentId, artifact);
    if (component.messages.length > cursor) {
      allItems.push(
        ...adaptMessages({
          messages: component.messages,
          sessionId: signal.sourceSessionId,
          capturedSessionId,
          cwd: signal.cwd,
          timestamps: index.timestamps,
          observedAt: signal.observedAt ?? new Date().toISOString(),
          minimumMessageIndex: cursor,
          ...(cursor === 0 ? { activationTime: activation } : {}),
          componentId: component.componentId
        })
      );
    }
    cursorUpdates.push({
      key: cursorKey,
      value: {
        messageCount: component.messages.length,
        updatedAt: new Date().toISOString()
      }
    });
    if (component.componentId === "main") mainMessages = component.messages;
  }
  const artifacts = [...artifactsByComponent.values()].filter(
    (artifact): artifact is SourceArtifact => artifact !== null
  );
  const mainArtifact =
    artifacts.find((artifact) => artifact.sourceComponentId === "main") ??
    artifacts[0];
  const currentTurn = [...mainMessages]
    .reverse()
    .find(isHumanUserMessage)?.uuid;
  if (
    capturedSessionId &&
    currentTurn &&
    mainArtifact &&
    (signal.turnBoundary === true ||
      ["Stop", "StopFailure", "SessionEnd"].includes(
        signal.hookEventName ?? ""
      ))
  ) {
    allItems.push(
      turnBoundaryControl({
        signal,
        capturedSessionId,
        externalTurnId: currentTurn,
        frontierOffset: mainArtifact.providerCursorOffset,
        frontierLine: mainArtifact.providerCursorLine,
        sourceSequence: mainMessages.length * 1_000 + 999
      })
    );
  }
  if (allItems.length > 0) {
    if (!capturedSessionId) {
      throw new Error("Claude capture did not resolve its Captured Session");
    }
    const persisted = await persistRawConversationItems(
      client,
      allItems,
      `Claude session ${signal.sourceSessionId}`
    );
    await projectRawConversationItems(
      client,
      persisted,
      `Claude session ${signal.sourceSessionId}`
    );
  }
  if (signal.hookEventName === "SessionEnd" && artifacts.length > 0) {
    for (const artifact of artifacts) {
      await client.finalizeConversationSourceArtifact(artifact.id, {
        expectedProviderOffset: artifact.providerCursorOffset,
        expectedProviderLine: artifact.providerCursorLine
      });
    }
    const sourceGenerationId = artifacts[0]?.sourceGenerationId;
    if (!sourceGenerationId) {
      throw new Error("claude_source_generation_identity_missing");
    }
    await client.finalizeConversationSourceSet(sourceGenerationId);
  }
  for (const update of cursorUpdates) {
    state.cursors[update.key] = update.value;
  }
};
