import type { CollaborationThreadRecord } from "@koed/db";
import {
  sharedMemoryGrantScopedPrincipalId,
  sharedMemoryGrantScopedSourceId
} from "@koed/shared";

export const publicCollaborationThread = (
  thread: CollaborationThreadRecord
): CollaborationThreadRecord =>
  thread.scope === "team" &&
  thread.kind === "shared_session_discussion" &&
  thread.sharedLogicalMemoryId &&
  thread.shareGrantId
    ? {
        ...thread,
        sharedLogicalMemoryId: sharedMemoryGrantScopedSourceId(
          thread.shareGrantId,
          thread.sharedLogicalMemoryId
        ),
        createdByUserId: thread.createdByUserId
          ? sharedMemoryGrantScopedPrincipalId(
              thread.shareGrantId,
              thread.createdByUserId
            )
          : null
      }
    : thread;
