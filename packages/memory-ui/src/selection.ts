export type ThreadSelection = {
  id: string;
  projectId: string;
};

export type SessionSelection = {
  id: string;
  sessionId?: string | null;
};

export const threadSelectionKey = (thread: ThreadSelection): string =>
  `${encodeURIComponent(thread.projectId)}:${encodeURIComponent(thread.id)}`;

export const sessionSelectionId = (session: SessionSelection): string =>
  session.sessionId ?? session.id;
