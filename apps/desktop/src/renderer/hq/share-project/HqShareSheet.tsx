import { Dialog, DialogPopup } from "@koed/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@koed/shared/project-contract";
import type { ProjectsDesktopApi } from "../../../ipc/projects-protocol.js";
import type { WorkspaceProjectShareContext } from "@koed/shared/workspace-project-contract";
import type { workspaceProjectMembersSchema } from "@koed/shared/workspace-project-contract";
import type { WorkspaceProjectLifecycleReview } from "@koed/shared/workspace-project-contract";
import type { z } from "zod";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import type { RemovalCoordinator } from "../sharing/removal-coordinator.js";
import {
  createShareProjectFlow,
  type ShareProjectTarget
} from "./share-project-flow.js";
import { HqSharePolicy } from "./HqSharePolicy.js";
import "./share-project.css";

export function HqShareSheet({
  open,
  project,
  projectsApi,
  collaboration,
  removalCoordinator,
  identityKey,
  onClose,
  onShared,
  onOpenSettings,
  onOpenSharing
}: {
  open: boolean;
  project: Project | null;
  projectsApi: ProjectsDesktopApi;
  collaboration: CollaborationRendererClient;
  removalCoordinator: RemovalCoordinator;
  identityKey: string;
  onClose(): void;
  onShared(): void;
  onOpenSettings?(): void;
  onOpenSharing?(): void;
}) {
  const flow = useMemo(
    () => createShareProjectFlow(projectsApi, collaboration),
    [projectsApi, collaboration]
  );
  const [context, setContext] = useState<WorkspaceProjectShareContext | null>(
    null
  );
  const [target, setTarget] = useState<ShareProjectTarget>({
    kind: "new_team"
  });
  const [attemptKey, setAttemptKey] = useState<string>(() =>
    crypto.randomUUID()
  );
  const [pending, setPending] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [autoOfferToken, setAutoOfferToken] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const currentScope = useRef("");
  const principalId = collaboration.current()?.navigation.teamPrincipal?.id;
  const scope = `${identityKey}\u0000${project?.id ?? ""}\u0000${project?.teamBackendId ?? ""}\u0000${project?.workspaceProjectId ?? ""}\u0000${principalId ?? ""}\u0000${open}`;
  if (currentScope.current !== scope) {
    currentScope.current = scope;
    requestGeneration.current += 1;
  }
  const [invitationUrl, setInvitationUrl] = useState<string | null>(null);
  const [invitationError, setInvitationError] = useState<string | null>(null);
  const [members, setMembers] = useState<z.infer<
    typeof workspaceProjectMembersSchema
  > | null>(null);
  const [ownerReview, setOwnerReview] =
    useState<WorkspaceProjectLifecycleReview | null>(null);
  const lifecycleCurrent = (request: number) =>
    requestGeneration.current === request &&
    Boolean(project?.teamBackendId && project.workspaceProjectId);
  useEffect(() => {
    if (!open || !project) return;
    let alive = true;
    const request = ++requestGeneration.current;
    setContext(null);
    setError(null);
    setDone(false);
    setAutoOfferToken(null);
    setInvitationUrl(null);
    setInvitationError(null);
    setMembers(null);
    setOwnerReview(null);
    setAttemptKey(crypto.randomUUID());
    setTarget({ kind: "new_team" });
    setPending(false);
    void (async () => {
      try {
        const next = await flow.context();
        if (!alive || requestGeneration.current !== request) return;
        setContext(next);
        if (next.state !== "ready") return;
        if (project.workspaceProjectId && project.teamBackendId) {
          return;
        }
        const attempt = await projectsApi.sharedPendingShare?.(project.id);
        if (!alive || requestGeneration.current !== request || !attempt) return;
        setPending(true);
        setAttemptKey(attempt.shareAttemptKey);
        setTarget({
          kind: "workspace",
          teamId: attempt.targetTeamId,
          workspaceId: attempt.targetWorkspaceId
        });
      } catch (caught) {
        if (alive && requestGeneration.current === request)
          setError(
            caught instanceof Error ? caught.message : "Sharing is unavailable."
          );
      }
    })();
    return () => {
      alive = false;
      requestGeneration.current += 1;
    };
  }, [open, project?.id, identityKey, principalId, flow, projectsApi]);

  useEffect(() => {
    if (!open || !project?.workspaceProjectId || !project.teamBackendId) return;
    const request = requestGeneration.current;
    void projectsApi
      .sharedMembers?.(project.workspaceProjectId, project.teamBackendId)
      .then((roster) => {
        if (requestGeneration.current === request && roster) setMembers(roster);
      })
      .catch(() => {
        if (requestGeneration.current === request) setMembers(null);
      });
  }, [
    open,
    project?.id,
    project?.workspaceProjectId,
    project?.teamBackendId,
    projectsApi,
    identityKey
  ]);
  useEffect(() => {
    if (!open || !project?.workspaceProjectId || !project.teamBackendId) return;
    const request = requestGeneration.current;
    void collaboration
      .reviewProjectLifecycle({
        projectId: project.workspaceProjectId,
        backendId: project.teamBackendId
      })
      .then((review) => {
        if (
          lifecycleCurrent(request) &&
          review.project.id === project.workspaceProjectId &&
          review.actorTeamMemberId === review.project.ownerTeamMemberId
        )
          setOwnerReview(review);
      })
      .catch(() => undefined);
  }, [
    open,
    project?.workspaceProjectId,
    project?.teamBackendId,
    collaboration,
    identityKey,
    principalId
  ]);

  const share = async () => {
    if (!project || busy || !context || context.state !== "ready") return;
    const request = requestGeneration.current;
    setBusy(true);
    setError(null);
    try {
      const result = await flow.share(
        project,
        target,
        attemptKey,
        inviteEmail || undefined
      );
      if (requestGeneration.current !== request) return;
      setInvitationUrl(result.invitationUrl);
      setInvitationError(result.invitationError);
      setDone(true);
      setAutoOfferToken(crypto.randomUUID());
      onShared();
    } catch (caught) {
      if (requestGeneration.current !== request) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "This Project could not be shared."
      );
    } finally {
      if (requestGeneration.current === request) setBusy(false);
    }
  };
  const cancelPending = async () => {
    if (!project || !pending || busy || !projectsApi.sharedCancelPendingShare)
      return;
    const request = requestGeneration.current;
    setBusy(true);
    setError(null);
    try {
      await projectsApi.sharedCancelPendingShare(project.id);
      if (requestGeneration.current !== request) return;
      setPending(false);
      setAttemptKey(crypto.randomUUID());
      setTarget({ kind: "new_team" });
    } catch (caught) {
      if (requestGeneration.current !== request) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "The pending share could not be canceled. It remains ready to resume."
      );
    } finally {
      if (requestGeneration.current === request) setBusy(false);
    }
  };
  const eligibleTeams =
    context?.teams.filter(
      (team) => team.role === "owner" || team.role === "admin"
    ) ?? [];
  const selectedTeam =
    target.kind === "new_team"
      ? null
      : context?.teams.find((team) => team.id === target.teamId);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) onClose();
      }}
    >
      <DialogPopup
        aria-label={`Share ${project?.name ?? "Project"}`}
        data-hq-shell=""
        className="hq-share-sheet"
        showCloseButton={false}
      >
        <div className="hq-share-sheet__head">
          <div>
            <span className="hq-share-sheet__eyebrow">SHARE PROJECT</span>
            <h2>{project?.name}</h2>
          </div>
          <button
            type="button"
            aria-label="Close Share Project"
            onClick={onClose}
            disabled={busy}
          >
            ×
          </button>
        </div>
        {done ? (
          <div className="hq-share-sheet__body" role="status">
            <h3>Project shared</h3>
            <p>
              Your Team can now work with this Project. Each member’s Agent
              chats stay private.
            </p>
            {invitationUrl ? (
              <>
                <p>
                  Team invitation pending. Project membership is not active
                  until verified acceptance and Project admission.
                </p>
                <label className="hq-share-sheet__field">
                  Invitation link
                  <input
                    readOnly
                    value={invitationUrl}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </label>
              </>
            ) : null}
            {invitationError ? <p role="alert">{invitationError}</p> : null}
            {project ? (
              <HqSharePolicy
                key={`${identityKey}:${project.id}`}
                identityKey={identityKey}
                personalProjectId={project.id}
                projectsApi={projectsApi}
                autoOfferToken={autoOfferToken}
              />
            ) : null}
            <button type="button" onClick={onClose}>
              Done
            </button>
          </div>
        ) : context?.state !== "ready" ? (
          <div className="hq-share-sheet__body">
            <h3>
              {!context && !error
                ? "Checking Project sharing…"
                : project?.workspaceProjectId
                  ? "Team connection unavailable"
                  : "Sign in to Koed cloud to share"}
            </h3>
            <p>
              {project?.workspaceProjectId
                ? "The current Project roster and summary-sharing policy cannot be checked until the Team connection is ready."
                : "Sharing needs a verified Team account and a configured Koed cloud connection. Your Project stays private until both are ready."}
            </p>
            {context?.state === "unavailable" ? (
              <p role="status">
                This Team connection is not ready for Project sharing.
              </p>
            ) : null}
            {onOpenSettings ? (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenSettings();
                }}
              >
                Open connection settings
              </button>
            ) : null}
          </div>
        ) : project?.workspaceProjectId ? (
          <div className="hq-share-sheet__body">
            <h3>Who’s in</h3>
            <p>
              {members
                ? `${members.people.length} people have access to this Project.`
                : "Loading current Project members…"}
            </p>
            {members ? (
              <ul>
                {members.people.map((person) => (
                  <li key={person.teamMemberId}>
                    {person.displayName} ·{" "}
                    {person.access === "write" ? "Can edit" : "Can view"}
                    {ownerReview &&
                    person.userId &&
                    person.teamMemberId !== ownerReview.actorTeamMemberId ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          void (async () => {
                            if (
                              !project.workspaceProjectId ||
                              !project.teamBackendId
                            )
                              return;
                            const request = requestGeneration.current;
                            await removalCoordinator.start([
                              {
                                name: person.displayName,
                                place: project.name,
                                async prepare() {
                                  const review =
                                    await collaboration.reviewProjectLifecycle({
                                      projectId: project.workspaceProjectId!,
                                      targetUserId: person.userId!,
                                      backendId: project.teamBackendId!
                                    });
                                  if (
                                    !lifecycleCurrent(request) ||
                                    review.targetTeamMemberId !==
                                      person.teamMemberId ||
                                    review.targetAccess === "disabled" ||
                                    review.actorTeamMemberId !==
                                      review.project.ownerTeamMemberId
                                  )
                                    throw new Error("Member review changed.");
                                  return collaboration.prepareRemoveProjectMember(
                                    {
                                      teamId: review.project.teamId,
                                      projectId: review.project.id,
                                      targetUserId: person.userId!,
                                      expectedProjectVersion:
                                        review.project.version,
                                      expectedMemberVersion:
                                        review.targetMemberVersion!,
                                      backendId: project.teamBackendId!
                                    }
                                  );
                                },
                                async reconcile() {
                                  if (!lifecycleCurrent(request)) return;
                                  try {
                                    const roster =
                                      await projectsApi.sharedMembers?.(
                                        project.workspaceProjectId!,
                                        project.teamBackendId!
                                      );
                                    if (lifecycleCurrent(request)) {
                                      if (roster) setMembers(roster);
                                      onShared();
                                    }
                                  } catch {
                                    if (lifecycleCurrent(request))
                                      setError(
                                        "Project members could not be refreshed. Retry when the Team connection returns."
                                      );
                                  }
                                }
                              }
                            ]);
                          })();
                        }}
                      >
                        Remove
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {error ? (
              <p role="alert" className="hq-share-sheet__error">
                {error}
              </p>
            ) : null}
            <p className="hq-share-sheet__muted">
              Project owners can remove members here. Team membership is managed
              in Shared groups.
            </p>
            <HqSharePolicy
              key={`${identityKey}:${project.id}`}
              identityKey={identityKey}
              personalProjectId={project.id}
              projectsApi={projectsApi}
            />
          </div>
        ) : (
          <div className="hq-share-sheet__body">
            {pending ? (
              <p role="status">
                An interrupted share is ready to resume at its original Team and
                Workspace. You can cancel that attempt before starting a
                different one.
              </p>
            ) : null}
            <label className="hq-share-sheet__field">
              Share with
              <select
                value={
                  target.kind === "new_team"
                    ? "new_team"
                    : target.kind === "workspace"
                      ? `workspace:${target.teamId}:${target.workspaceId}`
                      : `team:${target.teamId}`
                }
                disabled={busy || pending}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "new_team") setTarget({ kind: "new_team" });
                  else if (value.startsWith("workspace:")) {
                    const [, teamId, workspaceId] = value.split(":");
                    if (teamId && workspaceId)
                      setTarget({ kind: "workspace", teamId, workspaceId });
                  } else if (value.startsWith("team:"))
                    setTarget({ kind: "team", teamId: value.slice(5) });
                }}
              >
                <option value="new_team">Create a new Team</option>
                {eligibleTeams.map((team) => (
                  <option key={team.id} value={`team:${team.id}`}>
                    New Workspace in {team.name}
                  </option>
                ))}
                {context.teams.flatMap((team) =>
                  team.workspaces
                    .filter((workspace) => workspace.access === "write")
                    .map((workspace) => (
                      <option
                        key={workspace.id}
                        value={`workspace:${team.id}:${workspace.id}`}
                      >
                        Existing {team.name} / {workspace.name}
                      </option>
                    ))
                )}
              </select>
            </label>
            {selectedTeam ? (
              <p className="hq-share-sheet__muted">
                {selectedTeam.people.length} people in {selectedTeam.name}.{" "}
                {target.kind === "team"
                  ? "A new Workspace will hold this Project."
                  : "This Workspace must not already hold a shared Project."}
              </p>
            ) : null}
            <label className="hq-share-sheet__field">
              Invite someone (optional)
              <input
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="name@example.com"
                disabled={busy}
              />
            </label>
            <div className="hq-share-sheet__disclosure">
              <h3>What the Team will see</h3>
              <ul>
                <li>Project name, to-dos, and Source titles and metadata</li>
                <li>
                  Eligible captured chat summaries after your separate Native
                  review
                </li>
                <li>Updates and safe Agent progress for shared to-dos</li>
              </ul>
              <p>
                Original files, Note text, and private Agent chats do not go to
                the Team. Curated Memory needs its own review and approval.
              </p>
            </div>
            {error ? (
              <p role="alert" className="hq-share-sheet__error">
                {error}
              </p>
            ) : null}
            <div className="hq-share-sheet__actions">
              <button type="button" onClick={onClose} disabled={busy}>
                Close
              </button>
              {pending ? (
                <button
                  type="button"
                  onClick={() => void cancelPending()}
                  disabled={busy}
                >
                  Cancel pending share
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void share()}
                disabled={busy}
              >
                {busy
                  ? "Sharing…"
                  : pending
                    ? "Resume sharing"
                    : "Share Project"}
              </button>
            </div>
          </div>
        )}
        {error &&
        (context?.state !== "ready" || project?.workspaceProjectId) ? (
          <p role="alert" className="hq-share-sheet__error">
            {error}
          </p>
        ) : null}
        {onOpenSharing ? (
          <div className="hq-share-sheet__sharing-link">
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenSharing();
              }}
            >
              Everything you share
            </button>
          </div>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
