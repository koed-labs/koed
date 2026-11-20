import { useEffect, useRef } from "react";
import type {
  FloatingKinActivity,
  FloatingKinSummary,
  FloatingKinSummaryRequest
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
    "Summaries require an available Claude Code or Pi assignment. Check Settings → AI models.",
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

export function FloatingKinPanel({
  conversation,
  age,
  view,
  isCancelling,
  close,
  summarize,
  cancel
}: {
  conversation: Conversation;
  age: string;
  view: {
    request: FloatingKinSummaryRequest;
    result: FloatingKinSummary | null;
  } | null;
  isCancelling: boolean;
  close: () => void;
  summarize: (action: FloatingKinSummaryRequest["action"]) => void;
  cancel: () => void;
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
      ? "Summarizing captured work…"
      : result?.status === "answered"
        ? "Summary ready."
        : result
          ? failures[result.status]
          : "";
  const title =
    view?.request.action === "project"
      ? "Project summary"
      : view
        ? "Conversation summary"
        : "Recent Conversation";
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
          <h2 id="fk-panel-title">{title}</h2>
          <small>
            <ClientMark client={conversation.client} />{" "}
            {clientNames[conversation.client]} · Captured {age} ago
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
      <div className="fk-body" tabIndex={0} aria-label="Summary content">
        <div className="fk-body-content">
          <p role="status" className="fk-note">
            {status}
          </p>
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
            <div className="fk-actions">
              <button
                type="button"
                disabled={isCancelling}
                onClick={() => {
                  closeButton.current?.focus();
                  summarize("conversation");
                }}
              >
                Summarize Conversation
              </button>
              <button
                type="button"
                disabled={isCancelling || !conversation.projectId}
                onClick={() => {
                  closeButton.current?.focus();
                  summarize("project");
                }}
              >
                Summarize Project
              </button>
            </div>
          )}
          {!view ? (
            <p className="fk-note">
              Uses your assigned AI Client and its subscription. Shows captured
              work, not live activity.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
