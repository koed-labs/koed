#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const parseEnvFile = (filePath) => {
  if (!existsSync(filePath)) return {};
  return Object.fromEntries(
    readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [
          line.slice(0, separator).trim(),
          line.slice(separator + 1).trim()
        ];
      })
  );
};
const usableToken = (value) => {
  const token = value?.trim();
  return token && !token.includes("replace_with_token") ? token : null;
};
const rootEnv = parseEnvFile(path.resolve(".env"));
const explorerEnv = parseEnvFile(path.resolve("apps/explorer/.env.local"));
const apiUrl = (
  process.env.MEMORY_API_URL ??
  rootEnv.MEMORY_API_URL ??
  (process.env.API_HOST_PORT
    ? `http://localhost:${process.env.API_HOST_PORT}`
    : null) ??
  (rootEnv.API_HOST_PORT
    ? `http://localhost:${rootEnv.API_HOST_PORT}`
    : null) ??
  "http://localhost:3300"
).replace(/\/+$/, "");
const apiToken =
  usableToken(process.env.MEMORY_API_TOKEN) ??
  usableToken(rootEnv.MEMORY_API_TOKEN) ??
  usableToken(process.env.VITE_KOED_API_TOKEN) ??
  usableToken(rootEnv.VITE_KOED_API_TOKEN) ??
  usableToken(explorerEnv.VITE_KOED_API_TOKEN);
const nodeCommand = process.env.MEMORY_NODE_COMMAND ?? "node";
const hookPath =
  process.env.MEMORY_CAPTURE_HOOK_PATH ??
  path.resolve("packages/mcp-server/dist/capture-hook.js");
const requireFromDbPackage = createRequire(
  path.resolve("packages/db/package.json")
);
const marker = `koed-capture-verify-${Date.now()}-${randomUUID().slice(0, 8)}`;
const promptText = `Koed capture hook verification prompt: ${marker}`;
const toolCallPurpose = `Koed capture hook verification tool call: ${marker}`;
const toolResultText = `Koed capture hook verification tool result: ${marker}`;
const finalText = `Koed capture hook verification final response: ${marker}`;
let transcriptTimestampOffset = 0;
const searchTimeoutMs = Number(
  process.env.CAPTURE_VERIFY_SEARCH_TIMEOUT_MS ?? 30000
);
const searchPollMs = Number(process.env.CAPTURE_VERIFY_SEARCH_POLL_MS ?? 1000);

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

const tempDir = mkdtempSync(path.join(tmpdir(), "koed-capture-verify-"));
const transcriptPath = path.join(tempDir, "transcript.jsonl");

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (description, fn, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(
    `${description} did not complete within ${timeoutMs}ms${
      lastError
        ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}`
        : ""
    }`
  );
};

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
const transcriptTimestamp = () =>
  new Date(Date.now() + transcriptTimestampOffset++).toISOString();
const transcriptRecord = (payload) =>
  JSON.stringify({
    timestamp: transcriptTimestamp(),
    type: "event_msg",
    payload
  });
const responseItem = (payload) =>
  JSON.stringify({
    timestamp: transcriptTimestamp(),
    type: "response_item",
    payload
  });
const appendTranscriptRecords = (records) => {
  writeFileSync(transcriptPath, `${records.join("\n")}\n`, { flag: "a" });
};

const waitForMarkerSearchHit = async () => {
  const deadline = Date.now() + searchTimeoutMs;
  let lastSearch;

  do {
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
    lastSearch = search;

    const hit = Array.isArray(search.hits)
      ? search.hits.find((item) => JSON.stringify(item).includes(marker))
      : null;
    if (hit) return hit;

    await sleep(searchPollMs);
  } while (Date.now() < deadline);

  throw new Error(
    `Capture Hook ran but marker was not found in memory within ${searchTimeoutMs}ms: ${marker}${lastSearch ? `; last search response: ${JSON.stringify(lastSearch)}` : ""}`
  );
};

try {
  await requestJson("/v1/capture-policies", {
    method: "PUT",
    body: JSON.stringify({
      targetType: "global",
      captureState: "enabled",
      visibility: "personal"
    })
  });

  writeFileSync(transcriptPath, "");

  const hookLogs = [];
  hookLogs.push(
    await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: marker,
      turn_id: turnId,
      transcript_path: transcriptPath,
      cwd: process.cwd(),
      model: "verification",
      prompt: promptText
    })
  );

  const toolUseId = `verify-tool-${randomUUID()}`;
  appendTranscriptRecords([
    transcriptRecord({ type: "user_message", message: promptText }),
    responseItem({
      type: "function_call",
      id: toolUseId,
      call_id: toolUseId,
      name: "verification_tool",
      arguments: { marker, purpose: toolCallPurpose },
      status: "completed"
    }),
    responseItem({
      type: "function_call_output",
      id: `${toolUseId}-output`,
      call_id: toolUseId,
      output: toolResultText
    })
  ]);

  hookLogs.push(
    await runHook({
      hook_event_name: "PostToolUse",
      session_id: marker,
      turn_id: turnId,
      transcript_path: transcriptPath,
      tool_use_id: toolUseId,
      tool_name: "verification_tool",
      tool_input: { marker, purpose: toolCallPurpose },
      tool_response: toolResultText,
      cwd: process.cwd(),
      model: "verification"
    })
  );

  appendTranscriptRecords([
    transcriptRecord({ type: "agent_message", message: finalText })
  ]);

  hookLogs.push(
    await runHook({
      hook_event_name: "Stop",
      session_id: marker,
      turn_id: turnId,
      transcript_path: transcriptPath,
      cwd: process.cwd(),
      model: "verification",
      last_assistant_message: finalText
    })
  );

  let verifiedWithDatabase = false;
  if (process.env.DATABASE_URL) {
    const { Client } = requireFromDbPackage("pg");
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await waitFor("Capture Hook DB projection", async () => {
        const raw = await client.query(
          `
            select source_adapter_version, source_event_type, count(*)::int as count
            from conversation_items
            where external_session_id = $1
              and (
                source_adapter_version = 'codex-hook-v1'
                or source_adapter_version = 'codex-transcript-v1'
              )
            group by source_adapter_version, source_event_type
          `,
          [marker]
        );
        const rawCounts = new Map(
          raw.rows.map((row) => [
            `${row.source_adapter_version}:${row.source_event_type}`,
            Number(row.count)
          ])
        );
        const expectedRawCounts = new Map([
          ["codex-transcript-v1:user_message", 1],
          ["codex-transcript-v1:function_call", 1],
          ["codex-transcript-v1:function_call_output", 1],
          ["codex-transcript-v1:agent_message", 1],
          ["codex-hook-v1:Stop", 1]
        ]);
        for (const [key, expectedCount] of expectedRawCounts) {
          if (rawCounts.get(key) !== expectedCount) {
            throw new Error(
              `Expected ${expectedCount} raw ${key} item(s) for ${marker}; got ${
                rawCounts.get(key) ?? 0
              }`
            );
          }
        }

        const rawDuplicates = await client.query(
          `
            select source_adapter_version, source_event_type, source_hash, idempotency_key, count(*)::int as count
            from conversation_items
            where external_session_id = $1
            group by source_adapter_version, source_event_type, source_hash, idempotency_key
            having count(*) > 1
          `,
          [marker]
        );
        if (rawDuplicates.rowCount > 0) {
          throw new Error(
            `Duplicate raw conversation item source/idempotency keys found for ${marker}`
          );
        }

        const missingTranscriptTimes = await client.query(
          `
            select count(*)::int as count
            from conversation_items
            where external_session_id = $1
              and source_adapter_version = 'codex-transcript-v1'
              and event_time is null
          `,
          [marker]
        );
        if (Number(missingTranscriptTimes.rows[0]?.count ?? 0) !== 0) {
          throw new Error(
            `Transcript rows without source event timestamps found for ${marker}`
          );
        }

        const memoryEvents = await client.query(
          `
            select payload ->> 'content' as content
            from memory_events
            where session_id in (
              select distinct session_id
              from conversation_items
              where external_session_id = $1
                and session_id is not null
            )
              and payload ->> 'content' ilike '%' || $2 || '%'
          `,
          [marker, marker]
        );
        const matchingMemoryEventCount = (snippet) =>
          memoryEvents.rows.filter((row) => row.content?.includes(snippet))
            .length;
        for (const snippet of [promptText, toolResultText, finalText]) {
          const count = matchingMemoryEventCount(snippet);
          if (count !== 1) {
            throw new Error(
              `Expected exactly one projected memory event containing "${snippet}" for ${marker}; got ${count}`
            );
          }
        }
        return true;
      });
      verifiedWithDatabase = true;
    } finally {
      await client.end();
    }
  }

  if (!verifiedWithDatabase) {
    await waitForMarkerSearchHit();
  }

  console.log("Codex Capture Hook verification passed.");
  console.log(`Marker: ${marker}`);
  console.log(hookLogs.filter(Boolean).join("\n"));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
