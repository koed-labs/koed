import { Badge } from "@koed-labs/ui";
import { AlertCircle, CheckCircle2, CircleDashed, Clock3 } from "lucide-react";
import type { RecallActivityQuestion } from "@koed-labs/shared/personal-desktop";

const outcomeLabels = {
  found: "Memory found",
  not_found: "No matching Memory",
  insufficient: "Partial evidence",
  pending_summary: "Summaries pending",
  unknown: "Unknown",
  error: "Recorded error"
};

export function RecallActivityOutcome({
  status,
  memoryStatus
}: {
  status: RecallActivityQuestion["status"];
  memoryStatus: NonNullable<RecallActivityQuestion["metadata"]>["memoryStatus"];
}) {
  const outcome = status === "error" ? "error" : (memoryStatus ?? "unknown");
  const Icon =
    outcome === "found"
      ? CheckCircle2
      : outcome === "error"
        ? AlertCircle
        : outcome === "pending_summary"
          ? Clock3
          : CircleDashed;
  return (
    <Badge variant="outline" className={`recall-outcome is-${outcome}`}>
      <Icon />
      {outcomeLabels[outcome]}
    </Badge>
  );
}
