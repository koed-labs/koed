import { EventEmitter } from "node:events";
import http from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryAnswerTask } from "@koed/shared";
import { MemoryAnswerTaskRuntime } from "../src/memory-answer-task-runtime.js";
import type { MemoryAnswerTaskScheduler } from "../src/memory-answer-task-scheduler.js";
import type { LocalRuntimeCallerContext } from "../src/local-runtime-protocol.js";

const id = "7c07a3cc-5679-4df2-bb67-c86571df93c2";
const task = (version = 2, overrides = {}): MemoryAnswerTask =>
  ({
    id,
    version,
    status: "running",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides
  }) as MemoryAnswerTask;
const flush = async () => {
  for (let n = 0; n < 10; n++) await Promise.resolve();
};
function fixture(get: () => Promise<MemoryAnswerTask>, resume?: string) {
  let listener: ((task: MemoryAnswerTask) => void) | undefined;
  const unsubscribe = vi.fn();
  const cancel = vi.fn();
  const scheduler = {
    get: vi.fn(get),
    cancel,
    subscribe: vi.fn((_id: string, next: (task: MemoryAnswerTask) => void) => {
      listener = next;
      return unsubscribe;
    })
  };
  const response = Object.assign(new EventEmitter(), {
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    destroyed: false,
    writableEnded: false,
    end: vi.fn(() => {
      response.writableEnded = true;
      response.emit("close");
    })
  });
  const runtime = new MemoryAnswerTaskRuntime(
    scheduler as unknown as MemoryAnswerTaskScheduler,
    {}
  );
  const open = () =>
    runtime.handleResourceRoute(
      Object.assign(new http.IncomingMessage(new Socket()), {
        method: "GET",
        headers: { "last-event-id": resume }
      }),
      response as unknown as http.ServerResponse,
      new URL(`http://local/v1/tasks/${id}/events`),
      vi.fn()
    );
  return {
    scheduler,
    response,
    open,
    unsubscribe,
    publish: (current: MemoryAnswerTask) => listener?.(current)
  };
}
afterEach(() => vi.useRealTimers());
describe("canonical task acceptance", () => {
  const canonical = {
    query: "prior decision",
    response_detail: "answer_only",
    search_domain: "project",
    limit: 10,
    include_evidence: false
  };
  const admission = (allowed = true) => {
    const start = vi.fn<MemoryAnswerTaskScheduler["start"]>(async () =>
      task(1, { status: "accepted" })
    );
    const eligible = vi.fn<
      (
        input: Record<string, unknown>,
        caller: LocalRuntimeCallerContext
      ) => boolean
    >(() => allowed);
    const runtime = new MemoryAnswerTaskRuntime(
      { start } as unknown as MemoryAnswerTaskScheduler,
      { durableMemoryAnswerEligible: eligible }
    );
    return { runtime, start, eligible };
  };

  it.each(["pi", "claude"])(
    "normalizes query-only input before eligibility and scheduler acceptance for %s",
    async (clientName) => {
      const f = admission();
      const input = { query: "  prior decision  " };
      const caller: LocalRuntimeCallerContext = {
        cwd: "/owned/project",
        protocolVersion: "test-version",
        clientInfo: { name: clientName },
        clientCapabilities: { experimental: { marker: "original" } }
      };
      const accepted = await f.runtime.start({
        input,
        caller,
        invocationKey: "original-invocation"
      });
      expect(accepted.status).toBe("accepted");
      expect(f.eligible).toHaveBeenCalledExactlyOnceWith(canonical, caller);
      expect(f.start).toHaveBeenCalledExactlyOnceWith({
        origin: clientName === "pi" ? "pi_extension" : "mcp",
        invocationKey: "original-invocation",
        toolInput: canonical,
        caller
      });
      expect(f.eligible.mock.calls[0]?.[1]).toBe(caller);
      expect(f.start.mock.calls[0]?.[0].caller).toBe(caller);
      expect(input).toEqual({ query: "  prior decision  " });
    }
  );

  it("sends the same canonical request for implicit and explicit defaults without changing invocation identity", async () => {
    const f = admission();
    const caller = { cwd: "/owned/project" };
    const request = { caller, invocationKey: "retry-same-invocation" };
    await f.runtime.start({ ...request, input: { query: "prior decision" } });
    await f.runtime.start({ ...request, input: { ...canonical } });
    expect(f.start.mock.calls[0]).toEqual(f.start.mock.calls[1]);
  });

  it.each([
    {},
    { query: " " },
    { query: "PRIVATE_INVALID_QUERY", limit: 0 },
    { query: "prior decision", unexpected: "PRIVATE_VALUE" },
    { query: "prior decision", search_domain: "session" },
    { query: "prior decision", team_workspace_id: "invalid" },
    {
      query: "prior decision",
      recent_days: 1,
      source_after: "2026-01-01T00:00:00Z"
    }
  ])(
    "rejects invalid input %j with a static 400 before eligibility or acceptance",
    async (input) => {
      const f = admission();
      await expect(
        f.runtime.start({ input, caller: { cwd: "/owned/project" } })
      ).rejects.toMatchObject({
        message: "Invalid Memory Answer task input",
        statusCode: 400
      });
      expect(f.eligible).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
    }
  );

  it.each([
    { query: "prior decision" },
    { query: "prior decision", team_workspace_id: id }
  ])(
    "preserves authoritative Team rejection after normalization for %j",
    async (input) => {
      const f = admission(false);
      const caller = { cwd: "/owned/team-project" };
      await expect(f.runtime.start({ input, caller })).rejects.toMatchObject({
        statusCode: 409,
        message: "Team Workspace Memory Answer does not support detached tasks"
      });
      expect(f.eligible).toHaveBeenCalledExactlyOnceWith(
        { ...canonical, ...input },
        caller
      );
      expect(f.start).not.toHaveBeenCalled();
    }
  );
});
describe("authorized task observation", () => {
  it.each([401, 403, 404, 410])(
    "rejects status %s before SSE headers or subscription",
    async (status) => {
      const f = fixture(async () => {
        throw Object.assign(new Error("denied"), { status });
      });
      await expect(f.open()).rejects.toMatchObject({ status });
      expect(f.response.writeHead).not.toHaveBeenCalled();
      expect(f.scheduler.subscribe).not.toHaveBeenCalled();
    }
  );
  it("does not emit an admitted cached completion after revocation", async () => {
    let denied = false;
    const f = fixture(async () => {
      if (denied) throw Object.assign(new Error("revoked"), { status: 401 });
      return task();
    });
    await f.open();
    await flush();
    denied = true;
    f.publish(
      task(4, { status: "completed", result: { markdown: "PRIVATE_RESULT" } })
    );
    await flush();
    expect(f.response.write.mock.calls.flat().join("")).not.toContain(
      "PRIVATE_RESULT"
    );
    expect(f.response.end).toHaveBeenCalledOnce();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.scheduler.cancel).not.toHaveBeenCalled();
  });
  it("serializes delayed reads and suppresses regressing versions", async () => {
    let release!: (value: MemoryAnswerTask) => void;
    let calls = 0;
    const f = fixture(() => {
      calls++;
      if (calls === 1) return Promise.resolve(task(3));
      if (calls === 2)
        return new Promise((resolve) => {
          release = resolve;
        });
      return Promise.resolve(task(4, { status: "completed" }));
    });
    await f.open();
    f.publish(task(4));
    f.publish(task(4));
    expect(f.scheduler.get).toHaveBeenCalledTimes(2);
    release(task(2));
    await flush();
    const bytes = f.response.write.mock.calls.flat().join("");
    expect(
      [...bytes.matchAll(/id: (\d+)/g)].map((match) => Number(match[1]))
    ).toEqual([3, 4]);
    expect(f.scheduler.get).toHaveBeenCalledTimes(3);
  });
  it("rechecks authority before keepalive and ends retention without events", async () => {
    vi.useFakeTimers();
    let denied = false;
    const f = fixture(async () => {
      if (denied) throw new Error("denied");
      return task();
    });
    await f.open();
    await flush();
    denied = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.response.write.mock.calls.flat().join("")).not.toContain(
      "keepalive"
    );
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    const expiry = fixture(async () =>
      task(2, { expiresAt: new Date(Date.now() + 100).toISOString() })
    );
    await expiry.open();
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(expiry.response.end).toHaveBeenCalledOnce();
    expect(expiry.scheduler.cancel).not.toHaveBeenCalled();
  });
  it("honors Last-Event-ID and disconnects while a read is pending", async () => {
    let release!: (value: MemoryAnswerTask) => void;
    let calls = 0;
    const f = fixture(
      () =>
        ++calls === 1
          ? Promise.resolve(task(3))
          : new Promise((resolve) => {
              release = resolve;
            }),
      "3"
    );
    await f.open();
    expect(f.response.write).not.toHaveBeenCalled();
    f.response.emit("close");
    release(task(4, { status: "completed", result: { markdown: "LATE" } }));
    await flush();
    expect(f.response.write).not.toHaveBeenCalled();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.scheduler.cancel).not.toHaveBeenCalled();
  });
});
