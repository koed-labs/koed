import { useEffect, useMemo, useState } from "react";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";

export type HqVisibility = "personal-private" | "unverified";

type VisibilityReader = Pick<
  CollaborationRendererClient,
  "listOwnedSharedMemoryGrants" | "listOwnedShares"
>;

type ConversationSourceIdentity = {
  sessionId: string | null | undefined;
  logicalMemoryId?: string | null;
};

/** An old route row and a replacing execution must not form a mixed source. */
export function hqVisibilityIdentity(
  routeThread: ConversationSourceIdentity,
  detailThread: ConversationSourceIdentity,
  capturedSessionId: string | null | undefined
): { sessionId: string; logicalMemoryId: string } | null {
  const sessionId = detailThread.sessionId;
  if (
    !sessionId ||
    (routeThread.sessionId && routeThread.sessionId !== sessionId) ||
    (capturedSessionId && capturedSessionId !== sessionId) ||
    (routeThread.logicalMemoryId &&
      detailThread.logicalMemoryId &&
      routeThread.logicalMemoryId !== detailThread.logicalMemoryId)
  )
    return null;
  const logicalMemoryId =
    detailThread.logicalMemoryId ??
    (routeThread.sessionId === sessionId ? routeThread.logicalMemoryId : null);
  return logicalMemoryId ? { sessionId, logicalMemoryId } : null;
}

const matchesConversationSource = (
  source: { kind: string; logicalMemoryId: string; sessionId?: string },
  logicalMemoryId: string,
  sessionId: string,
  localSessionId?: string | null
) =>
  source.logicalMemoryId === logicalMemoryId ||
  source.sessionId === sessionId ||
  localSessionId === sessionId;

/** A complete owner read is required before making a privacy claim. */
export async function readHqConversationVisibility(
  client: VisibilityReader,
  logicalMemoryId: string,
  sessionId: string
): Promise<HqVisibility> {
  try {
    const grants = await client.listOwnedSharedMemoryGrants({
      logicalMemoryId
    });
    if (
      grants.some(
        (grant) =>
          (grant.lifecycle === "active" || grant.lifecycle === "unavailable") &&
          matchesConversationSource(grant.source, logicalMemoryId, sessionId)
      )
    )
      return "unverified";

    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = await client.listOwnedShares({
        cursor,
        limit: 100,
        history: false
      });
      if (
        page.shares.some((item) => {
          const source =
            item.kind === "pending"
              ? item.pendingShare.source
              : item.grant.source;
          if (item.kind === "pending" && item.pendingShare.state === "revoked")
            return false;
          // Either source identity matching while the other conflicts is
          // ambiguous. A missing local mapping cannot clear a logical match.
          return matchesConversationSource(
            source,
            logicalMemoryId,
            sessionId,
            item.summary.sourceSessionId
          );
        })
      )
        return "unverified";
      if (!page.nextCursor) return "personal-private";
      if (page.shares.length === 0) return "unverified";
      if (seen.has(page.nextCursor)) return "unverified";
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  } catch {
    // Missing Team authority, offline state and interrupted reads cannot prove privacy.
  }
  return "unverified";
}

export function useHqConversationVisibility({
  client,
  logicalMemoryId,
  sessionId,
  ownerId,
  revision,
  connected
}: {
  client: VisibilityReader | null | undefined;
  logicalMemoryId: string | null | undefined;
  sessionId: string | null | undefined;
  ownerId: string | null | undefined;
  revision: string | null | undefined;
  connected: boolean;
}): HqVisibility {
  const key = [ownerId, logicalMemoryId, sessionId, revision, connected].join(
    "\u0000"
  );
  // A new token is created even when navigation or reconnection returns to an
  // earlier key. A prior private read can never be rendered during recheck.
  const request = useMemo(() => ({ key, client }), [key, client]);
  const [result, setResult] = useState<{
    request: typeof request;
    value: HqVisibility;
  } | null>(null);
  useEffect(() => {
    if (!client || !logicalMemoryId || !sessionId || !ownerId || !connected)
      return;
    let current = true;
    void readHqConversationVisibility(client, logicalMemoryId, sessionId).then(
      (value) => {
        if (current) setResult({ request, value });
      }
    );
    return () => {
      current = false;
    };
  }, [client, logicalMemoryId, sessionId, ownerId, connected, request]);
  return result?.request === request ? result.value : "unverified";
}
