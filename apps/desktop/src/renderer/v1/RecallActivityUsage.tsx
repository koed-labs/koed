import { ScrollArea } from "@koed-labs/ui";
import type { RecallActivityDetail as Detail } from "@koed-labs/shared/personal-desktop";
import {
  recallCallerPresentation,
  recallDurationLabel,
  recallTokenLabel
} from "./recall-activity-model.js";

export function RecallActivityUsage({ detail }: { detail: Detail }) {
  const { usage } = detail;
  return (
    <section
      className="recall-usage-detail"
      aria-labelledby="recall-usage-title"
    >
      <h3 id="recall-usage-title">Known synthesis usage</h3>
      <div className="recall-usage-number">
        {recallTokenLabel(usage.totalTokens)}
        <small>
          {usage.totalTokens === null
            ? "Usage not recorded"
            : "Recorded tokens"}
          {" · "}
          {usage.recordedAttempts.toLocaleString()} recorded{" "}
          {usage.recordedAttempts === 1 ? "attempt" : "attempts"}
        </small>
      </div>
      <dl className="recall-detail-facts">
        <div>
          <dt>Accepted to completion</dt>
          <dd>
            {recallDurationLabel(detail.question.metadata?.timing?.durationMs)}
          </dd>
        </div>
        <div>
          <dt>Usage coverage</dt>
          <dd>
            {usage.coverage === "unavailable"
              ? "Unknown"
              : usage.coverage === "partial"
                ? "Partial"
                : "Recorded"}
            {usage.includesEstimates && " · includes estimates"}
          </dd>
        </div>
        <div>
          <dt>Calling AI Client</dt>
          <dd>
            {
              recallCallerPresentation(detail.question.metadata?.caller?.name)
                .label
            }
          </dd>
        </div>
        <div>
          <dt>Synthesis worker</dt>
          <dd>
            {detail.worker ?? "Unknown"}
            <small>Model: {detail.model ?? "Unknown"}</small>
          </dd>
        </div>
      </dl>
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
      <details>
        <summary>Token breakdown</summary>
        <dl className="recall-detail-facts">
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
      </details>
      {!!usage.attempts.length && (
        <details>
          <summary>Recorded attempts</summary>
          <ScrollArea className="recall-table-wrap">
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
          </ScrollArea>
        </details>
      )}
    </section>
  );
}
