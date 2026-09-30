"use client";

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
import { homeProjects, type HomeProject } from "@/lib/studio-home";
import { HostedStudio } from "@/components/hosted/HostedStudio";
import { personalAgentsHttpAdapter } from "@/lib/personal-agents-client";

function LiveHome({
  onPlugins,
  onPullRequests,
  initialChatOpen,
  initialProjectRequest,
  executionId,
  requestedProjectId,
  requestedAgentId
}: {
  onPlugins: () => void;
  onPullRequests: () => void;
  initialChatOpen: boolean;
  initialProjectRequest: boolean;
  executionId?: string;
  requestedProjectId?: string;
  requestedAgentId?: string;
}) {
  const [chatOpen, setChatOpen] = useState(initialChatOpen);
  const [collapsed, setCollapsed] = useState(false);
  const [chatKey, setChatKey] = useState(0);
  const [initialChatDraft, setInitialChatDraft] = useState("");
  const [initialChatSelection, setInitialChatSelection] = useState<
    ChatComposerSelection | undefined
  >();
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
  const [resumeId, setResumeId] = useState(executionId);
  const [projects, setProjects] = useState<HomeProject[]>([]);
  const [managedConversations, setManagedConversations] = useState<
    HomeExecution[]
  >([]);
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
        setInitialChatSelection({
          agentId: agent.id,
          expectedAgentVersion: agent.currentVersion,
          provider: agent.defaultProvider,
          model: agent.defaultModel ?? "",
          effort: agent.defaultReasoningEffort ?? "",
          permissionMode: "full"
        });
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
  }, [requestedAgentId]);

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
    const controller = new AbortController();
    fetch("/studio-api/home", {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal
    })
      .then(async (response) => (await response.json()) as unknown)
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
          setProjects([]);
          setManagedConversations([]);
          setSelectedProject(null);
          return;
        }

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
        setManagedConversations(executions);
        const verifiedProjects = homeProjects(recents, executions);
        setProjects(verifiedProjects);

        const candidate = executionId
          ? (executions.find((item) => item.id === executionId)?.projectId ??
            null)
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
          setProjects([]);
          setManagedConversations([]);
          setSelectedProject(null);
        }
      });
    return () => controller.abort();
  }, [
    executionId,
    homeRefreshRevision,
    registeredProjects,
    requestedProjectId
  ]);

  const newChat = (
    prompt = "",
    projectId?: string,
    selection?: ChatComposerSelection
  ) => {
    setResumeId(undefined);
    setInitialChatDraft(prompt);
    setInitialChatSelection(selection);
    setChatKey((value) => value + 1);
    setChatOpen(true);
    const nextProject =
      projectId ||
      (selectedProject && projectIds.has(selectedProject)
        ? selectedProject
        : null);
    setSelectedProject(nextProject);
    const project = nextProject
      ? `&project=${encodeURIComponent(nextProject)}`
      : "";
    router.replace(`/?chat=1${project}`);
  };
  const resumeChat = (id: string) => {
    setResumeId(id);
    setSelectedProject(null);
    setInitialChatDraft("");
    setInitialChatSelection(undefined);
    setChatKey((value) => value + 1);
    setChatOpen(true);
    router.replace(`/?chat=1&execution=${encodeURIComponent(id)}`);
  };
  const moveManagedExecutionToProject = (
    executionId: string,
    destinationProjectId: string
  ) => {
    if (!/^lp_[0-9a-f]{32}$/iu.test(destinationProjectId)) return;
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
          onNewChat={() => newChat()}
          onNewProject={openProjectModal}
          canCreateLocalProject={canCreateLocalProject}
          onStartChat={newChat}
          onResumeChat={resumeChat}
          onMoveManagedExecution={moveManagedExecutionToProject}
          onPlugins={onPlugins}
          onPullRequests={onPullRequests}
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
          managedConversations={managedConversations}
          registeredProjectIds={registeredProjects
            .map((project) => project.id)
            .filter((id) => /^lp_[0-9a-f]{32}$/iu.test(id))}
          onChatSelect={resumeChat}
          onMoveManagedExecution={moveManagedExecutionToProject}
          collapsed={collapsed}
          selectedProject={selectedProject}
          onProjectSelect={(projectId) => {
            if (resumeId || executionId) return;
            const nextProject = projectIds.has(projectId) ? projectId : null;
            setSelectedProject(nextProject);
            const query = nextProject
              ? `&project=${encodeURIComponent(nextProject)}`
              : "";
            router.replace(`/?chat=1${query}`);
          }}
          onToggle={() => setCollapsed((value) => !value)}
          onHome={() => {
            setChatOpen(false);
            router.replace("/");
          }}
          onNewChat={() => newChat()}
          onNewProject={openProjectModal}
          canCreateLocalProject={canCreateLocalProject}
          onPullRequests={onPullRequests}
          onPlugins={onPlugins}
          activeSection="new-chat"
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
            {requestedAgentId && agentSelectionState === "loading" ? (
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
                  key={chatKey}
                  initialDraft={initialChatDraft}
                  initialSelection={initialChatSelection}
                  executionId={resumeId}
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
      requestedProjectId={searchParams.get("project") ?? undefined}
      requestedAgentId={searchParams.get("agent") ?? undefined}
    />
  );
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
