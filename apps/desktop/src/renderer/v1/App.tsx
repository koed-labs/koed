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
  managedConversationUpdatesSince,
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
import { NavigationShell } from "./NavigationShell.js";
import { buildProjectSidebar } from "./project-sidebar-model.js";
import { useNavigationHistory } from "./use-navigation-history.js";
import {
  acknowledgeLateV1Capture,
  confirmV1ProjectMembership,
  lateV1CaptureSessionId,
  selectV1ExecutionTarget,
  useV1ProjectMembershipReconciler
} from "./project-flow.js";
import {
  V1Onboarding,
  type OnboardingAgent,
  type OnboardingDraft
} from "./onboarding.js";
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
import { parseAgentLook, serializeAgentLook } from "./pixelkin/agent-kin.js";
import { DEFAULT_AGENT_LOOK, V1EmptyHero } from "./visual.js";

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
  const [inventoryScope, setInventoryScope] = useState<string | null>(null);
  const scopeKeyRef = useRef<string | null>(null);
  scopeKeyRef.current = scopeKey;
  const [provenance, setProvenance] = useState<V1Provenance>(emptyProvenance);
  const [error, setError] = useState<string | null>(null);
  const navigation = useNavigationHistory(scopeKey);
  const { route, navigate: setRoute } = navigation;
  const [profileName, setProfileName] = useState("User");
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [launchPending, setLaunchPending] = useState(false);
  const [composerGeneration, setComposerGeneration] = useState(0);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<V1SettingsTab>("general");
  const [revision, setRevision] = useState(0);
  const attemptedReconcile = useRef(new Set<string>());
  const attemptedCaptures = useRef(new Set<string>());
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
            look: parseAgentLook(profile.agentLook)
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
  // Projects stay hidden until a load succeeds for the current owner. Every
  // successful load the shell awaits opens that gate, so a later recovery is
  // not left behind an empty sidebar once the store clears its error.
  const publishInventoryScope = useCallback(
    async (result: { error: string | null }, expectedScope: string) => {
      if (result.error) return;
      const identity = await readV1Identity();
      if (
        identity.scopeKey === expectedScope &&
        scopeKeyRef.current === expectedScope
      )
        setInventoryScope(expectedScope);
    },
    []
  );
  const loadInventory = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!store || !scopeKey) return;
      try {
        await publishInventoryScope(
          await store.loadProjects(options),
          scopeKey
        );
      } catch (cause) {
        if (scopeKeyRef.current === scopeKey) setError(String(cause));
      }
    },
    [store, scopeKey, publishInventoryScope]
  );
  const loadInventoryRef = useRef(loadInventory);
  loadInventoryRef.current = loadInventory;
  const inventoryScopeRef = useRef(inventoryScope);
  inventoryScopeRef.current = inventoryScope;
  useEffect(() => {
    if (profile?.onboarding.completed && status?.api.state === "healthy")
      void loadInventory();
  }, [loadInventory, profile?.onboarding.completed, status?.api.state]);
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
          attemptedCaptures.current.clear();
          setProfileName("User");
          setOwnerId(identity.ownerId);
          setScopeKey(identity.scopeKey);
          setProvenance(emptyProvenance);
          setRealtime(null);
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
        const expectedScope = scopeKeyRef.current;
        const refreshed = await store.loadProjects({ silent: true });
        if (expectedScope)
          await publishInventoryScope(refreshed, expectedScope);
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
  }, [store, ownerId, platform, status?.api.state, publishInventoryScope]);

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
    let active = true;
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
        // The store's own refresh cannot open the owner gate, so recover
        // through the gated load until one has succeeded for this owner.
        if (
          scopeKeyRef.current &&
          inventoryScopeRef.current !== scopeKeyRef.current
        )
          void loadInventoryRef.current({ silent: true });
        else store?.refreshFromDurableEvent();
      }
    });
    void collaborationClient
      .load()
      .then((snapshot) => {
        if (!active || scopeKeyRef.current !== scopeKey) return;
        setProfileName(
          snapshot.navigation?.personalOwner.displayName ?? "User"
        );
        setError(null);
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause))
      );
    return () => {
      active = false;
      unsubscribe();
      collaborationClient.dispose();
    };
  }, [store, profile?.onboarding.completed, status?.api.state, scopeKey]);

  const projects = useMemo(
    () =>
      scopeKey && inventoryScope === scopeKey
        ? [...(snapshot?.projectsById.values() ?? [])]
        : [],
    [snapshot, scopeKey, inventoryScope]
  );
  const projectForIntent = useCallback(
    (intent: V1ConversationIntent) => {
      const executionFolderProject = snapshot?.inventory
        ? [
            projects.find(
              (project) => project.id === intent.presentationProjectId
            ),
            ...projects
          ]
            .filter((project): project is DesktopProject => Boolean(project))
            .find((project) =>
              projectExecutionFolders(project, snapshot.inventory).some(
                (folder) => folder.id === intent.projectId
              )
            )
        : null;
      return (
        executionFolderProject ??
        projectForLocalProject(projects, intent.projectId) ??
        (independentProject &&
        [independentProject.id, independentProject.localProjectId].includes(
          intent.projectId
        )
          ? independentProject
          : null)
      );
    },
    [projects, snapshot?.inventory, independentProject]
  );
  const confirmProjectMembership = useCallback(
    async (
      intent: V1ConversationIntent,
      executionId: string,
      sessionId?: string
    ) => {
      if (
        !intent.presentationProjectId ||
        intent.projectMembershipConfirmed ||
        !sessionId ||
        !store ||
        !personalMemoryApi?.manageProject
      )
        return;
      await confirmV1ProjectMembership({
        intent,
        executionId,
        sessionId,
        scope: scopeKeyRef.current,
        currentScope: () => scopeKeyRef.current,
        loadProject: async (id) =>
          (await store.loadProjects({ silent: true })).projectsById.get(id),
        manageProject: personalMemoryApi.manageProject,
        ack: (input) => v1State().ackConversation(input),
        refresh: async () => {
          await refreshProvenance();
          await store.loadProjects({ silent: true });
        }
      });
    },
    [store, personalMemoryApi, refreshProvenance]
  );
  // A recorded intent is replayed with its original idempotency key after an uncertain response.
  useEffect(() => {
    if (
      !scopeKey ||
      inventoryScope !== scopeKey ||
      status?.api.state !== "healthy" ||
      !profile?.onboarding.completed ||
      !managedConversations ||
      !store ||
      !snapshot ||
      snapshot.loading
    )
      return;
    let active = true;
    const claimed = new Set<string>();
    const reconcile = async () => {
      setPendingIntentError(null);
      for (const intent of Object.values(provenance.projects)) {
        if (intent.projectId && (!intent.folder || intent.folderAttached))
          continue;
        const attemptKey = `project:${reconcileRevision}:${intent.requestId}`;
        if (attemptedReconcile.current.has(attemptKey)) continue;
        attemptedReconcile.current.add(attemptKey);
        claimed.add(attemptKey);
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
        } finally {
          claimed.delete(attemptKey);
        }
      }
      for (const intent of Object.values(provenance.conversations)) {
        if (!active) return;
        const attemptKey = `conversation:${reconcileRevision}:${intent.idempotencyKey}:${intent.capturedSessionId ?? "pending"}`;
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
        claimed.add(attemptKey);
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
        } finally {
          claimed.delete(attemptKey);
        }
      }
    };
    void reconcile();
    return () => {
      active = false;
      for (const key of claimed) attemptedReconcile.current.delete(key);
    };
  }, [
    scopeKey,
    inventoryScope,
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

  // Membership is keyed to durable capture identity. Keep it independent of
  // the launch inspection pass, whose cleanup can be triggered by store loads.
  useV1ProjectMembershipReconciler({
    enabled:
      status?.api.state === "healthy" &&
      Boolean(
        profile?.onboarding.completed &&
        store &&
        personalMemoryApi?.manageProject
      ),
    scopeKey,
    intents: Object.values(provenance.conversations),
    retryRevision: reconcileRevision,
    currentScope: () => scopeKeyRef.current,
    confirm: (intent) =>
      confirmProjectMembership(
        intent,
        intent.executionId!,
        intent.capturedSessionId
      ),
    onError: (cause) =>
      setPendingIntentError(
        `Project membership is pending: ${cause instanceof Error ? cause.message : String(cause)}`
      )
  });

  // The captured session may arrive after start/inspect returned. Recording its
  // runtime ID prompts the normal intent pass to confirm Project membership.
  useEffect(() => {
    if (!scopeKey) return;
    const latestByExecution = new Map<string, string>();
    for (const entry of realtime
      ? managedConversationUpdatesSince(realtime, 0).updates
      : []) {
      const execution = entry.update.execution;
      if (execution.sessionId)
        latestByExecution.set(execution.id, execution.sessionId);
    }
    for (const intent of Object.values(provenance.conversations)) {
      if (!intent.executionId) continue;
      const sessionId = lateV1CaptureSessionId(
        intent,
        latestByExecution.get(intent.executionId),
        lifecycle.drafts.get(intent.executionId)?.conversation.capturedSessionId
      );
      if (!sessionId) continue;
      const key = `${scopeKey}:${intent.executionId}:${sessionId}`;
      if (attemptedCaptures.current.has(key)) continue;
      attemptedCaptures.current.add(key);
      void acknowledgeLateV1Capture({
        intent,
        sessionId,
        scope: scopeKey,
        currentScope: () => scopeKeyRef.current,
        ack: (input) => v1State().ackConversation(input),
        refresh: refreshProvenance
      }).catch((cause) => {
        attemptedCaptures.current.delete(key);
        if (scopeKeyRef.current === scopeKey)
          setPendingIntentError(
            `Conversation capture is pending: ${cause instanceof Error ? cause.message : String(cause)}`
          );
      });
    }
  }, [scopeKey, realtime, provenance, lifecycle.drafts, refreshProvenance]);

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

  const visibleProjects = projects;
  const sidebarProjects = useMemo(
    () =>
      scopeKey && inventoryScope === scopeKey
        ? buildProjectSidebar(
            visibleProjects,
            Object.values(provenance.conversations),
            lifecycle.drafts
          )
        : [],
    [
      visibleProjects,
      provenance,
      lifecycle.drafts,
      revision,
      scopeKey,
      inventoryScope
    ]
  );
  const activeProject = selectedProjectId
    ? (visibleProjects.find((project) => project.id === selectedProjectId) ??
      null)
    : independentProject;
  const folders =
    activeProject && selectedProjectId && snapshot
      ? projectExecutionFolders(activeProject, snapshot.inventory)
      : [];
  // Reuse main’s independent execution Folder for a named Project with no Folder.
  const { selectedFolder, executionProject, executionProjectId } =
    selectV1ExecutionTarget({
      selectedProjectId,
      folders,
      selectedFolderId: folderChoices[selectedProjectId ?? ""],
      activeProject,
      independentProject
    });
  const selectedExecution =
    route.kind === "conversation" ? route.executionId : undefined;
  const selectedIntent = Object.values(provenance.conversations).find(
    (intent) => intent.executionId === selectedExecution
  );
  const selectedDraft = selectedExecution
    ? (lifecycle.drafts.get(selectedExecution) ?? null)
    : null;
  const capturedProject =
    route.kind === "conversation" && route.projectId
      ? visibleProjects.find((project) => project.id === route.projectId)
      : undefined;
  const conversationProject =
    capturedProject ??
    (selectedIntent ? projectForIntent(selectedIntent) : null);
  const conversationThread = conversationProject
    ? (conversationProject.threads.find((thread) =>
        route.kind === "conversation" && route.threadId
          ? thread.id === route.threadId
          : Boolean(
              selectedExecution &&
              (thread.sessionId === selectedIntent?.capturedSessionId ||
                sessionSelectionId(thread) === selectedExecution)
            )
      ) ??
      selectedDraft?.thread ??
      null)
    : null;
  const conversationRouteId =
    selectedExecution ??
    (conversationThread ? sessionSelectionId(conversationThread) : "");
  const onSaveAgent = async (next: OnboardingAgent) => {
    await saveProfile((current) => ({
      ...current,
      agentName: next.name,
      agentLook: serializeAgentLook(next.look, next.name)
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
        projectId={executionProjectId}
        projectRoot={selectedFolder?.path ?? null}
        commandProjectId={selectedFolder?.id ?? null}
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
        contextKind={selectedFolder ? "project" : "independent"}
        options={launchOptions}
        selection={selection}
        onChange={setSelection}
        requirePrompt
        showContextHelp={false}
        onStarted={(conversation, status, launch, initialPrompt) => {
          const project = executionProject;
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
      <V1Onboarding
        savedAgent={{
          name: profile.agentName ?? "",
          look: parseAgentLook(profile.agentLook)
        }}
        savedDraft={profile.onboarding.draft}
        onSaveDraft={onSaveDraft}
        onSaveAgent={onSaveAgent}
        onComplete={onComplete}
        statusStore={statusStore}
      />
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
        <NavigationShell
          projects={sidebarProjects}
          route={route}
          scopeKey={scopeKey}
          title={conversationThread?.name}
          projectName={conversationProject?.name}
          profileName={profileName}
          onSelect={setRoute}
          onHome={() => {
            setSelectedProjectId(null);
            setLaunchPending(false);
            setComposerGeneration((value) => value + 1);
            setRoute({ kind: "home" });
          }}
          onSettings={() => {
            setSettingsTab("general");
            setSettingsOpen(true);
          }}
          onProfile={() => {
            setSettingsTab("general");
            setSettingsOpen(true);
          }}
          onBack={navigation.back}
          onForward={navigation.forward}
          canGoBack={navigation.canGoBack}
          canGoForward={navigation.canGoForward}
          loading={snapshot?.loading}
          error={snapshot?.error}
          onRetry={() => void loadInventory()}
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
              key={conversationRouteId}
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
              routeSessionId={conversationRouteId}
              store={store}
              thread={conversationThread}
            />
          ) : route.kind === "conversation" ? (
            <p role="status">
              {snapshot?.loading
                ? "Loading Conversation…"
                : "This conversation is no longer available. Choose another conversation from the sidebar."}
            </p>
          ) : (
            <V1EmptyHero
              agentName={agent.name}
              look={agent.look}
              subtitle="Your AI Client, with memory."
              composer={launchComposer}
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
        </NavigationShell>
      </ConversationPresentationContext.Provider>
    </V1AgentContext.Provider>
  );
}
