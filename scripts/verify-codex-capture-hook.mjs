#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const apiUrl = (process.env.MEMORY_API_URL ?? "http://localhost:3000").replace(
  /\/+$/,
  ""
);
const apiToken = process.env.MEMORY_API_TOKEN;
const nodeCommand = process.env.MEMORY_NODE_COMMAND ?? "node";
const hookPath =
  process.env.MEMORY_CAPTURE_HOOK_PATH ??
  path.resolve("packages/mcp-server/dist/capture-hook.js");
const requireFromDbPackage = createRequire(
  path.resolve("packages/db/package.json")
);
const marker = `koed-capture-verify-${Date.now()}-${randomUUID().slice(0, 8)}`;

if (!apiToken) {
  console.error(
    "Set MEMORY_API_TOKEN to a Koed API token from `pnpm api-token:create`."
  );
  process.exit(1);
}

if (!existsSync(hookPath)) {
  console.error(
    `${hookPath} does not exist. Run pnpm --filter @koed/mcp-server build first.`
  );
  process.exit(1);
}

const requestJson = async (pathName, init = {}) => {
  const response = await fetch(`${apiUrl}${pathName}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${pathName} failed with ${response.status}: ${
        body.error ?? JSON.stringify(body)
      }`
    );
  }
  return body;
};

await requestJson("/v1/capture-policies", {
  method: "PUT",
  body: JSON.stringify({
    targetType: "global",
    captureState: "enabled",
    visibility: "personal"
  })
});

const runHook = async (payload) => {
  const hook = spawn(nodeCommand, [hookPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MEMORY_API_URL: apiUrl,
      MEMORY_API_TOKEN: apiToken,
      MEMORY_HOOK_STRICT: "true",
      MEMORY_HOOK_TRIGGER_LCM_SUMMARY: "false"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  hook.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  hook.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  hook.stdin.end(`${JSON.stringify(payload)}\n`);

  const code = await new Promise((resolve) => hook.on("close", resolve));
  if (code !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `hook exited ${code}`);
  }
  return stderr.trim();
};

const turnId = randomUUID();
const hookPayloads = [
  {
    hook_event_name: "UserPromptSubmit",
    session_id: marker,
    turn_id: turnId,
    cwd: process.cwd(),
    model: "verification",
    prompt: `Koed capture hook verification prompt: ${marker}`
  },
  {
    hook_event_name: "PostToolUse",
    session_id: marker,
    turn_id: turnId,
    tool_use_id: `verify-tool-${randomUUID()}`,
    tool_name: "verification_tool",
    tool_input: { marker },
    tool_response: `Koed capture hook verification tool result: ${marker}`,
    cwd: process.cwd(),
    model: "verification"
  },
  {
    hook_event_name: "Stop",
    session_id: marker,
    turn_id: turnId,
    cwd: process.cwd(),
    model: "verification",
    last_assistant_message: `Koed capture hook verification final response: ${marker}`
  }
];

const hookLogs = [];
for (const payload of hookPayloads) {
  try {
    hookLogs.push(await runHook(payload));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const search = await requestJson("/v1/memory/search", {
  method: "POST",
  body: JSON.stringify({
    query: marker,
    retrieval_scope: "personal",
    search_domain: "project",
    workspace_id: process.cwd(),
    limit: 5
  })
});

const hit = Array.isArray(search.hits)
  ? search.hits.find((item) => JSON.stringify(item).includes(marker))
  : null;

if (!hit) {
  console.error(
    `Capture Hook ran but marker was not found in memory: ${marker}`
  );
  process.exit(1);
}

if (process.env.DATABASE_URL) {
  const { Client } = requireFromDbPackage("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const raw = await client.query(
      `
        select source_event_type, count(*)::int as count
        from conversation_items
        where external_session_id = $1
          and source_adapter_version = 'codex-hook-v1'
          and source_event_type = any($2::text[])
        group by source_event_type
      `,
      [marker, ["UserPromptSubmit", "PostToolUse", "Stop"]]
    );
    const counts = new Map(
      raw.rows.map((row) => [row.source_event_type, Number(row.count)])
    );
    for (const eventName of ["UserPromptSubmit", "PostToolUse", "Stop"]) {
      if (counts.get(eventName) !== 1) {
        throw new Error(
          `Expected exactly one raw ${eventName} item for ${marker}; got ${
            counts.get(eventName) ?? 0
          }`
        );
      }
    }

    const duplicates = await client.query(
      `
        select idempotency_key, count(*)::int as count
        from conversation_items
        where external_session_id = $1
        group by idempotency_key
        having count(*) > 1
      `,
      [marker]
    );
    if (duplicates.rowCount > 0) {
      throw new Error(
        `Duplicate raw conversation item idempotency keys found for ${marker}`
      );
    }
  } finally {
    await client.end();
  }
}

console.log("Codex Capture Hook verification passed.");
console.log(`Marker: ${marker}`);
console.log(hookLogs.filter(Boolean).join("\n"));
