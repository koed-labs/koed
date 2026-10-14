"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { managedConversationActivity } from "@/lib/managed-agent-activity";
import {
  managedChatProgress,
  managedChatProgressHistory
} from "@/lib/agent-chat-progress";
import type { RuntimeSnapshot } from "@/lib/managed-agent-chat";
import { resolvePersonalChatRecipients } from "@/lib/personal-conversation-launch";
import { useRouter } from "next/navigation";
import type {
  PersonalAgentChatConversation,
  PersonalAgentChatSubmit
} from "@koed/shared/personal-agent-chat-contract";
import type { AgentModelCapability } from "@/lib/agentIdentityEditor";
import {
  cancelPersonalConversationMessage,
  continuePersonalConversationMessage,
  readPersonalConversation,
  PersonalConversationError,
  renamePersonalConversation,
  submitPersonalConversationMessage
} from "@/lib/personal-conversations-client";
import {
  personalAgentsHttpAdapter,
  parseAvatar
} from "@/lib/personal-agents-client";
import {
  createDeviceManagedChatRecoveryStore,
  type DeviceManagedChatPendingOperation,
  type DeviceManagedChatRecoveryStore
} from "@/lib/device-managed-chat-recovery";
import {
  loadHostedConversationDiff,
  loadHostedLaunchOptions,
  loadHostedManagedConversation,
  HostedManagedChatError,
  loadHostedManagedConversationAccess,
  requestHostedConversationControl,
  type HostedLaunchOptions
} from "@/lib/hosted-managed-chats";
import type { PersonalAgent } from "@/lib/personal-agents-client";
import type {
  ChatComposerRestoreSelection,
  ChatComposerSelection
} from "@/components/ChatComposer";
import {
  NewChatView,
  type NewChatRuntime,
  type NewChatRuntimeMessage
} from "@/components/studio/NewChatView";
import { conversationDiffEvent } from "@/lib/conversation-build-diff";
import type { BuildActivity } from "@/lib/studio-build-activity";

type Props = {
  conversationId?: string;
  initialAgentId?: string;
  initialDraft?: string;
  onBack: () => void;
};

export function hostedPersonalMentionAgent(agent: PersonalAgent) {
  return {
    id: agent.id,
    currentVersion: agent.currentVersion,
    name: agent.name,
    role: agent.role,
    avatar: agent.avatar,
    lifecycle: agent.lifecycle,
    defaultProvider: agent.defaultProvider,
    defaultModel: agent.defaultModel,
    defaultReasoningEffort: agent.defaultReasoningEffort
  };
}

function persistedAgentSelections(
  conversation: PersonalAgentChatConversation
): Record<string, ChatComposerRestoreSelection> {
  return Object.fromEntries(
    conversation.participants.map((participant) => {
      const launch = participant.launch;
      return [
        participant.agentId,
        {
          key: `${conversation.conversationId}:${participant.agentId}:${participant.agentVersion}`,
          provider: launch.provider,
          model: launch.model,
          effort: launch.reasoningEffort,
          permissionMode:
            launch.permissionMode === "supervised" ? "ask" : "full",
          hostedInstanceId: launch.aiClientInstanceId
        }
      ];
    })
  );
}

function mapMessages(
  conversation: PersonalAgentChatConversation,
  agents: readonly PersonalAgent[]
): NewChatRuntimeMessage[] {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  return conversation.messages.map((message) => {
    const author = message.authorAgentId
      ? agentsById.get(message.authorAgentId)
      : undefined;
    return {
      id: message.id,
      sequence: message.sequence,
      role: message.kind === "user" ? "user" : "assistant",
      content: message.text + (message.truncated ? "\n[Output truncated]" : ""),
      createdAt: Date.parse(message.createdAt),
      author:
        message.kind === "agent_reply"
          ? {
              agentId:
                message.authorAgentId ??
                `provider:${message.provider ?? "generic"}`,
              name: message.authorName ?? message.provider ?? "AI Client",
              avatar: author?.avatar ? parseAvatar(author.avatar) : undefined
            }
          : null
    };
  });
}

function mergeMessages(
  current: readonly NewChatRuntimeMessage[],
  incoming: readonly NewChatRuntimeMessage[]
) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(
    (left, right) =>
      (left.sequence ?? 0) - (right.sequence ?? 0) ||
      left.createdAt - right.createdAt
  );
}

export function resolveHostedPersonalRecipients(
  selection: ChatComposerSelection,
  options: HostedLaunchOptions,
  agents: readonly PersonalAgent[]
): PersonalAgentChatSubmit["recipients"] {
  return resolvePersonalChatRecipients(selection, options.instances, agents);
}

async function fingerprint(value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value))
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function HostedPersonalConversationChat({
  conversationId: initialConversationId,
  initialAgentId,
  initialDraft = "",
  onBack
}: Props) {
  const router = useRouter();
  const [agents, setAgents] = useState<PersonalAgent[]>([]);
  const agentsRef = useRef<PersonalAgent[]>([]);
  const [launchOptions, setLaunchOptions] =
    useState<HostedLaunchOptions | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(
    initialConversationId ?? null
  );
  const [conversation, setConversation] =
    useState<PersonalAgentChatConversation | null>(null);
  const conversationRef = useRef<PersonalAgentChatConversation | null>(null);
  const [messages, setMessages] = useState<NewChatRuntimeMessage[]>([]);
  const [draft, setDraft] = useState(initialDraft);
  const latestDraft = useRef(initialDraft);
  const sendInFlight = useRef(false);
  const [projectDraft, setProjectDraft] = useState("");
  const [activeAgentId, setActiveAgentId] = useState<string | null>(
    initialAgentId ?? null
  );
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(initialConversationId));
  const [sending, setSending] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [diffLoadingId, setDiffLoadingId] = useState<string | null>(null);
  const [activity, setActivity] = useState<BuildActivity | null>(null);
  const [nativeActivity, setNativeActivity] = useState<BuildActivity | null>(
    null
  );
  const [nativeRuntime, setNativeRuntime] = useState<RuntimeSnapshot | null>(
    null
  );
  const [recoveryScope, setRecoveryScope] = useState<{
    ownerId: string;
    backendId: string;
  } | null>(null);
  const recoveryStore = useRef<DeviceManagedChatRecoveryStore | null>(null);
  const recoveryOperation = useRef<DeviceManagedChatPendingOperation | null>(
    null
  );
  const hydratedConversationId = useRef<string | null>(null);
  const requestRead = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const invalidateAccess = useCallback(() => {
    requestRead.current += 1;
    abortRef.current?.abort();
    recoveryStore.current = null;
    recoveryOperation.current = null;
    conversationRef.current = null;
    agentsRef.current = [];
    latestDraft.current = "";
    setConversation(null);
    setMessages([]);
    setAgents([]);
    setLaunchOptions(null);
    setRecoveryScope(null);
    setNativeRuntime(null);
    setNativeActivity(null);
    setActivity(null);
    setDraft("");
    setProjectDraft("");
    setHasOlderMessages(false);
    setActiveAgentId(null);
    setLoading(false);
    setSending(false);
    setBlocked(true);
    setRetryAvailable(false);
    setError(
      "Access to this chat changed. Sign in again or reopen an authorized conversation."
    );
  }, []);

  const refresh = useCallback(
    async (id: string, mode: "tail" | "older" = "tail") => {
      const sequence = ++requestRead.current;
      let root: Awaited<ReturnType<typeof readPersonalConversation>>;
      try {
        root = await readPersonalConversation(id, {
          limit: 100,
          signal: abortRef.current?.signal
        });
      } catch (cause) {
        if (
          cause instanceof PersonalConversationError &&
          [401, 403, 404].includes(cause.status ?? 0)
        )
          invalidateAccess();
        throw cause;
      }
      if (sequence !== requestRead.current) return;
      const loadedConversation = root.conversation;
      conversationRef.current = loadedConversation;
      setConversation(loadedConversation);
      setHasOlderMessages(root.timelinePage.hasMore);
      setMessages((current) =>
        mergeMessages(
          current,
          mapMessages(loadedConversation, agentsRef.current)
        )
      );
      if (mode === "tail") {
        const pending = recoveryOperation.current;
        const admitted = Boolean(
          pending?.personalSubmit &&
          loadedConversation.messages.some(
            (message) => message.requestId === pending.personalSubmit?.requestId
          )
        );
        if (admitted) {
          recoveryOperation.current = null;
          setRetryAvailable(false);
          setBlocked(false);
          const store = recoveryStore.current;
          const latestDraft = store?.read()?.draft ?? "";
          store?.write({
            schemaVersion: 1,
            personalConversationId: id,
            draft: latestDraft
          });
        } else if (pending?.personalSubmit) {
          setRetryAvailable(true);
          setBlocked(true);
        }
        const uncertain =
          loadedConversation.status === "uncertain" ||
          loadedConversation.deliveries.some(
            (delivery) => delivery.status === "uncertain"
          );
        setBlocked((current) => current || uncertain);
        const busy = loadedConversation.deliveries.some((delivery) =>
          ["queued", "starting", "running"].includes(delivery.status)
        );
        if (hydratedConversationId.current !== id) {
          hydratedConversationId.current = id;
          setActiveAgentId(loadedConversation.activeAgentId);
        }
        setSending(busy);
        if (busy) setStatus("Agents are working");
        else if (uncertain) setStatus("Delivery outcome uncertain");
        else setStatus("");
      }
      setLoading(false);
      const executionId = loadedConversation.activeExecutionId;
      if (mode === "tail" && !executionId) {
        setNativeRuntime(null);
        setNativeActivity(null);
      }
      if (mode === "tail" && executionId) {
        try {
          const observed = await loadHostedManagedConversation(
            executionId,
            abortRef.current?.signal
          );
          if (
            sequence !== requestRead.current ||
            abortRef.current?.signal.aborted
          )
            return;
          setNativeRuntime(observed.runtime);
          setNativeActivity(
            managedConversationActivity(
              observed.state as unknown as Record<string, unknown>,
              observed.runtime
            )
          );
        } catch (cause) {
          if (
            cause instanceof HostedManagedChatError &&
            [401, 403].includes(cause.status ?? 0)
          ) {
            invalidateAccess();
            return;
          }
          if (
            sequence === requestRead.current &&
            !abortRef.current?.signal.aborted
          ) {
            setNativeRuntime(null);
            setNativeActivity({ source: "live", state: "unknown", events: [] });
          }
        }
      }
    },
    [invalidateAccess]
  );

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    void Promise.all([
      personalAgentsHttpAdapter.list(controller.signal),
      loadHostedLaunchOptions(),
      loadHostedManagedConversationAccess(controller.signal)
    ])
      .then(async ([availableAgents, options, access]) => {
        if (controller.signal.aborted) return;
        agentsRef.current = availableAgents;
        setAgents(availableAgents);
        setLaunchOptions(options);
        setRecoveryScope({
          ownerId: access.ownerId,
          backendId: `${window.location.origin}:${access.backendId}`
        });
        const initialId = initialConversationId;
        const store = createDeviceManagedChatRecoveryStore({
          ownerId: access.ownerId,
          backendId: `${window.location.origin}:${access.backendId}`,
          executionId: initialId ?? null
        });
        recoveryStore.current = store;
        if (!initialId) {
          await store?.writeDurably?.({
            schemaVersion: 1,
            draft: initialDraft
          });
        }
        const recovered = store?.read();
        const operation = recovered?.pendingOperation;
        if (operation?.personalSubmit) {
          recoveryOperation.current = operation;
          setRetryAvailable(true);
          setBlocked(true);
          latestDraft.current = recovered?.draft || operation.prompt;
          setDraft(latestDraft.current);
        } else if (!initialDraft && recovered?.draft) {
          latestDraft.current = recovered.draft;
          setDraft(recovered.draft);
        }
        if (!controller.signal.aborted && initialId) {
          try {
            await refresh(initialId);
          } catch (cause) {
            setLoading(false);
            if (operation?.personalSubmit) setRetryAvailable(true);
            setError(
              cause instanceof Error
                ? cause.message
                : "This chat could not be loaded."
            );
          }
        } else {
          setLoading(false);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Personal chat is unavailable."
          );
      });
    return () => {
      controller.abort();
      requestRead.current += 1;
    };
  }, [initialConversationId, initialDraft, refresh]);

  useEffect(() => {
    if (!conversationId || !launchOptions || !agents.length) return;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        await refresh(conversationId);
      } catch {
        // Keep the durable timeline visible; the next bounded refresh retries.
      }
      if (!controller.signal.aborted)
        timeout = setTimeout(() => {
          void poll();
        }, 4_000);
    };
    timeout = setTimeout(() => {
      void poll();
    }, 4_000);
    return () => {
      controller.abort();
      if (timeout) clearTimeout(timeout);
    };
  }, [agents.length, conversationId, launchOptions, refresh]);

  useEffect(() => {
    recoveryStore.current?.write({
      schemaVersion: 1,
      ...(conversationId ? { personalConversationId: conversationId } : {}),
      draft,
      ...(recoveryOperation.current
        ? { pendingOperation: recoveryOperation.current }
        : {})
    });
  }, [conversationId, draft]);

  const modelOptions: AgentModelCapability[] = useMemo(
    () =>
      (launchOptions?.instances ?? []).flatMap((instance) =>
        instance.ready
          ? instance.models.map((model) => ({
              provider: instance.driverId,
              id: model.id,
              displayName: model.displayName,
              instanceId: instance.instanceId,
              ...(instance.hostedInstanceId
                ? { hostedInstanceId: instance.hostedInstanceId }
                : {}),
              targetDeviceId: instance.runnerDeviceId,
              supportedReasoningEfforts: model.supportedReasoningEfforts
            }))
          : []
      ),
    [launchOptions]
  );
  const restoreAgentSelections = useMemo(
    () => (conversation ? persistedAgentSelections(conversation) : undefined),
    [conversation]
  );
  const restoreSelection = useMemo(() => {
    if (!conversation || !activeAgentId) return undefined;
    return restoreAgentSelections?.[activeAgentId];
  }, [activeAgentId, conversation, restoreAgentSelections]);
  const projectId = conversation?.projectId ?? (projectDraft || null);
  const projectName =
    launchOptions?.projects.find((project) => project.id === projectId)?.name ??
    "Personal";

  const applySubmission = (
    submitted: Awaited<ReturnType<typeof submitPersonalConversationMessage>>
  ) => {
    const root = submitted.conversation;
    setConversationId(root.conversationId);
    conversationRef.current = root;
    setConversation(root);
    hydratedConversationId.current = root.conversationId;
    setActiveAgentId(root.activeAgentId);
    setMessages((current) => mergeMessages(current, mapMessages(root, agents)));
    setRetryAvailable(false);
    setBlocked(root.status === "uncertain");
    setSending(
      root.deliveries.some((delivery) =>
        ["queued", "starting", "running"].includes(delivery.status)
      )
    );
    const remainingDraft =
      latestDraft.current === recoveryOperation.current?.prompt
        ? ""
        : latestDraft.current;
    recoveryOperation.current = null;
    recoveryStore.current?.write({
      schemaVersion: 1,
      personalConversationId: root.conversationId,
      draft: remainingDraft
    });
    latestDraft.current = remainingDraft;
    setDraft(remainingDraft);
    setError(null);
    setStatus("Agent batch accepted");
    router.replace(
      `/?chat=1&conversation=${encodeURIComponent(root.conversationId)}`
    );
    void refresh(root.conversationId).catch(() =>
      setStatus("Accepted · reconnecting to progress")
    );
    return { commandId: submitted.deliveries[0]?.commandId ?? undefined };
  };

  const send = async (text: string, selection: ChatComposerSelection) => {
    if (sendInFlight.current)
      throw new Error("A submission is already in progress.");
    if (blocked || retryAvailable)
      throw new Error(
        "Reconcile or retry the saved send before sending another message."
      );
    setActivity(null);
    if (!launchOptions)
      throw new Error("Hosted AI Client launch options are unavailable.");
    const recipients = resolveHostedPersonalRecipients(
      selection,
      launchOptions,
      agents
    );
    const id = conversationId ?? crypto.randomUUID();
    const sourceExecutionId = undefined;
    const currentProjectId = conversation?.projectId ?? (projectDraft || null);
    const contextKind: PersonalAgentChatSubmit["context"]["contextKind"] =
      currentProjectId ? "project" : "independent";
    const bodyWithoutId = {
      text,
      ...(sourceExecutionId ? { sourceExecutionId } : {}),
      context: {
        projectId: currentProjectId,
        contextKind,
        targetDeviceId: recipients[0]!.targetDeviceId
      },
      recipients
    };
    const requestId = crypto.randomUUID();
    const request: PersonalAgentChatSubmit = { requestId, ...bodyWithoutId };
    const requestFingerprint = await fingerprint({
      conversationId: id,
      ...bodyWithoutId
    });
    const operation: DeviceManagedChatPendingOperation = {
      kind: "start",
      startIdempotencyKey: crypto.randomUUID(),
      promptIdempotencyKey: requestId,
      clientUserMessageId: crypto.randomUUID(),
      prompt: text,
      requestFingerprint,
      personalSubmit: request,
      state: "pending"
    };
    const scope = recoveryScope;
    const store = scope
      ? createDeviceManagedChatRecoveryStore({ ...scope, executionId: id })
      : null;
    if (!store?.writeDurably)
      throw new Error("Hosted chat recovery is unavailable. Nothing was sent.");
    store.writeDurably({
      schemaVersion: 1,
      personalConversationId: id,
      draft: latestDraft.current,
      pendingOperation: operation
    });
    recoveryStore.current = store;
    recoveryOperation.current = operation;
    sendInFlight.current = true;
    setRetryAvailable(false);
    setSending(true);
    setError(null);
    try {
      const submitted = await submitPersonalConversationMessage(
        id,
        request,
        abortRef.current?.signal
      );
      return applySubmission(submitted);
    } catch (cause) {
      if (
        cause instanceof PersonalConversationError &&
        [401, 403].includes(cause.status ?? 0)
      ) {
        invalidateAccess();
        return undefined;
      }
      recoveryOperation.current = operation;
      setConversationId(id);
      router.replace(`/?chat=1&conversation=${encodeURIComponent(id)}`);
      setRetryAvailable(true);
      setBlocked(true);
      setSending(false);
      setError(
        cause instanceof Error
          ? cause.message
          : "The delivery could not be confirmed."
      );
      setStatus("Saved send needs reconciliation");
      return undefined;
    } finally {
      sendInFlight.current = false;
    }
  };

  const retry = async () => {
    const operation = recoveryOperation.current;
    const request = operation?.personalSubmit;
    const id = conversationId;
    if (!operation || !request || !id) return;
    setRetryAvailable(false);
    setSending(true);
    setError(null);
    try {
      const submitted = await submitPersonalConversationMessage(
        id,
        request,
        abortRef.current?.signal
      );
      return applySubmission(submitted);
    } catch (cause) {
      setRetryAvailable(true);
      setBlocked(true);
      setSending(false);
      setError(
        cause instanceof Error
          ? cause.message
          : "The saved send could not be confirmed."
      );
    }
  };

  const loadOlder = async () => {
    const id = conversationId;
    const oldest = conversationRef.current?.messages[0]?.sequence;
    const sequence = requestRead.current;
    const signal = abortRef.current?.signal;
    if (!id || !oldest) return;
    try {
      const page = await readPersonalConversation(id, {
        beforeSequence: oldest,
        limit: 100,
        signal
      });
      if (signal?.aborted || sequence !== requestRead.current) return;
      setMessages((current) =>
        mergeMessages(current, mapMessages(page.conversation, agents))
      );
      setHasOlderMessages(page.timelinePage.hasMore);
    } catch (cause) {
      if (
        cause instanceof PersonalConversationError &&
        [401, 403, 404].includes(cause.status ?? 0)
      ) {
        invalidateAccess();
        return;
      }
      if (signal?.aborted || sequence !== requestRead.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Older messages could not be loaded."
      );
    }
  };

  const stopBatch = async () => {
    const root = conversationRef.current;
    const id = conversationId;
    const latestUser = [...(root?.messages ?? [])]
      .reverse()
      .find((message) => message.kind === "user");
    if (!root || !id || !latestUser) return;
    try {
      const activeExecutionId = root.activeExecutionId;
      const result = await cancelPersonalConversationMessage(
        id,
        latestUser.id,
        crypto.randomUUID(),
        abortRef.current?.signal
      );
      conversationRef.current = result.conversation;
      setConversation(result.conversation);
      if (activeExecutionId) {
        const child = await loadHostedManagedConversation(
          activeExecutionId,
          abortRef.current?.signal
        );
        await requestHostedConversationControl(
          child.runtime.execution,
          "interrupt",
          crypto.randomUUID(),
          abortRef.current?.signal
        );
      }
      setSending(false);
      setStatus("This batch was stopped.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? `Batch stop was not confirmed: ${cause.message}`
          : "Batch stop was not confirmed."
      );
    }
  };

  const showDiff = async (deliveryId: string) => {
    const delivery = conversationRef.current?.deliveries.find(
      (candidate) => candidate.id === deliveryId
    );
    if (
      !delivery?.executionId ||
      !delivery.commandId ||
      !delivery.diffAvailable
    )
      return;
    setDiffLoadingId(delivery.id);
    try {
      const child = await loadHostedManagedConversation(
        delivery.executionId,
        abortRef.current?.signal
      );
      const runtime = {
        ...child.runtime,
        latestCommand: {
          id: delivery.commandId,
          state: "completed",
          commandKind: "prompt",
          lastErrorCode: null
        }
      };
      const payload = await loadHostedConversationDiff(
        delivery.executionId,
        delivery.commandId,
        abortRef.current?.signal
      );
      const event = conversationDiffEvent(payload, runtime);
      setActivity({
        source: "live",
        state: "completed",
        events: event
          ? [event]
          : [
              {
                id: `diff-unavailable:${delivery.id}`,
                kind: "message",
                technical: {
                  status:
                    "No saved changes are available for this Agent response."
                }
              }
            ],
        ...(event ? { recentTurnChanges: event } : {}),
        availability: event ? "available" : "unavailable"
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The saved changes could not be loaded."
      );
    } finally {
      setDiffLoadingId(null);
    }
  };

  const rename = async (title: string | null) => {
    if (!conversationId) return;
    const result = await renamePersonalConversation(
      conversationId,
      title,
      crypto.randomUUID(),
      abortRef.current?.signal
    );
    conversationRef.current = result.conversation;
    setConversation(result.conversation);
  };

  const continueDelivery = async (messageId: string, deliveryId: string) => {
    if (!conversationId) return;
    try {
      const result = await continuePersonalConversationMessage(
        conversationId,
        messageId,
        crypto.randomUUID(),
        deliveryId,
        abortRef.current?.signal
      );
      conversationRef.current = result.conversation;
      setConversation(result.conversation);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The remaining Agent could not be resumed."
      );
    }
  };

  const runtime: NewChatRuntime = {
    enabled: Boolean(
      launchOptions &&
      !loading &&
      !sending &&
      !blocked &&
      !retryAvailable &&
      modelOptions.length
    ),
    status: error ?? status,
    messages,
    isSending: sending,
    error,
    progress: nativeRuntime ? managedChatProgress(nativeRuntime) : null,
    progressHistory: nativeRuntime
      ? managedChatProgressHistory(nativeRuntime)
      : [],
    onSend: async (text, selection) => {
      await send(text, selection);
    },
    restoreSelection,
    restoreAgentSelections,
    personalConversation:
      conversation || retryAvailable
        ? {
            status: conversation?.status ?? "Previous send needs confirmation",
            retryAvailable,
            deliveries: (conversation?.deliveries ?? []).map((delivery) => ({
              id: delivery.id,
              ordinal: delivery.ordinal,
              name: delivery.agentName ?? "AI Client",
              status: delivery.status,
              progress:
                delivery.progress?.summary ?? delivery.progress?.stage ?? null,
              error: delivery.errorCode,
              contextSummary: delivery.contextTransfer
                ? `Transferred ${delivery.contextTransfer.transferredMessages} messages${delivery.contextTransfer.omittedMessages ? ` · ${delivery.contextTransfer.omittedMessages} omitted` : ""}`
                : null,
              canContinue: delivery.canContinue,
              diffAvailable: Boolean(
                delivery.diffAvailable &&
                delivery.executionId &&
                delivery.commandId
              ),
              diffLoading: delivery.id === diffLoadingId,
              messageId: delivery.messageId
            })),
            hasOlderMessages,
            uncertain: !retryAvailable && conversation?.status === "uncertain",
            onStopBatch: conversation?.deliveries.some((delivery) =>
              ["queued", "starting", "running"].includes(delivery.status)
            )
              ? stopBatch
              : undefined,
            onRetry: retryAvailable ? retry : undefined,
            onContinueDelivery: continueDelivery,
            onShowDiff: showDiff,
            onLoadOlder: hasOlderMessages ? loadOlder : undefined
          }
        : undefined,
    onRenameConversation: conversationId ? rename : undefined
  };

  const projectSelector = (
    <div className="flex items-center gap-2">
      <select
        aria-label="Conversation Project"
        aria-describedby={
          conversationId ? "conversation-project-lock" : undefined
        }
        value={projectId ?? ""}
        disabled={Boolean(conversationId)}
        onChange={(event) => setProjectDraft(event.target.value)}
        className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
      >
        <option value="">Standalone</option>
        {(launchOptions?.projects ?? []).map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      {conversationId ? (
        <span
          id="conversation-project-lock"
          role="note"
          className="text-[10px] text-muted"
        >
          Project context is fixed for this chat.
        </span>
      ) : null}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded px-2 py-1 text-xs text-foreground-secondary hover:bg-surface-hover"
        >
          Back to Conversations
        </button>
        {loading ? (
          <span className="text-xs text-muted">Loading chat…</span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        <NewChatView
          mode="live"
          conversationTitle={
            conversation?.title ??
            (conversationId ? "Personal chat" : "New chat")
          }
          conversationProjectName={projectId ? projectName : null}
          projectName={projectName}
          projectSelector={projectSelector}
          initialDraft={initialDraft}
          recoveredDraft={draft}
          agents={agents
            .filter((agent) => agent.lifecycle === "active")
            .map(hostedPersonalMentionAgent)}
          activeAgentId={activeAgentId}
          onActiveAgentChange={setActiveAgentId}
          onAgentMention={setActiveAgentId}
          allowMultipleAgentMentions
          modelOptions={modelOptions}
          conversationScopeKey={conversationId ?? "new-hosted-personal-chat"}
          runtime={runtime}
          activity={activity ?? nativeActivity}
          onDraftChange={(value) => {
            latestDraft.current = value;
            setDraft(value);
          }}
        />
      </div>
    </div>
  );
}
