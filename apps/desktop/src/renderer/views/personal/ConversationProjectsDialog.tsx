import { useState } from "react";
import { ChevronRight, Folder, FolderPlus, GitFork } from "lucide-react";
import {
  Button,
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from "@koed/ui";
import type {
  PersonalDesktopApi,
  PersonalDesktopProjectThread,
  PersonalDesktopProject
} from "@koed/shared/personal-desktop";
import type { PersonalMemoryStore } from "../../state/personal-memory.js";
import { CreateProjectDialog, type CreateProject } from "./ProjectActions.js";
import {
  hasRule,
  isExcluded,
  needsSyncReview,
  useConversationProjectsDraft,
  type ConversationProjectDraft
} from "./use-conversation-projects-draft.js";
import "./conversation-cards.css";

export function ConversationProjectsDialog({
  thread,
  projects,
  manage,
  store,
  create,
  menuitem = false
}: {
  thread: PersonalDesktopProjectThread;
  projects: readonly PersonalDesktopProject[];
  manage: NonNullable<PersonalDesktopApi["manageProject"]>;
  store: PersonalMemoryStore;
  create?: CreateProject;
  menuitem?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [expanded, setExpanded] = useState<string | null>(null);
  const draft = useConversationProjectsDraft(manage, store, () =>
    setOpen(false)
  );
  if (!thread.sessionId) return null;
  const disabled = draft.loading || draft.busy || draft.failed;
  const cancel = () => {
    if (!draft.busy) {
      draft.discard();
      setOpen(false);
    }
  };
  const toggle = (entry: ConversationProjectDraft) => {
    if (isExcluded(entry) && !entry.included) {
      setExpanded(entry.project.id);
      return;
    }
    const included = !entry.included;
    draft.edit(entry.project.id, {
      included,
      direct: included
        ? entry.direct || !hasRule(entry)
        : hasRule(entry)
          ? entry.direct
          : false,
      restore: included && entry.restore
    });
  };
  const openDialog = () => {
    setExpanded(null);
    setOpen(true);
    void draft.load(projects, thread.sessionId!);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
    >
      {menuitem ? (
        <button type="button" role="menuitem" onClick={openDialog}>
          <FolderPlus aria-hidden="true" />
          Add to Project
        </button>
      ) : (
        <Button variant="outline" onClick={openDialog}>
          Add to Project
        </Button>
      )}
      <DialogPopup className="personal-conversation-card">
        <DialogHeader>
          <DialogTitle>Projects for this Conversation</DialogTitle>
          <DialogDescription>{thread.name}</DialogDescription>
        </DialogHeader>
        <div
          className="personal-conversation-card-body"
          aria-busy={draft.loading || draft.busy}
        >
          <div className="personal-conversation-source">
            <GitFork aria-hidden="true" />
            <span>
              {thread.repositoryAssignment?.effective?.anchorDisplay ??
                thread.sourceProject?.name ??
                thread.projectName}
            </span>
            {thread.capturedCwd ? (
              <>
                <ChevronRight aria-hidden="true" />
                <Folder aria-hidden="true" />
                <span>{thread.capturedCwd}</span>
              </>
            ) : null}
          </div>
          {draft.loading ? (
            <p role="status">Reviewing Project membership…</p>
          ) : null}
          {!draft.loading && !draft.entries.length && !draft.error ? (
            <p>Create a Project to group this Conversation.</p>
          ) : null}
          <ul className="personal-conversation-project-list">
            {draft.entries.map((entry) => {
              const { project, explanation } = entry;
              const excluded = isExcluded(entry);
              const blocked = needsSyncReview(entry);
              const description =
                excluded && !entry.included
                  ? "Excluded from this Project"
                  : entry.included
                    ? [
                        explanation.reasons.some(
                          (reason) => reason.kind === "repository"
                        )
                          ? "Git Anchor"
                          : null,
                        explanation.reasons.some(
                          (reason) => reason.kind === "folder"
                        )
                          ? "Folder"
                          : null
                      ]
                        .filter(Boolean)
                        .join(" and ") || "Added directly"
                    : "Not included";
              const currentDirect = explanation.reasons.some(
                (reason) => reason.kind === "session"
              );
              return (
                <li key={project.id}>
                  <div className="personal-conversation-project-row">
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`Include in ${project.name}`}
                        checked={entry.included}
                        disabled={disabled || blocked}
                        onChange={() => toggle(entry)}
                      />
                      <span>
                        <strong>{project.name}</strong>
                        <small>
                          {entry.included && hasRule(entry)
                            ? `Included through ${description}`
                            : description}
                        </small>
                      </span>
                    </label>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="personal-conversation-caret"
                      aria-label={`Review membership in ${project.name}`}
                      aria-expanded={expanded === project.id}
                      aria-controls={`membership-${project.id}`}
                      disabled={draft.busy}
                      onClick={() =>
                        setExpanded(expanded === project.id ? null : project.id)
                      }
                    >
                      <ChevronRight aria-hidden="true" />
                    </Button>
                  </div>
                  {expanded === project.id ? (
                    <section
                      className="personal-conversation-membership-details"
                      id={`membership-${project.id}`}
                      aria-label={`${project.name} membership details`}
                    >
                      <ul>
                        {explanation.reasons.map((reason) => {
                          const rule = project.inclusionRules?.find(
                            (row) => row.inclusionId === reason.inclusionId
                          );
                          return (
                            <li key={reason.inclusionId}>
                              {reason.kind === "session"
                                ? "Direct inclusion"
                                : reason.kind === "folder"
                                  ? `Folder${rule?.folderContext ? `: ${rule.folderContext.normalizedPath}` : ""}`
                                  : `Git Anchor${rule?.target.kind === "repository" ? `: ${rule.target.repository.anchorDisplay ?? rule.target.repository.key}` : ""}`}
                              {rule?.target.kind === "folder" ? (
                                <small>
                                  Device{" "}
                                  {rule.target.folder.originatingDeviceId} ·
                                  Profile{" "}
                                  {rule.target.folder.originatingProfileId}
                                </small>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                      {blocked ? (
                        <p>
                          Open this Project’s Sync details to review its
                          exclusion changes.
                        </p>
                      ) : excluded && !entry.included ? (
                        <>
                          <p>
                            Adding back clears the reviewed exclusion and adds
                            this Conversation directly.
                          </p>
                          <Button
                            variant="outline"
                            disabled={disabled}
                            onClick={() =>
                              draft.edit(project.id, {
                                included: true,
                                direct: true,
                                restore: true
                              })
                            }
                          >
                            Add back to {project.name}
                          </Button>
                        </>
                      ) : entry.restore ? (
                        <p>The exclusion will be cleared on Confirm.</p>
                      ) : entry.included && hasRule(entry) ? (
                        <>
                          <Button
                            variant="outline"
                            disabled={disabled}
                            onClick={() =>
                              draft.edit(project.id, { direct: !entry.direct })
                            }
                          >
                            {entry.direct
                              ? `Remove direct inclusion from ${project.name}`
                              : `Also add directly to ${project.name}`}
                          </Button>
                          {currentDirect !== entry.direct ? (
                            <p>
                              Direct inclusion will be{" "}
                              {entry.direct ? "added" : "removed"} on Confirm.
                            </p>
                          ) : null}
                        </>
                      ) : null}
                      {!entry.included &&
                      explanation.included &&
                      hasRule(entry) ? (
                        <p>
                          Confirm will exclude this Conversation while keeping
                          the matching rules.
                        </p>
                      ) : null}
                    </section>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {create ? (
            <CreateProjectDialog
              create={create}
              buttonTrigger
              triggerClassName="personal-conversation-create-project"
              onCreated={(project) => void draft.addProject(project)}
              disabled={disabled}
            />
          ) : null}
          {draft.error ? (
            <p className="personal-conversation-card-error" role="alert">
              {draft.error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <span className="personal-conversation-card-status" role="status">
            {draft.changed
              ? `${draft.changed} pending ${draft.changed === 1 ? "change" : "changes"}`
              : ""}
          </span>
          <Button variant="outline" disabled={draft.busy} onClick={cancel}>
            Cancel
          </Button>
          <Button disabled={disabled} onClick={() => void draft.confirm()}>
            Confirm
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
