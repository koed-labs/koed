"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, RefreshCw, Send, Square, X } from "lucide-react";
import {
  cancelHostedProjectMove,
  cancelHostedQueuedPrompt,
  cancelHostedConversationStart,
  HostedManagedChatError,
  loadLatestHostedProjectMove,
  listHostedManagedConversations,
  loadHostedLaunchOptions,
  loadHostedManagedConversation,
  queueHostedConversationPrompt,
  requestHostedProjectMove,
  requestHostedConversationControl,
  startHostedManagedConversation,
  type HostedLaunchOptions,
  type HostedConversationMessage,
  type HostedManagedExecution,
  type HostedProjectMove
} from "@/lib/hosted-managed-chats";
import type { RuntimeSnapshot } from "@/lib/managed-agent-chat";
import { ProjectMoveConfirmation } from "@/components/ProjectMoveConfirmation";
import {
  dismissProjectMoveNotice,
  shouldKeepProjectMoveNoticeIntent
} from "@/lib/project-move-preference";

// Keep false until the runner context transition has passed end-to-end validation.
const PROJECT_MOVE_UI_ENABLED = false;

const moveNoticeIntentKey = (executionId: string, moveId: string) =>
  `koed.studio.project-move-dismiss-intent:${executionId}:${moveId}`;
const isRegisteredProjectId = (value: string) =>
  /^lp_[0-9a-f]{32}$/iu.test(value);

const terminalCommands = new Set([
  "completed",
  "failed",
  "canceled",
  "indeterminate"
]);

type PendingMessage = HostedConversationMessage & {
  commandId: string;
  commandState: string;
};

const stateLabel = (execution: HostedManagedExecution) => {
  if (execution.state === "running") return "Running";
  if (execution.state === "starting") return "Starting";
  if (execution.state === "stopped") return "Stopped";
  if (execution.state === "failed") return "Failed";
  return execution.state.replaceAll("_", " ");
};

export function HostedManagedChats({
  onAuthorizationLost
}: {
  onAuthorizationLost: () => void;
}) {
  const [executions, setExecutions] = useState<HostedManagedExecution[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [messages, setMessages] = useState<HostedConversationMessage[]>([]);
  const [pendingMessage, setPendingMessage] = useState<PendingMessage | null>(
    null
  );
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [launchOptions, setLaunchOptions] =
    useState<HostedLaunchOptions | null>(null);
  const [launchLoading, setLaunchLoading] = useState(false);
  const [launchProjectId, setLaunchProjectId] = useState("");
  const [launchDeviceId, setLaunchDeviceId] = useState("");
  const [launchInstanceId, setLaunchInstanceId] = useState("");
  const [launchModelId, setLaunchModelId] = useState("");
  const [launchEffort, setLaunchEffort] = useState("");
  const [launchPermission, setLaunchPermission] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [latestProjectMove, setLatestProjectMove] =
    useState<HostedProjectMove | null>(null);
  const [projectMoveLoaded, setProjectMoveLoaded] = useState(false);
  const [projectMoveBusy, setProjectMoveBusy] = useState(false);
  const [projectMovePickerOpen, setProjectMovePickerOpen] = useState(false);
  const [projectMoveDialogOpen, setProjectMoveDialogOpen] = useState(false);
  const [projectMoveDestinationId, setProjectMoveDestinationId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const authLost = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const refreshedCompletedMoveRef = useRef<string | null>(null);
  const projectMoveRequestInFlightRef = useRef(false);

  const handleError = useCallback(
    (cause: unknown) => {
      if (cause instanceof HostedManagedChatError && cause.status === 401) {
        setExecutions([]);
        selectedIdRef.current = null;
        setSelectedId(null);
        setRuntime(null);
        setMessages([]);
        setPendingMessage(null);
        setDraft("");
        setLaunchOptions(null);
        setLaunchProjectId("");
        setLaunchDeviceId("");
        setLaunchInstanceId("");
        setLaunchModelId("");
        setInitialPrompt("");
        setLatestProjectMove(null);
        setProjectMoveLoaded(false);
        setProjectMoveDialogOpen(false);
        setProjectMovePickerOpen(false);
        if (!authLost.current) {
          authLost.current = true;
          onAuthorizationLost();
        }
        return;
      }
      setError(
        cause instanceof Error ? cause.message : "Conversation request failed."
      );
    },
    [onAuthorizationLost]
  );

  const refreshList = useCallback(async (signal?: AbortSignal) => {
    const values = await listHostedManagedConversations(signal);
    if (signal?.aborted) return;
    setExecutions(values);
    const current = selectedIdRef.current;
    const next =
      current && values.some((item) => item.id === current)
        ? current
        : (values[0]?.id ?? null);
    if (next !== current) {
      selectedIdRef.current = next;
      setSelectedId(next);
      setRuntime(null);
      setMessages([]);
      setPendingMessage(null);
      setStatus(null);
      setLatestProjectMove(null);
      setProjectMoveLoaded(false);
      setProjectMoveDialogOpen(false);
      setProjectMovePickerOpen(false);
    }
  }, []);

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
        // Preference intent storage is optional; it never changes move state.
      }

      if (
        move.state !== "completed" ||
        refreshedCompletedMoveRef.current === move.id
      )
        return;
      refreshedCompletedMoveRef.current = move.id;
      await refreshList(signal);
      const value = await loadHostedManagedConversation(
        move.executionId,
        signal
      );
      if (signal?.aborted || selectedIdRef.current !== move.executionId) return;
      setRuntime(value.runtime);
      setMessages(value.state.messages);
    },
    [refreshList]
  );

  const refreshProjectMove = useCallback(
    async (executionId: string, signal?: AbortSignal) => {
      const move = await loadLatestHostedProjectMove(executionId, signal);
      if (
        signal?.aborted ||
        selectedIdRef.current !== executionId ||
        projectMoveRequestInFlightRef.current
      )
        return;
      await applyProjectMoveState(move, signal);
    },
    [applyProjectMoveState]
  );

  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        await refreshList(controller.signal);
        setError(null);
      } catch (cause) {
        if (!controller.signal.aborted) handleError(cause);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [handleError, refreshList]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    let timeout = 0;
    const poll = async () => {
      try {
        const value = await loadHostedManagedConversation(
          selectedId,
          controller.signal
        );
        if (controller.signal.aborted || selectedIdRef.current !== selectedId)
          return;
        setRuntime(value.runtime);
        setMessages(value.state.messages);
        setError(null);
        setStatus(null);
        setPendingMessage((pending) =>
          pending &&
          value.state.messages.some((message) => message.id === pending.id)
            ? null
            : pending
        );
        await refreshProjectMove(selectedId, controller.signal);
      } catch (cause) {
        if (!controller.signal.aborted && selectedIdRef.current === selectedId)
          handleError(cause);
      }
      if (!controller.signal.aborted && selectedIdRef.current === selectedId)
        timeout = window.setTimeout(poll, 2500);
    };
    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [handleError, refreshProjectMove, selectedId]);

  const selected = useMemo(
    () => executions.find((execution) => execution.id === selectedId) ?? null,
    [executions, selectedId]
  );
  const selectedRuntime = runtime?.execution.id === selectedId ? runtime : null;
  const latestCommand = selectedRuntime?.latestCommand;
  const activePrompt = Boolean(
    latestCommand?.commandKind === "prompt" &&
    !terminalCommands.has(latestCommand.state)
  );
  const pendingControl = Boolean(
    (latestCommand?.commandKind === "stop" ||
      latestCommand?.commandKind === "interrupt") &&
    ["queued", "blocked", "dispatching"].includes(latestCommand.state)
  );
  const canSend =
    selectedRuntime?.execution.state === "running" &&
    !activePrompt &&
    !pendingControl;
  const canInterrupt = selectedRuntime?.execution.state === "running";
  const canStop = selectedRuntime?.execution.state === "running";
  const canCancelQueuedPrompt =
    latestCommand?.commandKind === "prompt" && latestCommand.state === "queued";
  const pendingStart =
    latestCommand?.commandKind === "start" &&
    ["blocked", "queued"].includes(latestCommand.state);
  const pendingPrompt =
    latestCommand?.commandKind === "prompt" &&
    ["queued", "blocked"].includes(latestCommand.state);
  const canCancelStart = pendingStart;
  const launchInstance = launchOptions?.instances.find(
    (item) => item.instanceId === launchInstanceId
  );
  const launchModel = launchInstance?.models.find(
    (model) => model.id === launchModelId
  );
  const launchReasoningEffortValid = Boolean(
    launchModel &&
    (launchModel.supportedReasoningEfforts.length === 0
      ? launchEffort === ""
      : launchModel.supportedReasoningEfforts.includes(launchEffort))
  );
  const launchCanStart = Boolean(
    launchOptions &&
    launchOptions.runners.some((item) => item.deviceId === launchDeviceId) &&
    (launchProjectId === "" ||
      launchOptions.projects.some((item) => item.id === launchProjectId)) &&
    launchInstance &&
    launchModel &&
    launchReasoningEffortValid &&
    launchPermission &&
    launchInstance.permissionModes.includes(launchPermission)
  );
  const displayMessages = useMemo(() => {
    if (!selectedRuntime) return [];
    if (
      !pendingMessage ||
      messages.some((message) => message.id === pendingMessage.id)
    )
      return messages;
    return [...messages, pendingMessage];
  }, [messages, pendingMessage, selectedRuntime]);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await refreshList();
      const id = selectedIdRef.current;
      if (id) {
        const value = await loadHostedManagedConversation(id);
        if (selectedIdRef.current === id) {
          setRuntime(value.runtime);
          setMessages(value.state.messages);
          await refreshProjectMove(id);
        }
      }
    } catch (cause) {
      handleError(cause);
    } finally {
      setRefreshing(false);
    }
  };

  const openProjectMove = async () => {
    if (!PROJECT_MOVE_UI_ENABLED || !selectedRuntime) return;
    if (selectedRuntime.execution.provider !== "codex") {
      setStatus("Project Move is not verified for this AI Client.");
      return;
    }
    setProjectMoveBusy(true);
    setError(null);
    try {
      const options = launchOptions ?? (await loadHostedLaunchOptions());
      setLaunchOptions(options);
      const destinations = options.projects.filter(
        (project) =>
          isRegisteredProjectId(project.id) &&
          project.id !== selectedRuntime.execution.projectId
      );
      if (destinations.length === 0) {
        setStatus(
          "No other registered Projects are available on this account."
        );
        return;
      }
      setProjectMoveDestinationId(destinations[0]?.id ?? "");
      setProjectMovePickerOpen(true);
    } catch (cause) {
      handleError(cause);
    } finally {
      setProjectMoveBusy(false);
    }
  };

  const submitProjectMove = async (
    dontShowAgain: boolean
  ): Promise<"completed" | "pending"> => {
    if (!selectedRuntime || !projectMoveDestinationId) {
      throw new Error("Choose a registered destination Project first.");
    }
    projectMoveRequestInFlightRef.current = true;
    try {
      const move = await requestHostedProjectMove(
        selectedRuntime.execution,
        projectMoveDestinationId,
        crypto.randomUUID()
      );
      if (selectedIdRef.current !== selectedRuntime.execution.id) {
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
          // The move remains valid if this installation cannot keep the intent.
        }
      }
      await applyProjectMoveState(move);
      setStatus(
        move.state === "completed"
          ? "Project Move completed; Conversation context was refreshed."
          : "Project Move accepted · Pending on the assigned device."
      );
      if (move.state === "failed" || move.state === "cancelled") {
        throw new Error(
          "The assigned device did not complete this Project Move."
        );
      }
      return move.state === "completed" ? "completed" : "pending";
    } finally {
      projectMoveRequestInFlightRef.current = false;
    }
  };

  const cancelProjectMove = async () => {
    if (
      !selectedRuntime ||
      !latestProjectMove ||
      latestProjectMove.state !== "pending"
    )
      return;
    setProjectMoveBusy(true);
    setError(null);
    try {
      const result = await cancelHostedProjectMove(
        selectedRuntime.execution,
        latestProjectMove.id
      );
      await applyProjectMoveState(result);
      setStatus(
        result.state === "cancelled"
          ? "Pending Project Move canceled."
          : result.state === "claimed" || result.state === "completed"
            ? "The assigned device claimed the Move before cancellation; showing its current state."
            : "The Project Move remains pending."
      );
    } catch (cause) {
      handleError(cause);
    } finally {
      setProjectMoveBusy(false);
    }
  };

  const send = async () => {
    const prompt = draft.trim();
    if (!selected || !selectedRuntime || !prompt || !canSend || sending) return;
    setSending(true);
    setError(null);
    setStatus(null);
    const messageId = crypto.randomUUID();
    try {
      const command = await queueHostedConversationPrompt(
        selectedRuntime.execution,
        prompt,
        { idempotencyKey: crypto.randomUUID(), clientUserMessageId: messageId }
      );
      if (selectedIdRef.current !== selected.id) return;
      setDraft("");
      setPendingMessage({
        id: messageId,
        role: "user",
        content: prompt,
        createdAt: new Date().toISOString(),
        author: null,
        commandId: command.commandId,
        commandState: command.state
      });
      setStatus(
        command.state === "queued" || command.state === "blocked"
          ? "Pending · Koed accepted this message. Pending does not indicate whether the runner is online."
          : "Message accepted · refreshing Conversation status."
      );
      try {
        const value = await loadHostedManagedConversation(selected.id);
        if (selectedIdRef.current !== selected.id) return;
        setRuntime(value.runtime);
        setMessages(value.state.messages);
      } catch (cause) {
        if (
          cause instanceof HostedManagedChatError &&
          [401, 403].includes(cause.status ?? 0)
        )
          handleError(cause);
        else
          setStatus(
            "Message accepted · Conversation status is currently unverified."
          );
      }
    } catch (cause) {
      handleError(cause);
    } finally {
      setSending(false);
    }
  };

  const cancelPending = async () => {
    if (
      !selected ||
      !selectedRuntime ||
      !latestCommand ||
      !canCancelQueuedPrompt
    )
      return;
    setControlBusy(true);
    setError(null);
    try {
      const result = await cancelHostedQueuedPrompt(
        selectedRuntime.execution,
        latestCommand.id
      );
      if (selectedIdRef.current !== selected.id) return;
      if (result.canceled || result.state === "canceled") {
        setPendingMessage(null);
        setStatus("Pending message canceled.");
      } else {
        setPendingMessage((current) =>
          current ? { ...current, commandState: result.state } : current
        );
        setStatus(
          `Message is ${result.state}; cancellation was not confirmed.`
        );
      }
    } catch (cause) {
      handleError(cause);
    } finally {
      setControlBusy(false);
    }
  };

  const control = async (action: "interrupt" | "stop") => {
    if (!selectedRuntime) return;
    setControlBusy(true);
    setError(null);
    try {
      await requestHostedConversationControl(
        selectedRuntime.execution,
        action,
        crypto.randomUUID()
      );
      if (selectedIdRef.current !== selectedRuntime.execution.id) return;
      setStatus(
        `${action === "interrupt" ? "Interrupt" : "Stop"} accepted · waiting for runner status.`
      );
      try {
        const value = await loadHostedManagedConversation(
          selectedRuntime.execution.id
        );
        if (selectedIdRef.current === selectedRuntime.execution.id) {
          setRuntime(value.runtime);
          setMessages(value.state.messages);
        }
      } catch {
        // An accepted control remains accepted even when its state refresh fails.
      }
    } catch (cause) {
      handleError(cause);
    } finally {
      setControlBusy(false);
    }
  };

  const openNewConversation = async () => {
    setNewConversationOpen(true);
    if (launchOptions || launchLoading) return;
    setLaunchLoading(true);
    setError(null);
    try {
      const options = await loadHostedLaunchOptions();
      setLaunchOptions(options);
      setLaunchProjectId(options.projects[0]?.id ?? "");
      setLaunchDeviceId(options.runners[0]?.deviceId ?? "");
      const instance = options.instances[0];
      setLaunchInstanceId(instance?.instanceId ?? "");
      const model = instance?.models[0];
      setLaunchModelId(model?.id ?? "");
      setLaunchEffort(model?.supportedReasoningEfforts[0] ?? "");
      setLaunchPermission(instance?.permissionModes[0] ?? "");
    } catch (cause) {
      handleError(cause);
    } finally {
      setLaunchLoading(false);
    }
  };

  const createConversation = async () => {
    if (!launchCanStart || !launchInstance || !launchModel) return;
    setSending(true);
    setError(null);
    setStatus(null);
    try {
      const started = await startHostedManagedConversation({
        projectId: launchProjectId || null,
        contextKind: launchProjectId ? "project" : "independent",
        provider: launchInstance.driverId,
        aiClientInstanceId: launchInstance.instanceId,
        model: launchModel.id,
        reasoningEffort: launchEffort || null,
        permissionMode: launchPermission,
        targetDeviceId: launchDeviceId,
        idempotencyKey: crypto.randomUUID(),
        ...(initialPrompt.trim() ? { initialPrompt: initialPrompt.trim() } : {})
      });
      setNewConversationOpen(false);
      selectedIdRef.current = started.execution.id;
      setSelectedId(started.execution.id);
      setRuntime({
        execution: started.execution,
        items: [],
        latestCommand: {
          id: started.commandId,
          state: started.commandState,
          commandKind: "start",
          lastErrorCode: null
        }
      });
      setMessages([]);
      setPendingMessage(null);
      setInitialPrompt("");
      setStatus(
        started.commandState === "queued" || started.commandState === "blocked"
          ? "Pending · Koed accepted the Conversation start. Device eligibility does not show whether it is online."
          : "Conversation start accepted · waiting for runner status."
      );
      try {
        await refreshList();
        const value = await loadHostedManagedConversation(started.execution.id);
        if (selectedIdRef.current === started.execution.id) {
          setRuntime(value.runtime);
          setMessages(value.state.messages);
        }
      } catch (cause) {
        if (
          cause instanceof HostedManagedChatError &&
          [401, 403].includes(cause.status ?? 0)
        )
          handleError(cause);
      }
    } catch (cause) {
      if (cause instanceof HostedManagedChatError && cause.status === 403)
        setLaunchOptions(null);
      handleError(cause);
    } finally {
      setSending(false);
    }
  };

  const projectMoveInFlight = Boolean(
    latestProjectMove &&
    latestProjectMove.executionId === selectedId &&
    (latestProjectMove.state === "pending" ||
      latestProjectMove.state === "claimed")
  );
  const projectMoveDestination = launchOptions?.projects.find(
    (project) => project.id === projectMoveDestinationId
  );
  const selectedProjectId = selectedRuntime?.execution.projectId ?? null;
  const selectedProjectName = launchOptions?.projects.find(
    (project) => project.id === selectedProjectId
  )?.name;
  const moveUnavailableReason = selectedRuntime
    ? selectedRuntime.execution.provider !== "codex"
      ? "Project Move is unavailable for this AI Client; only verified Codex Conversations can move."
      : !PROJECT_MOVE_UI_ENABLED
        ? "Project Move is disabled while the assigned computer transition is being validated. Source edit status is unknown; dirty or unknown sources currently block rebinding."
        : null
    : "Load the managed Conversation state to check Project Move availability.";

  const cancelStart = async () => {
    if (!selectedRuntime || !canCancelStart) return;
    setControlBusy(true);
    setError(null);
    try {
      const result = await cancelHostedConversationStart(
        selectedRuntime.execution
      );
      if (selectedIdRef.current !== selectedRuntime.execution.id) return;
      if (result.canceled || result.state === "canceled") {
        setStatus("Pending Conversation start canceled.");
      } else {
        setStatus(
          `Conversation start is ${result.state}; cancellation was not confirmed.`
        );
      }
      try {
        const value = await loadHostedManagedConversation(
          selectedRuntime.execution.id
        );
        if (selectedIdRef.current === selectedRuntime.execution.id) {
          setRuntime(value.runtime);
          setMessages(value.state.messages);
        }
      } catch {
        // Report the cancellation result independently of a follow-up status refresh.
      }
    } catch (cause) {
      handleError(cause);
    } finally {
      setControlBusy(false);
    }
  };

  return (
    <section
      aria-label="Your Koed Conversations"
      className="mb-6 rounded-xl border border-border bg-surface p-4 md:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-foreground">
            Your Conversations
          </h1>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
            Continue managed Conversations from your Koed devices. Messages and
            controls use your signed-in Koed session.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void openNewConversation()}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90"
          >
            New Conversation
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs text-foreground-secondary hover:bg-surface-hover disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
            />{" "}
            Refresh
          </button>
        </div>
      </div>

      {newConversationOpen && (
        <form
          className="mt-4 rounded-lg border border-border bg-background p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void createConversation();
          }}
        >
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-semibold text-foreground">
              Start on a Koed device
            </p>
            <button
              type="button"
              onClick={() => setNewConversationOpen(false)}
              aria-label="Close New Conversation"
              className="rounded p-1 text-muted hover:bg-surface-hover"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {launchLoading ? (
            <p className="text-xs text-muted">
              Loading eligible devices, Project choices, and model choices…
            </p>
          ) : launchOptions ? (
            launchOptions.runners.length &&
            launchOptions.instances.some(
              (instance) =>
                instance.models.length > 0 &&
                instance.permissionModes.length > 0
            ) ? (
              <>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  <label className="text-[11px] text-muted">
                    Project
                    <select
                      value={launchProjectId}
                      onChange={(event) =>
                        setLaunchProjectId(event.target.value)
                      }
                      className="mt-1 block w-full rounded-md border border-border bg-background px-2 py-2 text-xs text-foreground"
                    >
                      <option value="">No Project / Standalone</option>
                      {launchOptions.projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-[11px] text-muted">
                    Device
                    <select
                      value={launchDeviceId}
                      onChange={(event) =>
                        setLaunchDeviceId(event.target.value)
                      }
                      className="mt-1 block w-full rounded-md border border-border bg-background px-2 py-2 text-xs text-foreground"
                    >
                      {launchOptions.runners.map((runner) => (
                        <option key={runner.deviceId} value={runner.deviceId}>
                          {runner.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-[11px] text-muted">
                    Model
                    <select
                      value={`${launchInstanceId}::${launchModelId}`}
                      onChange={(event) => {
                        const [instanceId, modelId] =
                          event.target.value.split("::");
                        const instance = launchOptions.instances.find(
                          (item) => item.instanceId === instanceId
                        );
                        const model = instance?.models.find(
                          (item) => item.id === modelId
                        );
                        setLaunchInstanceId(instanceId ?? "");
                        setLaunchModelId(modelId ?? "");
                        setLaunchEffort(
                          model?.supportedReasoningEfforts[0] ?? ""
                        );
                        setLaunchPermission(instance?.permissionModes[0] ?? "");
                      }}
                      className="mt-1 block w-full rounded-md border border-border bg-background px-2 py-2 text-xs text-foreground"
                    >
                      {launchOptions.instances.flatMap((instance) =>
                        instance.models.map((model) => (
                          <option
                            key={`${instance.instanceId}:${model.id}`}
                            value={`${instance.instanceId}::${model.id}`}
                          >
                            {model.displayName} · {instance.driverId}{" "}
                            {instance.ready ? "" : "(last known choice)"}
                          </option>
                        ))
                      )}
                    </select>
                  </label>
                  {launchModel &&
                    launchModel.supportedReasoningEfforts.length > 0 && (
                      <label className="text-[11px] text-muted">
                        Reasoning
                        <select
                          value={launchEffort}
                          onChange={(event) =>
                            setLaunchEffort(event.target.value)
                          }
                          className="mt-1 block w-full rounded-md border border-border bg-background px-2 py-2 text-xs text-foreground"
                        >
                          {launchModel.supportedReasoningEfforts.map(
                            (effort) => (
                              <option key={effort} value={effort}>
                                {effort}
                              </option>
                            )
                          )}
                        </select>
                      </label>
                    )}
                  <label className="text-[11px] text-muted">
                    Permission
                    <select
                      value={launchPermission}
                      onChange={(event) =>
                        setLaunchPermission(event.target.value)
                      }
                      className="mt-1 block w-full rounded-md border border-border bg-background px-2 py-2 text-xs text-foreground"
                    >
                      {launchInstance?.permissionModes.map((permission) => (
                        <option key={permission} value={permission}>
                          {permission.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="mt-3 block text-[11px] text-muted">
                  First message (optional)
                  <textarea
                    value={initialPrompt}
                    onChange={(event) => setInitialPrompt(event.target.value)}
                    rows={2}
                    className="mt-1 block w-full resize-y rounded-md border border-border bg-background px-2 py-2 text-xs text-foreground"
                  />
                </label>
                <p className="mt-2 text-[10px] leading-4 text-muted">
                  Device eligibility does not show whether it is online. Model
                  choices are last known and are checked by the device when it
                  reconnects; the Conversation may remain Pending.
                </p>
                <button
                  type="submit"
                  disabled={!launchCanStart || sending}
                  className="mt-3 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {sending ? "Starting…" : "Start Conversation"}
                </button>
              </>
            ) : (
              <p className="text-xs text-muted">
                An eligible device, model, and supported permission are
                required. Check your Koed account and try again.
              </p>
            )
          ) : (
            <p className="text-xs text-muted">
              Launch options are unavailable.
            </p>
          )}
        </form>
      )}

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}
      {status && (
        <p role="status" className="mt-3 text-xs text-muted">
          {status}
        </p>
      )}

      {loading ? (
        <div className="mt-5 flex items-center gap-2 text-xs text-muted">
          <LoaderCircle className="h-4 w-4 animate-spin" /> Loading
          Conversations…
        </div>
      ) : executions.length === 0 ? (
        <p className="mt-5 rounded-lg border border-dashed border-border px-4 py-5 text-sm text-muted">
          No managed Conversations are available for this account.
        </p>
      ) : (
        <div className="mt-4 grid min-h-[340px] gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
          <nav
            aria-label="Managed Conversations"
            className="max-h-56 space-y-1 overflow-y-auto lg:max-h-[520px]"
          >
            {executions.map((execution) => (
              <button
                key={execution.id}
                type="button"
                onClick={() => {
                  selectedIdRef.current = execution.id;
                  setSelectedId(execution.id);
                  setRuntime(null);
                  setMessages([]);
                  setPendingMessage(null);
                  setStatus(null);
                  setLatestProjectMove(null);
                  setProjectMoveLoaded(false);
                  setProjectMoveDialogOpen(false);
                  setProjectMovePickerOpen(false);
                }}
                aria-current={execution.id === selectedId ? "true" : undefined}
                className={`w-full rounded-md px-3 py-2 text-left ${execution.id === selectedId ? "bg-surface-hover text-foreground" : "text-foreground-secondary hover:bg-surface-hover"}`}
              >
                <span className="block truncate text-xs font-medium">
                  {execution.model} · {execution.provider}
                </span>
                <span className="mt-1 block text-[11px] text-muted">
                  {stateLabel(execution)} ·{" "}
                  {new Date(execution.updatedAt).toLocaleString()}
                </span>
              </button>
            ))}
          </nav>

          <div className="flex min-h-[340px] min-w-0 flex-col rounded-lg border border-border bg-background">
            <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-foreground">
                  {selected?.model ?? "Conversation"}
                </p>
                <p className="mt-0.5 text-[11px] text-muted">
                  {selectedRuntime
                    ? stateLabel({
                        ...selected!,
                        state: selectedRuntime.execution.state
                      })
                    : "Connecting"}
                </p>
                {(pendingStart || pendingPrompt) && (
                  <p className="mt-0.5 text-[10px] text-muted">
                    Pending · accepted by Koed; device availability is not known
                    from this state.
                  </p>
                )}
                {pendingControl && (
                  <p className="mt-0.5 text-[10px] text-muted">
                    {latestCommand?.commandKind === "stop"
                      ? "Stop"
                      : "Interrupt"}{" "}
                    accepted · waiting for the assigned device to apply it.
                  </p>
                )}
              </div>
              <div className="flex gap-1">
                {canCancelQueuedPrompt && (
                  <button
                    type="button"
                    onClick={() => void cancelPending()}
                    disabled={controlBusy}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
                  >
                    <X className="h-3 w-3" /> Cancel Pending
                  </button>
                )}
                {canCancelStart && (
                  <button
                    type="button"
                    onClick={() => void cancelStart()}
                    disabled={controlBusy}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
                  >
                    <X className="h-3 w-3" /> Cancel Start
                  </button>
                )}
                {canInterrupt && (
                  <button
                    type="button"
                    onClick={() => void control("interrupt")}
                    disabled={controlBusy || pendingControl}
                    className="rounded-md px-2 py-1 text-[11px] text-foreground-secondary hover:bg-surface-hover disabled:opacity-50"
                  >
                    Interrupt
                  </button>
                )}
                {canStop && (
                  <button
                    type="button"
                    onClick={() => void control("stop")}
                    disabled={controlBusy || pendingControl}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-foreground-secondary hover:bg-surface-hover disabled:opacity-50"
                  >
                    <Square className="h-3 w-3" /> Stop
                  </button>
                )}
              </div>
            </div>
            {selectedRuntime && (
              <div className="border-b border-border px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="mr-auto text-[11px] text-muted">
                    Current Project:{" "}
                    {selectedProjectId
                      ? (selectedProjectName ?? "Project")
                      : "Standalone"}
                  </p>
                  {latestProjectMove?.executionId === selectedId && (
                    <span role="status" className="text-[11px] text-muted">
                      Project Move{" "}
                      {latestProjectMove.state === "pending"
                        ? "Pending on assigned device"
                        : latestProjectMove.state === "claimed"
                          ? "claimed by assigned device"
                          : latestProjectMove.state === "completed"
                            ? "completed"
                            : latestProjectMove.state}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void openProjectMove()}
                    disabled={
                      !PROJECT_MOVE_UI_ENABLED ||
                      selectedRuntime.execution.provider !== "codex" ||
                      !projectMoveLoaded ||
                      projectMoveBusy ||
                      projectMoveInFlight ||
                      sending ||
                      controlBusy ||
                      activePrompt ||
                      pendingControl
                    }
                    title={moveUnavailableReason ?? undefined}
                    className="rounded-md border border-border px-2 py-1 text-[11px] text-foreground-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Move to Project
                  </button>
                  {latestProjectMove?.executionId === selectedId &&
                    latestProjectMove.state === "pending" && (
                      <button
                        type="button"
                        onClick={() => void cancelProjectMove()}
                        disabled={projectMoveBusy}
                        className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-surface-hover disabled:opacity-50"
                      >
                        Cancel Pending Move
                      </button>
                    )}
                </div>
                {moveUnavailableReason ? (
                  <p
                    role="note"
                    className="mt-1 text-[10px] leading-4 text-muted"
                  >
                    {moveUnavailableReason} If Move succeeds, source edits stay
                    at the source Project; if they cannot be safely retained,
                    the Move fails and the original context remains unchanged.
                  </p>
                ) : null}
                {projectMovePickerOpen && launchOptions ? (
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
                        {launchOptions.projects
                          .filter(
                            (project) =>
                              isRegisteredProjectId(project.id) &&
                              project.id !== selectedProjectId
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
                      disabled={!projectMoveDestination || projectMoveBusy}
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
              </div>
            )}
            <div
              aria-live="polite"
              className="flex-1 space-y-3 overflow-y-auto p-3"
            >
              {!selectedRuntime && (
                <p className="text-xs text-muted">Loading live Conversation…</p>
              )}
              {displayMessages.map((message) => (
                <article
                  key={message.id}
                  className={`max-w-[92%] rounded-lg px-3 py-2 text-sm ${message.role === "user" ? "ml-auto bg-accent/10 text-foreground" : "bg-surface text-foreground-secondary"}`}
                >
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted">
                    {message.role === "user"
                      ? "You"
                      : (message.author?.name ?? selected?.model ?? "Agent")}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-xs leading-5">
                    {message.content}
                  </p>
                  {message.id === pendingMessage?.id && (
                    <p className="mt-1 text-[10px] text-muted">
                      Pending · accepted by Koed
                    </p>
                  )}
                </article>
              ))}
              {selectedRuntime && displayMessages.length === 0 && (
                <p className="text-xs text-muted">
                  No messages in this Conversation yet.
                </p>
              )}
            </div>
            <form
              className="border-t border-border p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <div className="flex items-end gap-2">
                <textarea
                  aria-label="Continue Conversation"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  rows={2}
                  placeholder={
                    canSend
                      ? "Continue this Conversation…"
                      : "Conversation is not ready for a message"
                  }
                  disabled={!canSend || sending}
                  className="min-h-10 flex-1 resize-y rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
                />
                <button
                  type="submit"
                  disabled={!canSend || !draft.trim() || sending}
                  aria-label="Send message"
                  className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {sending ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}{" "}
                  Send
                </button>
              </div>
              <p className="mt-2 text-[10px] text-muted">
                Pending means Koed accepted the message. It does not show
                whether the device is online.
              </p>
            </form>
          </div>
        </div>
      )}
      {projectMoveDialogOpen && selectedRuntime && projectMoveDestination ? (
        <ProjectMoveConfirmation
          threadTitle={selected?.model ?? "Managed Conversation"}
          projectName={projectMoveDestination.name}
          sourceEditStatus="unknown"
          onMove={submitProjectMove}
          onCancel={() => {
            setProjectMoveDialogOpen(false);
            setProjectMovePickerOpen(false);
          }}
        />
      ) : null}
    </section>
  );
}
