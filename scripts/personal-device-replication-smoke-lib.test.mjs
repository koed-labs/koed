import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  replicatedTranscriptItems,
  waitForReplicatedRetrieval
} from "./personal-device-replication-smoke-lib.mjs";

test("waits on PDS notifications and verifies receiver semantic retrieval", async () => {
  const listener = new EventEmitter();
  const queries = [];
  listener.query = async (sql) => queries.push(sql);
  let checks = 0;
  const waiting = waitForReplicatedRetrieval({
    listener,
    marker: "replicated-marker",
    timeoutMs: 1_000,
    readStatus: async () => ({ status: { replicas: { ready: checks } } }),
    search: async () => {
      checks += 1;
      return checks > 1
        ? {
            retrievalMode: "semantic_vector",
            hits: [{ text: "replicated-marker" }]
          }
        : { retrievalMode: "semantic_vector", hits: [] };
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  listener.emit("notification", {
    channel: "koed_pds_local_sync",
    payload: "embedding_ready"
  });
  const result = await waiting;
  assert.equal(result.search.hits.length, 1);
  assert.deepEqual(queries, [
    "listen koed_pds_local_sync",
    "unlisten koed_pds_local_sync"
  ]);
});

test("builds one transcript-backed Personal source item", () => {
  const items = replicatedTranscriptItems({
    sessionId: "11111111-1111-4111-8111-111111111111",
    marker: "marker",
    observedAt: "2026-08-12T00:00:00.000Z"
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].metadata.transcriptType, "user_message");
  assert.match(items[0].rawText, /marker/);
});
