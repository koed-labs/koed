import { useEffect, useRef, useState } from "react";
import { Button } from "@koed/ui";
import { Check, X } from "lucide-react";
import type {
  PersonalConversationOrganizationInput,
  PersonalConversationOrganizationResult
} from "@koed/shared";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
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
  type ProjectSettingsPage
} from "./ProjectSettingsDialog.js";
import { MoveConversationDialog } from "./MoveConversationDialog.js";
import { ConversationProjectsDialog } from "./ConversationProjectsDialog.js";
import { SourceContextDialog } from "./SourceContextDialog.js";
import {
  projectErrorMessage,
  type ConversationManagementTarget
} from "./use-organization-review.js";

type Modal =
  | { kind: "create" }
  | { kind: "settings"; projectId: string; page?: ProjectSettingsPage }
  | {
      kind: "move" | "membership" | "context";
      target: ConversationManagementTarget;
      destinationId?: string;
      axis?: "git" | "folder";
    };
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
  const [state, setState] = useState<{
    scope: string | null;
    modal: Modal | null;
    notice: Notice | null;
  }>({ scope: scopeKey, modal: null, notice: null });
  const [busy, setBusy] = useState(false);
  const scope = useRef(scopeKey);
  scope.current = scopeKey;
  const alive = useRef(true);
  const locked = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const current =
    state.scope === scopeKey
      ? state
      : { scope: scopeKey, modal: null, notice: null };
  const open = (modal: Modal | null) =>
    setState((old) => ({
      scope: scopeKey,
      modal,
      notice: old.scope === scopeKey ? old.notice : null
    }));
  const notice = (value: Notice | null) =>
    setState((old) => ({ ...old, scope: scopeKey, notice: value }));
  const available =
    !!scopeKey &&
    !!api?.manageProject &&
    !!api.manageSourceContext &&
    !!api.createProject &&
    !!store;
  const run = async (work: (check: () => void) => Promise<void>) => {
    if (!available || locked.current)
      throw new Error("Project management is busy or unavailable.");
    const expectedScope = scopeKey;
    const check = () => {
      if (!alive.current || scope.current !== expectedScope)
        throw new Error("The active account or backend changed.");
    };
    check();
    locked.current = true;
    setBusy(true);
    try {
      await work(check);
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
    const next = [...snapshot.projectsById.values()];
    if (sessionId) onOrganized(sessionId, next, preferredProjectId);
    return next;
  };
  const perform = async (
    check: () => void,
    target: ConversationManagementTarget,
    edit: PersonalConversationOrganizationInput,
    preferredProjectId?: string
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
    notice({ message: `Updated ${target.title}`, undo: result.organization });
    try {
      await refresh(check, target.sessionId, preferredProjectId);
    } catch (cause) {
      check();
      notice({
        message: `Updated ${target.title}`,
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
  const drop = (row: SidebarConversation, destinationId: string) => {
    if (
      !row.sessionId ||
      row.managementPending ||
      row.sourceProjectId === destinationId ||
      locked.current
    )
      return;
    const target = {
      sessionId: row.sessionId,
      title: row.title,
      sourceProjectId: row.sourceProjectId
    };
    void run(async (check) => {
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
      if (edit) await perform(check, target, edit, destinationId);
    }).catch((cause) => {
      if (scope.current === scopeKey)
        notice({
          message: "Could not move Conversation",
          error: projectErrorMessage(cause)
        });
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
      if (scope.current === scopeKey)
        notice({ ...current.notice!, error: projectErrorMessage(cause) });
    }
  };
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
          onClose={() => open(null)}
          onSave={(project, changes) =>
            run(async (check) => {
              check();
              await api!.manageProject!({
                action: "apply_sources",
                projectId: project.id,
                expectedVersion: project.namedProject!.version,
                changes
              });
              check();
              open(null);
              notice({ message: "Project settings saved" });
              try {
                await refresh(check);
              } catch (cause) {
                check();
                notice({
                  message: "Project settings saved",
                  error: projectErrorMessage(cause)
                });
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
