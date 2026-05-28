import type { WorkerJsonCase } from "./benchmark.js";

export const workerJsonCases: WorkerJsonCase[] = [
  {
    id: "memory-found-project-decision",
    worker: "memory_answer",
    prompt:
      "What did we decide about where answer synthesis should run for Koed Self-Hosted?",
    expected: {
      status: "found",
      requiredSubstrings: ["local Codex", "subscription"],
      minEvidenceItems: 1
    },
    notes:
      "Memory Answer should return strict JSON, mark relevant memory found, and include supporting evidence metadata."
  },
  {
    id: "memory-not-found-irrelevant-candidates",
    worker: "memory_answer",
    prompt: "Have we discussed the billing dashboard codename?",
    expected: {
      status: "not_found",
      requiredSubstrings: ["No matching memory"],
      minEvidenceItems: 0
    },
    notes:
      "Irrelevant retrieval candidates should not be promoted into a fake answer."
  },
  {
    id: "memory-insufficient-partial-evidence",
    worker: "memory_answer",
    prompt:
      "What exact model and temperature did we choose for the answer worker when only the model is present in evidence?",
    expected: {
      status: "insufficient",
      relevantMemoryFound: true,
      requiredSubstrings: ["missing"],
      minEvidenceItems: 1
    },
    notes:
      "Partial relevant evidence should be marked insufficient instead of filled in from outside knowledge."
  },
  {
    id: "memory-pending-summary",
    worker: "memory_answer",
    prompt:
      "Answer from a memory node whose matching evidence says summaries are still pending.",
    expected: {
      status: "pending_summary",
      relevantMemoryFound: true,
      requiredSubstrings: ["summary"],
      minEvidenceItems: 0
    },
    notes:
      "Pending LCM summaries should be represented explicitly instead of pretending the answer is complete."
  },
  {
    id: "lcm-leaf-preserves-operational-details",
    worker: "lcm_summary",
    prompt:
      "Summarise a leaf containing a user request, Docker rebuild, file path, command, and unresolved UI regression.",
    expected: {
      requiredSubstrings: ["Docker", "regression"],
      requiredArrayKeys: ["user_requests", "commands", "errors"],
      minNonEmptyStructuredArrays: 3
    },
    notes:
      "LCM leaf summaries should preserve durable operational details in structured arrays as well as summary_text."
  },
  {
    id: "lcm-rollup-preserves-decisions-and-provenance",
    worker: "lcm_summary",
    prompt:
      "Roll up child summaries covering a projection decision, affected files, and node provenance.",
    expected: {
      requiredSubstrings: ["projection"],
      requiredArrayKeys: ["decisions", "files", "provenance_hints"],
      minNonEmptyStructuredArrays: 3
    },
    notes:
      "LCM rollups should keep structured decisions and trace hints instead of flattening everything to prose."
  }
];
