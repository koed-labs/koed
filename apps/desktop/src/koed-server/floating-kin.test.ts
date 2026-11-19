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

it("does not contact the runtime while stopped, starting or signed out", async () => {
  let lifecycle: "stopped" | "starting" | "running" = "stopped";
  let accountStatus: "signed_in" | "signed_out" = "signed_in";
  const runtime = createFloatingKinRuntime({
    koedHome: "/missing",
    lifecycle: () => lifecycle,
    accountStatus: () => accountStatus
  });
  expect(await runtime.activity()).toEqual({ state: "stopped" });
  lifecycle = "starting";
  expect(await runtime.activity()).toEqual({ state: "starting" });
  lifecycle = "running";
  accountStatus = "signed_out";
  expect(await runtime.activity()).toEqual({ state: "signed_out" });
});

it("authenticates both fixed routes, propagates cancellation, and rejects unsafe registration or payloads", async () => {
  const koedHome = mkdtempSync(join(tmpdir(), "koed-floating-kin-"));
  const authorization = `Bearer ${"a".repeat(32)}`;
  const input = {
    sessionId: "803c2792-c18b-4484-a699-b33c7d8a7576",
    action: "project" as const,
    projectId: "d861e091-bbd9-45c3-9907-463cb3c42744"
  };
  const calls: unknown[] = [];
  let onSummary = () => {};
  let onDisconnect = () => {};
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push([
      request.method,
      request.url,
      request.headers.authorization,
      Buffer.concat(chunks).toString()
    ]);
    if (request.method === "GET") {
      response.end(
        JSON.stringify(
          calls.length === 1
            ? { conversations: [], overflowCount: 0 }
            : { conversations: ["bad"], overflowCount: 0 }
        )
      );
    } else if (calls.length === 3) {
      response.end(JSON.stringify({ status: "no_evidence" }));
    } else {
      response.on("close", onDisconnect);
      onSummary();
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
      accountStatus: () => "signed_in"
    });
    expect(await runtime.activity()).toEqual({
      state: "running",
      conversations: [],
      overflowCount: 0
    });
    expect(await runtime.activity()).toEqual({ state: "unavailable" });
    expect(
      await runtime.summarize(input, new AbortController().signal)
    ).toEqual({ status: "no_evidence" });
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
    writeFileSync(
      path,
      JSON.stringify({ ...registration, url: "https://example.com:1234" })
    );
    expect(await runtime.activity()).toEqual({ state: "unavailable" });
    expect(calls).toHaveLength(4);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(koedHome, { recursive: true, force: true });
  }
});
