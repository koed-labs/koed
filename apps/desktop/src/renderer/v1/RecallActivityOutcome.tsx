import { Badge, Tooltip, TooltipPopup, TooltipTrigger } from "@koed-labs/ui";
import { useId } from "react";
import { AlertCircle, CheckCircle2, CircleDashed, Clock3 } from "lucide-react";
import type { RecallActivityQuestion } from "@koed-labs/shared/personal-desktop";

import { recallOutcomes } from "./recall-activity-model.js";

export function RecallActivityOutcome({
  status,
  memoryStatus
}: {
  status: RecallActivityQuestion["status"];
  memoryStatus: NonNullable<RecallActivityQuestion["metadata"]>["memoryStatus"];
}) {
  const descriptionId = useId();
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
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge variant="outline" className={`recall-outcome is-${outcome}`} />
        }
        tabIndex={0}
        aria-describedby={descriptionId}
      >
        <Icon aria-hidden="true" />
        {recallOutcomes[outcome].label}
      </TooltipTrigger>
      <TooltipPopup id={descriptionId} role="tooltip" className="max-w-72">
        {recallOutcomes[outcome].description}
      </TooltipPopup>
    </Tooltip>
  );
}
