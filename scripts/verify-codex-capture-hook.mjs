#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryApiClient } from "../packages/mcp-server/dist/index.js";
import { startCodexTranscriptWatcher } from "../packages/mcp-server/dist/codex-transcript-watcher.js";
import { resolveCaptureVerificationConfig } from "./verify-codex-capture-hook-lib.mjs";

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
const rootEnv = parseEnvFile(path.resolve(".env"));
const explorerEnv = parseEnvFile(path.resolve("apps/explorer/.env.local"));
const { apiUrl, apiToken } = resolveCaptureVerificationConfig({
  environment: process.env,
  rootEnv,
  explorerEnv
});
const nodeCommand = process.env.MEMORY_NODE_COMMAND ?? "node";
const hookPath =
  process.env.MEMORY_CAPTURE_HOOK_PATH ??
  path.resolve("packages/mcp-server/dist/capture-hook.js");
const requireFromDbPackage = createRequire(
  path.resolve("packages/db/package.json")
);
const marker = `koed-capture-verify-${Date.now()}-${randomUUID().slice(0, 8)}`;
const promptMarker = `${marker}-prompt`;
const toolCallMarker = `${marker}-tool-call`;
const toolResultMarker = `${marker}-tool-result`;
const finalMarker = `${marker}-final`;
const promptText = `Koed capture hook verification prompt: ${promptMarker}`;
const toolCallPurpose = `Koed capture hook verification tool call: ${toolCallMarker}`;
const toolResultText = `Koed capture hook verification tool result: ${toolResultMarker}`;
const finalText = `Koed capture hook verification final response: ${finalMarker}`;
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
const transcriptRoot = path.join(tempDir, "sessions");
const koedHome = path.join(tempDir, "koed-home");
const transcriptPath = path.join(transcriptRoot, `rollout-${marker}.jsonl`);
mkdirSync(transcriptRoot, { recursive: true, mode: 0o700 });
mkdirSync(path.join(koedHome, "run"), { recursive: true, mode: 0o700 });
const watcher = startCodexTranscriptWatcher(
  new MemoryApiClient({
    apiUrl,
    apiToken,
    requestTimeoutMs: 60_000
  }),
  {
    roots: [transcriptRoot],
    koedHome,
    rescanIntervalMs: 250,
    debounceMs: 10,
    maxEntriesPerScan: 100,
    maxFilesPerScan: 10,
    maxBytesPerBatch: 1_048_576
  }
);

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
      KOED_HOME: koedHome
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
const sessionRecord = () =>
  JSON.stringify({
    timestamp: transcriptTimestamp(),
    type: "session_meta",
    payload: {
      id: marker,
      cwd: process.cwd(),
      timestamp: transcriptTimestamp(),
      model_provider: "verification"
    }
  });

const waitForSearchHit = async ({ description, query, requiredSnippets }) => {
  const deadline = Date.now() + searchTimeoutMs;
  let lastSearch;

  do {
    const search = await requestJson("/v1/memory/search", {
      method: "POST",
      body: JSON.stringify({
        query,
        retrieval_scope: "personal",
        search_domain: "project",
        project_id: process.cwd(),
        limit: 5
      })
    });
    lastSearch = search;

    const hit = Array.isArray(search.hits)
      ? search.hits.find((item) => {
          const encoded = JSON.stringify(item);
          return requiredSnippets.every((snippet) => encoded.includes(snippet));
        })
      : null;
    if (hit && search.retrievalMode === "semantic_vector") return hit;

    await sleep(searchPollMs);
  } while (Date.now() < deadline);

  throw new Error(
    `${description} was not embedded and retrievable within ${searchTimeoutMs}ms${lastSearch ? `; last search response: ${JSON.stringify(lastSearch)}` : ""}`
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

  await watcher.scanNow();
  writeFileSync(transcriptPath, "");

  const hookLogs = [];
  hookLogs.push(
    await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: marker,
      transcript_path: transcriptPath
    })
  );

  const toolUseId = `verify-tool-${randomUUID()}`;
  appendTranscriptRecords([
    sessionRecord(),
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
      transcript_path: transcriptPath
    })
  );

  appendTranscriptRecords([
    transcriptRecord({ type: "agent_message", message: finalText })
  ]);

  hookLogs.push(
    await runHook({
      hook_event_name: "Stop",
      session_id: marker,
      transcript_path: transcriptPath
    })
  );
  const expectedTranscriptBytes = readFileSync(transcriptPath);
  const expectedTranscriptLines =
    expectedTranscriptBytes.toString("utf8").split("\n").length - 1;

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
          ["codex-hook-signal-v1:turn_completed", 1]
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
              and event_time is null
          `,
          [marker]
        );
        if (Number(missingTranscriptTimes.rows[0]?.count ?? 0) !== 0) {
          throw new Error(
            `Conversation source rows without source event timestamps found for ${marker}`
          );
        }

        const boundary = await client.query(
          `
            select raw_text, raw_json, canonical_stable_item_id
            from conversation_items
            where external_session_id = $1
              and source_adapter_version = 'codex-hook-signal-v1'
              and source_event_type = 'turn_completed'
          `,
          [marker]
        );
        if (
          boundary.rowCount !== 1 ||
          boundary.rows[0]?.raw_text !== null ||
          boundary.rows[0]?.raw_json?.type !== "hook_signal" ||
          !boundary.rows[0]?.canonical_stable_item_id?.endsWith(":completed")
        ) {
          throw new Error(
            `Expected one content-free Capture Hook turn boundary for ${marker}`
          );
        }

        const memoryEvents = await client.query(
          `
            select
              event.id,
              event.payload ->> 'content' as content,
              exists (
                select 1
                from memory_embeddings embedding
                where embedding.memory_event_id = event.id
                  and embedding.invalidated_at is null
                  and embedding.personal_deleted_at is null
              ) as embedded
            from memory_events event
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
        for (const snippet of [
          promptText,
          toolCallPurpose,
          toolResultText,
          finalText
        ]) {
          const count = matchingMemoryEventCount(snippet);
          if (count !== 1) {
            throw new Error(
              `Expected exactly one projected memory event containing "${snippet}" for ${marker}; got ${count}`
            );
          }
        }
        const completeAgentEvents = memoryEvents.rows.filter((row) =>
          [toolCallPurpose, toolResultText, finalText].every((snippet) =>
            row.content?.includes(snippet)
          )
        );
        if (completeAgentEvents.length !== 1) {
          throw new Error(
            `Expected one bundled agent memory event for ${marker}; got ${completeAgentEvents.length}`
          );
        }
        const expectedEmbeddedEvents = memoryEvents.rows.filter(
          (row) =>
            row.content?.includes(promptText) ||
            completeAgentEvents.some((agent) => agent.id === row.id)
        );
        if (
          expectedEmbeddedEvents.length !== 2 ||
          expectedEmbeddedEvents.some((row) => row.embedded !== true)
        ) {
          throw new Error(
            `Expected the user and bundled agent memory events to be embedded for ${marker}`
          );
        }

        const journal = await client.query(
          `
            select
              artifact.id as artifact_id,
              artifact.provider_cursor_offset,
              artifact.provider_cursor_line,
              artifact.current_source_length,
              segment.id as segment_id,
              segment.source_start_offset,
              segment.source_end_offset,
              segment.source_start_line,
              segment.source_end_line,
              segment.plaintext_size,
              cursor.source_offset as consumer_source_offset,
              cursor.source_line as consumer_source_line
            from conversation_source_artifacts artifact
            join conversation_source_segments segment
              on segment.artifact_id = artifact.id
            join conversation_source_consumer_cursors cursor
              on cursor.artifact_id = artifact.id
             and cursor.consumer_kind = 'canonical_live'
            where artifact.external_session_id = $1
            order by segment.segment_index
          `,
          [marker]
        );
        if (journal.rowCount === 0) {
          throw new Error(
            `Expected source journal segments for ${marker}; got none`
          );
        }
        const journalRows = journal.rows;
        const journalRow = journalRows.at(-1);
        let expectedOffset = 0;
        let expectedLine = 0;
        let plaintextSize = 0;
        const storedSegments = [];
        for (const row of journalRows) {
          if (
            Number(row.source_start_offset) !== expectedOffset ||
            Number(row.source_start_line) !== expectedLine
          ) {
            throw new Error(
              `Conversation source journal segments were not contiguous for ${marker}`
            );
          }
          expectedOffset = Number(row.source_end_offset);
          expectedLine = Number(row.source_end_line);
          plaintextSize += Number(row.plaintext_size);
          const stored = await requestJson(
            `/v1/conversation-source-artifacts/${encodeURIComponent(
              row.artifact_id
            )}/segments/${encodeURIComponent(row.segment_id)}/content`
          );
          storedSegments.push(Buffer.from(stored.bytesBase64 ?? "", "base64"));
        }
        if (
          expectedOffset !== expectedTranscriptBytes.byteLength ||
          expectedLine !== expectedTranscriptLines ||
          plaintextSize !== expectedTranscriptBytes.byteLength ||
          Number(journalRow.provider_cursor_offset) !==
            expectedTranscriptBytes.byteLength ||
          Number(journalRow.provider_cursor_line) !== expectedTranscriptLines ||
          Number(journalRow.current_source_length) !==
            expectedTranscriptBytes.byteLength ||
          Number(journalRow.consumer_source_offset) !==
            expectedTranscriptBytes.byteLength ||
          Number(journalRow.consumer_source_line) !== expectedTranscriptLines
        ) {
          throw new Error(
            `Conversation source journal cursors did not match the exact source frontier for ${marker}`
          );
        }
        const storedTranscriptBytes = Buffer.concat(storedSegments);
        if (!storedTranscriptBytes.equals(expectedTranscriptBytes)) {
          throw new Error(
            `Conversation source journal bytes did not reconstruct the transcript for ${marker}`
          );
        }
        return true;
      });
      verifiedWithDatabase = true;
    } finally {
      await client.end();
    }
  }

  if (!verifiedWithDatabase) {
    await waitForSearchHit({
      description: "Captured user prompt",
      query: promptMarker,
      requiredSnippets: [promptText]
    });
    await waitForSearchHit({
      description: "Complete captured agent turn",
      query: finalMarker,
      requiredSnippets: [toolCallPurpose, toolResultText, finalText]
    });
  }

  console.log("Codex Capture Hook verification passed.");
  console.log(`Marker: ${marker}`);
  console.log(hookLogs.filter(Boolean).join("\n"));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await watcher.stop();
  rmSync(tempDir, { recursive: true, force: true });
}
