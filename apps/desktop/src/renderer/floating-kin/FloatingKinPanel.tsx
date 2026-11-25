import { useEffect, useRef } from "react";
import { Settings } from "lucide-react";
import {
  displayConversationTitle,
  type FloatingKinActivity,
  type FloatingKinPreview,
  type FloatingKinSummary,
  type FloatingKinSummaryRequest
} from "@koed-labs/shared";
import { AiClientLogo } from "../views/personal/AiClientLogo.js";

export type Conversation = FloatingKinActivity["conversations"][number];
export const clientNames = {
  codex: "Codex",
  "claude-code": "Claude Code",
  pi: "Pi"
} as const;

export function ClientMark({ client }: { client: Conversation["client"] }) {
  return (
    <span className="fk-client">
      <AiClientLogo id={client === "claude-code" ? "claude" : client} />
    </span>
  );
}

function CaptureTime({ iso }: { iso: string }) {
  return <time dateTime={iso}>{new Date(iso).toLocaleString()}</time>;
}

const failures = {
  no_evidence: "No captured evidence for this summary.",
  client_unavailable:
    "Floating Kin summaries require a ready Codex or Pi assignment under Settings → AI models.",
  unavailable: "Summary unavailable. Try again from Floating Kin.",
  cancelled: "Summary cancelled.",
  busy: "A summary is already in progress.",
  timed_out: "Summary timed out. Try again."
} satisfies Record<Exclude<FloatingKinSummary["status"], "answered">, string>;

function Answer({
  result
}: {
  result: Extract<FloatingKinSummary, { status: "answered" }>;
}) {
  return (
    <>
      <section className="fk-copy">
        <h3>Captured</h3>
        <p>{result.captured}</p>
      </section>
      {result.inferred ? (
        <section className="fk-copy">
          <h3>Inferred</h3>
          <p>{result.inferred}</p>
        </section>
      ) : null}
      <details className="fk-sources">
        <summary>Captured sources ({result.sources.length})</summary>
        <ul>
          {result.sources.map((source) => (
            <li key={`${source.kind}:${source.id}`}>
              {source.kind === "conversation_item"
                ? "Conversation item"
                : "Memory Event"}{" "}
              · <CaptureTime iso={source.occurredAt} />
              <small>{source.id}</small>
            </li>
          ))}
        </ul>
      </details>
      {result.truncated ? (
        <p className="fk-note">Evidence was truncated.</p>
      ) : null}
      <footer className="fk-note">
        <div>
          Koed as of <CaptureTime iso={result.asOf} />
        </div>
        <div>
          {clientNames[result.client]} · {result.model}
          {result.effort ? ` · ${result.effort} effort` : ""}
        </div>
      </footer>
    </>
  );
}

function CapturedPreview({
  preview
}: {
  preview: NonNullable<FloatingKinPreview>;
}) {
  const { request, reply } = preview;
  const previous =
    request &&
    reply &&
    Date.parse(reply.occurredAt) < Date.parse(request.occurredAt);
  return (
    <>
      {request && (
        <section className="fk-copy fk-preview">
          <h3>Last captured request</h3>
          <p>{request.text}</p>
        </section>
      )}
      {reply && (
        <section className="fk-copy fk-preview">
          <h3>
            {previous ? "Previous captured reply" : "Last captured reply"}
          </h3>
          <p>{reply.text}</p>
        </section>
      )}
    </>
  );
}

export function FloatingKinPanel({
  conversation,
  preview,
  age,
  view,
  isCancelling,
  close,
  summarize,
  cancel,
  openLastSummary,
  openAiModels,
  openConversation
}: {
  conversation: Conversation;
  preview: FloatingKinPreview;
  age: string;
  view: {
    request: FloatingKinSummaryRequest;
    result: FloatingKinSummary | null;
    reopening?: boolean;
  } | null;
  isCancelling: boolean;
  close: () => void;
  summarize: () => void;
  cancel: () => void;
  openLastSummary?: () => void;
  openAiModels?: () => void;
  // Opens this Conversation in Koed Desktop.
  openConversation?: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
  }, [conversation.sessionId]);
  const result = view?.result;
  const working = !!view && !result && !isCancelling;
  const status = isCancelling
    ? "Cancelling summary…"
    : working
      ? view.reopening
        ? "Opening last summary…"
        : "Summarizing captured work…"
      : result?.status === "answered"
        ? "Summary ready."
        : result
          ? view?.reopening && result.status === "unavailable"
            ? "Last summary is no longer available."
            : failures[result.status]
          : "";
  const showingSummary =
    view && (working || isCancelling || result?.status === "answered");
  const title = showingSummary
    ? view.request.action === "project"
      ? "Project summary"
      : "Conversation summary"
    : (displayConversationTitle(preview?.title) ??
      displayConversationTitle(preview?.request?.text) ??
      "Recent Conversation");
  return (
    <section
      className="fk-panel"
      data-fk-hit
      id="floating-kin-summary"
      role="dialog"
      aria-labelledby="fk-panel-title"
    >
      <header className="fk-header">
        <div>
          <h2 id="fk-panel-title" title={title}>
            {openConversation && !showingSummary ? (
              <button
                type="button"
                className="fk-title-link"
                onClick={openConversation}
              >
                {title}
              </button>
            ) : (
              title
            )}
          </h2>
          <small className="fk-meta">
            <ClientMark client={conversation.client} />{" "}
            {clientNames[conversation.client]}
            {preview?.projectName && (
              <>
                {" · "}
                <span className="fk-project-name" title={preview.projectName}>
                  {preview.projectName}
                </span>
              </>
            )}
            {` · Captured ${age} ago`}
          </small>
        </div>
        <button
          type="button"
          ref={closeButton}
          onClick={close}
          aria-label="Close summary"
        >
          ×
        </button>
      </header>
      <div
        className="fk-body"
        tabIndex={0}
        aria-label={
          showingSummary ? "Summary content" : "Captured Conversation context"
        }
      >
        <div className="fk-body-content">
          <p role="status" className="fk-note">
            {status}
          </p>
          {!showingSummary && preview && <CapturedPreview preview={preview} />}
          {result?.status === "answered" ? <Answer result={result} /> : null}
          {working ? (
            <button
              type="button"
              onClick={() => {
                closeButton.current?.focus();
                cancel();
              }}
            >
              Cancel
            </button>
          ) : (
            <>
              {openLastSummary && result?.status !== "answered" ? (
                <button
                  type="button"
                  disabled={isCancelling}
                  onClick={() => {
                    closeButton.current?.focus();
                    openLastSummary();
                  }}
                >
                  Open last summary
                </button>
              ) : null}
              <div className="fk-actions">
                <button
                  type="button"
                  disabled={isCancelling}
                  onClick={() => {
                    closeButton.current?.focus();
                    summarize();
                  }}
                >
                  Summarize conversation
                </button>
                {openAiModels ? (
                  <button
                    type="button"
                    className="fk-settings-button"
                    aria-label="AI models settings"
                    title="AI models settings"
                    onClick={openAiModels}
                  >
                    <Settings aria-hidden="true" size={16} />
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
