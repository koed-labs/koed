import type { MouseEvent } from "react";
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  ScrollArea,
  Skeleton
} from "@koed-labs/ui";
import { ArrowUpRight, Search } from "lucide-react";
import type { RecallActivityQuestion } from "@koed-labs/shared/personal-desktop";
import { AiClientLogo } from "../views/personal/AiClientLogo.js";
import {
  recallDurationLabel,
  recallTokenLabel
} from "./recall-activity-model.js";
import { recallCallerPresentation } from "./recall-activity-model.js";

import { RecallActivityOutcome } from "./RecallActivityOutcome.js";

export function RecallActivityTable({
  rows,
  total,
  loadedCount,
  loading,
  unavailable,
  pageNumber,
  hasOlder,
  search,
  onSelect,
  onNewer,
  onOlder,
  onReset
}: {
  rows: RecallActivityQuestion[];
  total: number | null;
  loadedCount: number;
  loading: boolean;
  unavailable: boolean;
  pageNumber: number;
  hasOlder: boolean;
  search: string;
  onSelect: (
    row: RecallActivityQuestion,
    event: MouseEvent<HTMLButtonElement>
  ) => void;
  onNewer: () => void;
  onOlder: () => void;
  onReset: () => void;
}) {
  return (
    <Card
      className="recall-activity-card"
      aria-labelledby="recall-activity-card-title"
      aria-busy={loading}
    >
      <CardHeader className="recall-card-heading">
        <CardTitle id="recall-activity-card-title">
          Recorded activity{" "}
          {total !== null && (
            <span className="recall-count">{total.toLocaleString()}</span>
          )}
        </CardTitle>
        <span>Newest first</span>
      </CardHeader>
      <ScrollArea
        className="recall-activity-scroll"
        aria-label="Recorded activity list"
        key={`${pageNumber}:${search}`}
      >
        {rows.length ? (
          <div className="recall-table-wrap">
            <table className="recall-table">
              <caption className="sr-only">
                Recorded Memory Answers, newest first
              </caption>
              <thead>
                <tr>
                  <th scope="col">Question</th>
                  <th scope="col">Memory outcome</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Tokens</th>
                  <th scope="col">Time</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const caller = recallCallerPresentation(
                    row.metadata?.caller?.name
                  );
                  return (
                    <tr key={row.id}>
                      <td>
                        <button
                          type="button"
                          className="recall-question-link"
                          onClick={(event) => onSelect(row, event)}
                        >
                          <span>{row.query ?? "Question unavailable"}</span>
                          <ArrowUpRight />
                        </button>
                        <div className="recall-row-meta">
                          <span
                            className={`recall-client ${caller.icon ?? ""}`}
                            title={row.metadata?.caller?.name ?? undefined}
                          >
                            {caller.icon && (
                              <span className="recall-client-logo">
                                <AiClientLogo id={caller.icon} />
                              </span>
                            )}
                            <span className="recall-client-name">
                              {caller.label}
                            </span>
                          </span>
                        </div>
                      </td>
                      <td>
                        <RecallActivityOutcome
                          status={row.status}
                          memoryStatus={row.metadata?.memoryStatus ?? null}
                        />
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
                      <td>
                        <time
                          dateTime={row.recordedAt}
                          title={new Date(row.recordedAt).toLocaleString()}
                        >
                          {new Date(row.recordedAt).toLocaleTimeString(
                            undefined,
                            {
                              hour: "2-digit",
                              minute: "2-digit",
                              hourCycle: "h23"
                            }
                          )}
                        </time>
                        <small>
                          {new Date(row.recordedAt).toLocaleDateString(
                            undefined,
                            { day: "numeric", month: "short" }
                          )}
                        </small>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : loading ? (
          <div className="recall-table-loading" role="status">
            <span className="sr-only">Loading recorded answers…</span>
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} />
            ))}
          </div>
        ) : (
          <div className="recall-empty" role="status">
            <Search />
            <strong>
              {unavailable ? "Activity unavailable" : "No matching activity"}
            </strong>
            <p>
              {unavailable
                ? "Reconnect to your memory backend and refresh."
                : search
                  ? "No questions on this page match your search."
                  : "No recorded Memory Answers match these filters."}
            </p>
            {!unavailable && (
              <Button variant="outline" size="sm" onClick={onReset}>
                Clear filters
              </Button>
            )}
          </div>
        )}
      </ScrollArea>
      <footer className="recall-activity-card-footer">
        <span>
          {search
            ? `${rows.length} of ${loadedCount} on this page`
            : `${loadedCount} shown`}
          <span className="recall-page-number"> · Page {pageNumber}</span>
        </span>
        <div className="recall-pagination">
          <Button
            variant="ghost"
            size="sm"
            disabled={loading || pageNumber === 1}
            onClick={onNewer}
          >
            Newer
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={loading || !hasOlder}
            onClick={onOlder}
          >
            Older
          </Button>
        </div>
      </footer>
    </Card>
  );
}
