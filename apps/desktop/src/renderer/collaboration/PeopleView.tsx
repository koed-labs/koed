/**
 * Team People workflow.
 *
 * The roster is one aligned table: every person — enabled member, disabled
 * member, or pending invite — renders the same columns. Role and Workspace
 * Access edits stage into a single pending-change set and commit together,
 * so authority-sensitive writes keep their expected versions and a partial
 * failure leaves the unapplied remainder intact.
 */
import {
  type CollaborationInvitation,
  type CollaborationSnapshot,
  type CollaborationTeamPerson,
  deriveTeamPresenceSnapshot
} from "@koed/shared/collaboration";
import {
  Archive,
  BellOff,
  Check,
  CircleCheck,
  Clipboard,
  Ellipsis,
  FolderKanban,
  LogOut,
  Plus,
  RotateCcw,
  Search,
  Umbrella,
  UserPlus
} from "lucide-react";
import {
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";

import type { CollaborationRendererClient } from "../../collaboration/renderer-client.js";
import { createRendererPlatform } from "../services/platform.js";
import {
  Modal,
  ModalHeader,
  codePointLength,
  failureMessage,
  formatTime,
  initials,
  normalizedText,
  utf8ByteLength
} from "./collaboration-primitives.js";

type TeamSummary = CollaborationSnapshot["navigation"]["teams"][number];
type TeamWorkspace = TeamSummary["workspaces"][number];
type WorkspaceAccess = "disabled" | "read" | "write";
type TeamRole = "owner" | "admin" | "member";

const ROLE_LABELS: Record<TeamRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member"
};

const ROLE_RANK: Record<TeamRole, number> = {
  owner: 2,
  admin: 1,
  member: 0
};

const ACCESS_LABELS: Record<WorkspaceAccess, string> = {
  disabled: "No access",
  read: "Read",
  write: "Write"
};

type RosterFilter = "all" | TeamRole | "pending" | "disabled";
/** Statuses a person can select; "unknown" is display-only. */
type SelectableStatus = "available" | "do_not_disturb" | "out_of_office";

type PendingChange =
  | {
      kind: "role";
      teamId: string;
      userId: string;
      userName: string;
      before: TeamRole;
      after: TeamRole;
      expectedVersion: number;
    }
  | {
      kind: "access";
      teamId: string;
      workspaceId: string;
      workspaceName: string;
      userId: string;
      userName: string;
      before: WorkspaceAccess;
      after: WorkspaceAccess;
      expectedVersion: number | null;
    };

const roleChangeKey = (userId: string) => `role:${userId}`;
const accessChangeKey = (userId: string, workspaceId: string) =>
  `access:${userId}:${workspaceId}`;

const changeSummary = (change: PendingChange): string =>
  change.kind === "role"
    ? `${change.userName} · Team role: ${change.before} → ${change.after}`
    : `${change.userName} · ${change.workspaceName}: ${change.before} → ${change.after}`;

/**
 * Anchors a transient surface to its trigger with fixed positioning.
 *
 * The roster scrolls, and an absolutely positioned popover would be clipped
 * by that scroll container. Fixed positioning escapes the clip; the surface
 * flips above the trigger when it would otherwise run past the viewport.
 */
function useAnchoredSurface(open: boolean, anchor: unknown = open) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties | undefined>();

  useLayoutEffect(() => {
    if (!open) {
      setStyle(undefined);
      return;
    }
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (!trigger) return;
    const height = surfaceRef.current?.getBoundingClientRect().height ?? 0;
    const below = trigger.bottom + 4;
    const flip = height > 0 && below + height > window.innerHeight - 8;
    setStyle({
      position: "fixed",
      top: flip ? Math.max(8, trigger.top - height - 4) : below,
      insetInlineEnd: Math.max(8, window.innerWidth - trigger.right)
    });
  }, [anchor, open]);

  return { style, surfaceRef, triggerRef };
}

/**
 * Closes a transient surface on outside pointer input, Escape, or scroll.
 *
 * Scrolling matters because the surface is anchored with fixed positioning:
 * it would otherwise stay put while its trigger moves away.
 */
function useDismiss(active: boolean, onDismiss: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("pointerdown", onDismiss);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("scroll", onDismiss, true);
    return () => {
      window.removeEventListener("pointerdown", onDismiss);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("scroll", onDismiss, true);
    };
  }, [active, onDismiss]);
}

export function PeopleView({
  client,
  snapshot,
  onSelectWorkspace
}: {
  client: CollaborationRendererClient;
  snapshot: CollaborationSnapshot;
  onSelectWorkspace: (workspaceId: string) => void;
}) {
  const view = snapshot.view as Extract<
    CollaborationSnapshot["view"],
    { kind: "team_people" }
  >;
  const team = snapshot.navigation.teams.find(
    (candidate) => candidate.id === view.teamId
  )!;
  const canManage = team.role === "owner" || team.role === "admin";
  const principalId = snapshot.navigation.teamPrincipal?.id ?? "";
  const currentPerson = team.people.find((person) => person.id === principalId);
  const membershipVersion =
    team.membershipVersion ?? currentPerson?.management?.version;

  const [invitations, setInvitations] = useState<
    CollaborationInvitation[] | null
  >(null);
  const [invitationState, setInvitationState] = useState<
    "idle" | "loading" | "ready" | "denied"
  >(canManage ? "loading" : "idle");
  const [invitationError, setInvitationError] = useState("");
  const [invitationCursor, setInvitationCursor] = useState<string | null>(null);
  const [operationError, setOperationError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RosterFilter>("all");
  const [pending, setPending] = useState<Record<string, PendingChange>>({});
  const [presenceNow, setPresenceNow] = useState(() => Date.now());
  const [createdInvitation, setCreatedInvitation] = useState<{
    invitation: CollaborationInvitation;
    invitationUrl: string | null;
    copied: boolean;
  } | null>(null);

  const effectivePresenceNow = Math.max(presenceNow, Date.now());
  const pendingChanges = Object.values(pending);

  const presenceStatusLabels = new Map(
    snapshot.teamPresenceStatusCatalogue.statuses.map((status) => [
      status.key,
      status.label
    ])
  );
  const presenceStatusChoices = (
    [
      ["available", CircleCheck],
      ["do_not_disturb", BellOff],
      ["out_of_office", Umbrella]
    ] as const
  ).flatMap(([status, Icon]) => {
    const label = presenceStatusLabels.get(status);
    return label ? [[status, Icon, label] as const] : [];
  });

  useEffect(() => {
    const nextTransition = view.people
      .map(
        (person) =>
          deriveTeamPresenceSnapshot(
            {
              mode: person.teamPresence.mode,
              manualStatus: person.teamPresence.manualStatus,
              lastActivityAt: person.teamPresence.lastActivityAt,
              preferenceVersion: person.teamPresence.preferenceVersion
            },
            effectivePresenceNow
          ).nextTransitionAt
      )
      .filter((value): value is string => Boolean(value))
      .map(Date.parse)
      .filter((value) => Number.isFinite(value) && value > effectivePresenceNow)
      .sort((left, right) => left - right)[0];
    if (!nextTransition) return;
    const now = Date.now();
    const timer = window.setTimeout(
      () => setPresenceNow(Date.now()),
      Math.max(1, nextTransition - now)
    );
    return () => window.clearTimeout(timer);
  }, [effectivePresenceNow, view.people]);

  const presenceAt = (person: CollaborationTeamPerson) =>
    deriveTeamPresenceSnapshot(
      {
        mode: person.teamPresence.mode,
        manualStatus: person.teamPresence.manualStatus,
        lastActivityAt: person.teamPresence.lastActivityAt,
        preferenceVersion: person.teamPresence.preferenceVersion
      },
      effectivePresenceNow
    );

  const presenceLabel = (person: CollaborationTeamPerson): string => {
    if (person.teamPresence.mode === "manual") {
      return (
        presenceStatusLabels.get(person.teamPresence.manualStatus) ??
        "Unknown status"
      );
    }
    const activity = presenceAt(person).activityLevel;
    return activity === "active"
      ? "Active"
      : activity === "recently_active"
        ? "Recently active"
        : activity === "idle"
          ? "Idle"
          : "Inactive";
  };

  const presenceTone = (person: CollaborationTeamPerson): string => {
    if (person.teamPresence.mode === "manual") {
      return person.teamPresence.manualStatus;
    }
    return presenceAt(person).activityLevel ?? "unknown";
  };

  const loadInvitations = useCallback(
    async (cursor: string | null = null) => {
      if (!canManage) return;
      setInvitationState("loading");
      setInvitationError("");
      try {
        const page = await client.listInvitations({ teamId: team.id, cursor });
        const items = page.items.filter((item) => item.lifecycle === "pending");
        setInvitations((current) =>
          cursor
            ? [
                ...(current ?? []),
                ...items.filter(
                  (item) =>
                    !current?.some((existing) => existing.id === item.id)
                )
              ]
            : items
        );
        setInvitationCursor(page.nextCursor);
        setInvitationState("ready");
      } catch (cause) {
        setInvitations(null);
        setInvitationState("denied");
        setInvitationError(
          failureMessage(cause, "Pending invitations are not available.")
        );
      }
    },
    [canManage, client, team.id]
  );

  useEffect(() => {
    void loadInvitations(null);
  }, [loadInvitations]);

  const runOperation = async (
    key: string,
    operation: () => Promise<unknown>,
    fallback: string
  ) => {
    if (busyKey) return false;
    setBusyKey(key);
    setOperationError("");
    try {
      await operation();
      return true;
    } catch (cause) {
      setOperationError(failureMessage(cause, fallback));
      return false;
    } finally {
      setBusyKey("");
    }
  };

  // ── Effective (staged) state ────────────────────────────────────────────
  const roleOf = (person: CollaborationTeamPerson): TeamRole | null => {
    const staged = pending[roleChangeKey(person.id)];
    if (staged?.kind === "role") return staged.after;
    return person.management?.role ?? null;
  };

  const accessOf = (
    person: CollaborationTeamPerson,
    workspaceId: string
  ): WorkspaceAccess => {
    const staged = pending[accessChangeKey(person.id, workspaceId)];
    if (staged?.kind === "access") return staged.after;
    return (
      person.management?.workspaceAccess.find(
        (access) => access.workspaceId === workspaceId
      )?.access ?? "disabled"
    );
  };

  const activeWorkspaces = team.workspaces.filter(
    (workspace) => workspace.lifecycle === "active"
  );

  // Owner protection is evaluated against staged roles so a draft can never
  // commit the Team into having no owner.
  const committedEnabledOwners = team.people.filter(
    (person) =>
      person.management?.status === "enabled" &&
      person.management.role === "owner"
  ).length;
  const stagedEnabledOwners = team.people.filter(
    (person) =>
      person.management?.status === "enabled" && roleOf(person) === "owner"
  ).length;
  const lastOwner = team.role === "owner" && committedEnabledOwners <= 1;

  const stageChange = (key: string, change: PendingChange, revert: boolean) =>
    setPending((current) => {
      if (revert) {
        const remaining = { ...current };
        delete remaining[key];
        return remaining;
      }
      return { ...current, [key]: change };
    });

  const stageRole = (person: CollaborationTeamPerson, after: TeamRole) => {
    const management = person.management;
    if (!management) return;
    stageChange(
      roleChangeKey(person.id),
      {
        kind: "role",
        teamId: team.id,
        userId: person.id,
        userName: person.displayName,
        before: management.role,
        after,
        expectedVersion: management.version
      },
      after === management.role
    );
  };

  const stageAccess = (
    person: CollaborationTeamPerson,
    workspace: TeamWorkspace,
    after: WorkspaceAccess
  ) => {
    const current = person.management?.workspaceAccess.find(
      (access) => access.workspaceId === workspace.id
    );
    const before = current?.access ?? "disabled";
    stageChange(
      accessChangeKey(person.id, workspace.id),
      {
        kind: "access",
        teamId: team.id,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        userId: person.id,
        userName: person.displayName,
        before,
        after,
        expectedVersion: current?.version ?? null
      },
      after === before
    );
  };

  const applyPending = async () => {
    const entries = Object.entries(pending).sort(([, left], [, right]) => {
      const priority = (change: PendingChange) => {
        if (change.kind === "access") return 1;
        const authorityChange =
          ROLE_RANK[change.after] - ROLE_RANK[change.before];
        if (authorityChange > 0) return 0;
        if (authorityChange < 0 && change.userId === principalId) return 3;
        if (authorityChange < 0) return 2;
        return 1;
      };
      return priority(left) - priority(right);
    });
    if (entries.length === 0) return;
    await runOperation(
      "apply-pending",
      async () => {
        for (const [key, change] of entries) {
          if (change.kind === "role") {
            await client.updateMemberRole({
              teamId: change.teamId,
              userId: change.userId,
              role: change.after,
              expectedVersion: change.expectedVersion
            });
          } else {
            await client.setWorkspaceAccess({
              teamId: change.teamId,
              workspaceId: change.workspaceId,
              userId: change.userId,
              access: change.after,
              expectedVersion: change.expectedVersion
            });
          }
          setPending((current) => {
            const remaining = { ...current };
            delete remaining[key];
            return remaining;
          });
        }
      },
      "The remaining changes could not be applied. Successful changes are already reflected in the authoritative view."
    );
  };

  // ── Roster rows: members and pending invites share one shape ────────────
  const memberRows = [...view.people]
    .sort((left, right) => {
      if (left.id === principalId) return -1;
      if (right.id === principalId) return 1;
      return left.displayName.localeCompare(right.displayName);
    })
    .map((person) => ({ kind: "person" as const, person }));

  const inviteRows = (invitations ?? []).map((invitation) => ({
    kind: "invite" as const,
    invitation
  }));

  const rows = [...memberRows, ...inviteRows];

  const normalizedQuery = query.trim().toLowerCase();
  const visibleRows = rows.filter((row) => {
    if (row.kind === "invite") {
      if (
        normalizedQuery &&
        !row.invitation.email.toLowerCase().includes(normalizedQuery)
      ) {
        return false;
      }
      return filter === "all" || filter === "pending";
    }
    const { person } = row;
    if (normalizedQuery) {
      const haystack =
        `${person.displayName} ${person.management?.email ?? ""}`.toLowerCase();
      if (!haystack.includes(normalizedQuery)) return false;
    }
    if (filter === "all") return true;
    if (filter === "pending") return false;
    if (filter === "disabled") return person.membershipState === "disabled";
    return person.membershipState !== "disabled" && roleOf(person) === filter;
  });

  const counts = useMemo(() => {
    const byRole: Record<TeamRole, number> = { owner: 0, admin: 0, member: 0 };
    let disabled = 0;
    for (const person of view.people) {
      if (person.membershipState === "disabled") {
        disabled += 1;
        continue;
      }
      const role = roleOf(person);
      if (role) byRole[role] += 1;
    }
    return { byRole, disabled };
    // roleOf depends on staged roles, which is exactly when counts should move.
  }, [view.people, pending]);

  const filterChips: { key: RosterFilter; label: string; count: number }[] = [
    { key: "all", label: "All", count: rows.length },
    { key: "owner", label: "Owners", count: counts.byRole.owner },
    { key: "admin", label: "Admins", count: counts.byRole.admin },
    { key: "member", label: "Members", count: counts.byRole.member },
    ...(canManage
      ? [
          {
            key: "pending" as const,
            label: "Pending",
            count: inviteRows.length
          }
        ]
      : []),
    { key: "disabled", label: "Disabled", count: counts.disabled }
  ];

  // ── Modals ──────────────────────────────────────────────────────────────
  const submitWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = normalizedText(data.get("name")?.toString() ?? "");
    const description = normalizedText(
      data.get("description")?.toString() ?? ""
    );
    if (!name) {
      setOperationError("Enter a Workspace name.");
      return;
    }
    if (codePointLength(name) > snapshot.limits.nameMaxNormalizedCodePoints) {
      setOperationError(
        `Names can be at most ${snapshot.limits.nameMaxNormalizedCodePoints} characters.`
      );
      return;
    }
    if (
      utf8ByteLength(description) > snapshot.limits.topicDescriptionMaxUtf8Bytes
    ) {
      setOperationError("This description is too long.");
      return;
    }
    const completed = await runOperation(
      "create-workspace",
      () =>
        client.createWorkspace({
          teamId: team.id,
          name,
          description: description || null
        }),
      "The Workspace could not be created."
    );
    if (completed) setWorkspaceOpen(false);
  };

  const submitInvitation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = normalizedText(data.get("email")?.toString() ?? "");
    const role = data.get("role")?.toString() as TeamRole;
    const defaultWorkspaceId = data.get("workspaceId")?.toString() ?? "";
    const defaultWorkspaceAccess = data.get("access")?.toString() as
      | "read"
      | "write";
    if (!email || !email.includes("@")) {
      setOperationError("Enter a valid email address.");
      return;
    }
    const created = await runOperation(
      "create-invitation",
      async () => {
        const result = await client.createInvitation({
          teamId: team.id,
          email,
          role,
          defaultWorkspaceId,
          defaultWorkspaceAccess,
          ttlHours: 72
        });
        setCreatedInvitation({
          invitation: result.invitation,
          invitationUrl: result.invitationUrl,
          copied: false
        });
        setInvitations((current) => [
          result.invitation,
          ...(current ?? []).filter(
            (invitation) => invitation.id !== result.invitation.id
          )
        ]);
      },
      "The invitation could not be created."
    );
    if (!created) setCreatedInvitation(null);
  };

  const copyInvitation = async () => {
    if (!createdInvitation?.invitationUrl || busyKey) return;
    setBusyKey("copy-invitation");
    setOperationError("");
    try {
      await createRendererPlatform().copyText(createdInvitation.invitationUrl);
      setCreatedInvitation({
        ...createdInvitation,
        invitationUrl: null,
        copied: true
      });
    } catch {
      setOperationError("The invitation link could not be copied.");
    } finally {
      setBusyKey("");
    }
  };

  const revokeInvitation = (invitation: CollaborationInvitation) =>
    void runOperation(
      `revoke-${invitation.id}`,
      async () => {
        await client.revokeInvitation({
          teamId: team.id,
          invitationId: invitation.id,
          expectedVersion: invitation.version
        });
        setInvitations(
          (current) =>
            current?.filter((candidate) => candidate.id !== invitation.id) ?? []
        );
      },
      "The invitation could not be revoked."
    );

  return (
    <section className="collab-index collab-index-view collab-team-admin collab-people">
      <header className="collab-content-header">
        <div>
          <h1>People</h1>
          <p>{team.name}</p>
        </div>
        <div className="collab-header-actions">
          {currentPerson ? (
            <YourStatus
              busy={Boolean(busyKey)}
              choices={presenceStatusChoices}
              person={currentPerson}
              onSetPresence={(mode, manualStatus, key) =>
                void runOperation(
                  key,
                  () =>
                    client.setTeamPresence({
                      teamId: team.id,
                      mode,
                      manualStatus,
                      expectedVersion:
                        currentPerson.teamPresence.preferenceVersion
                    }),
                  "Your presence could not be changed."
                )
              }
            />
          ) : null}
          {canManage ? (
            <button
              type="button"
              onClick={() => {
                setOperationError("");
                setCreatedInvitation(null);
                setInviteOpen(true);
              }}
            >
              <UserPlus aria-hidden="true" /> Invite member
            </button>
          ) : null}
        </div>
      </header>

      <div className="collab-admin-scroll">
        {operationError ? (
          <p className="collab-admin-error" role="alert">
            {operationError}
          </p>
        ) : null}

        <div className="collab-roster-toolbar">
          <label className="collab-roster-search">
            <Search aria-hidden="true" />
            <input
              type="search"
              aria-label="Search people"
              placeholder="Search name or email"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <div
            className="collab-roster-filters"
            role="group"
            aria-label="Filter roster"
          >
            {filterChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                className="collab-roster-filter"
                aria-pressed={filter === chip.key}
                onClick={() => setFilter(chip.key)}
              >
                {chip.label} <small>{chip.count}</small>
              </button>
            ))}
          </div>
        </div>

        <WorkspaceStrip
          busy={Boolean(busyKey)}
          canManage={canManage}
          people={view.people}
          workspaces={team.workspaces}
          onArchive={(workspace) =>
            void runOperation(
              `archive-${workspace.id}`,
              () =>
                client.archiveWorkspace({
                  teamId: team.id,
                  workspaceId: workspace.id,
                  expectedVersion: workspace.version
                }),
              "The Workspace could not be archived."
            )
          }
          onCreate={() => {
            setOperationError("");
            setWorkspaceOpen(true);
          }}
          onOpen={onSelectWorkspace}
          onRestore={(workspace) =>
            void runOperation(
              `restore-${workspace.id}`,
              () =>
                client.restoreWorkspace({
                  teamId: team.id,
                  workspaceId: workspace.id,
                  expectedVersion: workspace.version
                }),
              "The Workspace could not be restored."
            )
          }
        />

        {canManage && invitationState === "denied" ? (
          <p className="collab-admin-error" role="alert">
            {invitationError}{" "}
            <button
              type="button"
              className="secondary"
              onClick={() => void loadInvitations(null)}
            >
              Retry
            </button>
          </p>
        ) : null}
        {canManage && invitationState === "loading" ? (
          <p className="collab-admin-empty" role="status">
            Loading pending invitations…
          </p>
        ) : null}

        {rows.length === 0 ? (
          <p className="collab-admin-empty">No Team members available.</p>
        ) : (
          <div className="collab-roster-wrap">
            <table className="collab-roster">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  {canManage ? <th scope="col">Team role</th> : null}
                  {canManage ? <th scope="col">Workspace access</th> : null}
                  <th scope="col">Status</th>
                  {canManage ? (
                    <th scope="col" className="collab-roster-actions-head">
                      <span className="collab-visually-hidden">Actions</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {visibleRows.length === 0 ? (
                  <tr>
                    <td colSpan={canManage ? 5 : 2}>
                      <p className="collab-admin-empty">
                        No one matches this search.
                      </p>
                    </td>
                  </tr>
                ) : null}
                {visibleRows.map((row) =>
                  row.kind === "person" ? (
                    <MemberRow
                      key={row.person.id}
                      accessOf={(workspaceId) =>
                        accessOf(row.person, workspaceId)
                      }
                      busy={Boolean(busyKey)}
                      canManage={canManage}
                      isCurrent={row.person.id === principalId}
                      lastCommittedOwnerHere={
                        row.person.management?.role === "owner" &&
                        committedEnabledOwners <= 1
                      }
                      lastStagedOwnerHere={
                        roleOf(row.person) === "owner" &&
                        stagedEnabledOwners <= 1
                      }
                      managerIsOwner={team.role === "owner"}
                      pending={pending}
                      person={row.person}
                      presenceLabel={presenceLabel(row.person)}
                      presenceTone={presenceTone(row.person)}
                      role={roleOf(row.person)}
                      workspaces={activeWorkspaces}
                      onDisable={() =>
                        void runOperation(
                          `disable-${row.person.id}`,
                          () =>
                            client.disableMember({
                              teamId: team.id,
                              userId: row.person.id,
                              expectedVersion: row.person.management!.version
                            }),
                          "The Team member could not be disabled."
                        )
                      }
                      onStageAccess={(workspace, access) =>
                        stageAccess(row.person, workspace, access)
                      }
                      onStageRole={(next) => stageRole(row.person, next)}
                    />
                  ) : (
                    <InviteRow
                      key={row.invitation.id}
                      busy={Boolean(busyKey)}
                      invitation={row.invitation}
                      onRevoke={() => revokeInvitation(row.invitation)}
                    />
                  )
                )}
              </tbody>
            </table>
          </div>
        )}

        {canManage && invitationCursor ? (
          <button
            type="button"
            className="collab-load-more secondary"
            onClick={() => void loadInvitations(invitationCursor)}
          >
            Load more
          </button>
        ) : null}

        {canManage && invitationState === "ready" && inviteRows.length === 0 ? (
          <p className="collab-admin-empty">No pending invitations.</p>
        ) : null}

        {membershipVersion || lastOwner ? (
          <section
            aria-label="Team membership actions"
            className="collab-leave-section"
            data-invites-visible={canManage || undefined}
          >
            {membershipVersion ? (
              <button
                type="button"
                className="danger-secondary"
                disabled={Boolean(busyKey) || lastOwner}
                title={
                  lastOwner ? "Add another owner before leaving." : undefined
                }
                onClick={() =>
                  void runOperation(
                    "leave-team",
                    () =>
                      client.leaveTeam({
                        teamId: team.id,
                        expectedVersion: membershipVersion
                      }),
                    "The Team could not be left."
                  )
                }
              >
                <LogOut aria-hidden="true" /> Leave Team
              </button>
            ) : null}
            {lastOwner ? (
              <p>The last owner must assign another owner before leaving.</p>
            ) : null}
          </section>
        ) : null}
      </div>

      {pendingChanges.length > 0 ? (
        <div
          className="collab-pending-bar"
          role="region"
          aria-label="Pending changes"
        >
          <strong role="status">
            {pendingChanges.length} pending{" "}
            {pendingChanges.length === 1 ? "change" : "changes"}
          </strong>
          <ul
            className="collab-pending-list"
            aria-label="Pending change detail"
          >
            {pendingChanges.map((change) => (
              <li
                key={
                  change.kind === "role"
                    ? roleChangeKey(change.userId)
                    : accessChangeKey(change.userId, change.workspaceId)
                }
              >
                {changeSummary(change)}
              </li>
            ))}
          </ul>
          <div className="collab-pending-actions">
            <button
              type="button"
              className="secondary"
              disabled={Boolean(busyKey)}
              onClick={() => setPending({})}
            >
              Discard
            </button>
            <button
              type="button"
              disabled={Boolean(busyKey)}
              onClick={() => void applyPending()}
            >
              {busyKey === "apply-pending" ? "Applying…" : "Apply changes"}
            </button>
          </div>
        </div>
      ) : null}

      {workspaceOpen ? (
        <Modal label="Create Workspace" onClose={() => setWorkspaceOpen(false)}>
          <ModalHeader
            title="Create Workspace"
            onClose={() => setWorkspaceOpen(false)}
          />
          <form
            className="collab-form"
            onSubmit={(event) => void submitWorkspace(event)}
          >
            <label>
              Name
              <input name="name" autoFocus />
            </label>
            <label>
              Description
              <textarea name="description" rows={3} />
            </label>
            {operationError ? (
              <p className="collab-form-error" role="alert">
                {operationError}
              </p>
            ) : null}
            <footer>
              <button
                type="button"
                className="secondary"
                onClick={() => setWorkspaceOpen(false)}
              >
                Cancel
              </button>
              <button type="submit" disabled={Boolean(busyKey)}>
                {busyKey === "create-workspace"
                  ? "Creating…"
                  : "Create Workspace"}
              </button>
            </footer>
          </form>
        </Modal>
      ) : null}

      {inviteOpen ? (
        <Modal label="Invite member" onClose={() => setInviteOpen(false)}>
          <ModalHeader
            title="Invite member"
            onClose={() => setInviteOpen(false)}
          />
          {createdInvitation ? (
            <div className="collab-invitation-created">
              <Check aria-hidden="true" />
              <strong>
                Invitation created for {createdInvitation.invitation.email}
              </strong>
              <p>The invitation link is available only in this confirmation.</p>
              {createdInvitation.invitationUrl ? (
                <button
                  type="button"
                  disabled={busyKey === "copy-invitation"}
                  onClick={() => void copyInvitation()}
                >
                  <Clipboard aria-hidden="true" /> Copy invitation link
                </button>
              ) : createdInvitation.copied ? (
                <p role="status">Invitation link copied.</p>
              ) : null}
              {operationError ? (
                <p className="collab-form-error" role="alert">
                  {operationError}
                </p>
              ) : null}
            </div>
          ) : (
            <form
              className="collab-form"
              onSubmit={(event) => void submitInvitation(event)}
            >
              <label>
                Email
                <input name="email" type="email" autoComplete="off" autoFocus />
              </label>
              <label>
                Role
                <select name="role" defaultValue="member">
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                  {team.role === "owner" ? (
                    <option value="owner">Owner</option>
                  ) : null}
                </select>
              </label>
              <label>
                Workspace
                <select
                  name="workspaceId"
                  defaultValue={activeWorkspaces[0]?.id}
                >
                  {activeWorkspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Workspace Access
                <select name="access" defaultValue="write">
                  <option value="read">Read</option>
                  <option value="write">Write</option>
                </select>
              </label>
              {operationError ? (
                <p className="collab-form-error" role="alert">
                  {operationError}
                </p>
              ) : null}
              <footer>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setInviteOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={Boolean(busyKey) || activeWorkspaces.length === 0}
                >
                  {busyKey === "create-invitation"
                    ? "Creating…"
                    : "Create invitation"}
                </button>
              </footer>
            </form>
          )}
        </Modal>
      ) : null}
    </section>
  );
}

/** Your own Team presence — a page-level preference, not a roster control. */
function YourStatus({
  busy,
  choices,
  person,
  onSetPresence
}: {
  busy: boolean;
  choices: readonly (readonly [
    SelectableStatus,
    (props: { "aria-hidden"?: "true" }) => ReactNode,
    string
  ])[];
  person: CollaborationTeamPerson;
  onSetPresence: (
    mode: "auto" | "manual",
    manualStatus: SelectableStatus,
    key: string
  ) => void;
}) {
  const auto = person.teamPresence.mode === "auto";
  return (
    <div className="collab-presence-controls" aria-label="Your Team presence">
      <label className="collab-presence-auto">
        <input
          type="checkbox"
          checked={auto}
          disabled={busy}
          onChange={(event) =>
            onSetPresence(
              event.currentTarget.checked ? "auto" : "manual",
              person.teamPresence.manualStatus === "unknown"
                ? (choices[0]?.[0] ?? "available")
                : person.teamPresence.manualStatus,
              "presence-mode"
            )
          }
        />
        <span>Auto</span>
      </label>
      <div className="collab-presence-choices">
        {choices.map(([status, Icon, label]) => {
          const selected = !auto && person.teamPresence.manualStatus === status;
          return (
            <button
              key={status}
              type="button"
              className={selected ? "selected" : ""}
              aria-label={label}
              aria-pressed={selected}
              title={label}
              disabled={busy || auto}
              onClick={() =>
                onSetPresence("manual", status, `presence-${status}`)
              }
            >
              <Icon aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function WorkspaceStrip({
  busy,
  canManage,
  people,
  workspaces,
  onArchive,
  onCreate,
  onOpen,
  onRestore
}: {
  busy: boolean;
  canManage: boolean;
  people: CollaborationTeamPerson[];
  workspaces: TeamWorkspace[];
  onArchive: (workspace: TeamWorkspace) => void;
  onCreate: () => void;
  onOpen: (workspaceId: string) => void;
  onRestore: (workspace: TeamWorkspace) => void;
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const closeMenu = useCallback(() => setOpenMenu(null), []);
  const menuAnchor = useAnchoredSurface(openMenu !== null, openMenu);
  useDismiss(openMenu !== null, closeMenu);

  if (workspaces.length === 0 && !canManage) {
    return <p className="collab-admin-empty">No Workspaces available.</p>;
  }

  return (
    <div
      className="collab-workspace-strip"
      aria-label="Workspaces"
      role="group"
    >
      {workspaces.map((workspace) => {
        const withAccess = people.filter((person) =>
          person.management?.workspaceAccess.some(
            (access) =>
              access.workspaceId === workspace.id &&
              access.access !== "disabled"
          )
        ).length;
        const archived = workspace.lifecycle !== "active";
        return (
          <div
            className="collab-workspace-card"
            data-state={archived ? "archived" : "active"}
            key={workspace.id}
          >
            <button
              type="button"
              className="collab-workspace-open"
              aria-label={`Open ${workspace.name}`}
              disabled={archived}
              onClick={() => onOpen(workspace.id)}
            >
              <span className="collab-workspace-glyph" aria-hidden="true">
                <FolderKanban />
              </span>
              <b className="collab-workspace-name">{workspace.name}</b>
              <span className="collab-workspace-meta">
                {archived
                  ? "Archived"
                  : canManage
                    ? `${withAccess} with access`
                    : workspace.description || "Active Workspace"}
              </span>
            </button>
            {canManage ? (
              <div className="collab-menu-host">
                <button
                  type="button"
                  className="collab-icon-button collab-workspace-more"
                  aria-label={`Actions for ${workspace.name}`}
                  aria-expanded={openMenu === workspace.id}
                  ref={
                    openMenu === workspace.id
                      ? menuAnchor.triggerRef
                      : undefined
                  }
                  disabled={busy}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() =>
                    setOpenMenu((current) =>
                      current === workspace.id ? null : workspace.id
                    )
                  }
                >
                  <Ellipsis aria-hidden="true" />
                </button>
                {openMenu === workspace.id ? (
                  <div
                    className="collab-menu"
                    role="menu"
                    ref={menuAnchor.surfaceRef}
                    style={menuAnchor.style}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    {archived ? (
                      <button
                        type="button"
                        role="menuitem"
                        disabled={busy}
                        onClick={() => {
                          closeMenu();
                          onRestore(workspace);
                        }}
                      >
                        <RotateCcw aria-hidden="true" /> Restore
                      </button>
                    ) : (
                      <button
                        type="button"
                        role="menuitem"
                        className="danger"
                        disabled={busy}
                        onClick={() => {
                          closeMenu();
                          onArchive(workspace);
                        }}
                      >
                        <Archive aria-hidden="true" /> Archive
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {canManage ? (
        <button
          type="button"
          className="collab-workspace-card collab-workspace-new"
          onClick={onCreate}
        >
          <Plus aria-hidden="true" /> Create Workspace
        </button>
      ) : null}
    </div>
  );
}

function MemberRow({
  accessOf,
  busy,
  canManage,
  isCurrent,
  lastCommittedOwnerHere,
  lastStagedOwnerHere,
  managerIsOwner,
  pending,
  person,
  presenceLabel,
  presenceTone,
  role,
  workspaces,
  onDisable,
  onStageAccess,
  onStageRole
}: {
  accessOf: (workspaceId: string) => WorkspaceAccess;
  busy: boolean;
  canManage: boolean;
  isCurrent: boolean;
  lastCommittedOwnerHere: boolean;
  lastStagedOwnerHere: boolean;
  managerIsOwner: boolean;
  pending: Record<string, PendingChange>;
  person: CollaborationTeamPerson;
  presenceLabel: string;
  presenceTone: string;
  role: TeamRole | null;
  workspaces: TeamWorkspace[];
  onDisable: () => void;
  onStageAccess: (workspace: TeamWorkspace, access: WorkspaceAccess) => void;
  onStageRole: (role: TeamRole) => void;
}) {
  const [accessOpen, setAccessOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeAccess = useCallback(() => setAccessOpen(false), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const accessAnchor = useAnchoredSurface(accessOpen);
  const menuAnchor = useAnchoredSurface(menuOpen);
  useDismiss(accessOpen, closeAccess);
  useDismiss(menuOpen, closeMenu);

  const management = person.management;
  const disabled = person.membershipState === "disabled";
  // Owners are only demotable by another owner, and never the last one.
  const canChangeTarget =
    canManage &&
    management?.status === "enabled" &&
    (management.role !== "owner" || managerIsOwner);
  const protectedOwner =
    role === "owner" && (!managerIsOwner || lastStagedOwnerHere);
  const disableReason =
    management?.role === "owner" && !managerIsOwner
      ? "Only a Team owner can disable another owner."
      : lastCommittedOwnerHere
        ? "The last owner cannot be disabled."
        : null;
  const roleDirty = Boolean(pending[roleChangeKey(person.id)]);
  const accessDirty = workspaces.some((workspace) =>
    Boolean(pending[accessChangeKey(person.id, workspace.id)])
  );

  const granted = workspaces
    .map((workspace) => accessOf(workspace.id))
    .filter((access) => access !== "disabled");
  const accessSummary =
    granted.length === 0
      ? "No access"
      : `${
          granted.every((access) => access === granted[0])
            ? ACCESS_LABELS[granted[0]!]
            : "Mixed"
        } · ${granted.length} ${granted.length === 1 ? "Workspace" : "Workspaces"}`;

  return (
    <tr
      className="collab-person-row"
      data-current-user={isCurrent || undefined}
      data-membership={disabled ? "disabled" : undefined}
    >
      <td>
        <div className="collab-person-identity">
          <span className="collab-avatar collab-person-avatar">
            {initials(person.displayName)}
            <span
              aria-hidden="true"
              className="collab-presence-icon"
              data-presence={presenceTone}
              title={presenceLabel}
            />
          </span>
          <div>
            <strong>
              {person.displayName}
              {isCurrent ? <span className="collab-me-badge">Me</span> : null}
              {disabled ? (
                <span className="collab-member-state">Disabled</span>
              ) : null}
            </strong>
            {management?.email ? <span>{management.email}</span> : null}
          </div>
        </div>
      </td>

      {canManage ? (
        <td className="collab-roster-role">
          {management && management.status === "enabled" ? (
            <select
              className="collab-member-role"
              aria-label={`Team role for ${person.displayName}`}
              data-dirty={roleDirty || undefined}
              value={role ?? management.role}
              disabled={busy || protectedOwner}
              title={
                protectedOwner
                  ? "The last owner must remain an owner."
                  : undefined
              }
              onChange={(event) =>
                onStageRole(event.currentTarget.value as TeamRole)
              }
            >
              {(Object.keys(ROLE_LABELS) as TeamRole[])
                .filter(
                  (value) =>
                    value !== "owner" || managerIsOwner || role === "owner"
                )
                .map((value) => (
                  <option key={value} value={value}>
                    {ROLE_LABELS[value]}
                  </option>
                ))}
            </select>
          ) : (
            <span className="collab-roster-quiet">
              {role ? ROLE_LABELS[role] : "—"}
            </span>
          )}
        </td>
      ) : null}

      {canManage ? (
        <td className="collab-roster-access">
          {management && workspaces.length > 0 ? (
            <div className="collab-menu-host">
              <button
                type="button"
                className="collab-access-summary"
                aria-label={`Workspace access for ${person.displayName}`}
                aria-expanded={accessOpen}
                ref={accessAnchor.triggerRef}
                data-dirty={accessDirty || undefined}
                disabled={busy || !canChangeTarget}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setAccessOpen((current) => !current)}
              >
                <span className="collab-access-bars" aria-hidden="true">
                  {workspaces.map((workspace) => {
                    const access = accessOf(workspace.id);
                    return (
                      <i
                        key={workspace.id}
                        data-access={access === "disabled" ? undefined : access}
                      />
                    );
                  })}
                </span>
                <em>{accessSummary}</em>
              </button>
              {accessOpen ? (
                <div
                  className="collab-access-popover"
                  role="group"
                  aria-label={`Workspace access options for ${person.displayName}`}
                  ref={accessAnchor.surfaceRef}
                  style={accessAnchor.style}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  {workspaces.map((workspace) => (
                    <label key={workspace.id}>
                      <span>{workspace.name}</span>
                      <select
                        aria-label={`${workspace.name} access for ${person.displayName}`}
                        value={accessOf(workspace.id)}
                        disabled={busy || !canChangeTarget}
                        onChange={(event) =>
                          onStageAccess(
                            workspace,
                            event.currentTarget.value as WorkspaceAccess
                          )
                        }
                      >
                        <option value="disabled">No access</option>
                        <option value="read">Read</option>
                        <option value="write">Write</option>
                      </select>
                    </label>
                  ))}
                  <p>Changes are staged until you apply them.</p>
                </div>
              ) : null}
            </div>
          ) : (
            <span className="collab-roster-quiet">—</span>
          )}
        </td>
      ) : null}

      <td className="collab-roster-status">
        <span>{presenceLabel}</span>
      </td>

      {canManage ? (
        <td className="collab-roster-actions">
          {management?.status === "enabled" && !isCurrent ? (
            <div className="collab-menu-host">
              <button
                type="button"
                className="collab-icon-button"
                aria-label={`Actions for ${person.displayName}`}
                aria-expanded={menuOpen}
                ref={menuAnchor.triggerRef}
                disabled={busy}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setMenuOpen((current) => !current)}
              >
                <Ellipsis aria-hidden="true" />
              </button>
              {menuOpen ? (
                <div
                  className="collab-menu"
                  role="menu"
                  ref={menuAnchor.surfaceRef}
                  style={menuAnchor.style}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className={`danger${disableReason ? " collab-menu-item-with-reason" : ""}`}
                    disabled={
                      busy || !canChangeTarget || lastCommittedOwnerHere
                    }
                    onClick={() => {
                      closeMenu();
                      onDisable();
                    }}
                  >
                    <span>Disable</span>
                    {disableReason ? <small>{disableReason}</small> : null}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </td>
      ) : null}
    </tr>
  );
}

function InviteRow({
  busy,
  invitation,
  onRevoke
}: {
  busy: boolean;
  invitation: CollaborationInvitation;
  onRevoke: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const menuAnchor = useAnchoredSurface(menuOpen);
  useDismiss(menuOpen, closeMenu);

  return (
    <tr className="collab-person-row collab-invite-row" data-pending="true">
      <td>
        <div className="collab-person-identity">
          <span className="collab-avatar collab-person-avatar collab-avatar-pending">
            {initials(invitation.email)}
          </span>
          <div>
            <strong>
              {invitation.email}
              <span className="collab-invite-badge">Pending</span>
            </strong>
            <span>expires {formatTime(invitation.expiresAt)}</span>
          </div>
        </div>
      </td>
      <td className="collab-roster-role">
        <span className="collab-roster-quiet">
          {ROLE_LABELS[invitation.role as TeamRole] ?? invitation.role}
        </span>
      </td>
      <td className="collab-roster-access">
        <span className="collab-roster-quiet">—</span>
      </td>
      <td className="collab-roster-status">
        <span>Awaiting acceptance</span>
      </td>
      <td className="collab-roster-actions">
        <div className="collab-menu-host">
          <button
            type="button"
            className="collab-icon-button"
            aria-label={`Actions for ${invitation.email}`}
            aria-expanded={menuOpen}
            ref={menuAnchor.triggerRef}
            disabled={busy}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setMenuOpen((current) => !current)}
          >
            <Ellipsis aria-hidden="true" />
          </button>
          {menuOpen ? (
            <div
              className="collab-menu"
              role="menu"
              ref={menuAnchor.surfaceRef}
              style={menuAnchor.style}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                className="danger"
                disabled={busy}
                onClick={() => {
                  closeMenu();
                  onRevoke();
                }}
              >
                Revoke
              </button>
            </div>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
