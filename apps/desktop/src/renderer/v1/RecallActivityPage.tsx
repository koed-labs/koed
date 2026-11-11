import { useRecallActivity } from "./use-recall-activity.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  RecallActivityDetail,
  recallTokenLabel,
  recallMemoryResultLabel,
  recallDurationLabel
} from "./RecallActivityDetail.js";
import { RecallTimeline } from "./RecallTimeline.js";
import type { MarkdownPlatformAdapters } from "../markdown/SecureMarkdown.js";
import {
  recallActivityListInputSchema,
  type PersonalDesktopApi,
  type RecallActivityListInput
} from "@koed/shared/personal-desktop";
import "./recall-activity.css";

const localDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const initialRange = () => {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 29);
  return { from: localDate(from), to: localDate(to) };
};
const dateRange = (from: string, to: string) => {
  const end = new Date(`${to}T00:00:00`);
  end.setDate(end.getDate() + 1);
  return {
    from: new Date(`${from}T00:00:00`).toISOString(),
    to: end.toISOString()
  };
};

export function RecallActivityPage({
  api,
  adapters
}: {
  api: PersonalDesktopApi | null;
  adapters: MarkdownPlatformAdapters;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const [draft, setDraft] = useState(() => ({
    ...initialRange(),
    projectId: "",
    sessionId: "",
    searchDomain: "",
    status: "",
    memoryStatus: "",
    callerName: "",
    callerUnknown: false,
    minDuration: "",
    maxDuration: ""
  }));
  const [filters, setFilters] = useState<RecallActivityListInput>(() => ({
    ...dateRange(draft.from, draft.to),
    limit: 50
  }));
  const [cursors, setCursors] = useState<
    NonNullable<RecallActivityListInput["cursor"]>[]
  >([]);
  const [filterError, setFilterError] = useState<string | null>(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { page, overview, loading, error, overviewError, accessLost, refresh } =
    useRecallActivity(api, { ...filters, cursor: cursors.at(-1) }, timezone);
  useEffect(() => {
    if (
      accessLost ||
      (!loading &&
        page &&
        selectedId &&
        !page.questions.some((row) => row.id === selectedId))
    )
      setSelectedId(null);
  }, [accessLost, loading, page, selectedId]);

  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    try {
      const next = recallActivityListInputSchema.parse({
        ...dateRange(draft.from, draft.to),
        limit: 50,
        projectId: draft.projectId.trim() || undefined,
        sessionId: draft.sessionId.trim() || undefined,
        searchDomain: draft.searchDomain || undefined,
        status: draft.status || undefined,
        memoryStatus: draft.memoryStatus || undefined,
        callerName: draft.callerUnknown
          ? ""
          : draft.callerName.trim() || undefined,
        minDurationMs: draft.minDuration
          ? Number(draft.minDuration) * 1000
          : undefined,
        maxDurationMs: draft.maxDuration
          ? Number(draft.maxDuration) * 1000
          : undefined
      });
      setFilterError(null);
      setSelectedId(null);
      setCursors([]);
      setFilters(next);
    } catch {
      setFilterError(
        "Choose a valid date and duration range and, if supplied, a valid Conversation identifier."
      );
    }
  };
  return (
    <section className="recall-activity" aria-labelledby="recall-title">
      <header className="recall-heading">
        <div>
          <h1 id="recall-title">Recall activity</h1>
          <p>
            Recorded Memory Answers from connected AI Clients · Personal Memory
          </p>
        </div>
        <button type="button" disabled={loading} onClick={() => refresh()}>
          Refresh
        </button>
      </header>
      <p className="recall-coverage recall-intro">
        Completed answers and recorded errors · {timezone}
      </p>
      <form className="recall-filters" onSubmit={applyFilters}>
        <label>
          From
          <input
            type="date"
            required
            value={draft.from}
            onChange={(event) =>
              setDraft({ ...draft, from: event.target.value })
            }
          />
        </label>
        <label>
          Through
          <input
            type="date"
            required
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </label>
        <label>
          Search Domain
          <select
            value={draft.searchDomain}
            onChange={(event) =>
              setDraft({ ...draft, searchDomain: event.target.value })
            }
          >
            <option value="">All</option>
            <option value="global">All Memory</option>
            <option value="project">Project</option>
            <option value="session">Conversation</option>
          </select>
        </label>
        <label>
          Status
          <select
            value={draft.status}
            onChange={(event) =>
              setDraft({ ...draft, status: event.target.value })
            }
          >
            <option value="">All</option>
            <option value="answered">Answered</option>
            <option value="error">Recorded error</option>
          </select>
        </label>
        <button type="submit">Apply filters</button>
        <details className="recall-more-filters">
          <summary>More filters</summary>
          <div className="recall-filter-fields">
            <label>
              Recorded Project
              <input
                list="recall-projects"
                value={draft.projectId}
                placeholder="All Projects"
                onChange={(event) =>
                  setDraft({ ...draft, projectId: event.target.value })
                }
              />
            </label>
            <datalist id="recall-projects">
              {[
                ...new Map(
                  (page?.questions ?? [])
                    .filter((row) => row.projectId)
                    .map((row) => [
                      row.projectId!,
                      row.projectName ?? row.projectId!
                    ])
                ).entries()
              ].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </datalist>
            <label>
              Conversation
              <input
                value={draft.sessionId}
                placeholder="All Conversations"
                onChange={(event) =>
                  setDraft({ ...draft, sessionId: event.target.value })
                }
              />
            </label>
            <label>
              Memory-found result
              <select
                value={draft.memoryStatus}
                onChange={(event) =>
                  setDraft({ ...draft, memoryStatus: event.target.value })
                }
              >
                <option value="">All results</option>
                {[
                  "found",
                  "not_found",
                  "insufficient",
                  "pending_summary",
                  "unknown"
                ].map((value) => (
                  <option key={value} value={value}>
                    {recallMemoryResultLabel(value)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Calling AI Client
              <input
                list="recall-callers"
                disabled={draft.callerUnknown}
                value={draft.callerName}
                placeholder="All AI Clients"
                onChange={(event) =>
                  setDraft({ ...draft, callerName: event.target.value })
                }
              />
            </label>
            <label>
              <span>AI Client coverage</span>
              <span>
                <input
                  type="checkbox"
                  checked={draft.callerUnknown}
                  onChange={(event) =>
                    setDraft({ ...draft, callerUnknown: event.target.checked })
                  }
                />{" "}
                Unknown only
              </span>
            </label>
            <datalist id="recall-callers">
              {[
                ...new Set(
                  page?.questions.flatMap((row) =>
                    row.metadata?.caller?.name ? [row.metadata.caller.name] : []
                  ) ?? []
                )
              ].map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <label>
              Minimum duration (s)
              <input
                type="number"
                min="0"
                step="0.001"
                value={draft.minDuration}
                onChange={(event) =>
                  setDraft({ ...draft, minDuration: event.target.value })
                }
              />
            </label>
            <label>
              Maximum duration (s)
              <input
                type="number"
                min="0"
                step="0.001"
                value={draft.maxDuration}
                onChange={(event) =>
                  setDraft({ ...draft, maxDuration: event.target.value })
                }
              />
            </label>
          </div>
        </details>
      </form>
      {filterError && <p role="alert">{filterError}</p>}
      {overviewError && (
        <p role="alert">
          Overview statistics are unavailable. Refresh to retry.
        </p>
      )}
      {overview && (
        <>
          <div className="recall-cards">
            <div>
              <span>Recorded Memory Answers</span>
              <strong>{overview.recordedQuestions.toLocaleString()}</strong>
            </div>
            <div>
              <span>Recorded errors</span>
              <strong>{overview.recordedErrors.toLocaleString()}</strong>
              <small>Errors are not recall misses</small>
            </div>
            <div>
              <span>Known synthesis tokens</span>
              <strong>{recallTokenLabel(overview.tokens.totalTokens)}</strong>
              <small>
                {overview.linkedQuestions} linked answers ·{" "}
                {overview.tokens.recordedAttempts} recorded attempts
                {overview.tokens.includesEstimates
                  ? " · includes estimates"
                  : ""}
                {overview.tokens.coverage === "partial" ? " · partial" : ""}
              </small>
            </div>
            <div>
              <span>Memory found</span>
              <strong>
                {overview.memoryResults.foundPercentage === null
                  ? "Unavailable"
                  : `${overview.memoryResults.foundPercentage.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`}
              </strong>
              <small>
                {overview.memoryResults.found} found /{" "}
                {overview.memoryResults.found +
                  overview.memoryResults.not_found}{" "}
                found or not found · {overview.memoryResults.unknown} unknown
              </small>
            </div>
            <div>
              <span>Median accepted to completion</span>
              <strong>{recallDurationLabel(overview.medianDurationMs)}</strong>
              <small>
                {overview.knownDurations} measured answers · includes queueing
                and retries
              </small>
            </div>
          </div>
          <div className="recall-charts">
            <RecallTimeline
              title={`Recorded Memory Answers by ${overview.bucket}`}
              points={overview.questions.map((point) => ({
                start: point.start,
                value: point.count,
                breakdown: {
                  Found: point.found,
                  "Not found": point.notFound,
                  "Partial evidence": point.insufficient,
                  "Pending summaries": point.pendingSummary,
                  Unknown: point.unknown
                }
              }))}
              timezone={overview.timezone}
              unit="Recorded answers"
            />
            <RecallTimeline
              title={`Known synthesis tokens by observation ${overview.bucket}`}
              points={overview.tokenTimeline.map((point) => ({
                start: point.start,
                value: point.totalTokens
              }))}
              timezone={overview.timezone}
              unit="Known tokens"
            />
          </div>
          <details className="recall-coverage recall-metric-notes">
            <summary>About these numbers and their coverage</summary>
            <p>
              Requests that ended before a final answer was recorded may be
              absent.
            </p>
            <p>
              Token history includes usage linked to recorded Personal Memory
              Answers. Older answers often lack these links; gaps mean
              unavailable usage, not zero consumption. Token dates describe when
              usage was observed, which may differ from the answer’s recorded
              date. Totals cover known recorded usage and may be partial.
              Memory-found results, calling AI Client and duration are recorded
              for new answers only. Found percentage excludes partial evidence,
              pending summaries and unknown results. Duration measures task
              acceptance to completion, including retries; it is not client
              request latency.
            </p>
          </details>
        </>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => refresh()}>
            Retry
          </button>
        </p>
      )}
      <div aria-busy={loading}>
        {loading && <p role="status">Loading recorded answers…</p>}
        {!loading && page?.questions.length === 0 && (
          <p role="status">No recorded Memory Answers match these filters.</p>
        )}
        {page && page.questions.length > 0 && (
          <div className="recall-table-wrap">
            <table>
              <caption>Recorded Memory Answers, newest first</caption>
              <thead>
                <tr>
                  <th>Recorded time</th>
                  <th>Question</th>
                  <th>Context</th>
                  <th>Status / result</th>
                  <th>Accepted to completion</th>
                  <th>Synthesis tokens</th>
                </tr>
              </thead>
              <tbody>
                {page.questions.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <time dateTime={row.recordedAt}>
                        {new Date(row.recordedAt).toLocaleString()}
                      </time>
                    </td>
                    <td className="recall-question">
                      <button
                        type="button"
                        className="recall-question-link"
                        onClick={(event) => {
                          selectedButton.current = event.currentTarget;
                          setSelectedId(row.id);
                        }}
                      >
                        {row.query}
                      </button>
                    </td>
                    <td>
                      {row.projectName ??
                        row.projectId ??
                        (row.sessionId ? "Conversation" : "All Memory")}
                      <small>
                        {row.searchDomain === "session"
                          ? "Conversation"
                          : row.searchDomain === "project"
                            ? "Project"
                            : "All Memory"}
                      </small>
                      <small>
                        AI Client: {row.metadata?.caller?.name ?? "Unknown"}
                      </small>
                    </td>
                    <td>
                      <span className="recall-status">
                        {row.status === "answered"
                          ? "Answered"
                          : "Recorded error"}
                      </span>
                      <small>
                        {recallMemoryResultLabel(row.metadata?.memoryStatus)}
                      </small>
                    </td>
                    <td>
                      {recallDurationLabel(row.metadata?.timing?.durationMs)}
                    </td>
                    <td>
                      {recallTokenLabel(row.usage.totalTokens)}
                      {row.usage.coverage === "partial" && (
                        <small>Partial</small>
                      )}
                      {row.usage.includesEstimates && (
                        <small>Includes estimates</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <footer className="recall-pagination">
        <button
          type="button"
          disabled={loading || !cursors.length}
          onClick={() => {
            setCursors((value) => value.slice(0, -1));
          }}
        >
          Newer
        </button>
        <span>Page {cursors.length + 1}</span>
        <button
          type="button"
          disabled={loading || !page?.nextCursor}
          onClick={() => {
            if (page?.nextCursor) {
              setCursors([...cursors, page.nextCursor]);
            }
          }}
        >
          Older
        </button>
        {page && (
          <small>Updated {new Date(page.asOf).toLocaleTimeString()}</small>
        )}
      </footer>
      {selectedId && api && (
        <RecallActivityDetail
          api={api}
          adapters={adapters}
          questionId={selectedId}
          revision={JSON.stringify(
            page?.questions.find((row) => row.id === selectedId) ?? null
          )}
          onClose={() => {
            setSelectedId(null);
            selectedButton.current?.focus();
          }}
        />
      )}
    </section>
  );
}
