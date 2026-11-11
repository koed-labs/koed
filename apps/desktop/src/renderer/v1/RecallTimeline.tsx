import { useId } from "react";

export function RecallTimeline({
  title,
  points,
  timezone,
  unit
}: {
  title: string;
  points: {
    start: string;
    value: number | null;
    breakdown?: Record<string, number>;
  }[];
  timezone: string;
  unit: string;
}) {
  const id = useId();
  const breakdownKeys = Object.keys(
    points.find((point) => point.breakdown)?.breakdown ?? {}
  );
  const max = Math.max(1, ...points.map((point) => point.value ?? 0));
  const x = (index: number) =>
    20 + (index * 720) / Math.max(1, points.length - 1);
  const y = (value: number) => 132 - (value / max) * 112;
  let previousKnown = false;
  const path = points
    .map((point, index) => {
      if (point.value === null) {
        previousKnown = false;
        return "";
      }
      const command = previousKnown ? "L" : "M";
      previousKnown = true;
      return `${command}${x(index)},${y(point.value)}`;
    })
    .join(" ");
  const label = (start: string) =>
    new Date(start).toLocaleDateString(undefined, {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  return (
    <figure className="recall-chart" aria-labelledby={id}>
      <figcaption id={id}>{title}</figcaption>
      {points.every((point) => point.value === null) && (
        <p className="recall-coverage">No attributable usage in this period.</p>
      )}
      {!points.every((point) => point.value === null) && (
        <p className="recall-chart-scale">
          0–{max.toLocaleString()} {unit.toLowerCase()}
        </p>
      )}
      <svg
        viewBox="0 0 760 140"
        role="img"
        aria-label={`${title}. Values are available in the table below.`}
      >
        <line
          x1="20"
          y1="132"
          x2="740"
          y2="132"
          className="recall-chart-axis"
        />
        <path d={path} className="recall-chart-line" />
        {points.map(
          (point, index) =>
            point.value !== null && (
              <circle key={point.start} cx={x(index)} cy={y(point.value)} r="3">
                <title>
                  {label(point.start)}: {point.value.toLocaleString()} {unit}
                  {point.breakdown
                    ? `; ${Object.entries(point.breakdown)
                        .map(([label, count]) => `${label}: ${count}`)
                        .join(", ")}`
                    : ""}
                </title>
              </circle>
            )
        )}
      </svg>
      <div className="recall-chart-labels" aria-hidden="true">
        <span>{points[0] ? label(points[0].start) : ""}</span>
        <span>{points.at(-1) ? label(points.at(-1)!.start) : ""}</span>
      </div>
      <details>
        <summary>View timeline values</summary>
        <div className="recall-timeline-values">
          <table>
            <thead>
              <tr>
                <th>Period starting ({timezone})</th>
                <th>{unit}</th>
                {breakdownKeys.map((key) => (
                  <th key={key}>{key}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.start}>
                  <td>{label(point.start)}</td>
                  <td>
                    {point.value === null
                      ? "Unavailable"
                      : point.value.toLocaleString()}
                  </td>
                  {breakdownKeys.map((key) => (
                    <td key={key}>{point.breakdown?.[key] ?? "Unknown"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
