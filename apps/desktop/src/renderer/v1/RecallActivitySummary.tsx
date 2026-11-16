import {
  Badge,
  Card,
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  ScrollArea,
  Skeleton
} from "@koed-labs/ui";
import { MessageSquare, Layers, Clock3, Zap } from "lucide-react";
import type { RecallActivityOverview } from "@koed-labs/shared/personal-desktop";
import {
  recallDurationLabel,
  recallOutcomes,
  recallTokenLabel
} from "./recall-activity-model.js";

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
        ? `${overview.memoryResults.found.toLocaleString()} of ${(overview.memoryResults.found + overview.memoryResults.not_found).toLocaleString()} found / unmatched`
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
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="v1-app recall-activity recall-detail recall-metrics-dialog">
        <ScrollArea className="recall-dialog-scroll">
          <div className="recall-dialog-content">
            <DialogTitle>Memory outcomes</DialogTitle>
            <DialogDescription>
              Each outcome shows what Koed found or why it did not answer.
            </DialogDescription>
            <table className="recall-outcome-guide">
              <caption className="sr-only">Memory outcome meanings</caption>
              <thead>
                <tr>
                  <th scope="col">Outcome</th>
                  <th scope="col">Meaning</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(recallOutcomes).map(
                  ([outcome, presentation]) => (
                    <tr key={outcome}>
                      <th scope="row">
                        <Badge
                          variant="outline"
                          className={`recall-outcome is-${outcome}`}
                        >
                          {presentation.label}
                        </Badge>
                      </th>
                      <td>{presentation.description}</td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
            <p className="recall-outcome-guide-note">
              Only Found and Unmatched count toward the Memory found percentage.
            </p>
          </div>
        </ScrollArea>
      </DialogPopup>
    </Dialog>
  );
}
