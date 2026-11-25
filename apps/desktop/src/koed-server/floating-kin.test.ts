import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  createFloatingKinLaunchState,
  createFloatingKinRuntime
} from "./floating-kin.js";

it("does not contact the runtime while stopped or starting", async () => {
  let lifecycle: "stopped" | "starting" = "stopped";
  const runtime = createFloatingKinRuntime({
    koedHome: "/missing",
    lifecycle: () => lifecycle,
    accountKey: () => "signed_out:"
  });
  expect(await runtime.activity()).toEqual({ state: "stopped" });
  lifecycle = "starting";
  expect(await runtime.activity()).toEqual({ state: "starting" });
});

it("bounds the wait for registration even if resume succeeds before publication", () => {
  let now = 1000;
  const launch = createFloatingKinLaunchState(() => now);
  expect(launch.pending()).toBe(true);
  launch.settle(true);
  expect(launch.pending()).toBe(true);
  now += 12_000;
  expect(launch.pending()).toBe(false);

  const failed = createFloatingKinLaunchState(() => now);
  failed.settle(false);
  expect(failed.pending()).toBe(false);

  const stalled = createFloatingKinLaunchState(() => now);
  now += 60_000;
  expect(stalled.pending()).toBe(false);
  stalled.settle(true);
  expect(stalled.pending()).toBe(false);
});

it("reports starting only for a missing registration during launch before the first successful activity read", async () => {
  const koedHome = mkdtempSync(join(tmpdir(), "koed-floating-kin-"));
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ conversations: [], overflowCount: 0 }));
  });
  let launchPending = true;
  const runtime = createFloatingKinRuntime({
    koedHome,
    lifecycle: () => "running",
    launchPending: () => launchPending,
    accountKey: () => "signed_out:"
  });
  try {
    expect(await runtime.activity()).toEqual({ state: "starting" });
    launchPending = false;
    expect(await runtime.activity()).toEqual({ state: "unavailable" });
    launchPending = true;

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No HTTP address");
    mkdirSync(join(koedHome, "run"));
    const path = join(koedHome, "run", "local-ai-runtime.json");
    writeFileSync(path, "{}", { mode: 0o600 });
    expect(await runtime.activity()).toEqual({ state: "unavailable" });
    writeFileSync(
      path,
      JSON.stringify({
        protocolVersion: 1,
        url: `http://127.0.0.1:${address.port}`,
        authorization: `Bearer ${"a".repeat(32)}`,
        pid: process.pid,
        startedAt: new Date().toISOString()
      })
    );
    expect(await runtime.activity()).toMatchObject({ state: "running" });
    rmSync(path);
    expect(await runtime.activity()).toEqual({ state: "unavailable" });
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(koedHome, { recursive: true, force: true });
  }
});

const statuses = ["signed_out", "reauthentication_required"];
it.each(statuses)("uses local authority while %s", async (status) => {
  const koedHome = mkdtempSync(join(tmpdir(), "koed-floating-kin-"));
  const authorization = `Bearer ${"a".repeat(32)}`;
  const input = {
    sessionId: "803c2792-c18b-4484-a699-b33c7d8a7576",
    action: "project" as const,
    projectId: "d861e091-bbd9-45c3-9907-463cb3c42744"
  };
  const capturedAt = "2026-10-01T12:00:00.000Z";
  const conversation = {
    sessionId: input.sessionId,
    projectId: input.projectId,
    client: "codex",
    lastActivityAt: capturedAt
  };
  const answer = {
    status: "answered",
    captured: "Implemented a focused test.",
    inferred: null,
    asOf: capturedAt,
    truncated: false,
    sources: [
      {
        id: "453181f5-310b-4cab-ae84-faac1797a25a",
        sessionId: input.sessionId,
        kind: "memory_event",
        occurredAt: capturedAt
      }
    ],
    client: "codex",
    model: "test-model",
    effort: null
  };
  const preview = {
    title: "Test the release",
    projectName: "Release",
    request: { text: "Run the focused tests.", occurredAt: capturedAt },
    reply: null
  };
  const calls: unknown[] = [];
  let accountKey = `${status}:`;
  let onSummary = () => {};
  let onDisconnect = () => {};
  let beforeResponse = () => {};
  let denied = false;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push([
      request.method,
      request.url,
      request.headers.authorization,
      Buffer.concat(chunks).toString()
    ]);
    beforeResponse();
    if (denied) response.writeHead(403);
    if (request.method === "GET") {
      response.end(
        JSON.stringify({
          conversations: calls.length === 2 ? ["bad"] : [conversation],
          overflowCount: 0
        })
      );
    } else if (request.url?.endsWith("/preview")) {
      response.end(JSON.stringify(preview));
    } else if (request.url?.endsWith("/summary/latest")) {
      response.end(JSON.stringify({ action: "project" }));
    } else if (request.url?.endsWith("/summary/open")) {
      response.end(JSON.stringify({ action: "project", result: answer }));
    } else if (calls.length === 4) {
      response.on("close", onDisconnect);
      onSummary();
    } else {
      response.end(JSON.stringify(answer));
    }
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => response.destroy());
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No HTTP address");
    mkdirSync(join(koedHome, "run"));
    const path = join(koedHome, "run", "local-ai-runtime.json");
    const registration = {
      protocolVersion: 1,
      url: `http://127.0.0.1:${address.port}`,
      authorization,
      pid: process.pid,
      startedAt: new Date().toISOString()
    };
    writeFileSync(path, JSON.stringify(registration), { mode: 0o600 });
    const runtime = createFloatingKinRuntime({
      koedHome,
      lifecycle: () => "running",
      accountKey: () => accountKey
    });
    expect(await runtime.activity()).toEqual({
      state: "running",
      conversations: [conversation],
      overflowCount: 0
    });
    expect(await runtime.activity()).toEqual({ state: "unavailable" });
    expect(
      await runtime.summarize(input, new AbortController().signal)
    ).toEqual(answer);
    expect(calls.slice(0, 3)).toEqual([
      ["GET", "/v1/desktop/floating-kin/activity", authorization, ""],
      ["GET", "/v1/desktop/floating-kin/activity", authorization, ""],
      [
        "POST",
        "/v1/desktop/floating-kin/summary",
        authorization,
        JSON.stringify(input)
      ]
    ]);
    const started = new Promise<void>((resolve) => {
      onSummary = resolve;
    });
    const disconnected = new Promise<void>((resolve) => {
      onDisconnect = resolve;
    });
    const abort = new AbortController();
    const summary = runtime.summarize(input, abort.signal);
    await started;
    abort.abort();
    expect(await summary).toEqual({ status: "cancelled" });
    await disconnected;

    const target = { sessionId: input.sessionId, projectId: input.projectId };
    const signal = new AbortController().signal;
    expect(await runtime.latest(target, signal)).toEqual({ action: "project" });
    expect(await runtime.reopen(target, signal)).toEqual({
      action: "project",
      result: answer
    });
    expect(calls.slice(-2)).toEqual([
      [
        "POST",
        "/v1/desktop/floating-kin/summary/latest",
        authorization,
        JSON.stringify(target)
      ],
      [
        "POST",
        "/v1/desktop/floating-kin/summary/open",
        authorization,
        JSON.stringify(target)
      ]
    ]);

    const previewInput = { sessionId: input.sessionId };
    expect(await runtime.preview(previewInput, signal)).toEqual(preview);
    expect(calls.at(-1)).toEqual([
      "POST",
      "/v1/desktop/floating-kin/preview",
      authorization,
      JSON.stringify(previewInput)
    ]);

    denied = true;
    expect(await runtime.latest(target, signal)).toEqual({ action: null });
    expect(await runtime.reopen(target, signal)).toBeNull();
    expect(await runtime.preview(previewInput, signal)).toBeNull();
    expect(await runtime.activity()).toEqual({ state: "unavailable" });
    expect(
      await runtime.summarize(input, new AbortController().signal)
    ).toEqual({ status: "unavailable" });
    denied = false;

    beforeResponse = () => {
      accountKey = "signed_in:changed-user";
    };
    expect(await runtime.preview(previewInput, signal)).toBeNull();
    accountKey = `${status}:`;
    expect(await runtime.reopen(target, signal)).toBeNull();
    beforeResponse = () => {
      accountKey = "signed_in:first-user";
    };
    expect(await runtime.activity()).toEqual({ state: "unavailable" });
    beforeResponse = () => {
      accountKey = "signed_in:second-user";
    };
    expect(
      await runtime.summarize(input, new AbortController().signal)
    ).toEqual({ status: "unavailable" });

    accountKey = `${status}:`;
    writeFileSync(
      path,
      JSON.stringify({ ...registration, url: "https://example.com:1234" })
    );
    expect(await runtime.activity()).toEqual({ state: "unavailable" });
    expect(calls).toHaveLength(16);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(koedHome, { recursive: true, force: true });
  }
});
