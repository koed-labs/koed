import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createFloatingKinRuntime } from "./floating-kin.js";

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

    denied = true;
    expect(await runtime.activity()).toEqual({ state: "unavailable" });
    expect(
      await runtime.summarize(input, new AbortController().signal)
    ).toEqual({ status: "unavailable" });
    denied = false;

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
    expect(calls).toHaveLength(8);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(koedHome, { recursive: true, force: true });
  }
});
