#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

if (process.env.KOED_RUN_PRIVACY_ACCELERATOR_TEST !== "1") {
  throw new Error(
    "Set KOED_RUN_PRIVACY_ACCELERATOR_TEST=1 to run the shared-accelerator smoke test."
  );
}

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const apiUrl = (process.env.MEMORY_API_URL ?? "http://127.0.0.1:3300").replace(
  /\/$/u,
  ""
);
const privacyUrl = (
  process.env.PRIVACY_SERVICE_URL ?? "http://127.0.0.1:8092"
).replace(/\/$/u, "");
const memoryApiToken = required("MEMORY_API_TOKEN");
const privacyToken = required("PRIVACY_SERVICE_TOKEN");
const privacyControlToken = required("PRIVACY_RUNTIME_CONTROL_TOKEN");
const databaseUrl = required("DATABASE_URL");
const psqlBin = process.env.PSQL_BIN?.trim() || "psql";
const requestCount = 2;

const requestJson = async (url, init = {}) => {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    body = { error: "response was not JSON" };
  }
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${new URL(url).pathname} failed (${response.status}): ${body.error ?? "unknown error"}`
    );
  }
  return body;
};

const capabilities = await requestJson(`${privacyUrl}/v1/capabilities`, {
  headers: { "x-koed-privacy-token": privacyToken }
});
if (capabilities.maximumConcurrentRequests !== 1) {
  throw new Error("Privacy Service did not declare one concurrent request.");
}

const runtime = await requestJson(`${privacyUrl}/v1/runtime/status`, {
  headers: { "x-koed-privacy-token": privacyControlToken }
});
if (runtime.activeProvider === "cpu") {
  throw new Error("Privacy Service is not using an accelerator.");
}

const embeddingHealth = await requestJson(
  `${process.env.EMBEDDING_SERVICE_URL ?? "http://127.0.0.1:3800"}/health`
);
if (typeof embeddingHealth.acceleration !== "string") {
  throw new Error("Embedding Service did not report its acceleration state.");
}
if (embeddingHealth.acceleration.startsWith("cpu;")) {
  throw new Error("Embedding Service is not using an accelerator.");
}

const fields = Array.from({ length: 8 }, (_, fieldIndex) => ({
  path: `items[${fieldIndex}].content`,
  text: `${Array.from({ length: 64 }, (_, tokenIndex) =>
    createHash("sha256")
      .update(`privacy-shared-accelerator-${fieldIndex}-${tokenIndex}`)
      .digest("hex")
  ).join(" ")} `
}));
const privacyBody = JSON.stringify({
  schemaVersion: 1,
  inputContractVersion: capabilities.inputContractVersion,
  fields
});

const privacyStates = Array.from({ length: requestCount }, () => ({
  complete: false,
  durationMs: 0,
  resultFields: 0
}));
const privacyStartedAt = performance.now();
const privacyRequests = privacyStates.map(async (state) => {
  const startedAt = performance.now();
  try {
    const body = await requestJson(`${privacyUrl}/v1/classify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-koed-privacy-token": privacyToken
      },
      body: privacyBody
    });
    state.resultFields = Array.isArray(body.fields) ? body.fields.length : 0;
    if (state.resultFields !== fields.length) {
      throw new Error("Privacy Service returned an incomplete field result.");
    }
  } finally {
    state.durationMs = Math.round(performance.now() - startedAt);
    state.complete = true;
  }
});

await sleep(1_000);
const marker = `privacy-shared-accelerator-${Date.now()}`;
const apiHeaders = {
  authorization: `Bearer ${memoryApiToken}`,
  "content-type": "application/json"
};
const session = await requestJson(`${apiUrl}/v1/sessions`, {
  method: "POST",
  headers: apiHeaders,
  body: JSON.stringify({
    externalSessionId: marker,
    sourceRuntime: "codex-cli",
    captureMethod: "api",
    projectId: "privacy-shared-accelerator-proof"
  })
});
const sessionId = session.session?.id;
if (typeof sessionId !== "string") {
  throw new Error("The synthetic Captured Session was not created.");
}
const captured = await requestJson(
  `${apiUrl}/v1/memory/capture-personal-event`,
  {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({
      projectId: "privacy-shared-accelerator-proof",
      sessionId,
      actor: "user",
      eventType: "user_prompt",
      content: `Embedding progress during sustained Privacy accelerator load ${marker}.`,
      metadata: { privacySharedAcceleratorProof: true },
      sourceRuntime: "codex-cli",
      captureMethod: "api"
    })
  }
);
const eventId = captured.event?.id;
if (typeof eventId !== "string") {
  throw new Error("The synthetic Memory Event was not created.");
}

const embeddingStartedAt = performance.now();
let embedded = false;
let privacyActiveAtEmbedding = false;
for (let attempt = 0; attempt < 600; attempt += 1) {
  const { stdout } = await execFile(
    psqlBin,
    [
      databaseUrl,
      "-Atqc",
      `select count(*) from memory_embeddings where memory_event_id = '${eventId}' and invalidated_at is null`
    ],
    { timeout: 5_000 }
  );
  if (Number(stdout.trim()) > 0) {
    embedded = true;
    privacyActiveAtEmbedding = privacyStates.some((state) => !state.complete);
    break;
  }
  await sleep(250);
}
const embeddingDurationMs = Math.round(performance.now() - embeddingStartedAt);
await Promise.all(privacyRequests);

const result = {
  schemaVersion: 1,
  passed: embedded && privacyActiveAtEmbedding,
  privacy: {
    activeProvider: runtime.activeProvider,
    maximumConcurrentRequests: capabilities.maximumConcurrentRequests,
    requestCount,
    requestDurationsMs: privacyStates.map((state) => state.durationMs),
    responseFieldCounts: privacyStates.map((state) => state.resultFields),
    totalWallMs: Math.round(performance.now() - privacyStartedAt)
  },
  embedding: {
    acceleration: embeddingHealth.acceleration,
    eventId,
    completed: embedded,
    completedWhilePrivacyActive: privacyActiveAtEmbedding,
    durationMs: embeddingDurationMs
  }
};

console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
