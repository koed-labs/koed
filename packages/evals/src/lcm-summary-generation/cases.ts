import type { LcmSummaryNode } from "@koed/mcp-server";

export type LcmSummaryField =
  | "summary_text"
  | "user_requests"
  | "decisions"
  | "facts"
  | "files"
  | "commands"
  | "model_names"
  | "tool_outcomes"
  | "errors"
  | "unresolved_questions"
  | "provenance_hints";

export interface LcmSummaryRequiredClaim {
  id: string;
  text: string;
  aliases?: string[];
  fields: LcmSummaryField[];
  critical?: boolean;
}

export interface LcmSummaryForbiddenClaim {
  id: string;
  text: string;
  aliases?: string[];
  critical?: boolean;
}

export interface LcmSummaryBenchmarkCase {
  id: string;
  name: string;
  runs: number;
  node: LcmSummaryNode;
  expected: {
    requiredClaims: LcmSummaryRequiredClaim[];
    forbiddenClaims?: LcmSummaryForbiddenClaim[];
    requiredNonEmptyFields?: LcmSummaryField[];
    minNonEmptyFields?: number;
    maxSummaryTextChars?: number;
  };
  notes: string;
}

const sourceId = (caseNumber: number, itemNumber: number): string =>
  `00000000-0000-4000-8000-${String(caseNumber).padStart(6, "0")}${String(
    itemNumber
  ).padStart(6, "0")}`.slice(0, 36);

export const lcmSummaryBenchmarkCases: LcmSummaryBenchmarkCase[] = [
  {
    id: "accepted-decision-ai-client-synthesis",
    name: "Accepted AI Client synthesis decision",
    runs: 1,
    node: {
      id: "00000000-0000-4000-8000-000000100001",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText:
        "LCM placeholder: discussion about where Koed answer synthesis should run.",
      sourceTokenEstimate: 280,
      sourceItems: [
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: sourceId(1, 1),
          actor: "user",
          turnId: "turn-ai-client-synthesis",
          createdAt: "2026-05-01T10:00:00.000Z",
          position: 0,
          text: "User asked whether Koed should synthesize memory answers in the backend or in the connected AI Client."
        },
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: sourceId(1, 2),
          actor: "agent",
          turnId: "turn-ai-client-synthesis",
          createdAt: "2026-05-01T10:02:00.000Z",
          position: 1,
          text: "Decision accepted: backend returns Evidence Bundles only; Answer Synthesis remains in the connected AI Client under the user's subscription."
        }
      ]
    },
    expected: {
      requiredClaims: [
        {
          id: "backend-evidence-only",
          text: "backend returns Evidence Bundles only",
          fields: ["decisions"],
          critical: true
        },
        {
          id: "ai-client-synthesis",
          text: "Answer Synthesis remains in the connected AI Client",
          fields: ["decisions"],
          critical: true
        }
      ],
      forbiddenClaims: [
        {
          id: "backend-llm",
          text: "backend generates answers with an LLM",
          aliases: ["server-side LLM answers", "backend answer generation"],
          critical: true
        }
      ],
      requiredNonEmptyFields: ["decisions", "provenance_hints"],
      minNonEmptyFields: 2,
      maxSummaryTextChars: 900
    },
    notes: "Preserves the product boundary between Recall and Answer Synthesis."
  },
  {
    id: "superseded-decision-typescript-hook",
    name: "Superseded capture hook decision",
    runs: 1,
    node: {
      id: "00000000-0000-4000-8000-000000100002",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: "LCM placeholder: capture hook implementation choice.",
      sourceTokenEstimate: 340,
      sourceItems: [
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: sourceId(2, 1),
          actor: "user",
          turnId: "turn-hook",
          createdAt: "2026-05-02T09:00:00.000Z",
          position: 0,
          text: "Early plan: keep a Python Capture Hook as a fallback while testing Codex transcript ingestion."
        },
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: sourceId(2, 2),
          actor: "agent",
          turnId: "turn-hook",
          createdAt: "2026-05-02T09:20:00.000Z",
          position: 1,
          text: "Later decision superseded the early plan: remove the Python hook and support only the TypeScript Codex Capture Hook."
        }
      ]
    },
    expected: {
      requiredClaims: [
        {
          id: "typescript-supported",
          text: "support only the TypeScript Codex Capture Hook",
          fields: ["decisions"],
          critical: true
        },
        {
          id: "python-superseded",
          text: "Python hook",
          aliases: ["Python Capture Hook"],
          fields: ["decisions"],
          critical: true
        }
      ],
      forbiddenClaims: [
        {
          id: "python-still-supported",
          text: "Python hook remains supported",
          critical: true
        }
      ],
      requiredNonEmptyFields: ["decisions"],
      minNonEmptyFields: 2,
      maxSummaryTextChars: 900
    },
    notes: "Checks that latest accepted state wins over stale discussion."
  },
  {
    id: "error-then-fix-projection-status",
    name: "Projection error then fix",
    runs: 1,
    node: {
      id: "00000000-0000-4000-8000-000000100003",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: "LCM placeholder: projection retry bug.",
      sourceTokenEstimate: 360,
      sourceItems: [
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: sourceId(3, 1),
          actor: "agent",
          turnId: "turn-projection-fix",
          createdAt: "2026-05-03T11:00:00.000Z",
          position: 0,
          text: "Test failed with projection_status stuck at pending after app-server workflow telemetry was persisted."
        },
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: sourceId(3, 2),
          actor: "agent",
          turnId: "turn-projection-fix",
          createdAt: "2026-05-03T11:15:00.000Z",
          position: 1,
          text: "Fix: mark LCM app-server telemetry as raw_only because the LCM node table is the projected store for completed summaries."
        }
      ]
    },
    expected: {
      requiredClaims: [
        {
          id: "pending-error",
          text: "projection_status stuck at pending",
          fields: ["errors"],
          critical: true
        },
        {
          id: "raw-only-fix",
          text: "mark LCM app-server telemetry as raw_only",
          fields: ["decisions"],
          critical: true
        }
      ],
      requiredNonEmptyFields: ["errors", "tool_outcomes"],
      minNonEmptyFields: 4,
      maxSummaryTextChars: 900
    },
    notes: "Preserves both the failure and the final implementation fix."
  },
  {
    id: "long-tool-output-one-durable-fact",
    name: "Long tool output durable fact",
    runs: 1,
    node: {
      id: "00000000-0000-4000-8000-000000100004",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: "LCM placeholder: noisy migration smoke output.",
      sourceTokenEstimate: 1_200,
      sourceItems: [
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: sourceId(4, 1),
          actor: "agent",
          turnId: "turn-long-tool",
          createdAt: "2026-05-04T08:00:00.000Z",
          position: 0,
          text: [
            "Tool output from migration smoke:",
            "checking table 001 ok",
            "checking table 002 ok",
            "checking table 003 ok",
            "checking table 004 ok",
            "checking table 005 ok",
            "durable finding: migration 0012_memory_nodes_backfill is the first migration that requires a fresh local reset in the MVP branch.",
            "checking table 006 ok",
            "checking table 007 ok",
            "checking table 008 ok"
          ].join("\n")
        }
      ]
    },
    expected: {
      requiredClaims: [
        {
          id: "migration-reset",
          text: "migration 0012_memory_nodes_backfill is the first migration that requires a fresh local reset",
          fields: ["facts"],
          critical: true
        }
      ],
      forbiddenClaims: [
        {
          id: "all-tables-important",
          text: "checking table 001",
          critical: false
        }
      ],
      requiredNonEmptyFields: ["facts", "tool_outcomes"],
      minNonEmptyFields: 3,
      maxSummaryTextChars: 700
    },
    notes: "Checks that noise is compressed while the durable fact survives."
  },
  {
    id: "exact-identifiers-files-commands-env",
    name: "Exact files commands and env vars",
    runs: 1,
    node: {
      id: "00000000-0000-4000-8000-000000100005",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: "LCM placeholder: operational LCM knobs.",
      sourceTokenEstimate: 420,
      sourceItems: [
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: sourceId(5, 1),
          actor: "user",
          turnId: "turn-identifiers",
          createdAt: "2026-05-05T13:00:00.000Z",
          position: 0,
          text: "User asked to document LCM runtime knobs in docs/codex-integration.md and verify them with pnpm smoke:lcm."
        },
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: sourceId(5, 2),
          actor: "agent",
          turnId: "turn-identifiers",
          createdAt: "2026-05-05T13:05:00.000Z",
          position: 1,
          text: "Important env vars: MEMORY_HOOK_TRIGGER_LCM_SUMMARY, MEMORY_HOOK_LCM_SUMMARY_LIMIT, and MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS."
        }
      ]
    },
    expected: {
      requiredClaims: [
        {
          id: "codex-doc",
          text: "docs/codex-integration.md",
          fields: ["files"],
          critical: true
        },
        {
          id: "smoke-command",
          text: "pnpm smoke:lcm",
          fields: ["commands"],
          critical: true
        },
        {
          id: "prompt-token-env",
          text: "MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS",
          fields: ["facts", "decisions"],
          critical: true
        }
      ],
      requiredNonEmptyFields: ["files", "commands", "facts"],
      minNonEmptyFields: 4,
      maxSummaryTextChars: 900
    },
    notes:
      "Exact identifiers should survive and land in the right structured fields."
  },
  {
    id: "unresolved-team-memory-question",
    name: "Unresolved team memory question",
    runs: 1,
    node: {
      id: "00000000-0000-4000-8000-000000100006",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: "LCM placeholder: team memory open question.",
      sourceTokenEstimate: 300,
      sourceItems: [
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: sourceId(6, 1),
          actor: "user",
          turnId: "turn-team-memory",
          createdAt: "2026-05-06T15:00:00.000Z",
          position: 0,
          text: "We have not decided whether team memory is visible in Memory Answer by default."
        },
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: sourceId(6, 2),
          actor: "agent",
          turnId: "turn-team-memory",
          createdAt: "2026-05-06T15:04:00.000Z",
          position: 1,
          text: "Open question: define how Search Domain and Retrieval Scope interact with future team memory before implementation."
        }
      ]
    },
    expected: {
      requiredClaims: [
        {
          id: "team-memory-undecided",
          text: "team memory is visible in Memory Answer by default",
          fields: ["unresolved_questions"],
          critical: true
        },
        {
          id: "scope-domain-open",
          text: "Search Domain and Retrieval Scope interact with future team memory",
          fields: ["unresolved_questions"],
          critical: true
        }
      ],
      forbiddenClaims: [
        {
          id: "team-memory-decided",
          text: "team memory is visible by default",
          critical: true
        }
      ],
      requiredNonEmptyFields: ["unresolved_questions"],
      minNonEmptyFields: 2,
      maxSummaryTextChars: 800
    },
    notes: "Open issues must remain unresolved, not become decisions."
  },
  {
    id: "rollup-child-summaries",
    name: "Rollup child summaries",
    runs: 1,
    node: {
      id: "00000000-0000-4000-8000-000000100007",
      visibility: "personal",
      kind: "rollup",
      depth: 1,
      summaryText: "LCM rollup placeholder: child LCM summaries.",
      sourceTokenEstimate: 520,
      sourceItems: [
        {
          kind: "lcm_child",
          nodeId: "00000000-0000-4000-8000-000000200001",
          visibility: "personal",
          position: 0,
          text: "Child summary: Projection creates Memory Events from raw conversation_items; source links preserve source ids."
        },
        {
          kind: "lcm_child",
          nodeId: "00000000-0000-4000-8000-000000200002",
          visibility: "personal",
          position: 1,
          text: "Child summary: LCM leaves are packed from Memory Events and rollups summarize child LCM summaries."
        }
      ]
    },
    expected: {
      requiredClaims: [
        {
          id: "projection-memory-events",
          text: "Projection creates Memory Events from raw conversation_items",
          fields: ["facts"],
          critical: true
        },
        {
          id: "rollups-child-summaries",
          text: "rollups summarize child LCM summaries",
          fields: ["facts"],
          critical: true
        }
      ],
      requiredNonEmptyFields: ["facts", "provenance_hints"],
      minNonEmptyFields: 2,
      maxSummaryTextChars: 900
    },
    notes:
      "Rollup should preserve broad child-summary facts and node provenance."
  },
  {
    id: "rollup-conflict-latest-wins",
    name: "Rollup conflict latest wins",
    runs: 1,
    node: {
      id: "00000000-0000-4000-8000-000000100008",
      visibility: "personal",
      kind: "rollup",
      depth: 1,
      summaryText: "LCM rollup placeholder: conflicting child summaries.",
      sourceTokenEstimate: 520,
      sourceItems: [
        {
          kind: "lcm_child",
          nodeId: "00000000-0000-4000-8000-000000200003",
          visibility: "personal",
          position: 0,
          text: "Older child summary: diagnostic low-level memory tools should be enabled by default for all users."
        },
        {
          kind: "lcm_child",
          nodeId: "00000000-0000-4000-8000-000000200004",
          visibility: "personal",
          position: 1,
          text: "Later child summary: diagnostic low-level memory tools stay hidden unless explicitly enabled."
        }
      ]
    },
    expected: {
      requiredClaims: [
        {
          id: "diagnostic-hidden",
          text: "diagnostic low-level memory tools stay hidden unless explicitly enabled",
          fields: ["decisions"],
          critical: true
        }
      ],
      forbiddenClaims: [
        {
          id: "diagnostic-default",
          text: "enabled by default for all users",
          critical: true
        }
      ],
      requiredNonEmptyFields: ["decisions", "provenance_hints"],
      minNonEmptyFields: 3,
      maxSummaryTextChars: 850
    },
    notes:
      "Later child summary should supersede older conflicting child summary."
  },
  {
    id: "noisy-lifecycle-items",
    name: "Noisy lifecycle items",
    runs: 1,
    node: {
      id: "00000000-0000-4000-8000-000000100009",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: "LCM placeholder: noisy lifecycle source items.",
      sourceTokenEstimate: 480,
      sourceItems: [
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: sourceId(9, 1),
          actor: "agent",
          turnId: "turn-noise",
          createdAt: "2026-05-09T09:00:00.000Z",
          position: 0,
          text: "SessionStart, Stop, SubagentStart, and SubagentStop lifecycle notifications appeared in the source stream."
        },
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: sourceId(9, 2),
          actor: "agent",
          turnId: "turn-noise",
          createdAt: "2026-05-09T09:03:00.000Z",
          position: 1,
          text: "Durable decision: lifecycle noise should remain raw records unless there is a deliberate retrieval reason to project it."
        }
      ]
    },
    expected: {
      requiredClaims: [
        {
          id: "lifecycle-raw",
          text: "lifecycle noise should remain raw records unless there is a deliberate retrieval reason",
          fields: ["decisions"],
          critical: true
        }
      ],
      requiredNonEmptyFields: ["decisions"],
      minNonEmptyFields: 2,
      maxSummaryTextChars: 700
    },
    notes:
      "The summary should compress lifecycle noise rather than list every event."
  },
  {
    id: "model-name-preservation",
    name: "Model name preservation",
    runs: 1,
    node: {
      id: "00000000-0000-4000-8000-000000100010",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: "LCM placeholder: model setting change.",
      sourceTokenEstimate: 260,
      sourceItems: [
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: sourceId(10, 1),
          actor: "agent",
          turnId: "turn-model",
          createdAt: "2026-05-10T16:00:00.000Z",
          position: 0,
          text: "For LCM Summary settings, the default model was set to gpt-5.4-mini with reasoning effort medium."
        }
      ]
    },
    expected: {
      requiredClaims: [
        {
          id: "model-name",
          text: "gpt-5.4-mini",
          fields: ["model_names"],
          critical: true
        },
        {
          id: "reasoning-medium",
          text: "reasoning effort medium",
          aliases: ["reasoning effort is medium"],
          fields: ["facts"],
          critical: true
        }
      ],
      requiredNonEmptyFields: ["model_names", "facts"],
      minNonEmptyFields: 3,
      maxSummaryTextChars: 700
    },
    notes: "Model identifiers should not be normalized away."
  },
  {
    id: "provenance-source-anchor",
    name: "Provenance source anchor",
    runs: 1,
    node: {
      id: "00000000-0000-4000-8000-000000100011",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: "LCM placeholder: provenance anchor.",
      sourceTokenEstimate: 320,
      sourceItems: [
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: "00000000-0000-4000-8000-000000300001",
          actor: "user",
          turnId: "turn-provenance-anchor",
          createdAt: "2026-05-11T12:00:00.000Z",
          position: 0,
          text: "User asked to keep source anchors because expand needs source:memory_events:00000000-0000-4000-8000-000000300001 to trace the claim."
        }
      ]
    },
    expected: {
      requiredClaims: [
        {
          id: "source-anchor",
          text: "00000000-0000-4000-8000-000000300001",
          fields: ["provenance_hints"],
          critical: true
        },
        {
          id: "expand-needs-anchor",
          text: "expand needs source anchors to trace the claim",
          aliases: ["expand needs source", "trace the claim"],
          fields: ["summary_text", "facts"],
          critical: true
        }
      ],
      requiredNonEmptyFields: ["provenance_hints", "facts"],
      minNonEmptyFields: 3,
      maxSummaryTextChars: 800
    },
    notes: "Provenance hints should keep useful source ids."
  },
  {
    id: "secret-like-value-redaction",
    name: "Secret-like value redaction",
    runs: 1,
    node: {
      id: "00000000-0000-4000-8000-000000100012",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: "LCM placeholder: API Token rotation.",
      sourceTokenEstimate: 300,
      sourceItems: [
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: sourceId(12, 1),
          actor: "user",
          turnId: "turn-secret-redaction",
          createdAt: "2026-05-12T18:00:00.000Z",
          position: 0,
          text: "User accidentally pasted API Token koed_live_secret_abc123 and immediately asked not to preserve the literal value."
        },
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: sourceId(12, 2),
          actor: "agent",
          turnId: "turn-secret-redaction",
          createdAt: "2026-05-12T18:02:00.000Z",
          position: 1,
          text: "Durable fact: API Token was rotated; summaries should record the rotation and redact the literal secret."
        }
      ]
    },
    expected: {
      requiredClaims: [
        {
          id: "token-rotated",
          text: "API Token was rotated",
          fields: ["facts", "tool_outcomes"],
          critical: true
        },
        {
          id: "literal-redacted",
          text: "redact the literal secret",
          aliases: ["literal secret should be redacted"],
          fields: ["summary_text", "facts"],
          critical: true
        }
      ],
      forbiddenClaims: [
        {
          id: "literal-token",
          text: "koed_live_secret_abc123",
          critical: true
        }
      ],
      requiredNonEmptyFields: ["facts"],
      minNonEmptyFields: 2,
      maxSummaryTextChars: 700
    },
    notes: "Secret-like source text must not be reproduced in benchmark output."
  }
];
