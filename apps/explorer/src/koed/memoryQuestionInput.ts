import type { RetrievalScope, SearchDomain, ThreadGroup } from "./types";

export interface MemoryQuestionInput {
  query: string;
  retrievalScope: RetrievalScope;
  searchDomain: SearchDomain;
  workspaceId?: string;
  projectName?: string;
  projectPath?: string;
  sessionId?: string;
  threadId?: string;
  threadName?: string;
}

export function selectedThreadSessionIdentifier(
  selectedThread: ThreadGroup | null | undefined
) {
  return selectedThread?.sessionId ?? selectedThread?.id ?? null;
}

export function buildMemoryQuestionInput({
  query,
  retrievalScope,
  searchDomain,
  selectedThread
}: {
  query: string;
  retrievalScope: RetrievalScope;
  searchDomain: SearchDomain;
  selectedThread: ThreadGroup | null | undefined;
}): MemoryQuestionInput {
  const workspaceId = selectedThread?.projectId;
  const sessionId = selectedThreadSessionIdentifier(selectedThread);
  return {
    query,
    retrievalScope,
    searchDomain,
    ...((searchDomain === "project" || searchDomain === "session") &&
    workspaceId
      ? { workspaceId }
      : {}),
    ...(searchDomain === "session" && sessionId ? { sessionId } : {}),
    ...(selectedThread?.projectName
      ? { projectName: selectedThread.projectName }
      : {}),
    ...(selectedThread?.projectPath
      ? { projectPath: selectedThread.projectPath }
      : {}),
    ...(selectedThread?.id ? { threadId: selectedThread.id } : {}),
    ...(selectedThread?.name ? { threadName: selectedThread.name } : {})
  };
}
