import { useRef, useState } from "react";
import type {
  PersonalProjectCommand,
  PersonalProjectMembershipExplanation
} from "@koed/shared";
import type {
  PersonalDesktopApi,
  PersonalDesktopProject
} from "@koed/shared/personal-desktop";
import type { PersonalMemoryStore } from "../../state/personal-memory.js";

type Manage = NonNullable<PersonalDesktopApi["manageProject"]>;
export type ConversationProjectDraft = {
  project: PersonalDesktopProject;
  version: number;
  explanation: PersonalProjectMembershipExplanation;
  included: boolean;
  direct: boolean;
  restore: boolean;
};
export const hasRule = (entry: ConversationProjectDraft) =>
  entry.explanation.reasons.some((reason) => reason.kind !== "session");
export const isExcluded = (entry: ConversationProjectDraft) =>
  !!(
    entry.explanation.syncExclusion?.blocked ||
    entry.explanation.exclusion?.clearedAt === null
  );
export const needsSyncReview = (entry: ConversationProjectDraft) =>
  !!(
    entry.explanation.syncExclusion &&
    (entry.explanation.syncExclusion.state !== "available" ||
      (entry.explanation.syncExclusion.blocked && !entry.explanation.exclusion))
  );

function commandsFor(
  entry: ConversationProjectDraft,
  sessionId: string
): PersonalProjectCommand[] {
  const base = { projectId: entry.project.id, expectedVersion: entry.version };
  const direct = entry.explanation.reasons.filter(
    (reason) => reason.kind === "session"
  );
  if (isExcluded(entry)) {
    if (!entry.included) return [];
    const exclusion = entry.explanation.exclusion;
    if (!entry.restore || !exclusion || needsSyncReview(entry))
      throw new Error(
        "Review the exclusion before adding this Conversation back."
      );
    return [
      {
        ...base,
        action: "add_back",
        sessionId,
        exclusionId: exclusion.exclusionId,
        expectedExclusionRevisionId: exclusion.headRevisionId
      }
    ];
  }
  if (!entry.included && entry.explanation.included && hasRule(entry))
    return [{ ...base, action: "exclude_session", sessionId }];
  if ((!entry.included || !entry.direct) && direct.length)
    return direct.map((reason) => ({
      ...base,
      action: "remove_inclusion",
      inclusionId: reason.inclusionId
    }));
  if (entry.included && entry.direct && !direct.length)
    return [{ ...base, action: "add_session", sessionId }];
  return [];
}

/** Pin each reviewed Project version for the life of this draft. Stop on failure;
 * reopening is required before any further save, including after partial writes. */
export function useConversationProjectsDraft(
  manage: Manage,
  store: PersonalMemoryStore,
  onConfirmed: () => void
) {
  const [entries, setEntries] = useState<ConversationProjectDraft[]>([]);
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [failed, setFailed] = useState(false);
  const request = useRef(0),
    running = useRef(false),
    session = useRef("");
  const review = async (
    project: PersonalDesktopProject,
    sessionId: string
  ): Promise<ConversationProjectDraft> => {
    const version = project.namedProject!.version;
    const result = await manage({
      action: "explain_session",
      projectId: project.id,
      expectedVersion: version,
      sessionId
    });
    if (
      result.project.projectId !== project.id ||
      result.project.version !== version ||
      result.explanation?.sessionId !== sessionId
    )
      throw new Error(
        "Conversation membership could not be verified. Close and reopen this card."
      );
    return {
      project,
      version,
      explanation: result.explanation,
      included: result.explanation.included,
      direct: result.explanation.reasons.some(
        (reason) => reason.kind === "session"
      ),
      restore: false
    };
  };
  const load = async (
    projects: readonly PersonalDesktopProject[],
    sessionId: string
  ) => {
    const id = ++request.current;
    session.current = sessionId;
    setEntries([]);
    setError("");
    setFailed(false);
    setLoading(true);
    try {
      const reviewed = await Promise.all(
        projects
          .filter(
            (project) => project.namedProject && !project.namedProject.deletedAt
          )
          .map((project) => review(project, sessionId))
      );
      if (id === request.current) setEntries(reviewed);
    } catch (cause) {
      if (id === request.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setFailed(true);
      }
    } finally {
      if (id === request.current) setLoading(false);
    }
  };
  const addProject = async (project: PersonalDesktopProject) => {
    const id = request.current;
    setLoading(true);
    try {
      const entry = await review(project, session.current);
      if (id === request.current)
        setEntries((previous) =>
          previous.some((row) => row.project.id === project.id)
            ? previous
            : [...previous, entry]
        );
    } catch (cause) {
      if (id === request.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setFailed(true);
      }
    } finally {
      if (id === request.current) setLoading(false);
    }
  };
  const edit = (
    projectId: string,
    patch: Partial<
      Pick<ConversationProjectDraft, "included" | "direct" | "restore">
    >
  ) =>
    setEntries((previous) =>
      previous.map((entry) =>
        entry.project.id === projectId ? { ...entry, ...patch } : entry
      )
    );
  const changed = entries.filter(
    (entry) => commandsFor(entry, session.current).length > 0
  ).length;
  const confirm = async () => {
    if (running.current || loading || failed) return;
    running.current = true;
    setBusy(true);
    setError("");
    let completed = 0;
    try {
      const changes = entries
        .map((entry) => ({
          entry,
          commands: commandsFor(entry, session.current)
        }))
        .filter((row) => row.commands.length);
      // Review every affected Project before the first write, without rebasing.
      for (const { entry } of changes) {
        const current = await review(
          {
            ...entry.project,
            namedProject: {
              ...entry.project.namedProject!,
              version: entry.version
            }
          },
          session.current
        );
        if (
          current.explanation.logicalSessionId !==
          entry.explanation.logicalSessionId
        )
          throw new Error(
            "Conversation identity changed. Close and reopen this card."
          );
      }
      for (const { entry, commands } of changes) {
        let version = entry.version;
        for (const command of commands) {
          const result = await manage({ ...command, expectedVersion: version });
          if (
            result.project.projectId !== entry.project.id ||
            result.project.version < version
          )
            throw new Error("The Project response could not be verified.");
          version = result.project.version;
          completed++;
        }
      }
      if (changes.length) {
        const refreshed = await store.loadProjects({ silent: true });
        if (refreshed.error) throw new Error(refreshed.error);
      }
      onConfirmed();
    } catch (cause) {
      setFailed(true);
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(
        `${completed ? `${completed} ${completed === 1 ? "change was" : "changes were"} saved before stopping. ` : ""}${message} Close and reopen this card before saving again.`
      );
      await store.loadProjects({ silent: true });
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return {
    entries,
    loading,
    busy,
    error,
    failed,
    changed,
    load,
    addProject,
    edit,
    confirm,
    discard: () => {
      request.current++;
    }
  };
}
