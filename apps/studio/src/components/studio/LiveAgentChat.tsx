"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import { useRouter } from "next/navigation";
import { NewChatView, type NewChatRuntimeMessage } from "./NewChatView";
import type { ChatComposerSelection } from "../ChatComposer";
import {
  personalAgentsHttpAdapter,
  parseAvatar,
  type PersonalAgent
} from "@/lib/personal-agents-client";
import { pendingChatRequests } from "@/lib/managed-chat-requests";
import { managedAgentActivity } from "@/lib/managed-agent-activity";
import {
  cancelLocalProjectMove,
  deleteLocalRetainedManagedWorktree,
  loadLatestLocalProjectMove,
  loadLocalRetainedWorkspaces,
  openLocalRetainedWorkspace,
  requestLocalProjectMove,
  type HostedProjectMove,
  type LocalRetainedWorkspace
} from "@/lib/hosted-managed-chats";
import { ProjectMoveConfirmation } from "@/components/ProjectMoveConfirmation";
import {
  dismissProjectMoveNotice,
  shouldKeepProjectMoveNoticeIntent
} from "@/lib/project-move-preference";
import type { BuildActivity } from "@/lib/studio-build-activity";
import {
  acceptRuntimeSnapshot,
  managedRequest,
  managedConversationControls,
  parseExecution,
  parseLaunchInstances,
  parseRuntime,
  record,
  resolveLaunchSelection,
  validExecutionId,
  type LaunchInstance,
  type RuntimeSnapshot
} from "@/lib/managed-agent-chat";
import {
  createLocalManagedChatRecoveryStore,
  managedChatCommandMatchesPendingPrompt,
  managedChatRecoveryCommandDisposition,
  managedChatSendRequestFingerprint,
  reusableManagedChatSendIdentity,
  settleManagedChatStartRecovery,
  type DeviceManagedChatRecoveryRecord,
  type DeviceManagedChatRecoveryStore
} from "@/lib/device-managed-chat-recovery";

type LocalRecoveryStore = DeviceManagedChatRecoveryStore & {
  hydrate?: () => Promise<DeviceManagedChatRecoveryRecord | null>;
};

const terminalCommands = new Set([
  "completed",
  "failed",
  "canceled",
  "indeterminate"
]);
const failedExecutions = new Set(["failed", "fenced", "stopped", "stopping"]);
// Local Codex Move is exposed for review only after the runner transition passed service regression checks.
const PROJECT_MOVE_UI_ENABLED = true;
const isRegisteredProjectId = (value: string) =>
  /^lp_[0-9a-f]{32}$/iu.test(value);
const moveNoticeIntentKey = (executionId: string, moveId: string) =>
  `koed.studio.project-move-dismiss-intent:${executionId}:${moveId}`;
const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });

export function LiveAgentChat({
  executionId: initialExecutionId,
  initialDraft = "",
  initialSelection,
  projectId,
  projectName,
  registeredProjects = [],
  onProjectMoveCompleted,
  sidebarMoveTarget = null,
  onSidebarMoveTargetHandled
}: {
  executionId?: string;
  initialDraft?: string;
  initialSelection?: ChatComposerSelection;
  projectId?: string;
  projectName?: string;
  registeredProjects?: Array<{ id: string; name: string }>;
  onProjectMoveCompleted?: () => void;
  sidebarMoveTarget?: {
    executionId: string;
    destinationProjectId: string;
    requestId: number;
  } | null;
  onSidebarMoveTargetHandled?: (requestId: number) => void;
}) {
  const router = useRouter();
  const [agents, setAgents] = useState<PersonalAgent[]>([]);
  const [instances, setInstances] = useState<LaunchInstance[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(
    initialSelection?.agentId ?? null
  );
  const [executionId, setExecutionId] = useState<string | null>(
    initialExecutionId && validExecutionId(initialExecutionId)
      ? initialExecutionId
      : null
  );
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [activity, setActivity] = useState<BuildActivity | null>(null);
  const [messages, setMessages] = useState<NewChatRuntimeMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Connecting to the local runtime");
  const [historyNotice, setHistoryNotice] = useState("");
  const [latestProjectMove, setLatestProjectMove] =
    useState<HostedProjectMove | null>(null);
  const [projectMoveLoaded, setProjectMoveLoaded] = useState(false);
  const [projectMoveBusy, setProjectMoveBusy] = useState(false);
  const [projectMovePickerOpen, setProjectMovePickerOpen] = useState(false);
  const [projectMoveDialogOpen, setProjectMoveDialogOpen] = useState(false);
  const [projectMoveDestinationId, setProjectMoveDestinationId] = useState("");
  const [retainedWorkspaceState, setRetainedWorkspaceState] = useState<{
    executionId: string;
    workspaces: LocalRetainedWorkspace[];
    error: string | null;
  } | null>(null);
  const [openingRetainedWorkspaceId, setOpeningRetainedWorkspaceId] = useState<
    string | null
  >(null);
  const [retainedWorkspaceToDelete, setRetainedWorkspaceToDelete] =
    useState<LocalRetainedWorkspace | null>(null);
  const [deletingRetainedWorkspace, setDeletingRetainedWorkspace] =
    useState(false);
  const [sending, setSending] = useState(false);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [recoveredDraft, setRecoveredDraft] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [restoreSelection, setRestoreSelection] = useState<{
    key: string;
    provider: string;
    model: string;
    effort: string | null;
    permissionMode: "full" | "ask" | "read";
  }>();
  const restoredExecution = useRef<string | null>(null);
  const runtimeRef = useRef<RuntimeSnapshot | null>(null);
  const refreshSequence = useRef(0);
  const lifecycle = useRef<AbortController | null>(null);
  const recoveryStore = useRef<LocalRecoveryStore | null>(null);
  const recoveryIdentity = useRef<{ ownerId: string; backendId: string } | null>(null);
  const latestDraft = useRef(initialDraft);
  const operationRef = useRef(false);
  const refreshedCompletedMoveRef = useRef<string | null>(null);
  const projectMoveRequestInFlightRef = useRef(false);
  const retainedWorkspaceSequenceRef = useRef(0);
  const handledSidebarMoveRequestRef = useRef<number | null>(null);
  const selectionDirty = useRef(false);
  const pending = useRef<{
    key: string;
    id: string;
    messageId: string;
    startId: string;
    executionId?: string;
  } | null>(null);

  const activeRecoveryStore = (id: string | null) => {
    const identity = recoveryIdentity.current;
    if (!identity) return null;
    return createLocalManagedChatRecoveryStore({
      ...identity,
      executionId: id
    });
  };
  const persistDraft = (draft: string) => {
    const store = recoveryStore.current;
    if (!store) return;
    const current = store.read();
    store.write({
      schemaVersion: 1,
      draft,
      ...(current?.pendingOperation
        ? { pendingOperation: current.pendingOperation }
        : {})
    });
  };
  const settleRecoveredSend = useCallback((submittedPrompt: string) => {
    const store = recoveryStore.current;
    const latest = store?.read()?.draft ?? latestDraft.current;
    if (latest && latest !== submittedPrompt) {
      store?.write({ schemaVersion: 1, draft: latest });
      setRecoveredDraft(latest);
    } else {
      store?.clear();
      setRecoveredDraft(null);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    Promise.all([
      personalAgentsHttpAdapter.list(controller.signal),
      managedRequest("/launch-options", undefined, controller.signal),
      managedRequest("/access", undefined, controller.signal)
    ])
      .then(async ([library, options, access]) => {
        if (controller.signal.aborted) return;
        let recoveringPreviousSend = false;
        const user = record(access.user) ? access.user : null;
        recoveryIdentity.current = null;
        recoveryStore.current = null;
        if (user && typeof user.id === "string" && user.id.trim()) {
          // This component uses the Desktop's owner-authenticated loopback
          // managed gateway. The Team collaboration connection is unrelated
          // and may be offline while Personal chats still work.
          const identity = {
            ownerId: user.id,
            backendId: `${window.location.origin}:local-managed-gateway`
          };
          recoveryIdentity.current = identity;
          recoveryStore.current = createLocalManagedChatRecoveryStore({
            ...identity,
            executionId: initialExecutionId ?? null
          });
          if (recoveryStore.current.hydrate) {
            await recoveryStore.current.hydrate();
            if (controller.signal.aborted) return;
          }
          const recoveryRecord = recoveryStore.current?.read();
          const editedDuringLoad = latestDraft.current !== initialDraft;
          const draft = editedDuringLoad
            ? latestDraft.current
            : recoveryRecord?.draft ?? latestDraft.current;
          if (editedDuringLoad || (!recoveryRecord && draft)) {
            recoveryStore.current?.write({
              schemaVersion: 1,
              draft,
              ...(recoveryRecord?.pendingOperation
                ? { pendingOperation: recoveryRecord.pendingOperation }
                : {})
            });
          }
          setRecoveredDraft(draft || null);
          if (recoveryRecord?.pendingOperation) {
            recoveringPreviousSend = true;
            setRecoveryBlocked(true);
            setStatus("Checking the previous send status…");
            const operation = recoveryRecord.pendingOperation;
            const query = new URLSearchParams({
              kind: operation.kind,
              idempotencyKey: operation.kind === "start"
                ? operation.startIdempotencyKey
                : operation.promptIdempotencyKey
            });
            if (operation.kind === "prompt" && initialExecutionId && operation.executionGeneration !== undefined) {
              query.set("clientUserMessageId", operation.clientUserMessageId);
              query.set("executionId", initialExecutionId);
              query.set("executionGeneration", String(operation.executionGeneration));
            }
            if (operation.kind === "start" || (initialExecutionId && operation.executionGeneration !== undefined)) {
              void managedRequest(`/recovery/lookup?${query}`, undefined, controller.signal)
                .then(async (result) => {
                  if (controller.signal.aborted) return;
                  if (result.found === false) {
                    setStatus("Previous send status is not confirmed.");
                    setRecoveryBlocked(false);
                    setError(
                      operation.requestFingerprint
                        ? "Studio found no saved command. Retry the retained prompt to send it with the same identity; no message was sent again automatically."
                        : "This saved send predates settings verification. Send the same prompt to retry with its saved identity; the service will reject changed settings without creating another command."
                    );
                    return;
                  }
                  if (result.found !== true) {
                    setRecoveryBlocked(true);
                    setStatus("The previous send has an unconfirmed outcome.");
                    setError("Studio retained the draft and send identity because the status response was not understood.");
                    return;
                  }
                  const execution = parseExecution(result.execution);
                  const recoveredState = record(result.command) && typeof result.command.state === "string"
                    ? result.command.state
                    : "unknown";
                  const disposition = managedChatRecoveryCommandDisposition(recoveredState);
                  if (operation.kind === "start") {
                    const executionStore = activeRecoveryStore(execution.id);
                    if (executionStore && initialExecutionId !== execution.id) {
                      executionStore.write({
                        schemaVersion: 1,
                        draft: recoveryRecord.draft,
                        pendingOperation: { ...operation, state: "reconciling" }
                      });
                      await executionStore.flush?.();
                      recoveryStore.current?.clear();
                      recoveryStore.current = executionStore;
                    }
                    setExecutionId(execution.id);
                    if (disposition === "uncertain") {
                      setRecoveryBlocked(true);
                      setStatus("The previous chat launch has an unconfirmed outcome.");
                      setError("Studio retained the draft and send identity. Review the runtime before starting another turn.");
                    } else {
                      const currentRecord = recoveryStore.current?.read() ?? recoveryRecord;
                      const settledRecord = settleManagedChatStartRecovery(
                        currentRecord,
                        recoveredState
                      );
                      const retainedDraft = settledRecord.draft;
                      recoveryStore.current?.write(settledRecord);
                      await recoveryStore.current?.flush?.();
                      setRecoveredDraft(retainedDraft || null);
                      setRecoveryBlocked(false);
                      setStatus(
                        disposition === "failed" || disposition === "canceled"
                          ? `The previous chat launch ${disposition}; its draft is retained.`
                          : "Chat launch found; your draft is ready to continue."
                      );
                    }
                    router.replace(`/?chat=1&execution=${encodeURIComponent(execution.id)}`);
                    return;
                  }
                  if (execution.id !== initialExecutionId) throw new Error("Recovered send belongs to a different chat.");
                  if (disposition === "uncertain") {
                    setRecoveryBlocked(true);
                    setStatus("The previous continuation has an unconfirmed outcome.");
                    setError("Studio retained the draft and send identity. Review the runtime before starting another turn.");
                    return;
                  }
                  if (disposition === "failed" || disposition === "canceled") {
                    setRecoveryBlocked(false);
                    const preservedDraft = recoveryStore.current?.read()?.draft ?? operation.prompt;
                    recoveryStore.current?.write({ schemaVersion: 1, draft: preservedDraft });
                    setRecoveredDraft(preservedDraft);
                    setStatus(`The previous continuation ${disposition}. Its draft is retained.`);
                    return;
                  }
                  settleRecoveredSend(operation.prompt);
                  setRecoveryBlocked(false);
                  setStatus("Task accepted; reconnecting to its progress.");
                })
                .catch((cause) => {
                  if (!controller.signal.aborted) {
                    // An invalid state response is different from an unavailable
                    // lookup: a future command state must remain fail-closed.
                    // Network failures can still be retried explicitly with the
                    // retained idempotency identity.
                    const invalidRecoveryState =
                      cause instanceof Error && /invalid recovery state/i.test(cause.message);
                    setRecoveryBlocked(invalidRecoveryState);
                    setStatus("Previous send status could not be checked.");
                    setError(
                      invalidRecoveryState
                        ? "Studio retained the draft and send identity because the command state is not recognized. Check the runtime before retrying."
                        : "Retry the retained prompt to continue with the same send identity. The service will return the existing command or reject changed settings."
                    );
                  }
                });
            } else {
              setStatus("Previous send status is not confirmed.");
              setRecoveryBlocked(false);
              setError("Retry the retained prompt to continue with the same send identity; no message was sent again automatically.");
            }
          }
        }
        setAgents(library);
        setInstances(parseLaunchInstances(options));
        setLoaded(true);
        if (!recoveringPreviousSend) setStatus("");
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load agent settings."
          );
      });
    return () => controller.abort();
  }, [initialDraft, initialExecutionId, router, settleRecoveredSend]);

  const refresh = useCallback(
    async (id: string, signal: AbortSignal) => {
      const sequence = ++refreshSequence.current;
      const snapshot = parseRuntime(
        await managedRequest(`/${id}/runtime`, undefined, signal)
      );
      if (
        signal.aborted ||
        sequence !== refreshSequence.current ||
        !acceptRuntimeSnapshot(runtimeRef.current, snapshot)
      )
        return snapshot;
      runtimeRef.current = snapshot;
      setRuntime(snapshot);
      const state = await managedRequest(
        `/${id}/agent-state`,
        undefined,
        signal
      );
      if (signal.aborted || sequence !== refreshSequence.current)
        return snapshot;
      if (state.executionGeneration !== snapshot.execution.executionGeneration)
        return snapshot;
      setActivity(managedAgentActivity(state));
      setHistoryNotice(
        state.hasMore === true ? "Showing recent conversation history" : ""
      );
      if (
        !selectionDirty.current &&
        (typeof state.activeAgentId === "string" ||
          state.activeAgentId === null)
      )
        setActiveAgentId(state.activeAgentId);
      if (
        restoredExecution.current !== id &&
        !selectionDirty.current &&
        initialExecutionId === id
      ) {
        restoredExecution.current = id;
        const current = snapshot.execution;
        if (
          current.permissionMode === "supervised" ||
          current.permissionMode === "full_access"
        ) {
          setRestoreSelection({
            key: id,
            provider: current.provider,
            model: current.model,
            effort: current.reasoningEffort,
            permissionMode:
              current.permissionMode === "supervised" ? "ask" : "full"
          });
        } else {
          setError(
            "This conversation uses a permission mode not supported by this composer. Select a supported mode explicitly before sending."
          );
        }
      }
      if (Array.isArray(state.messages)) {
        const retained = state.messages.flatMap(
          (message): NewChatRuntimeMessage[] => {
            if (
              !record(message) ||
              typeof message.id !== "string" ||
              !["user", "assistant"].includes(String(message.role)) ||
              typeof message.content !== "string"
            )
              return [];
            const sourceAuthor = message.author;
            const author =
              record(sourceAuthor) &&
              typeof sourceAuthor.agentId === "string" &&
              typeof sourceAuthor.name === "string"
                ? {
                    agentId: sourceAuthor.agentId,
                    name: sourceAuthor.name,
                    avatar: parseAvatar(sourceAuthor.avatarReference)
                  }
                : null;
            return [
              {
                id: message.id,
                role: message.role as "user" | "assistant",
                content:
                  message.content +
                  (message.truncated === true ? "\n[Output truncated]" : ""),
                createdAt:
                  typeof message.createdAt === "string"
                    ? Date.parse(message.createdAt)
                    : 0,
                author
              }
            ];
          }
        );
        setMessages(retained);
      }
      const command = snapshot.latestCommand;
      const busy = Boolean(
        command?.commandKind === "prompt" &&
        !terminalCommands.has(command.state)
      );
      if (!operationRef.current) setSending(busy);
      setStatus(
        busy
          ? "Working"
          : snapshot.execution.state === "starting"
            ? "Starting the AI Client"
            : ""
      );
      if (command && ["failed", "indeterminate"].includes(command.state))
        setError(
          `The last task ${command.state === "indeterminate" ? "needs recovery" : "failed"}. ${command.lastErrorCode ?? "Check the runtime before retrying."}`
        );
      const pendingRecovery = recoveryStore.current?.read()?.pendingOperation;
      if (
        pendingRecovery &&
        command &&
        managedChatCommandMatchesPendingPrompt(
          pendingRecovery,
          command,
          snapshot.execution.executionGeneration
        )
      ) {
        // A mount-time lookup can race command persistence. Runtime is the
        // authoritative second check for this exact message identity.
        const disposition = managedChatRecoveryCommandDisposition(command.state);
        if (disposition === "uncertain") {
          setRecoveryBlocked(true);
          setStatus("The previous continuation has an unconfirmed outcome.");
          setError("Studio retained the draft and send identity because the runtime reported an unknown command state.");
        } else if (disposition === "failed" || disposition === "canceled") {
          const retainedDraft = recoveryStore.current?.read()?.draft ?? pendingRecovery.prompt;
          recoveryStore.current?.write({ schemaVersion: 1, draft: retainedDraft });
          setRecoveredDraft(retainedDraft);
          setRecoveryBlocked(false);
          setStatus(`The previous continuation ${disposition}. Its draft is retained.`);
          setError(null);
        } else {
          settleRecoveredSend(pendingRecovery.prompt);
          setRecoveryBlocked(false);
          setError(null);
          setStatus(
            disposition === "completed"
              ? "The previous continuation completed; its persisted state is shown."
              : "The previous continuation was accepted; reconnecting to its progress."
          );
        }
      }
      return snapshot;
    },
    [initialExecutionId, settleRecoveredSend]
  );

  const refreshRetainedWorkspaces = useCallback(
    async (id: string, signal?: AbortSignal) => {
      const sequence = ++retainedWorkspaceSequenceRef.current;
      try {
        const workspaces = await loadLocalRetainedWorkspaces(id, signal);
        if (
          signal?.aborted ||
          sequence !== retainedWorkspaceSequenceRef.current ||
          executionId !== id
        )
          return;
        setRetainedWorkspaceState({ executionId: id, workspaces, error: null });
      } catch (cause) {
        if (
          signal?.aborted ||
          sequence !== retainedWorkspaceSequenceRef.current ||
          executionId !== id
        )
          return;
        setRetainedWorkspaceState({
          executionId: id,
          workspaces: [],
          error:
            cause instanceof Error
              ? cause.message
              : "Retained workspace status is unavailable."
        });
      }
    },
    [executionId]
  );

  const applyProjectMoveState = useCallback(
    async (move: HostedProjectMove | null, signal?: AbortSignal) => {
      if (signal?.aborted) return;
      setLatestProjectMove(move);
      setProjectMoveLoaded(true);
      if (!move) return;
      const intentKey = moveNoticeIntentKey(move.executionId, move.id);
      try {
        if (move.state === "completed") {
          if (window.localStorage.getItem(intentKey) === "true") {
            dismissProjectMoveNotice();
          }
          window.localStorage.removeItem(intentKey);
        } else if (move.state === "cancelled" || move.state === "failed") {
          window.localStorage.removeItem(intentKey);
        }
      } catch {
        // The preference intent is optional and does not affect move state.
      }
      if (
        move.state !== "completed" ||
        refreshedCompletedMoveRef.current === move.id
      )
        return;
      refreshedCompletedMoveRef.current = move.id;
      if (lifecycle.current && !lifecycle.current.signal.aborted) {
        await refresh(move.executionId, signal ?? lifecycle.current.signal);
      }
      await refreshRetainedWorkspaces(
        move.executionId,
        signal ?? lifecycle.current?.signal
      );
      onProjectMoveCompleted?.();
    },
    [onProjectMoveCompleted, refresh, refreshRetainedWorkspaces]
  );

  const refreshProjectMove = useCallback(
    async (id: string, signal?: AbortSignal) => {
      const move = await loadLatestLocalProjectMove(id, signal);
      if (
        signal?.aborted ||
        executionId !== id ||
        projectMoveRequestInFlightRef.current
      )
        return;
      await applyProjectMoveState(move, signal);
    },
    [applyProjectMoveState, executionId]
  );

  useEffect(() => {
    if (!executionId || !loaded) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh(executionId, controller.signal);
        await refreshProjectMove(executionId, controller.signal);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Connection lost.");
          setStatus("Connection unavailable; task state is unverified");
          setActivity((current) =>
            current ? { ...current, state: "unknown" } : current
          );
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2500);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [executionId, loaded, refresh, refreshProjectMove]);

  useEffect(() => {
    if (!executionId || !loaded) return;
    void refreshRetainedWorkspaces(executionId);
    return () => {
      retainedWorkspaceSequenceRef.current += 1;
    };
  }, [executionId, loaded, refreshRetainedWorkspaces]);

  const openProjectMove = () => {
    const current = runtimeRef.current?.execution;
    if (!PROJECT_MOVE_UI_ENABLED || !current || current.provider !== "codex")
      return;
    if (
      current.state !== "running" ||
      commandInFlight ||
      operationRef.current ||
      moveInFlight
    ) {
      setStatus(
        "Move is available only when this Codex Conversation is idle and running."
      );
      return;
    }
    const destinations = registeredProjects.filter(
      (project) =>
        isRegisteredProjectId(project.id) && project.id !== current.projectId
    );
    if (!destinations.length) {
      setStatus("No other registered Projects are available in this Studio.");
      return;
    }
    setProjectMoveDestinationId(destinations[0]?.id ?? "");
    setProjectMovePickerOpen(true);
  };

  const submitProjectMove = async (
    dontShowAgain: boolean
  ): Promise<"completed" | "pending"> => {
    const current = runtimeRef.current?.execution;
    if (!current || !projectMoveDestinationId) {
      throw new Error("Choose a registered destination Project first.");
    }
    projectMoveRequestInFlightRef.current = true;
    try {
      const move = await requestLocalProjectMove(
        current,
        projectMoveDestinationId,
        crypto.randomUUID()
      );
      if (runtimeRef.current?.execution.id !== current.id) {
        throw new Error(
          "The selected Conversation changed before the Move was accepted."
        );
      }
      if (dontShowAgain && shouldKeepProjectMoveNoticeIntent(move.state)) {
        try {
          window.localStorage.setItem(
            moveNoticeIntentKey(move.executionId, move.id),
            "true"
          );
        } catch {
          // Keep the accepted move even if this installation cannot store intent.
        }
      }
      await applyProjectMoveState(move, lifecycle.current?.signal);
      if (move.state === "failed" || move.state === "cancelled") {
        throw new Error(
          "The assigned computer could not complete this Project Move."
        );
      }
      return move.state === "completed" ? "completed" : "pending";
    } finally {
      projectMoveRequestInFlightRef.current = false;
    }
  };

  const cancelProjectMove = async () => {
    const current = runtimeRef.current?.execution;
    if (!current || !latestProjectMove || latestProjectMove.state !== "pending")
      return;
    setProjectMoveBusy(true);
    try {
      const move = await cancelLocalProjectMove(
        current,
        latestProjectMove.id,
        lifecycle.current?.signal
      );
      await applyProjectMoveState(move, lifecycle.current?.signal);
      setStatus(
        move.state === "cancelled"
          ? "Pending Project Move canceled."
          : move.state === "claimed" || move.state === "completed"
            ? "The assigned computer claimed the Move before cancellation; showing its current state."
            : "The Project Move remains pending."
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not cancel the Project Move."
      );
    } finally {
      setProjectMoveBusy(false);
    }
  };

  const openRetainedWorkspace = async (workspace: LocalRetainedWorkspace) => {
    if (
      !executionId ||
      !workspace.available ||
      workspace.moveId === openingRetainedWorkspaceId
    )
      return;
    setOpeningRetainedWorkspaceId(workspace.moveId);
    try {
      await openLocalRetainedWorkspace(
        executionId,
        workspace.moveId,
        lifecycle.current?.signal
      );
      setRetainedWorkspaceState((current) =>
        current?.executionId === executionId
          ? { ...current, error: null }
          : current
      );
    } catch (cause) {
      setRetainedWorkspaceState((current) =>
        current?.executionId === executionId
          ? {
              ...current,
              error:
                cause instanceof Error
                  ? cause.message
                  : "Koed could not open this retained workspace."
            }
          : current
      );
    } finally {
      setOpeningRetainedWorkspaceId(null);
    }
  };

  const deleteRetainedManagedWorktree = async () => {
    const workspace = retainedWorkspaceToDelete;
    if (!executionId || !workspace?.deletable || deletingRetainedWorkspace)
      return;
    setDeletingRetainedWorkspace(true);
    try {
      await deleteLocalRetainedManagedWorktree(
        executionId,
        workspace.moveId,
        lifecycle.current?.signal
      );
      setRetainedWorkspaceToDelete(null);
      await refreshRetainedWorkspaces(executionId, lifecycle.current?.signal);
    } catch (cause) {
      setRetainedWorkspaceState((current) =>
        current?.executionId === executionId
          ? {
              ...current,
              error:
                cause instanceof Error
                  ? cause.message
                  : "Koed could not delete this managed worktree."
            }
          : current
      );
      setRetainedWorkspaceToDelete(null);
    } finally {
      setDeletingRetainedWorkspace(false);
    }
  };

  const send = async (text: string, selection: ChatComposerSelection) => {
    if (operationRef.current)
      throw new Error("A submission is already in progress.");
    const signal = lifecycle.current?.signal;
    if (!signal || signal.aborted)
      throw new Error("The chat is no longer active.");
    if (!recoveryStore.current)
      throw new Error("Studio could not establish device recovery for this chat. Nothing was sent.");
    operationRef.current = true;
    setSending(true);
    setError(null);
    const startedNewExecution = !executionId;
    let navigableExecutionId: string | null = executionId;
    try {
      const selected = agents.find(
        (agent) =>
          agent.id === selection.agentId && agent.lifecycle === "active"
      );
      if (!selected)
        throw new Error("Choose an available agent before sending.");
      const latestOptions = parseLaunchInstances(
        await managedRequest("/launch-options", undefined, signal)
      );
      setInstances(latestOptions);
      const settings = resolveLaunchSelection(selection, latestOptions);
      const recoveryRecord = recoveryStore.current?.read() ?? null;
      const recovered = recoveryRecord?.pendingOperation;
      const operationExecutionId = executionId ?? pending.current?.executionId ?? null;
      const operationKind = operationExecutionId ? "prompt" : "start";
      const knownExecution =
        operationExecutionId && runtimeRef.current?.execution.id === operationExecutionId
          ? runtimeRef.current.execution
          : null;
      const requestFingerprint = managedChatSendRequestFingerprint({
        kind: operationKind,
        projectId: projectId ?? null,
        executionId: operationExecutionId,
        executionGeneration: knownExecution?.executionGeneration ?? null,
        agentId: selected.id,
        agentVersion: selected.currentVersion,
        provider: settings.provider,
        aiClientInstanceId: settings.aiClientInstanceId,
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
        permissionMode: settings.permissionMode,
        expectedSettings: knownExecution
          ? {
              model: knownExecution.model,
              reasoningEffort: knownExecution.reasoningEffort,
              permissionMode: knownExecution.permissionMode
            }
          : null
      });
      const key = requestFingerprint;
      const reusableIdentity = reusableManagedChatSendIdentity(
        recoveryRecord,
        text,
        requestFingerprint
      );
      const persistedRequestFingerprint =
        recovered && recovered.requestFingerprint === undefined
          ? undefined
          : requestFingerprint;
      if (
        recovered &&
        (recovered.state === "pending" || recovered.state === "reconciling") &&
        !reusableIdentity
      ) {
        throw new Error("Studio has not confirmed the previous send. Restore its original prompt, Project, Agent, model, and permission settings before retrying.");
      }
      if (reusableIdentity) {
        pending.current = {
          key,
          id: reusableIdentity.promptIdempotencyKey,
          messageId: reusableIdentity.clientUserMessageId,
          startId: reusableIdentity.startIdempotencyKey,
          ...(executionId ? { executionId } : {})
        };
      }
      if (!pending.current || pending.current.key !== key)
        pending.current = {
          key,
          id: crypto.randomUUID(),
          messageId: crypto.randomUUID(),
          startId: crypto.randomUUID()
        };
      const request = pending.current;
      recoveryStore.current?.write({
        schemaVersion: 1,
        draft: latestDraft.current !== text ? latestDraft.current : text,
        pendingOperation: {
          kind: executionId || request.executionId ? "prompt" : "start",
          startIdempotencyKey: request.startId,
          promptIdempotencyKey: request.id,
          clientUserMessageId: request.messageId,
          ...(executionId && runtimeRef.current?.execution.executionGeneration !== undefined
            ? { executionGeneration: runtimeRef.current.execution.executionGeneration }
            : {}),
          prompt: text,
          ...(persistedRequestFingerprint
            ? { requestFingerprint: persistedRequestFingerprint }
            : {}),
          state: "pending"
        }
      });
      // The idempotency keys must be durable before the first request can
      // reach the runner; otherwise a process exit could permit a duplicate.
      try {
        await recoveryStore.current?.flush?.();
      } catch {
        throw new Error("Studio could not save the send identity on this device. Nothing was sent; try again.");
      }
      let id = executionId ?? request.executionId;
      if (!id) {
        setStatus("Starting the AI Client");
        const started = await managedRequest(
          "",
          {
            ...settings,
            projectId: projectId ?? null,
            contextKind: projectId ? "project" : "independent",
            runnerKind: "local_device",
            idempotencyKey: request.startId
          },
          signal
        );
        const execution = parseExecution(started.execution);
        id = execution.id;
        navigableExecutionId = id;
        request.executionId = id;
        setExecutionId(id);
        const previousStore = recoveryStore.current;
        const executionStore = activeRecoveryStore(id);
        if (executionStore) {
          const oldRecord = previousStore?.read();
          if (oldRecord) executionStore.write(oldRecord);
          await executionStore.flush?.();
          previousStore?.clear();
          recoveryStore.current = executionStore;
        }
      }
      let snapshot = parseRuntime(
        await managedRequest(`/${id}/runtime`, undefined, signal)
      );
      const deadline = Date.now() + 60000;
      while (snapshot.execution.state === "starting" && Date.now() < deadline) {
        await delay(1000, signal);
        snapshot = parseRuntime(
          await managedRequest(`/${id}/runtime`, undefined, signal)
        );
      }
      if (
        snapshot.latestCommand?.commandKind === "prompt" &&
        snapshot.latestCommand.clientUserMessageId === request.messageId
      ) {
        if (snapshot.latestCommand.state === "indeterminate") {
          setRecoveryBlocked(true);
          throw new Error("The previous continuation has an uncertain outcome. Its draft and send identity are retained; review the runtime before another turn.");
        }
        if (["failed", "canceled"].includes(snapshot.latestCommand.state)) {
          pending.current = null;
          const preservedDraft = recoveryStore.current?.read()?.draft ?? latestDraft.current;
          recoveryStore.current?.write({ schemaVersion: 1, draft: preservedDraft });
          setRecoveredDraft(preservedDraft);
          throw new Error(`The previous continuation ${snapshot.latestCommand.state}. Its draft is retained.`);
        }
        pending.current = null;
        settleRecoveredSend(text);
        setError(null);
        setStatus(
          snapshot.latestCommand.state === "canceled"
            ? "The continuation was canceled."
            : "Task already accepted; reconnecting to its progress."
        );
        try {
          await refresh(id, signal);
        } catch {
          // Runtime status will be reconciled on the next periodic refresh.
        }
        if (startedNewExecution)
          router.replace(`/?chat=1&execution=${encodeURIComponent(id)}`);
        return;
      }
      if (snapshot.execution.state !== "running")
        throw new Error(
          "The AI Client is not ready. Your draft is retained; retry after it becomes available."
        );
      if (
        snapshot.latestCommand?.commandKind === "prompt" &&
        !terminalCommands.has(snapshot.latestCommand.state)
      )
        throw new Error(
          "A task is still in progress. Wait or interrupt it before sending another."
        );
      if (
        snapshot.execution.provider !== settings.provider ||
        snapshot.execution.aiClientInstanceId !== settings.aiClientInstanceId
      ) {
        throw new Error(
          "This conversation is bound to a different AI Client. Start a new chat to use that provider; no fallback was applied."
        );
      }
      const current = snapshot.execution;
      const exactRequestFingerprint = managedChatSendRequestFingerprint({
        kind: "prompt",
        projectId: projectId ?? null,
        executionId: id,
        executionGeneration: current.executionGeneration,
        agentId: selected.id,
        agentVersion: selected.currentVersion,
        provider: settings.provider,
        aiClientInstanceId: settings.aiClientInstanceId,
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
        permissionMode: settings.permissionMode,
        expectedSettings: {
          model: current.model,
          reasoningEffort: current.reasoningEffort,
          permissionMode: current.permissionMode
        }
      });
      if (
        recovered &&
        (recovered.state === "pending" || recovered.state === "reconciling") &&
        recovered.requestFingerprint !== undefined &&
        recovered.requestFingerprint !== exactRequestFingerprint
      ) {
        throw new Error("The previous send settings no longer match this conversation. Its identity is retained; restore the original settings before retrying.");
      }
      const expected = {
        model: current.model,
        reasoningEffort: current.reasoningEffort,
        permissionMode: current.permissionMode
      };
      const next = {
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
        permissionMode: settings.permissionMode
      };
      recoveryStore.current?.write({
        schemaVersion: 1,
        draft: latestDraft.current !== text ? latestDraft.current : text,
        pendingOperation: {
          kind: "prompt",
          startIdempotencyKey: request.startId,
          promptIdempotencyKey: request.id,
          clientUserMessageId: request.messageId,
          executionGeneration: current.executionGeneration,
          prompt: text,
          ...(persistedRequestFingerprint
            ? { requestFingerprint: exactRequestFingerprint }
            : {}),
          state: "pending"
        }
      });
      try {
        await recoveryStore.current?.flush?.();
      } catch {
        throw new Error("Studio could not save the send identity on this device. Nothing was sent; try again.");
      }
      const result = await managedRequest(
        `/${id}/prompts`,
        {
          executionGeneration: current.executionGeneration,
          idempotencyKey: request.id,
          clientUserMessageId: request.messageId,
          prompt: text,
          agentId: selected.id,
          expectedAgentVersion: selected.currentVersion,
          ...(JSON.stringify(expected) === JSON.stringify(next)
            ? {}
            : { settingsChange: { expected, next } })
        },
        signal
      );
      if (!record(result.command) || typeof result.command.id !== "string")
        throw new Error(
          "The task was not confirmed. Retry with the same draft."
        );
      pending.current = null;
      settleRecoveredSend(text);
      setError(null);
      selectionDirty.current = false;
      setStatus("Task queued");
      // An accepted command must not become a failed submission just because its status refresh failed.
      try {
        await refresh(id, signal);
      } catch {
        if (!signal.aborted)
          setStatus("Task accepted; reconnecting to its progress");
      }
      if (startedNewExecution)
        router.replace(`/?chat=1&execution=${encodeURIComponent(id)}`);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Unable to send the task.";
      if (!signal.aborted) {
        const existing = recoveryStore.current?.read();
        if (existing?.pendingOperation) {
          recoveryStore.current?.write({
            ...existing,
            pendingOperation: {
              ...existing.pendingOperation,
              state: "reconciling"
            }
          });
        }
        setError(message);
        setStatus("");
        if (startedNewExecution && navigableExecutionId)
          router.replace(`/?chat=1&execution=${encodeURIComponent(navigableExecutionId)}`);
      }
      throw cause;
    } finally {
      operationRef.current = false;
      const command = runtimeRef.current?.latestCommand;
      if (!signal.aborted)
        setSending(
          Boolean(
            command?.commandKind === "prompt" &&
            !terminalCommands.has(command.state)
          )
        );
    }
  };

  const interrupt = async () => {
    if (
      !runtime ||
      !executionId ||
      !managedConversationControls(runtime.latestCommand).canInterrupt
    ) return;
    try {
      await managedRequest(`/${executionId}/interrupt`, {
        executionGeneration: runtime.execution.executionGeneration,
        idempotencyKey: crypto.randomUUID()
      });
      setStatus("Cancellation requested");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Cancellation was not confirmed."
      );
    }
  };
  const cancelPendingPrompt = async () => {
    const latest = runtime?.latestCommand;
    if (
      !runtime ||
      !executionId ||
      !latest ||
      latest.commandKind !== "prompt" ||
      !["queued", "pending"].includes(latest.state)
    ) return;
    try {
      const result = await managedRequest(
        `/${executionId}/prompts/${latest.id}/cancel`,
        { executionGeneration: runtime.execution.executionGeneration }
      );
      const command = record(result.command) ? result.command : null;
      const state = command && typeof command.state === "string" ? command.state : "unknown";
      if (state === "canceled") {
        setStatus("Pending continuation canceled.");
        setSending(false);
      } else {
        setStatus(
          `The continuation was not canceled (state: ${state}). If the turn has started, use Stop to interrupt it.`
        );
      }
      await refresh(executionId, lifecycle.current?.signal ?? new AbortController().signal);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not cancel the pending continuation.");
    }
  };
  const endSession = async () => {
    if (!runtime || !executionId) return;
    try {
      await managedRequest(`/${executionId}/stop`, {
        executionGeneration: runtime.execution.executionGeneration,
        idempotencyKey: crypto.randomUUID()
      });
      setStatus("End session accepted · waiting for the runner to finish.");
      const updated = await refresh(
        executionId,
        lifecycle.current?.signal ?? new AbortController().signal
      );
      if (updated.execution.state === "stopped") {
        setStatus("Session ended.");
        setSending(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Session end was not confirmed.");
    }
  };
  const chooseAgent = (id: string | null) => {
    selectionDirty.current = true;
    setActiveAgentId(id);
  };
  const requests = pendingChatRequests(runtime);
  const currentExecution = runtime?.execution ?? null;
  const currentProjectId = currentExecution?.projectId ?? null;
  const currentProjectName = registeredProjects.find(
    (project) => project.id === currentProjectId
  )?.name;
  const moveInFlight = Boolean(
    latestProjectMove &&
    latestProjectMove.executionId === executionId &&
    (latestProjectMove.state === "pending" ||
      latestProjectMove.state === "claimed")
  );
  const commandInFlight = Boolean(
    runtime?.latestCommand &&
    !["completed", "failed", "canceled"].includes(runtime.latestCommand.state)
  );
  const { canCancelPendingPrompt, canInterrupt } = managedConversationControls(
    runtime?.latestCommand ?? null
  );
  const moveUnavailableReason = currentExecution
    ? currentExecution.provider !== "codex"
      ? "Project Move is unavailable for this AI Client; only verified Codex Conversations can move."
      : currentExecution.state !== "running"
        ? "Project Move is available only for a running managed Conversation."
        : commandInFlight || sending
          ? "Wait for the active task to finish before moving this Conversation."
          : moveInFlight
            ? "A Project Move is already pending for this Conversation."
            : null
    : null;

  useEffect(() => {
    const target = sidebarMoveTarget;
    if (!target || handledSidebarMoveRequestRef.current === target.requestId)
      return;
    const execution = runtimeRef.current?.execution;
    if (!execution || execution.id !== target.executionId) return;
    if (!projectMoveLoaded) return;
    handledSidebarMoveRequestRef.current = target.requestId;
    const finish = (message?: string) => {
      if (message) setStatus(message);
      onSidebarMoveTargetHandled?.(target.requestId);
    };
    if (execution.provider !== "codex") {
      finish("Only Codex managed Conversations can move between Projects.");
      return;
    }
    if (
      execution.state !== "running" ||
      commandInFlight ||
      operationRef.current ||
      moveInFlight
    ) {
      finish("This Conversation is busy or stopped; no Move was started.");
      return;
    }
    if (
      !isRegisteredProjectId(target.destinationProjectId) ||
      target.destinationProjectId === execution.projectId ||
      !registeredProjects.some(
        (project) => project.id === target.destinationProjectId
      )
    ) {
      finish("The dropped destination is not a different registered Project.");
      return;
    }
    setProjectMoveDestinationId(target.destinationProjectId);
    setProjectMovePickerOpen(false);
    setProjectMoveDialogOpen(true);
    finish();
  }, [
    commandInFlight,
    moveInFlight,
    onSidebarMoveTargetHandled,
    projectMoveLoaded,
    registeredProjects,
    runtime,
    sidebarMoveTarget
  ]);
  const respond = async (
    id: string,
    response:
      | { decision: "accept" | "decline" }
      | { answers: Record<string, string[]> }
  ) => {
    const request = requests.find((item) => item.id === id);
    if (!request || !runtime || !executionId)
      throw new Error("This request is no longer active.");
    await managedRequest(
      `/${executionId}/runtime-items/${id}/respond`,
      {
        kind: request.kind,
        executionGeneration: runtime.execution.executionGeneration,
        ...response
      },
      lifecycle.current?.signal
    );
    try {
      if (lifecycle.current)
        await refresh(executionId, lifecycle.current.signal);
    } catch {
      setStatus("Response accepted; reconnecting to progress");
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      {currentExecution ? (
        <section
          aria-label="Managed Conversation Project"
          className="shrink-0 border-b border-border bg-surface/70 px-4 py-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-auto text-[11px] text-muted">
              Current Project:{" "}
              {currentProjectId
                ? (currentProjectName ?? "Project")
                : "Standalone"}
            </p>
            {latestProjectMove?.executionId === currentExecution.id ? (
              <span role="status" className="text-[11px] text-muted">
                Project Move{" "}
                {latestProjectMove.state === "pending"
                  ? "Pending on assigned computer"
                  : latestProjectMove.state === "claimed"
                    ? "claimed by assigned computer"
                    : latestProjectMove.state === "completed"
                      ? "completed"
                      : latestProjectMove.state}
              </span>
            ) : null}
            <button
              type="button"
              onClick={openProjectMove}
              disabled={
                !PROJECT_MOVE_UI_ENABLED ||
                currentExecution.provider !== "codex" ||
                currentExecution.state !== "running" ||
                !projectMoveLoaded ||
                projectMoveBusy ||
                moveInFlight ||
                sending ||
                commandInFlight
              }
              title={moveUnavailableReason ?? undefined}
              className="rounded-md border border-border px-2 py-1 text-[11px] text-foreground-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              Move to Project
            </button>
            {latestProjectMove?.executionId === currentExecution.id &&
            latestProjectMove.state === "pending" ? (
              <button
                type="button"
                onClick={() => void cancelProjectMove()}
                disabled={projectMoveBusy}
                className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-surface-hover disabled:opacity-50"
              >
                Cancel Pending Move
              </button>
            ) : null}
          </div>
          {moveUnavailableReason ? (
            <p role="note" className="mt-1 text-[10px] leading-4 text-muted">
              {moveUnavailableReason} If Move succeeds, source edits stay in the
              source Project; if they cannot be safely retained, the Move fails
              and the original context remains unchanged.
            </p>
          ) : null}
          {retainedWorkspaceState?.executionId === currentExecution.id &&
          (retainedWorkspaceState.workspaces.length > 0 ||
            retainedWorkspaceState.error) ? (
            <div className="mt-2 border-t border-border/70 pt-2">
              {retainedWorkspaceState.workspaces.map((workspace) => (
                <div
                  key={workspace.moveId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1"
                >
                  <span className="shrink-0 text-[10px] font-medium text-foreground-secondary">
                    Retained workspace
                  </span>
                  <code
                    className={
                      workspace.available
                        ? "min-w-0 flex-1 truncate text-[10px] text-muted"
                        : "min-w-0 flex-1 truncate text-[10px] text-subtle line-through"
                    }
                    title={workspace.sourcePath}
                  >
                    {workspace.sourcePath}
                  </code>
                  {!workspace.available ? (
                    <span className="shrink-0 text-[10px] text-subtle">
                      Unavailable
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void openRetainedWorkspace(workspace)}
                    disabled={
                      !workspace.available ||
                      openingRetainedWorkspaceId === workspace.moveId
                    }
                    title={
                      workspace.available
                        ? "Open retained workspace folder"
                        : "This retained workspace is no longer available on this computer."
                    }
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-foreground-secondary hover:bg-surface-hover disabled:opacity-50"
                  >
                    <FolderOpen className="h-3 w-3" />
                    {!workspace.available
                      ? "Unavailable"
                      : openingRetainedWorkspaceId === workspace.moveId
                        ? "Opening…"
                        : "Open folder"}
                  </button>
                  {workspace.deletable ? (
                    <button
                      type="button"
                      onClick={() => setRetainedWorkspaceToDelete(workspace)}
                      className="shrink-0 rounded-md border border-border px-2 py-1 text-[10px] text-foreground-secondary hover:bg-surface-hover"
                    >
                      Delete worktree…
                    </button>
                  ) : null}
                  <span className="basis-full text-[10px] text-subtle">
                    {workspace.reason}
                  </span>
                </div>
              ))}
              {retainedWorkspaceState.error ? (
                <p role="status" className="py-1 text-[10px] text-muted">
                  {retainedWorkspaceState.error}
                </p>
              ) : null}
            </div>
          ) : null}
          {projectMovePickerOpen ? (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="text-[10px] text-muted">
                Destination Project
                <select
                  value={projectMoveDestinationId}
                  onChange={(event) =>
                    setProjectMoveDestinationId(event.target.value)
                  }
                  className="mt-1 block min-w-44 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                >
                  {registeredProjects
                    .filter(
                      (project) =>
                        isRegisteredProjectId(project.id) &&
                        project.id !== currentProjectId
                    )
                    .map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => setProjectMoveDialogOpen(true)}
                disabled={
                  !registeredProjects.some(
                    (project) => project.id === projectMoveDestinationId
                  ) || projectMoveBusy
                }
                className="rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-medium text-accent-foreground disabled:opacity-50"
              >
                Review Move
              </button>
              <button
                type="button"
                onClick={() => setProjectMovePickerOpen(false)}
                className="rounded-md px-2 py-1.5 text-[11px] text-muted hover:bg-surface-hover"
              >
                Cancel
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
      <div className="min-h-0 flex-1">
        <NewChatView
          mode="live"
          initialDraft={initialDraft}
          initialSelection={initialSelection}
          projectName={
            projectId ? (projectName ?? "Project chat") : "Standalone chat"
          }
          activity={activity}
          agents={agents}
          activeAgentId={activeAgentId}
          onActiveAgentChange={chooseAgent}
          onAgentMention={chooseAgent}
          modelOptions={instances.flatMap((instance) => instance.models)}
          runtime={{
            enabled:
              loaded &&
              instances.length > 0 &&
              !recoveryBlocked &&
              !failedExecutions.has(runtime?.execution.state ?? ""),
            messages,
            isSending: sending,
            error,
            status: [status, historyNotice].filter(Boolean).join(" · "),
            onSend: send,
            onInterrupt: () => void interrupt(),
            canInterrupt,
            canCancelPendingPrompt,
            onCancelPendingPrompt: canCancelPendingPrompt
              ? () => void cancelPendingPrompt()
              : undefined,
            onEndSession: currentExecution
              ? () => void endSession()
              : undefined,
            restoreSelection,
            pendingRequests: requests,
            onRespond: respond
          }}
          recoveredDraft={recoveredDraft}
          onDraftChange={(draft) => {
            latestDraft.current = draft;
            persistDraft(draft);
          }}
        />
      </div>
      {projectMoveDialogOpen &&
      currentExecution &&
      registeredProjects.some(
        (project) => project.id === projectMoveDestinationId
      ) ? (
        <ProjectMoveConfirmation
          threadTitle={currentExecution.model}
          projectName={
            registeredProjects.find(
              (project) => project.id === projectMoveDestinationId
            )?.name ?? "Project"
          }
          sourceEditStatus="unknown"
          onMove={submitProjectMove}
          onCancel={() => {
            setProjectMoveDialogOpen(false);
            setProjectMovePickerOpen(false);
          }}
        />
      ) : null}
      {retainedWorkspaceToDelete ? (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm no-drag">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="retained-worktree-delete-title"
            className="w-[400px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
          >
            <div className="px-5 py-4">
              <h2
                id="retained-worktree-delete-title"
                className="text-base font-semibold text-foreground"
              >
                Delete retained worktree?
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                This deletes the Koed-managed temporary worktree and its
                uncommitted files from this computer. The Conversation and its
                current Project stay in place.
              </p>
              <code className="mt-3 block break-all text-xs text-foreground-secondary">
                {retainedWorkspaceToDelete.sourcePath}
              </code>
            </div>
            <div className="flex justify-end gap-2 border-t border-border bg-background/40 px-5 py-3">
              <button
                type="button"
                disabled={deletingRetainedWorkspace}
                onClick={() => setRetainedWorkspaceToDelete(null)}
                className="rounded-md px-3.5 py-2 text-sm font-medium text-foreground-secondary hover:bg-surface-hover disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deletingRetainedWorkspace}
                onClick={() => void deleteRetainedManagedWorktree()}
                className="rounded-md bg-chip px-4 py-2 text-sm font-medium text-chip-foreground hover:bg-white disabled:opacity-50"
              >
                {deletingRetainedWorkspace ? "Deleting…" : "Delete worktree"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
