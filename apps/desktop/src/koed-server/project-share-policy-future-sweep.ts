export type ActiveProjectSharePolicy = {
  projectId: string;
  teamBackendId: string;
  workspaceProjectId: string;
  policyVersion: number;
};
type Page = {
  projects: ActiveProjectSharePolicy[];
  nextCursor: string | null;
  hasMore: boolean;
};

/** Main receives Project identities only from the owner-local selector. Each
 * turn advances at most two Projects and one bounded Session page per Project. */
export const createProjectSharePolicyFutureSweep = (input: {
  list(cursor: string | undefined, signal: AbortSignal): Promise<Page>;
  stage(
    project: ActiveProjectSharePolicy,
    cursor: string | undefined,
    signal: AbortSignal
  ): Promise<{ hasMore: boolean; nextCursor: string | null }>;
  reconcileIssues?(
    project: ActiveProjectSharePolicy,
    cursor: string | undefined,
    signal: AbortSignal
  ): Promise<{ hasMore: boolean; nextCursor: string | null }>;
}) => {
  let authorityKey: string | null = null;
  let selectorCursor: string | undefined;
  let page: Page | null = null;
  let position = 0;
  const sessionCursors = new Map<string, string>();
  const issueCursors = new Map<string, string>();
  const identity = (item: ActiveProjectSharePolicy) =>
    `${item.projectId}\u0000${item.teamBackendId}\u0000${item.workspaceProjectId}\u0000${item.policyVersion}`;
  const reset = (key: string) => {
    authorityKey = key;
    selectorCursor = undefined;
    page = null;
    position = 0;
    sessionCursors.clear();
    issueCursors.clear();
  };
  return {
    clear() {
      authorityKey = null;
      selectorCursor = undefined;
      page = null;
      position = 0;
      sessionCursors.clear();
      issueCursors.clear();
    },
    async reconcile(
      key: string,
      signal: AbortSignal
    ): Promise<{ hasMore: boolean }> {
      if (authorityKey !== key) reset(key);
      if (signal.aborted) return { hasMore: false };
      if (!page) {
        const received = await input.list(selectorCursor, signal);
        if (signal.aborted || authorityKey !== key) return { hasMore: false };
        page = received;
        position = 0;
      }
      let advanced = 0;
      while (
        page &&
        position < page.projects.length &&
        advanced < 2 &&
        !signal.aborted
      ) {
        const project = page.projects[position++]!;
        advanced++;
        const id = identity(project);
        const outcome = await input.stage(
          project,
          sessionCursors.get(id),
          signal
        );
        if (signal.aborted || authorityKey !== key) return { hasMore: false };
        if (outcome.hasMore && outcome.nextCursor) {
          // The cursor is an opaque, scope-bound local-edge token. Keep the
          // cache bounded even if many policies are visited over time.
          sessionCursors.delete(id);
          sessionCursors.set(id, outcome.nextCursor);
          if (sessionCursors.size > 100)
            sessionCursors.delete(sessionCursors.keys().next().value!);
        } else sessionCursors.delete(id);
        if (input.reconcileIssues) {
          const issues = await input.reconcileIssues(
            project,
            issueCursors.get(id),
            signal
          );
          if (signal.aborted || authorityKey !== key) return { hasMore: false };
          if (issues.hasMore && issues.nextCursor) {
            issueCursors.delete(id);
            issueCursors.set(id, issues.nextCursor);
            if (issueCursors.size > 100)
              issueCursors.delete(issueCursors.keys().next().value!);
          } else issueCursors.delete(id);
        }
      }
      if (page && position >= page.projects.length) {
        selectorCursor = page.hasMore
          ? (page.nextCursor ?? undefined)
          : undefined;
        page = null;
      }
      return {
        hasMore: Boolean(
          page || selectorCursor || sessionCursors.size || issueCursors.size
        )
      };
    }
  };
};
