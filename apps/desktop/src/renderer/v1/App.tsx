import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import type {
  ManagedConversationDesktopApi,
  ManagedConversationLaunchOptions
} from "../../ipc/managed-conversation-protocol.js";
import type {
  V1ConversationIntent,
  V1Profile,
  V1Provenance
} from "../../ipc/v1-state-protocol.js";
import type { DesktopProject } from "../../project-memory-ui.js";
import {
  projectForLocalProject,
  sessionSelectionId
} from "../../project-memory-ui.js";
import { projectExecutionFolders } from "../../project-source-navigation.js";
import { assignmentFrom } from "../views/preferences/local-ai-client-settings-helpers.js";
import {
  selectionForAssignment,
  selectionForInstance,
  type ConversationSelection
} from "../views/personal/ConversationSettings.js";
import {
  appendManagedConversationUpdate,
  type ManagedConversationUpdateEnvelope
} from "../state/managed-conversation-runtime.js";
import { V1Settings, type V1SettingsTab } from "./settings.js";
import "./app-layout.css";
import "./app.css";
import { ConversationPresentationContext } from "../conversation-presentation.js";
import { createCollaborationRendererClient } from "../../collaboration/renderer-client.js";
import { DesktopStatusStore } from "../services/desktop-commands.js";
import { createRendererPlatform } from "../services/platform.js";
import { PersonalMemoryStore } from "../state/personal-memory.js";
import { useManagedConversationLifecycle } from "../state/use-managed-conversation-lifecycle.js";
import { ThemeStore } from "../state/theme.js";
import { useDesktopStatus } from "../state/use-status.js";
import { NewConversationComposer } from "../views/personal/NewConversationComposer.js";
import { StoreConversation } from "../views/personal/PersonalMemoryViews.js";
import {
  V1Onboarding,
  type OnboardingAgent,
  type OnboardingDraft
} from "./onboarding.js";
import { saveOnboardingMemory, V1MemoryPanel } from "./memory.js";
import {
  V1AgentContext,
  V1ConversationSurface,
  V1ManagedInput
} from "./runtime.js";
import {
  readV1Identity,
  readV1Profile,
  saveV1Profile,
  v1State
} from "./state.js";
import {
  DEFAULT_AGENT_LOOK,
  V1EmptyHero,
  V1Shell,
  V1ThreadLayout,
  type AgentLook,
  type V1HistoryGroup
} from "./visual.js";

const defaultStatusStore = new DesktopStatusStore();
const defaultThemeStore = new ThemeStore();
const emptyProvenance: V1Provenance = {
  schemaVersion: 1,
  conversations: {},
  projects: {}
};
const emptyProfile: V1Profile = {
  onboarding: { selections: {}, completed: false }
};
const fallbackAgent: OnboardingAgent = {
  name: "Koed",
  look: DEFAULT_AGENT_LOOK
};
const parseLook = (value: string | undefined): AgentLook => {
  try {
    const parsed: unknown = JSON.parse(value ?? "");
    if (!parsed || typeof parsed !== "object") return DEFAULT_AGENT_LOOK;
    const look = parsed as Record<string, unknown>;
    if (
      !["block", "bean", "tall", "wide"].includes(String(look.shape)) ||
      ![
        "violet",
        "blue",
        "mint",
        "lime",
        "sun",
        "coral",
        "pink",
        "slate"
      ].includes(String(look.color)) ||
      !["none", "antenna", "sprout", "ears"].includes(String(look.top))
    )
      return DEFAULT_AGENT_LOOK;
    return look as AgentLook;
  } catch {
    return DEFAULT_AGENT_LOOK;
  }
};
const launchIntent = (
  input: Parameters<ManagedConversationDesktopApi["start"]>[0],
  createdAt: string
): V1ConversationIntent => ({
  idempotencyKey: input.idempotencyKey,
  projectId: input.projectId,
  ...(input.contextKind ? { contextKind: input.contextKind } : {}),
  aiClientDriverId: input.aiClientDriverId,
  aiClientInstanceId: input.aiClientInstanceId,
  model: input.model,
  reasoningEffort: input.reasoningEffort,
  permissionMode: input.permissionMode,
  runnerKind: "local_device",
  ...(input.chiefOfStaffName
    ? { chiefOfStaffName: input.chiefOfStaffName }
    : {}),
  createdAt
});
const launchInput = (
  intent: V1ConversationIntent
): Parameters<ManagedConversationDesktopApi["start"]>[0] => ({
  projectId: intent.projectId,
  ...(intent.contextKind ? { contextKind: intent.contextKind } : {}),
  aiClientDriverId: intent.aiClientDriverId,
  aiClientInstanceId: intent.aiClientInstanceId,
  model: intent.model,
  reasoningEffort: intent.reasoningEffort,
  permissionMode: intent.permissionMode,
  runnerKind: "local_device",
  ...(intent.chiefOfStaffName
    ? { chiefOfStaffName: intent.chiefOfStaffName }
    : {}),
  idempotencyKey: intent.idempotencyKey
});

export const selectV1Projects = (
  projects: readonly DesktopProject[],
  provenance: V1Provenance
): DesktopProject[] =>
  projects.filter((project) => {
    const namedId = project.namedProject?.projectId;
    return (
      Boolean(
        namedId &&
        Object.values(provenance.projects).some(
          (intent) => intent.projectId === namedId
        )
      ) ||
      Object.values(provenance.conversations).some(
        (intent) => intent.presentationProjectId === project.id
      )
    );
  });

export const selectV1History = (provenance: V1Provenance) =>
  Object.values(provenance.conversations).filter((intent) =>
    Boolean(intent.executionId)
  );

export const shouldShowV1Onboarding = (
  profile: V1Profile,
  backendComplete: boolean
): boolean => !profile.onboarding.completed || !backendComplete;

export const createV1ProfileWriter = (
  read: () => V1Profile,
  persist: (profile: V1Profile) => Promise<V1Profile>,
  publish: (profile: V1Profile) => void
) => {
  let tail = Promise.resolve();
  return (update: (profile: V1Profile) => V1Profile): Promise<V1Profile> => {
    const work = tail.then(async () => {
      const current = read();
      const next = update(current);
      if (next === current) return current;
      const saved = await persist(next);
      publish(saved);
      return saved;
    });
    tail = work.then(
      () => undefined,
      () => undefined
    );
    return work;
  };
};

export function V1App({
  completeOnboarding,
  onboardingComplete = true,
  personalMemoryApi = window.koedDesktop?.personalMemory ?? null,
  managedConversations = window.koedDesktop?.managedConversations ?? null,
  statusStore = defaultStatusStore,
  themeStore = defaultThemeStore
}: {
  completeOnboarding?: () => Promise<void>;
  onboardingComplete?: boolean;
  personalMemoryApi?: PersonalDesktopApi | null;
  managedConversations?: ManagedConversationDesktopApi | null;
  statusStore?: DesktopStatusStore;
  themeStore?: ThemeStore;
}) {
  const [profile, setProfile] = useState<V1Profile | null>(null);
  const [profileReadError, setProfileReadError] = useState<string | null>(null);
  const [profileReadRevision, setProfileReadRevision] = useState(0);
  const [reconcileRevision, setReconcileRevision] = useState(0);
  const [pendingIntentError, setPendingIntentError] = useState<string | null>(
    null
  );
  const profileRef = useRef<V1Profile>(emptyProfile);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [scopeKey, setScopeKey] = useState<string | null>(null);
  const scopeKeyRef = useRef<string | null>(null);
  scopeKeyRef.current = scopeKey;
  const [provenance, setProvenance] = useState<V1Provenance>(emptyProvenance);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<{
    kind: "home" | "project" | "conversation";
    projectId?: string;
    executionId?: string;
  }>({ kind: "home" });
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectFolderPath, setNewProjectFolderPath] = useState("");
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [launchPending, setLaunchPending] = useState(false);
  const [composerGeneration, setComposerGeneration] = useState(0);
  const [newProjectBusy, setNewProjectBusy] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null
  );
  const [folderChoices, setFolderChoices] = useState<Record<string, string>>(
    {}
  );
  const [launchOptions, setLaunchOptions] =
    useState<ManagedConversationLaunchOptions | null>(null);
  const [selection, setSelection] = useState<ConversationSelection>({
    instanceId: "",
    model: "",
    reasoningEffort: "",
    permissionMode: ""
  });
  const [realtime, setRealtime] =
    useState<ManagedConversationUpdateEnvelope | null>(null);
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  const [independentProject, setIndependentProject] =
    useState<DesktopProject | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<V1SettingsTab>("general");
  const [revision, setRevision] = useState(0);
  const attemptedReconcile = useRef(new Set<string>());
  const lastSelectedGeneration = useRef<number | null>(null);
  const selectedProjectIdRef = useRef<string | null>(null);
  selectedProjectIdRef.current = selectedProjectId;
  const platform = useMemo(() => createRendererPlatform(), []);
  const { status } = useDesktopStatus(statusStore);
  const store = useMemo(
    () =>
      personalMemoryApi ? new PersonalMemoryStore(personalMemoryApi) : null,
    [personalMemoryApi]
  );
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? (() => () => undefined),
    store?.current ?? (() => null),
    store?.current ?? (() => null)
  );
  const lifecycle = useManagedConversationLifecycle({
    api: managedConversations,
    store,
    ownerId,
    revision,
    update: realtime
  });
  const agent = useMemo<OnboardingAgent>(
    () =>
      profile
        ? {
            name: profile.agentName ?? fallbackAgent.name,
            look: parseLook(profile.agentLook)
          }
        : fallbackAgent,
    [profile]
  );
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const refreshProvenance = useCallback(async () => {
    const identity = await readV1Identity();
    const value = await v1State().readProvenance();
    const verified = await readV1Identity();
    if (
      identity.scopeKey === verified.scopeKey &&
      identity.scopeKey === scopeKeyRef.current
    )
      setProvenance(value);
    return value;
  }, []);
  const saveProfile = useMemo(
    () =>
      createV1ProfileWriter(
        () => profileRef.current,
        saveV1Profile,
        (saved) => {
          profileRef.current = saved;
          setProfile(saved);
        }
      ),
    []
  );

  useEffect(() => {
    let active = true;
    void readV1Profile()
      .then((value) => {
        if (active) {
          profileRef.current = value;
          setProfileReadError(null);
          setProfile(value);
        }
      })
      .catch((cause) => {
        if (active)
          setProfileReadError(
            cause instanceof Error ? cause.message : String(cause)
          );
      });
    return () => {
      active = false;
    };
  }, [profileReadRevision]);
  useEffect(() => {
    if (
      !store ||
      !profile?.onboarding.completed ||
      status?.api.state !== "healthy"
    )
      return;
    void store.loadProjects().catch((cause) => setError(String(cause)));
  }, [store, profile?.onboarding.completed, status?.api.state]);
  useEffect(() => {
    if (status?.api.state === "healthy") setError(null);
  }, [status?.api.state]);
  useEffect(() => {
    void statusStore.refresh();
    void themeStore.load();
  }, [statusStore, themeStore]);
  useEffect(() => {
    if (
      !personalMemoryApi ||
      !managedConversations ||
      !profile?.onboarding.completed ||
      status?.api.state !== "healthy"
    )
      return;
    let active = true;
    let generation = 0;
    const load = async () => {
      const currentGeneration = ++generation;
      try {
        const identity = await readV1Identity();
        if (!active || currentGeneration !== generation) return;
        if (scopeKey !== identity.scopeKey) {
          attemptedReconcile.current.clear();
          setOwnerId(identity.ownerId);
          setScopeKey(identity.scopeKey);
          setProvenance(emptyProvenance);
          setIndependentProject(null);
          setSelectedProjectId(null);
          setRoute({ kind: "home" });
        }
        const value = await v1State().readProvenance();
        const verified = await readV1Identity();
        if (
          !active ||
          currentGeneration !== generation ||
          verified.scopeKey !== identity.scopeKey
        )
          return;
        setProvenance(value);
      } catch (cause) {
        if (active && currentGeneration === generation)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    const unsubscribe = window.koedDesktop?.status?.subscribe(
      () => void load()
    );
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [
    personalMemoryApi,
    managedConversations,
    scopeKey,
    refreshProvenance,
    profile?.onboarding.completed,
    status?.api.state
  ]);
  useEffect(() => {
    if (!store || !ownerId || status?.api.state !== "healthy") return;
    let active = true;
    const resolve = async () => {
      try {
        const metadata = await platform.ensureIndependentProject();
        const refreshed = await store.loadProjects({ silent: true });
        const found = projectForLocalProject(
          refreshed.projectsById.values(),
          metadata.localProjectId
        );
        if (active) setIndependentProject(found);
      } catch (cause) {
        if (active) {
          setIndependentProject(null);
          setError(
            `Chat Folder is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`
          );
        }
      }
    };
    void resolve();
    return () => {
      active = false;
    };
  }, [store, ownerId, platform, status?.api.state]);

  useEffect(() => {
    if (
      !managedConversations ||
      !profile?.onboarding.completed ||
      status?.api.state !== "healthy"
    )
      return;
    let active = true;
    const load = async () => {
      try {
        const [{ options }, settings] = await Promise.all([
          managedConversations.launchOptions(),
          window.koedDesktop?.localAiClients?.list()
        ]);
        if (!active) return;
        const assignment = settings
          ? assignmentFrom(settings.readModel, "conversations")
          : null;
        setLaunchOptions(options);
        setSelection((current) => {
          if (lastSelectedGeneration.current !== composerGeneration) {
            lastSelectedGeneration.current = composerGeneration;
            return assignment
              ? selectionForAssignment(options, assignment)
              : selectionForInstance(
                  options,
                  options.instances.find((candidate) => candidate.ready)
                    ?.instanceId ?? ""
                );
          }
          const instance = options.instances.find(
            (candidate) => candidate.instanceId === current.instanceId
          );
          const currentModel = instance?.models.find(
            (model) => model.id === current.model
          );
          const effortValid =
            currentModel &&
            (current.reasoningEffort === "" ||
              currentModel.supportedReasoningEfforts.includes(
                current.reasoningEffort
              ));
          const permissionValid = instance?.capabilities.permissionModes.some(
            (mode) =>
              mode.mode === current.permissionMode &&
              mode.support === "supported"
          );
          if (instance?.ready && currentModel && effortValid && permissionValid)
            return current;
          return assignment
            ? selectionForAssignment(options, assignment)
            : selectionForInstance(
                options,
                options.instances.find((candidate) => candidate.ready)
                  ?.instanceId ?? ""
              );
        });
      } catch (cause) {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [
    managedConversations,
    profile?.onboarding.completed,
    status?.state,
    settingsOpen,
    composerGeneration
  ]);
  useEffect(() => {
    if (!profile?.onboarding.completed || status?.api.state !== "healthy")
      return;
    const collaborationClient = createCollaborationRendererClient(
      window.koedDesktop?.collaboration ?? {
        command: async () => {
          throw new Error("Collaboration bridge unavailable.");
        },
        subscribe: () => () => undefined
      }
    );
    const unsubscribe = collaborationClient.subscribe((_snapshot, update) => {
      if (update.authoritativeRecovery)
        setRecoveryRevision((value) => value + 1);
      if (update.kind !== "realtime") return;
      if (update.realtimeUpdate?.type === "managed_conversation_upserted") {
        const realtimeUpdate = update.realtimeUpdate;
        setRevision((value) => value + 1);
        setRealtime((current) =>
          appendManagedConversationUpdate(current, realtimeUpdate)
        );
      } else if (update.realtimeUpdate?.type === "personal_memory_upserted") {
        store?.refreshFromDurableEvent();
      }
    });
    void collaborationClient
      .load()
      .then(() => setError(null))
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause))
      );
    return () => {
      unsubscribe();
      collaborationClient.dispose();
    };
  }, [store, profile?.onboarding.completed, status?.api.state]);

  const projects = useMemo(
    () => [...(snapshot?.projectsById.values() ?? [])],
    [snapshot]
  );
  const projectForIntent = useCallback(
    (intent: V1ConversationIntent) =>
      projects.find((project) => project.id === intent.presentationProjectId) ??
      (independentProject &&
      [independentProject.id, independentProject.localProjectId].includes(
        intent.projectId
      )
        ? independentProject
        : null),
    [projects, independentProject]
  );
  // A recorded intent is replayed with its original idempotency key after an uncertain response.
  useEffect(() => {
    if (
      !scopeKey ||
      status?.api.state !== "healthy" ||
      !profile?.onboarding.completed ||
      !managedConversations ||
      !store ||
      !snapshot ||
      snapshot.loading
    )
      return;
    let active = true;
    const reconcile = async () => {
      setPendingIntentError(null);
      for (const intent of Object.values(provenance.projects)) {
        if (intent.projectId && (!intent.folder || intent.folderAttached))
          continue;
        const attemptKey = `project:${reconcileRevision}:${intent.requestId}`;
        if (attemptedReconcile.current.has(attemptKey)) continue;
        attemptedReconcile.current.add(attemptKey);
        try {
          let projectId = intent.projectId;
          if (!projectId) {
            if (!personalMemoryApi?.createProject)
              throw new Error("Project creation is unavailable.");
            const created = await personalMemoryApi.createProject({
              name: intent.name,
              requestId: intent.requestId
            });
            if (!active) return;
            projectId = created.projectId;
            await v1State().ackProject({
              requestId: intent.requestId,
              projectId
            });
            await refreshProvenance();
          }
          if (intent.folder && personalMemoryApi?.manageProject) {
            const fresh = await store.loadProjects({ silent: true });
            const project = [...fresh.projectsById.values()].find(
              (candidate) => candidate.namedProject?.projectId === projectId
            );
            if (!project?.namedProject)
              throw new Error("Project is still loading.");
            const attached = project.inclusionRules?.some(
              (rule) =>
                rule.target.kind === "folder" &&
                JSON.stringify(rule.target.folder) ===
                  JSON.stringify(intent.folder) &&
                !rule.removedAt
            );
            if (!attached) {
              await personalMemoryApi.manageProject({
                action: "add_folder",
                projectId,
                expectedVersion: project.namedProject.version,
                folder: intent.folder
              });
              await store.loadProjects({ silent: true });
            }
            await v1State().ackProjectFolder(intent.requestId);
            await refreshProvenance();
          }
        } catch (cause) {
          if (active)
            setPendingIntentError(
              `Project ${intent.name} is pending: ${cause instanceof Error ? cause.message : String(cause)}`
            );
        }
      }
      for (const intent of Object.values(provenance.conversations)) {
        if (!active) return;
        const attemptKey = `conversation:${reconcileRevision}:${intent.idempotencyKey}`;
        if (attemptedReconcile.current.has(attemptKey)) continue;
        const project = projectForIntent(intent);
        if (!project) {
          if (active)
            setPendingIntentError(
              "A Conversation is pending until its local Folder is available."
            );
          continue;
        }
        attemptedReconcile.current.add(attemptKey);
        try {
          const result = intent.executionId
            ? await managedConversations.inspect(intent.executionId)
            : await managedConversations.start(launchInput(intent));
          if (!active) return;
          if (!intent.executionId) {
            await v1State().ackConversation({
              idempotencyKey: intent.idempotencyKey,
              executionId: result.executionId,
              capturedSessionId: result.conversation?.capturedSessionId
            });
            await refreshProvenance();
          } else if (
            result.conversation?.capturedSessionId &&
            result.conversation.capturedSessionId !== intent.capturedSessionId
          ) {
            await v1State().ackConversation({
              idempotencyKey: intent.idempotencyKey,
              executionId: result.executionId,
              capturedSessionId: result.conversation.capturedSessionId
            });
            await refreshProvenance();
          }
          if (!lifecycle.drafts.has(result.executionId)) {
            const conversation = result.conversation ?? {
              executionId: result.executionId,
              projectId: intent.projectId,
              capturedSessionId: result.executionId,
              threadId: result.executionId
            };
            lifecycle.started(
              project,
              conversation,
              result.status === "ready" ? "ready" : "starting",
              launchInput(intent),
              intent.initialPrompt
            );
          }
        } catch (cause) {
          if (active)
            setPendingIntentError(
              `Conversation launch is pending: ${cause instanceof Error ? cause.message : String(cause)}`
            );
        }
      }
    };
    void reconcile();
    return () => {
      active = false;
    };
  }, [
    scopeKey,
    managedConversations,
    personalMemoryApi,
    store,
    snapshot?.loading,
    projects,
    independentProject,
    provenance,
    refreshProvenance,
    reconcileRevision,
    status?.api.state,
    profile?.onboarding.completed
  ]);

  const v1ManagedConversations = useMemo<ManagedConversationDesktopApi | null>(
    () =>
      managedConversations && {
        ...managedConversations,
        start: async (input) => {
          const presentationProjectId = selectedProjectIdRef.current;
          const existing = (await v1State().readProvenance()).conversations[
            input.idempotencyKey
          ];
          const scoped = {
            ...input,
            chiefOfStaffName:
              existing?.chiefOfStaffName ?? agentRef.current.name
          };
          if (
            existing &&
            Object.entries(launchInput(existing)).some(
              ([key, value]) =>
                (scoped as Record<string, unknown>)[key] !== value
            )
          )
            throw new Error(
              "The pending Conversation has different launch settings."
            );
          if (!existing)
            await v1State().putConversationIntent({
              ...launchIntent(scoped, new Date().toISOString()),
              ...(presentationProjectId ? { presentationProjectId } : {})
            });
          const result = await managedConversations.start(scoped);
          await v1State().ackConversation({
            idempotencyKey: scoped.idempotencyKey,
            executionId: result.executionId,
            capturedSessionId: result.conversation?.capturedSessionId
          });
          await refreshProvenance();
          return result;
        },
        send: async (input) => {
          const known = Object.values(
            (await v1State().readProvenance()).conversations
          ).find((intent) => intent.executionId === input.executionId);
          if (!known) throw new Error("V1 Conversation provenance is missing.");
          const initialPrompt = {
            clientUserMessageId: input.clientUserMessageId,
            prompt: input.prompt,
            status: "reconciling" as const,
            message:
              "Koed could not confirm whether the first prompt was accepted."
          };
          await v1State().saveInitialPrompt({
            idempotencyKey: known.idempotencyKey,
            initialPrompt
          });
          const result = await managedConversations.send(input);
          await v1State().saveInitialPrompt({
            idempotencyKey: known.idempotencyKey,
            initialPrompt: {
              ...initialPrompt,
              status: result.status,
              message: result.message ?? ""
            }
          });
          await refreshProvenance();
          return result;
        }
      },
    [managedConversations, refreshProvenance]
  );

  const visibleSessionIds = new Set(
    Object.values(provenance.conversations).flatMap((intent) =>
      [intent.capturedSessionId, intent.executionId].filter(
        (id): id is string => Boolean(id)
      )
    )
  );
  const visibleProjects = selectV1Projects(projects, provenance);
  const activeProject = selectedProjectId
    ? (visibleProjects.find((project) => project.id === selectedProjectId) ??
      null)
    : independentProject;
  const folders =
    activeProject && selectedProjectId && snapshot
      ? projectExecutionFolders(activeProject, snapshot.inventory)
      : [];
  const selectedFolder =
    folders.find(
      (folder) => folder.id === folderChoices[selectedProjectId ?? ""]
    ) ?? (folders.length === 1 ? folders[0] : null);
  const selectedExecution =
    route.kind === "conversation" ? route.executionId : undefined;
  const selectedIntent = Object.values(provenance.conversations).find(
    (intent) => intent.executionId === selectedExecution
  );
  const selectedDraft = selectedExecution
    ? (lifecycle.drafts.get(selectedExecution) ?? null)
    : null;
  const conversationProject = selectedIntent
    ? projectForIntent(selectedIntent)
    : null;
  const conversationThread =
    conversationProject && selectedExecution
      ? (conversationProject.threads.find(
          (thread) =>
            visibleSessionIds.has(thread.sessionId ?? "") &&
            (thread.sessionId === selectedIntent?.capturedSessionId ||
              sessionSelectionId(thread) === selectedExecution)
        ) ??
        selectedDraft?.thread ??
        null)
      : null;
  const groups: V1HistoryGroup[] = [
    {
      id: "conversations",
      label: "Conversations",
      items: Object.values(provenance.conversations)
        .filter((intent) => intent.executionId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((intent) => {
          const draft = lifecycle.drafts.get(intent.executionId!);
          const project = projectForIntent(intent);
          const captured = project?.threads.find(
            (thread) => thread.sessionId === intent.capturedSessionId
          );
          return {
            id: intent.executionId!,
            title: captured?.name || draft?.thread.name || "New Conversation",
            active:
              route.kind === "conversation" &&
              route.executionId === intent.executionId,
            onSelect: () =>
              setRoute({
                kind: "conversation",
                executionId: intent.executionId
              })
          };
        })
    },
    {
      id: "projects",
      label: "Projects",
      items: visibleProjects
        .filter((project) => project.namedProject)
        .map((project) => ({
          id: project.id,
          title: project.name,
          active: route.kind === "project" && route.projectId === project.id,
          onSelect: () => {
            setSelectedProjectId(project.id);
            setRoute({ kind: "project", projectId: project.id });
          }
        }))
    }
  ];
  const createProject = async () => {
    const name = newProjectName.trim();
    if (!name || !personalMemoryApi?.createProject || newProjectBusy) return;
    setNewProjectBusy(true);
    setError(null);
    try {
      const existing = Object.values(
        (await v1State().readProvenance()).projects
      ).find(
        (intent) =>
          intent.name === name &&
          (!intent.projectId || (intent.folder && !intent.folderAttached))
      );
      const requestId = existing?.requestId ?? crypto.randomUUID();
      const local = snapshot?.inventory.localFolders.find(
        (item) => item.normalizedPath === newProjectFolderPath
      );
      const folder =
        existing?.folder ??
        (local && ownerId
          ? { ...local.identity, ownerUserId: ownerId }
          : undefined);
      if (!existing)
        await v1State().putProjectIntent({
          requestId,
          name,
          ...(folder ? { folder } : {}),
          createdAt: new Date().toISOString()
        });
      let projectId = existing?.projectId;
      if (!projectId) {
        const created = await personalMemoryApi.createProject({
          name,
          requestId
        });
        projectId = created.projectId;
        await v1State().ackProject({ requestId, projectId });
      }
      await refreshProvenance();
      const fresh = await store?.loadProjects({ silent: true });
      const project = [...(fresh?.projectsById.values() ?? [])].find(
        (item) => item.namedProject?.projectId === projectId
      );
      if (project) {
        setSelectedProjectId(project.id);
        setRoute({ kind: "project", projectId: project.id });
      }
      if (existing && folder && !existing.folderAttached)
        setReconcileRevision((value) => value + 1);
      setNewProjectOpen(false);
      setNewProjectName("");
      setNewProjectFolderPath("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setNewProjectBusy(false);
    }
  };
  const onSaveAgent = async (next: OnboardingAgent) => {
    await saveProfile((current) => ({
      ...current,
      agentName: next.name,
      agentLook: JSON.stringify(next.look)
    }));
  };
  const onSaveDraft = async (draft: OnboardingDraft) => {
    await saveProfile((current) =>
      current.onboarding.completed
        ? current
        : {
            ...current,
            onboarding: {
              ...current.onboarding,
              step: draft.step,
              draft: draft as unknown as Record<string, unknown>
            }
          }
    );
  };
  const onComplete = async () => {
    await completeOnboarding?.();
    await saveProfile((current) => ({
      ...current,
      onboarding: { ...current.onboarding, completed: true, draft: undefined }
    }));
  };
  const launchComposer = (
    <div className="v1-launch">
      <div className="v1-project-picker">
        <button
          type="button"
          disabled={launchPending}
          aria-expanded={projectPickerOpen}
          aria-label="Select Project"
          onClick={() => setProjectPickerOpen((open) => !open)}
        >
          {activeProject && selectedProjectId
            ? activeProject.name
            : "No project"}{" "}
          ▾
        </button>
        {projectPickerOpen && (
          <div role="menu" aria-label="Projects">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setSelectedProjectId(null);
                setProjectPickerOpen(false);
              }}
            >
              No project
            </button>
            {visibleProjects
              .filter((project) => project.namedProject)
              .map((project) => (
                <button
                  key={project.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSelectedProjectId(project.id);
                    setProjectPickerOpen(false);
                  }}
                >
                  {project.name}
                </button>
              ))}
          </div>
        )}
      </div>
      <NewConversationComposer
        key={composerGeneration}
        onPendingChange={setLaunchPending}
        api={v1ManagedConversations}
        projectId={
          selectedProjectId
            ? (selectedFolder?.id ?? null)
            : (activeProject?.localProjectId ?? activeProject?.id ?? null)
        }
        projectRoot={selectedProjectId ? (selectedFolder?.path ?? null) : null}
        commandProjectId={
          selectedProjectId ? (selectedFolder?.id ?? null) : null
        }
        folderPicker={{
          folders,
          selectedId: selectedFolder?.id ?? null,
          onSelect: (id) => {
            if (selectedProjectId)
              setFolderChoices((current) => ({
                ...current,
                [selectedProjectId]: id
              }));
          },
          ...(selectedProjectId
            ? {}
            : { disabledReason: "Chat uses its own Folder." })
        }}
        contextKind={selectedProjectId ? "project" : "independent"}
        options={launchOptions}
        selection={selection}
        onChange={setSelection}
        requirePrompt
        showContextHelp={false}
        onStarted={(conversation, status, launch, initialPrompt) => {
          const project = activeProject;
          if (!project) return;
          const routeId = lifecycle.started(
            project,
            conversation,
            status,
            launch,
            initialPrompt
          );
          if (routeId) {
            setRevision((value) => value + 1);
            setRoute({
              kind: "conversation",
              executionId: routeId
            });
          }
        }}
      />
    </div>
  );
  if (!profile)
    return profileReadError ? (
      <main role="alert">
        Koed could not read your saved profile: {profileReadError}{" "}
        <button
          type="button"
          onClick={() => {
            setProfileReadError(null);
            setProfileReadRevision((value) => value + 1);
          }}
        >
          Retry
        </button>
      </main>
    ) : (
      <p role="status">Loading Koed…</p>
    );
  if (shouldShowV1Onboarding(profile, onboardingComplete))
    return (
      <V1Shell title="Getting started" groups={[]} accountLabel="Koed">
        <V1Onboarding
          savedAgent={{
            name: profile.agentName ?? "",
            look: parseLook(profile.agentLook)
          }}
          savedDraft={
            (profile.onboarding.draft as OnboardingDraft | undefined) ?? null
          }
          onSaveDraft={onSaveDraft}
          onSaveAgent={onSaveAgent}
          onComplete={onComplete}
          onMemoryDemo={
            personalMemoryApi
              ? (text) => saveOnboardingMemory(personalMemoryApi, text)
              : undefined
          }
          statusStore={statusStore}
        />
      </V1Shell>
    );
  // The prototype debug restart panel is excluded; Settings owns "Run setup again".
  return (
    <V1AgentContext.Provider value={agent}>
      <ConversationPresentationContext.Provider
        value={{
          Input: V1ManagedInput,
          Surface: V1ConversationSurface,
          compact: true
        }}
      >
        <V1Shell
          title={
            route.kind === "project"
              ? visibleProjects.find(
                  (project) => project.id === route.projectId
                )?.name
              : route.kind === "conversation"
                ? (conversationThread?.name ?? "Conversation")
                : undefined
          }
          groups={groups}
          accountLabel={agent.name}
          accountSubLabel="Your Koed"
          onAccount={() => {
            setSettingsTab("general");
            setSettingsOpen(true);
          }}
          onHome={() => setRoute({ kind: "home" })}
          onNewConversation={() => {
            setSelectedProjectId(null);
            setLaunchPending(false);
            setComposerGeneration((value) => value + 1);
            setRoute({ kind: "home" });
          }}
          onNewProject={() => setNewProjectOpen(true)}
          railFooter={
            <button
              type="button"
              aria-label="Open service status"
              onClick={() => {
                setSettingsTab("services");
                setSettingsOpen(true);
              }}
            >
              Koed{" "}
              {status?.state === "healthy"
                ? "ready"
                : status?.state === "needs_attention"
                  ? "needs attention"
                  : status?.state === "starting"
                    ? "starting"
                    : "stopped"}
            </button>
          }
          topActions={
            <>
              <button type="button" onClick={() => setMemoryOpen(true)}>
                Memory
              </button>
              <button type="button" onClick={() => setSettingsOpen(true)}>
                Settings
              </button>
            </>
          }
        >
          {pendingIntentError && (
            <p role="alert">
              {pendingIntentError}{" "}
              <button
                type="button"
                onClick={() => setReconcileRevision((value) => value + 1)}
              >
                Retry pending action
              </button>
            </p>
          )}
          {error && (
            <p role="alert">
              {error}{" "}
              <button type="button" onClick={() => setError(null)}>
                Dismiss
              </button>
            </p>
          )}
          {route.kind === "conversation" &&
          conversationProject &&
          conversationThread &&
          store ? (
            <StoreConversation
              key={selectedExecution}
              managedConversationRevision={revision}
              managedConversationRecoveryRevision={recoveryRevision}
              managedConversationUpdate={realtime}
              managedConversations={managedConversations}
              pendingCanonicalConversation={Boolean(
                selectedDraft && selectedDraft.status !== "ready"
              )}
              managedDraft={selectedDraft}
              onRetryManagedConversation={
                selectedExecution
                  ? () => void lifecycle.retry(selectedExecution)
                  : null
              }
              project={conversationProject}
              routeSessionId={selectedExecution!}
              store={store}
              thread={conversationThread}
            />
          ) : route.kind === "conversation" ? (
            <p role="status">Loading Conversation…</p>
          ) : (
            <>
              {route.kind === "project" && (
                <V1ThreadLayout composer={launchComposer}>
                  <section className="v1-project-page">
                    <h2>
                      {visibleProjects.find(
                        (project) => project.id === route.projectId
                      )?.name ?? "Project"}
                    </h2>
                    <p>
                      {folders.length
                        ? `${folders.length} local Folder${folders.length === 1 ? "" : "s"}`
                        : "No local Folder is attached yet."}
                    </p>
                    <ul>
                      {folders.map((folder) => (
                        <li key={folder.id}>{folder.path}</li>
                      ))}
                    </ul>
                    {Object.values(provenance.conversations)
                      .filter(
                        (intent) =>
                          intent.presentationProjectId === route.projectId &&
                          intent.executionId
                      )
                      .map((intent) => (
                        <button
                          key={intent.idempotencyKey}
                          type="button"
                          onClick={() =>
                            setRoute({
                              kind: "conversation",
                              executionId: intent.executionId
                            })
                          }
                        >
                          {lifecycle.drafts.get(intent.executionId!)?.thread
                            .name ?? "Conversation"}
                        </button>
                      ))}
                    {!folders.length &&
                    snapshot?.inventory.localFolders.length ? (
                      <label>
                        Attach a local Folder{" "}
                        <select
                          aria-label="Attach a local Folder"
                          defaultValue=""
                          onChange={(event) => {
                            const local = snapshot?.inventory.localFolders.find(
                              (folder) =>
                                folder.normalizedPath === event.target.value
                            );
                            const project = visibleProjects.find(
                              (item) => item.id === route.projectId
                            );
                            if (
                              !local ||
                              !project?.namedProject ||
                              !ownerId ||
                              !personalMemoryApi?.manageProject
                            )
                              return;
                            void personalMemoryApi
                              .manageProject({
                                action: "add_folder",
                                projectId: project.namedProject.projectId,
                                expectedVersion: project.namedProject.version,
                                folder: {
                                  ...local.identity,
                                  ownerUserId: ownerId
                                }
                              })
                              .then(() => store?.loadProjects({ silent: true }))
                              .catch((cause) =>
                                setError(
                                  cause instanceof Error
                                    ? cause.message
                                    : String(cause)
                                )
                              );
                          }}
                        >
                          <option value="">Choose Folder</option>
                          {snapshot.inventory.localFolders.map((folder) => (
                            <option
                              key={folder.normalizedPath}
                              value={folder.normalizedPath}
                            >
                              {folder.normalizedPath}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </section>
                </V1ThreadLayout>
              )}
              {route.kind === "home" && (
                <V1EmptyHero
                  agentName={agent.name}
                  look={agent.look}
                  subtitle="Your AI Client, with memory."
                  composer={launchComposer}
                />
              )}
            </>
          )}
          {newProjectOpen && (
            <div role="dialog" aria-label="Create Project" className="v1-modal">
              <h2>New Project</h2>
              <input
                aria-label="Project name"
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void createProject();
                }}
              />
              <label>
                Folder (optional)
                <select
                  value={newProjectFolderPath}
                  onChange={(event) =>
                    setNewProjectFolderPath(event.target.value)
                  }
                >
                  <option value="">Add later</option>
                  {snapshot?.inventory.localFolders.map((folder) => (
                    <option
                      key={folder.normalizedPath}
                      value={folder.normalizedPath}
                    >
                      {folder.normalizedPath}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={newProjectBusy || !newProjectName.trim()}
                onClick={() => void createProject()}
              >
                Create
              </button>
              <button
                type="button"
                disabled={newProjectBusy}
                onClick={() => setNewProjectOpen(false)}
              >
                Cancel
              </button>
            </div>
          )}
          {memoryOpen && personalMemoryApi && (
            <V1MemoryPanel
              api={personalMemoryApi}
              onClose={() => setMemoryOpen(false)}
            />
          )}
          {settingsOpen && (
            <V1Settings
              agent={agent}
              onSaveAgent={onSaveAgent}
              statusStore={statusStore}
              themeStore={themeStore}
              onClose={() => setSettingsOpen(false)}
              initialTab={settingsTab}
              onRestartOnboarding={async () => {
                await saveProfile((current) => ({
                  ...current,
                  onboarding: {
                    ...current.onboarding,
                    completed: false,
                    draft: undefined
                  }
                }));
                setSettingsOpen(false);
              }}
            />
          )}
        </V1Shell>
      </ConversationPresentationContext.Provider>
    </V1AgentContext.Provider>
  );
}
