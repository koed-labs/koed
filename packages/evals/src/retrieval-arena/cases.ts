import {
  arenaCaseSchema,
  stableHash,
  type ArenaBudget,
  type ArenaCase,
  type ArenaSplit,
  type CorpusItem,
  type RelevanceJudgment
} from "./contracts.js";

export const RETRIEVAL_ARENA_DATASET_VERSION = "koed-first-party-v6";

const budget: ArenaBudget = {
  maxCandidates: 8,
  maxEvidenceItems: 4,
  maxEvidenceTokens: 220,
  maxSearchCalls: 2,
  maxExpansions: 1,
  timeoutMs: 90_000
};

const item = (
  id: string,
  text: string,
  metadata: Record<string, unknown> = {},
  sourceType: CorpusItem["sourceType"] = "memory_event"
): CorpusItem => ({
  id,
  text,
  sourceType,
  sourceChunkIndex: 0,
  tokenCount: text.split(/\s+/).length,
  metadata
});

const defineCase = (input: {
  id: string;
  split: ArenaSplit;
  question: string;
  retrievalHints?: {
    semantic: string[];
    exact: string[];
    lexical: string[];
  };
  corpus: CorpusItem[];
  qrels: RelevanceJudgment[];
  status?: ArenaCase["answerChecks"]["status"];
  exactFacts?: string[];
  forbiddenFacts?: string[];
  referenceAnswer: string;
  tags: string[];
  budget?: ArenaBudget;
  productContext?: ArenaCase["productContext"];
}): ArenaCase => {
  const {
    status,
    exactFacts,
    forbiddenFacts,
    budget: caseBudget,
    ...benchmarkCase
  } = input;
  return arenaCaseSchema.parse({
    ...benchmarkCase,
    retrievalHints: input.retrievalHints ?? {
      semantic: [`Relevant memory about: ${input.question}`],
      exact: input.exactFacts?.length ? input.exactFacts : [input.tags[0]!],
      lexical: input.tags.slice(0, 2).map((tag) => tag.replaceAll("_", " "))
    },
    budget: caseBudget ?? budget,
    productContext: input.productContext ?? {
      memoryClass: "personal",
      retrievalScope: "personal",
      searchDomain: "global"
    },
    answerChecks: {
      status: status ?? "found",
      exactFacts: exactFacts ?? [],
      forbiddenFacts: forbiddenFacts ?? [],
      requiredJsonKeys: []
    }
  });
};

export const retrievalArenaCases: ArenaCase[] = [
  defineCase({
    id: "dev-exact-anchor",
    split: "development",
    question:
      "Which transport guard is defined in apps/api/src/server/config.ts?",
    corpus: [
      item(
        "d1",
        "apps/api/src/server/config.ts keeps REQUEST_BODY_LIMIT_BYTES as the transport guard."
      ),
      item("d2", "apps/api/src/server/routes.ts configures request logging."),
      item("d3", "The worker budget uses MAX_CANDIDATES for retrieval.")
    ],
    qrels: [
      { itemId: "d1", grade: 3, evidenceGroup: "guard", forbidden: false },
      { itemId: "d2", grade: 0, forbidden: false },
      { itemId: "d3", grade: 0, forbidden: false }
    ],
    exactFacts: ["REQUEST_BODY_LIMIT_BYTES"],
    referenceAnswer: "The transport guard is REQUEST_BODY_LIMIT_BYTES.",
    tags: ["exact_identifier", "lexical_anchor", "project_scope"],
    productContext: {
      memoryClass: "personal",
      retrievalScope: "personal",
      searchDomain: "project",
      projectId: "retrieval-arena-project"
    }
  }),
  defineCase({
    id: "dev-semantic-paraphrase",
    split: "development",
    question: "Where should the browser answer bridge be launched?",
    corpus: [
      item(
        "d4",
        "The question answering bridge belongs in the local MCP startup path, not in backend synthesis."
      ),
      item("d5", "The browser uses a split pane when inspecting memory."),
      item("d6", "A hosted worker processes billing exports.")
    ],
    qrels: [
      { itemId: "d4", grade: 3, evidenceGroup: "location", forbidden: false },
      { itemId: "d5", grade: 0, forbidden: false },
      { itemId: "d6", grade: 0, forbidden: true }
    ],
    exactFacts: ["local MCP startup path"],
    forbiddenFacts: ["hosted worker"],
    referenceAnswer:
      "Launch it through the local MCP startup path, not a backend synthesis service.",
    tags: ["semantic_paraphrase", "synonym", "exclusion"]
  }),
  defineCase({
    id: "dev-multi-evidence",
    split: "development",
    question:
      "What database durability and recall response defaults did we choose?",
    corpus: [
      item(
        "d7",
        "Keep Postgres WAL and fsync enabled during local smoke tests."
      ),
      item(
        "d8",
        "Memory Answer defaults to answer_only; with_evidence is diagnostic."
      ),
      item("d9", "The CSS theme uses neutral borders."),
      item("d10", "An old prototype disabled fsync for speed.")
    ],
    qrels: [
      { itemId: "d7", grade: 3, evidenceGroup: "durability", forbidden: false },
      { itemId: "d8", grade: 3, evidenceGroup: "response", forbidden: false },
      { itemId: "d9", grade: 0, forbidden: false },
      { itemId: "d10", grade: 0, forbidden: true }
    ],
    exactFacts: ["fsync", "answer_only"],
    forbiddenFacts: ["disabled fsync"],
    referenceAnswer:
      "Keep WAL and fsync enabled, and use answer_only as the default response detail.",
    tags: ["conjunction", "multi_evidence", "superseded"]
  }),
  defineCase({
    id: "validation-temporal-conflict",
    split: "validation",
    question: "What is the current memory read limit?",
    corpus: [
      item(
        "v1",
        "Current decision dated 2026-07-01: memory reads allow 1000 requests per 60 seconds.",
        { sourceTime: "2026-07-01" }
      ),
      item(
        "v2",
        "Superseded decision dated 2025-11-01: memory reads allow 250 requests per minute.",
        { sourceTime: "2025-11-01", superseded: true }
      ),
      item("v3", "Write endpoints have a separate limit.")
    ],
    qrels: [
      { itemId: "v1", grade: 3, evidenceGroup: "current", forbidden: false },
      { itemId: "v2", grade: 1, evidenceGroup: "history", forbidden: false },
      { itemId: "v3", grade: 0, forbidden: false }
    ],
    exactFacts: ["1000 requests per 60 seconds"],
    forbiddenFacts: ["250 requests per minute is current"],
    referenceAnswer:
      "The current limit is 1000 requests per 60 seconds; 250 per minute was superseded.",
    tags: ["temporal", "historical_evolution", "conflict"]
  }),
  defineCase({
    id: "validation-historical-state",
    split: "validation",
    question: "What memory read limit was superseded on 2025-11-01?",
    corpus: [
      item(
        "v10",
        "Current decision dated 2026-07-01: memory reads allow 1000 requests per 60 seconds.",
        { sourceTime: "2026-07-01" }
      ),
      item(
        "v11",
        "Superseded decision dated 2025-11-01: memory reads allow 250 requests per minute.",
        { sourceTime: "2025-11-01", superseded: true }
      ),
      item("v12", "Write endpoints have a separate limit.")
    ],
    qrels: [
      { itemId: "v10", grade: 1, evidenceGroup: "current", forbidden: false },
      { itemId: "v11", grade: 3, evidenceGroup: "history", forbidden: false },
      { itemId: "v12", grade: 0, forbidden: false }
    ],
    exactFacts: ["250 requests per minute"],
    forbiddenFacts: ["1000 requests per 60 seconds was superseded"],
    referenceAnswer:
      "The superseded 2025-11-01 limit was 250 requests per minute.",
    tags: ["historical_state", "superseded", "temporal"]
  }),
  defineCase({
    id: "validation-no-answer",
    split: "validation",
    question: "Which Kafka cluster did we approve for production?",
    corpus: [
      item(
        "v4",
        "A user asked whether Kafka might be useful; no deployment decision was made."
      ),
      item("v5", "Production uses Postgres for durable memory."),
      item(
        "v6",
        "A tool output mentioned cluster-kappa without user confirmation."
      )
    ],
    qrels: [
      { itemId: "v4", grade: 1, evidenceGroup: "absence", forbidden: false },
      { itemId: "v5", grade: 0, forbidden: false },
      { itemId: "v6", grade: 0, forbidden: false }
    ],
    status: "found",
    forbiddenFacts: ["cluster-kappa was approved"],
    referenceAnswer: "No Kafka production cluster approval is recorded.",
    tags: ["false_premise", "supported_absence", "noisy_echo"],
    productContext: {
      memoryClass: "personal",
      retrievalScope: "personal",
      searchDomain: "project",
      projectId: "retrieval-arena-kafka-negative"
    }
  }),
  defineCase({
    id: "validation-not-found",
    split: "validation",
    question: "Which Redis cluster did we approve for the Mars deployment?",
    corpus: [
      item("v13", "Production uses Postgres for durable memory."),
      item("v14", "A Redis queue is used for local background work."),
      item("v15", "The local deployment checklist includes a health check.")
    ],
    qrels: [
      { itemId: "v13", grade: 0, forbidden: false },
      { itemId: "v14", grade: 0, forbidden: false },
      { itemId: "v15", grade: 0, forbidden: false }
    ],
    status: "not_found",
    forbiddenFacts: ["a Redis cluster was approved", "Mars deployment exists"],
    referenceAnswer:
      "No relevant memory records a Redis cluster approved for a Mars deployment.",
    tags: ["no_answer", "not_found", "abstention", "distractors"],
    budget: { ...budget, maxSearchCalls: 5 },
    productContext: {
      memoryClass: "personal",
      retrievalScope: "personal",
      searchDomain: "project",
      projectId: "retrieval-arena-redis-mars"
    }
  }),
  defineCase({
    id: "validation-boundary",
    split: "validation",
    question: "What color did I choose for my personal launch checklist?",
    corpus: [
      item(
        "v7",
        "Personal Memory for the requesting User: launch checklist color is teal.",
        { visibility: "personal", owner: "requester" }
      ),
      item("v8", "Another User's private checklist color is crimson.", {
        visibility: "personal",
        owner: "other"
      }),
      item("v9", "Workspace checklist uses black text.", {
        visibility: "team",
        workspace: "other"
      })
    ],
    qrels: [
      { itemId: "v7", grade: 3, evidenceGroup: "personal", forbidden: false },
      { itemId: "v8", grade: 0, forbidden: true },
      { itemId: "v9", grade: 0, forbidden: true }
    ],
    exactFacts: ["teal"],
    forbiddenFacts: ["crimson"],
    referenceAnswer: "Your personal launch checklist color is teal.",
    tags: ["personal", "authorization", "private", "workspace_boundary"]
  }),
  defineCase({
    id: "heldout-lcm-routing",
    split: "held_out",
    question: "Why did the Helios migration stall and what unblocked it?",
    corpus: [
      item(
        "h1",
        "LCM rollup: Helios migration covered certificate rotation and service startup.",
        { nodeKind: "lcm_rollup", lcmDepth: 1, childIds: ["h2", "h3"] },
        "memory_node"
      ),
      item(
        "h2",
        "LCM leaf: Helios stalled because the old CA remained pinned; rotating the CA bundle unblocked startup.",
        { nodeKind: "lcm_leaf", lcmDepth: 0, parentId: "h1" },
        "memory_node"
      ),
      item(
        "h3",
        "LCM leaf: Helios UI spacing was adjusted.",
        {
          nodeKind: "lcm_leaf",
          lcmDepth: 0,
          parentId: "h1"
        },
        "memory_node"
      ),
      item("h4", "Fresh pending evidence discusses an unrelated DNS test.", {
        summaryStatus: "pending"
      })
    ],
    qrels: [
      { itemId: "h1", grade: 1, evidenceGroup: "route", forbidden: false },
      {
        itemId: "h2",
        grade: 3,
        evidenceGroup: "cause_resolution",
        forbidden: false
      },
      { itemId: "h3", grade: 0, forbidden: false },
      { itemId: "h4", grade: 0, forbidden: false }
    ],
    exactFacts: ["old CA", "rotating the CA bundle"],
    referenceAnswer:
      "The old CA was still pinned; rotating the CA bundle unblocked service startup.",
    tags: ["lcm_routing", "expansion", "long_tail"]
  }),
  defineCase({
    id: "heldout-fresh-pending",
    split: "held_out",
    question: "What codename was selected in the latest session?",
    corpus: [
      item(
        "h5",
        "Fresh pending Memory Event from the current Session: selected codename is ORCHID-91.",
        { session: "current", summaryStatus: "pending" }
      ),
      item(
        "h6",
        "Older Project note proposed ORCHID-19 but did not select it.",
        { session: "old" }
      ),
      item("h7", "Revoked Team memory says codename COBALT-2.", {
        revoked: true
      })
    ],
    qrels: [
      { itemId: "h5", grade: 3, evidenceGroup: "latest", forbidden: false },
      { itemId: "h6", grade: 1, forbidden: false },
      { itemId: "h7", grade: 0, forbidden: true }
    ],
    exactFacts: ["ORCHID-91"],
    forbiddenFacts: ["COBALT-2"],
    referenceAnswer: "The latest session selected ORCHID-91.",
    tags: ["fresh_pending", "session", "revoked", "exact_identifier"],
    productContext: {
      memoryClass: "personal",
      retrievalScope: "personal",
      searchDomain: "session",
      sessionId: "retrieval-arena-session"
    }
  }),
  defineCase({
    id: "heldout-budget-insufficient",
    split: "held_out",
    question:
      "List all three independent safeguards required for remote launch.",
    corpus: [
      item(
        "h8",
        "Remote launch safeguard one: validate the device credential."
      ),
      item("h9", "Remote launch safeguard two: enforce Workspace Access."),
      item("h10", "Remote launch safeguard three: check active Share Grants."),
      item("h11", "Remote launch uses a blue status icon.")
    ],
    qrels: [
      { itemId: "h8", grade: 3, evidenceGroup: "credential", forbidden: false },
      { itemId: "h9", grade: 3, evidenceGroup: "workspace", forbidden: false },
      { itemId: "h10", grade: 3, evidenceGroup: "grant", forbidden: false },
      { itemId: "h11", grade: 0, forbidden: false }
    ],
    budget: { ...budget, maxEvidenceItems: 2 },
    status: "insufficient",
    referenceAnswer:
      "The two-item evidence budget is insufficient to establish all three independently required safeguards.",
    tags: ["disjunction", "multi_evidence", "budget_exhaustion", "insufficient"]
  }),
  defineCase({
    id: "heldout-team-curated-hierarchy",
    split: "held_out",
    question: "What deployment window did the Team approve for Atlas?",
    corpus: [
      item(
        "h12",
        "Curated Memory: Atlas deployment is approved for Tuesday at 09:30 UTC.",
        {
          visibility: "team_shared",
          lexicalAnchors: ["Atlas", "09:30 UTC"],
          hierarchyPath: ["Team", "Atlas", "Deployment"]
        },
        "curated_memory"
      ),
      item(
        "h13",
        "LCM leaf: Atlas readiness checks passed after certificate validation.",
        { nodeKind: "lcm_leaf", parentId: "h14", depth: 0 },
        "memory_node"
      ),
      item(
        "h14",
        "LCM rollup: Atlas launch planning and readiness.",
        { nodeKind: "lcm_rollup", childIds: ["h13"], depth: 1 },
        "memory_node"
      ),
      item("h15", "Memory Event: an earlier draft suggested Wednesday.", {
        eventKind: "conversation_item",
        superseded: true
      })
    ],
    qrels: [
      {
        itemId: "h12",
        grade: 3,
        evidenceGroup: "approved_window",
        forbidden: false
      },
      { itemId: "h13", grade: 1, evidenceGroup: "readiness", forbidden: false },
      { itemId: "h14", grade: 1, evidenceGroup: "route", forbidden: false },
      { itemId: "h15", grade: 0, forbidden: true }
    ],
    exactFacts: ["Tuesday", "09:30 UTC"],
    forbiddenFacts: ["Wednesday is approved"],
    referenceAnswer: "The Team approved Tuesday at 09:30 UTC.",
    tags: [
      "team_workspace",
      "positive_team",
      "curated_memory",
      "hierarchy",
      "lexical_anchor"
    ],
    productContext: {
      memoryClass: "team_workspace",
      retrievalScope: "shared",
      searchDomain: "global",
      teamWorkspaceId: "00000000-0000-4000-8000-000000000042"
    }
  })
];

export const retrievalArenaCorpus: CorpusItem[] = retrievalArenaCases.flatMap(
  (benchmarkCase) => benchmarkCase.corpus
);

export const retrievalArenaSplitIdentities = Object.fromEntries(
  (["development", "validation", "held_out"] as const).map((split) => {
    const cases = retrievalArenaCases.filter(
      (benchmarkCase) => benchmarkCase.split === split
    );
    const corpus = cases.flatMap((benchmarkCase) => benchmarkCase.corpus);
    if (cases.length === 0) {
      throw new Error(`Retrieval Arena ${split} split must not be empty`);
    }
    return [
      split,
      {
        caseIds: cases.map((benchmarkCase) => benchmarkCase.id),
        corpusItemIds: corpus.map((entry) => entry.id),
        identity: stableHash({
          version: RETRIEVAL_ARENA_DATASET_VERSION,
          split,
          cases
        })
      }
    ];
  })
) as Record<
  ArenaSplit,
  { caseIds: string[]; corpusItemIds: string[]; identity: string }
>;

if (
  new Set(retrievalArenaCorpus.map((entry) => entry.id)).size !==
  retrievalArenaCorpus.length
) {
  throw new Error("Retrieval Arena corpus item IDs must be globally unique");
}

for (const benchmarkCase of retrievalArenaCases) {
  const judgedIds = benchmarkCase.qrels.map((qrel) => qrel.itemId);
  if (
    new Set(judgedIds).size !== judgedIds.length ||
    judgedIds.length !== benchmarkCase.corpus.length
  ) {
    throw new Error(
      `Retrieval Arena case ${benchmarkCase.id} must judge every corpus item exactly once`
    );
  }
}

export const retrievalArenaDatasetHash = stableHash({
  version: RETRIEVAL_ARENA_DATASET_VERSION,
  corpus: retrievalArenaCorpus,
  cases: retrievalArenaCases.map((benchmarkCase) => ({
    ...benchmarkCase,
    corpus: benchmarkCase.corpus.map((entry) => entry.id)
  }))
});

export const retrievalArenaCorpusIdentity = stableHash({
  datasetHash: retrievalArenaDatasetHash,
  corpusHash: stableHash(retrievalArenaCorpus),
  itemIds: retrievalArenaCorpus.map((entry) => entry.id)
});
