export type RetrievalStage =
  | "score_scan"
  | "rollup_search"
  | "scoped_leaf_search"
  | "leaf_search"
  | "fresh_pending_search"
  | "raw_fallback_search"
  | "lexical_search";

export type SeedSourceType = "memory_event" | "memory_node";

export interface RetrievalSeedItem {
  id: string;
  sourceType: SeedSourceType;
  retrievalStage: Exclude<RetrievalStage, "score_scan">;
  text: string;
  relevant: boolean;
  createdDaysAgo: number;
  parentNodeIds?: string[];
  lcmDepth?: 0 | 1;
  lcmSummaryStatus?: "pending" | "summarized";
  tags?: string[];
}

export interface RetrievalSuccessCase {
  id: string;
  prompt: string;
  runs: number;
  boundaryProfile: "post-koe-166-defaults";
  seed: RetrievalSeedItem[];
  expected: {
    memoryStatus: "found" | "not_found" | "insufficient" | "pending_summary";
    answerSubstrings?: string[];
    requiredEvidenceIds?: string[];
    forbiddenEvidenceIds?: string[];
    temporal?: {
      recentDays?: number;
      sourceAfter?: string;
      sourceBefore?: string;
      requiredInWindowIds: string[];
      forbiddenOutOfWindowIds: string[];
    };
    maxEvidenceItems?: number;
  };
  notes?: string;
}

const runs = 5;

const longTail = (tail: string): string =>
  `${"operational note ".repeat(560)}Final durable detail: ${tail}`;

export const retrievalSuccessCases: RetrievalSuccessCase[] = [
  {
    id: "fresh-tail-story-detail",
    prompt:
      "What was the name of the keeper of the lamp in the city-by-the-sea story?",
    runs,
    boundaryProfile: "post-koe-166-defaults",
    seed: [
      {
        id: "fresh-story-lamp-keeper",
        sourceType: "memory_event",
        retrievalStage: "fresh_pending_search",
        text: longTail("the keeper of the lamp was Tamar."),
        relevant: true,
        createdDaysAgo: 0,
        tags: ["fresh", "long-tail"]
      },
      {
        id: "fresh-story-tool-echo",
        sourceType: "memory_event",
        retrievalStage: "raw_fallback_search",
        text: "Tool output echoed the user question about a lamp keeper but did not contain the answer.",
        relevant: false,
        createdDaysAgo: 0,
        tags: ["noise", "tool-output"]
      }
    ],
    expected: {
      memoryStatus: "found",
      answerSubstrings: ["Tamar"],
      requiredEvidenceIds: ["fresh-story-lamp-keeper"],
      forbiddenEvidenceIds: ["fresh-story-tool-echo"],
      maxEvidenceItems: 2
    },
    notes:
      "Covers fresh unsummarized memory and a long-tail answer near the end of a source."
  },
  {
    id: "lcm-leaf-operational-detail",
    prompt:
      "Which Postgres durability setting did we decide to keep enabled during local smoke tests?",
    runs,
    boundaryProfile: "post-koe-166-defaults",
    seed: [
      {
        id: "leaf-postgres-wal",
        sourceType: "memory_node",
        retrievalStage: "leaf_search",
        text: "LCM leaf summary: keep Postgres WAL enabled during local smoke tests; do not disable fsync for benchmark convenience.",
        relevant: true,
        createdDaysAgo: 8,
        lcmDepth: 0,
        lcmSummaryStatus: "summarized"
      },
      {
        id: "leaf-docker-cache-noise",
        sourceType: "memory_node",
        retrievalStage: "leaf_search",
        text: "LCM leaf summary: Docker layer cache was cleared for a clean browser rebuild.",
        relevant: false,
        createdDaysAgo: 8,
        lcmDepth: 0,
        lcmSummaryStatus: "summarized"
      }
    ],
    expected: {
      memoryStatus: "found",
      answerSubstrings: ["Postgres WAL", "fsync"],
      requiredEvidenceIds: ["leaf-postgres-wal"],
      forbiddenEvidenceIds: ["leaf-docker-cache-noise"],
      maxEvidenceItems: 2
    },
    notes: "Covers direct LCM leaf retrieval."
  },
  {
    id: "rollup-to-scoped-leaf-decision",
    prompt:
      "What did we decide about where the browser question answering bridge should run?",
    runs,
    boundaryProfile: "post-koe-166-defaults",
    seed: [
      {
        id: "rollup-question-answering",
        sourceType: "memory_node",
        retrievalStage: "rollup_search",
        text: "LCM rollup: local Memory Answer runtime ownership and app-server migration decisions.",
        relevant: true,
        createdDaysAgo: 12,
        lcmDepth: 1,
        lcmSummaryStatus: "summarized"
      },
      {
        id: "leaf-local-runtime-ownership",
        sourceType: "memory_node",
        retrievalStage: "scoped_leaf_search",
        parentNodeIds: ["rollup-question-answering"],
        text: "Scoped LCM leaf: koed-server should supervise one Local AI Runtime, while MCP adapters remain thin and backend LLM synthesis remains prohibited.",
        relevant: true,
        createdDaysAgo: 12,
        lcmDepth: 0,
        lcmSummaryStatus: "summarized"
      },
      {
        id: "leaf-unrelated-bridge",
        sourceType: "memory_node",
        retrievalStage: "scoped_leaf_search",
        parentNodeIds: ["rollup-question-answering"],
        text: "Scoped LCM leaf: unrelated note about CSS split panes.",
        relevant: false,
        createdDaysAgo: 12,
        lcmDepth: 0,
        lcmSummaryStatus: "summarized"
      }
    ],
    expected: {
      memoryStatus: "found",
      answerSubstrings: ["Local AI Runtime", "not", "backend"],
      requiredEvidenceIds: ["leaf-local-runtime-ownership"],
      forbiddenEvidenceIds: ["leaf-unrelated-bridge"],
      maxEvidenceItems: 3
    },
    notes: "Covers rollup discovery followed by scoped leaf retrieval."
  },
  {
    id: "lexical-exact-filename",
    prompt: "Which setting did we change in `apps/api/src/server/config.ts`?",
    runs,
    boundaryProfile: "post-koe-166-defaults",
    seed: [
      {
        id: "event-config-file-exact",
        sourceType: "memory_event",
        retrievalStage: "lexical_search",
        text: "Exact file note: apps/api/src/server/config.ts was changed to keep REQUEST_BODY_LIMIT_BYTES as a transport guard.",
        relevant: true,
        createdDaysAgo: 5,
        tags: ["filename", "exact"]
      },
      {
        id: "event-config-generic-noise",
        sourceType: "memory_event",
        retrievalStage: "leaf_search",
        text: "Generic config discussion without the exact filename.",
        relevant: false,
        createdDaysAgo: 5
      }
    ],
    expected: {
      memoryStatus: "found",
      answerSubstrings: ["REQUEST_BODY_LIMIT_BYTES", "transport guard"],
      requiredEvidenceIds: ["event-config-file-exact"],
      forbiddenEvidenceIds: ["event-config-generic-noise"],
      maxEvidenceItems: 2
    },
    notes:
      "Covers concrete filename lookup where lexical search should improve evidence."
  },
  {
    id: "temporal-filter-recent-rate-limit",
    prompt:
      "In the last 30 days, what memory read rate limit did we settle on?",
    runs,
    boundaryProfile: "post-koe-166-defaults",
    seed: [
      {
        id: "event-rate-limit-recent",
        sourceType: "memory_event",
        retrievalStage: "fresh_pending_search",
        text: "Recent decision: default memory read endpoints allow 1000 requests per 60 seconds.",
        relevant: true,
        createdDaysAgo: 4
      },
      {
        id: "event-rate-limit-old",
        sourceType: "memory_event",
        retrievalStage: "raw_fallback_search",
        text: "Old superseded test setting: prototype notes mentioned 250 requests per minute.",
        relevant: false,
        createdDaysAgo: 90
      }
    ],
    expected: {
      memoryStatus: "found",
      answerSubstrings: ["1000", "60 seconds"],
      requiredEvidenceIds: ["event-rate-limit-recent"],
      forbiddenEvidenceIds: ["event-rate-limit-old"],
      temporal: {
        recentDays: 30,
        requiredInWindowIds: ["event-rate-limit-recent"],
        forbiddenOutOfWindowIds: ["event-rate-limit-old"]
      },
      maxEvidenceItems: 2
    },
    notes: "Covers date-window filtering based on underlying source event time."
  },
  {
    id: "lexical-noisy-echo-not-found",
    prompt:
      "Did we ever decide anything about the exact error text `ERR_KOE_NOISE_777`?",
    runs,
    boundaryProfile: "post-koe-166-defaults",
    seed: [
      {
        id: "event-noisy-echo",
        sourceType: "memory_event",
        retrievalStage: "lexical_search",
        text: "Tool output repeated ERR_KOE_NOISE_777 because the user asked about it, but no decision or resolution was recorded.",
        relevant: false,
        createdDaysAgo: 2,
        tags: ["exact", "noise"]
      }
    ],
    expected: {
      memoryStatus: "not_found",
      answerSubstrings: ["No matching", "decision"],
      forbiddenEvidenceIds: ["event-noisy-echo"],
      maxEvidenceItems: 0
    },
    notes:
      "Covers lexical false positives from user/tool echo text and evidence curation."
  },
  {
    id: "semantic-question-avoid-lexical-repeated-terms",
    prompt:
      "Who was the apprentice in the recipe story where the recipe name was revealed at the end?",
    runs,
    boundaryProfile: "post-koe-166-defaults",
    seed: [
      {
        id: "event-recipe-apprentice",
        sourceType: "memory_event",
        retrievalStage: "fresh_pending_search",
        text: longTail(
          "the apprentice was Celandine and the recipe was Moonlit Saffron Broth."
        ),
        relevant: true,
        createdDaysAgo: 0,
        tags: ["fresh", "long-tail"]
      },
      {
        id: "event-recipe-echo",
        sourceType: "memory_event",
        retrievalStage: "lexical_search",
        text: "The phrase recipe story appeared in a user prompt but this source contains no answer.",
        relevant: false,
        createdDaysAgo: 0,
        tags: ["noise"]
      }
    ],
    expected: {
      memoryStatus: "found",
      answerSubstrings: ["Celandine"],
      requiredEvidenceIds: ["event-recipe-apprentice"],
      forbiddenEvidenceIds: ["event-recipe-echo"],
      maxEvidenceItems: 2
    },
    notes:
      "Covers semantic story recall with repeated terms that could otherwise trigger noisy lexical fallback."
  }
];
