import { startupMark } from "../../startup-marks.js";
import type { Agent } from "@koed/shared/agent-contract";
import type { KoedTextActionProjection } from "@koed/shared";
import { Pixelkin } from "../agents/Pixelkin.js";
import { ArrowUp, Paperclip, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MarkdownPlatformAdapters } from "@koed/memory-ui";
import type { PersonalDesktopProjectThread } from "@koed/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type { ProjectHqConversationDesktopApi } from "../../../ipc/project-hq-conversation-protocol.js";
import type {
  ManagedConversationDesktopApi,
  ManagedConversationIdentity,
  ManagedConversationLaunchOptions
} from "../../../ipc/managed-conversation-protocol.js";
import type { ManagedProjectDesktopApi } from "../../../ipc/managed-project-protocol.js";
import type { AgentsDesktopApi } from "../../../ipc/agents-protocol.js";
import type { DesktopApi } from "../../../types.js";
import {
  clearPendingDelegation,
  pendingDelegationRequestId,
  resolveAgentMention
} from "../agents/agent-delegation-intent.js";
import type { PersonalMemoryStore } from "../../state/personal-memory.js";
import type { ManagedConversationLifecycle } from "../../state/use-managed-conversation-lifecycle.js";
import {
  HqActiveConversation,
  HqConversationSettings
} from "../conversation/HqConversation.js";
import {
  hqSelectionForInstance,
  type HqSelection
} from "../conversation/hq-conversation-model.js";
import { HqVisibilityLine } from "../conversation/HqVisibilityLine.js";
import { HqUsageSuggestion } from "../usage/HqUsageSuggestion.js";
import "./hq-project-conversation.css";

/** This route owns the private HQ handle; it does not register an ordinary draft. */
export function HqProjectConversation({
  project,
  chiefName,
  chiefAgent,
  chiefInstanceId,
  localAiClients,
  usageAuthorityKey,
  usageDismissalScopeKey,
  api,
  managedConversations,
  managedProject,
  store,
  lifecycle,
  markdownAdapters,
  inspectorOpen = false,
  panelHostRef,
  contextLabel,
  documentWorkItemIntent,
  onDocumentWorkItemIntentConsumed,
  onOfferChatForget,
  onTextActionApply,
  onTextActionNativeReview,
  onTextActionResumeMove,
  onOpenDeck,
  ownerId,
  profileKey,
  onClearContext,
  agentsApi,
  helperAgents,
  ownerIdentity = "",
  catchUpEnabled = false,
  activityRevision = "",
  foreground = true,
  teamUnreadCount = 0,
  onOpenTeam,
  privateVisibilityTeamName,
  home = false
}: {
  project: DesktopProject;
  chiefName: string;
  chiefAgent?: Agent | null;
  chiefInstanceId: string | null;
  localAiClients?: DesktopApi["localAiClients"];
  usageAuthorityKey?: string;
  usageDismissalScopeKey?: string;
  api: ProjectHqConversationDesktopApi;
  managedConversations: ManagedConversationDesktopApi;
  managedProject: ManagedProjectDesktopApi | null;
  store: PersonalMemoryStore;
  lifecycle: ManagedConversationLifecycle;
  markdownAdapters: MarkdownPlatformAdapters;
  inspectorOpen?: boolean;
  panelHostRef?: (node: HTMLDivElement | null) => void;
  contextLabel?: string | null;
  documentWorkItemIntent?: {
    id: string;
    prompt: string;
    sourceId: string;
  } | null;
  onDocumentWorkItemIntentConsumed?: (id: string) => void;
  onClearContext?: () => void;
  onOfferChatForget?: (sourceSessionId: string) => Promise<boolean>;
  onTextActionApply?: (action: KoedTextActionProjection) => Promise<boolean>;
  onTextActionNativeReview?: (action: KoedTextActionProjection) => void;
  onTextActionResumeMove?: (
    action: KoedTextActionProjection
  ) => Promise<boolean>;
  onOpenDeck?: (target: { projectId: string; deckId: string }) => void;
  ownerId?: string;
  profileKey?: string;
  agentsApi?: AgentsDesktopApi | null;
  helperAgents?: readonly Agent[];
  ownerIdentity?: string;
  /** Enabled only after the trusted catch-up migration and terminal proof. */
  catchUpEnabled?: boolean;
  activityRevision?: string;
  foreground?: boolean;
  teamUnreadCount?: number;
  onOpenTeam?: () => void;
  privateVisibilityTeamName?: string | null;
  /** Solo's Now: the one conversation with the Chief of Staff, not a Project's. */
  home?: boolean;
}) {
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [conversation, setConversation] =
    useState<ManagedConversationIdentity | null>(null);
  const [graphIdentity, setGraphIdentity] = useState<{
    projectId: string;
    threadId: string;
  } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [attemptedPrompt, setAttemptedPrompt] = useState<string | null>(null);
  const attemptedDocumentSourceId = useRef<string | null>(null);
  const [options, setOptions] =
    useState<ManagedConversationLaunchOptions | null>(null);
  const [selection, setSelection] = useState<HqSelection>({
    instanceId: "",
    model: "",
    reasoningEffort: "",
    permissionMode: ""
  });
  const [conflict, setConflict] = useState(false);
  const [reviewStarted, setReviewStarted] = useState(false);
  const [terminalUncaptured, setTerminalUncaptured] = useState(false);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const startedDocumentIntent = useRef<string | null>(null);
  const [delegationNotice, setDelegationNotice] = useState("");
  const [catchUpStatus, setCatchUpStatus] = useState<
    | "idle"
    | "starting"
    | "waiting"
    | "recovered"
    | "retry_available"
    | "reconciliation_required"
  >("idle");
  const [catchUpCommandId, setCatchUpCommandId] = useState<string | null>(null);
  const retryCatchUpId = useRef<{
    commandId: string;
    requestId: string;
  } | null>(null);
  const currentScope = useRef(`${ownerIdentity}:${project.id}`);
  const scopeEpoch = useRef(0);
  const idleCheckBusy = useRef<number | null>(null);
  const lastActivityRevision = useRef(activityRevision);

  const checkIdleActivity = useCallback(async () => {
    const epoch = scopeEpoch.current;
    if (idleCheckBusy.current === epoch) return;
    idleCheckBusy.current = epoch;
    const scope = currentScope.current;
    try {
      const result = await api.catchUp(project.id);
      if (currentScope.current !== scope || scopeEpoch.current !== epoch)
        return;
      if (result.executionId) setExecutionId(result.executionId);
      setCatchUpCommandId(result.commandId);
      setCatchUpStatus(
        result.status === "queued"
          ? "waiting"
          : result.status === "nothing"
            ? "idle"
            : result.status
      );
    } catch {
      if (currentScope.current !== scope || scopeEpoch.current !== epoch)
        return;
      setCatchUpStatus("reconciliation_required");
      setError("Project catch-up could not be confirmed. Check delivery.");
    } finally {
      if (idleCheckBusy.current === epoch) idleCheckBusy.current = null;
    }
  }, [api, project.id]);

  useEffect(() => {
    let live = true;
    const scope = `${ownerIdentity}:${project.id}`;
    const epoch = ++scopeEpoch.current;
    currentScope.current = scope;
    idleCheckBusy.current = null;
    lastActivityRevision.current = activityRevision;
    setLoading(true);
    setExecutionId(null);
    setConversation(null);
    setGraphIdentity(null);
    setPrompt("");
    setAttemptedPrompt(null);
    setConflict(false);
    setReviewStarted(false);
    setTerminalUncaptured(false);
    setPending(false);
    setUncertain(false);
    setError("");
    setDelegationNotice("");
    setCatchUpStatus("idle");
    setCatchUpCommandId(null);
    retryCatchUpId.current = null;
    void (async () => {
      try {
        const value = await api.reserve(project.id);
        if (
          !live ||
          currentScope.current !== scope ||
          scopeEpoch.current !== epoch
        )
          return;
        setExecutionId(value.executionId);
      } catch {
        if (
          !live ||
          currentScope.current !== scope ||
          scopeEpoch.current !== epoch
        )
          return;
        setError("Project HQ Conversation could not be opened. Retry.");
        setLoading(false);
        return;
      }
      if (catchUpEnabled) {
        try {
          const result = await api.catchUp(project.id);
          if (
            !live ||
            currentScope.current !== scope ||
            scopeEpoch.current !== epoch
          )
            return;
          if (result.executionId) setExecutionId(result.executionId);
          setCatchUpCommandId(result.commandId);
          setCatchUpStatus(
            result.status === "queued"
              ? "waiting"
              : result.status === "nothing"
                ? "idle"
                : result.status
          );
        } catch {
          if (
            live &&
            currentScope.current === scope &&
            scopeEpoch.current === epoch
          )
            setError(
              "Project catch-up is unavailable. You can still ask directly."
            );
        }
      }
      if (
        live &&
        currentScope.current === scope &&
        scopeEpoch.current === epoch
      )
        setLoading(false);
    })();
    return () => {
      live = false;
      if (scopeEpoch.current === epoch) {
        scopeEpoch.current += 1;
        idleCheckBusy.current = null;
      }
    };
  }, [api, catchUpEnabled, ownerIdentity, project.id]);

  // Personal activity does not currently emit a dedicated Project cursor
  // invalidation. Check the single foreground HQ on collaboration revision
  // and with a bounded timer; never scan every idle Project.
  useEffect(() => {
    if (lastActivityRevision.current === activityRevision) return;
    lastActivityRevision.current = activityRevision;
    if (catchUpEnabled && foreground && !loading && catchUpStatus === "idle")
      void checkIdleActivity();
  }, [
    activityRevision,
    catchUpEnabled,
    foreground,
    loading,
    catchUpStatus,
    checkIdleActivity
  ]);
  useEffect(() => {
    if (!catchUpEnabled || !foreground || loading || catchUpStatus !== "idle")
      return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = async () => {
      await checkIdleActivity();
      if (live) timer = setTimeout(() => void check(), 15_000);
    };
    timer = setTimeout(() => void check(), 15_000);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [catchUpEnabled, foreground, loading, catchUpStatus, checkIdleActivity]);

  // A cold HQ first creates the same logical execution and returns
  // "starting". Recheck until it can enqueue, then until the persisted
  // assistant reply lets the server acknowledge the exact Team window.
  useEffect(() => {
    if (
      !catchUpEnabled ||
      !["starting", "waiting", "recovered"].includes(catchUpStatus)
    )
      return;
    let live = true;
    const scope = currentScope.current;
    const epoch = scopeEpoch.current;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = async () => {
      try {
        const result = await api.catchUp(project.id);
        if (
          !live ||
          currentScope.current !== scope ||
          scopeEpoch.current !== epoch
        )
          return;
        if (result.executionId) setExecutionId(result.executionId);
        setCatchUpCommandId(result.commandId);
        const nextStatus =
          result.status === "queued"
            ? "waiting"
            : result.status === "nothing"
              ? "idle"
              : result.status;
        setCatchUpStatus(nextStatus);
        if (["starting", "waiting", "recovered"].includes(nextStatus))
          timer = setTimeout(() => void check(), 4_000);
      } catch {
        if (
          !live ||
          currentScope.current !== scope ||
          scopeEpoch.current !== epoch
        )
          return;
        setCatchUpStatus("reconciliation_required");
        setError("Project catch-up could not be confirmed. Check delivery.");
      }
    };
    timer = setTimeout(() => void check(), 4_000);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [api, catchUpEnabled, catchUpStatus, project.id]);

  useEffect(() => {
    let live = true;
    void managedConversations
      .launchOptions()
      .then(({ options: next }) => {
        if (!live) return;
        setOptions(next);
        setSelection(
          chiefInstanceId
            ? hqSelectionForInstance(next, chiefInstanceId)
            : {
                instanceId: "",
                model: "",
                reasoningEffort: "",
                permissionMode: ""
              }
        );
      })
      .catch(() => {
        if (live)
          setError(
            "Chief of Staff permissions could not be loaded. Retry opening HQ Conversation."
          );
      });
    return () => {
      live = false;
    };
  }, [managedConversations, chiefInstanceId]);

  useEffect(() => {
    if (!executionId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const inspect = async () => {
      try {
        const result = await managedConversations.inspect(executionId);
        if (!live) return;
        if (
          result.conversation &&
          result.conversation.projectId === project.id
        ) {
          const durable = await api.read(project.id);
          if (!live) return;
          if (
            durable.conversation?.executionId !== executionId ||
            durable.execution?.capturedSessionId !==
              result.conversation.capturedSessionId ||
            !durable.execution.graphProjectId ||
            !durable.execution.graphThreadId
          ) {
            setError(
              "HQ capture identity is still being verified. The Conversation will open when it is ready."
            );
            timer = setTimeout(() => void inspect(), 1_000);
            return;
          }
          setGraphIdentity({
            projectId: durable.execution.graphProjectId,
            threadId: durable.execution.graphThreadId
          });
          setConversation(result.conversation);
          setPending(false);
          return;
        } else if (result.status === "failed") {
          const durable = await api.read(project.id);
          if (!live) return;
          const execution = durable.execution;
          if (
            durable.conversation?.executionId === executionId &&
            execution?.capturedSessionId &&
            execution.threadId &&
            execution.graphProjectId &&
            execution.graphThreadId
          ) {
            setGraphIdentity({
              projectId: execution.graphProjectId,
              threadId: execution.graphThreadId
            });
            setConversation({
              executionId,
              projectId: project.id,
              capturedSessionId: execution.capturedSessionId,
              threadId: execution.threadId,
              executionOwner: {
                driverId: execution.provider as "codex" | "claude" | "pi",
                instanceId: execution.aiClientInstanceId
              }
            });
          } else {
            setTerminalUncaptured(true);
            setError(
              "This HQ execution ended before a Captured Session was available. Its first message was not automatically retried."
            );
          }
          setPending(false);
          return;
        }
      } catch {
        if (live)
          setError(
            "Project HQ Conversation status could not be confirmed. Check delivery."
          );
      }
      if (live) timer = setTimeout(() => void inspect(), 1_000);
    };
    void inspect();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [api, catchUpStatus, executionId, managedConversations, project.id]);

  const thread = useMemo<PersonalDesktopProjectThread | null>(
    () =>
      conversation
        ? {
            id: graphIdentity?.threadId ?? conversation.threadId,
            name: "HQ Conversation",
            sessionId: conversation.capturedSessionId,
            sourceAiClient:
              conversation.executionOwner?.driverId === "claude"
                ? "claude-code"
                : (conversation.executionOwner?.driverId ?? null),
            projectId: graphIdentity?.projectId ?? "unassigned",
            projectName: project.name,
            projectPath: project.path,
            projectAssignmentSource: "detected",
            eventCount: 0,
            invalidatedCount: 0,
            latestAt: new Date().toISOString(),
            sample: "",
            presentation: null
          }
        : null,
    [conversation, graphIdentity, project.name, project.path]
  );

  useEffect(
    () => (thread ? store.registerPrivateThread(thread) : undefined),
    [store, thread]
  );

  const start = async (
    retry = false,
    documentPrompt?: string,
    selectedDocumentSourceId?: string
  ) => {
    if (!retry && !(documentPrompt ?? prompt).trim()) return;
    const raw = retry ? attemptedPrompt : (documentPrompt ?? prompt);
    const mention = documentPrompt
      ? { kind: "none" as const }
      : resolveAgentMention(raw ?? "", helperAgents ?? []);
    if (mention.kind === "invalid") {
      setError(mention.message);
      return;
    }
    const text =
      mention.kind === "matched"
        ? raw
        : retry
          ? attemptedPrompt
          : (documentPrompt ??
            (contextLabel ? `About ${contextLabel}: ${prompt}` : prompt));
    if (pending || loading || !text?.trim() || (executionId && !retry)) return;
    if (mention.kind === "matched") {
      if (!agentsApi) {
        setError("Helper Agents are unavailable. Retry when they are ready.");
        return;
      }
      if (!retry) setAttemptedPrompt(raw);
      setPending(true);
      setError("");
      try {
        const scope = `${ownerIdentity}:${project.id}:cold-hq`;
        const requestId = await pendingDelegationRequestId(
          scope,
          mention.agent.id,
          mention.task
        );
        await agentsApi.delegateCold({
          projectId: project.id,
          agentId: mention.agent.id,
          requestId,
          prompt: mention.task
        });
        clearPendingDelegation(scope, requestId);
        setPrompt("");
        setAttemptedPrompt(null);
        setUncertain(false);
        setDelegationNotice(
          `${mention.agent.name} is working on this in a private Conversation.`
        );
        window.dispatchEvent(
          new CustomEvent("hq-agent-delegated", {
            detail: { projectId: project.id }
          })
        );
      } catch {
        setUncertain(true);
        setError(
          "Koed cannot confirm this Agent delegation. Check Working now, then retry the same draft to recover it."
        );
      } finally {
        setPending(false);
      }
      return;
    }
    if (!selection.permissionMode) {
      setError("Ask first is unavailable for the configured Chief of Staff.");
      return;
    }
    if (!retry) {
      setAttemptedPrompt(text);
      attemptedDocumentSourceId.current = selectedDocumentSourceId ?? null;
    }
    setPending(true);
    setError("");
    try {
      const result = await api.start(
        project.id,
        text,
        selection.permissionMode,
        retry
          ? (attemptedDocumentSourceId.current ?? undefined)
          : selectedDocumentSourceId
      );
      setExecutionId(result.executionId);
      setUncertain(false);
      setConflict(false);
      setPrompt("");
      if (contextLabel && !retry) onClearContext?.();
    } catch (cause) {
      setUncertain(true);
      const differentMessage =
        cause instanceof Error &&
        /already started with another first message|already started with another permission choice/i.test(
          cause.message
        );
      setConflict(differentMessage);
      setError(
        differentMessage
          ? "Another first message started this HQ Conversation. Your message is still here for review."
          : "Koed could not confirm delivery. Check before retrying this same message."
      );
      setPending(false);
    }
  };

  useEffect(() => {
    if (
      !documentWorkItemIntent ||
      startedDocumentIntent.current === documentWorkItemIntent.id ||
      executionId ||
      pending ||
      loading ||
      uncertain ||
      !options ||
      !selection.permissionMode
    )
      return;
    if (prompt.trim()) {
      setError(
        "Send or clear the current draft before making Work Items from a document."
      );
      return;
    }
    startedDocumentIntent.current = documentWorkItemIntent.id;
    onDocumentWorkItemIntentConsumed?.(documentWorkItemIntent.id);
    setPrompt(documentWorkItemIntent.prompt);
    void start(
      false,
      documentWorkItemIntent.prompt,
      documentWorkItemIntent.sourceId
    );
  }, [
    documentWorkItemIntent,
    onDocumentWorkItemIntentConsumed,
    executionId,
    pending,
    loading,
    uncertain,
    options,
    selection.permissionMode,
    prompt
  ]);

  const checkDelivery = async () => {
    if (
      resolveAgentMention(attemptedPrompt ?? "", helperAgents ?? []).kind ===
      "matched"
    ) {
      setError(
        "Check Working now for this Agent task, then retry the same message to confirm delivery."
      );
      return;
    }
    setLoading(true);
    setError("");
    try {
      const value = await api.read(project.id);
      setExecutionId(value.conversation?.executionId ?? null);
      if (!value.conversation?.executionId)
        setError(
          "Koed found no started HQ Conversation. Retry the same message."
        );
      else
        setError(
          "A Conversation started. Retry the same message to confirm whether yours was accepted, or open it to review your draft."
        );
    } catch {
      setError("Koed could not confirm the HQ Conversation. Check again.");
    } finally {
      setLoading(false);
    }
  };

  const checkCatchUp = async () => {
    const scope = currentScope.current;
    const epoch = scopeEpoch.current;
    try {
      const result = await api.catchUp(project.id);
      if (currentScope.current !== scope || scopeEpoch.current !== epoch)
        return;
      if (result.executionId) setExecutionId(result.executionId);
      setCatchUpCommandId(result.commandId);
      setCatchUpStatus(
        result.status === "queued"
          ? "waiting"
          : result.status === "nothing"
            ? "idle"
            : result.status
      );
      setError("");
    } catch {
      if (currentScope.current === scope && scopeEpoch.current === epoch)
        setError("Project catch-up could not be checked. Try again.");
    }
  };

  const retryCatchUp = async () => {
    if (!catchUpCommandId || pending) return;
    const scope = currentScope.current;
    const epoch = scopeEpoch.current;
    if (retryCatchUpId.current?.commandId !== catchUpCommandId)
      retryCatchUpId.current = {
        commandId: catchUpCommandId,
        requestId: crypto.randomUUID()
      };
    setPending(true);
    try {
      const result = await api.retryCatchUp(
        project.id,
        catchUpCommandId,
        retryCatchUpId.current.requestId
      );
      if (currentScope.current !== scope || scopeEpoch.current !== epoch)
        return;
      setExecutionId(result.executionId);
      setCatchUpCommandId(result.commandId);
      setCatchUpStatus(result.status === "completed" ? "recovered" : "waiting");
      setError("");
    } catch {
      if (currentScope.current === scope && scopeEpoch.current === epoch)
        setError(
          "Project catch-up Retry could not be confirmed. Check its status before retrying."
        );
    } finally {
      if (currentScope.current === scope && scopeEpoch.current === epoch)
        setPending(false);
    }
  };

  const activeConversation =
    thread && conversation && (!uncertain || reviewStarted) ? (
      <>
        <HqActiveConversation
          key={conversation.executionId}
          {...(home ? { assistantName: chiefName } : {})}
          privateProjectHq
          privateProjectHqTeamName={privateVisibilityTeamName}
          privateProjectHqIdentity={conversation}
          api={managedConversations}
          localAiClients={localAiClients}
          usageAuthorityKey={usageAuthorityKey}
          usageDismissalScopeKey={usageDismissalScopeKey}
          managedProject={managedProject}
          store={store}
          project={project}
          thread={thread}
          draft={null}
          lifecycle={lifecycle}
          onRetryStart={() => undefined}
          markdownAdapters={markdownAdapters}
          contextLabel={contextLabel}
          documentWorkItemIntent={
            startedDocumentIntent.current === documentWorkItemIntent?.id
              ? null
              : documentWorkItemIntent
          }
          onDocumentWorkItemIntentConsumed={onDocumentWorkItemIntentConsumed}
          onClearContext={onClearContext}
          onOfferChatForget={onOfferChatForget}
          onTextActionApply={onTextActionApply}
          onTextActionNativeReview={onTextActionNativeReview}
          onTextActionResumeMove={onTextActionResumeMove}
          onOpenDeck={onOpenDeck}
          visibilityOwnerId={ownerId}
          visibilityProfileKey={profileKey}
          agentsApi={agentsApi}
          helperAgents={helperAgents}
          inspectorOpen={inspectorOpen}
          panelHostRef={panelHostRef}
        />
        {conflict && attemptedPrompt ? (
          <div className="hq-project-conversation__unsent" role="status">
            <strong>Your unsent message</strong>
            <p>{attemptedPrompt}</p>
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard.writeText(attemptedPrompt)
              }
            >
              Copy message
            </button>
          </div>
        ) : null}
      </>
    ) : null;

  return (
    <div className="hq-project-conversation">
      <header
        className="hq-project-conversation__header"
        hidden={inspectorOpen}
      >
        <span className="hq-visually-hidden">{project.name}</span>
        {chiefAgent ? (
          <Pixelkin agent={chiefAgent} size={home ? 32 : 22} />
        ) : null}
        {home ? (
          <span className="hq-project-conversation__chief">
            <strong>{chiefName}</strong>
            <small>Your chief of staff</small>
          </span>
        ) : (
          <strong>Just me</strong>
        )}
      </header>
      {onOpenTeam && teamUnreadCount > 0 ? (
        <div className="hq-project-conversation__team-unread" role="status">
          <button type="button" onClick={onOpenTeam}>
            {teamUnreadCount} new{" "}
            {teamUnreadCount === 1 ? "message" : "messages"} in Team
          </button>
        </div>
      ) : null}
      {catchUpEnabled && catchUpStatus !== "idle" ? (
        <div className="hq-project-conversation__catch-up" role="status">
          <span>
            {catchUpStatus === "reconciliation_required"
              ? "Catch-up delivery needs review before another turn."
              : catchUpStatus === "retry_available"
                ? "Catch-up stopped before reaching your AI Client."
                : catchUpStatus === "recovered"
                  ? "Catch-up reply recovered."
                  : "Catching up on this Project…"}
          </span>
          {catchUpStatus === "reconciliation_required" ? (
            <button type="button" onClick={() => void checkCatchUp()}>
              Check catch-up
            </button>
          ) : null}
          {catchUpStatus === "retry_available" && catchUpCommandId ? (
            <button
              type="button"
              onClick={() => void retryCatchUp()}
              disabled={pending}
            >
              Retry catch-up
            </button>
          ) : null}
          {onOpenTeam ? (
            <button type="button" onClick={onOpenTeam}>
              Open Team
            </button>
          ) : null}
        </div>
      ) : null}
      {activeConversation && home ? (
        <StartupMark name="chief conversation shown" />
      ) : null}
      {activeConversation ? (
        <div className="hq-project-conversation__active">
          {activeConversation}
        </div>
      ) : (
        <div className="hq-conversation hq-project-conversation__empty">
          <div
            className="hq-conversation__scroll"
            aria-live="polite"
            hidden={inspectorOpen}
          >
            {executionId ? (
              <p role="status">
                {terminalUncaptured
                  ? "This HQ execution ended before capture."
                  : pending
                    ? "Starting your Conversation…"
                    : "Opening your Conversation…"}
              </p>
            ) : null}
            {loading ? <p role="status">Opening HQ Conversation…</p> : null}
            {delegationNotice ? <p role="status">{delegationNotice}</p> : null}
          </div>
          <div
            className="hq-project-conversation__inspector"
            hidden={!inspectorOpen}
            ref={panelHostRef}
          />
          <div className="hq-conversation__dock">
            <div className="hq-composer-wrap">
              <HqVisibilityLine
                visibility={
                  privateVisibilityTeamName
                    ? {
                        kind: "private-project",
                        teamName: privateVisibilityTeamName
                      }
                    : "personal-private"
                }
              />
              {contextLabel ? (
                <div className="hq-project-conversation__context">
                  About <strong>{contextLabel}</strong>
                  <button
                    type="button"
                    aria-label="Stop talking about this"
                    onClick={onClearContext}
                  >
                    <X size={13} />
                  </button>
                </div>
              ) : null}
              <HqUsageSuggestion
                draft={prompt}
                selection={selection}
                options={options}
                localAiClients={localAiClients}
                authorityKey={usageAuthorityKey}
                dismissalScopeKey={usageDismissalScopeKey}
                projectHq
              />
              <form
                className="hq-composer"
                aria-label="HQ Conversation composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void start();
                }}
              >
                <textarea
                  aria-label={
                    home
                      ? `Message ${chiefName}`
                      : `Ask ${chiefName} about ${project.name}`
                  }
                  placeholder={
                    home
                      ? `Message ${chiefName}`
                      : `Ask ${chiefName} about ${project.name}`
                  }
                  value={prompt}
                  disabled={
                    loading || pending || Boolean(executionId) || uncertain
                  }
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void start();
                    }
                  }}
                />
                <div className="hq-composer__toolbar">
                  <button
                    type="button"
                    aria-label="Attach a Project file"
                    title="Attachments become available after the first message"
                    disabled
                  >
                    <Paperclip size={17} />
                  </button>
                  <HqConversationSettings
                    options={options}
                    selection={selection}
                    onChange={setSelection}
                    disabled={
                      loading || pending || Boolean(executionId) || uncertain
                    }
                    permissionOnly
                  />
                  <span className="hq-project-conversation__status">Auto</span>
                  <button
                    className="hq-composer__send"
                    type="submit"
                    aria-label="Send message"
                    disabled={
                      loading ||
                      pending ||
                      Boolean(executionId) ||
                      uncertain ||
                      !prompt.trim() ||
                      (!selection.permissionMode &&
                        resolveAgentMention(prompt, helperAgents ?? []).kind !==
                          "matched")
                    }
                  >
                    <ArrowUp size={19} />
                  </button>
                </div>
              </form>
              {error ? (
                <p className="hq-conversation-error" role="alert">
                  {error}
                </p>
              ) : null}
              {uncertain ? (
                <div className="hq-project-conversation__recovery">
                  <button
                    type="button"
                    onClick={() => void checkDelivery()}
                    disabled={loading}
                  >
                    Check delivery
                  </button>
                  <button
                    type="button"
                    onClick={() => void start(true)}
                    disabled={loading || pending || conflict}
                  >
                    Retry same message
                  </button>
                  {conversation ? (
                    <button
                      type="button"
                      onClick={() => setReviewStarted(true)}
                    >
                      Open Conversation to review draft
                    </button>
                  ) : null}
                </div>
              ) : null}
              {!loading && !executionId && !uncertain && error && !prompt ? (
                <button type="button" onClick={() => void checkDelivery()}>
                  Retry opening HQ Conversation
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const StartupMark = ({ name }: { name: string }) => {
  startupMark(name);
  return null;
};
