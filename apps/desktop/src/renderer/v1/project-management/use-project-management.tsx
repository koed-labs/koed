import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@koed-labs/ui";
import { Check, X } from "lucide-react";
import type {
  PersonalConversationOrganizationInput,
  PersonalConversationOrganizationResult
} from "@koed-labs/shared";
import type { PersonalDesktopApi } from "@koed-labs/shared/personal-desktop";
import {
  mergeProjectSources,
  type DesktopProject
} from "../../../project-memory-ui.js";
import type { PersonalMemoryStore } from "../../state/personal-memory.js";
import type { SidebarManagement } from "../ProjectSidebar.js";
import type { SidebarConversation } from "../project-sidebar-model.js";
import {
  activeNamedProjects,
  excludedMembership,
  inverseOrganizationEdit,
  moveConversationEdit,
  reviewConversationOrganization
} from "./conversation-organization.js";
import { CreateProjectDialog } from "./CreateProjectDialog.js";
import {
  ProjectSettingsDialog,
  type ConversationFilter,
  type ProjectSettingsPage
} from "./ProjectSettingsDialog.js";
import { MoveConversationDialog } from "./MoveConversationDialog.js";
import { ConversationProjectsDialog } from "./ConversationProjectsDialog.js";
import { SourceContextDialog } from "./SourceContextDialog.js";
import { applySuggestions } from "./apply-suggestion.js";
import { folderHintCache } from "./folder-hint-cache.js";
import { useFolderSuggestions } from "./use-folder-suggestions.js";
import { useSuggestionDismissals } from "./suggestion-dismissals.js";
import {
  projectErrorMessage,
  type ConversationManagementTarget
} from "./use-organization-review.js";

type Modal =
  | { kind: "create" }
  | {
      kind: "settings";
      projectId: string;
      page?: ProjectSettingsPage;
      filter?: ConversationFilter;
    }
  | {
      kind: "move" | "membership" | "context";
      target: ConversationManagementTarget;
      destinationId?: string;
      axis?: "git" | "folder";
    };
// How long a confirmation, and its Undo, stay up.
export const NOTICE_MS = 5_000;
type Notice = {
  message: string;
  undo?: PersonalConversationOrganizationResult;
  error?: string;
};

export function useProjectManagement({
  scopeKey,
  api,
  store,
  projects,
  onOrganized
}: {
  scopeKey: string | null;
  api: PersonalDesktopApi | null;
  store: PersonalMemoryStore | null;
  projects: readonly DesktopProject[];
  onOrganized: (
    sessionId: string,
    projects: readonly DesktopProject[],
    preferredProjectId?: string
  ) => void;
}) {
  const operationScope = useMemo(
    () => ({ scopeKey, api, store }),
    [scopeKey, api, store]
  );
  const scope = useRef(operationScope);
  scope.current = operationScope;
  const [state, setState] = useState<{
    scope: typeof operationScope;
    modal: Modal | null;
    notice: Notice | null;
  }>({ scope: operationScope, modal: null, notice: null });
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const locked = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const sameScope = (value: typeof state) => value.scope === operationScope;
  const scopeIsCurrent = () =>
    alive.current && scope.current === operationScope;
  const current = sameScope(state) ? state : { modal: null, notice: null };
  const open = (modal: Modal | null) =>
    setState((old) => ({
      scope: operationScope,
      modal,
      notice: sameScope(old) ? old.notice : null
    }));
  const notice = (value: Notice | null) =>
    setState((old) => ({
      scope: operationScope,
      notice: value,
      modal: sameScope(old) ? old.modal : null
    }));
  const available =
    !!scopeKey &&
    !!api?.manageProject &&
    !!api.manageSourceContext &&
    !!api.createProject &&
    !!store;
  // Suggestions are worked out in the background, a little after start-up and
  // a batch at a time, so the sidebar can show a count beside each Project.
  const [suggestionsVersion, setSuggestionsVersion] = useState(0);
  const forgetSuggestions = () => {
    folderHintCache.clear();
    setSuggestionsVersion((version) => version + 1);
  };
  const worked = useFolderSuggestions(api ?? undefined, projects, available, {
    version: suggestionsVersion,
    startDelayMs: 2500,
    pauseMs: 300
  });
  // Suggestions the User turned down stay out of the list and the counts.
  const { isDismissed, dismiss } = useSuggestionDismissals(scopeKey);
  // Nor is a Conversation suggested for a Project it is already in (added
  // directly, say): only the Projects it is not yet in stay on the row.
  const members = useMemo(() => {
    const byName = new Map<string, Set<string>>();
    for (const project of projects) {
      const ids = project.threads.flatMap((t) =>
        t.sessionId ? [t.sessionId] : []
      );
      for (const name of [project.name, project.namedProject?.name])
        if (name)
          byName.set(name, new Set([...(byName.get(name) ?? []), ...ids]));
    }
    return byName;
  }, [projects]);
  const shown = useMemo(
    () =>
      worked.rows.flatMap((row) => {
        if (isDismissed(row)) return [];
        const open = row.proposal.projects.filter(
          (name) => !members.get(name)?.has(row.sessionId)
        );
        if (open.length === row.proposal.projects.length) return [row];
        return open.length > 0
          ? [{ ...row, proposal: { ...row.proposal, projects: open } }]
          : [];
      }),
    [worked.rows, isDismissed, members]
  );
  const suggestions = { ...worked, rows: shown };
  const run = async <T,>(work: (check: () => void) => Promise<T>) => {
    if (!available || locked.current)
      throw new Error("Project management is busy or unavailable.");
    const check = () => {
      if (!scopeIsCurrent())
        throw new Error("The active account or backend changed.");
    };
    check();
    locked.current = true;
    setBusy(true);
    try {
      return await work(check);
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const refresh = async (
    check: () => void,
    sessionId?: string,
    preferredProjectId?: string
  ) => {
    check();
    const snapshot = await store!.loadProjects({ silent: true });
    check();
    if (snapshot.error)
      throw new Error(
        `Saved, but the sidebar could not refresh. ${snapshot.error}`
      );
    if (sessionId)
      onOrganized(
        sessionId,
        [...snapshot.projectsById.values()],
        preferredProjectId
      );
  };
  const readSettingsInventory = async (check: () => void) => {
    check();
    const { localCheckouts } = store!.current().inventory;
    // A concurrent store refresh can supersede ours and leave its published
    // snapshot behind. Review versions from a direct post-write inventory read.
    const [latest, local] = await Promise.all([
      api!.listProjects(),
      api!.listProjectMetadata?.().catch(() => localCheckouts) ?? localCheckouts
    ]);
    check();
    return mergeProjectSources(latest, local);
  };
  const perform = async (
    check: () => void,
    target: ConversationManagementTarget,
    edit: PersonalConversationOrganizationInput,
    preferredProjectId?: string,
    message = `Updated ${target.title}`
  ) => {
    check();
    const result = await api!.manageSourceContext!({
      action: "organize",
      sessionId: target.sessionId,
      edit
    });
    check();
    if (!result.organization)
      throw new Error(
        "The saved organization result is missing. Refresh before trying again."
      );
    open(null);
    forgetSuggestions();
    notice({ message, undo: result.organization });
    try {
      await refresh(check, target.sessionId, preferredProjectId);
    } catch (cause) {
      check();
      notice({
        message,
        undo: result.organization,
        error: projectErrorMessage(cause)
      });
    }
  };
  const action = (
    row: SidebarConversation,
    kind: "move" | "membership" | "context"
  ) => {
    if (!row.sessionId || row.managementPending || locked.current) return;
    open({
      kind,
      target: {
        sessionId: row.sessionId,
        title: row.title,
        sourceProjectId: row.sourceProjectId
      }
    });
  };
  // Resolves true once the Conversation is in the Project; false when nothing
  // changed, a dialog took over, or it failed (the toast says why).
  const drop = (
    row: SidebarConversation,
    destinationId: string
  ): Promise<boolean> => {
    if (
      !row.sessionId ||
      row.managementPending ||
      row.sourceProjectId === destinationId ||
      locked.current
    )
      return Promise.resolve(false);
    const target = {
      sessionId: row.sessionId,
      title: row.title,
      sourceProjectId: row.sourceProjectId
    };
    let moved = false;
    return run(async (check) => {
      const review = await reviewConversationOrganization(
        api!,
        projects,
        target.sessionId,
        [
          ...(target.sourceProjectId ? [target.sourceProjectId] : []),
          destinationId
        ]
      );
      check();
      const destination = review.memberships.find(
        (m) => m.project.id === destinationId
      );
      if (destination && excludedMembership(destination.explanation)) {
        open({ kind: "move", target, destinationId });
        return;
      }
      const edit = moveConversationEdit(
        review,
        target.sourceProjectId,
        destinationId
      );
      if (edit) {
        const name = projects.find((p) => p.id === destinationId)?.name;
        await perform(
          check,
          target,
          edit,
          destinationId,
          name ? `Added ${target.title} to ${name}` : undefined
        );
        moved = true;
      }
    })
      .then(() => moved)
      .catch((cause) => {
        if (scopeIsCurrent())
          notice({
            message: "Could not move Conversation",
            error: projectErrorMessage(cause)
          });
        return false;
      });
  };
  const management: SidebarManagement | undefined = available
    ? {
        busy,
        onCreateProject: () => open({ kind: "create" }),
        onProjectSettings: (id) => {
          const projectId = id ?? activeNamedProjects(projects)[0]?.id;
          open(
            projectId ? { kind: "settings", projectId } : { kind: "create" }
          );
        },
        onConversationAction: action,
        onDrop: drop
      }
    : undefined;
  const modal = current.modal;
  const dialogProps =
    modal && "target" in modal && api
      ? {
          api,
          projects,
          target: modal.target,
          onClose: () => open(null),
          onApply: (
            edit: PersonalConversationOrganizationInput,
            preferredProjectId?: string
          ) =>
            run((check) =>
              perform(check, modal.target, edit, preferredProjectId)
            )
        }
      : null;
  const undo = async () => {
    const previous = current.notice?.undo;
    if (!previous) return;
    try {
      await run(async (check) => {
        const edit = inverseOrganizationEdit(previous);
        if (!edit) return;
        const sessionId = edit.expectedContext.sessionId;
        check();
        await api!.manageSourceContext!({
          action: "organize",
          sessionId,
          edit
        });
        check();
        notice({ message: "Change undone" });
        try {
          await refresh(check, sessionId);
        } catch (cause) {
          check();
          notice({
            message: "Change undone",
            error: projectErrorMessage(cause)
          });
        }
      });
    } catch (cause) {
      if (scopeIsCurrent())
        notice({ ...current.notice!, error: projectErrorMessage(cause) });
    }
  };
  // A confirmation clears itself; an error stays until dismissed.
  const clearing = current.notice && !current.notice.error;
  useEffect(() => {
    if (!clearing || busy) return;
    const timer = window.setTimeout(() => notice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [current.notice, clearing, busy]);
  const overlays = available && (
    <>
      {modal?.kind === "create" && (
        <CreateProjectDialog
          key={scopeKey}
          onClose={() => open(null)}
          onCreate={(name, requestId) =>
            run(async (check) => {
              check();
              const result = await api!.createProject!({ name, requestId });
              check();
              open(null);
              notice({ message: `Created ${name}` });
              try {
                await refresh(check);
                open({ kind: "settings", projectId: result.projectId });
              } catch (cause) {
                check();
                notice({
                  message: `Created ${name}`,
                  error: projectErrorMessage(cause)
                });
              }
            })
          }
        />
      )}
      {modal?.kind === "settings" && (
        <ProjectSettingsDialog
          key={`${scopeKey}:${modal.projectId}`}
          api={api!}
          store={store!}
          projects={projects}
          projectId={modal.projectId}
          page={modal.page}
          {...(modal.filter ? { filter: modal.filter } : {})}
          suggestions={suggestions}
          onClose={() => {
            if (scopeIsCurrent()) open(null);
          }}
          onRefresh={() => run(readSettingsInventory)}
          onSave={(project, changes, accepted, rejected) =>
            run(async (check) => {
              check();
              if (changes.length > 0)
                await api!.manageProject!({
                  action: "apply_sources",
                  projectId: project.id,
                  expectedVersion: project.namedProject!.version,
                  changes
                });
              check();
              // Excluded now, so no longer suggested here or in the sidebar.
              if (rejected.length > 0) dismiss(rejected);
              const status: Notice = { message: "Project settings saved" };
              if (accepted.length > 0) {
                try {
                  // Settings can advance Project versions. Pin each review to
                  // the inventory after the settings write, not the draft.
                  const latest = await api!.listProjects();
                  check();
                  const added = await applySuggestions(
                    api!,
                    mergeProjectSources(latest, []),
                    accepted,
                    project.id,
                    check
                  );
                  check();
                  if (added.failed.length > 0) {
                    status.message += `. ${added.done} of ${accepted.length} suggested conversations added.`;
                    status.error = added.failed.join("\n");
                  } else {
                    status.message += `. Added ${added.done} ${added.done === 1 ? "conversation" : "conversations"}.`;
                  }
                } catch (cause) {
                  check();
                  status.message += ". No suggested conversations added.";
                  status.error = projectErrorMessage(cause);
                }
                forgetSuggestions();
              }
              notice(status);
              let saveError = status.error;
              const reportRefreshError = (cause: unknown) => {
                check();
                saveError = [saveError, projectErrorMessage(cause)]
                  .filter(Boolean)
                  .join("\n");
                notice({ ...status, error: saveError });
              };
              await refresh(check).catch(reportRefreshError);
              try {
                return await readSettingsInventory(check);
              } catch (cause) {
                reportRefreshError(cause);
                return null;
              }
            })
          }
          onDelete={(project) =>
            run(async (check) => {
              check();
              await api!.manageProject!({
                action: "delete",
                projectId: project.id,
                expectedVersion: project.namedProject!.version
              });
              check();
              open(null);
              notice({ message: `Removed ${project.name}` });
              try {
                await refresh(check);
              } catch (cause) {
                check();
                notice({
                  message: `Removed ${project.name}`,
                  error: projectErrorMessage(cause)
                });
              }
            })
          }
        />
      )}
      {dialogProps && modal?.kind === "move" && (
        <MoveConversationDialog
          key={`${scopeKey}:${modal.target.sessionId}:move`}
          {...dialogProps}
          destinationId={modal.destinationId}
        />
      )}
      {dialogProps && modal?.kind === "membership" && (
        <ConversationProjectsDialog
          key={`${scopeKey}:${modal.target.sessionId}:membership`}
          {...dialogProps}
        />
      )}
      {dialogProps && modal?.kind === "context" && (
        <SourceContextDialog
          key={`${scopeKey}:${modal.target.sessionId}:context`}
          {...dialogProps}
          axis={modal.axis}
        />
      )}
      {current.notice && (
        <div
          className="v1-project-ui v1-pm-toast"
          role={current.notice.error ? "alert" : "status"}
        >
          <Check />
          <span>
            {current.notice.message}
            {current.notice.error && <small>{current.notice.error}</small>}
          </span>
          {current.notice.undo && (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => void undo()}
            >
              Undo
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss notification"
            onClick={() => notice(null)}
          >
            <X />
          </Button>
        </div>
      )}
    </>
  );
  return {
    management,
    overlays,
    busy,
    openContext: (
      target: ConversationManagementTarget,
      axis: "git" | "folder"
    ) => open({ kind: "context", target, axis }),
    openMemberships: (target: ConversationManagementTarget) =>
      open({ kind: "membership", target }),
    openSettings: (projectId: string) => open({ kind: "settings", projectId })
  };
}
