#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (value.startsWith("--")) {
    args.set(value.slice(2), process.argv[index + 1]);
    index += 1;
  }
}

const apiUrl = (
  args.get("api-url") ??
  process.env.MEMORY_API_URL ??
  "http://localhost:3000"
).replace(/\/+$/, "");
const composeProject =
  args.get("compose-project") ?? process.env.COMPOSE_PROJECT_NAME ?? "koed";
const smokeLeafEventThreshold = Number.parseInt(
  args.get("leaf-event-threshold") ??
    process.env.LCM_SMOKE_LEAF_EVENT_THRESHOLD ??
    process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD ??
    "6",
  10
);
const smokeFreshEventTail = Number.parseInt(
  args.get("fresh-event-tail") ??
    process.env.LCM_SMOKE_FRESH_EVENT_TAIL ??
    process.env.MEMORY_LCM_FRESH_EVENT_TAIL ??
    "10",
  10
);
const smokeDepthOneFanout = Number.parseInt(
  args.get("depth-one-fanout") ??
    process.env.LCM_SMOKE_DEPTH1_FANOUT ??
    process.env.MEMORY_LCM_DEPTH1_FANOUT ??
    "2",
  10
);
const defaultSmokeEvents =
  smokeLeafEventThreshold * smokeDepthOneFanout + smokeFreshEventTail;
const eventCount = Number.parseInt(
  args.get("events") ??
    process.env.LCM_SMOKE_EVENTS ??
    String(defaultSmokeEvents),
  10
);
const timeoutMs = Number.parseInt(
  args.get("timeout-ms") ?? process.env.LCM_SMOKE_TIMEOUT_MS ?? "90000",
  10
);
const marker =
  args.get("marker") ?? `lcm-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`;
const workspaceId = `lcm-smoke-${marker}`;
const summaryModel =
  args.get("summary-model") ??
  process.env.LCM_SMOKE_SUMMARY_MODEL ??
  "gpt-5.4-mini";
const summaryReasoningEffort =
  args.get("summary-reasoning-effort") ??
  process.env.LCM_SMOKE_SUMMARY_REASONING_EFFORT ??
  "medium";
const existingApiToken =
  args.get("api-token") ??
  process.env.LCM_SMOKE_API_TOKEN ??
  process.env.MEMORY_API_TOKEN;

const assert = (condition, message, details) => {
  if (!condition) {
    const suffix =
      details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`;
    throw new Error(`${message}${suffix}`);
  }
};

const requestJson = async (path, options = {}) => {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(options.headers ?? {})
    }
  });
  const text = await response.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    body = { rawBody: text };
  }
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${path} failed with ${response.status}: ${JSON.stringify(body)}`
    );
  }
  return { body, headers: response.headers };
};

const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

const psqlJson = (sql) => {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      composeProject,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "koed",
      "-d",
      "koed",
      "-v",
      "ON_ERROR_STOP=1",
      "-t",
      "-A",
      "-c",
      sql
    ],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(`psql failed:\n${result.stderr || result.stdout}`);
  }
  const line = result.stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith("{") || item.startsWith("["));
  assert(line, "psql did not return JSON", result.stdout);
  return JSON.parse(line);
};

const runCommand = (cmd, commandArgs, options = {}) => {
  const result = spawnSync(cmd, commandArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
    ...options
  });
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${commandArgs.join(" ")} failed:\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
};

const getDbState = () =>
  psqlJson(`
    with marked_events as (
      select id
      from memory_events
      where payload -> 'metadata' ->> 'lcmSmokeMarker' = ${sqlLiteral(marker)}
    ),
    marked_nodes as (
      select distinct mn.*
      from memory_nodes mn
      join memory_node_sources mns on mns.memory_node_id = mn.id
      join marked_events me on me.id = mns.memory_event_id
      where mn.invalidated_at is null
    ),
    marked_rollups as (
      select *
      from marked_nodes
      where kind = 'rollup'
    )
    select jsonb_build_object(
      'marker', ${sqlLiteral(marker)},
      'eventCount', (select count(*) from marked_events),
      'leafCount', (select count(*) from marked_nodes where kind = 'leaf'),
      'rollupCount', (select count(*) from marked_nodes where kind = 'rollup'),
      'sourceLinkCount', (
        select count(*)
        from memory_node_sources mns
        join marked_events me on me.id = mns.memory_event_id
      ),
      'childLinkCount', (
        select count(*)
        from memory_node_children mnc
        join marked_rollups mr on mr.id = mnc.parent_memory_node_id
      ),
      'summarizedNodeCount', (
        select count(*)
        from marked_nodes
        where summary_model is not null
          and summary_prompt_version is not null
          and summary_token_estimate is not null
      ),
      'pendingSummaryCount', (
        select count(*)
        from marked_nodes
        where summary_model is null
      ),
      'codexSummaryCount', (
        select count(*)
        from marked_nodes
        where summary_model like 'codex%'
      ),
      'structuredSummaryCount', (
        select count(*)
        from marked_nodes
        where summary_structured_json is not null
          and summary_structured_schema_version = 'lcm-structured-summary-v1'
      ),
      'embeddedNodeCount', (
        select count(distinct me.memory_node_id)
        from memory_embeddings me
        join marked_nodes mn on mn.id = me.memory_node_id
        where me.invalidated_at is null
      ),
      'summaryModels', (
        select coalesce(jsonb_object_agg(summary_model, count), '{}'::jsonb)
        from (
          select coalesce(summary_model, 'pending') as summary_model, count(*) as count
          from marked_nodes
          group by coalesce(summary_model, 'pending')
        ) model_counts
      ),
      'leafSummaryHeaderCount', (
        select count(*)
        from marked_nodes
        where kind = 'leaf'
          and summary_text like 'LCM depth 0 leaf summary%'
      ),
      'rollupSummaryHeaderCount', (
        select count(*)
        from marked_nodes
        where kind = 'rollup'
          and summary_text like 'LCM depth 1 rollup summary%'
      ),
      'rollupChildSourceItemCount', (
        select count(*)
        from marked_rollups
        where jsonb_path_exists(source_items_json, '$[*] ? (@.kind == "lcm_child")')
      ),
      'nodes', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'id', id,
            'kind', kind,
            'depth', depth,
            'sourceEventCount', source_event_count,
            'sourceTokenEstimate', source_token_estimate,
            'summaryTokenEstimate', summary_token_estimate,
            'summaryModel', summary_model,
            'summaryPromptVersion', summary_prompt_version,
            'summaryStructuredSchemaVersion', summary_structured_schema_version,
            'summaryPreview', left(summary_text, 220)
          )
          order by depth, created_at, id
        ), '[]'::jsonb)
        from marked_nodes
      ),
      'rollupNodeId', (
        select id
        from marked_rollups
        order by created_at desc
        limit 1
      )
    )::text;
  `);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForLcmStructure = async () => {
  const startedAt = Date.now();
  let lastState = getDbState();
  while (Date.now() - startedAt < timeoutMs) {
    const totalNodes =
      Number(lastState.leafCount) + Number(lastState.rollupCount);
    if (
      Number(lastState.eventCount) === eventCount &&
      Number(lastState.leafCount) >= 2 &&
      Number(lastState.rollupCount) >= 1 &&
      Number(lastState.leafSummaryHeaderCount) >= 2 &&
      Number(lastState.rollupSummaryHeaderCount) >= 1 &&
      Number(lastState.rollupChildSourceItemCount) >= 1 &&
      Number(lastState.childLinkCount) >= 2 &&
      Number(lastState.sourceLinkCount) >= eventCount - 2 &&
      Number(lastState.embeddedNodeCount) >= totalNodes
    ) {
      return lastState;
    }
    await sleep(2000);
    lastState = getDbState();
  }
  throw new Error(
    `Timed out waiting for LCM structure and placeholder embeddings:\n${JSON.stringify(lastState, null, 2)}`
  );
};

const waitForLocalSummaries = async () => {
  const startedAt = Date.now();
  let lastState = getDbState();
  while (Date.now() - startedAt < timeoutMs) {
    const totalNodes =
      Number(lastState.leafCount) + Number(lastState.rollupCount);
    if (
      totalNodes >= 3 &&
      Number(lastState.summarizedNodeCount) >= totalNodes &&
      Number(lastState.codexSummaryCount) >= totalNodes &&
      Number(lastState.structuredSummaryCount) >= totalNodes &&
      Number(lastState.pendingSummaryCount) === 0 &&
      Number(lastState.embeddedNodeCount) >= totalNodes
    ) {
      return lastState;
    }
    await sleep(2000);
    lastState = getDbState();
  }
  throw new Error(
    `Timed out waiting for local Codex LCM summaries and updated embeddings:\n${JSON.stringify(lastState, null, 2)}`
  );
};

const main = async () => {
  assert(
    Number.isFinite(eventCount) &&
      eventCount >=
        smokeLeafEventThreshold * smokeDepthOneFanout + smokeFreshEventTail,
    "--events must be high enough to exceed the fresh tail and trigger the requested leaf/rollup structure"
  );

  console.log(`LCM smoke marker: ${marker}`);
  console.log(`API: ${apiUrl}`);
  console.log(`Docker Compose project: ${composeProject}`);
  console.log(
    `Local LCM summary model: ${summaryModel} (${summaryReasoningEffort})`
  );

  let token = existingApiToken;
  let authLabel = "existing API token";
  if (token) {
    console.log("Using existing smoke API token.");
  } else {
    const email = `lcm-smoke-${marker}@example.com`;
    const password = `local-lcm-smoke-${randomUUID()}`;
    const registered = await requestJson("/auth/setup", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        displayName: "LCM Smoke Test"
      })
    });
    const cookie = registered.headers.get("set-cookie")?.split(";")[0];
    assert(cookie, "Registration did not return a session cookie");

    const tokenResponse = await requestJson("/api-tokens", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: `LCM smoke ${marker}` })
    });
    token = tokenResponse.body.token;
    authLabel = `created user ${email}`;
  }
  assert(
    typeof token === "string" && token.startsWith("cmt_"),
    "API token was not returned",
    { tokenType: typeof token, tokenPrefix: String(token).slice(0, 4) }
  );

  const authHeaders = { authorization: `Bearer ${token}` };
  const access = await requestJson("/v1/access/check", {
    headers: authHeaders
  });
  assert(access.body.ok === true, "Access check failed", access.body);
  assert(
    access.body.providerConfigSupported === false,
    "Expected backend provider configuration to stay unsupported for cost-safety smoke test",
    access.body
  );
  console.log(
    `Authenticated with ${authLabel}; token prefix ${token.slice(0, 12)}`
  );

  for (let index = 1; index <= eventCount; index += 1) {
    const content = [
      `LCM smoke prompt ${index}/${eventCount}.`,
      `Marker ${marker}.`,
      `The durable fact for this turn is summary-check-${marker}-${String(index).padStart(2, "0")}.`,
      "This content is intentionally repetitive enough for local semantic embedding but unique enough to verify ordered source recovery."
    ].join(" ");
    const response = await requestJson("/v1/memory/capture-personal-event", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        workspaceId,
        actor: "user",
        eventType: "user_prompt",
        content,
        metadata: {
          lcmSmokeMarker: marker,
          lcmSmokeIndex: index
        }
      })
    });
    assert(
      response.body.processing?.compaction?.queued === true,
      "Compaction was not queued for captured event",
      response.body
    );
  }
  console.log(
    `Captured ${eventCount} prompt events; waiting for backend compaction and placeholder embeddings...`
  );

  const structureState = await waitForLcmStructure();
  console.log("DB LCM structure state before local summarisation:");
  console.log(JSON.stringify(structureState, null, 2));

  const expectedFact = `summary-check-${marker}-01`;
  const pendingSearch = await requestJson("/v1/memory/search", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      query: expectedFact,
      retrieval_scope: "personal",
      limit: 50
    })
  });
  assert(
    pendingSearch.body.hits?.some(
      (hit) =>
        hit.summaryText?.includes(expectedFact) &&
        hit.lcmNodeSummaryStatus === "pending"
    ),
    "Search did not mark relevant pre-summary LCM evidence as pending",
    pendingSearch.body
  );
  console.log("Pre-summary pending search check:");
  console.log(
    JSON.stringify(
      {
        hits: pendingSearch.body.hits.length,
        pendingHits: pendingSearch.body.hits.filter(
          (hit) => hit.lcmNodeSummaryStatus === "pending"
        ).length,
        firstHit: pendingSearch.body.hits[0]
      },
      null,
      2
    )
  );

  const configDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "koed-lcm-smoke-")
  );
  const configPath = path.join(configDirectory, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ apiUrl, apiToken: token }, null, 2)
  );

  runCommand("corepack", ["pnpm", "--filter", "@koed/mcp-server", "build"]);
  const summaryOutput = runCommand("node", [
    "packages/mcp-server/dist/cli.js",
    "--config",
    configPath,
    "lcm-summarize",
    "--limit",
    "10",
    "--model",
    summaryModel,
    "--reasoning-effort",
    summaryReasoningEffort
  ]);
  const summaryRun = JSON.parse(summaryOutput);
  assert(
    summaryRun.submittedCount >= 3,
    "Local MCP summariser did not submit all expected LCM summaries",
    summaryRun
  );
  console.log("Local MCP summariser result:");
  console.log(JSON.stringify(summaryRun, null, 2));

  const state = await waitForLocalSummaries();
  console.log("DB summary state after local Codex summarisation:");
  console.log(JSON.stringify(state, null, 2));

  const search = await requestJson("/v1/memory/search", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      query: expectedFact,
      retrieval_scope: "personal",
      limit: 50
    })
  });
  assert(
    search.body.hits?.length > 0,
    "Search did not retrieve summarized/captured smoke content",
    search.body
  );
  assert(
    search.body.retrievalMode === "semantic_vector",
    "Expected semantic vector retrieval mode",
    search.body
  );
  assert(
    search.body.hits.some((hit) => hit.summaryText?.includes(expectedFact)),
    "Search did not return the exact expected smoke fact",
    search.body
  );
  assert(
    search.body.hits
      .filter((hit) => hit.summaryText?.includes(expectedFact))
      .every((hit) => hit.lcmNodeSummaryStatus !== "pending"),
    "Search still marked completed LCM evidence as pending",
    search.body
  );

  const rollupNodeId = state.rollupNodeId;
  assert(
    typeof rollupNodeId === "string" && rollupNodeId.length > 0,
    "No rollup node id found",
    state
  );
  const expanded = await requestJson(
    `/v1/memory/nodes/${encodeURIComponent(rollupNodeId)}/expand`,
    {
      headers: authHeaders
    }
  );
  assert(
    expanded.body.expanded?.sourceItems?.some(
      (item) => item.kind === "lcm_child"
    ),
    "Expanded rollup did not include child LCM summary references",
    expanded.body
  );
  assert(
    expanded.body.expanded?.sources?.length >=
      smokeLeafEventThreshold * smokeDepthOneFanout,
    "Expanded rollup did not recover enough original source events",
    expanded.body
  );

  console.log("Search check:");
  console.log(
    JSON.stringify(
      {
        hits: search.body.hits.length,
        retrievalMode: search.body.retrievalMode,
        vectorHitsCount: search.body.vectorHitsCount,
        textHitsCount: search.body.textHitsCount,
        firstHit: search.body.hits[0]
      },
      null,
      2
    )
  );
  console.log("Expanded rollup check:");
  console.log(
    JSON.stringify(
      {
        rollupNodeId,
        sourceItems: expanded.body.expanded.sourceItems.length,
        recoveredSources: expanded.body.expanded.sources.length,
        firstSource: expanded.body.expanded.sources[0]
      },
      null,
      2
    )
  );
  console.log("LCM smoke test passed.");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
