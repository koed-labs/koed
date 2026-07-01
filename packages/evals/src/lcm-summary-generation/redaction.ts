import type { LcmSummaryBenchmarkCase } from "./cases.js";

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const redactString = (value: string, redactions: string[]): string =>
  redactions.reduce(
    (current, redaction) =>
      current.replace(new RegExp(escapeRegExp(redaction), "gi"), "[REDACTED]"),
    value
  );

export const redactLcmSummaryBenchmarkValue = (
  value: unknown,
  redactions: string[]
): unknown => {
  if (redactions.length === 0) {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value, redactions);
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      redactLcmSummaryBenchmarkValue(item, redactions)
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactString(key, redactions),
        redactLcmSummaryBenchmarkValue(item, redactions)
      ])
    );
  }
  return value;
};

export const lcmSummaryBenchmarkReportRedactions = (
  cases: LcmSummaryBenchmarkCase[]
): string[] => [
  ...new Set(
    cases.flatMap(
      (benchmarkCase) =>
        benchmarkCase.expected.forbiddenClaims
          ?.filter((claim) => claim.redactInReports === true)
          .flatMap((claim) => claim.match.exactPhrases ?? []) ?? []
    )
  )
];
