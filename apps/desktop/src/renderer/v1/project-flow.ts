import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import type { V1ConversationIntent } from "../../ipc/v1-state-protocol.js";
import type { DesktopProject } from "../../project-memory-ui.js";
import type { projectExecutionFolders } from "../../project-source-navigation.js";
import { useEffect, useRef } from "react";

type ExecutionFolder = ReturnType<typeof projectExecutionFolders>[number];
type ManageProject = NonNullable<PersonalDesktopApi["manageProject"]>;

export function selectV1ExecutionTarget({
  selectedProjectId,
  folders,
  selectedFolderId,
  activeProject,
  independentProject
}: {
  selectedProjectId: string | null;
  folders: readonly ExecutionFolder[];
  selectedFolderId?: string;
  activeProject: DesktopProject | null;
  independentProject: DesktopProject | null;
}) {
  const selectedFolder =
    folders.find((folder) => folder.id === selectedFolderId) ??
    (folders.length === 1 ? folders[0] : null);
  return {
    selectedFolder,
    executionProject:
      selectedProjectId && folders.length ? activeProject : independentProject,
    executionProjectId:
      selectedFolder?.id ??
      (folders.length === 0
        ? (independentProject?.localProjectId ?? independentProject?.id ?? null)
        : null)
  };
}

export async function confirmV1ProjectMembership({
  intent,
  executionId,
  sessionId,
  scope,
  currentScope,
  loadProject,
  manageProject,
  ack,
  refresh
}: {
  intent: V1ConversationIntent;
  executionId: string;
  sessionId?: string;
  scope: string | null;
  currentScope: () => string | null;
  loadProject: (id: string) => Promise<DesktopProject | undefined>;
  manageProject: ManageProject;
  ack: (input: {
    idempotencyKey: string;
    executionId: string;
    capturedSessionId: string;
    projectMembershipConfirmed: true;
  }) => Promise<unknown>;
  refresh: () => Promise<unknown>;
}): Promise<boolean> {
  if (
    !intent.presentationProjectId ||
    intent.projectMembershipConfirmed ||
    !sessionId ||
    currentScope() !== scope
  )
    return false;
  const project = await loadProject(intent.presentationProjectId);
  if (currentScope() !== scope) return false;
  if (!project?.namedProject || project.namedProject.deletedAt)
    throw new Error("The selected Project is no longer available.");
  const reviewed = await manageProject({
    action: "explain_session",
    projectId: project.id,
    expectedVersion: project.namedProject.version,
    sessionId
  });
  if (currentScope() !== scope) return false;
  if (
    !reviewed.explanation ||
    reviewed.explanation.sessionId !== sessionId ||
    reviewed.project.projectId !== project.namedProject.projectId ||
    reviewed.project.version !== project.namedProject.version
  )
    throw new Error("Conversation membership could not be verified.");
  if (!reviewed.explanation.included) {
    if (
      reviewed.explanation.exclusion ||
      reviewed.explanation.syncExclusion?.blocked
    )
      throw new Error(
        "This Conversation is excluded from the Project. Review its membership before adding it back."
      );
    await manageProject({
      action: "add_session",
      projectId: project.id,
      expectedVersion: reviewed.project.version,
      sessionId
    });
  }
  if (currentScope() !== scope) return false;
  await ack({
    idempotencyKey: intent.idempotencyKey,
    executionId,
    capturedSessionId: sessionId,
    projectMembershipConfirmed: true
  });
  await refresh();
  return true;
}

export async function acknowledgeLateV1Capture({
  intent,
  sessionId,
  scope,
  currentScope,
  ack,
  refresh
}: {
  intent: V1ConversationIntent;
  sessionId: string;
  scope: string;
  currentScope: () => string | null;
  ack: (input: {
    idempotencyKey: string;
    executionId: string;
    capturedSessionId: string;
  }) => Promise<unknown>;
  refresh: () => Promise<unknown>;
}): Promise<boolean> {
  if (
    !intent.executionId ||
    !sessionId ||
    intent.capturedSessionId === sessionId ||
    currentScope() !== scope
  )
    return false;
  await ack({
    idempotencyKey: intent.idempotencyKey,
    executionId: intent.executionId,
    capturedSessionId: sessionId
  });
  if (currentScope() !== scope) return false;
  await refresh();
  return true;
}

export function lateV1CaptureSessionId(
  intent: V1ConversationIntent,
  realtimeSessionId?: string | null,
  draftSessionId?: string | null
): string | null {
  const candidate = realtimeSessionId || draftSessionId;
  return candidate &&
    candidate !== intent.executionId &&
    candidate !== intent.capturedSessionId
    ? candidate
    : null;
}

export function useV1ProjectMembershipReconciler({
  enabled,
  scopeKey,
  intents,
  retryRevision,
  currentScope,
  confirm,
  onError
}: {
  enabled: boolean;
  scopeKey: string | null;
  intents: readonly V1ConversationIntent[];
  retryRevision: number;
  currentScope: () => string | null;
  confirm: (intent: V1ConversationIntent) => Promise<unknown>;
  onError: (cause: unknown) => void;
}) {
  const attempts = useRef(new Set<string>());
  const lastScope = useRef(scopeKey);
  if (lastScope.current !== scopeKey) {
    attempts.current.clear();
    lastScope.current = scopeKey;
  }
  useEffect(() => {
    if (!enabled || !scopeKey) return;
    for (const intent of intents) {
      if (
        !intent.executionId ||
        !intent.capturedSessionId ||
        !intent.presentationProjectId ||
        intent.projectMembershipConfirmed
      )
        continue;
      const key = `${retryRevision}:${intent.idempotencyKey}:${intent.capturedSessionId}`;
      if (attempts.current.has(key)) continue;
      attempts.current.add(key);
      void confirm(intent).catch((cause) => {
        if (currentScope() === scopeKey) onError(cause);
      });
    }
  }, [
    enabled,
    scopeKey,
    intents,
    retryRevision,
    currentScope,
    confirm,
    onError
  ]);
}
