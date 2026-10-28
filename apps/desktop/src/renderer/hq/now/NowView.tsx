import {
  ChevronDown,
  CircleHelp,
  CalendarDays,
  Folder,
  RotateCw,
  ShieldAlert
} from "lucide-react";
import { soloEdition } from "../../edition.js";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type { Project } from "@koed/shared";
import type { WorkItem } from "@koed/shared/work-item-contract";
import type { WorkspaceProjectWorkItem } from "@koed/shared";
import type { ProjectsDesktopApi } from "../../../ipc/projects-protocol.js";
import {
  projectNavigation,
  type ProjectNavigationRow
} from "../project-navigation.js";
import type {
  ManagedConversationDesktopApi,
  ManagedConversationRuntimeItem,
  ManagedConversationListEntry
} from "../../../ipc/managed-conversation-protocol.js";
import type {
  CollaborationActionGrantProjection,
  CollaborationRendererClient
} from "../../../collaboration/renderer-client.js";
import type { CollaborationMyInvitation } from "@koed/shared/collaboration";
import type { ManagedConversationLifecycle } from "../../state/use-managed-conversation-lifecycle.js";
import {
  nowNeedsFromApprovals,
  nowNeedsFromRuntime,
  nowInspectableExecutions,
  nowProjectStatus,
  nowPersonalProjectStatus,
  nowNeedsFromExecutionInventory,
  nowProjects,
  nowVisible
} from "./now-model.js";
import type { NowNeed } from "./now-model.js";
import { sameInvitationAuthority } from "./invitation-authority.js";
import { readNowPreferences, writeNowPreferences } from "./now-preferences.js";
import { ExecutionMemoryChips } from "../memory/ExecutionMemoryChips.js";
import { latestRuntimeTurn } from "../memory/execution-memory-chips.js";
import {
  dueChip,
  nowDeadlineItems,
  nowSharedDeadlineItems
} from "../due/hq-due-model.js";
import { viewerTimeZone } from "../project/hq-work-item-model.js";
import { NowScheduledJobs } from "../jobs/NowScheduledJobs.js";
import type { Agent } from "@koed/shared/agent-contract";
import { actionableScheduledRuns } from "../jobs/scheduled-jobs-model.js";
import type { ScheduledJobInventory } from "../jobs/use-scheduled-jobs.js";
import "./now.css";

export function NowView({
  projects,
  personalProjects,
  projectsApi,
  api,
  invitationsClient,
  lifecycle,
  approvals,
  blockedConversationSessions,
  projectsReady = false,
  projectsLoading = false,
  projectsError = false,
  ownerId,
  profileKey,
  memoryPanelHost,
  onMemoryPanelOpenChange,
  onOpenCitationMessage,
  onSelectProject,
  onJoinedProject,
  onSelectDueItem,
  onSelectConversation,
  scheduledJobs,
  onOpenJob,
  scheduledJobAgents
}: {
  projects: readonly DesktopProject[];
  personalProjects?: readonly Project[];
  projectsApi?: ProjectsDesktopApi | null;
  api?: ManagedConversationDesktopApi | null;
  invitationsClient?: CollaborationRendererClient | null;
  lifecycle?: ManagedConversationLifecycle;
  approvals: readonly CollaborationActionGrantProjection[];
  blockedConversationSessions?: ReadonlySet<string>;
  projectsReady?: boolean;
  projectsLoading?: boolean;
  projectsError?: boolean;
  ownerId?: string | null;
  profileKey?: string | null;
  memoryPanelHost?: HTMLElement | null;
  onMemoryPanelOpenChange?: (open: boolean) => void;
  onOpenCitationMessage?: (
    target: NonNullable<
      import("../../../ipc/managed-conversation-protocol.js").ManagedConversationTurnCitation["messageTarget"]
    >
  ) => Promise<boolean>;
  onSelectProject: (id: string) => void;
  onJoinedProject?: (id: string) => Promise<void>;
  onSelectDueItem?: (projectId: string, itemId: string) => void;
  onSelectConversation: (need: NowNeed) => void;
  scheduledJobs?: ScheduledJobInventory;
  onOpenJob?: (sessionId: string, projectId: string | null) => Promise<boolean>;
  scheduledJobAgents?: readonly Agent[];
}) {
  const [preferences, setPreferences] = useState(readNowPreferences);
  const [moreNeeds, setMoreNeeds] = useState(false);
  const [moreProjects, setMoreProjects] = useState(false);
  const [moreDues, setMoreDues] = useState(false);
  const [duesOpen, setDuesOpen] = useState(false);
  const [dueInventory, setDueInventory] = useState<{
    api: ProjectsDesktopApi | null;
    ownerId: string | null;
    profileKey: string | null;
    projectKey: string;
    items: ReadonlyMap<string, readonly WorkItem[]>;
    sharedItems: ReadonlyMap<string, readonly WorkspaceProjectWorkItem[]>;
    loading: boolean;
    error: string;
    notice: string;
  } | null>(null);
  const [memoryPanelRow, setMemoryPanelRow] = useState<string | null>(null);
  const [runtimeItems, setRuntimeItems] = useState<
    ReadonlyMap<string, readonly ManagedConversationRuntimeItem[]>
  >(new Map());
  const [runtimeGenerations, setRuntimeGenerations] = useState<
    ReadonlyMap<string, number>
  >(new Map());
  const [executions, setExecutions] = useState<
    readonly ManagedConversationListEntry[]
  >([]);
  const [complete, setComplete] = useState(false);
  const [inventoryTruncated, setInventoryTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [runtimeError, setRuntimeError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const invitationAuthority = () => {
    if (!invitationsClient || !ownerId || !profileKey) return null;
    const snapshot = invitationsClient.current();
    const remoteUrl = invitationsClient.currentRemoteUrl();
    if (
      !snapshot ||
      !snapshot.connection.backendId ||
      !remoteUrl ||
      snapshot.navigation.personalOwner.id !== ownerId ||
      profileKey !==
        `${snapshot.connection.backendId}|${snapshot.connection.connectedAt ?? ""}|${remoteUrl}`
    )
      return null;
    return JSON.stringify([
      ownerId,
      profileKey,
      snapshot.navigation.personalOwner.id,
      snapshot.navigation.teamPrincipal?.id ?? null,
      snapshot.connection.backendId,
      remoteUrl
    ]);
  };
  const authorityKey = useSyncExternalStore(
    (notify) => invitationsClient?.subscribe(() => notify()) ?? (() => {}),
    invitationAuthority,
    () => null
  );
  const [invitationSnapshot, setInvitationSnapshot] = useState<{
    authorityKey: string;
    items: readonly CollaborationMyInvitation[];
  } | null>(null);
  const invitations =
    invitationSnapshot?.authorityKey === authorityKey
      ? invitationSnapshot.items
      : [];
  const [invitationError, setInvitationError] = useState("");
  const [invitationBusy, setInvitationBusy] = useState<string | null>(null);
  const [joinRecovery, setJoinRecovery] = useState<{
    authorityKey: string;
    workspaceProjectId: string;
    teamBackendId: string;
    name: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    setInvitationSnapshot(null);
    setInvitationError("");
    setInvitationBusy(null);
    if (joinRecovery && joinRecovery.authorityKey !== authorityKey)
      setJoinRecovery(null);
    if (!invitationsClient || !authorityKey) {
      return;
    }
    void invitationsClient
      .listMyInvitations()
      .then((items) => {
        if (active && invitationAuthority() === authorityKey) {
          setInvitationSnapshot({ authorityKey, items });
          setInvitationError("");
        }
      })
      .catch(() => {
        if (active && invitationAuthority() === authorityKey) {
          setInvitationSnapshot(null);
          setInvitationError(
            "Team invitations could not load. Refresh to try again."
          );
        }
      });
    return () => {
      active = false;
    };
  }, [invitationsClient, authorityKey, refreshKey]);
  const decideInvitation = async (
    invite: CollaborationMyInvitation,
    decision: "accept" | "decline"
  ) => {
    if (
      !invitationsClient ||
      !authorityKey ||
      invitationBusy ||
      invitationSnapshot?.authorityKey !== authorityKey
    )
      return;
    const decisionAuthority = authorityKey;
    let continuingAuthority = decisionAuthority;
    let joinStarted = false;
    setInvitationBusy(invite.id);
    setInvitationError("");
    try {
      await invitationsClient.decideInvitation(invite, decision);
      // Accepting a first invitation can establish the Team principal while
      // the local owner, backend and URL remain the same. Continue the join
      // under that fresh authority rather than abandoning it as a switch.
      const joinedAuthority = invitationAuthority();
      if (
        !joinedAuthority ||
        !sameInvitationAuthority(
          decisionAuthority,
          joinedAuthority,
          decision === "accept"
        )
      )
        return;
      continuingAuthority = joinedAuthority;
      if (decision === "accept" && invite.project) {
        const backendId = invitationsClient.current()?.connection.backendId;
        if (!backendId || !projectsApi?.sharedJoinProject)
          throw new Error("Joined Project setup is unavailable");
        const recovery = {
          authorityKey: joinedAuthority,
          workspaceProjectId: invite.project.id,
          teamBackendId: backendId,
          name: invite.project.name
        };
        setJoinRecovery(recovery);
        joinStarted = true;
        const joined = await projectsApi.sharedJoinProject(
          recovery.workspaceProjectId,
          recovery.teamBackendId
        );
        if (invitationAuthority() === joinedAuthority) {
          await onJoinedProject?.(joined.id);
          if (invitationAuthority() === joinedAuthority) setJoinRecovery(null);
        }
      }
      if (invitationAuthority() === joinedAuthority)
        setRefreshKey((value) => value + 1);
    } catch {
      if (invitationAuthority() === continuingAuthority) {
        setInvitationError(
          joinStarted
            ? "Project setup is incomplete. Retry to finish joining."
            : "Invitation changed or the review was canceled. Refresh to check its current state."
        );
        setRefreshKey((value) => value + 1);
      }
    } finally {
      if (invitationAuthority() === continuingAuthority)
        setInvitationBusy(null);
    }
  };
  const retryJoinedProject = async () => {
    const recovery = joinRecovery;
    if (
      !recovery ||
      recovery.authorityKey !== authorityKey ||
      invitationAuthority() !== recovery.authorityKey ||
      !projectsApi?.sharedJoinProject ||
      invitationBusy
    )
      return;
    setInvitationBusy(recovery.workspaceProjectId);
    setInvitationError("");
    try {
      const joined = await projectsApi.sharedJoinProject(
        recovery.workspaceProjectId,
        recovery.teamBackendId
      );
      if (invitationAuthority() === recovery.authorityKey) {
        await onJoinedProject?.(joined.id);
        if (invitationAuthority() !== recovery.authorityKey) return;
        setJoinRecovery(null);
        setRefreshKey((value) => value + 1);
      }
    } catch {
      if (invitationAuthority() === recovery.authorityKey)
        setInvitationError(
          "Project setup is incomplete. Retry to finish joining."
        );
    } finally {
      if (invitationAuthority() === recovery.authorityKey)
        setInvitationBusy(null);
    }
  };
  const [sourceApi, setSourceApi] =
    useState<ManagedConversationDesktopApi | null>(null);
  const [sourceOwnerId, setSourceOwnerId] = useState<string | null>(null);
  const [sourceProfileKey, setSourceProfileKey] = useState<string | null>(null);
  const [approvalClock, setApprovalClock] = useState(0);
  const drafts = lifecycle?.drafts;
  const draftIdentityKey = [...(drafts?.keys() ?? [])].sort().join("\u0000");
  // Solo has no to-dos, so there are no deadlines to read.
  const solo = soloEdition();
  const privateDueProjects = (solo ? [] : (personalProjects ?? [])).filter(
    (project) => !project.workspaceProjectId
  );
  const sharedDueProjects = (solo ? [] : (personalProjects ?? [])).filter(
    (project) =>
      project.workspaceProjectId &&
      project.teamBackendId &&
      project.teamWorkspaceId
  );
  const incompleteSharedLink = (personalProjects ?? []).some(
    (project) =>
      project.workspaceProjectId &&
      (!project.teamBackendId || !project.teamWorkspaceId)
  );
  const dueProjectKey = [...(personalProjects ?? [])]
    .map((project) =>
      [
        project.id,
        project.workspaceProjectId ?? "",
        project.teamBackendId ?? "",
        project.teamWorkspaceId ?? ""
      ].join(":")
    )
    .sort()
    .join("\u0000");
  useEffect(() => {
    let active = true;
    const base = {
      api: projectsApi ?? null,
      ownerId: ownerId ?? null,
      profileKey: profileKey ?? null,
      projectKey: dueProjectKey
    };
    const blank = {
      items: new Map<string, readonly WorkItem[]>(),
      sharedItems: new Map<string, readonly WorkspaceProjectWorkItem[]>()
    };
    setDueInventory({
      ...base,
      ...blank,
      loading: true,
      error: "",
      notice: ""
    });
    if (
      !projectsReady ||
      !personalProjects ||
      !projectsApi ||
      (privateDueProjects.length > 0 && !projectsApi.workItemList) ||
      (sharedDueProjects.length > 0 && !projectsApi.sharedRefresh)
    ) {
      setDueInventory({
        ...base,
        ...blank,
        loading: false,
        error:
          projectsReady && personalProjects?.length
            ? "Deadlines are unavailable."
            : "",
        notice: ""
      });
      return;
    }
    void (async () => {
      const items = new Map<string, readonly WorkItem[]>();
      const sharedItems = new Map<
        string,
        readonly WorkspaceProjectWorkItem[]
      >();
      const notices: string[] = [];
      try {
        for (let offset = 0; offset < privateDueProjects.length; offset += 8) {
          const batch = privateDueProjects.slice(offset, offset + 8);
          const results = await Promise.all(
            batch.map((project) => projectsApi.workItemList!(project.id))
          );
          if (!active) return;
          results.forEach((rows, index) => {
            if (rows.some((item) => item.projectId !== batch[index]!.id))
              throw new Error("Work Item Project identity mismatch.");
            items.set(batch[index]!.id, rows);
          });
        }
        for (let offset = 0; offset < sharedDueProjects.length; offset += 8) {
          const batch = sharedDueProjects.slice(offset, offset + 8);
          const results = await Promise.allSettled(
            batch.map((project) =>
              projectsApi.sharedRefresh!(
                project.workspaceProjectId!,
                project.teamBackendId!
              )
            )
          );
          if (!active) return;
          results.forEach((result, index) => {
            const project = batch[index]!;
            if (result.status === "rejected") {
              notices.push(
                `Shared deadlines for ${project.name} could not be loaded.`
              );
              return;
            }
            const state = result.value;
            if (
              !state.project ||
              state.project.id !== project.workspaceProjectId ||
              state.project.workspaceId !== project.teamWorkspaceId
            ) {
              notices.push(
                `Shared deadlines for ${project.name} could not be verified.`
              );
              return;
            }
            sharedItems.set(project.id, state.workItems);
            if (state.readOnly && state.notice)
              notices.push(`${project.name}: ${state.notice}`);
          });
        }
        if (incompleteSharedLink)
          notices.push("Some shared Project deadlines are unavailable.");
        if (active)
          setDueInventory({
            ...base,
            items,
            sharedItems,
            loading: false,
            error: "",
            notice: notices.join(" ")
          });
      } catch {
        if (active)
          setDueInventory({
            ...base,
            ...blank,
            loading: false,
            error: "Deadlines could not be loaded. Try refreshing.",
            notice: ""
          });
      }
    })();
    return () => {
      active = false;
    };
  }, [
    projectsApi,
    projectsReady,
    dueProjectKey,
    ownerId,
    profileKey,
    refreshKey
  ]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible")
        setRefreshKey((value) => value + 1);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const nextExpiry = approvals
      .filter(
        ({ state }) =>
          state === "awaiting_approval" || state === "awaiting_review"
      )
      .map(({ expiresAt }) => Date.parse(expiresAt))
      .filter((value) => Number.isFinite(value) && value > Date.now())
      .sort((a, b) => a - b)[0];
    if (nextExpiry === undefined) return;
    const timer = window.setTimeout(
      () => setApprovalClock((value) => value + 1),
      Math.max(1, nextExpiry - Date.now() + 1)
    );
    return () => window.clearTimeout(timer);
  }, [approvals, approvalClock]);
  useEffect(() => {
    const list = api?.list;
    if (!api || !list) {
      setExecutions([]);
      setRuntimeItems(new Map());
      setRuntimeGenerations(new Map());
      setComplete(false);
      setInventoryTruncated(false);
      setSourceApi(null);
      setSourceOwnerId(null);
      setSourceProfileKey(null);
      setLoading(false);
      setRuntimeError("Managed Conversations are unavailable.");
      return;
    }
    let active = true;
    setLoading(true);
    setRuntimeError("");
    void (async () => {
      try {
        const listed = await list();
        if (!active) return;
        const inspectable = nowInspectableExecutions(listed.executions);
        const ids = inspectable.executions.map(
          ({ executionId }) => executionId
        );
        const next = new Map<
          string,
          readonly ManagedConversationRuntimeItem[]
        >();
        const nextGenerations = new Map<string, number>();
        let failed = false;
        for (let offset = 0; offset < ids.length; offset += 8) {
          if (!active) return;
          const batch = ids.slice(offset, offset + 8);
          const results = await Promise.allSettled(
            batch.map((id) => api.runtime(id))
          );
          if (!active) return;
          results.forEach((result, index) => {
            if (result.status === "fulfilled") {
              next.set(batch[index]!, result.value.items);
              nextGenerations.set(
                batch[index]!,
                result.value.executionGeneration
              );
            } else failed = true;
          });
        }
        if (!active) return;
        setExecutions(inspectable.executions);
        setSourceApi(api);
        setSourceOwnerId(ownerId ?? null);
        setSourceProfileKey(profileKey ?? null);
        setComplete(listed.complete && !failed && !inspectable.unknownState);
        setInventoryTruncated(!listed.complete);
        setRuntimeItems(next);
        setRuntimeGenerations(nextGenerations);
        setRuntimeError(
          failed
            ? "Some Conversation requests could not be loaded."
            : inspectable.unknownState
              ? "Some Conversation states could not be inspected."
              : ""
        );
      } catch {
        if (!active) return;
        setExecutions([]);
        setSourceApi(api);
        setSourceOwnerId(ownerId ?? null);
        setSourceProfileKey(profileKey ?? null);
        setComplete(false);
        setInventoryTruncated(false);
        setRuntimeItems(new Map());
        setRuntimeGenerations(new Map());
        setRuntimeError("Needs you could not load. Try refreshing.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [api, ownerId, profileKey, draftIdentityKey, refreshKey]);
  const sourceCurrent =
    sourceApi === api &&
    sourceOwnerId === (ownerId ?? null) &&
    sourceProfileKey === (profileKey ?? null);
  useEffect(() => {
    setMemoryPanelRow(null);
    onMemoryPanelOpenChange?.(false);
  }, [ownerId, profileKey, api]);
  const visibleRuntime = sourceCurrent
    ? runtimeItems
    : new Map<string, readonly ManagedConversationRuntimeItem[]>();
  const visibleGenerations = sourceCurrent
    ? runtimeGenerations
    : new Map<string, number>();
  const visibleExecutions = sourceCurrent ? executions : [];
  const scopedDrafts = new Map(
    [...(drafts ?? new Map())].filter(([id]) =>
      visibleExecutions.some(({ executionId }) => executionId === id)
    )
  );
  const needs = useMemo(
    () =>
      [
        ...nowNeedsFromRuntime(scopedDrafts, visibleRuntime),
        ...nowNeedsFromExecutionInventory(
          visibleExecutions,
          visibleRuntime,
          scopedDrafts,
          projects
        ),
        ...nowNeedsFromApprovals(approvals)
      ]
        .filter(
          (need) =>
            !need.projectId ||
            !need.sessionId ||
            !blockedConversationSessions?.has(
              `${need.projectId}\u0000${need.sessionId}`
            )
        )
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    [
      scopedDrafts,
      visibleRuntime,
      visibleExecutions,
      approvals,
      projects,
      blockedConversationSessions,
      approvalClock
    ]
  );
  const projectRows = useMemo<
    readonly (DesktopProject | ProjectNavigationRow)[]
  >(
    () =>
      personalProjects
        ? projectNavigation(personalProjects, projects).projects
        : nowProjects(projects),
    [personalProjects, projects]
  );
  const dueCurrent =
    dueInventory?.api === (projectsApi ?? null) &&
    dueInventory.ownerId === (ownerId ?? null) &&
    dueInventory.profileKey === (profileKey ?? null) &&
    dueInventory.projectKey === dueProjectKey;
  const dueLoading = !projectsReady || !dueCurrent || dueInventory.loading;
  const dueError = dueCurrent ? dueInventory.error : "";
  const dueNotice = dueCurrent ? dueInventory.notice : "";
  const privateDues =
    dueCurrent && !dueInventory.loading && !dueInventory.error
      ? nowDeadlineItems(
          privateDueProjects,
          dueInventory.items,
          viewerTimeZone(),
          new Date()
        )
      : { soon: [], week: [] };
  const sharedDues =
    dueCurrent && !dueInventory.loading && !dueInventory.error
      ? nowSharedDeadlineItems(
          sharedDueProjects,
          dueInventory.sharedItems,
          viewerTimeZone(),
          new Date()
        )
      : { soon: [], week: [] };
  const dueOrder = (
    left: { daysUntil: number; item: { updatedAt: string; id: string } },
    right: { daysUntil: number; item: { updatedAt: string; id: string } }
  ) =>
    left.daysUntil - right.daysUntil ||
    left.item.updatedAt.localeCompare(right.item.updatedAt) ||
    left.item.id.localeCompare(right.item.id);
  const soonDues = [...privateDues.soon, ...sharedDues.soon].sort(dueOrder);
  const weekDues = [...privateDues.week, ...sharedDues.week].sort(dueOrder);
  const needRows = [
    ...soonDues.map((due) => ({ type: "due" as const, due })),
    ...needs.map((need) => ({ type: "need" as const, need }))
  ];
  const jobNeeds = scheduledJobs
    ? actionableScheduledRuns(scheduledJobs.jobs, scheduledJobs.runs)
    : [];
  const pendingJoinCount = joinRecovery?.authorityKey === authorityKey ? 1 : 0;
  const setFold = (section: "needsFolded" | "projectsFolded") => {
    const next = { ...preferences, [section]: !preferences[section] };
    setPreferences(next);
    writeNowPreferences(next);
  };
  return (
    <div className="hq-now" aria-label="Now">
      <div className="hq-now__content">
        <section
          className="hq-now__section"
          aria-label="Needs you"
          data-has-items={
            needRows.length +
              jobNeeds.length +
              invitations.length +
              pendingJoinCount >
            0
          }
        >
          <header className="hq-now__section-header">
            <button
              type="button"
              aria-expanded={!preferences.needsFolded}
              onClick={() => setFold("needsFolded")}
            >
              <ChevronDown aria-hidden="true" />
              <i className="hq-now__section-dot" aria-hidden="true" />
              Needs you{" "}
              <span>
                {needRows.length +
                  jobNeeds.length +
                  invitations.length +
                  pendingJoinCount}
              </span>
            </button>
            <button
              type="button"
              className="hq-now__refresh"
              aria-label="Refresh Needs you"
              disabled={loading}
              onClick={() => setRefreshKey((value) => value + 1)}
            >
              <RotateCw aria-hidden="true" />
            </button>
          </header>
          {!preferences.needsFolded ? (
            <div className="hq-now__rows">
              {runtimeError && (sourceCurrent || !api?.list) ? (
                <p role="alert">{runtimeError}</p>
              ) : null}
              {invitationError ? <p role="alert">{invitationError}</p> : null}
              {joinRecovery?.authorityKey === authorityKey ? (
                <p role="status">
                  {joinRecovery.name} was accepted but its Personal Project
                  setup needs to finish.{" "}
                  <button
                    type="button"
                    disabled={invitationBusy !== null}
                    onClick={() => void retryJoinedProject()}
                  >
                    Retry setup
                  </button>
                </p>
              ) : null}
              {invitations.map((invite) => (
                <article
                  key={invite.id}
                  className="hq-now__invitation"
                  aria-label={`Invitation to ${invite.team.name}`}
                >
                  <div className="hq-now__invitation-copy">
                    <strong>
                      {invite.inviter.displayName || "A teammate"} invited you
                      to {invite.project?.name ?? invite.workspace.name}
                    </strong>
                    <small>
                      {invite.team.name} ·{" "}
                      {invite.project ? "Project" : "Workspace"} ·{" "}
                      {invite.effectiveRole} · {invite.workspaceAccess} access
                    </small>
                    {invite.inviter.agentDisplayName ? (
                      <small>
                        Inviter’s Agent: {invite.inviter.agentDisplayName}
                      </small>
                    ) : null}
                    <small>
                      Expires{" "}
                      {new Date(invite.expiresAt).toLocaleDateString(
                        undefined,
                        { month: "short", day: "numeric", year: "numeric" }
                      )}
                    </small>
                    {invite.project ? (
                      <p>
                        Your chats in {invite.project.name} will be shared as
                        summaries with {invite.team.name}.
                      </p>
                    ) : null}
                  </div>
                  <div className="hq-now__invitation-actions">
                    <button
                      type="button"
                      disabled={invitationBusy === invite.id}
                      onClick={() => void decideInvitation(invite, "decline")}
                    >
                      Decline
                    </button>
                    <button
                      type="button"
                      disabled={invitationBusy === invite.id}
                      onClick={() => void decideInvitation(invite, "accept")}
                    >
                      Accept
                    </button>
                  </div>
                </article>
              ))}
              {dueError ? <p role="alert">{dueError}</p> : null}
              {dueNotice ? <p role="status">{dueNotice}</p> : null}
              {dueLoading && personalProjects?.length ? (
                <p role="status">Checking deadlines…</p>
              ) : null}
              {loading || !sourceCurrent ? (
                <p role="status">Checking Conversations…</p>
              ) : null}
              {scheduledJobs?.loading ? (
                <p role="status">Checking Scheduled Jobs…</p>
              ) : null}
              {scheduledJobs?.error ? (
                <p role="alert">{scheduledJobs.error}</p>
              ) : null}
              {scheduledJobs?.truncated ? (
                <p role="status">
                  Scheduled Job history is incomplete. Refresh to check for more
                  runs.
                </p>
              ) : null}
              {!loading && sourceCurrent && inventoryTruncated ? (
                <p role="status">
                  Showing recent Conversations. Older activity may be missing.
                </p>
              ) : null}
              {!loading &&
              !dueLoading &&
              !dueError &&
              sourceCurrent &&
              complete &&
              (!scheduledJobs ||
                (!scheduledJobs.loading &&
                  !scheduledJobs.error &&
                  !scheduledJobs.truncated)) &&
              needRows.length +
                jobNeeds.length +
                invitations.length +
                pendingJoinCount ===
                0 ? (
                <p className="hq-now__empty">Nothing needs you right now.</p>
              ) : null}
              {nowVisible(needRows, moreNeeds).map((entry) =>
                entry.type === "due" ? (
                  <button
                    type="button"
                    key={`due:${entry.due.item.id}`}
                    className="hq-now__row hq-now__due-row"
                    onClick={() =>
                      onSelectDueItem
                        ? onSelectDueItem(
                            entry.due.project.id,
                            entry.due.item.id
                          )
                        : onSelectProject(entry.due.project.id)
                    }
                  >
                    <span className="hq-now__due-icon">
                      <CalendarDays aria-hidden="true" />
                    </span>
                    <span className="hq-now__row-copy">
                      <strong>{entry.due.item.title}</strong>
                      <small>
                        <span
                          className={`hq-now__due-chip hq-now__due-chip--${dueChip(entry.due.item.dueOn, viewerTimeZone(), new Date())?.[0] ?? "grey"}`}
                        >
                          {
                            dueChip(
                              entry.due.item.dueOn,
                              viewerTimeZone(),
                              new Date()
                            )?.[1]
                          }
                        </span>
                        {" · "}
                        {entry.due.project.name}
                      </small>
                    </span>
                    <span aria-hidden="true">›</span>
                  </button>
                ) : (
                  (() => {
                    const item = entry.need;
                    return projects.some(({ id }) => id === item.projectId) &&
                      item.executionId &&
                      item.projectId &&
                      item.sessionId &&
                      item.threadId ? (
                      <div key={item.id} className="hq-now__memory-row">
                        <button
                          type="button"
                          className="hq-now__row"
                          onClick={() => onSelectConversation(item)}
                        >
                          <span
                            className="hq-now__need-icon"
                            aria-hidden="true"
                          >
                            {item.kind === "question" ? (
                              <CircleHelp />
                            ) : (
                              <ShieldAlert />
                            )}
                          </span>
                          <span className="hq-now__row-copy">
                            <strong>{item.title}</strong>
                          </span>
                          <span aria-hidden="true">›</span>
                        </button>
                        <div className="hq-execution-memory__secondary">
                          {item.kind === "question" ? (
                            <ExecutionMemoryChips
                              api={api}
                              ownerId={ownerId}
                              profileKey={profileKey}
                              projectId={item.projectId}
                              executionId={item.executionId}
                              executionGeneration={visibleGenerations.get(
                                item.executionId
                              )}
                              providerTurnId={latestRuntimeTurn(
                                visibleRuntime.get(item.executionId) ?? [],
                                item.runtimeItemId,
                                visibleGenerations.get(item.executionId)
                              )}
                              variant="why"
                              panelHost={memoryPanelHost}
                              panelActive={memoryPanelRow === item.id}
                              onPanelOpen={() => {
                                setMemoryPanelRow(item.id);
                                onMemoryPanelOpenChange?.(true);
                              }}
                              onPanelClose={() => {
                                setMemoryPanelRow(null);
                                onMemoryPanelOpenChange?.(false);
                              }}
                              onOpenMessage={onOpenCitationMessage}
                            />
                          ) : null}
                          <small>{item.context}</small>
                        </div>
                      </div>
                    ) : (
                      <div key={item.id} className="hq-now__row">
                        <span className="hq-now__need-icon" aria-hidden="true">
                          {item.kind === "question" ? (
                            <CircleHelp />
                          ) : (
                            <ShieldAlert />
                          )}
                        </span>
                        <span className="hq-now__row-copy">
                          <strong>{item.title}</strong>
                          <small>{item.context}</small>
                        </span>
                      </div>
                    );
                  })()
                )
              )}
              {jobNeeds
                .slice(
                  0,
                  moreNeeds ? undefined : Math.max(0, 5 - needRows.length)
                )
                .map(({ job, run }) => (
                  <div className="hq-now__job-need" key={`job:${run.id}`}>
                    <span>
                      <strong>{job.title}</strong>
                      <small>
                        {" "}
                        ·{" "}
                        {run.status === "missed"
                          ? "Missed run"
                          : run.status === "failed"
                            ? "Failed run"
                            : "Interrupted run"}
                      </small>
                    </span>
                    {scheduledJobs?.uncertainIds.has(job.id) ? (
                      <small>
                        Recent runs:{" "}
                        {scheduledJobs.runs
                          .filter((entry) => entry.jobId === job.id)
                          .slice(0, 3)
                          .map(
                            (entry) =>
                              `${entry.status} ${new Date(entry.scheduledFor).toLocaleString()}`
                          )
                          .join(" · ") || "none found"}
                      </small>
                    ) : null}
                    {scheduledJobs?.uncertainIds.has(job.id) ? (
                      <button
                        type="button"
                        onClick={() =>
                          scheduledJobs.acknowledgeUncertain(job.id)
                        }
                      >
                        Reviewed run history
                      </button>
                    ) : null}
                    {run.status !== "missed" ? (
                      <button
                        type="button"
                        disabled={
                          job.paused || scheduledJobs?.pendingIds.has(job.id)
                        }
                        onClick={() => void scheduledJobs?.retry(job, run)}
                      >
                        Retry
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={
                        job.paused ||
                        scheduledJobs?.pendingIds.has(job.id) ||
                        scheduledJobs?.uncertainIds.has(job.id)
                      }
                      onClick={() => void scheduledJobs?.runNow(job)}
                    >
                      Run now
                    </button>
                    <button
                      type="button"
                      disabled={scheduledJobs?.pendingIds.has(job.id)}
                      onClick={() => void scheduledJobs?.skip(job, run)}
                    >
                      Skip
                    </button>
                  </div>
                ))}
              {needRows.length + jobNeeds.length > 5 ? (
                <button
                  type="button"
                  className="hq-now__more"
                  onClick={() => setMoreNeeds((value) => !value)}
                >
                  {moreNeeds
                    ? "Show less"
                    : `Show ${needRows.length + jobNeeds.length - 5} more`}
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
        <section className="hq-now__section" aria-label="Projects">
          <header className="hq-now__section-header">
            <button
              type="button"
              aria-expanded={!preferences.projectsFolded}
              onClick={() => setFold("projectsFolded")}
            >
              <ChevronDown aria-hidden="true" />
              <i className="hq-now__section-dot" aria-hidden="true" />
              Projects <span>{projectRows.length}</span>
            </button>
          </header>
          {!preferences.projectsFolded ? (
            <div className="hq-now__rows">
              {projectsError ? (
                <p role="alert">
                  Projects could not load. Retry from the sidebar.
                </p>
              ) : null}
              {projectsLoading && !projectRows.length ? (
                <p role="status">Loading Projects…</p>
              ) : null}
              {projectsReady && projectRows.length === 0 ? (
                <p className="hq-now__empty">No Projects yet.</p>
              ) : null}
              {nowVisible<DesktopProject | ProjectNavigationRow>(
                projectRows,
                moreProjects
              ).map((project) => {
                const status = !("threads" in project)
                  ? nowPersonalProjectStatus(project, needs)
                  : nowProjectStatus(project, needs);
                const pending =
                  status.pending +
                  soonDues.filter(
                    ({ project: dueProject }) => dueProject.id === project.id
                  ).length;
                return (
                  <button
                    key={project.id}
                    type="button"
                    className="hq-now__row"
                    onClick={() => onSelectProject(project.id)}
                  >
                    <span className="hq-now__project-icon">
                      <Folder aria-hidden="true" />
                    </span>
                    <span className="hq-now__row-copy">
                      <strong>{project.name}</strong>
                      <small>
                        {pending > 0 ? (
                          <>
                            <span className="hq-now__pending-count">
                              {pending} need you
                            </span>{" "}
                            ·{" "}
                          </>
                        ) : null}
                        {status.conversations}
                      </small>
                    </span>
                    <span
                      className="hq-now__sparkline"
                      aria-label="Activity preview unavailable"
                      title="Activity preview unavailable"
                    />
                  </button>
                );
              })}
              {projectRows.length > 5 ? (
                <button
                  type="button"
                  className="hq-now__more"
                  onClick={() => setMoreProjects((value) => !value)}
                >
                  {moreProjects
                    ? "Show less"
                    : `Show ${projectRows.length - 5} more`}
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
        {scheduledJobs && onOpenJob ? (
          <NowScheduledJobs
            inventory={scheduledJobs}
            onOpenJob={onOpenJob}
            agents={scheduledJobAgents}
          />
        ) : null}
        {weekDues.length ? (
          <section className="hq-now__due-week" aria-label="Due this week">
            <button
              type="button"
              className="hq-now__due-week-head"
              aria-expanded={duesOpen}
              onClick={() => setDuesOpen((value) => !value)}
            >
              <CalendarDays size={16} aria-hidden="true" />
              <span>
                Due this week:{" "}
                {weekDues
                  .slice(0, 2)
                  .map(({ item }) => item.title)
                  .join(" · ")}
                {weekDues.length > 2 ? ` · +${weekDues.length - 2}` : ""}
              </span>
              <ChevronDown size={15} aria-hidden="true" />
            </button>
            {duesOpen ? (
              <div className="hq-now__due-week-list">
                {nowVisible(weekDues, moreDues).map(({ item, project }) => (
                  <button
                    type="button"
                    key={item.id}
                    className="hq-now__due-week-row"
                    onClick={() =>
                      onSelectDueItem
                        ? onSelectDueItem(project.id, item.id)
                        : onSelectProject(project.id)
                    }
                  >
                    <CalendarDays size={14} aria-hidden="true" />
                    <b>{item.title}</b>
                    <small>
                      {project.name} ·{" "}
                      {dueChip(item.dueOn, viewerTimeZone(), new Date())?.[1]}
                    </small>
                  </button>
                ))}
                {weekDues.length > 5 ? (
                  <button
                    type="button"
                    className="hq-now__more"
                    onClick={() => setMoreDues((value) => !value)}
                  >
                    {moreDues
                      ? "Show less"
                      : `Show ${weekDues.length - 5} more`}
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}
