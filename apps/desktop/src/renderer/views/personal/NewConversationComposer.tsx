import { useRef, useState } from "react";
import { ArrowUp, LoaderCircle, MonitorSmartphone } from "lucide-react";
import type {
  ManagedConversationDesktopApi,
  ManagedConversationIdentity,
  ManagedConversationLaunchOptions
} from "../../../ipc/managed-conversation-protocol.js";
import {
  ConversationSettings,
  type ConversationSelection
} from "./ConversationSettings.js";

export type InitialConversationPrompt = {
  clientUserMessageId: string;
  prompt: string;
  status: "queued" | "rejected" | "reconciling";
  message: string;
};

export function NewConversationComposer({
  api,
  projectId,
  options,
  selection,
  onChange,
  onStarted
}: {
  api: ManagedConversationDesktopApi;
  projectId: string;
  options: ManagedConversationLaunchOptions;
  selection: ConversationSelection;
  onChange: (value: ConversationSelection) => void;
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
  const instance = options.instances.find(
    (item) => item.instanceId === selection.instanceId
  );
  const available =
    instance?.ready &&
    instance.models.some((model) => model.id === selection.model) &&
    selection.permissionMode;
  const start = async () => {
    if (
      inFlight.current ||
      !instance ||
      !available ||
      !selection.permissionMode
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    const launch = launchRef.current ?? {
      projectId,
      aiClientDriverId: instance.driverId,
      aiClientInstanceId: instance.instanceId,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort || null,
      permissionMode: selection.permissionMode,
      runnerKind: "local_device" as const,
      idempotencyKey: `desktop-conversation:${crypto.randomUUID()}`
    };
    launchRef.current = launch;
    try {
      const result = await api.start(launch);
      const conversation = result.conversation ?? {
        executionId: result.executionId,
        projectId,
        capturedSessionId: result.executionId,
        threadId: result.executionId,
        executionOwner: {
          driverId: launch.aiClientDriverId,
          instanceId: launch.aiClientInstanceId
        }
      };
      let initialPrompt: InitialConversationPrompt | undefined;
      if (prompt.trim()) {
        initialPrompt = {
          clientUserMessageId: crypto.randomUUID(),
          prompt,
          status: "rejected",
          message: "The prompt was not sent. Your draft is available below."
        };
        const draftScope = {
          projectId,
          capturedSessionId: result.executionId,
          threadId: result.executionId
        };
        // Keep the draft available even if enqueue has an uncertain response.
        await api
          .writeDraft({ ...draftScope, value: prompt })
          .catch(() => undefined);
        try {
          const sent = await api.send({
            executionId: result.executionId,
            capturedSessionId: conversation.capturedSessionId,
            threadId: conversation.threadId,
            idempotencyKey: `desktop-prompt:${initialPrompt.clientUserMessageId}`,
            clientUserMessageId: initialPrompt.clientUserMessageId,
            prompt
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
      onStarted(conversation, result.status, launch, initialPrompt);
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
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <div className="personal-managed-composer-field conversation-input">
        <label>
          <span className="sr-only">First message</span>
          <textarea
            autoFocus
            rows={2}
            value={prompt}
            disabled={busy}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Ask the selected AI Client to work in this Project"
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void start();
              }
            }}
          />
        </label>
        <div className="conversation-input-footer">
          <ConversationSettings
            options={options}
            selection={selection}
            disabledReason={
              busy
                ? "Starting the Conversation…"
                : launchRef.current
                  ? "Retry the pending start before changing settings."
                  : undefined
            }
            onChange={onChange}
          />
          <button
            className="conversation-send"
            type="submit"
            disabled={busy || !available}
            aria-label={busy ? "Starting Conversation" : "Start Conversation"}
            title="Start Conversation"
          >
            {busy ? (
              <LoaderCircle aria-hidden="true" />
            ) : (
              <ArrowUp aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
      <div className="personal-managed-meta-row">
        <span className="conversation-settings-status">
          {busy
            ? "Starting the AI Client…"
            : "Send your first message to start the Conversation."}
        </span>
        <span className="conversation-new-device">
          <MonitorSmartphone aria-hidden="true" />
          {options.runners[0]?.displayName ?? "This device"}
        </span>
      </div>
      {error && (
        <p role="alert" className="personal-managed-error">
          {error}
        </p>
      )}
    </form>
  );
}
