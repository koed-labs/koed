"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  X
} from "lucide-react";
import {
  cancelHostedProjectMove,
  cancelHostedQueuedPrompt,
  cancelHostedConversationStart,
  HostedManagedChatError,
  hostedActiveAgentAttribution,
  loadLatestHostedProjectMove,
  listHostedManagedConversations,
  loadHostedLaunchOptions,
  loadHostedManagedConversation,
  loadHostedManagedConversationAccess,
  loadHostedRecallFeedback,
  lookupHostedConversationRecovery,
  hasMeaningfulHostedApprovalDetails,
  hostedPromptOutcomeIsUncertain,
  hostedRecoveryDisposition,
  hostedRecoveryGuardForSelection,
  hostedRecoverySelectionIsCurrent,
  hostedNewStartPromptForVerifiedScope,
  hostedMessagesForSelection,
  hostedMessagesWithTransientOutput,
  hostedLaunchInstancesForDevice,
  hostedLaunchSelectionForOptions,
  queueHostedConversationPrompt,
  requestHostedProjectMove,
  requestHostedConversationControl,
  updateHostedRecallFeedback,
  respondToHostedRuntimeItem,
  startHostedManagedConversation,
  type HostedLaunchOptions,
  type HostedConversationMessage,
  type HostedManagedExecution,
  type HostedProjectMove
} from "@/lib/hosted-managed-chats";
import {
  canCancelManagedConversationPrompt,
  type RuntimeSnapshot
} from "@/lib/managed-agent-chat";
import { pendingChatRequests } from "@/lib/managed-chat-requests";
import {
  createDeviceManagedChatRecoveryStore,
  type DeviceManagedChatPendingOperation,
  type DeviceManagedChatRecoveryStore
} from "@/lib/device-managed-chat-recovery";
import { ProjectMoveConfirmation } from "@/components/ProjectMoveConfirmation";
import { ChatComposer } from "@/components/ChatComposer";
import { AgentChatMessage, SharedChatUI } from "@/components/SharedChatUI";
import { MemoryAttributionNote } from "@/components/studio/MemoryAttributionNote";
import { TeamAgentRequestReviewPanel } from "@/components/TeamAgentRequestViews";
import { teamSummaryReplyForTurn } from "@/lib/team-agent-summary-state";
import {
  managedAgentJobMarkers,
  type ManagedAgentJobMarker
} from "@/lib/managed-agent-job-markers";
import { TeamAgentRequestsClient } from "@/lib/team-agent-requests-client";
import { HostedTeamCollaborationClient } from "@/lib/hosted-team-collaboration";
import {
  personalAgentsHttpAdapter,
  type PersonalAgent
} from "@/lib/personal-agents-client";
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
const retainTeamRequestContext = (
  executionId: string,
  requestId?: string,
  teamId?: string,
  requestVersion?: number,
  reviewVersion?: number
) => {
  const params = new URLSearchParams({ chat: "1", execution: executionId });
  if (requestId && teamId) {
    params.set("teamRequest", requestId);
    params.set("teamRequestTeam", teamId);
  }
  if (Number.isSafeInteger(requestVersion))
    params.set("teamRequestVersion", String(requestVersion));
  if (Number.isSafeInteger(reviewVersion))
    params.set("teamReviewVersion", String(reviewVersion));
  return `/?${params.toString()}`;
};

type PendingMessage = HostedConversationMessage & {
  executionId: string;
  commandId: string;
  commandState: string;
};

type HostedRecoveryScope = { ownerId: string; backendId: string };

const stateLabel = (execution: HostedManagedExecution) => {
  if (execution.state === "running") return "Running";
  if (execution.state === "starting") return "Starting";
  if (execution.state === "stopped") return "Stopped";
  if (execution.state === "failed") return "Failed";
  return execution.state.replaceAll("_", " ");
};

export function HostedManagedChats({
  onAuthorizationLost,
  initialNewConversation = false,
  initialAgentId,
  initialExecutionId,
  initialDraft = "",
  teamRequestId,
  teamRequestTeamId,
  teamRequestExpectedRequestVersion,
  teamRequestExpectedReviewVersion
}: {
  onAuthorizationLost: () => void;
  initialNewConversation?: boolean;
  initialAgentId?: string;
  initialExecutionId?: string;
  initialDraft?: string;
  teamRequestId?: string;
  teamRequestTeamId?: string;
  teamRequestExpectedRequestVersion?: number;
  teamRequestExpectedReviewVersion?: number;
}) {
  const router = useRouter();
  const teamAgentRequestsClient = useMemo(
    () => new TeamAgentRequestsClient("hosted"),
    []
  );
  const teamCollaborationClient = useMemo(
    () => new HostedTeamCollaborationClient(),
    []
  );
  const [executions, setExecutions] = useState<HostedManagedExecution[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialExecutionId ?? null
  );
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [messages, setMessages] = useState<HostedConversationMessage[]>([]);
  const [jobMarkers, setJobMarkers] = useState<ManagedAgentJobMarker[]>([]);
  const [jobMarkersExecutionId, setJobMarkersExecutionId] = useState<
    string | null
  >(null);
  const [pendingMessage, setPendingMessage] = useState<PendingMessage | null>(
    null
  );
  const [draft, setDraft] = useState(initialDraft);
  const [recoveryScope, setRecoveryScope] =
    useState<HostedRecoveryScope | null>(null);
  const [pendingRecoveryOperation, setPendingRecoveryOperation] =
    useState<DeviceManagedChatPendingOperation | null>(null);
  const [pendingRecoveryExecutionId, setPendingRecoveryExecutionId] = useState<
    string | null
  >(null);
  const [pendingNewStart, setPendingNewStart] =
    useState<DeviceManagedChatPendingOperation | null>(null);
  const [runtimeRequestNotice, setRuntimeRequestNotice] = useState<{
    executionId: string;
  } | null>(null);
  const [recoveryCheckCounts, setRecoveryCheckCounts] = useState<
    Record<string, number>
  >({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [teamSummaryState, setTeamSummaryState] = useState<{
    status: "idle" | "drafting" | "ready" | "error";
    text: string;
  }>({ status: "idle", text: "" });
  const [teamSummaryAttemptRevision, setTeamSummaryAttemptRevision] =
    useState(0);
  const [teamQuestionDraft, setTeamQuestionDraft] = useState("");
  const [teamRequestReviewVersion, setTeamRequestReviewVersion] = useState(
    teamRequestExpectedReviewVersion
  );
  const [teamRequestReviewSaved, setTeamRequestReviewSaved] = useState(
    !teamRequestId || Boolean(initialExecutionId)
  );
  const teamSummaryAttempt = useRef<{
    executionId: string;
    commandId: string;
    userMessageId: string;
  } | null>(null);
  const [controlBusy, setControlBusy] = useState(false);
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false);
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [launchOptions, setLaunchOptions] =
    useState<HostedLaunchOptions | null>(null);
  const [launchAgent, setLaunchAgent] = useState<PersonalAgent | null>(null);
  const [launchAgentLoading, setLaunchAgentLoading] = useState(false);
  const [launchAgentError, setLaunchAgentError] = useState<string | null>(null);
  const [confirmedAgentModelFor, setConfirmedAgentModelFor] = useState<
    string | null
  >(null);
  const [launchLoading, setLaunchLoading] = useState(false);
  const [launchProjectId, setLaunchProjectId] = useState("");
  const [launchDeviceId, setLaunchDeviceId] = useState("");
  const [launchInstanceId, setLaunchInstanceId] = useState("");
  const [launchModelId, setLaunchModelId] = useState("");
  const [launchEffort, setLaunchEffort] = useState("");
  const [launchPermission, setLaunchPermission] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [memoryRecallFailure, setMemoryRecallFailure] = useState<{
    kind: "start" | "prompt";
    executionId?: string;
    agentId: string | null;
  } | null>(null);
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
  const selectedIdRef = useRef<string | null>(initialExecutionId ?? null);
  const draftRef = useRef("");
  const recoveryStoreRef = useRef<DeviceManagedChatRecoveryStore | null>(null);
  const newStartStoreRef = useRef<DeviceManagedChatRecoveryStore | null>(null);
  const newStartOperationRef = useRef<DeviceManagedChatPendingOperation | null>(
    null
  );
  const recoveryOperationRef = useRef<DeviceManagedChatPendingOperation | null>(
    null
  );
  const recoverySelectionRef = useRef<string | null | undefined>(undefined);
  const refreshedCompletedMoveRef = useRef<string | null>(null);
  const projectMoveRequestInFlightRef = useRef(false);
  const launchOptionsLoadInFlightRef = useRef(false);
  const initialNewConversationHandled = useRef(false);
  const initialPromptWasEdited = useRef(false);
  const initialPromptSeeded = useRef(false);

  const writeRecovery = useCallback(
    (
      store: DeviceManagedChatRecoveryStore | null,
      draftValue: string,
      operation: DeviceManagedChatPendingOperation | null
    ) => {
      if (!store) return;
      store.write({
        schemaVersion: 1,
        draft: draftValue,
        ...(operation ? { pendingOperation: operation } : {})
      });
    },
    []
  );

  const setScopedPendingRecoveryOperation = useCallback(
    (
      operation: DeviceManagedChatPendingOperation | null,
      executionId: string | null
    ) => {
      setPendingRecoveryExecutionId(executionId);
      setPendingRecoveryOperation(operation);
    },
    []
  );

  const beginRecoveryCheck = useCallback((executionId: string | null) => {
    const key = executionId ?? "__new_conversation__";
    setRecoveryCheckCounts((current) => ({
      ...current,
      [key]: (current[key] ?? 0) + 1
    }));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setRecoveryCheckCounts((current) => {
        const count = current[key] ?? 0;
        if (count <= 1) {
          const remaining = { ...current };
          delete remaining[key];
          return remaining;
        }
        return { ...current, [key]: count - 1 };
      });
    };
  }, []);

  const updateDraft = useCallback(
    (value: string) => {
      draftRef.current = value;
      setDraft(value);
      writeRecovery(
        recoveryStoreRef.current,
        value,
        recoveryOperationRef.current
      );
    },
    [writeRecovery]
  );

  const setRecoveryOperation = useCallback(
    (
      operation: DeviceManagedChatPendingOperation | null,
      store = recoveryStoreRef.current,
      draftValue = draftRef.current
    ) => {
      recoveryOperationRef.current = operation;
      setScopedPendingRecoveryOperation(operation, selectedIdRef.current);
      writeRecovery(store, draftValue, operation);
    },
    [writeRecovery, setScopedPendingRecoveryOperation]
  );

  const handleError = useCallback(
    (cause: unknown) => {
      if (cause instanceof HostedManagedChatError && cause.status === 401) {
        setExecutions([]);
        selectedIdRef.current = null;
        setSelectedId(null);
        setRuntime(null);
        setMessages([]);
        setJobMarkers([]);
        setJobMarkersExecutionId(null);
        setPendingMessage(null);
        draftRef.current = "";
        setDraft("");
        recoveryStoreRef.current = null;
        newStartStoreRef.current = null;
        recoveryOperationRef.current = null;
        newStartOperationRef.current = null;
        setRecoveryScope(null);
        setScopedPendingRecoveryOperation(null, null);
        setPendingNewStart(null);
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
    [onAuthorizationLost, setScopedPendingRecoveryOperation]
  );

  const refreshList = useCallback(
    async (signal?: AbortSignal) => {
      const values = await listHostedManagedConversations(signal);
      if (signal?.aborted) return;
      setExecutions(values);
      const current = selectedIdRef.current;
      const next =
        current && values.some((item) => item.id === current)
          ? current
          : (values[0]?.id ?? null);
      if (next !== current) {
        setMemoryRecallFailure(null);
        selectedIdRef.current = next;
        setSelectedId(next);
        recoveryOperationRef.current = null;
        setScopedPendingRecoveryOperation(null, next);
        setRuntime(null);
        setMessages([]);
        setPendingMessage(null);
        setStatus(null);
        setLatestProjectMove(null);
        setProjectMoveLoaded(false);
        setProjectMoveDialogOpen(false);
        setProjectMovePickerOpen(false);
      }
    },
    [setScopedPendingRecoveryOperation]
  );

  const reconcilePromptOperation = useCallback(
    async (
      operation: DeviceManagedChatPendingOperation,
      executionId: string,
      store: DeviceManagedChatRecoveryStore | null,
      signal?: AbortSignal
    ) => {
      const endRecoveryCheck = beginRecoveryCheck(executionId);
      try {
        const value = await loadHostedManagedConversation(executionId, signal);
        if (value.runtime.execution.id !== executionId)
          throw new Error("The selected Conversation changed during recovery.");
        const result = await lookupHostedConversationRecovery(
          {
            kind: "prompt",
            idempotencyKey: operation.promptIdempotencyKey,
            clientUserMessageId: operation.clientUserMessageId,
            executionId,
            executionGeneration:
              operation.executionGeneration ??
              value.runtime.execution.executionGeneration
          },
          signal
        );
        if (signal?.aborted) return;
        if (result.found) {
          const disposition = hostedRecoveryDisposition(result.commandState);
          const restoredDraft = disposition.restorePrompt
            ? operation.prompt
            : (store?.read()?.draft ?? "");
          if (disposition.kind === "failed") {
            writeRecovery(store, restoredDraft, {
              ...operation,
              state: "rejected"
            });
          } else if (disposition.clearIdentity) {
            writeRecovery(store, restoredDraft, null);
          } else {
            writeRecovery(store, restoredDraft, {
              ...operation,
              state: "reconciling"
            });
          }
          if (selectedIdRef.current === executionId) {
            const preserveOperation =
              !disposition.clearIdentity && disposition.kind !== "failed";
            const savedOperation = {
              ...operation,
              state:
                disposition.kind === "failed"
                  ? ("rejected" as const)
                  : ("reconciling" as const)
            };
            recoveryOperationRef.current = preserveOperation
              ? savedOperation
              : null;
            setScopedPendingRecoveryOperation(
              preserveOperation ? savedOperation : null,
              executionId
            );
            draftRef.current = restoredDraft;
            setDraft(restoredDraft);
            setRuntime(value.runtime);
            setMessages(value.state.messages);
            if (!disposition.showPendingMessage) {
              setPendingMessage(null);
            } else if (
              !value.state.messages.some(
                (message) => message.id === operation.clientUserMessageId
              )
            ) {
              setPendingMessage({
                id: operation.clientUserMessageId,
                executionId,
                role: "user",
                content: operation.prompt,
                createdAt: new Date().toISOString(),
                author: null,
                commandId: result.commandId,
                commandState: result.commandState
              });
            } else {
              setPendingMessage(null);
            }
            if (disposition.kind === "canceled") {
              setStatus(
                "The previous continuation was canceled. Its draft is restored; sending again will create a new attempt."
              );
              setError(null);
            } else if (disposition.kind === "failed") {
              setStatus(
                "The previous continuation failed. Its draft is restored; sending again will create a new attempt."
              );
              setError(null);
            } else if (disposition.kind === "uncertain") {
              setStatus(
                "The previous continuation has an uncertain outcome. Its send identity is retained; check status before trying again."
              );
              setError(
                "Studio cannot safely retry this continuation until Koed confirms its outcome."
              );
            } else {
              setStatus(
                result.commandState === "queued" ||
                  result.commandState === "blocked"
                  ? "The previous continuation was accepted and is still pending on its assigned runner."
                  : result.commandState === "dispatching"
                    ? "The previous continuation was accepted and the runner has claimed it."
                    : "The previous continuation completed; its persisted state is refreshed."
              );
              setError(null);
            }
          }
        } else {
          const unresolved = { ...operation, state: "reconciling" as const };
          writeRecovery(store, operation.prompt, unresolved);
          if (selectedIdRef.current === executionId) {
            recoveryOperationRef.current = unresolved;
            setScopedPendingRecoveryOperation(unresolved, executionId);
            draftRef.current = operation.prompt;
            setDraft(operation.prompt);
            setRuntime(value.runtime);
            setMessages(value.state.messages);
            setStatus(
              "Koed has not found this continuation yet. Its prompt and send identity are retained; Studio will not send it again. Check status again before continuing."
            );
          }
        }
      } catch (cause) {
        if (signal?.aborted) return;
        const unresolved = { ...operation, state: "reconciling" as const };
        writeRecovery(store, operation.prompt, unresolved);
        if (selectedIdRef.current === executionId) {
          recoveryOperationRef.current = unresolved;
          setScopedPendingRecoveryOperation(unresolved, executionId);
          draftRef.current = operation.prompt;
          setDraft(operation.prompt);
          setStatus(
            "Studio could not verify the previous continuation. Its send identity and prompt are saved; Studio will not send it again."
          );
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not verify the previous continuation."
          );
        }
      } finally {
        endRecoveryCheck();
      }
    },
    [beginRecoveryCheck, setScopedPendingRecoveryOperation, writeRecovery]
  );

  const reconcileStartOperation = useCallback(
    async (
      operation: DeviceManagedChatPendingOperation,
      store: DeviceManagedChatRecoveryStore | null,
      fromNewSlot: boolean,
      signal?: AbortSignal
    ) => {
      const selectedExecutionAtStart = selectedIdRef.current;
      const endRecoveryCheck = beginRecoveryCheck(
        fromNewSlot ? null : selectedExecutionAtStart
      );
      try {
        const result = await lookupHostedConversationRecovery(
          { kind: "start", idempotencyKey: operation.startIdempotencyKey },
          signal
        );
        if (signal?.aborted) return;
        if (
          !hostedRecoverySelectionIsCurrent(
            selectedExecutionAtStart,
            selectedIdRef.current
          )
        ) {
          return;
        }
        if (result.found) {
          const disposition = hostedRecoveryDisposition(result.commandState);
          if (
            disposition.kind === "failed" ||
            disposition.kind === "uncertain"
          ) {
            const failed = disposition.kind === "failed";
            if (failed) {
              setPendingMessage((pending) =>
                pending?.executionId === result.executionId ? null : pending
              );
            }
            const retained = {
              ...operation,
              state: failed ? ("rejected" as const) : ("reconciling" as const)
            };
            writeRecovery(store, operation.prompt, retained);
            if (fromNewSlot) {
              newStartOperationRef.current = failed ? null : retained;
              setPendingNewStart(failed ? null : retained);
            } else {
              recoveryOperationRef.current = failed ? null : retained;
              setScopedPendingRecoveryOperation(
                failed ? null : retained,
                selectedExecutionAtStart
              );
            }
            setInitialPrompt(operation.prompt);
            if (failed) setNewConversationOpen(true);
            setStatus(
              failed
                ? "The previous Conversation start failed. Its initial prompt is restored; starting again will create a new attempt."
                : "The previous Conversation start has an uncertain outcome. Its send identity is retained; check status before trying again."
            );
            setError(
              failed
                ? null
                : "Studio cannot safely retry this Conversation start until Koed confirms its outcome."
            );
            return;
          }
          if (disposition.kind === "canceled") {
            setPendingMessage((pending) =>
              pending?.executionId === result.executionId ? null : pending
            );
            writeRecovery(store, operation.prompt, null);
            if (fromNewSlot) {
              newStartOperationRef.current = null;
              setPendingNewStart(null);
              setNewConversationOpen(true);
            } else {
              recoveryOperationRef.current = null;
              setScopedPendingRecoveryOperation(null, selectedExecutionAtStart);
            }
            draftRef.current = operation.prompt;
            setDraft(operation.prompt);
            setInitialPrompt(operation.prompt);
            setStatus(
              "The previous Conversation start was canceled. Its initial prompt is restored; starting again will create a new attempt."
            );
            setError(null);
            return;
          }
          if (
            result.commandState === "completed" &&
            operation.prompt &&
            result.initialPromptCommandId
          ) {
            const conversationStore =
              fromNewSlot && recoveryScope
                ? createDeviceManagedChatRecoveryStore({
                    ...recoveryScope,
                    executionId: result.executionId
                  })
                : store;
            const childOperation: DeviceManagedChatPendingOperation = {
              ...operation,
              kind: "prompt",
              state: "reconciling",
              promptIdempotencyKey: `managed-conversation-start-prompt:${result.commandId}`,
              commandId: result.initialPromptCommandId,
              executionGeneration: result.executionGeneration
            };
            writeRecovery(conversationStore, "", childOperation);
            recoveryStoreRef.current = conversationStore;
            if (fromNewSlot) {
              store?.clear();
              newStartOperationRef.current = null;
              setPendingNewStart(null);
            }
            recoveryOperationRef.current = childOperation;
            selectedIdRef.current = result.executionId;
            setScopedPendingRecoveryOperation(
              childOperation,
              result.executionId
            );
            setSelectedId(result.executionId);
            setRuntime(null);
            setMessages([]);
            setPendingMessage(null);
            setNewConversationOpen(false);
            setInitialPrompt("");
            await refreshList(signal);
            await reconcilePromptOperation(
              childOperation,
              result.executionId,
              conversationStore,
              signal
            );
            return;
          }
          if (
            result.commandState === "completed" &&
            operation.prompt &&
            !result.initialPromptCommandId
          ) {
            const conversationStore =
              fromNewSlot && recoveryScope
                ? createDeviceManagedChatRecoveryStore({
                    ...recoveryScope,
                    executionId: result.executionId
                  })
                : store;
            writeRecovery(conversationStore, operation.prompt, null);
            recoveryStoreRef.current = conversationStore;
            if (fromNewSlot) store?.clear();
            newStartOperationRef.current = null;
            setPendingNewStart(null);
            recoveryOperationRef.current = null;
            setScopedPendingRecoveryOperation(null, result.executionId);
            draftRef.current = operation.prompt;
            setDraft(operation.prompt);
            selectedIdRef.current = result.executionId;
            setSelectedId(result.executionId);
            setRuntime(null);
            setMessages([]);
            setPendingMessage(null);
            setNewConversationOpen(false);
            setInitialPrompt("");
            setStatus(
              "This older Conversation start did not accept its initial message. The message is restored as a draft; send it when you are ready."
            );
            await refreshList(signal);
            return;
          }
          const retainAcceptedIdentity = !disposition.clearIdentity;
          const retainedOperation = {
            ...operation,
            state: "reconciling" as const,
            commandId: result.commandId
          };
          if (fromNewSlot && recoveryScope) {
            const conversationStore = createDeviceManagedChatRecoveryStore({
              ...recoveryScope,
              executionId: result.executionId
            });
            writeRecovery(
              conversationStore,
              "",
              retainAcceptedIdentity ? retainedOperation : null
            );
            recoveryStoreRef.current = conversationStore;
            store?.clear();
            newStartOperationRef.current = null;
            setPendingNewStart(null);
            recoveryOperationRef.current = retainAcceptedIdentity
              ? retainedOperation
              : null;
            setScopedPendingRecoveryOperation(
              retainAcceptedIdentity ? retainedOperation : null,
              result.executionId
            );
          } else {
            writeRecovery(
              store,
              "",
              retainAcceptedIdentity ? retainedOperation : null
            );
            recoveryStoreRef.current = store;
            recoveryOperationRef.current = retainAcceptedIdentity
              ? retainedOperation
              : null;
            setScopedPendingRecoveryOperation(
              retainAcceptedIdentity ? retainedOperation : null,
              result.executionId
            );
          }
          draftRef.current = "";
          setDraft("");
          selectedIdRef.current = result.executionId;
          setSelectedId(result.executionId);
          setRuntime(null);
          setMessages([]);
          setPendingMessage(null);
          await refreshList(signal);
          const value = await loadHostedManagedConversation(
            result.executionId,
            signal
          );
          if (
            !signal?.aborted &&
            selectedIdRef.current === result.executionId
          ) {
            setRuntime(value.runtime);
            setMessages(value.state.messages);
            setPendingMessage(
              operation.prompt && disposition.showPendingMessage
                ? {
                    id: operation.clientUserMessageId,
                    executionId: result.executionId,
                    role: "user",
                    content: operation.prompt,
                    createdAt: new Date().toISOString(),
                    author: null,
                    commandId: result.commandId,
                    commandState: result.commandState
                  }
                : null
            );
            setNewConversationOpen(false);
            setInitialPrompt("");
            setStatus(
              result.commandState === "queued" ||
                result.commandState === "blocked"
                ? "The previous Conversation start was accepted and is still pending on its assigned runner."
                : result.commandState === "dispatching"
                  ? "The previous Conversation start was accepted and the runner has claimed it."
                  : "The previous Conversation start completed; its persisted state is shown."
            );
          }
        } else {
          const unresolved = { ...operation, state: "reconciling" as const };
          writeRecovery(store, operation.prompt, unresolved);
          if (fromNewSlot) {
            newStartOperationRef.current = unresolved;
            setPendingNewStart(unresolved);
          } else {
            recoveryOperationRef.current = unresolved;
            setScopedPendingRecoveryOperation(
              unresolved,
              selectedExecutionAtStart
            );
          }
          setInitialPrompt(operation.prompt);
          setStatus(
            "Koed has not found this Conversation start yet. Its initial prompt and send identity are retained; Studio will not start it again. Check status again before continuing."
          );
        }
      } catch (cause) {
        if (
          signal?.aborted ||
          !hostedRecoverySelectionIsCurrent(
            selectedExecutionAtStart,
            selectedIdRef.current
          )
        )
          return;
        const unresolved = { ...operation, state: "reconciling" as const };
        writeRecovery(store, operation.prompt, unresolved);
        if (fromNewSlot) {
          newStartOperationRef.current = unresolved;
          setPendingNewStart(unresolved);
        } else {
          recoveryOperationRef.current = unresolved;
          setScopedPendingRecoveryOperation(
            unresolved,
            selectedExecutionAtStart
          );
        }
        setStatus(
          "Studio could not verify the previous Conversation start. Its send identity and prompt are saved; Studio will not start it again."
        );
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not verify the previous Conversation start."
        );
      } finally {
        endRecoveryCheck();
      }
    },
    [
      beginRecoveryCheck,
      recoveryScope,
      refreshList,
      writeRecovery,
      reconcilePromptOperation,
      setScopedPendingRecoveryOperation
    ]
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
    const controller = new AbortController();
    void loadHostedManagedConversationAccess(controller.signal)
      .then((access) => {
        if (controller.signal.aborted) return;
        setRecoveryScope({
          ownerId: access.ownerId,
          backendId: `${window.location.origin}:${access.backendId}`
        });
      })
      .catch((cause) => {
        if (!controller.signal.aborted) handleError(cause);
      });
    return () => controller.abort();
  }, [handleError]);

  useEffect(() => {
    if (!recoveryScope || loading || initialPromptSeeded.current) return;
    const controller = new AbortController();
    const selectedExecutionAtStart = selectedIdRef.current;
    const newConversationStore = createDeviceManagedChatRecoveryStore({
      ...recoveryScope,
      executionId: null
    });
    newStartStoreRef.current = newConversationStore;
    const recovered = newConversationStore?.read();
    const pendingStart = recovered?.pendingOperation;
    if (pendingStart?.kind === "start") {
      if (pendingStart.state === "rejected") {
        newStartOperationRef.current = null;
        queueMicrotask(() => {
          if (controller.signal.aborted) return;
          initialPromptSeeded.current = true;
          setPendingNewStart(null);
          setInitialPrompt(pendingStart.prompt);
          setNewConversationOpen(true);
          setStatus(
            "The previous Conversation start failed. Its initial prompt is restored; starting again will create a new attempt."
          );
        });
        return () => controller.abort();
      }
      newStartOperationRef.current = pendingStart;
      queueMicrotask(() => {
        if (controller.signal.aborted) return;
        initialPromptSeeded.current = true;
        setPendingNewStart(pendingStart);
        void reconcileStartOperation(
          pendingStart,
          newConversationStore,
          true,
          controller.signal
        );
      });
      return () => controller.abort();
    }
    newStartOperationRef.current = null;
    queueMicrotask(() => {
      if (controller.signal.aborted || initialPromptSeeded.current) return;
      initialPromptSeeded.current = true;
      const prompt = hostedNewStartPromptForVerifiedScope({
        recoveryRecord: recovered ?? null,
        handoffDraft: initialDraft,
        promptWasEdited: initialPromptWasEdited.current,
        selectedExecutionAtStart,
        selectedExecutionNow: selectedIdRef.current
      });
      if (prompt !== null) setInitialPrompt(prompt);
    });
    return () => controller.abort();
  }, [recoveryScope, loading, initialDraft, reconcileStartOperation]);

  useEffect(() => {
    if (!recoveryScope || !selectedId) return;
    const controller = new AbortController();
    const store = createDeviceManagedChatRecoveryStore({
      ...recoveryScope,
      executionId: selectedId
    });
    recoveryStoreRef.current = store;
    const recovered = store?.read();
    const firstSelection = recoverySelectionRef.current === undefined;
    recoverySelectionRef.current = selectedId;
    const recoveredDraft =
      recovered?.draft ?? (firstSelection ? draftRef.current : "");
    draftRef.current = recoveredDraft;
    setDraft(recoveredDraft);
    const operation = recovered?.pendingOperation ?? null;
    if (operation?.state === "rejected") {
      recoveryOperationRef.current = null;
      setScopedPendingRecoveryOperation(null, selectedId);
      if (operation.kind === "start") {
        setInitialPrompt(operation.prompt);
        setNewConversationOpen(true);
      }
      setStatus(
        operation.kind === "start"
          ? "The previous Conversation start failed. Its initial prompt is restored; starting again will create a new attempt."
          : "The previous continuation failed. Its draft is restored; sending again will create a new attempt."
      );
      return () => controller.abort();
    }
    recoveryOperationRef.current = operation;
    setScopedPendingRecoveryOperation(operation, selectedId);
    if (!operation) return () => controller.abort();
    if (operation.kind === "prompt") {
      void reconcilePromptOperation(
        operation,
        selectedId,
        store,
        controller.signal
      );
    } else {
      void reconcileStartOperation(operation, store, false, controller.signal);
    }
    return () => controller.abort();
  }, [
    recoveryScope,
    selectedId,
    reconcilePromptOperation,
    reconcileStartOperation,
    setScopedPendingRecoveryOperation
  ]);

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
        setJobMarkers(
          managedAgentJobMarkers(value.state, {
            messages: value.state.messages,
            activeAgentName:
              value.state.participants?.find(
                (participant) =>
                  participant.agentId === value.state.activeAgentId
              )?.name ?? null,
            projects: launchOptions?.projects.map((project) => ({
              id: project.id,
              name: project.name
            }))
          })
        );
        setJobMarkersExecutionId(selectedId);
        setError(null);
        setStatus(null);
        setPendingMessage((pending) =>
          pending &&
          value.state.messages.some((message) => message.id === pending.id)
            ? null
            : pending
        );
        await refreshProjectMove(selectedId, controller.signal);
        const operation = recoveryOperationRef.current;
        const command = value.runtime.latestCommand;
        const commandSettled =
          command?.id === operation?.commandId &&
          ["completed", "failed", "canceled", "indeterminate"].includes(
            command?.state ?? ""
          );
        if (
          operation &&
          (commandSettled ||
            (operation.kind === "start" &&
              value.runtime.execution.state === "running"))
        ) {
          const store = recoveryStoreRef.current;
          if (operation.kind === "start") {
            await reconcileStartOperation(
              operation,
              store,
              false,
              controller.signal
            );
          } else {
            await reconcilePromptOperation(
              operation,
              selectedId,
              store,
              controller.signal
            );
          }
        }
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
  }, [
    handleError,
    refreshProjectMove,
    selectedId,
    reconcileStartOperation,
    reconcilePromptOperation,
    launchOptions
  ]);

  const selected = useMemo(
    () => executions.find((execution) => execution.id === selectedId) ?? null,
    [executions, selectedId]
  );
  const selectedRuntime = runtime?.execution.id === selectedId ? runtime : null;
  useEffect(() => {
    const attempt = teamSummaryAttempt.current;
    const command = selectedRuntime?.latestCommand;
    if (
      !attempt ||
      attempt.executionId !== selectedId ||
      command?.id !== attempt.commandId
    )
      return;
    if (command.state === "completed") {
      const draft = teamSummaryReplyForTurn(messages, attempt.userMessageId);
      if (draft) {
        setTeamSummaryState({ status: "ready", text: draft.slice(0, 2_000) });
        teamSummaryAttempt.current = null;
      }
    } else if (command.state === "failed" || command.state === "canceled") {
      setTeamSummaryState({ status: "error", text: "" });
      teamSummaryAttempt.current = null;
    }
  }, [
    messages,
    selectedId,
    selectedRuntime?.latestCommand,
    teamSummaryAttemptRevision
  ]);
  const draftTeamSummary = async (
    request: import("@koed/shared/team-agent-requests").TeamAgentRequest
  ) => {
    if (
      !selectedRuntime ||
      request.status !== "accepted" ||
      !["succeeded", "failed", "canceled"].includes(request.jobStatus ?? "") ||
      !request.jobId
    )
      return;
    setTeamSummaryState({ status: "drafting", text: "" });
    try {
      const result = await send(
        false,
        {
          purpose: "team_summary_draft",
          teamSummary: {
            teamId: teamRequestTeamId ?? request.teamId,
            requestId: request.id,
            jobId: request.jobId
          }
        },
        "Draft a summary for my review"
      );
      if (!result) throw new Error("The private summary draft was not queued.");
      teamSummaryAttempt.current = {
        executionId: selectedRuntime.execution.id,
        ...result
      };
      setTeamSummaryAttemptRevision((revision) => revision + 1);
    } catch (failure) {
      setTeamSummaryState({ status: "error", text: "" });
      handleError(failure);
    }
  };
  const shareTeamQuestion = async (
    request: import("@koed/shared/team-agent-requests").TeamAgentRequest,
    text: string,
    clientMessageId: string
  ) => {
    if (request.status !== "accepted" || !request.channelId)
      throw new Error(
        "Questions can only be posted for accepted work in its originating channel."
      );
    const receipt = await teamCollaborationClient.sendMessage(
      request.teamId,
      request.channelId,
      text,
      clientMessageId,
      request.originRootMessageId
    );
    if (receipt.message.delivery !== "sent")
      throw new Error(
        "The question send is still being reconciled. Retry this same reviewed question before editing it."
      );
    if (receipt.acceptedBody !== text)
      throw new Error(
        "The question receipt did not match this reviewed text. The send remains unconfirmed."
      );
  };
  const handleTeamReviewSaved = useCallback(
    (
      review: import("@koed/shared/team-agent-requests").TeamAgentRequestReview
    ) => {
      setTeamRequestReviewVersion(review.version);
      setTeamRequestReviewSaved(Boolean(review.privateGoal.trim()));
      if (
        teamRequestId &&
        teamRequestTeamId &&
        typeof window !== "undefined" &&
        window.location.search.includes("teamReviewVersion=")
      ) {
        const params = new URLSearchParams(window.location.search);
        if (params.get("teamReviewVersion") !== String(review.version)) {
          params.set("teamReviewVersion", String(review.version));
          router.replace(`${window.location.pathname}?${params.toString()}`);
        }
      }
    },
    [router, teamRequestId, teamRequestTeamId]
  );
  const activeMemoryRecall =
    memoryRecallFailure?.kind === "start"
      ? newConversationOpen
        ? memoryRecallFailure
        : null
      : memoryRecallFailure?.executionId === selectedId
        ? memoryRecallFailure
        : null;
  const recoveryGuard = hostedRecoveryGuardForSelection({
    selectedExecutionId: selectedId,
    pendingOperationExecutionId: pendingRecoveryOperation
      ? pendingRecoveryExecutionId
      : null,
    checkingExecutionIds: Object.keys(recoveryCheckCounts).filter(
      (executionId) => executionId !== "__new_conversation__"
    )
  });
  const newStartRecoveryChecking =
    (recoveryCheckCounts.__new_conversation__ ?? 0) > 0;
  const currentRecoveryChecking = pendingNewStart
    ? newStartRecoveryChecking
    : recoveryGuard.isChecking;
  const pendingRecoveryForSelection = recoveryGuard.hasPendingOperation
    ? pendingRecoveryOperation
    : null;
  const latestCommand = selectedRuntime?.latestCommand;
  const activePrompt = Boolean(
    latestCommand?.commandKind === "prompt" &&
    latestCommand.state === "dispatching"
  );
  const pendingControl = Boolean(
    (latestCommand?.commandKind === "stop" ||
      latestCommand?.commandKind === "interrupt") &&
    ["queued", "blocked", "dispatching"].includes(latestCommand.state)
  );
  const canSend =
    recoveryScope !== null &&
    selectedRuntime?.execution.state === "running" &&
    !activePrompt &&
    !(
      latestCommand?.commandKind === "prompt" &&
      ["queued", "blocked"].includes(latestCommand.state)
    ) &&
    !hostedPromptOutcomeIsUncertain(selectedRuntime) &&
    !pendingControl &&
    !recoveryGuard.isChecking &&
    pendingRecoveryForSelection === null;
  const canStop = selectedRuntime?.execution.state === "running";
  const canCancelQueuedPrompt =
    canCancelManagedConversationPrompt(latestCommand);
  const pendingStart =
    latestCommand?.commandKind === "start" &&
    ["blocked", "queued"].includes(latestCommand.state);
  const pendingPrompt =
    latestCommand?.commandKind === "prompt" &&
    ["queued", "blocked"].includes(latestCommand.state);
  const canCancelStart = pendingStart;
  const launchDeviceInstances = hostedLaunchInstancesForDevice(
    launchOptions,
    launchDeviceId
  );
  const launchInstance = launchDeviceInstances.find(
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
  const launchAgentDefaultAvailable = Boolean(
    launchAgent?.defaultProvider &&
    launchAgent.defaultModel &&
    launchDeviceInstances.some(
      (instance) =>
        instance.driverId === launchAgent.defaultProvider &&
        instance.models.some((model) => model.id === launchAgent.defaultModel)
    )
  );
  const launchCanStart = Boolean(
    recoveryScope &&
    (!teamRequestId || Boolean(selectedId) || teamRequestReviewSaved) &&
    launchOptions &&
    launchOptions.runners.some((item) => item.deviceId === launchDeviceId) &&
    (launchProjectId === "" ||
      launchOptions.projects.some((item) => item.id === launchProjectId)) &&
    launchInstance &&
    launchModel &&
    launchReasoningEffortValid &&
    launchPermission &&
    launchInstance.permissionModes.includes(launchPermission) &&
    (!initialAgentId ||
      (launchAgent?.lifecycle === "active" &&
        initialPrompt.trim().length > 0 &&
        (launchAgentDefaultAvailable ||
          confirmedAgentModelFor === launchAgent.id)))
  );
  const displayMessages = useMemo(() => {
    const withTransientOutput = hostedMessagesWithTransientOutput(
      selectedId,
      selectedRuntime,
      messages
    );
    return hostedMessagesForSelection(
      selectedId,
      selectedRuntime?.execution.id ?? null,
      withTransientOutput,
      pendingMessage
    );
  }, [messages, pendingMessage, selectedId, selectedRuntime]);
  const runtimeRequests = useMemo(
    () => pendingChatRequests(selectedRuntime),
    [selectedRuntime]
  );

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
          setJobMarkers(
            managedAgentJobMarkers(value.state, {
              messages: value.state.messages,
              activeAgentName:
                value.state.participants?.find(
                  (participant) =>
                    participant.agentId === value.state.activeAgentId
                )?.name ?? null,
              projects: launchOptions?.projects.map((project) => ({
                id: project.id,
                name: project.name
              }))
            })
          );
          setJobMarkersExecutionId(id);
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

  const send = async (
    continueWithoutMemory = false,
    purpose?: {
      purpose: "team_summary_draft";
      teamSummary: { teamId: string; requestId: string; jobId: string };
    },
    promptOverride?: string
  ) => {
    const prompt = (promptOverride ?? draft).trim();
    if (
      !selected ||
      !selectedRuntime ||
      !prompt ||
      !canSend ||
      hostedPromptOutcomeIsUncertain(selectedRuntime) ||
      sending ||
      pendingRecoveryForSelection
    )
      return;
    setSending(true);
    setError(null);
    setMemoryRecallFailure(null);
    setStatus(null);
    let agentAttribution:
      | { agentId: string; expectedAgentVersion: number }
      | undefined;
    try {
      const ownerState = await loadHostedManagedConversation(selected.id);
      agentAttribution =
        hostedActiveAgentAttribution(ownerState.state) ?? undefined;
      if (continueWithoutMemory && !agentAttribution)
        throw new Error(
          "Continue without Memory is available only for an active Agent Job."
        );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not verify this Conversation’s active Agent."
      );
      setSending(false);
      return;
    }
    const store = recoveryStoreRef.current;
    const operation: DeviceManagedChatPendingOperation = {
      kind: "prompt",
      startIdempotencyKey: crypto.randomUUID(),
      promptIdempotencyKey: crypto.randomUUID(),
      clientUserMessageId: crypto.randomUUID(),
      executionGeneration: selectedRuntime.execution.executionGeneration,
      prompt,
      state: "pending"
    };
    const messageId = operation.clientUserMessageId;
    try {
      if (!store?.writeDurably)
        throw new Error("Device recovery storage is unavailable.");
      store.writeDurably({
        schemaVersion: 1,
        draft: prompt,
        pendingOperation: operation
      });
    } catch {
      setError(
        "Studio could not save the send identity on this device. Nothing was sent; try again."
      );
      setSending(false);
      return;
    }
    setRecoveryOperation(operation, store, prompt);
    try {
      const command = await queueHostedConversationPrompt(
        selectedRuntime.execution,
        prompt,
        {
          idempotencyKey: operation.promptIdempotencyKey,
          clientUserMessageId: messageId,
          ...agentAttribution
        },
        undefined,
        fetch,
        {
          ...(continueWithoutMemory
            ? { continueWithoutMemory: true as const }
            : {}),
          ...(purpose ?? {})
        }
      );
      if (selectedIdRef.current !== selected.id) return;
      const acceptedOperation = {
        ...operation,
        state: "accepted" as const,
        commandId: command.commandId
      };
      setRecoveryOperation(acceptedOperation, store, "");
      draftRef.current = "";
      setDraft("");
      setPendingMessage({
        id: messageId,
        executionId: selected.id,
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
      await reconcilePromptOperation(acceptedOperation, selected.id, store);
      return { commandId: command.commandId, userMessageId: messageId };
    } catch (cause) {
      if (
        cause instanceof HostedManagedChatError &&
        cause.code === "MEMORY_RECALL_UNAVAILABLE"
      ) {
        recoveryOperationRef.current = null;
        writeRecovery(store, prompt, null);
        setMemoryRecallFailure({
          kind: "prompt",
          executionId: selected.id,
          agentId: agentAttribution?.agentId ?? null
        });
        setError(cause.message);
      } else {
        const unresolved = { ...operation, state: "reconciling" as const };
        setRecoveryOperation(unresolved, store, prompt);
        await reconcilePromptOperation(unresolved, selected.id, store);
      }
      if (
        cause instanceof HostedManagedChatError &&
        [401, 403].includes(cause.status ?? 0)
      )
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
        setStatus("Pending message canceled before the runner claimed it.");
      } else {
        setPendingMessage((current) =>
          current ? { ...current, commandState: result.state } : current
        );
        setStatus(
          result.state === "dispatching"
            ? "The runner claimed this message before cancellation. Use Stop in the composer to interrupt its active turn."
            : `Message is ${result.state}; cancellation was not confirmed.`
        );
      }
      const value = await loadHostedManagedConversation(selected.id);
      if (selectedIdRef.current === selected.id) {
        setRuntime(value.runtime);
        setMessages(value.state.messages);
      }
    } catch (cause) {
      if (cause instanceof HostedManagedChatError && cause.status === 409) {
        try {
          const value = await loadHostedManagedConversation(selected.id);
          if (selectedIdRef.current === selected.id) {
            setRuntime(value.runtime);
            setMessages(value.state.messages);
            const command = value.runtime.latestCommand;
            setStatus(
              command?.commandKind === "prompt" &&
                command.state === "dispatching"
                ? "The runner claimed this message before cancellation. Use Stop in the composer to interrupt its active turn."
                : `Cancellation lost the race; the persisted message state is ${command?.state ?? "unavailable"}.`
            );
          }
        } catch (refreshCause) {
          handleError(refreshCause);
        }
      } else {
        handleError(cause);
      }
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
        `${action === "interrupt" ? "Turn interrupt" : "End session"} accepted · waiting for runner status.`
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

  const respondToRuntimeRequest = async (
    itemId: string,
    response: {
      decision?: "accept" | "acceptForSession" | "decline" | "cancel";
      answers?: Record<string, string[]>;
    }
  ) => {
    if (!selectedRuntime || controlBusy) return;
    const item = selectedRuntime.items.find(
      (candidate) => candidate.id === itemId
    );
    if (!item) return;
    setControlBusy(true);
    setError(null);
    setStatus(null);
    try {
      await respondToHostedRuntimeItem(
        selectedRuntime.execution,
        item,
        response
      );
      const value = await loadHostedManagedConversation(
        selectedRuntime.execution.id
      );
      if (selectedIdRef.current === selectedRuntime.execution.id) {
        setRuntime(value.runtime);
        setMessages(value.state.messages);
        setStatus(
          "Response submitted · showing the latest runner request state."
        );
      }
    } catch (cause) {
      if (
        cause instanceof HostedManagedChatError &&
        [404, 409].includes(cause.status ?? 0)
      ) {
        try {
          const value = await loadHostedManagedConversation(
            selectedRuntime.execution.id
          );
          if (selectedIdRef.current === selectedRuntime.execution.id) {
            setRuntime(value.runtime);
            setMessages(value.state.messages);
            setRuntimeRequestNotice({
              executionId: selectedRuntime.execution.id
            });
          }
        } catch (refreshCause) {
          handleError(refreshCause);
        }
      } else {
        handleError(cause);
      }
    } finally {
      setControlBusy(false);
    }
  };

  const endConversation = () => {
    setConversationMenuOpen(false);
    if (
      !selectedRuntime ||
      !canStop ||
      !window.confirm(
        "End this session? The active turn will stop and this conversation session will end."
      )
    )
      return;
    void control("stop");
  };

  const checkRecoveryStatus = () => {
    if (
      (newStartOperationRef.current && newStartRecoveryChecking) ||
      (recoveryOperationRef.current && recoveryGuard.isChecking)
    )
      return;
    const newStart = newStartOperationRef.current;
    if (newStart) {
      void reconcileStartOperation(newStart, newStartStoreRef.current, true);
      return;
    }
    const operation = recoveryOperationRef.current;
    if (!operation) return;
    if (operation.kind === "start") {
      void reconcileStartOperation(operation, recoveryStoreRef.current, false);
    } else if (selectedIdRef.current) {
      void reconcilePromptOperation(
        operation,
        selectedIdRef.current,
        recoveryStoreRef.current
      );
    }
  };

  const openNewConversation = useCallback(
    async (agentId?: string) => {
      setNewConversationOpen(true);
      setError(null);
      setMemoryRecallFailure(null);
      setLaunchAgentError(null);
      let selectedAgent: PersonalAgent | null = null;
      if (!agentId) {
        setLaunchAgent(null);
        setConfirmedAgentModelFor(null);
      }
      if (agentId) {
        setLaunchAgentLoading(true);
        setConfirmedAgentModelFor(null);
        try {
          selectedAgent = await personalAgentsHttpAdapter.get(agentId);
          if (selectedAgent.lifecycle !== "active") {
            throw new Error("Retired Agents cannot start a new Conversation.");
          }
          setLaunchAgent(selectedAgent);
        } catch (cause) {
          setLaunchAgent(null);
          setLaunchAgentError(
            cause instanceof Error
              ? cause.message
              : "The selected Agent could not be loaded."
          );
        } finally {
          setLaunchAgentLoading(false);
        }
      }
      if (launchOptionsLoadInFlightRef.current) return;
      launchOptionsLoadInFlightRef.current = true;
      setLaunchLoading(true);
      try {
        const options = await loadHostedLaunchOptions();
        setLaunchOptions(options);
        const currentSelection = {
          projectId: launchProjectId,
          deviceId: launchDeviceId,
          instanceId: launchInstanceId,
          modelId: launchModelId,
          effort: launchEffort,
          permission: launchPermission
        };
        let preferredSelection = currentSelection;
        if (selectedAgent?.defaultProvider && selectedAgent.defaultModel) {
          const matchingInstance = options.instances.find(
            (instance) =>
              instance.driverId === selectedAgent?.defaultProvider &&
              instance.models.some(
                (model) => model.id === selectedAgent?.defaultModel
              )
          );
          const matchingModel = matchingInstance?.models.find(
            (model) => model.id === selectedAgent?.defaultModel
          );
          if (matchingInstance && matchingModel) {
            preferredSelection = {
              ...currentSelection,
              deviceId: matchingInstance.runnerDeviceId,
              instanceId: matchingInstance.instanceId,
              modelId: matchingModel.id,
              effort:
                selectedAgent.defaultReasoningEffort &&
                matchingModel.supportedReasoningEfforts.includes(
                  selectedAgent.defaultReasoningEffort
                )
                  ? selectedAgent.defaultReasoningEffort
                  : (matchingModel.supportedReasoningEfforts[0] ?? ""),
              permission:
                matchingInstance.permissionModes[0] ??
                currentSelection.permission
            };
          }
        }
        const selection = hostedLaunchSelectionForOptions(
          options,
          preferredSelection
        );
        setLaunchProjectId(selection.projectId);
        setLaunchDeviceId(selection.deviceId);
        setLaunchInstanceId(selection.instanceId);
        setLaunchModelId(selection.modelId);
        setLaunchEffort(selection.effort);
        setLaunchPermission(selection.permission);
      } catch (cause) {
        handleError(cause);
      } finally {
        launchOptionsLoadInFlightRef.current = false;
        setLaunchLoading(false);
      }
    },
    [
      handleError,
      launchDeviceId,
      launchEffort,
      launchInstanceId,
      launchModelId,
      launchPermission,
      launchProjectId
    ]
  );

  useEffect(() => {
    if (!initialNewConversation || initialNewConversationHandled.current)
      return;
    initialNewConversationHandled.current = true;
    void openNewConversation(initialAgentId);
  }, [initialAgentId, initialNewConversation, openNewConversation]);

  const createConversation = async (continueWithoutMemory = false) => {
    if (
      !launchCanStart ||
      !launchInstance ||
      !launchModel ||
      !recoveryScope ||
      pendingNewStart ||
      newStartRecoveryChecking
    )
      return;
    if (
      continueWithoutMemory &&
      (!initialAgentId || launchAgent?.lifecycle !== "active")
    ) {
      setError(
        "Continue without Memory is available only for an active Agent Job."
      );
      return;
    }
    setSending(true);
    setError(null);
    setMemoryRecallFailure(null);
    setStatus(null);
    const prompt = initialPrompt.trim();
    const store =
      newStartStoreRef.current ??
      (recoveryScope
        ? createDeviceManagedChatRecoveryStore({
            ...recoveryScope,
            executionId: null
          })
        : null);
    newStartStoreRef.current = store;
    const operation: DeviceManagedChatPendingOperation = {
      kind: "start",
      startIdempotencyKey: crypto.randomUUID(),
      promptIdempotencyKey: crypto.randomUUID(),
      clientUserMessageId: crypto.randomUUID(),
      prompt,
      state: "pending"
    };
    newStartOperationRef.current = operation;
    try {
      if (!store?.writeDurably)
        throw new Error("Device recovery storage is unavailable.");
      store.writeDurably({
        schemaVersion: 1,
        draft: prompt,
        pendingOperation: operation
      });
    } catch {
      newStartOperationRef.current = null;
      setError(
        "Studio could not save the send identity on this device. Nothing was sent; try again."
      );
      setSending(false);
      return;
    }
    setPendingNewStart(operation);
    writeRecovery(store, prompt, operation);
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
        idempotencyKey: operation.startIdempotencyKey,
        ...(initialAgentId && launchAgent
          ? {
              agentId: launchAgent.id,
              expectedAgentVersion: launchAgent.currentVersion
            }
          : {}),
        ...(teamRequestId &&
        teamRequestTeamId &&
        typeof teamRequestExpectedRequestVersion === "number" &&
        Number.isSafeInteger(teamRequestExpectedRequestVersion) &&
        typeof teamRequestReviewVersion === "number" &&
        Number.isSafeInteger(teamRequestReviewVersion)
          ? {
              teamAgentRequest: {
                teamId: teamRequestTeamId,
                requestId: teamRequestId,
                expectedRequestVersion: teamRequestExpectedRequestVersion,
                expectedReviewVersion: teamRequestReviewVersion
              }
            }
          : {}),
        ...(prompt
          ? {
              initialPrompt: prompt,
              initialPromptClientUserMessageId: operation.clientUserMessageId
            }
          : {}),
        ...(continueWithoutMemory
          ? { continueWithoutMemory: true as const }
          : {})
      });
      router.replace(
        retainTeamRequestContext(
          started.execution.id,
          teamRequestId,
          teamRequestTeamId,
          teamRequestExpectedRequestVersion,
          teamRequestReviewVersion
        )
      );
      setNewConversationOpen(false);
      selectedIdRef.current = started.execution.id;
      recoveryOperationRef.current = null;
      setScopedPendingRecoveryOperation(null, started.execution.id);
      setSelectedId(started.execution.id);
      setRuntime({
        execution: started.execution,
        items: [],
        latestCommand: {
          id: started.commandId,
          state: started.commandState,
          commandKind: "start",
          canCancelBeforeClaim: false,
          lastErrorCode: null
        }
      });
      setMessages([]);
      setPendingMessage(
        prompt
          ? {
              id: operation.clientUserMessageId,
              executionId: started.execution.id,
              role: "user",
              content: prompt,
              createdAt: new Date().toISOString(),
              author: null,
              commandId: started.commandId,
              commandState: started.commandState
            }
          : null
      );
      setInitialPrompt("");
      const acceptedOperation = {
        ...operation,
        state: "accepted" as const,
        commandId: started.commandId
      };
      newStartOperationRef.current = acceptedOperation;
      setPendingNewStart(acceptedOperation);
      writeRecovery(store, prompt, acceptedOperation);
      setStatus(
        started.commandState === "queued" || started.commandState === "blocked"
          ? "Pending · Koed accepted the Conversation start. Device eligibility does not show whether it is online."
          : "Conversation start accepted · waiting for runner status."
      );
      await reconcileStartOperation(acceptedOperation, store, true);
    } catch (cause) {
      if (
        cause instanceof HostedManagedChatError &&
        cause.code === "MEMORY_RECALL_UNAVAILABLE"
      ) {
        newStartOperationRef.current = null;
        setPendingNewStart(null);
        writeRecovery(store, prompt, null);
        setMemoryRecallFailure({
          kind: "start",
          agentId:
            initialAgentId && launchAgent?.lifecycle === "active"
              ? launchAgent.id
              : null
        });
        setError(cause.message);
        setSending(false);
        return;
      }
      if (cause instanceof HostedManagedChatError && cause.status === 403)
        setLaunchOptions(null);
      const unresolved = { ...operation, state: "reconciling" as const };
      newStartOperationRef.current = unresolved;
      setPendingNewStart(unresolved);
      await reconcileStartOperation(unresolved, store, true);
      if (
        cause instanceof HostedManagedChatError &&
        [401, 403].includes(cause.status ?? 0)
      )
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
    <>
      {teamRequestId && teamRequestTeamId ? (
        <TeamAgentRequestReviewPanel
          teamId={teamRequestTeamId}
          requestId={teamRequestId}
          executionId={selectedRuntime?.execution.id ?? null}
          client={teamAgentRequestsClient}
          onAuthorizationLost={onAuthorizationLost}
          onAccepted={() => {
            void refresh();
          }}
          onReviewSaved={handleTeamReviewSaved}
          summaryDraftStatus={teamSummaryState.status}
          summaryDraftText={teamSummaryState.text}
          onDraftSummary={(request) => void draftTeamSummary(request)}
          questionDraft={teamQuestionDraft}
          onQuestionDraftConsumed={() => setTeamQuestionDraft("")}
          onShareQuestion={shareTeamQuestion}
        />
      ) : null}
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
              Continue managed Conversations from your Koed devices. Messages
              and controls use your signed-in Koed session.
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
                onClick={() => {
                  setNewConversationOpen(false);
                  setMemoryRecallFailure(null);
                  setError(null);
                }}
                aria-label="Close New Conversation"
                className="rounded p-1 text-muted hover:bg-surface-hover"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {initialAgentId && (
              <div className="mb-3 rounded-md border border-border bg-surface/60 px-3 py-2 text-xs">
                {launchAgentLoading ? (
                  <p className="text-muted">Loading the selected Agent…</p>
                ) : launchAgentError ? (
                  <p role="alert" className="text-danger">
                    {launchAgentError}
                  </p>
                ) : launchAgent ? (
                  <>
                    <p className="font-medium text-foreground">
                      Agent · {launchAgent.name}
                    </p>
                    <p className="mt-0.5 text-muted">
                      Start a private Agent conversation. Discuss the work
                      before it becomes an assigned Job.
                    </p>
                    {!launchAgent.defaultProvider ||
                    !launchAgent.defaultModel ||
                    !launchAgentDefaultAvailable ? (
                      <p className="mt-2 text-warning">
                        {launchAgent.defaultProvider && launchAgent.defaultModel
                          ? "This Agent’s default model is unavailable on the selected computer. Choose an available model and reasoning setting for this conversation; the profile defaults will stay unchanged."
                          : "This Agent has no default model. Choose an available model and reasoning setting for this conversation; the profile will stay unchanged."}
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>
            )}
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
                        onChange={(event) => {
                          const deviceId = event.target.value;
                          setLaunchDeviceId(deviceId);
                          setConfirmedAgentModelFor(null);
                          const instance = hostedLaunchInstancesForDevice(
                            launchOptions,
                            deviceId
                          )[0];
                          const model = instance?.models[0];
                          setLaunchInstanceId(instance?.instanceId ?? "");
                          setLaunchModelId(model?.id ?? "");
                          setLaunchEffort(
                            model?.supportedReasoningEfforts[0] ?? ""
                          );
                          setLaunchPermission(
                            instance?.permissionModes[0] ?? ""
                          );
                        }}
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
                          const instance = launchDeviceInstances.find(
                            (item) => item.instanceId === instanceId
                          );
                          const model = instance?.models.find(
                            (item) => item.id === modelId
                          );
                          setLaunchInstanceId(instanceId ?? "");
                          setLaunchModelId(modelId ?? "");
                          setConfirmedAgentModelFor(launchAgent?.id ?? null);
                          setLaunchEffort(
                            model?.supportedReasoningEfforts[0] ?? ""
                          );
                          setLaunchPermission(
                            instance?.permissionModes[0] ?? ""
                          );
                        }}
                        className="mt-1 block w-full rounded-md border border-border bg-background px-2 py-2 text-xs text-foreground"
                      >
                        {launchDeviceInstances.flatMap((instance) =>
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
                  <div className="mt-3 text-[11px] text-muted">
                    <span>
                      {initialAgentId
                        ? "Private conversation prompt"
                        : "First message (optional)"}
                    </span>
                    <ChatComposer
                      placeholder={
                        initialAgentId
                          ? "Write a private prompt for this Agent…"
                          : "Add a first message or start with an empty Conversation…"
                      }
                      projectName={selectedProjectName ?? "Managed runtime"}
                      branch="managed runtime"
                      value={initialPrompt}
                      required={Boolean(initialAgentId)}
                      ariaLabel={
                        initialAgentId
                          ? "Private conversation prompt"
                          : "First message (optional)"
                      }
                      allowEnterNewline
                      showExecutionControls={false}
                      showMetaBar={false}
                      showSendButton={false}
                      sendEnabled={false}
                      onChange={(value) => {
                        initialPromptWasEdited.current = true;
                        setInitialPrompt(value);
                        const store =
                          newStartStoreRef.current ??
                          (recoveryScope
                            ? createDeviceManagedChatRecoveryStore({
                                ...recoveryScope,
                                executionId: null
                              })
                            : null);
                        newStartStoreRef.current = store;
                        writeRecovery(
                          store,
                          value,
                          newStartOperationRef.current
                        );
                      }}
                    />
                  </div>
                  <p className="mt-2 text-[10px] leading-4 text-muted">
                    Device eligibility does not show whether it is online. Model
                    choices are last known and are checked by the device when it
                    reconnects; the Conversation may remain Pending.
                  </p>
                  <button
                    type="submit"
                    disabled={
                      !launchCanStart ||
                      sending ||
                      newStartRecoveryChecking ||
                      pendingNewStart !== null
                    }
                    className="mt-3 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {sending
                      ? "Starting…"
                      : initialAgentId
                        ? "Start private conversation"
                        : "Start Conversation"}
                  </button>
                  {activeMemoryRecall?.kind === "start" ? (
                    <div
                      className="mt-2 flex flex-wrap gap-2"
                      role="group"
                      aria-label="Memory recall actions"
                    >
                      <button
                        type="button"
                        disabled={sending}
                        onClick={() => void createConversation()}
                        className="rounded border border-border px-2.5 py-1 text-[11px] text-foreground disabled:opacity-40"
                      >
                        Retry
                      </button>
                      {activeMemoryRecall.agentId ? (
                        <button
                          type="button"
                          disabled={sending}
                          onClick={() => void createConversation(true)}
                          className="rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-foreground disabled:opacity-40"
                        >
                          Continue without Memory
                        </button>
                      ) : null}
                    </div>
                  ) : null}
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
        {runtimeRequestNotice?.executionId === selectedId && (
          <div
            role="alert"
            className="mt-3 flex items-start justify-between gap-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-foreground"
          >
            <p>
              This request changed before Studio could apply your response. Your
              response was not applied; the latest request state is shown below.
            </p>
            <button
              type="button"
              className="shrink-0 text-muted underline underline-offset-2"
              onClick={() => setRuntimeRequestNotice(null)}
            >
              Dismiss
            </button>
          </div>
        )}
        {(status || pendingNewStart || pendingRecoveryForSelection) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
            <p role="status">
              {status ??
                (pendingNewStart
                  ? "A previous Conversation start is saved. Check its status before starting another."
                  : "A previous continuation is saved. Check its status before sending again.")}
            </p>
            {(pendingNewStart || pendingRecoveryForSelection) && (
              <button
                className="rounded border border-border px-2 py-1 text-[11px] text-foreground-secondary hover:bg-surface-hover disabled:opacity-50"
                disabled={currentRecoveryChecking}
                onClick={checkRecoveryStatus}
                type="button"
              >
                {currentRecoveryChecking
                  ? "Checking…"
                  : pendingNewStart
                    ? "Check start status"
                    : "Check send status"}
              </button>
            )}
          </div>
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
                    setMemoryRecallFailure(null);
                    setError(null);
                    selectedIdRef.current = execution.id;
                    recoveryOperationRef.current = null;
                    setScopedPendingRecoveryOperation(null, execution.id);
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
                  aria-current={
                    execution.id === selectedId ? "true" : undefined
                  }
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
                      Pending · accepted by Koed; device availability is not
                      known from this state.
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
                  {canStop && (
                    <div className="relative">
                      <button
                        type="button"
                        aria-label="Conversation menu"
                        aria-expanded={conversationMenuOpen}
                        onClick={() => setConversationMenuOpen((open) => !open)}
                        className="rounded-md p-1.5 text-foreground-secondary hover:bg-surface-hover"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                      {conversationMenuOpen && (
                        <div className="absolute right-0 z-10 mt-1 min-w-36 rounded-md border border-border bg-background p-1 shadow-lg">
                          <button
                            type="button"
                            onClick={endConversation}
                            disabled={controlBusy || pendingControl}
                            className="w-full rounded px-2 py-1.5 text-left text-xs text-foreground-secondary hover:bg-surface-hover disabled:opacity-50"
                          >
                            End session…
                          </button>
                        </div>
                      )}
                    </div>
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
                      {moveUnavailableReason} If Move succeeds, source edits
                      stay at the source Project; if they cannot be safely
                      retained, the Move fails and the original context remains
                      unchanged.
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
              <SharedChatUI
                mode={{ kind: "agent", controls: "limited" }}
                scopeKey={`${recoveryScope?.backendId ?? "unknown-backend"}:${recoveryScope?.ownerId ?? "unknown-owner"}:${selectedId ?? "new"}`}
                messages={displayMessages}
                className="min-h-0 flex-1"
                viewportClassName="p-3"
                listClassName="space-y-3"
                composer={
                  <div className="border-t border-border p-3">
                    <ChatComposer
                      placeholder={
                        canSend
                          ? "Continue this Conversation…"
                          : "Conversation is not ready for a message"
                      }
                      projectName={
                        selectedProjectName ?? "Managed Conversation"
                      }
                      branch="managed runtime"
                      executionPreset={
                        selectedRuntime
                          ? {
                              environment: "local",
                              model:
                                selectedRuntime.execution.model ||
                                "Unavailable",
                              effort:
                                selectedRuntime.execution.reasoningEffort ??
                                "Not set",
                              access:
                                selectedRuntime.execution.permissionMode ??
                                "Unspecified"
                            }
                          : undefined
                      }
                      value={draft}
                      onChange={updateDraft}
                      onSend={async (
                        _text,
                        _selection,
                        continueWithoutMemory
                      ) => {
                        await send(continueWithoutMemory === true);
                      }}
                      sendEnabled={canSend && !sending && !activePrompt}
                      sendDisabledReason={
                        error ??
                        status ??
                        "Conversation is not ready for a message"
                      }
                      interruptActive={Boolean(activePrompt)}
                      interruptDisabled={
                        selectedRuntime?.execution.state !== "running" ||
                        controlBusy ||
                        pendingControl
                      }
                      onInterrupt={() => void control("interrupt")}
                      showExecutionControls={Boolean(selectedRuntime)}
                      showMetaBar={false}
                      memoryRecallFailure={
                        activeMemoryRecall?.kind === "prompt"
                          ? "Memory could not be checked. Your draft is still here."
                          : null
                      }
                      showContinueWithoutMemory={Boolean(
                        activeMemoryRecall?.agentId
                      )}
                      footer="Pending means Koed accepted the message. It does not show whether the device is online."
                    />
                  </div>
                }
                renderMessage={(message) => (
                  <AgentChatMessage message={message} compact>
                    {teamRequestId &&
                    message.role === "assistant" &&
                    message.content.trim() &&
                    !message.id.startsWith("transient:") ? (
                      <button
                        type="button"
                        onClick={() =>
                          setTeamQuestionDraft(message.content.slice(0, 2_000))
                        }
                        className="mt-2 rounded-md border border-border px-2 py-1 text-[10px] text-subtle hover:bg-surface-hover"
                      >
                        Prepare Team question
                      </button>
                    ) : null}
                    {message.role === "assistant" && message.memory ? (
                      <MemoryAttributionNote
                        key={`memory:${recoveryScope?.backendId ?? "no-backend"}:${recoveryScope?.ownerId ?? "no-owner"}:${selectedId ?? "no-execution"}:${message.id}`}
                        memory={message.memory}
                        messageId={message.id}
                        feedbackAccess={
                          selectedId && recoveryScope
                            ? {
                                ...recoveryScope,
                                executionId: selectedId,
                                load: (messageId, signal) =>
                                  loadHostedRecallFeedback(
                                    selectedId,
                                    messageId,
                                    signal
                                  ),
                                update: (messageId, change, signal) =>
                                  updateHostedRecallFeedback(
                                    selectedId,
                                    messageId,
                                    change,
                                    signal
                                  )
                              }
                            : undefined
                        }
                      />
                    ) : null}
                    {message.id.startsWith("transient:") && (
                      <p className="mt-1 text-[10px] text-muted" role="status">
                        {hostedPromptOutcomeIsUncertain(selectedRuntime)
                          ? "Partial response · outcome uncertain"
                          : "Streaming response"}
                      </p>
                    )}
                    {message.id === pendingMessage?.id && (
                      <p className="mt-1 text-[10px] text-muted">
                        {pendingMessage?.commandState === "dispatching"
                          ? "Working · claimed by the assigned computer"
                          : ["queued", "blocked"].includes(
                                pendingMessage?.commandState ?? ""
                              )
                            ? "Pending · accepted by Koed"
                            : "Outcome uncertain · check send status"}
                      </p>
                    )}
                  </AgentChatMessage>
                )}
                childrenAfter={
                  <>
                    {runtimeRequests.map((request) => {
                      const item = selectedRuntime?.items.find(
                        (candidate) => candidate.id === request.id
                      );
                      if (!item) return null;
                      const sessionApproval =
                        item.payload.supportsSessionApproval === true;
                      const approvalCanBeReviewed =
                        hasMeaningfulHostedApprovalDetails(request);
                      const visibleDetails = request.details.filter(
                        (detail) =>
                          detail.label !== "Working directory" &&
                          detail.label !== "Grant root"
                      );
                      return (
                        <article
                          key={request.id}
                          className="rounded-lg border border-border bg-surface p-3"
                          aria-label={
                            request.kind === "user_input"
                              ? "Pending agent question"
                              : "Pending agent permission"
                          }
                        >
                          <p className="text-xs font-semibold text-foreground">
                            {request.kind === "user_input"
                              ? "The AI Client needs your input"
                              : request.kind === "permissions_approval"
                                ? "Approve permissions?"
                                : request.kind === "file_approval"
                                  ? "Approve file changes?"
                                  : "Approve command?"}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap break-words text-xs text-foreground-secondary">
                            {request.description}
                          </p>
                          {visibleDetails.map((detail, index) => (
                            <div
                              className="mt-2"
                              key={`${detail.label}:${index}`}
                            >
                              <p className="text-[10px] font-medium text-muted">
                                {detail.label}
                              </p>
                              <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-[11px] leading-4 text-foreground-secondary">
                                {detail.text}
                              </pre>
                            </div>
                          ))}
                          {request.kind === "user_input" ? (
                            request.questions?.length ? (
                              <form
                                className="mt-3 space-y-2"
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  const values = new FormData(
                                    event.currentTarget
                                  );
                                  const answers = Object.fromEntries(
                                    (request.questions ?? []).map(
                                      (question) => {
                                        const answer = String(
                                          values.get(question.id) ?? ""
                                        );
                                        const options =
                                          question.options?.map(
                                            (option) => option.label
                                          ) ?? [];
                                        return [
                                          question.id,
                                          [
                                            question.isOther &&
                                            answer &&
                                            !options.includes(answer)
                                              ? `user_note: ${answer}`
                                              : answer
                                          ]
                                        ];
                                      }
                                    )
                                  );
                                  void respondToRuntimeRequest(request.id, {
                                    answers
                                  });
                                }}
                              >
                                {(request.questions ?? []).map((question) => (
                                  <label
                                    className="block text-[11px] text-foreground-secondary"
                                    key={question.id}
                                  >
                                    <span>
                                      {question.header || question.question}
                                    </span>
                                    {question.header && question.question ? (
                                      <span className="mt-0.5 block text-muted">
                                        {question.question}
                                      </span>
                                    ) : null}
                                    {question.options?.length &&
                                    !question.isOther ? (
                                      <select
                                        className="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                                        name={question.id}
                                        required={question.required !== false}
                                        defaultValue=""
                                      >
                                        <option disabled value="">
                                          Select an answer
                                        </option>
                                        {question.options.map((option) => (
                                          <option
                                            key={option.label}
                                            value={option.label}
                                          >
                                            {option.label}
                                          </option>
                                        ))}
                                      </select>
                                    ) : (
                                      <input
                                        className="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                                        name={question.id}
                                        required={question.required !== false}
                                        type={
                                          question.isSecret
                                            ? "password"
                                            : "text"
                                        }
                                      />
                                    )}
                                  </label>
                                ))}
                                <button
                                  className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-medium text-accent-foreground disabled:opacity-50"
                                  disabled={controlBusy}
                                  type="submit"
                                >
                                  <Check className="h-3 w-3" /> Submit answer
                                </button>
                              </form>
                            ) : (
                              <p
                                className="mt-3 text-[11px] text-muted"
                                role="status"
                              >
                                The latest question details are unavailable.
                                Refresh before responding.
                              </p>
                            )
                          ) : approvalCanBeReviewed ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                className="rounded-md border border-border px-2.5 py-1.5 text-[11px] text-foreground-secondary disabled:opacity-50"
                                disabled={controlBusy}
                                onClick={() =>
                                  void respondToRuntimeRequest(request.id, {
                                    decision: "decline"
                                  })
                                }
                                type="button"
                              >
                                Deny
                              </button>
                              <button
                                className="rounded-md border border-border px-2.5 py-1.5 text-[11px] text-foreground-secondary disabled:opacity-50"
                                disabled={controlBusy}
                                onClick={() =>
                                  void respondToRuntimeRequest(request.id, {
                                    decision: "cancel"
                                  })
                                }
                                type="button"
                              >
                                Cancel request
                              </button>
                              <button
                                className="rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-medium text-accent-foreground disabled:opacity-50"
                                disabled={controlBusy}
                                onClick={() =>
                                  void respondToRuntimeRequest(request.id, {
                                    decision: "accept"
                                  })
                                }
                                type="button"
                              >
                                Approve
                              </button>
                              {sessionApproval ? (
                                <button
                                  className="rounded-md border border-border px-2.5 py-1.5 text-[11px] text-foreground-secondary disabled:opacity-50"
                                  disabled={controlBusy}
                                  onClick={() =>
                                    void respondToRuntimeRequest(request.id, {
                                      decision: "acceptForSession"
                                    })
                                  }
                                  type="button"
                                >
                                  Always allow this session
                                </button>
                              ) : null}
                            </div>
                          ) : (
                            <p
                              className="mt-3 text-[11px] text-muted"
                              role="status"
                            >
                              Koed did not provide enough safe request detail to
                              review this approval. Refresh before deciding.
                            </p>
                          )}
                        </article>
                      );
                    })}
                    {selectedRuntime &&
                      displayMessages.length === 0 &&
                      runtimeRequests.length === 0 && (
                        <p className="text-xs text-muted">
                          No messages in this Conversation yet.
                        </p>
                      )}
                  </>
                }
              >
                {!selectedRuntime && (
                  <p className="text-xs text-muted">
                    Loading live Conversation…
                  </p>
                )}
                {jobMarkersExecutionId === selectedId &&
                  jobMarkers.map((job) => (
                    <article
                      key={`job:${job.id}`}
                      className="mx-auto w-full max-w-3xl rounded-lg border border-border bg-surface/70 px-3 py-2 text-xs text-foreground-secondary"
                    >
                      <p className="font-medium text-foreground">
                        Job · {job.state.replaceAll("_", " ")}
                      </p>
                      <p className="mt-1">
                        {job.agentName} · {job.projectName}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap break-words text-muted">
                        {job.goal}
                      </p>
                    </article>
                  ))}
              </SharedChatUI>
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
    </>
  );
}
