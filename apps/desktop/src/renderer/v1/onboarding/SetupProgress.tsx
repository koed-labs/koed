import { useState } from "react";
import { Progress } from "@koed-labs/ui";
import type { setupState } from "./model.js";

export function SetupProgress({
  runId,
  state,
  running,
  failed,
  inspecting
}: {
  runId: string | undefined;
  state: ReturnType<typeof setupState>;
  running: boolean;
  failed: boolean;
  inspecting: boolean;
}) {
  const [confirmed, setConfirmed] = useState({ runId, value: state.value });
  // Unknown byte totals during verification must not erase confirmed progress.
  // A retry has a new run ID and starts from its newly inspected prerequisites.
  const value =
    confirmed.runId === runId
      ? Math.max(confirmed.value, state.value)
      : state.value;
  if (confirmed.runId !== runId || confirmed.value !== value)
    setConfirmed({ runId, value });
  const percent = Math.floor(value);
  return (
    <div className="lp-progress-stack">
      <div className="lp-progress-label">
        <span>
          {state.ready
            ? "Setup complete"
            : running
              ? inspecting
                ? "Checking local setup"
                : state.copy.label
              : failed
                ? state.copy.label
                : "Ready to set up Koed"}
        </span>
        <span>{percent}%</span>
      </div>
      <Progress
        className="lp-progress-track"
        value={value}
        aria-label="Overall setup progress"
        aria-valuetext={
          running && state.indeterminate
            ? `${percent}% confirmed; ${state.copy.label} in progress`
            : `${percent}%`
        }
      />
      {running && state.detail && (
        <p className="lp-progress-detail">{state.detail}</p>
      )}
    </div>
  );
}
