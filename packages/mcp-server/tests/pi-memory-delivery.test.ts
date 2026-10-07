import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPiMemoryDelivery,
  COMPLETION,
  RECEIPT,
  DISPOSITION
} from "../integrations/pi/pi-memory-delivery.mjs";

interface Task {
  id: string;
  invocationKey: string | null;
  status: "running" | "completed";
  version: number;
  expiresAt: string;
  result?: { answer: string };
}
function fixture(
  options: { mode?: string; persistent?: boolean; incapable?: boolean } = {}
) {
  const entries: Array<{
    type: string;
    customType: string;
    data: Record<string, unknown>;
  }> = [];
  const manager = {
    getSessionId: () => "conversation-1",
    getSessionFile: () =>
      options.persistent === false ? undefined : "/tmp/pi-session.jsonl",
    getEntries: () => entries,
    getBranch: () => entries
  };
  const ctx = {
    cwd: "/generated",
    sessionManager: manager,
    ui: { notify: vi.fn() }
  };
  const pi = {
    appendEntry: vi.fn((customType: string, data: Record<string, unknown>) =>
      entries.push({ type: "custom", customType, data })
    ),
    sendMessage: vi.fn(
      (
        _message: {
          customType: string;
          content: string;
          display: boolean;
          details: Record<string, unknown>;
        },
        _options: { deliverAs: "followUp"; triggerTurn: true }
      ) => {
        void _message;
        void _options;
      }
    )
  };
  const tasks = new Map<string, Task>();
  const port = {
    scope: "/tmp/owned-koed",
    start: vi.fn(
      async (
        _input: Record<string, unknown>,
        _caller: unknown,
        invocationKey?: string
      ) => {
        const task: Task = {
          id: `task-${tasks.size}`,
          invocationKey: invocationKey ?? null,
          status: "running",
          version: 1,
          expiresAt: new Date(Date.now() + 60000).toISOString()
        };
        tasks.set(task.id, task);
        return task;
      }
    ),
    get: vi.fn(async (id: string) => tasks.get(id)!),
    cancel: vi.fn()
  };
  const blocking = vi.fn(async () => ({ answer: "blocking" }));
  const delivery = createPiMemoryDelivery(options.incapable ? {} : pi, {
    port,
    blocking,
    mode: options.mode,
    pollMs: 25,
    retryMs: 1
  });
  delivery.start({ reason: "startup" }, ctx);
  const complete = () => {
    for (const t of tasks.values()) {
      t.status = "completed";
      t.version++;
      t.result = { answer: `answer ${t.id}` };
    }
  };
  return { entries, ctx, pi, tasks, port, blocking, delivery, complete };
}

afterEach(() => vi.useRealTimers());

describe("supported Pi Memory Answer delivery", () => {
  it("keeps a throttled receipt pending and automatically delivers after the fresh read", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.port.get.mockRejectedValueOnce(
      Object.assign(new Error("quota-private"), {
        statusCode: 429,
        retryAfterMs: 1000
      })
    );
    await f.delivery.execute("call", { query: "q" }, undefined, f.ctx);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.delivery.pending.size).toBe(1);
    expect(f.ctx.ui.notify).not.toHaveBeenCalled();
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    f.complete();
    await vi.advanceTimersByTimeAsync(1);
    await f.delivery.settle();
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.port.start).toHaveBeenCalledTimes(1);
    expect(f.port.cancel).not.toHaveBeenCalled();
  });

  it("acknowledges promptly, polls outside the model, and sends attributed automatic followUp", async () => {
    const f = fixture();
    const receipt = await f.delivery.execute(
      "call-1",
      { query: "generated question" },
      undefined,
      f.ctx
    );
    expect(receipt.details.accepted).toBe(true);
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    expect(f.port.start).toHaveBeenCalledTimes(1);
    expect(f.port.start.mock.calls[0]![1]).toMatchObject({
      clientInfo: {
        deliveryOrigin: {
          conversation: "conversation-1",
          invocation: "conversation-1:call-1"
        }
      }
    });
    f.complete();
    await f.delivery.settle();
    expect(f.port.get.mock.calls.length).toBeGreaterThanOrEqual(2);
    const [message, options] = f.pi.sendMessage.mock.calls[0]!;
    expect(message.customType).toBe(COMPLETION);
    expect(message.details).toMatchObject({
      taskId: "task-0",
      query: "generated question",
      invocation: "conversation-1:call-1"
    });
    expect(options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(f.entries.some((e) => e.customType === DISPOSITION)).toBe(true);
  });
  it.each([{ mode: "blocking" }, { persistent: false }, { incapable: true }])(
    "retains blocking for unsupported mode/capabilities: %j",
    async (options) => {
      const f = fixture(options);
      expect(
        (
          await f.delivery.execute(
            "call",
            { query: "question" },
            undefined,
            f.ctx
          )
        ).details.answer
      ).toBe("blocking");
      expect(f.port.start).not.toHaveBeenCalled();
      f.delivery.detach();
    }
  );
  it("Team input and authoritative 409 use blocking without a detached Team task", async () => {
    const f = fixture();
    await f.delivery.execute(
      "call",
      { query: "q", team_workspace_id: "team" },
      undefined,
      f.ctx
    );
    expect(f.port.start).not.toHaveBeenCalled();
    f.port.start.mockRejectedValueOnce(
      Object.assign(new Error("ineligible"), { statusCode: 409 })
    );
    await f.delivery.execute("call-2", { query: "q" }, undefined, f.ctx);
    expect(f.blocking).toHaveBeenCalledTimes(2);
    expect(f.entries).toHaveLength(0);
  });
  it("resume recovers pending receipts and already-enqueued results never repeat", async () => {
    const f = fixture();
    await f.delivery.execute("call", { query: "q" }, undefined, f.ctx);
    f.delivery.detach();
    f.complete();
    f.delivery.start({ reason: "resume" }, f.ctx);
    await f.delivery.settle();
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
    f.delivery.start({ reason: "reload" }, f.ctx);
    await f.delivery.settle();
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.port.cancel).not.toHaveBeenCalled();
  });
  it("fork, switches and invalidated branches suppress late results without cancelling execution", async () => {
    const f = fixture();
    await f.delivery.execute("call", { query: "q" }, undefined, f.ctx);
    f.delivery.detach(true);
    f.complete();
    f.delivery.start({ reason: "fork" }, f.ctx);
    await f.delivery.settle();
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    f.delivery.start({ reason: "resume" }, f.ctx);
    await f.delivery.settle();
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    expect(f.port.cancel).not.toHaveBeenCalled();
  });
  it.each([401, 403])(
    "ends Pi observation on fatal authorization HTTP %s",
    async (statusCode) => {
      const f = fixture();
      f.port.get.mockRejectedValueOnce(
        Object.assign(new Error("private denial"), { statusCode })
      );
      await f.delivery.execute("call", { query: "q" }, undefined, f.ctx);
      await f.delivery.settle();
      expect(f.delivery.pending.size).toBe(0);
      expect(f.port.get).toHaveBeenCalledTimes(1);
      expect(f.port.start).toHaveBeenCalledTimes(1);
      expect(f.pi.sendMessage).not.toHaveBeenCalled();
      expect(f.ctx.ui.notify).toHaveBeenCalledTimes(1);
      expect(f.port.cancel).not.toHaveBeenCalled();
    }
  );

  it("revocation on the final authorized read prevents cached answer delivery", async () => {
    const f = fixture();
    f.port.get.mockImplementationOnce(async (id) => {
      const task = f.tasks.get(id);
      if (!task) throw new Error("Expected accepted fixture task");
      return {
        ...task,
        status: "completed",
        version: 2,
        result: { answer: "secret" }
      };
    });
    f.port.get.mockRejectedValueOnce(
      Object.assign(new Error("private provider text"), { statusCode: 403 })
    );
    await f.delivery.execute("call", { query: "q" }, undefined, f.ctx);
    await f.delivery.settle();
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    expect(f.ctx.ui.notify.mock.calls.flat().join(" ")).not.toContain(
      "private provider text"
    );
  });
  it("transient disconnection retries through fresh port reads", async () => {
    const f = fixture();
    f.port.get.mockRejectedValueOnce(new Error("connection reset"));
    await f.delivery.execute("call", { query: "q" }, undefined, f.ctx);
    f.complete();
    await f.delivery.settle();
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  });
  it("concurrent recalls retain their own query, invocation and task", async () => {
    const f = fixture();
    await Promise.all([
      f.delivery.execute("a", { query: "alpha" }, undefined, f.ctx),
      f.delivery.execute("b", { query: "beta" }, undefined, f.ctx)
    ]);
    f.complete();
    await f.delivery.settle();
    expect(
      f.pi.sendMessage.mock.calls.map(([m]) => m.details.query).sort()
    ).toEqual(["alpha", "beta"]);
  });
  it.each([
    { query: "altered" },
    { expiresAt: "2000-01-01T00:00:00.000Z" },
    { scope: "/tmp/foreign-koed" },
    { conversation: "foreign-conversation" }
  ])(
    "does not recover malformed, expired or foreign receipts: %j",
    async (change) => {
      const f = fixture();
      await f.delivery.execute("call", { query: "q" }, undefined, f.ctx);
      f.delivery.detach();
      f.complete();
      Object.assign(
        f.entries.find((e) => e.customType === RECEIPT)!.data,
        change
      );
      f.delivery.start({ reason: "resume" }, f.ctx);
      await f.delivery.settle();
      expect(f.pi.sendMessage).not.toHaveBeenCalled();
    }
  );
  it("tree commit invalidates the outgoing observer even when its receipt is no longer on the current branch", async () => {
    const f = fixture();
    await f.delivery.execute("call", { query: "q" }, undefined, f.ctx);
    const outgoing = f.entries.find((e) => e.customType === RECEIPT)!;
    f.ctx.sessionManager.getBranch = () =>
      f.entries.filter((e) => e !== outgoing);
    f.delivery.detach(true);
    f.complete();
    f.ctx.sessionManager.getBranch = () => f.entries;
    f.delivery.start({ reason: "resume" }, f.ctx);
    await f.delivery.settle();
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    expect(
      f.entries.some(
        (e) =>
          e.customType === DISPOSITION && e.data.taskId === outgoing.data.taskId
      )
    ).toBe(true);
  });

  it("invalidates off-branch receipts after stale observers finish during an earlier asynchronous tree handler", async () => {
    const f = fixture();
    await f.delivery.execute("call", { query: "q" }, undefined, f.ctx);
    const outgoing = f.entries.find((e) => e.customType === RECEIPT)!;
    f.ctx.sessionManager.getBranch = () =>
      f.entries.filter((e) => e !== outgoing);
    f.complete();
    await f.delivery.settle();
    expect(f.delivery.pending.size).toBe(0);
    expect(f.entries.some((e) => e.customType === DISPOSITION)).toBe(false);
    f.delivery.detach(true);
    f.ctx.sessionManager.getBranch = () => f.entries;
    f.delivery.start({ reason: "resume" }, f.ctx);
    await f.delivery.settle();
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    expect(
      f.entries.some(
        (e) =>
          e.customType === DISPOSITION && e.data.taskId === outgoing.data.taskId
      )
    ).toBe(true);
  });

  it("rejects an invocation reused with a different query before new acceptance", async () => {
    const f = fixture();
    await f.delivery.execute(
      "same-call",
      { query: "original" },
      undefined,
      f.ctx
    );
    await expect(
      f.delivery.execute("same-call", { query: "changed" }, undefined, f.ctx)
    ).rejects.toThrow("recorded query");
    expect(f.port.start).toHaveBeenCalledTimes(1);
    f.delivery.detach();
  });
  it("bounds active observers to 128 and uses blocking at admission capacity", async () => {
    const f = fixture();
    for (let i = 0; i < 128; i++)
      await f.delivery.execute(
        `call-${i}`,
        { query: `generated ${i}` },
        undefined,
        f.ctx
      );
    expect(f.delivery.pending.size).toBe(128);
    const last = await f.delivery.execute(
      "overflow",
      { query: "generated overflow" },
      undefined,
      f.ctx
    );
    expect(last.details.answer).toBe("blocking");
    expect(f.port.start).toHaveBeenCalledTimes(128);
    f.delivery.detach();
  });
  it("reserves observer capacity before asynchronous acceptance and rejects changed query at capacity", async () => {
    const f = fixture();
    for (let i = 0; i < 127; i++)
      await f.delivery.execute(
        `call-${i}`,
        { query: `generated ${i}` },
        undefined,
        f.ctx
      );
    let accept!: (task: Task) => void;
    f.port.start.mockImplementationOnce(
      async () =>
        await new Promise<Task>((resolve) => {
          accept = resolve;
        })
    );
    const pendingAccept = f.delivery.execute(
      "reserved",
      { query: "generated reservation" },
      undefined,
      f.ctx
    );
    const overflow = await f.delivery.execute(
      "overflow",
      { query: "generated overflow" },
      undefined,
      f.ctx
    );
    expect(overflow.details.answer).toBe("blocking");
    expect(f.port.start).toHaveBeenCalledTimes(128);
    await expect(
      f.delivery.execute(
        "call-0",
        { query: "changed at capacity" },
        undefined,
        f.ctx
      )
    ).rejects.toThrow("recorded query");
    const task: Task = {
      id: "task-127",
      invocationKey: "conversation-1:reserved",
      status: "running",
      version: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString()
    };
    f.tasks.set(task.id, task);
    accept(task);
    await pendingAccept;
    expect(f.delivery.pending.size).toBe(128);
    f.delivery.detach();
  });
});
