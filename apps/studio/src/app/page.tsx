"use client";

import { readHomeJson } from "@/lib/home-json";
import type { InitialChatSubmission } from "@/lib/use-initial-chat-submission";
import {
  privateAgentHandoffSelection,
  teamAgentRequestBindingFromRuntime,
  teamAgentFreshPlanningHref
} from "@/lib/team-agent-mentions-state";
import { newChatProjectId } from "@/lib/chat-project-selection";
import { managedRequest } from "@/lib/managed-agent-chat";
import type { TeamAgentRequestExecutionBinding } from "@/lib/team-agent-mentions-state";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DemoHome } from "@/components/studio/DemoHome";
import { PersonalHome } from "@/components/studio/PersonalHome";
import { LiveAgentChat } from "@/components/studio/LiveAgentChat";
import { StudioSidebar } from "@/components/studio/StudioSidebar";
import type { ChatComposerSelection } from "@/components/ChatComposer";
import { CreateProjectModal } from "@/components/CreateProjectModal";
import {
  chooseLocalProjectFolder,
  registerLocalProject,
  useLocalProjectCapabilities
} from "@/lib/local-projects";
import type { HomeExecution, HomeRecent } from "@/lib/studio-contract";
import { managedProviderSourceIdsByExecution } from "@/components/studio/LocalConversationBrowser.match";
import type { HomeItem } from "@koed/shared/home";
import { useHomeFeed } from "@/lib/use-home-feed";
import { homeProjects, type HomeProject } from "@/lib/studio-home";
import { HostedStudio } from "@/components/hosted/HostedStudio";
import { personalAgentsHttpAdapter } from "@/lib/personal-agents-client";
import { useVerifiedPersonalScope } from "@/components/studio/useVerifiedPersonalScope";
import { listPersonalConversations } from "@/lib/personal-conversations-client";
import { personalConversationForExecution } from "@/lib/personal-conversation-routing";
import type { PersonalAgentChatConversationSummary } from "@koed/shared/personal-agent-chat-contract";

const teamBindingContextMismatchMessage =
  "This conversation’s Team request context does not match its owner-authorized runtime binding.";

function LiveHome({
  onPlugins,
  onPullRequests,
  initialChatOpen,
  initialProjectRequest,
  executionId,
  personalConversationId: initialPersonalConversationId,
  requestedProjectId,
  requestedAgentId,
  requestedSettings,
  requestDraft,
  teamRequestId,
  teamRequestTeamId,
  teamRequestExpectedRequestVersion,
  teamRequestExpectedReviewVersion
}: {
  onPlugins: () => void;
  onPullRequests: () => void;
  initialChatOpen: boolean;
  initialProjectRequest: boolean;
  executionId?: string;
  personalConversationId?: string;
  requestedProjectId?: string;
  requestedAgentId?: string;
  requestedSettings?: Partial<ChatComposerSelection>;
  requestDraft?: string;
  teamRequestId?: string;
  teamRequestTeamId?: string;
  teamRequestExpectedRequestVersion?: number;
  teamRequestExpectedReviewVersion?: number;
}) {
  const [chatOpen, setChatOpen] = useState(initialChatOpen);
  const [collapsed, setCollapsed] = useState(false);
  const [chatKey, setChatKey] = useState(0);
  const [initialChatDraft, setInitialChatDraft] = useState(requestDraft ?? "");
  const [initialChatSelection, setInitialChatSelection] = useState<
    ChatComposerSelection | undefined
  >();
  const [initialSubmission, setInitialSubmission] = useState<
    InitialChatSubmission | undefined
  >();
  const startedHomeSubmissions = useRef(new Set<string>());
  const claimInitialSubmission = useCallback((id: string) => {
    if (startedHomeSubmissions.current.has(id)) return false;
    startedHomeSubmissions.current.add(id);
    return true;
  }, []);
  const [agentSelectionResult, setAgentSelectionResult] = useState<{
    id: string;
    state: "ready" | "error";
    error?: string;
  } | null>(null);
  const agentSelectionState = !requestedAgentId
    ? "ready"
    : agentSelectionResult?.id === requestedAgentId
      ? agentSelectionResult.state
      : "loading";
  const agentSelectionError =
    requestedAgentId && agentSelectionResult?.id === requestedAgentId
      ? (agentSelectionResult.error ?? null)
      : null;
  const requestedProvider = requestedSettings?.provider;
  const requestedModel = requestedSettings?.model;
  const requestedEffort = requestedSettings?.effort;
  const requestedPermissionMode = requestedSettings?.permissionMode;
  const requestedInstanceId = requestedSettings?.instanceId;
  const requestedHostedInstanceId = requestedSettings?.hostedInstanceId;
  const [resumeId, setResumeId] = useState(executionId);
  const [resumePersonalConversationId, setResumePersonalConversationId] =
    useState(initialPersonalConversationId);
  const [selectedExecutionId, setSelectedExecutionId] = useState(
    executionId ?? initialPersonalConversationId
  );
  const [teamBindingProbe, setTeamBindingProbe] = useState<{
    executionId: string;
    state: "loading" | "ready" | "error";
    binding:
      | TeamAgentRequestExecutionBinding
      | Omit<TeamAgentRequestExecutionBinding, "status">
      | null;
    error?: string;
  } | null>(null);
  const [acceptedTeamStartExecutionId, setAcceptedTeamStartExecutionId] =
    useState<string | null>(null);
  const acceptedTeamStartExecutionIdRef = useRef<string | null>(null);
  const teamBindingProbeLoadingExecution = useRef<string | null>(null);
  const [openingConversationError, setOpeningConversationError] = useState<{
    executionId: string;
    message: string;
  } | null>(null);
  const [openingConversationId, setOpeningConversationId] = useState<
    string | null
  >(null);
  const openingConversationSequence = useRef(0);
  const openingConversationController = useRef<AbortController | null>(null);
  const routeScopeKey = [
    executionId ?? "",
    initialPersonalConversationId ?? "",
    teamRequestId ?? "",
    teamRequestTeamId ?? "",
    requestedAgentId ?? ""
  ].join("\u0000");
  const routeScopeKeyRef = useRef(routeScopeKey);
  useEffect(() => {
    routeScopeKeyRef.current = routeScopeKey;
  }, [routeScopeKey]);
  const pendingOpenOnScopeCleanup = useRef(false);
  const previousRouteScopeKey = useRef(routeScopeKey);
  const invalidateOpeningConversation = useCallback(() => {
    openingConversationSequence.current += 1;
    openingConversationController.current?.abort();
    openingConversationController.current = null;
  }, []);
  useEffect(() => {
    if (previousRouteScopeKey.current !== routeScopeKey) {
      previousRouteScopeKey.current = routeScopeKey;
      if (pendingOpenOnScopeCleanup.current) {
        pendingOpenOnScopeCleanup.current = false;
        // Close the stale loading gate when navigation changes its owner scope.
        setOpeningConversationId(null);
      }
    }
    return () => {
      pendingOpenOnScopeCleanup.current =
        openingConversationController.current !== null;
      invalidateOpeningConversation();
    };
  }, [invalidateOpeningConversation, routeScopeKey]);
  useEffect(() => {
    // Route recovery can arrive without the first-send callback.
    if (executionId) {
      // This effect mirrors an external URL selection into sidebar state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedExecutionId(executionId);
      setResumeId(executionId);
    }
  }, [executionId]);
  useEffect(() => {
    // Durable root routes stay selected independently of the active child.
    if (initialPersonalConversationId) {
      // This effect mirrors an external URL selection into sidebar state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedExecutionId(initialPersonalConversationId);
      setResumePersonalConversationId(initialPersonalConversationId);
    }
  }, [initialPersonalConversationId]);
  const [projects, setProjects] = useState<HomeProject[]>([]);
  const [homeScopeKey, setHomeScopeKey] = useState<string | null>(null);
  const [managedConversations, setManagedConversations] = useState<
    HomeExecution[]
  >([]);
  const [personalConversationSummaries, setPersonalConversationSummaries] =
    useState<PersonalAgentChatConversationSummary[]>([]);
  const [
    personalConversationSummariesLoaded,
    setPersonalConversationSummariesLoaded
  ] = useState(false);
  const [managedProviderSources, setManagedProviderSources] = useState<
    Record<string, string[]>
  >({});
  const [registeredProjects, setRegisteredProjects] = useState<HomeProject[]>(
    []
  );
  const [registeredProjectsError, setRegisteredProjectsError] = useState<
    string | null
  >(null);
  const [loadingRegisteredProjects, setLoadingRegisteredProjects] =
    useState(false);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [pendingSidebarMove, setPendingSidebarMove] = useState<{
    executionId: string;
    destinationProjectId: string;
    requestId: number;
  } | null>(null);
  const sidebarMoveRequestSequence = useRef(0);
  const [homeRefreshRevision, setHomeRefreshRevision] = useState(0);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const { canCreateLocalProject, loading: projectCapabilitiesLoading } =
    useLocalProjectCapabilities();
  const router = useRouter();
  const homeFeed = useHomeFeed({
    transport: "studio",
    identityKey: "personal",
    autoRefresh: false
  });
  const personalScopeKey = useVerifiedPersonalScope(homeScopeKey);
  const allProjects = useMemo(() => {
    const byId = new Map(projects.map((project) => [project.id, project]));
    for (const project of registeredProjects) byId.set(project.id, project);
    return [...byId.values()];
  }, [projects, registeredProjects]);
  const projectIds = useMemo(
    () => new Set(allProjects.map((project) => project.id)),
    [allProjects]
  );
  const selectedProjectName = allProjects.find(
    (project) => project.id === selectedProject
  )?.name;
  const registeredProjectsSequence = useRef(0);
  const handleProjectMoveCompleted = useCallback(() => {
    setHomeRefreshRevision((revision) => revision + 1);
  }, []);

  useEffect(() => {
    if (!initialProjectRequest || projectCapabilitiesLoading) return;
    if (!canCreateLocalProject) router.replace("/");
  }, [
    canCreateLocalProject,
    initialProjectRequest,
    projectCapabilitiesLoading,
    router
  ]);

  useEffect(() => {
    if (!requestedAgentId) return;
    const controller = new AbortController();
    void personalAgentsHttpAdapter
      .get(requestedAgentId, controller.signal)
      .then((agent) => {
        if (controller.signal.aborted) return;
        if (agent.lifecycle !== "active") {
          throw new Error("Retired Agents cannot start a new Conversation.");
        }
        if (executionId) setResumeId(executionId);
        setInitialChatSelection({
          agentId: agent.id,
          expectedAgentVersion: agent.currentVersion,
          provider: null,
          model: "",
          effort: "",
          permissionMode: "full",
          ...(requestedProvider !== undefined
            ? { provider: requestedProvider }
            : {}),
          ...(requestedModel !== undefined ? { model: requestedModel } : {}),
          ...(requestedEffort !== undefined ? { effort: requestedEffort } : {}),
          ...(requestedPermissionMode !== undefined
            ? { permissionMode: requestedPermissionMode }
            : {}),
          ...(requestedInstanceId !== undefined
            ? { instanceId: requestedInstanceId }
            : {}),
          ...(requestedHostedInstanceId !== undefined
            ? { hostedInstanceId: requestedHostedInstanceId }
            : {})
        });
        if (acceptedTeamStartExecutionIdRef.current !== executionId)
          setChatKey((value) => value + 1);
        setAgentSelectionResult({ id: requestedAgentId, state: "ready" });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setInitialChatSelection(undefined);
        setAgentSelectionResult({
          id: requestedAgentId,
          state: "error",
          error:
            reason instanceof Error
              ? reason.message
              : "The selected Agent could not be loaded."
        });
      });
    return () => controller.abort();
  }, [
    requestedAgentId,
    requestedProvider,
    requestedModel,
    requestedEffort,
    requestedPermissionMode,
    requestedInstanceId,
    requestedHostedInstanceId,
    executionId
  ]);

  const loadRegisteredProjects = useCallback(async () => {
    registeredProjectsSequence.current += 1;
    const sequence = registeredProjectsSequence.current;
    setLoadingRegisteredProjects(true);
    setRegisteredProjectsError(null);
    try {
      const response = await fetch("/studio-api/projects", {
        headers: { accept: "application/json" },
        cache: "no-store"
      });
      if (!response.ok) throw new Error("project_catalog_unavailable");
      const payload = await response.json();
      if (
        !Array.isArray(payload?.projects) ||
        !payload.projects.every((item: unknown): item is HomeProject =>
          Boolean(
            item &&
            typeof item === "object" &&
            typeof (item as HomeProject).id === "string" &&
            typeof (item as HomeProject).name === "string"
          )
        )
      ) {
        throw new Error("invalid_project_catalog");
      }
      if (sequence === registeredProjectsSequence.current) {
        setRegisteredProjects(payload.projects);
      }
    } catch (reason) {
      if (sequence === registeredProjectsSequence.current) {
        setRegisteredProjectsError(
          reason instanceof TypeError
            ? "Koed Studio could not be reached. Check that the local Studio gateway is running, then retry."
            : "The local Project list is unavailable. Retry to check again."
        );
      }
    } finally {
      if (sequence === registeredProjectsSequence.current) {
        setLoadingRegisteredProjects(false);
      }
    }
  }, []);

  useEffect(() => {
    const refreshProjects = () => void loadRegisteredProjects();
    refreshProjects();
    window.addEventListener("koed:projects-changed", refreshProjects);
    return () => {
      registeredProjectsSequence.current += 1;
      window.removeEventListener("koed:projects-changed", refreshProjects);
    };
  }, [loadRegisteredProjects]);

  useEffect(() => {
    const updateTitles = () => setHomeRefreshRevision((value) => value + 1);
    window.addEventListener("koed:conversation-titles-changed", updateTitles);
    return () =>
      window.removeEventListener(
        "koed:conversation-titles-changed",
        updateTitles
      );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    listPersonalConversations(controller.signal)
      .then((summaries) => {
        if (!controller.signal.aborted) {
          setPersonalConversationSummaries(summaries);
          setPersonalConversationSummariesLoaded(true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPersonalConversationSummaries([]);
          setPersonalConversationSummariesLoaded(true);
        }
      });
    return () => controller.abort();
  }, [homeRefreshRevision]);

  const executionRoot = personalConversationForExecution(
    personalConversationSummaries,
    executionId
  );
  const currentTeamBindingProbe =
    teamBindingProbe?.executionId === executionId ? teamBindingProbe : null;
  const teamBindingContextMismatch = Boolean(
    currentTeamBindingProbe?.state === "ready" &&
    ((currentTeamBindingProbe.binding &&
      ((teamRequestId &&
        teamRequestId !== currentTeamBindingProbe.binding.requestId) ||
        (teamRequestTeamId &&
          teamRequestTeamId !== currentTeamBindingProbe.binding.teamId) ||
        (requestedAgentId &&
          requestedAgentId !== currentTeamBindingProbe.binding.agentId))) ||
      (!currentTeamBindingProbe.binding &&
        (teamRequestId || teamRequestTeamId)))
  );
  useEffect(() => {
    if (!executionId) return;
    if (teamBindingProbe?.executionId === executionId) {
      if (teamBindingProbe.state !== "ready") return;
      const binding = teamBindingProbe.binding;
      if (teamBindingContextMismatch) return;
      if (binding && !teamRequestId) {
        const query = new URLSearchParams({
          chat: "1",
          execution: executionId,
          agent: binding.agentId,
          teamRequest: binding.requestId,
          teamRequestTeam: binding.teamId
        });
        router.replace(`/?${query.toString()}`);
      }
      return;
    }
    if (teamBindingProbeLoadingExecution.current === executionId) return;
    const controller = new AbortController();
    teamBindingProbeLoadingExecution.current = executionId;
    void managedRequest(
      `/${encodeURIComponent(executionId)}/runtime`,
      undefined,
      controller.signal
    )
      .then((payload) => {
        if (controller.signal.aborted) return;
        teamBindingProbeLoadingExecution.current = null;
        const binding = teamAgentRequestBindingFromRuntime(payload);
        if (binding === undefined)
          throw new Error(
            "The owner-authorized Team request binding is unavailable."
          );
        if (
          (binding &&
            ((teamRequestId && teamRequestId !== binding.requestId) ||
              (teamRequestTeamId && teamRequestTeamId !== binding.teamId) ||
              (requestedAgentId && requestedAgentId !== binding.agentId))) ||
          (!binding && (teamRequestId || teamRequestTeamId))
        )
          throw new Error(teamBindingContextMismatchMessage);
        setTeamBindingProbe({ executionId, state: "ready", binding });
        if (binding && !teamRequestId) {
          const query = new URLSearchParams({
            chat: "1",
            execution: executionId,
            agent: binding.agentId,
            teamRequest: binding.requestId,
            teamRequestTeam: binding.teamId
          });
          router.replace(`/?${query.toString()}`);
        }
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        teamBindingProbeLoadingExecution.current = null;
        setTeamBindingProbe({
          executionId,
          state: "error",
          binding: null,
          error:
            failure instanceof Error
              ? failure.message
              : "The conversation owner scope could not be checked."
        });
      });
    return () => {
      controller.abort();
      if (teamBindingProbeLoadingExecution.current === executionId)
        teamBindingProbeLoadingExecution.current = null;
    };
  }, [
    executionId,
    requestedAgentId,
    router,
    teamBindingContextMismatch,
    teamBindingProbe,
    teamRequestId,
    teamRequestTeamId
  ]);
  const resolvingExecutionRoot = Boolean(
    executionId &&
    !initialPersonalConversationId &&
    (!currentTeamBindingProbe ||
      currentTeamBindingProbe.state === "loading" ||
      (currentTeamBindingProbe.state === "ready" &&
        ((currentTeamBindingProbe.binding && !teamRequestId) ||
          (!currentTeamBindingProbe.binding &&
            !personalConversationSummariesLoaded))))
  );
  useEffect(() => {
    if (
      !executionId ||
      !executionRoot ||
      teamRequestId ||
      currentTeamBindingProbe?.state !== "ready" ||
      currentTeamBindingProbe.binding
    )
      return;
    // Resolve legacy child/source links to the durable root URL and selection.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResumeId(undefined);
    setResumePersonalConversationId(executionRoot.conversationId);
    setSelectedExecutionId(executionRoot.conversationId);
    setSelectedProject(executionRoot.projectId);
    router.replace(
      `/?chat=1&conversation=${encodeURIComponent(executionRoot.conversationId)}`
    );
  }, [
    currentTeamBindingProbe,
    executionId,
    executionRoot,
    router,
    teamRequestId
  ]);
  useEffect(() => {
    if (!openingConversationId || openingConversationError) return;
    const root = personalConversationForExecution(
      personalConversationSummaries,
      openingConversationId
    );
    const routeMatchesTeamExecution = Boolean(
      executionId === openingConversationId &&
      currentTeamBindingProbe?.state === "ready" &&
      currentTeamBindingProbe.binding &&
      teamRequestId === currentTeamBindingProbe.binding.requestId &&
      teamRequestTeamId === currentTeamBindingProbe.binding.teamId
    );
    const routeMatchesManagedExecution = Boolean(
      executionId === openingConversationId &&
      currentTeamBindingProbe?.state === "ready" &&
      currentTeamBindingProbe.binding === null &&
      !teamRequestId
    );
    const routeMatchesPersonalRoot = Boolean(
      initialPersonalConversationId &&
      (openingConversationId === initialPersonalConversationId ||
        root?.conversationId === initialPersonalConversationId)
    );
    if (
      routeMatchesTeamExecution ||
      routeMatchesManagedExecution ||
      routeMatchesPersonalRoot
    ) {
      // Clear the loading gate once the route reflects this explicit open.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpeningConversationId(null);
    }
  }, [
    currentTeamBindingProbe,
    executionId,
    initialPersonalConversationId,
    openingConversationError,
    openingConversationId,
    personalConversationSummaries,
    teamRequestId,
    teamRequestTeamId
  ]);

  useEffect(() => {
    const controller = new AbortController();
    // Clear protected sidebar data before verifying a replacement scope.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHomeScopeKey(null);
    fetch("/studio-api/home?mode=metadata", {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Home unavailable");
        return readHomeJson(response);
      })
      .then((payload) => {
        if (!payload || typeof payload !== "object") return;
        const snapshot = payload as {
          state?: unknown;
          scopeKey?: unknown;
          executions?: unknown;
          recents?: unknown;
        };
        if (
          !["ready", "partial"].includes(String(snapshot.state)) ||
          typeof snapshot.scopeKey !== "string" ||
          !Array.isArray(snapshot.executions) ||
          !Array.isArray(snapshot.recents)
        ) {
          setHomeScopeKey(null);
          setProjects([]);
          setManagedConversations([]);
          setManagedProviderSources({});
          setSelectedProject(null);
          return;
        }
        setHomeScopeKey(snapshot.scopeKey);

        const executions = snapshot.executions.filter(
          (item): item is HomeExecution =>
            Boolean(
              item &&
              typeof item === "object" &&
              typeof (item as HomeExecution).id === "string" &&
              ((item as HomeExecution).projectId === null ||
                typeof (item as HomeExecution).projectId === "string")
            )
        );
        const recents = snapshot.recents.filter((item): item is HomeRecent =>
          Boolean(
            item &&
            typeof item === "object" &&
            typeof (item as HomeRecent).id === "string" &&
            ((item as HomeRecent).projectId === null ||
              typeof (item as HomeRecent).projectId === "string") &&
            typeof (item as HomeRecent).projectName === "string"
          )
        );
        const hiddenExecutionIds = new Set(
          personalConversationSummaries.flatMap((conversation) => [
            ...conversation.sourceExecutionIds,
            ...conversation.childExecutionIds
          ])
        );
        const hiddenCapturedIds = new Set(
          personalConversationSummaries.flatMap(
            (conversation) => conversation.capturedSessionIds
          )
        );
        const visibleExecutions = executions.filter(
          (item) => !hiddenExecutionIds.has(item.id)
        );
        const visibleRecents = recents.filter(
          (item) =>
            !hiddenCapturedIds.has(item.id) &&
            !hiddenCapturedIds.has(item.sessionId)
        );
        setManagedConversations((current) => [
          ...visibleExecutions.map((item) => {
            const previous = current.find(
              (candidate) => candidate.id === item.id
            );
            return item.title === "Untitled conversation" && previous
              ? { ...item, title: previous.title }
              : item;
          }),
          ...personalConversationSummaries.map((conversation) => {
            const previous = current.find(
              (candidate) =>
                candidate.personalConversationId === conversation.conversationId
            );
            const state = [
              "queued",
              "running",
              "blocked",
              "uncertain"
            ].includes(conversation.status)
              ? "running"
              : conversation.status === "failed"
                ? "failed"
                : "stopped";
            return {
              id: conversation.conversationId,
              personalConversationId: conversation.conversationId,
              sourceExecutionIds: conversation.sourceExecutionIds,
              childExecutionIds: conversation.childExecutionIds,
              capturedSessionIds: conversation.capturedSessionIds,
              activeAgentId: conversation.activeAgentId,
              latestAgentName: conversation.latestAgentName,
              sessionId: null,
              projectId: conversation.projectId,
              title:
                conversation.title ??
                previous?.title ??
                (conversation.latestAgentName
                  ? `Chat with ${conversation.latestAgentName}`
                  : "New chat"),
              provider: conversation.activeProvider ?? "personal-conversation",
              state,
              updatedAt: conversation.updatedAt,
              error: null,
              activity:
                conversation.status === "uncertain"
                  ? "uncertain"
                  : conversation.status === "blocked"
                    ? "pending"
                    : state === "running"
                      ? "running"
                      : "idle"
            } satisfies HomeExecution;
          })
        ]);
        setManagedProviderSources(
          managedProviderSourceIdsByExecution({
            recents: visibleRecents,
            executions: visibleExecutions
          })
        );
        const verifiedProjects = homeProjects(
          visibleRecents,
          [
            ...visibleExecutions,
            ...personalConversationSummaries.map((conversation) => ({
              id: conversation.conversationId,
              sessionId: null,
              projectId: conversation.projectId,
              title: conversation.title ?? "New chat",
              provider: conversation.activeProvider ?? "personal-conversation",
              state: conversation.status,
              updatedAt: conversation.updatedAt,
              error: null
            }))
          ],
          registeredProjects
        );
        setProjects(verifiedProjects);

        const rootForRoute = personalConversationForExecution(
          personalConversationSummaries,
          executionId
        );
        const candidate = rootForRoute
          ? rootForRoute.projectId
          : executionId
            ? (executions.find((item) => item.id === executionId)?.projectId ??
              null)
            : initialPersonalConversationId
              ? (personalConversationSummaries.find(
                  (item) =>
                    item.conversationId === initialPersonalConversationId
                )?.projectId ?? null)
              : (requestedProjectId ?? null);
        setSelectedProject(
          candidate &&
            (verifiedProjects.some((project) => project.id === candidate) ||
              registeredProjects.some((project) => project.id === candidate))
            ? candidate
            : null
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setHomeScopeKey(null);
          setProjects([]);
          setManagedConversations([]);
          setManagedProviderSources({});
          setSelectedProject(null);
        }
      });
    return () => controller.abort();
  }, [
    executionId,
    initialPersonalConversationId,
    homeRefreshRevision,
    personalConversationSummaries,
    registeredProjects,
    requestedProjectId
  ]);

  const newChat = (
    prompt = "",
    projectId?: string | null,
    selection?: ChatComposerSelection
  ) => {
    invalidateOpeningConversation();
    setOpeningConversationId(null);
    setOpeningConversationError(null);
    setResumeId(undefined);
    setResumePersonalConversationId(undefined);
    setSelectedExecutionId(undefined);
    setInitialChatDraft(prompt);
    setInitialChatSelection(selection);
    setInitialSubmission(
      prompt.trim() && selection
        ? { id: crypto.randomUUID(), text: prompt.trim(), selection }
        : undefined
    );
    setChatKey((value) => value + 1);
    setChatOpen(true);
    const nextProject = newChatProjectId(
      projectId,
      selectedProject,
      projectIds
    );
    setSelectedProject(nextProject);
    const project = nextProject
      ? `&project=${encodeURIComponent(nextProject)}`
      : "";
    router.replace(`/?chat=1${project}`);
  };
  const startFreshTeamPlanning = (input: {
    selection: ChatComposerSelection;
    projectId: string | null;
    requestVersion: number;
    reviewVersion: number;
  }) => {
    if (!teamRequestId || !teamRequestTeamId || !input.selection.agentId)
      return;
    const href = teamAgentFreshPlanningHref({
      agentId: input.selection.agentId,
      projectId: input.projectId,
      teamId: teamRequestTeamId,
      requestId: teamRequestId,
      requestVersion: input.requestVersion,
      reviewVersion: input.reviewVersion,
      selection: input.selection
    });
    if (!href) return;
    invalidateOpeningConversation();
    setOpeningConversationId(null);
    setOpeningConversationError(null);
    setResumeId(undefined);
    setResumePersonalConversationId(undefined);
    setSelectedExecutionId(undefined);
    setInitialChatDraft("");
    setInitialChatSelection(input.selection);
    setInitialSubmission(undefined);
    setChatKey((value) => value + 1);
    setChatOpen(true);
    setSelectedProject(input.projectId);
    router.replace(href);
  };
  const resumeChat = (id: string) => {
    const knownPersonalRootExecution = managedConversations.find(
      (item) => item.personalConversationId === id
    );
    const knownPersonalRootSummary = personalConversationSummaries.find(
      (conversation) => conversation.conversationId === id
    );
    const knownPersonalRootId =
      knownPersonalRootExecution?.personalConversationId ??
      knownPersonalRootSummary?.conversationId;
    invalidateOpeningConversation();
    const requestSequence = openingConversationSequence.current;
    const routeScopeAtStart = routeScopeKeyRef.current;
    setOpeningConversationError(null);
    setOpeningConversationId(id);
    setChatOpen(true);
    setSelectedExecutionId(id);
    setInitialChatDraft("");
    setInitialChatSelection(undefined);
    setInitialSubmission(undefined);
    setChatKey((value) => value + 1);
    if (knownPersonalRootId) {
      setTeamBindingProbe(null);
      setResumeId(undefined);
      setResumePersonalConversationId(knownPersonalRootId);
      setSelectedExecutionId(knownPersonalRootId);
      setSelectedProject(
        knownPersonalRootSummary?.projectId ??
          knownPersonalRootExecution?.projectId ??
          null
      );
      router.replace(
        `/?chat=1&conversation=${encodeURIComponent(knownPersonalRootId)}`
      );
      return;
    }
    const controller = new AbortController();
    openingConversationController.current = controller;
    void managedRequest(
      `/${encodeURIComponent(id)}/runtime`,
      undefined,
      controller.signal
    )
      .then((payload) => {
        if (
          requestSequence !== openingConversationSequence.current ||
          routeScopeKeyRef.current !== routeScopeAtStart
        )
          return;
        openingConversationController.current = null;
        const binding = teamAgentRequestBindingFromRuntime(payload);
        if (binding === undefined)
          throw new Error(
            "The owner-authorized Team request binding is unavailable."
          );
        setTeamBindingProbe({ executionId: id, state: "ready", binding });
        if (binding) {
          setResumeId(id);
          setResumePersonalConversationId(undefined);
          setSelectedProject(null);
          const query = new URLSearchParams({
            chat: "1",
            execution: id,
            agent: binding.agentId,
            teamRequest: binding.requestId,
            teamRequestTeam: binding.teamId
          });
          router.replace(`/?${query.toString()}`);
          return;
        }
        const rootId =
          managedConversations.find(
            (item) => item.personalConversationId === id
          )?.personalConversationId ??
          personalConversationForExecution(personalConversationSummaries, id)
            ?.conversationId;
        setResumeId(rootId ? undefined : id);
        setResumePersonalConversationId(rootId);
        setSelectedExecutionId(rootId ?? id);
        setSelectedProject(null);
        router.replace(
          rootId
            ? `/?chat=1&conversation=${encodeURIComponent(rootId)}`
            : `/?chat=1&execution=${encodeURIComponent(id)}`
        );
      })
      .catch((failure: unknown) => {
        if (
          requestSequence !== openingConversationSequence.current ||
          routeScopeKeyRef.current !== routeScopeAtStart
        )
          return;
        openingConversationController.current = null;
        setOpeningConversationError({
          executionId: id,
          message:
            failure instanceof Error
              ? failure.message
              : "The conversation owner scope could not be checked."
        });
        setTeamBindingProbe({
          executionId: id,
          state: "error",
          binding: null,
          error:
            failure instanceof Error
              ? failure.message
              : "The conversation owner scope could not be checked."
        });
      });
  };
  const openHomeItem = (item: HomeItem) => {
    if (item.destination.kind === "execution")
      resumeChat(item.destination.executionId);
    else
      router.push(
        `/pull-requests?review=${encodeURIComponent(item.destination.reviewId)}`
      );
  };
  const moveManagedExecutionToProject = (
    executionId: string,
    destinationProjectId: string
  ) => {
    if (
      !/^lp_[0-9a-f]{32}$/iu.test(destinationProjectId) ||
      managedConversations.some(
        (conversation) => conversation.personalConversationId === executionId
      )
    )
      return;
    setPendingSidebarMove({
      executionId,
      destinationProjectId,
      requestId: ++sidebarMoveRequestSequence.current
    });
    resumeChat(executionId);
  };
  const openProjectModal = () => {
    if (canCreateLocalProject) setProjectModalOpen(true);
  };
  const chooseChatFolder = async (): Promise<HomeProject | null> => {
    if (!canCreateLocalProject) return null;
    const folder = await chooseLocalProjectFolder();
    if (!folder) return null;
    const project = await registerLocalProject({
      selectionId: folder.selectionId
    });
    setRegisteredProjects((current) => [
      { id: project.id, name: project.name },
      ...current.filter((item) => item.id !== project.id)
    ]);
    window.dispatchEvent(new Event("koed:projects-changed"));
    return project;
  };
  const projectModal =
    (projectModalOpen ||
      (initialProjectRequest &&
        !projectCapabilitiesLoading &&
        canCreateLocalProject)) &&
    canCreateLocalProject ? (
      <CreateProjectModal
        teams={[]}
        liveMode
        onClose={() => {
          setProjectModalOpen(false);
          if (initialProjectRequest) router.replace("/");
        }}
        onChooseFolder={chooseLocalProjectFolder}
        onCreate={async (input) => {
          if (!input.selectionId)
            throw new Error("Choose a Project folder first.");
          const project = await registerLocalProject({
            name: input.name,
            selectionId: input.selectionId
          });
          setRegisteredProjects((current) => [
            { id: project.id, name: project.name },
            ...current.filter((item) => item.id !== project.id)
          ]);
          window.dispatchEvent(new Event("koed:projects-changed"));
          setProjectModalOpen(false);
          if (initialProjectRequest) router.replace("/");
        }}
      />
    ) : null;
  if (!chatOpen) {
    return (
      <>
        <PersonalHome
          registeredProjects={registeredProjects.filter((project) =>
            /^lp_[0-9a-f]{32}$/iu.test(project.id)
          )}
          onChooseChatFolder={chooseChatFolder}
          onNewChat={() => newChat()}
          onNewProject={openProjectModal}
          canCreateLocalProject={canCreateLocalProject}
          onStartChat={newChat}
          onResumeChat={resumeChat}
          onMoveManagedExecution={moveManagedExecutionToProject}
          onPlugins={onPlugins}
          onPullRequests={onPullRequests}
          homeFeed={homeFeed}
          onOpenHomeItem={openHomeItem}
          personalConversationSummaries={personalConversationSummaries}
        />
        {projectModal}
      </>
    );
  }
  return (
    <>
      <div className="flex h-full min-h-0 w-full">
        <StudioSidebar
          projects={allProjects}
          personalScopeKey={personalScopeKey}
          managedConversations={managedConversations}
          managedProviderSourceIds={managedProviderSources}
          registeredProjectIds={registeredProjects
            .map((project) => project.id)
            .filter((id) => /^lp_[0-9a-f]{32}$/iu.test(id))}
          onChatSelect={resumeChat}
          showLocalCatalog
          onSelectManagedExecution={resumeChat}
          managedSourceIds={Object.values(managedProviderSources).flat()}
          onMoveManagedExecution={moveManagedExecutionToProject}
          collapsed={collapsed}
          selectedProject={selectedProject}
          onProjectSelect={(projectId) => {
            if (resumeId || executionId || resumePersonalConversationId) return;
            const nextProject = projectIds.has(projectId) ? projectId : null;
            setSelectedProject(nextProject);
            const query = nextProject
              ? `&project=${encodeURIComponent(nextProject)}`
              : "";
            router.replace(`/?chat=1${query}`);
          }}
          onToggle={() => setCollapsed((value) => !value)}
          onHome={() => {
            invalidateOpeningConversation();
            setOpeningConversationId(null);
            setOpeningConversationError(null);
            setChatOpen(false);
            router.replace("/");
          }}
          onNewChat={() => newChat()}
          onNewProject={openProjectModal}
          canCreateLocalProject={canCreateLocalProject}
          onPullRequests={onPullRequests}
          onPlugins={onPlugins}
          activeSection={selectedExecutionId ? "conversation" : "new-chat"}
          selectedExecutionId={selectedExecutionId}
          homeBadgeCount={homeFeed.snapshot?.badgeCount ?? 0}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {registeredProjectsError ? (
            <div
              role="status"
              className="flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2 text-xs text-subtle"
            >
              <span>{registeredProjectsError}</span>
              <button
                type="button"
                disabled={loadingRegisteredProjects}
                onClick={() => void loadRegisteredProjects()}
                className="shrink-0 rounded-md px-2 py-1 text-foreground-secondary hover:bg-surface-hover hover:text-foreground disabled:opacity-60"
              >
                {loadingRegisteredProjects ? "Retrying…" : "Retry Projects"}
              </button>
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            {openingConversationError ||
            (executionId &&
              (currentTeamBindingProbe?.state === "error" ||
                teamBindingContextMismatch)) ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <p role="alert" className="max-w-md text-sm text-danger">
                  {openingConversationError?.message ??
                    currentTeamBindingProbe?.error ??
                    (teamBindingContextMismatch
                      ? teamBindingContextMismatchMessage
                      : "The conversation owner scope could not be checked.")}
                </p>
                <button
                  type="button"
                  onClick={() =>
                    resumeChat(
                      openingConversationError?.executionId ?? executionId!
                    )
                  }
                  className="rounded-md border border-border px-3 py-2 text-xs text-foreground-secondary hover:bg-surface-hover"
                >
                  Retry owner check
                </button>
              </div>
            ) : openingConversationId || resolvingExecutionRoot ? (
              <div className="flex h-full items-center justify-center text-sm text-subtle">
                {openingConversationId
                  ? "Checking conversation ownership…"
                  : "Opening conversation…"}
              </div>
            ) : requestedAgentId && agentSelectionState === "loading" ? (
              <div className="flex h-full items-center justify-center text-sm text-subtle">
                Loading the selected Agent…
              </div>
            ) : requestedAgentId && agentSelectionState === "error" ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <p role="alert" className="max-w-md text-sm text-danger">
                  {agentSelectionError ?? "The selected Agent is unavailable."}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => router.push("/agents")}
                    className="rounded-md border border-border px-3 py-2 text-xs text-foreground-secondary"
                  >
                    Back to Agents
                  </button>
                  <button
                    type="button"
                    onClick={() => router.replace("/?chat=1")}
                    className="rounded-md bg-accent px-3 py-2 text-xs font-medium text-accent-foreground"
                  >
                    Start a separate New Chat
                  </button>
                </div>
              </div>
            ) : (
              <>
                <LiveAgentChat
                  key={`${chatKey}:${acceptedTeamStartExecutionId === executionId ? "new" : (executionRoot?.conversationId ?? resumePersonalConversationId ?? resumeId ?? "new")}`}
                  conversationTitle={
                    managedConversations.find(
                      (item) => item.id === selectedExecutionId
                    )?.title
                  }
                  initialDraft={initialChatDraft}
                  onConversationStarted={(conversation) => {
                    setSelectedExecutionId(conversation.id);
                    setSelectedProject(conversation.projectId);
                    if (
                      !conversation.personalConversationId &&
                      teamRequestId &&
                      teamRequestTeamId &&
                      requestedAgentId &&
                      Number.isSafeInteger(teamRequestExpectedRequestVersion) &&
                      teamRequestExpectedRequestVersion! > 0 &&
                      Number.isSafeInteger(teamRequestExpectedReviewVersion) &&
                      teamRequestExpectedReviewVersion! > 0 &&
                      routeScopeKeyRef.current === routeScopeKey
                    ) {
                      // The successful start accepted these exact owner-review
                      // versions and binds the execution before it is returned.
                      // Seed the scope now so the execution URL transition keeps
                      // this live chat mounted while subsequent state refreshes.
                      acceptedTeamStartExecutionIdRef.current = conversation.id;
                      setAcceptedTeamStartExecutionId(conversation.id);
                      setTeamBindingProbe({
                        executionId: conversation.id,
                        state: "ready",
                        binding: {
                          requestId: teamRequestId,
                          teamId: teamRequestTeamId,
                          agentId: requestedAgentId
                        }
                      });
                    }
                    setManagedConversations((current) => [
                      conversation,
                      ...current.filter((item) => item.id !== conversation.id)
                    ]);
                    if (conversation.personalConversationId) {
                      setResumeId(undefined);
                      setResumePersonalConversationId(
                        conversation.personalConversationId
                      );
                      void listPersonalConversations()
                        .then(setPersonalConversationSummaries)
                        .catch(() => undefined);
                    }
                  }}
                  onStartFreshTeamPlanning={startFreshTeamPlanning}
                  initialSubmission={initialSubmission}
                  claimInitialSubmission={claimInitialSubmission}
                  initialSelection={initialChatSelection}
                  executionId={executionRoot ? undefined : resumeId}
                  personalConversationId={
                    executionRoot?.conversationId ??
                    resumePersonalConversationId
                  }
                  teamRequestId={teamRequestId}
                  teamRequestTeamId={teamRequestTeamId}
                  teamRequestExpectedRequestVersion={
                    teamRequestExpectedRequestVersion
                  }
                  teamRequestExpectedReviewVersion={
                    teamRequestExpectedReviewVersion
                  }
                  sidebarMoveTarget={pendingSidebarMove}
                  onSidebarMoveTargetHandled={(requestId) => {
                    setPendingSidebarMove((current) =>
                      current?.requestId === requestId ? null : current
                    );
                  }}
                  projectId={selectedProject ?? undefined}
                  projectName={selectedProjectName}
                  registeredProjects={registeredProjects.filter((project) =>
                    /^lp_[0-9a-f]{32}$/iu.test(project.id)
                  )}
                  onChooseChatFolder={
                    canCreateLocalProject ? chooseChatFolder : undefined
                  }
                  onProjectMoveCompleted={handleProjectMoveCompleted}
                />
              </>
            )}
          </div>
        </div>
      </div>
      {projectModal}
    </>
  );
}

function HomeMode() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const requestedSettings = useMemo(
    () => privateAgentHandoffSelection(searchParams),
    [searchParams]
  );
  const demoMode = searchParams.get("demo");
  const chat = searchParams.get("chat") === "1";
  const initialProjectRequest = searchParams.get("newProject") === "1";
  useEffect(() => {
    if (demoMode === "1") router.replace("/personal-preview");
  }, [demoMode, router]);
  if (demoMode === "1") return null;
  return demoMode === "legacy" ? (
    <DemoHome
      initialNewChat={chat}
      onPlugins={() => router.push("/plugins?demo=1")}
      onPullRequests={() => router.push("/pull-requests?demo=1")}
    />
  ) : (
    <LiveHome
      onPlugins={() => router.push("/plugins")}
      onPullRequests={() => router.push("/pull-requests")}
      initialChatOpen={chat}
      initialProjectRequest={initialProjectRequest}
      executionId={searchParams.get("execution") ?? undefined}
      personalConversationId={searchParams.get("conversation") ?? undefined}
      requestedProjectId={searchParams.get("project") ?? undefined}
      requestedAgentId={searchParams.get("agent") ?? undefined}
      requestedSettings={requestedSettings}
      requestDraft={searchParams.get("draft") ?? undefined}
      teamRequestId={searchParams.get("teamRequest") ?? undefined}
      teamRequestTeamId={searchParams.get("teamRequestTeam") ?? undefined}
      teamRequestExpectedRequestVersion={readVersionParam(
        searchParams.get("teamRequestVersion")
      )}
      teamRequestExpectedReviewVersion={readVersionParam(
        searchParams.get("teamReviewVersion")
      )}
    />
  );
}

function readVersionParam(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export default function Home() {
  if (process.env.NEXT_PUBLIC_KOED_STUDIO_HOSTED === "1") {
    return (
      <Suspense fallback={null}>
        <HostedStudio view="home" />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <HomeMode />
    </Suspense>
  );
}
