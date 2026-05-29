#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

const hookPayload = {
  hook_event_name: "Stop",
  session_id: marker,
  turn_id: randomUUID(),
  cwd: process.cwd(),
  model: "verification",
  prompt: `Koed capture hook verification marker: ${marker}`
};

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
hook.stdin.end(`${JSON.stringify(hookPayload)}\n`);

const code = await new Promise((resolve) => hook.on("close", resolve));
if (code !== 0) {
  console.error(stderr.trim() || stdout.trim());
  process.exit(Number(code) || 1);
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

console.log("Codex Capture Hook verification passed.");
console.log(`Marker: ${marker}`);
console.log(stderr.trim());
