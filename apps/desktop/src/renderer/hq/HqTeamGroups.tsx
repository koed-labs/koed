import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { CollaborationRendererClient } from "../../collaboration/renderer-client.js";
import type { ProjectsDesktopApi } from "../../ipc/projects-protocol.js";
import type { WorkspaceProjectRestorable } from "@koed/shared/workspace-project-contract";

type TeamRow = {
  id: string;
  name: string;
  membershipVersion?: number;
  role: "owner" | "admin" | "member";
};
type Review = {
  team: TeamRow;
  ownedCount: number;
  membershipVersion: number;
  backendId: string;
  pendingLeaveOperationId: string | null;
};

export function HqTeamGroups({
  open,
  onClose,
  onFinished,
  client,
  projectsApi,
  ownerId,
  profileKey,
  requestedTeamId,
  onLeave
}: {
  open: boolean;
  onClose(): void;
  onFinished(): void;
  client: CollaborationRendererClient;
  projectsApi: ProjectsDesktopApi;
  ownerId: string | null | undefined;
  profileKey: string | null | undefined;
  requestedTeamId?: string | null;
  onLeave?: (teamId: string, expectedVersion: number) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restorable, setRestorable] = useState<WorkspaceProjectRestorable[]>(
    []
  );
  const generation = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const snapshot = client.current();
  const backendId = snapshot?.connection.backendId;
  const principalId = snapshot?.navigation.teamPrincipal?.id;
  const identity = `${ownerId ?? ""}|${profileKey ?? ""}|${backendId ?? ""}|${principalId ?? ""}|${open}`;
  useEffect(() => {
    generation.current++;
    setSelectedId(requestedTeamId ?? null);
    setReview(null);
    setError(null);
    setNotice(null);
    setBusy(false);
    setRestorable([]);
    if (!open || !backendId || !principalId) return;
    const expected = generation.current;
    void client
      .listRestorableProjects()
      .then((items) => {
        if (
          generation.current === expected &&
          client.current()?.connection.backendId === backendId &&
          client.current()?.navigation.teamPrincipal?.id === principalId
        )
          setRestorable(items);
      })
      .catch(() => undefined);
    return () => {
      generation.current++;
    };
  }, [identity, client, requestedTeamId]);
  useEffect(() => {
    if (!open) return;
    trigger.current = document.activeElement as HTMLElement | null;
    dialog.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    return () => {
      trigger.current?.focus();
    };
  }, [open]);
  useEffect(() => {
    if (open)
      dialog.current
        ?.querySelector<HTMLElement>("button:not(:disabled)")
        ?.focus();
  }, [open, review]);
  if (!open) return null;
  const teams = (snapshot?.navigation.teams ?? []) as TeamRow[];
  const current = (expected: number, backend: string) =>
    generation.current === expected &&
    client.current()?.connection.backendId === backend &&
    client.current()?.navigation.teamPrincipal?.id === principalId;
  const begin = async (team: TeamRow) => {
    if (!backendId || !projectsApi.sharedTeamLeaveStage || busy) return;
    const expected = generation.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const stage = await projectsApi.sharedTeamLeaveStage(backendId, team.id);
      if (!current(expected, backendId)) return;
      if (
        stage.teamId !== team.id ||
        stage.expectedMembershipVersion !== team.membershipVersion
      )
        throw new Error("Group membership changed. Refresh and review again.");
      setReview({
        team,
        ownedCount: stage.expectedOwnedWorkspaceProjects.length,
        membershipVersion: stage.expectedMembershipVersion,
        backendId,
        pendingLeaveOperationId: stage.pendingLeaveOperationId ?? null
      });
    } catch (cause) {
      if (current(expected, backendId))
        setError(
          cause instanceof Error
            ? cause.message
            : "Group review is unavailable."
        );
    } finally {
      if (current(expected, backendId)) setBusy(false);
    }
  };
  const leave = async () => {
    if (
      !review ||
      busy ||
      !current(generation.current, review.backendId) ||
      !teams.some(
        ({ id, membershipVersion }) =>
          id === review.team.id &&
          membershipVersion === review.membershipVersion
      )
    )
      return;
    const expected = generation.current;
    setBusy(true);
    setError(null);
    try {
      if (onLeave) await onLeave(review.team.id, review.membershipVersion);
      else
        await client.leaveTeam({
          teamId: review.team.id,
          expectedVersion: review.membershipVersion
        });
      if (!current(expected, review.backendId)) return;
      setReview(null);
      setSelectedId(null);
      setNotice(
        `Left ${review.team.name}. A new invitation is needed to return.`
      );
      setRestorable((items) =>
        items.filter(({ teamId }) => teamId !== review.team.id)
      );
      onFinished();
    } catch (cause) {
      if (current(expected, review.backendId))
        setError(
          cause instanceof Error
            ? cause.message
            : "Group departure needs review."
        );
    } finally {
      if (current(expected, review.backendId)) setBusy(false);
    }
  };
  const selected = teams.find((team) => team.id === selectedId) ?? null;
  const cancelUrl = (() => {
    if (!review?.pendingLeaveOperationId) return null;
    const remote = client.currentRemoteUrl();
    if (!remote) return null;
    try {
      const base = new URL(remote);
      if (
        !["https:", "http:"].includes(base.protocol) ||
        base.username ||
        base.password
      )
        return null;
      base.pathname = `${base.pathname.replace(/\/$/, "")}/team-leave/${encodeURIComponent(review.team.id)}`;
      base.search = "";
      base.hash = "";
      return base.toString();
    } catch {
      return null;
    }
  })();
  const keepFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const controls = [
      ...(dialog.current?.querySelectorAll<HTMLElement>(
        "a[href],button:not(:disabled)"
      ) ?? [])
    ];
    if (!controls.length) return;
    const first = controls[0]!,
      last = controls[controls.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="hq-project-modal-backdrop" data-hq-shell="">
      <div
        ref={dialog}
        className="hq-project-modal hq-team-groups"
        role="dialog"
        aria-modal="true"
        aria-label={review ? `Leave ${review.team.name}` : "Shared groups"}
        onKeyDown={(event) => {
          keepFocus(event);
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            if (review) setReview(null);
            else onClose();
          }
        }}
      >
        {review ? (
          <>
            <h2>Leave {review.team.name}?</h2>
            <p>
              You will lose access to Projects owned by other people in this
              group.
              {review.ownedCount > 0
                ? ` Your ${review.ownedCount} owned ${review.ownedCount === 1 ? "Project stays" : "Projects stay"} in Just me with their to-dos and private chats. Their Team links close for everyone.`
                : " Your private chats and Personal memory stay with you."}
            </p>
            <p>
              Published Team evidence stays with the group as a frozen record.
              Your Personal memory remains yours. A member must send a new
              invitation if you return. Leaving has no Undo.
            </p>
            {review.pendingLeaveOperationId ? (
              <p role="status">
                A previous departure is pending.
                {cancelUrl ? (
                  <>
                    {" "}
                    <a
                      href={cancelUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Review and cancel it in your browser
                    </a>
                    , then review this group again.
                  </>
                ) : (
                  " Open your Team browser session to review and cancel it."
                )}
              </p>
            ) : null}
            {error ? (
              <p className="hq-project-modal__error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="hq-project-modal__actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => setReview(null)}
              >
                Back
              </button>
              <button
                type="button"
                className="hq-project-modal__danger"
                disabled={busy || !!review.pendingLeaveOperationId}
                onClick={() => void leave()}
              >
                {busy ? "Leaving…" : "Leave group"}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>Shared groups</h2>
            {teams.length ? (
              <div className="hq-team-groups__list">
                {teams.map((team) => (
                  <button
                    key={team.id}
                    type="button"
                    disabled={busy}
                    className={selectedId === team.id ? "is-selected" : ""}
                    onClick={() => {
                      setSelectedId(team.id);
                      setError(null);
                    }}
                    aria-pressed={selectedId === team.id}
                  >
                    <span>{team.name}</span>
                    <small>{team.role}</small>
                  </button>
                ))}
              </div>
            ) : (
              <p>You are not in a shared group on this connection.</p>
            )}
            {restorable.length ? (
              <div className="hq-team-groups__restorable">
                <h3>Recently deleted Projects</h3>
                {restorable.map((item) => (
                  <div key={item.projectId}>
                    <span>{item.name}</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        void (async () => {
                          const expected = generation.current;
                          setBusy(true);
                          setError(null);
                          try {
                            await client.restoreSharedProject({
                              teamId: item.teamId,
                              projectId: item.projectId,
                              expectedProjectVersion: item.version
                            });
                            if (current(expected, backendId!)) {
                              setRestorable((items) =>
                                items.filter(
                                  ({ projectId }) =>
                                    projectId !== item.projectId
                                )
                              );
                              setNotice(
                                `${item.name} metadata and thread restored. Members need new access.`
                              );
                              onFinished();
                            }
                          } catch (cause) {
                            if (current(expected, backendId!))
                              setError(
                                cause instanceof Error
                                  ? cause.message
                                  : "Restore needs review."
                              );
                          } finally {
                            if (current(expected, backendId!)) setBusy(false);
                          }
                        })();
                      }}
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {notice ? <p role="status">{notice}</p> : null}
            {error ? (
              <p className="hq-project-modal__error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="hq-project-modal__actions">
              <button
                data-hq-team-groups-close
                type="button"
                disabled={busy}
                onClick={onClose}
              >
                Done
              </button>
              <button
                type="button"
                className="hq-project-modal__danger"
                disabled={
                  !selected ||
                  !selected.membershipVersion ||
                  !backendId ||
                  !projectsApi.sharedTeamLeaveStage ||
                  busy
                }
                onClick={() => selected && void begin(selected)}
              >
                {busy ? "Reviewing…" : "Review leave"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
