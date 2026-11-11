import {
  Card,
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  ScrollArea,
  Skeleton
} from "@koed/ui";
import { MessageSquare, Layers, Clock3, Zap } from "lucide-react";
import type { RecallActivityOverview } from "@koed/shared/personal-desktop";
import {
  recallDurationLabel,
  recallTokenLabel
} from "./recall-activity-model.js";
import { RecallTimeline } from "./RecallTimeline.js";

export function RecallActivitySummary({
  overview,
  loading
}: {
  overview: RecallActivityOverview | null;
  loading: boolean;
}) {
  const stats = [
    {
      icon: MessageSquare,
      name: "Recorded answers",
      value: overview
        ? (
            overview.recordedQuestions - overview.recordedErrors
          ).toLocaleString()
        : "—",
      note: overview
        ? `${overview.recordedErrors.toLocaleString()} recorded ${overview.recordedErrors === 1 ? "error" : "errors"}`
        : "Completed answers and recorded errors"
    },
    {
      icon: Layers,
      name: "Memory found",
      value:
        overview?.memoryResults.foundPercentage == null
          ? "—"
          : `${overview.memoryResults.foundPercentage.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`,
      note: overview
        ? `${overview.memoryResults.found.toLocaleString()} of ${(overview.memoryResults.found + overview.memoryResults.not_found).toLocaleString()} found / not found`
        : "No known results"
    },
    {
      icon: Clock3,
      name: "Median duration",
      value:
        overview?.medianDurationMs == null
          ? "—"
          : recallDurationLabel(overview.medianDurationMs),
      note: "Includes queueing and retries"
    },
    {
      icon: Zap,
      name: "Known synthesis tokens",
      value:
        overview?.tokens.totalTokens == null
          ? "—"
          : recallTokenLabel(overview.tokens.totalTokens),
      note: overview
        ? `${overview.linkedQuestions.toLocaleString()} linked answers${overview.tokens.coverage === "partial" ? " · partial usage" : overview.tokens.coverage === "unavailable" ? " · usage unavailable" : ""}${overview.tokens.includesEstimates ? " · estimates" : ""}`
        : "Usage unavailable"
    }
  ];
  return (
    <Card
      className="recall-stats"
      aria-label="Recall overview"
      aria-busy={loading}
    >
      {stats.map(({ icon: Icon, name, value, note }) => (
        <div className="recall-stat" key={name}>
          <span>
            <Icon />
            {name}
          </span>
          {loading && !overview ? (
            <Skeleton className="recall-stat-loading" />
          ) : (
            <strong>{value}</strong>
          )}
          <small>{note}</small>
        </div>
      ))}
    </Card>
  );
}

export function RecallActivityCoverage({
  overview,
  open,
  onOpenChange
}: {
  overview: RecallActivityOverview | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="v1-app recall-activity recall-detail recall-metrics-dialog">
        <ScrollArea className="recall-dialog-scroll">
          <div className="recall-dialog-content">
            <DialogTitle>About these metrics</DialogTitle>
            <DialogDescription>
              Recorded Memory Answers and known Answer Synthesis usage.
            </DialogDescription>
            <p>
              Requests that ended before a final answer was recorded may be
              absent. Recorded errors are not recall misses.
            </p>
            <p>
              Memory found is found ÷ (found + not found). Partial evidence,
              pending summaries, unknown results and errors are excluded.
              Missing results remain unknown.
            </p>
            <p>
              Duration measures task acceptance to completion, including
              queueing and retries. It is not client request latency. The median
              uses every known duration in the filtered range.
            </p>
            <p>
              Only linked usage contributes to these totals. Older answers often
              lack links; unknown usage is not zero. Token dates describe when
              usage was observed, which may differ from the answer’s recorded
              date. Totals may be partial and are not a complete billing total.
            </p>
            <p>
              Date, caller, outcome and advanced filters apply to the whole
              range. Question search only finds text on the loaded page and does
              not change the overview.
            </p>
            {overview && (
              <>
                <p className="recall-coverage">
                  {overview.knownDurations.toLocaleString()} measured durations
                  · {overview.memoryResults.unknown.toLocaleString()} unknown
                  results · {overview.tokens.recordedAttempts.toLocaleString()}{" "}
                  recorded usage attempts
                  {overview.tokens.includesEstimates
                    ? " · includes estimates"
                    : ""}
                  . Updated {new Date(overview.asOf).toLocaleString()}.
                </p>
                <RecallTimeline
                  title={`Known synthesis tokens by observation ${overview.bucket}`}
                  points={overview.tokenTimeline.map((point) => ({
                    start: point.start,
                    value: point.totalTokens
                  }))}
                  timezone={overview.timezone}
                  unit="Known tokens"
                  hourly={overview.bucket === "hour"}
                />
              </>
            )}
          </div>
        </ScrollArea>
      </DialogPopup>
    </Dialog>
  );
}
