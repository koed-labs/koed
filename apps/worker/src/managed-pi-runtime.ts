import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  completeTranscriptBoundary,
  piSessionIdentity,
  processPiTranscriptSignal,
  type MemoryApiClient
} from "@koed/mcp-server";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Drain the canonical consumer to the completed managed turn's journal frontier. */
export async function captureManagedPiTurn(input: {
  client: MemoryApiClient;
  sessionId: string;
  transcriptPath: string;
  sessionDirectory: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  artifact: Record<string, unknown>;
  transcriptPath: string;
  managedHome: string;
}> {
  const managedHome = await realpath(input.sessionDirectory);
  const transcriptPath = await realpath(input.transcriptPath);
  const child = relative(managedHome, transcriptPath);
  if (
    !child ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    resolve(managedHome, child) !== transcriptPath
  ) {
    throw new Error("ManagedConversationPiSourceBoundaryError");
  }
  const state = {
    version: 1 as const,
    activatedAt: new Date().toISOString(),
    baselines: { [transcriptPath]: 0 }
  };
  const env = { ...input.env, PI_CODING_AGENT_SESSION_DIR: managedHome };
  const identity = piSessionIdentity(transcriptPath);
  if (identity.id !== input.sessionId)
    throw new Error("ManagedConversationPiSourceIdentityError");
  const turnBoundary = completeTranscriptBoundary(transcriptPath);
  let previousOffset = -1;
  for (let page = 0; page < 1_000_000; page += 1) {
    await processPiTranscriptSignal(
      input.client,
      state,
      {
        sourceSessionId: input.sessionId,
        transcriptPath,
        cwd: identity.cwd,
        eventName: "agent_settled"
      },
      env
    );
    const artifact = object(
      (
        await input.client.lookupConversationSourceArtifact({
          sourceKind: "pi",
          externalSessionId: input.sessionId
        })
      ).artifact
    );
    if (
      typeof artifact.id !== "string" ||
      typeof artifact.providerCursorOffset !== "number"
    ) {
      throw new Error("ManagedConversationPiCaptureUnavailableError");
    }
    if (artifact.providerCursorOffset < turnBoundary) {
      throw new Error("ManagedConversationPiCaptureIncompleteError");
    }
    const cursor = object(
      (
        await input.client.getConversationSourceCursor(
          artifact.id,
          "canonical_live"
        )
      ).cursor
    );
    if (
      typeof cursor.sourceOffset !== "number" ||
      cursor.sourceOffset <= previousOffset
    ) {
      throw new Error("ManagedConversationPiCaptureProgressError");
    }
    if (cursor.sourceOffset === artifact.providerCursorOffset) {
      if (typeof artifact.sessionId !== "string")
        throw new Error("ManagedConversationPiCaptureUnavailableError");
      const released = await input.client.releaseManagedJournalProjection({
        sessionId: artifact.sessionId,
        artifactId: artifact.id,
        sourceOffset: turnBoundary
      });
      for (
        let index = 0;
        index < released.conversationItemIds.length;
        index += 1000
      ) {
        const conversationItemIds = released.conversationItemIds.slice(
          index,
          index + 1000
        );
        await input.client.projectConversationItems({
          conversationItemIds,
          limit: conversationItemIds.length
        });
      }
      return { artifact, transcriptPath, managedHome };
    }
    previousOffset = cursor.sourceOffset;
  }
  throw new Error("ManagedConversationPiCaptureCapacityError");
}
