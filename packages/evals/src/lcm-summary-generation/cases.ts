import type { LcmSummaryNode } from "@koed/mcp-server";

export interface LcmSummaryTermMatch {
  exactPhrases?: string[];
  phraseGroups?: string[][];
  allTerms?: string[];
  anyTermGroups?: string[][];
}

export interface LcmSummaryRequiredClaim {
  id: string;
  label: string;
  match: LcmSummaryTermMatch;
  critical?: boolean;
}

export interface LcmSummaryForbiddenClaim {
  id: string;
  label: string;
  match: LcmSummaryTermMatch;
  allowedContextTerms?: string[];
  critical?: boolean;
  redactInReports?: boolean;
}

export interface LcmSummaryBenchmarkCase {
  id: string;
  name: string;
  runs?: number;
  node: LcmSummaryNode;
  expected: {
    requiredClaims: LcmSummaryRequiredClaim[];
    forbiddenClaims?: LcmSummaryForbiddenClaim[];
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
          label: "backend returns only Evidence Bundles",
          match: {
            allTerms: ["backend", "Evidence Bundles"],
            anyTermGroups: [["return", "returns", "returned"], ["only"]]
          },
          critical: true
        },
        {
          id: "ai-client-synthesis",
          label: "Answer Synthesis remains in the connected AI Client",
          match: {
            allTerms: ["Answer Synthesis"],
            phraseGroups: [
              [
                "remains in the connected AI Client",
                "stays in the connected AI Client",
                "is kept in the connected AI Client",
                "run in the connected AI Client",
                "run within the connected AI Client",
                "runs in the connected AI Client",
                "runs within the connected AI Client"
              ]
            ]
          },
          critical: true
        }
      ],
      forbiddenClaims: [
        {
          id: "backend-llm",
          label: "backend LLM answer generation",
          match: {
            allTerms: ["backend"],
            anyTermGroups: [
              ["LLM", "server-side"],
              ["answers", "generation", "generates"]
            ]
          },
          critical: true
        }
      ],
      maxSummaryTextChars: 900
    },
    notes: "Preserves the product boundary between Recall and Answer Synthesis."
  },
  {
    id: "superseded-decision-typescript-hook",
    name: "Superseded capture hook decision",
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
          label: "only the TypeScript Codex Capture Hook is supported",
          match: {
            allTerms: ["Codex Capture Hook"],
            anyTermGroups: [
              ["TypeScript", "TypeScript-only"],
              ["only", "sole", "exclusive", "TypeScript-only"],
              ["support", "supported", "supporting", "TypeScript-only"]
            ]
          },
          critical: true
        },
        {
          id: "python-superseded",
          label: "Python hook was removed or superseded",
          match: {
            allTerms: ["Python"],
            anyTermGroups: [
              ["hook", "Capture Hook"],
              ["remove", "removed", "supersede", "superseded"]
            ]
          },
          critical: true
        }
      ],
      forbiddenClaims: [
        {
          id: "python-still-supported",
          label: "Python hook remains supported",
          match: {
            exactPhrases: [
              "Python hook remains supported",
              "Python Capture Hook remains supported",
              "Python hook is supported",
              "Python Capture Hook is supported"
            ]
          },
          critical: true
        }
      ],
      maxSummaryTextChars: 900
    },
    notes: "Checks that latest accepted state wins over stale discussion."
  },
  {
    id: "error-then-fix-projection-status",
    name: "Projection error then fix",
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
          label: "projection_status was stuck pending",
          match: {
            allTerms: ["projection_status", "pending"],
            anyTermGroups: [["stuck", "stayed", "remained"]]
          },
          critical: true
        },
        {
          id: "raw-only-fix",
          label: "LCM app-server telemetry marked raw_only",
          match: {
            allTerms: ["LCM app-server telemetry", "raw_only"]
          },
          critical: true
        }
      ],
      maxSummaryTextChars: 900
    },
    notes: "Preserves both the failure and the final implementation fix."
  },
  {
    id: "long-tool-output-one-durable-fact",
    name: "Long tool output durable fact",
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
          label: "memory node backfill migration requires first fresh reset",
          match: {
            exactPhrases: ["migration 0012_memory_nodes_backfill"],
            allTerms: ["first migration", "fresh local reset"]
          },
          critical: true
        }
      ],
      forbiddenClaims: [
        {
          id: "all-tables-important",
          label: "noisy table check output",
          match: {
            exactPhrases: ["checking table 001"]
          },
          critical: false
        }
      ],
      maxSummaryTextChars: 700
    },
    notes: "Checks that noise is compressed while the durable fact survives."
  },
  {
    id: "exact-identifiers-files-commands-env",
    name: "Exact files commands and env vars",
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
          label: "codex integration doc path",
          match: {
            exactPhrases: ["docs/codex-integration.md"]
          },
          critical: true
        },
        {
          id: "smoke-command",
          label: "LCM smoke command",
          match: {
            exactPhrases: ["pnpm smoke:lcm"]
          },
          critical: true
        },
        {
          id: "prompt-token-env",
          label: "LCM prompt token env var",
          match: {
            exactPhrases: ["MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS"]
          },
          critical: true
        }
      ],
      maxSummaryTextChars: 900
    },
    notes:
      "Exact identifiers should survive and land in the right structured fields."
  },
  {
    id: "unresolved-team-memory-question",
    name: "Unresolved team memory question",
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
          label: "team memory default Memory Answer visibility is unresolved",
          match: {
            allTerms: ["team memory", "Memory Answer", "default"],
            anyTermGroups: [["visible", "visibility"]]
          },
          critical: true
        },
        {
          id: "scope-domain-open",
          label: "Search Domain and Retrieval Scope interaction is unresolved",
          match: {
            allTerms: ["Search Domain", "Retrieval Scope", "team memory"]
          },
          critical: true
        }
      ],
      forbiddenClaims: [
        {
          id: "team-memory-decided",
          label: "team memory visible by default as decision",
          match: {
            allTerms: ["team memory", "visible", "default"],
            anyTermGroups: [["accepted", "decided", "decision"]]
          },
          allowedContextTerms: ["not decided", "undecided", "unresolved"],
          critical: true
        }
      ],
      maxSummaryTextChars: 800
    },
    notes: "Open issues must remain unresolved, not become decisions."
  },
  {
    id: "rollup-child-summaries",
    name: "Rollup child summaries",
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
          label: "raw conversation_items become Memory Events",
          match: {
            allTerms: ["raw conversation_items", "Memory Events"],
            anyTermGroups: [
              ["Projection", "project", "projects", "create", "creates"]
            ]
          },
          critical: true
        },
        {
          id: "rollups-child-summaries",
          label: "rollups summarize child LCM summaries",
          match: {
            allTerms: ["rollups", "child LCM summaries"],
            anyTermGroups: [["summarize", "summarizes", "operate"]]
          },
          critical: true
        }
      ],
      maxSummaryTextChars: 900
    },
    notes:
      "Rollup should preserve broad child-summary facts and node provenance."
  },
  {
    id: "rollup-conflict-latest-wins",
    name: "Rollup conflict latest wins",
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
          label: "diagnostic low-level memory tools stay hidden unless enabled",
          match: {
            allTerms: ["diagnostic low-level memory tools", "hidden"],
            phraseGroups: [
              [
                "unless explicitly enabled",
                "unless enabled explicitly",
                "when explicitly enabled",
                "when enabled explicitly",
                "if explicitly enabled",
                "if enabled explicitly"
              ]
            ]
          },
          critical: true
        }
      ],
      forbiddenClaims: [
        {
          id: "diagnostic-default",
          label: "diagnostic tools enabled by default as active state",
          match: {
            exactPhrases: ["enabled by default for all users"]
          },
          allowedContextTerms: [
            "superseded",
            "earlier",
            "initial",
            "initially"
          ],
          critical: true
        }
      ],
      maxSummaryTextChars: 850
    },
    notes:
      "Later child summary should supersede older conflicting child summary."
  },
  {
    id: "noisy-lifecycle-items",
    name: "Noisy lifecycle items",
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
          label: "lifecycle noise remains raw unless retrieval reason exists",
          match: {
            allTerms: [
              "lifecycle noise",
              "raw records",
              "deliberate retrieval reason"
            ],
            anyTermGroups: [["remain", "keep", "kept"]]
          },
          critical: true
        }
      ],
      maxSummaryTextChars: 700
    },
    notes:
      "The summary should compress lifecycle noise rather than list every event."
  },
  {
    id: "model-name-preservation",
    name: "Model name preservation",
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
          label: "LCM model name",
          match: {
            exactPhrases: ["gpt-5.4-mini"]
          },
          critical: true
        },
        {
          id: "reasoning-medium",
          label: "medium reasoning effort",
          match: {
            allTerms: ["reasoning effort", "medium"]
          },
          critical: true
        }
      ],
      maxSummaryTextChars: 700
    },
    notes: "Model identifiers should not be normalized away."
  },
  {
    id: "provenance-source-anchor",
    name: "Provenance source anchor",
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
          label: "source anchor id",
          match: {
            exactPhrases: ["00000000-0000-4000-8000-000000300001"]
          },
          critical: true
        },
        {
          id: "expand-needs-anchor",
          label: "expand needs source anchors to trace claims",
          match: {
            allTerms: ["source", "trace", "claim"],
            anyTermGroups: [["expand", "expansion"]]
          },
          critical: true
        }
      ],
      maxSummaryTextChars: 800
    },
    notes: "Provenance hints should keep useful source ids."
  },
  {
    id: "secret-like-value-redaction",
    name: "Secret-like value redaction",
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
          label: "API Token was rotated",
          match: {
            allTerms: ["API token", "rotated"]
          },
          critical: true
        },
        {
          id: "literal-redacted",
          label: "literal secret should be redacted",
          match: {
            allTerms: ["secret"],
            anyTermGroups: [["redact", "redacted", "redacting"]]
          },
          critical: true
        }
      ],
      forbiddenClaims: [
        {
          id: "literal-token",
          label: "literal secret token",
          match: {
            exactPhrases: ["koed_live_secret_abc123"]
          },
          critical: true,
          redactInReports: true
        }
      ],
      maxSummaryTextChars: 700
    },
    notes: "Secret-like source text must not be reproduced in benchmark output."
  }
];
