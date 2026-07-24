/**
 * PROTOTYPE. Question: can the production LCM worker safely drive an isolated
 * candidate while active Recall remains usable, and what durable readiness is
 * needed before a generation pointer may move?
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pg from "../../packages/db/node_modules/pg/lib/index.js";
import {
  buildLcmSummaryPrompt,
  runCodexAppServerLcmSummary,
  summarizePendingLcmNodes
} from "../../packages/mcp-server/dist/lcm-summary-worker.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const root = process.env.SPIKE_ROOT;
const lockDir = join(process.env.SPIKE_TMP, "locks");
mkdirSync(lockDir, { recursive: true });
const trace = [];
const check = (name, condition, detail = "") => {
  assert.ok(condition, `${name}: ${detail}`);
  trace.push({ name, pass: true, detail });
};
const summary = (label) =>
  JSON.stringify({
    schema_version: "lcm-semantic-summary-v1",
    title: `${label} title`,
    summary_text: `${label} completed LCM Summary`
  });

await pool.query(`
  create table spike_lcm_generation_nodes (
    generation text not null, id uuid primary key default gen_random_uuid(),
    parent_id uuid null, kind text not null, depth integer not null,
    placeholder text not null, summary_text text null, summary_model text null,
    prompt_version text null, embedding_ready boolean not null default false,
    source_closed boolean not null default true, created_at timestamptz not null default now()
  );
  create table spike_lcm_generation_jobs (
    generation text not null, node_id uuid primary key references spike_lcm_generation_nodes(id),
    state text not null default 'pending', attempts integer not null default 0,
    last_error text null, unique (generation, node_id)
  );
`);
const insertNode = async ({
  generation,
  parentId = null,
  kind = "leaf",
  depth = 0,
  sourceClosed = true
}) => {
  const node = await pool.query(
    `insert into spike_lcm_generation_nodes (generation,parent_id,kind,depth,placeholder,source_closed) values ($1,$2,$3,$4,$5,$6) returning id`,
    [
      generation,
      parentId,
      kind,
      depth,
      `LCM Placeholder for ${generation}:${kind}`,
      sourceClosed
    ]
  );
  await pool.query(
    `insert into spike_lcm_generation_jobs (generation,node_id) values ($1,$2)`,
    [generation, node.rows[0].id]
  );
  return node.rows[0].id;
};
const activeParent = await insertNode({
  generation: "active-v1",
  kind: "rollup",
  depth: 1
});
const activeLeaf = await insertNode({
  generation: "active-v1",
  parentId: activeParent
});
const candidateParent = await insertNode({
  generation: "candidate-v2",
  kind: "rollup",
  depth: 1
});
const candidateLeaf = await insertNode({
  generation: "candidate-v2",
  parentId: candidateParent
});

// This adapter is the API contract exercised by the real production worker.
const clientFor = (generation, failure = {}) => ({
  async listPendingLcmSummaries({ limit }) {
    const rows = await pool.query(
      `
      select n.* from spike_lcm_generation_nodes n join spike_lcm_generation_jobs j on j.node_id=n.id
      where n.generation=$1 and j.state='pending' and n.summary_text is null
        and not exists (select 1 from spike_lcm_generation_nodes child where child.parent_id=n.id and child.summary_text is null)
      order by n.depth, n.created_at limit $2`,
      [generation, limit]
    );
    return {
      nodes: rows.rows.map((n) => ({
        id: n.id,
        visibility: "personal",
        kind: n.kind,
        depth: n.depth,
        summaryText: n.placeholder,
        sourceItems: [
          {
            kind: "memory_event",
            sourceTable: "memory_events",
            sourceId: `source-${n.id}`,
            text: `source for ${generation}`,
            position: 0
          }
        ],
        sourceTokenEstimate: 10
      }))
    };
  },
  async submitLcmSummary(nodeId, input) {
    if (failure.beforePersistence)
      throw new Error("injected submission outage");
    await pool.query(
      `update spike_lcm_generation_nodes set summary_text=$2, summary_model=$3, prompt_version=$4 where id=$1`,
      [
        nodeId,
        input.summaryText,
        input.summaryModel,
        input.summaryPromptVersion
      ]
    );
    await pool.query(
      `update spike_lcm_generation_jobs set state='completed', attempts=attempts+1 where node_id=$1`,
      [nodeId]
    );
    if (failure.afterPersistenceBeforeEmbedding)
      throw new Error("injected embedding enqueue outage after persistence");
    await pool.query(
      `update spike_lcm_generation_nodes set embedding_ready=true where id=$1`,
      [nodeId]
    );
  },
  async persistRawConversationItems() {
    return [];
  },
  async recordTokenUsage() {},
  async projectRawConversationItems() {}
});
const config = (tag) => ({
  provider: "codex",
  model: "gpt-5.4-mini",
  reasoningEffort: "low",
  timeoutMs: 20,
  maxAttempts: 1,
  retryDelayMs: 0,
  concurrency: 1,
  maxPromptTokens: 4000,
  appServerBinary: "not-called",
  cwd: root,
  env: {
    ...process.env,
    MEMORY_LCM_SUMMARY_LOCK_PATH: join(lockDir, `${tag}.lock`)
  }
});
const fakeRunner =
  (tag, mode = "ok") =>
  async () => {
    if (mode === "outage")
      throw new Error("AI Client unavailable before prompt completion");
    return { text: summary(tag), model: tag };
  };
const recall = async (generation) =>
  (
    await pool.query(
      `select summary_text from spike_lcm_generation_nodes where generation=$1 and depth=0`,
      [generation]
    )
  ).rows[0].summary_text;

// Active generation completes normally and continues serving while candidate fails.
const activeRun = await summarizePendingLcmNodes(clientFor("active-v1"), {
  limit: 1,
  config: config("model-v1"),
  runner: fakeRunner("active-v1")
});
check(
  "active Recall serves completed LCM",
  Boolean(await recall("active-v1")),
  JSON.stringify(activeRun)
);
const outage = await summarizePendingLcmNodes(clientFor("candidate-v2"), {
  limit: 1,
  config: config("model-v2-outage"),
  runner: fakeRunner("candidate-v2", "outage")
});
check(
  "AI Client outage leaves candidate pending",
  outage.failedCount === 1 && !(await recall("candidate-v2")),
  JSON.stringify(outage)
);
check(
  "active Recall survives candidate outage",
  Boolean(await recall("active-v1"))
);

const submitOutage = await summarizePendingLcmNodes(
  clientFor("candidate-v2", { beforePersistence: true }),
  {
    limit: 1,
    config: config("model-v2-submit"),
    runner: fakeRunner("candidate-v2")
  }
);
check(
  "submission outage leaves candidate resumable",
  submitOutage.failedCount === 1 && !(await recall("candidate-v2"))
);
await summarizePendingLcmNodes(clientFor("candidate-v2"), {
  limit: 1,
  config: config("model-v2"),
  runner: fakeRunner("candidate-v2")
});
check(
  "retry persists isolated candidate Summary",
  Boolean(await recall("candidate-v2")) &&
    (await recall("active-v1")).includes("active-v1")
);
const parentBefore = await clientFor("candidate-v2").listPendingLcmSummaries({
  limit: 10
});
check(
  "bottom-up blocking releases parent only after child summary",
  parentBefore.nodes.length === 1 && parentBefore.nodes[0].kind === "rollup"
);

// Current worker/API split exposes the critical post-persistence gap: it no longer lists a completed node.
const postPersist = await summarizePendingLcmNodes(
  clientFor("candidate-v2", { afterPersistenceBeforeEmbedding: true }),
  {
    limit: 1,
    config: config("model-v2-parent"),
    runner: fakeRunner("candidate-v2-parent")
  }
);
check(
  "post-persistence interruption is reported",
  postPersist.failedCount === 1
);
const parent = (
  await pool.query(
    `select summary_text, embedding_ready from spike_lcm_generation_nodes where id=$1`,
    [candidateParent]
  )
).rows[0];
check(
  "persistence can succeed before embedding enqueue",
  Boolean(parent.summary_text) && !parent.embedding_ready
);
const relisted = await clientFor("candidate-v2").listPendingLcmSummaries({
  limit: 10
});
check(
  "current pending discovery cannot repair completed-but-unembedded node",
  relisted.nodes.length === 0
);

// The real current schema's global node uniqueness is probed with the same source closure.
const uniqueness = await pool.query(
  `select indexdef from pg_indexes where tablename='memory_nodes' and indexname='memory_nodes_source_hash_unique'`
);
check(
  "current schema has global source-hash uniqueness",
  uniqueness.rows[0]?.indexdef.includes("source_hash") &&
    !uniqueness.rows[0]?.indexdef.includes("generation")
);
const candidates = await pool.query(
  `select generation, depth, summary_text is not null as summarized, embedding_ready, source_closed from spike_lcm_generation_nodes order by generation, depth`
);
const readiness = candidates.rows.filter(
  (row) => row.generation === "candidate-v2"
);
let connectedCodexSmoke = { attempted: false, result: "not requested" };
if (process.env.SPIKE_REAL_CODEX_SMOKE === "1") {
  connectedCodexSmoke = { attempted: true, result: "failed" };
  try {
    const smokeConfig = {
      ...config("connected-codex-smoke"),
      appServerBinary: process.env.CODEX_BINARY ?? "/opt/homebrew/bin/codex"
    };
    const prompt = buildLcmSummaryPrompt(
      {
        id: "00000000-0000-0000-0000-000000000001",
        visibility: "personal",
        kind: "leaf",
        depth: 0,
        summaryText: "LCM Placeholder: harmless scratch smoke input.",
        sourceItems: [
          {
            kind: "memory_event",
            sourceTable: "scratch",
            sourceId: "smoke",
            text: "Koed scratch LCM smoke: return only the requested JSON.",
            position: 0
          }
        ],
        sourceTokenEstimate: 12
      },
      "summary",
      smokeConfig.env
    );
    const result = await runCodexAppServerLcmSummary(
      prompt,
      smokeConfig,
      120_000
    );
    JSON.parse(result.text);
    connectedCodexSmoke = {
      attempted: true,
      result: "succeeded",
      model: result.model
    };
  } catch (error) {
    connectedCodexSmoke = {
      attempted: true,
      result: `failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
console.log(
  JSON.stringify(
    {
      prototype: "lcm-generation-investigation",
      checks: trace,
      candidateRows: readiness,
      connectedCodexSmoke,
      conclusion:
        "PASS: real worker retry/prompt contract exercised; FAIL-CLOSED: activation cannot treat completed-but-unembedded as ready."
    },
    null,
    2
  )
);
await pool.end();
