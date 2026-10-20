import type { Agent } from "@koed/shared/agent-contract";
import { Pixelkin } from "../agents/Pixelkin.js";
import { ArrowUp, Paperclip, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import "./hq-project-conversation.css";

/** This route owns the private HQ handle; it does not register an ordinary draft. */
export function HqProjectConversation({
  project,
  chiefName,
  chiefAgent,
  chiefInstanceId,
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
  onClearContext,
  agentsApi,
  helperAgents,
  ownerIdentity = ""
}: {
  project: DesktopProject;
  chiefName: string;
  chiefAgent?: Agent | null;
  chiefInstanceId: string | null;
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
  agentsApi?: AgentsDesktopApi | null;
  helperAgents?: readonly Agent[];
  ownerIdentity?: string;
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

  useEffect(() => {
    let live = true;
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
    void api
      .reserve(project.id)
      .then((value) => {
        if (!live) return;
        setExecutionId(value.executionId);
        setLoading(false);
      })
      .catch(() => {
        if (!live) return;
        setError("Project HQ Conversation could not be opened. Retry.");
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api, project.id]);

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
  }, [api, executionId, managedConversations, project.id]);

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

  const activeConversation =
    thread && conversation && (!uncertain || reviewStarted) ? (
      <>
        <HqActiveConversation
          key={conversation.executionId}
          privateProjectHq
          privateProjectHqIdentity={conversation}
          api={managedConversations}
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
        {chiefAgent ? <Pixelkin agent={chiefAgent} size={22} /> : null}
        <strong>Just me</strong>
      </header>
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
              <HqVisibilityLine visibility="personal-private" />
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
              <form
                className="hq-composer"
                aria-label="HQ Conversation composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void start();
                }}
              >
                <textarea
                  aria-label={`Ask ${chiefName} about ${project.name}`}
                  placeholder={`Ask ${chiefName} about ${project.name}`}
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
