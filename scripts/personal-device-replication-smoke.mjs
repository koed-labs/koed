#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  replicatedTranscriptItems,
  waitForReplicatedRetrieval
} from "./personal-device-replication-smoke-lib.mjs";

const requireFromDb = createRequire(
  new URL("../packages/db/package.json", import.meta.url)
);
const { Client } = requireFromDb("pg");
const originA = process.env.PDS_SMOKE_DEVICE_A_URL?.trim()?.replace(/\/+$/, "");
const originB = process.env.PDS_SMOKE_DEVICE_B_URL?.trim()?.replace(/\/+$/, "");
const tokenA = process.env.PDS_SMOKE_DEVICE_A_API_TOKEN?.trim();
const tokenB = process.env.PDS_SMOKE_DEVICE_B_API_TOKEN?.trim();
const cookieA = process.env.PDS_SMOKE_DEVICE_A_BROWSER_COOKIE?.trim();
const databaseB = process.env.PDS_SMOKE_DEVICE_B_DATABASE_URL?.trim();
const groupId = process.env.PDS_SMOKE_GROUP_ID?.trim();
const browserOrigin =
  process.env.PDS_SMOKE_BROWSER_ORIGIN?.trim() || "http://127.0.0.1:5174";
const required = {
  originA,
  originB,
  tokenA,
  tokenB,
  cookieA,
  databaseB,
  groupId
};
for (const [name, value] of Object.entries(required)) {
  if (!value)
    throw new Error(`Missing required Personal replication setting: ${name}.`);
}
if (new URL(originA).origin === new URL(originB).origin) {
  throw new Error(
    "Personal replication smoke requires distinct Device A and Device B API origins."
  );
}

const request = async (
  origin,
  route,
  { token, cookie, method = "GET", body } = {}
) => {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie, origin: browserOrigin } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${method} ${route} failed (${response.status}): ${text}`);
  }
  return parsed;
};

const marker = `pds-replication-${Date.now()}-${randomUUID().slice(0, 8)}`;
const listener = new Client({ connectionString: databaseB });
await listener.connect();
try {
  await request(
    originA,
    `/v1/personal-device-sync/groups/${encodeURIComponent(groupId)}/policy`,
    {
      cookie: cookieA,
      method: "PUT",
      body: {
        enabled: true,
        future_closed_sessions_only: true,
        historical_backfill_enabled: false
      }
    }
  );
  const created = await request(originA, "/v1/sessions", {
    token: tokenA,
    method: "POST",
    body: {
      externalSessionId: marker,
      sourceRuntime: "codex",
      captureMethod: "transcript",
      projectId: marker
    }
  });
  const sessionId = created.session?.id;
  if (typeof sessionId !== "string")
    throw new Error("Device A did not create a Captured Session.");
  const observedAt = new Date().toISOString();
  await request(originA, "/v1/memory/conversation-items", {
    token: tokenA,
    method: "POST",
    body: {
      items: replicatedTranscriptItems({ sessionId, marker, observedAt })
    }
  });
  const projected = await request(
    originA,
    "/v1/memory/conversation-items/project",
    {
      token: tokenA,
      method: "POST",
      body: { limit: 100 }
    }
  );
  if (Number(projected.projection?.memoryEventsCreated ?? 0) < 1) {
    throw new Error("Device A Projection did not create a Memory Event.");
  }

  let closure;
  const received = await waitForReplicatedRetrieval({
    listener,
    marker,
    onListening: async () => {
      closure = await request(
        originA,
        `/v1/personal-device-sync/groups/${encodeURIComponent(groupId)}/sessions/${encodeURIComponent(sessionId)}/close`,
        { cookie: cookieA, method: "POST" }
      );
      if (closure.closure?.state !== "ready") {
        throw new Error(
          "Device A did not seal a ready closed-session package."
        );
      }
    },
    search: () =>
      request(originB, "/v1/memory/search", {
        token: tokenB,
        method: "POST",
        body: {
          query: marker,
          retrieval_scope: "personal",
          search_domain: "global",
          limit: 5
        }
      })
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        marker,
        sessionId,
        sourceSequence: closure.closure.source_sequence,
        deviceB: {
          retrievalMode: received.search.retrievalMode,
          hits: received.search.hits.length
        }
      },
      null,
      2
    )}\n`
  );
} finally {
  await listener.end();
}
