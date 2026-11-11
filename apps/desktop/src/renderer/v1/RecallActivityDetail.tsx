import { Dialog, DialogPopup, DialogTitle } from "@koed/ui";
import { useEffect, useRef, useState } from "react";
import type {
  PersonalDesktopApi,
  RecallActivityDetail as Detail,
  RecallUsage
} from "@koed/shared/personal-desktop";
import {
  SecureMarkdown,
  type MarkdownPlatformAdapters
} from "../markdown/SecureMarkdown.js";

export const recallTokenLabel = (value: number | null) =>
  value === null ? "Unknown" : value.toLocaleString();
const outcomeLabels = {
  found: "Memory found",
  not_found: "No matching Memory",
  insufficient: "Partial evidence",
  pending_summary: "Summaries pending"
};
function UsageDetail({ usage }: { usage: RecallUsage }) {
  return (
    <section aria-labelledby="recall-usage-title">
      <h3 id="recall-usage-title">Answer Synthesis usage</h3>
      <p>
        <strong>{recallTokenLabel(usage.totalTokens)}</strong> recorded tokens ·{" "}
        {usage.recordedAttempts} recorded attempts
      </p>
      {usage.provenance === "historical_job" ? (
        <p className="recall-coverage">
          Matched from this question’s historical worker job. Earlier task runs
          and missing usage cannot be recovered. Historical worker labels may be
          inaccurate. These values do not contribute to list or chart totals.
        </p>
      ) : (
        <p className="recall-coverage">
          Known recorded consumption, not a complete billing total. Missing
          usage remains unknown.
        </p>
      )}
      {usage.coverage === "partial" && <p>Usage coverage is partial.</p>}
      {usage.truncated && (
        <p>
          Only the first 200 recorded attempts are shown; totals here are
          partial.
        </p>
      )}
      {usage.ambiguous && <p>Conflicting usage associations were excluded.</p>}
      <dl className="recall-facts">
        <div>
          <dt>Input</dt>
          <dd>{recallTokenLabel(usage.inputTokens)}</dd>
        </div>
        <div>
          <dt>Cached input, included in input</dt>
          <dd>{recallTokenLabel(usage.cachedInputTokens)}</dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd>{recallTokenLabel(usage.outputTokens)}</dd>
        </div>
        <div>
          <dt>Reasoning, included in output</dt>
          <dd>{recallTokenLabel(usage.reasoningOutputTokens)}</dd>
        </div>
      </dl>
      {!!usage.attempts.length && (
        <details>
          <summary>Recorded attempts</summary>
          <div className="recall-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Observed</th>
                  <th>Synthesis worker</th>
                  <th>Model</th>
                  <th>Status</th>
                  <th>Tokens</th>
                  <th>Accuracy</th>
                </tr>
              </thead>
              <tbody>
                {usage.attempts.map((attempt) => (
                  <tr key={attempt.id}>
                    <td>{new Date(attempt.observedAt).toLocaleString()}</td>
                    <td>{attempt.worker ?? "Unknown"}</td>
                    <td>{attempt.model ?? "Unknown"}</td>
                    <td>{attempt.status}</td>
                    <td>{recallTokenLabel(attempt.totalTokens)}</td>
                    <td>{attempt.accuracy.replaceAll("_", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

export const recallMemoryResultLabel = (value: string | null | undefined) =>
  ({
    found: "Found",
    not_found: "Not found",
    insufficient: "Partial evidence",
    pending_summary: "Pending summaries"
  })[value ?? ""] ?? "Unknown";
export const recallDurationLabel = (value: number | null | undefined) =>
  value == null
    ? "Unknown"
    : value < 1000
      ? `${Math.round(value)} ms`
      : `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;

export function RecallActivityDetail({
  api,
  questionId,
  revision,
  onClose,
  adapters
}: {
  api: PersonalDesktopApi;
  questionId: string;
  revision: string;
  onClose: () => void;
  adapters: MarkdownPlatformAdapters;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const memoryStatus = detail?.question.metadata
    ? detail.question.metadata.memoryStatus
    : detail?.memoryStatus;
  useEffect(() => {
    let active = true;
    setDetail(null);
    setError(false);
    if (!api.loadRecallActivity) {
      setError(true);
      return;
    }
    void api.loadRecallActivity({ questionId }).then(
      (value) => {
        if (active) setDetail(value);
      },
      () => {
        if (active) setError(true);
      }
    );
    return () => {
      active = false;
    };
  }, [api, questionId, revision]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        className="v1-app recall-activity recall-detail"
        showCloseButton={false}
        initialFocus={heading}
      >
        <header className="recall-heading">
          <DialogTitle id="recall-detail-title" tabIndex={-1} ref={heading}>
            Memory Answer details
          </DialogTitle>
          <button type="button" onClick={onClose}>
            Close details
          </button>
        </header>
        {error ? (
          <p role="alert">
            This Memory Answer is unavailable or your access has changed.
          </p>
        ) : !detail ? (
          <p role="status">Loading answer…</p>
        ) : (
          <>
            <p className="recall-question">{detail.question.query}</p>
            <dl className="recall-facts">
              <div>
                <dt>Calling AI Client</dt>
                <dd>
                  {detail.question.metadata?.caller?.name ?? "Unknown"}
                  {detail.question.metadata?.caller?.version
                    ? ` · ${detail.question.metadata.caller.version}`
                    : ""}
                </dd>
              </div>
              <div>
                <dt>Accepted to completion</dt>
                <dd>
                  {recallDurationLabel(
                    detail.question.metadata?.timing?.durationMs
                  )}
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  {detail.question.status === "answered"
                    ? "Answered"
                    : "Recorded error"}
                </dd>
              </div>
              <div>
                <dt>Memory found</dt>
                <dd>
                  {memoryStatus ? outcomeLabels[memoryStatus] : "Unknown"}
                </dd>
              </div>
              <div>
                <dt>Synthesis worker</dt>
                <dd>{detail.worker ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{detail.model ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>Searches / expansions / candidates</dt>
                <dd>
                  {[
                    detail.searchCount,
                    detail.expandCount,
                    detail.candidateCount
                  ]
                    .map(recallTokenLabel)
                    .join(" / ")}
                </dd>
              </div>
            </dl>
            {detail.failure && <p role="status">{detail.failure}</p>}
            {detail.answer && (
              <SecureMarkdown source={detail.answer} adapters={adapters} />
            )}
            <section aria-labelledby="recall-evidence-title">
              <h3 id="recall-evidence-title">Evidence Bundle</h3>
              {!detail.evidence.length && (
                <p>No retained evidence is available.</p>
              )}
              {detail.evidence.map((item, index) => (
                <details key={index}>
                  <summary>{item.title}</summary>
                  <p className="recall-question">
                    {item.text || "No retained excerpt."}
                  </p>
                  {item.sourceId && <small>Source: {item.sourceId}</small>}
                </details>
              ))}
              {!!detail.citations.length && (
                <details>
                  <summary>Citations ({detail.citations.length})</summary>
                  {detail.citations.map((item, index) => (
                    <p key={index}>
                      {item.title}: {item.text || item.sourceId}
                    </p>
                  ))}
                </details>
              )}
            </section>
            {detail.contentTruncated && (
              <p>Long content has been shortened for this view.</p>
            )}
            <UsageDetail usage={detail.usage} />
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
