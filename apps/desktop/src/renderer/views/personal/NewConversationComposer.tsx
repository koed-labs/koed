import { useRef, useState } from "react";
import { MonitorSmartphone } from "lucide-react";
import type {
  ManagedConversationDesktopApi,
  ManagedConversationIdentity,
  ManagedConversationLaunchOptions
} from "../../../ipc/managed-conversation-protocol.js";
import type { ConversationSelection } from "./ConversationSettings.js";
import { ConversationInput } from "./ConversationInput.js";

import type { InitialConversationPrompt } from "../../state/use-managed-conversation-lifecycle.js";
export type { InitialConversationPrompt } from "../../state/use-managed-conversation-lifecycle.js";

export function NewConversationComposer({
  api,
  contextKind = "project",
  requirePrompt = false,
  showContextHelp = true,
  placeholder = "Tell the selected AI Client what to do",
  projectId,
  options,
  selection,
  onChange,
  onPendingChange,
  onStarted
}: {
  api: ManagedConversationDesktopApi | null;
  contextKind?: "project" | "independent";
  requirePrompt?: boolean;
  showContextHelp?: boolean;
  placeholder?: string;
  projectId: string | null;
  options: ManagedConversationLaunchOptions | null;
  selection: ConversationSelection;
  onChange: (value: ConversationSelection) => void;
  onPendingChange?: (pending: boolean) => void;
  onStarted: (
    conversation: ManagedConversationIdentity,
    status: "starting" | "ready",
    launch: Parameters<ManagedConversationDesktopApi["start"]>[0],
    initialPrompt?: InitialConversationPrompt
  ) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  // Retain the launch identity after an uncertain start response. An explicit retry
  // recovers that execution instead of starting a second AI Client.
  const launchRef = useRef<
    Parameters<ManagedConversationDesktopApi["start"]>[0] | null
  >(null);
  const initialPromptRef = useRef<InitialConversationPrompt | null>(null);
  const instance = options?.instances.find(
    (item) => item.instanceId === selection.instanceId
  );
  const available =
    api &&
    projectId &&
    instance?.ready &&
    instance.models.some((model) => model.id === selection.model) &&
    selection.permissionMode;
  const start = async () => {
    if (
      inFlight.current ||
      !api ||
      !projectId ||
      !instance ||
      !available ||
      (requirePrompt && !prompt.trim()) ||
      !selection.permissionMode
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    const launch = launchRef.current ?? {
      projectId,
      contextKind,
      aiClientDriverId: instance.driverId,
      aiClientInstanceId: instance.instanceId,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort || null,
      permissionMode: selection.permissionMode,
      runnerKind: "local_device" as const,
      idempotencyKey: `desktop-conversation:${crypto.randomUUID()}`
    };
    launchRef.current = launch;
    onPendingChange?.(true);
    try {
      const result = await api.start(launch);
      const conversation = result.conversation ?? {
        executionId: result.executionId,
        projectId: launch.projectId,
        capturedSessionId: result.executionId,
        threadId: result.executionId,
        executionOwner: {
          driverId: launch.aiClientDriverId,
          instanceId: launch.aiClientInstanceId
        }
      };
      let initialPrompt: InitialConversationPrompt | undefined;
      if (prompt.trim()) {
        initialPrompt =
          (initialPromptRef.current?.status === "rejected" &&
          initialPromptRef.current.prompt !== prompt
            ? null
            : initialPromptRef.current) ??
          ({
            clientUserMessageId: crypto.randomUUID(),
            prompt,
            status: "rejected",
            message: "The prompt was not sent. Your draft is available below."
          } satisfies InitialConversationPrompt);
        initialPromptRef.current = initialPrompt;
        const draftScope = {
          projectId: launch.projectId,
          capturedSessionId: result.executionId,
          threadId: result.executionId
        };
        // Keep the draft available even if enqueue has an uncertain response.
        await api
          .writeDraft({ ...draftScope, value: initialPrompt.prompt })
          .catch(() => undefined);
        try {
          const sent = await api.send({
            executionId: result.executionId,
            capturedSessionId: conversation.capturedSessionId,
            threadId: conversation.threadId,
            idempotencyKey: `desktop-prompt:${initialPrompt.clientUserMessageId}`,
            clientUserMessageId: initialPrompt.clientUserMessageId,
            prompt: initialPrompt.prompt
          });
          initialPrompt.status = sent.status;
          initialPrompt.message =
            sent.message ??
            (sent.status === "rejected"
              ? "The prompt was not sent. Review the Conversation and try again."
              : "");
          if (sent.status === "queued")
            await api.deleteDraft(draftScope).catch(() => undefined);
        } catch {
          initialPrompt.status = "reconciling";
          initialPrompt.message =
            "Koed could not confirm whether the first prompt was accepted. It will not submit the prompt again automatically.";
        }
      }
      // The execution exists even when first-prompt delivery is uncertain.
      // Hand its launch and prompt identities to owner-scoped recovery.
      onStarted(
        conversation,
        result.status,
        launch,
        initialPrompt ? { ...initialPrompt } : undefined
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The AI Client could not start. Retry to check the same Conversation."
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <form
      className="personal-managed-composer personal-new-conversation-composer"
      aria-label="New Conversation"
      aria-busy={!api || !projectId || !options || busy}
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <ConversationInput
        action={{
          kind: busy ? "busy" : "send",
          label: busy ? "Starting Conversation" : "Start Conversation",
          disabled: busy || !available || (requirePrompt && !prompt.trim())
        }}
        autoFocus
        disabled={busy || initialPromptRef.current?.status === "reconciling"}
        label="First message"
        onChange={setPrompt}
        onSubmit={() => void start()}
        placeholder={placeholder}
        rows={2}
        settings={{
          options,
          selection,
          disabledReason: busy
            ? "Starting the Conversation…"
            : launchRef.current
              ? "Retry the pending start before changing settings."
              : undefined,
          onChange
        }}
        value={prompt}
      />
      {showContextHelp ? (
        <div className="personal-managed-meta-row">
          <span className="conversation-settings-status">
            {busy
              ? "Starting the AI Client…"
              : "Send your first message to start the Conversation."}
          </span>
          <span className="conversation-new-device">
            <MonitorSmartphone aria-hidden="true" />
            {options?.runners[0]?.displayName ?? "This device"}
          </span>
        </div>
      ) : null}
      {error && (
        <p role="alert" className="personal-managed-error">
          {error}
        </p>
      )}
    </form>
  );
}
