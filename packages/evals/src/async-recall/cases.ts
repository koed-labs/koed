import type { RecallCase } from "./benchmark.js";

const primary = {
  phase: "primary" as const,
  memory:
    "We agreed to retry transient import failures exactly once. Never cache authorization decisions.",
  expected: { outcome: "decided", retry_count: 1, cache_authorization: false }
};
const independentPrompt =
  "Recall our previous import retry decision while collecting the current diagnostics with read_import_diagnostics; those diagnostics do not depend on memory. Then record the implementation decision with record_import_decision only after obtaining the recalled constraints. Do not change code.";
export const asyncRecallCases: RecallCase[] = [
  {
    id: "independent-diagnostics",
    prompt: independentPrompt,
    independentWork: true,
    phases: [{ ...primary, preferredMode: "non_blocking" }]
  },
  {
    id: "dependent-decision",
    prompt:
      "The import diagnostics have already been collected. Recall the previous retry decision and record it with record_import_decision. The next action depends on the recalled constraints. Do not change code.",
    independentWork: false,
    phases: [{ ...primary, preferredMode: "blocking" }]
  },
  {
    id: "no-relevant-memory",
    prompt: `${independentPrompt} If no relevant memory exists, record outcome unknown without inventing retry settings.`,
    independentWork: true,
    phases: [
      {
        phase: "primary",
        preferredMode: "non_blocking",
        memory: null,
        expected: { outcome: "unknown" }
      }
    ]
  },
  {
    id: "followup-mixed-modes",
    prompt: `${independentPrompt} After recording that primary decision, make a follow-up recall for the previously agreed retry delay and immediately record the followup decision with retry_delay_ms. No further independent work is required for that follow-up.`,
    independentWork: true,
    phases: [
      { ...primary, preferredMode: "non_blocking" },
      {
        phase: "followup",
        preferredMode: "blocking",
        memory:
          "The previously agreed retry delay is exactly 1729 milliseconds.",
        expected: { outcome: "decided", retry_delay_ms: 1729 }
      }
    ]
  }
];
