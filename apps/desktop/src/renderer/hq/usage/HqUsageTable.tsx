import { RotateCcw } from "lucide-react";
import type { DesktopApi } from "../../../types.js";
import {
  usageAge,
  usageCell,
  usageForWindow,
  type UsageCell,
  type UsageReading
} from "./hq-usage-model.js";
import { useHqUsage } from "./use-hq-usage.js";
import "./hq-usage.css";

const sourceFor = (driver: string): UsageReading["source"] | null =>
  driver === "codex"
    ? "codex_app_server"
    : driver === "claude"
      ? "claude_agent_sdk"
      : null;
const displayName = (driver: string, name: string) =>
  driver === "pi" ? "Pi" : name;

function Cell({ cell, note }: { cell: UsageCell; note?: string }) {
  return (
    <div
      className={`hq-usage__cell${cell.low ? " hq-usage__cell--low" : ""}`}
      title={cell.tooltip}
    >
      <strong>
        {note ? `${note} ` : ""}
        {cell.text}
      </strong>
      {cell.percent !== null ? (
        <span className="hq-usage__bar" aria-hidden="true">
          <i
            style={{ width: `${Math.max(2, Math.min(100, cell.percent))}%` }}
          />
        </span>
      ) : null}
      {cell.reset ? <small>{cell.reset}</small> : null}
    </div>
  );
}

export function HqUsageTable({
  localAiClients,
  authorityKey
}: {
  localAiClients?: DesktopApi["localAiClients"];
  authorityKey: string;
}) {
  const usage = useHqUsage(localAiClients, authorityKey);
  const codex = usage.instances.find(
    (instance) => instance.driverId === "codex" && instance.enabled
  );
  return (
    <section className="hq-usage" aria-label="AI Client usage">
      <div className="hq-usage__heading">
        <h3>Usage</h3>
        <p>From each provider, including use outside Koed</p>
        <button
          type="button"
          aria-label="Check usage now"
          title="Check now"
          disabled={!codex || usage.busy}
          onClick={() => codex && void usage.refresh(codex.instanceId)}
        >
          <RotateCcw size={15} />
        </button>
      </div>
      <div
        className="hq-usage__table"
        role="table"
        aria-label="AI Client usage"
      >
        <div className="hq-usage__row hq-usage__header" role="row">
          <span role="columnheader">AI Client</span>
          <span role="columnheader">5 hours</span>
          <span role="columnheader">Week</span>
        </div>
        {usage.instances
          .filter((instance) => instance.enabled)
          .map((instance) => {
            const source = sourceFor(instance.driverId);
            const own = usage.readings.filter(
              (reading) => reading.instanceId === instance.instanceId
            );
            const newest = own
              .map((reading) => Date.parse(reading.observedAt))
              .filter(Number.isFinite)
              .sort((a, b) => b - a)[0];
            const old =
              newest !== undefined && Date.now() - newest > 15 * 60_000;
            const label = displayName(instance.driverId, instance.displayName);
            const selectedModel =
              usage.readModel?.settings.find(
                (setting) =>
                  setting.flowKey === "conversations" &&
                  setting.aiClientInstanceId === instance.instanceId
              )?.model ??
              (usage.readModel?.defaults.conversations?.assignment
                ?.ai_client_instance_id === instance.instanceId
                ? usage.readModel.defaults.conversations.assignment.model
                : "");
            const fiveWindow = source
              ? usageForWindow(own, source, "five", selectedModel)
              : null;
            const weekWindow = source
              ? usageForWindow(
                  own,
                  source,
                  "week",
                  source === "claude_agent_sdk" ? "" : selectedModel
                )
              : null;
            const five = fiveWindow?.primary ?? null;
            const weekReading = weekWindow?.primary ?? null;
            const codexFiveNote =
              source === "codex_app_server" ? fiveWindow?.note : null;
            const codexWeekNote =
              source === "codex_app_server" ? weekWindow?.note : null;
            const note =
              weekReading?.window === "seven_day_opus"
                ? "Opus"
                : weekReading?.window === "seven_day_sonnet"
                  ? "Sonnet"
                  : weekReading?.window === "seven_day_overage_included"
                    ? "Overage"
                    : undefined;
            return (
              <div
                className="hq-usage__row"
                role="row"
                key={instance.instanceId}
              >
                <div
                  className="hq-usage__name"
                  role="cell"
                  title={
                    newest !== undefined
                      ? `Reported by ${label} · checked ${usageAge(new Date(newest).toISOString())}`
                      : `Not shared by ${label}`
                  }
                >
                  <strong>{label}</strong>
                  {old ? (
                    <small>
                      as of {usageAge(new Date(newest).toISOString())}
                    </small>
                  ) : null}
                </div>
                {source ? (
                  <>
                    <div role="cell">
                      <Cell cell={usageCell(five)} />
                      {codexFiveNote ? (
                        <small className="hq-usage__note">
                          {codexFiveNote.bucketName ?? codexFiveNote.bucketId}{" "}
                          {usageCell(codexFiveNote).text}
                        </small>
                      ) : null}
                    </div>
                    <div role="cell">
                      <Cell cell={usageCell(weekReading)} note={note} />
                      {codexWeekNote ? (
                        <small className="hq-usage__note">
                          {codexWeekNote.bucketName ?? codexWeekNote.bucketId}{" "}
                          {usageCell(codexWeekNote).text}
                        </small>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <div className="hq-usage__unshared" role="cell">
                    Not shared by {label}
                  </div>
                )}
              </div>
            );
          })}
      </div>
      {usage.refreshMessage ? (
        <p className="hq-usage__message" role="status">
          {usage.refreshMessage}
        </p>
      ) : null}
    </section>
  );
}
