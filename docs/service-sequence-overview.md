# Service Sequence Overview

This overview describes the high-level service flow for Koed ingestion,
LCM summarisation, and retrieval. It follows the current self-hosted boundary:
the backend stores, projects, embeds, and retrieves memory, while the connected
AI Client performs Answer Synthesis and creates LCM Summaries through local
MCP-side workers.

## Services In Scope

- **AI Client**: Codex is the supported AI Client in this build.
- **Capture Hook**: the TypeScript hook that sends conversation activity to Koed.
- **MCP Server**: the local process that exposes `memory_answer`, runs local
  memory-answer work, and runs the LCM Summary Service.
- **API**: the Fastify backend that authenticates API Tokens, persists raw
  records, runs Projection, and serves recall endpoints.
- **Worker**: the BullMQ/background process that performs catch-up projection,
  embedding work, and LCM node embedding.
- **Embedding Service**: local service that turns memory text into retrieval
  vectors.
- **Database**: Postgres storage for raw conversation items, projected semantic
  rows, Memory Events, Memory Nodes, embeddings, questions, and token usage.

## Ingestion

1. Codex emits supported hook events such as `SessionStart`,
   `UserPromptSubmit`, `PostToolUse`, `Stop`, `SubagentStart`, and
   `SubagentStop`.
2. The TypeScript Capture Hook reads the hook payload and transcript tail,
   resolves local configuration, and checks the effective Capture Policy when
   needed.
3. The Capture Hook converts Codex transcript records into canonical raw
   `conversation_items` with `sourceAdapterVersion=codex-transcript-v1`,
   `sourceTransport=hook`, idempotency keys, source hashes, and
   `projectionStatus=pending`.
4. The API authenticates the API Token and persists the raw items as
   `personal` memory through `POST /v1/memory/conversation-items`.
5. While still inside the hook deadline, the Capture Hook tries foreground
   projection through `POST /v1/memory/conversation-items/project`. If this is
   too slow or unavailable, raw rows remain pending for catch-up.
6. Projection derives Koed semantic rows: Captured Sessions, turns, messages,
   tool events, Memory Events, source links, and token usage where available.
   Agent work is bundled into semantic `agent_turn` Memory Events only when a
   seal condition is reached.
7. The API schedules processing for newly projected Memory Events. The Worker
   also runs a catch-up loop over pending or failed raw rows.
8. The Worker embeds Memory Events by calling the Embedding Service and then
   upserts source embeddings.
9. The Worker schedules compaction, creating or updating LCM Placeholder Memory
   Nodes from Memory Events and child nodes, then queues Memory Node embedding.
10. Pending LCM placeholders remain available as degraded evidence until local
    LCM summaries are submitted.

```mermaid
sequenceDiagram
  participant Client as AI Client
  participant Hook as Capture Hook
  participant API as API
  participant DB as Database
  participant Worker as Worker
  participant Embed as Embedding Service

  Client->>Hook: Supported hook event and transcript path
  Hook->>API: Check effective Capture Policy
  Hook->>API: POST raw conversation_items
  API->>DB: Persist raw rows idempotently
  Hook->>API: POST project pending items
  API->>DB: Project sessions, turns, messages, Memory Events
  API-->>Hook: Projection and processing status
  Worker->>DB: Catch up pending raw rows
  Worker->>Embed: Embed Memory Event text
  Embed-->>Worker: Vectors
  Worker->>DB: Store embeddings and LCM placeholders
```

## LCM Summarisation

1. Projection and compaction create LCM Placeholder Memory Nodes from
   token-bounded Memory Event spans or lower-level Memory Nodes.
2. The MCP Server starts the local LCM Summary Service on a timer and can also
   nudge it after capture.
3. The LCM Summary Service asks the API for pending session titles and pending
   LCM summaries.
4. The API returns LCM nodes plus ordered source items and marks the work as
   local-only; the backend does not call an LLM for LCM summaries.
5. The local LCM worker builds token-bounded prompts from exact source items or
   child summaries.
6. The LCM worker runs Codex app-server mode locally under the user's Codex
   subscription and parses the returned structured LCM Summary.
7. App-server workflow telemetry is persisted as raw-only conversation items,
   and provider token usage is recorded for attribution.
8. The LCM worker submits the completed LCM Summary to
   `POST /v1/memory/lcm/summaries/{nodeId}`.
9. The API updates the Memory Node summary fields and enqueues Memory Node
   embedding.
10. The Worker embeds the updated Memory Node so retrieval can use the
    completed summary.

```mermaid
sequenceDiagram
  participant DB as Database
  participant MCP as MCP Server
  participant API as API
  participant Codex as Codex App Server
  participant Worker as Worker
  participant Embed as Embedding Service

  DB-->>API: Pending LCM Placeholder nodes
  MCP->>API: GET pending LCM summaries
  API-->>MCP: Nodes and source items
  MCP->>Codex: Local LCM summary prompt
  Codex-->>MCP: Structured LCM Summary
  MCP->>API: Persist raw-only telemetry and token usage
  MCP->>API: POST completed LCM Summary
  API->>DB: Update Memory Node summary
  API->>Worker: Enqueue Memory Node embedding
  Worker->>Embed: Embed completed summary
  Worker->>DB: Store Memory Node embedding
```

## Retrieval

1. The AI Client calls the MCP Server's `memory_answer` tool with a query,
   Retrieval Scope, and Search Domain.
2. The MCP Server starts a local memory-answer worker in Codex app-server mode.
   The worker is given only Koed dynamic RAG tools: `scan`, `search`, and
   `expand`.
3. The local memory-answer worker calls API search through the MCP client's
   dynamic tools. Project search defaults to the current project path; session
   search requires a captured-session id; global search still only searches
   visible Personal Memory.
4. The API authenticates the API Token and calls the core recall path.
5. The repository validates the Search Domain and runs retrieval stages over
   Memory Nodes, fresh pending Memory Events, raw fallback evidence, and lexical
   matches. Semantic stages use local embedding search and may be reranked when
   configured.
6. The API returns hits, citations, and retrieval metadata. When a promising
   Memory Node needs more detail, the local memory-answer worker can call
   `expand` to fetch underlying source items.
7. The local memory-answer worker performs Answer Synthesis from the retrieved
   Evidence Bundle and returns structured answer JSON.
8. The MCP Server compacts the response according to `response_detail`.
9. The MCP Server persists the Memory Question result and records token usage
   for the local app-server answer work.
10. The AI Client receives the final Memory Answer and can cite returned
    evidence when requested.

```mermaid
sequenceDiagram
  participant Client as AI Client
  participant MCP as MCP Server
  participant Answer as Local Memory Answer Worker
  participant API as API
  participant DB as Database
  participant Embed as Embedding Service

  Client->>MCP: memory_answer(query, Search Domain)
  MCP->>Answer: Start local Codex app-server worker
  Answer->>API: scan/search dynamic RAG calls
  API->>Embed: Query embedding when semantic retrieval runs
  API->>DB: Search Memory Nodes and fallback evidence
  DB-->>API: Hits, citations, retrieval metadata
  API-->>Answer: Evidence Bundle candidates
  Answer->>API: expand relevant Memory Nodes
  API-->>Answer: Underlying source items
  Answer-->>MCP: Structured Memory Answer
  MCP->>API: Persist Memory Question and token usage
  MCP-->>Client: Compact Memory Answer
```

## Implementation Anchors

- Capture Hook: `packages/mcp-server/src/capture-hook.ts`
- Raw ingestion API: `apps/api/src/memory/raw-conversation-routes.ts`
- Raw projection catch-up: `apps/worker/src/raw-projection-service.ts`
- Embedding workflow: `apps/worker/src/embedding-workflow.ts`
- LCM Summary Service: `packages/mcp-server/src/lcm-summary-service.ts`
- LCM summary worker: `packages/mcp-server/src/lcm-summary-worker.ts`
- LCM API routes: `apps/api/src/memory/lcm-routes.ts`
- MCP `memory_answer`: `packages/mcp-server/src/cli.ts`
- Memory answer worker: `packages/mcp-server/src/answer-worker.ts`
- Recall API routes: `apps/api/src/memory/recall-routes.ts`
- Core recall contract: `packages/core/src/index.ts`
- Repository retrieval stages: `packages/db/src/repository.ts`
