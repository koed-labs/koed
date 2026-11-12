import { useId, useState } from "react";
import { Card, CardHeader, CardTitle, Skeleton } from "@koed-labs/ui";
import type { RecallActivityOverview } from "@koed-labs/shared/personal-desktop";
import { recallChartModel } from "./recall-activity-model.js";

export function RecallActivityChart({
  overview,
  from,
  to,
  loading
}: {
  overview: RecallActivityOverview | null;
  from: string;
  to: string;
  loading: boolean;
}) {
  const titleId = useId();
  const [hover, setHover] = useState<string | null>(null);
  const chart = overview ? recallChartModel(overview, from, to) : null;
  const max = Math.max(
    1,
    ...(chart?.buckets.map((point) => point.count) ?? [])
  );
  const tickEvery = Math.ceil((chart?.buckets.length ?? 1) / 7);
  return (
    <Card
      className="recall-chart-card"
      aria-labelledby={titleId}
      aria-busy={loading}
    >
      <CardHeader className="recall-card-heading">
        <CardTitle id={titleId}>Recall over time</CardTitle>
        <span className="recall-chart-range" title={chart?.label}>
          {chart?.label ?? "Selected range"}
        </span>
      </CardHeader>
      <div className="recall-chart-content">
        <div className="recall-legend">
          <span>
            <i className="found" />
            Found
          </span>
          <span>
            <i />
            Other outcomes
          </span>
          <span>
            <i className="error" />
            Error
          </span>
        </div>
        {!chart ? (
          <div className="recall-chart-placeholder">
            {loading ? <Skeleton /> : <p>Chart unavailable</p>}
          </div>
        ) : (
          <div
            className="recall-bars"
            style={{
              gridTemplateColumns: `repeat(${chart.buckets.length || 1}, minmax(0, 1fr))`
            }}
            aria-label={`${chart.resolution} recorded recall activity`}
            data-resolution={chart.resolution}
          >
            {chart.buckets.map((point, index) => {
              const showTick =
                index === chart.buckets.length - 1 ||
                (index % tickEvery === 0 &&
                  (tickEvery === 1 || index < chart.buckets.length - 2));
              return (
                <button
                  key={point.start}
                  type="button"
                  className="recall-bar-group"
                  aria-label={`${point.rangeLabel}: ${point.found} found, ${point.other} other outcomes, ${point.errors} errors`}
                  onMouseEnter={() => setHover(point.start)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(point.start)}
                  onBlur={() => setHover(null)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setHover(null);
                  }}
                >
                  <span className="recall-bar-stack" aria-hidden="true">
                    <span
                      className="error"
                      style={{ height: `${(point.errors / max) * 100}%` }}
                    />
                    <span
                      className="other"
                      style={{ height: `${(point.other / max) * 100}%` }}
                    />
                    <span
                      className="found"
                      style={{ height: `${(point.found / max) * 100}%` }}
                    />
                  </span>
                  <small aria-hidden="true">
                    {showTick ? point.label : "\u00a0"}
                  </small>
                  {hover === point.start && (
                    <span
                      className="recall-chart-tip"
                      aria-hidden="true"
                      style={
                        index < chart.buckets.length / 2
                          ? { left: 0 }
                          : { right: 0 }
                      }
                    >
                      <strong>{point.rangeLabel}</strong>
                      <span>{point.count.toLocaleString()} records</span>
                      <span>
                        {point.found} found · {point.other} other ·{" "}
                        {point.errors} errors
                      </span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <footer className="recall-chart-footer">
          <span>{chart?.resolution ?? "—"}</span>
          <span>
            {overview
              ? `${overview.recordedQuestions.toLocaleString()} records`
              : "—"}
          </span>
        </footer>
      </div>
    </Card>
  );
}
