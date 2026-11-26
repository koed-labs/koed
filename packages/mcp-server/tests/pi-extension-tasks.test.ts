import {
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
const taskId = "ae4e3f31-7300-49b9-ab81-a4df03d9bdd7";
const task = (status: string, extra = {}) => ({
  id: taskId,
  status,
  version: 1,
  invocationKey: "session-a:call-1",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...extra
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.KOED_HOME;
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
});

type Tool = {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    update: unknown,
    ctx: unknown
  ) => Promise<{
    content: { text: string }[];
    details: Record<string, unknown>;
  }>;
};

type LifecycleContext = {
  cwd: string;
  sessionManager: {
    getSessionFile: () => string | undefined;
    getSessionId: () => string;
  };
  ui: { notify: () => void };
};
type Handler = (event: { reason?: string }, ctx: LifecycleContext) => unknown;

const setup = async () => {
  const home = mkdtempSync(join(tmpdir(), "koed-pi-tasks-"));
  roots.push(home);
  process.env.KOED_HOME = home;
  mkdirSync(join(home, "run"));
  writeFileSync(
    join(home, "run", "local-ai-runtime.json"),
    JSON.stringify({
      url: "http://127.0.0.1:32123",
      protocolVersion: 1,
      authorization: `Bearer ${"a".repeat(32)}`,
      pid: 123,
      startedAt: new Date().toISOString()
    }),
    { mode: 0o600 }
  );
  // Pi supplies TypeBox. A schema-only stand-in lets the standalone extension
  // run here without installing the Pi SDK in the server workspace.
  const extensionUrl = new URL(
    "../integrations/pi/extensions/koed.mjs",
    import.meta.url
  );
  const source = readFileSync(extensionUrl, "utf8")
    .replace(
      'import { Type } from "typebox";',
      "const Type = new Proxy({}, { get: (_, type) => (...args) => ({ type, args }) });"
    )
    .replace(
      /from "(\.\.\/[^"]+)"/g,
      (_match, path: string) =>
        `from ${JSON.stringify(new URL(path, extensionUrl).href)}`
    );
  const extension = (await import(
    /* @vite-ignore */
    `data:text/javascript;base64,${Buffer.from(`${source}\n// ${home}`).toString("base64")}`
  )) as {
    default: (pi: {
      registerTool: (tool: Tool & { name: string }) => unknown;
      on: (name: string, handler: Handler) => unknown;
    }) => void;
  };
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler>();
  extension.default({
    registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
    on: (name, handler) => handlers.set(name, handler)
  });
  const invoke = (
    name: string,
    params: Record<string, unknown>,
    session = "session-a",
    signal = new AbortController().signal,
    cwd = "/work/project"
  ) =>
    tools.get(name)!.execute("call-1", params, signal, undefined, {
      cwd,
      sessionManager: { getSessionId: () => session }
    });
  return { invoke, tools, handlers, home };
};

const livenessSetup = async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
  const { handlers, home } = await setup();
  let sessionId = "session-a";
  let sessionFile: string | undefined = join(home, "private-transcript.jsonl");
  const ctx = {
    cwd: "/private/project",
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionId
    },
    ui: { notify: vi.fn() }
  };
  const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
    void url;
    void init;
    return Response.json({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  const livenessCalls = () =>
    fetchMock.mock.calls.filter(
      ([url]) => url.pathname === "/v1/capture/pi-liveness"
    );
  return {
    emit: (name: string) => handlers.get(name)?.({}, ctx),
    setSession: (id: string, file: string | undefined) => {
      sessionId = id;
      sessionFile = file;
    },
    handlers,
    wakePath: join(home, "run", "pi-transcript-watcher.wake"),
    fetchMock,
    livenessCalls,
    payloads: (): Array<Record<string, unknown>> =>
      livenessCalls().map(
        ([, init]) => JSON.parse(String(init.body)) as Record<string, unknown>
      )
  };
};

describe("Pi metadata-only liveness", () => {
  it("sends exact metadata on start and renews every five seconds without waking transcript capture", async () => {
    const { emit, handlers, livenessCalls, payloads, wakePath } =
      await livenessSetup();
    const startedAt = Date.now();
    expect(emit("agent_start")).toBeUndefined();
    emit("agent_start");
    expect(handlers.has("agent_end")).toBe(false);
    expect(existsSync(wakePath)).toBe(false);
    await expect.poll(() => livenessCalls().length).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(livenessCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect.poll(() => livenessCalls().length).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect.poll(() => livenessCalls().length).toBe(3);
    const publisherId = payloads()[0]?.publisherId;
    expect(publisherId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(payloads()).toEqual(
      [0, 5_000, 10_000].map((offset, index) => ({
        externalSessionId: "session-a",
        publisherId,
        sequence: index + 1,
        observedAt: startedAt + offset,
        working: true
      }))
    );
    expect(livenessCalls()[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { authorization: `Bearer ${"a".repeat(32)}` }
    });
    expect(existsSync(wakePath)).toBe(false);
  });

  it("aborts an in-flight start on quick settlement and preserves the transcript wake", async () => {
    const { emit, fetchMock, livenessCalls, payloads, wakePath } =
      await livenessSetup();
    fetchMock.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(Response.json({ ok: true })), 100);
        })
    );
    emit("agent_start");
    await expect.poll(() => livenessCalls().length).toBe(1);
    emit("agent_settled");
    expect(livenessCalls()[0]?.[1].signal?.aborted).toBe(true);
    expect(existsSync(wakePath)).toBe(true);
    await expect.poll(() => livenessCalls().length).toBe(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(payloads()).toMatchObject([
      { sequence: 1, working: true },
      { sequence: 2, working: false }
    ]);
  });

  it("does not send a working update if Pi settles before registration is read", async () => {
    const { emit, livenessCalls, payloads, wakePath } = await livenessSetup();
    emit("agent_start");
    emit("agent_settled");
    expect(existsSync(wakePath)).toBe(true);
    await expect.poll(() => livenessCalls().length).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(payloads()).toMatchObject([{ sequence: 2, working: false }]);
  });

  it("does not publish for ephemeral sessions or overlong session IDs", async () => {
    const { emit, setSession, payloads, wakePath } = await livenessSetup();
    setSession("session-a", undefined);
    emit("agent_start");
    emit("agent_settled");
    expect(existsSync(wakePath)).toBe(false);
    setSession("a".repeat(1025), "/private/transcript.jsonl");
    emit("agent_start");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(payloads()).toEqual([]);
  });

  it.each(["session_start", "session_tree", "session_shutdown"])(
    "clears the lease and stops renewals on %s",
    async (event) => {
      const { emit, fetchMock, livenessCalls, payloads } =
        await livenessSetup();
      fetchMock.mockImplementation(async (url, init) =>
        url.pathname === "/v1/capture/pi-liveness"
          ? new Promise((_resolve, reject) => {
              init.signal?.addEventListener(
                "abort",
                () => reject(init.signal?.reason),
                { once: true }
              );
            })
          : Response.json({ ok: true })
      );
      emit("agent_start");
      await expect.poll(() => livenessCalls().length).toBe(1);
      await emit(event);
      expect(livenessCalls()[0]?.[1].signal?.aborted).toBe(true);
      await expect.poll(() => livenessCalls().length).toBe(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(payloads()).toMatchObject([
        { sequence: 1, working: true },
        { sequence: 2, working: false }
      ]);
    }
  );

  it("drops the old heartbeat when the current session changes", async () => {
    const { emit, setSession, payloads, livenessCalls } = await livenessSetup();
    emit("agent_start");
    await expect.poll(() => livenessCalls().length).toBe(1);
    setSession("session-b", "/private/other-transcript.jsonl");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect.poll(() => livenessCalls().length).toBe(2);
    emit("agent_start");
    await expect.poll(() => livenessCalls().length).toBe(3);
    expect(payloads()).toMatchObject([
      { externalSessionId: "session-a", sequence: 1, working: true },
      { externalSessionId: "session-a", sequence: 2, working: false },
      { externalSessionId: "session-b", sequence: 3, working: true }
    ]);
  });

  it("times out stalled sends and retries only at the next heartbeat", async () => {
    const { emit, fetchMock, livenessCalls, payloads } = await livenessSetup();
    fetchMock.mockImplementationOnce(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true }
          );
        })
    );
    emit("agent_start");
    await expect.poll(() => livenessCalls().length).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(livenessCalls()).toHaveLength(1);
    expect(livenessCalls()[0]?.[1].signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect.poll(() => livenessCalls().length).toBe(2);
    expect(payloads()).toMatchObject([
      { sequence: 1, working: true },
      { sequence: 2, working: true }
    ]);
  });
});

describe("Pi explicit Memory Answer tasks", () => {
  it.each(["blocking", "non_blocking"])(
    "uses each Pi Conversation directory for %s recall, including concurrent sessions",
    async (delivery_mode) => {
      const requests: Array<{
        caller: {
          cwd: string;
          conversation: { externalSessionId: string; sourceRuntime: string };
        };
        input: Record<string, unknown>;
      }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, init: RequestInit) => {
          requests.push(
            JSON.parse(String(init.body)) as (typeof requests)[number]
          );
          return new Response(
            JSON.stringify(
              delivery_mode === "non_blocking"
                ? { task: task("accepted") }
                : { markdown: "Answer" }
            )
          );
        })
      );
      const { invoke } = await setup();
      await Promise.all(
        ["/work/shared", "/work/shared"].map((cwd, index) =>
          invoke(
            "memory_answer",
            { query: `session-${index}`, delivery_mode },
            `session-${index}`,
            new AbortController().signal,
            cwd
          )
        )
      );
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.caller.cwd).toBe("/work/shared");
        expect(request.caller.conversation).toEqual({
          externalSessionId: request.input.query,
          sourceRuntime: "pi"
        });
      }
    }
  );
  it("submits promptly, collects pending, and freshly collects compact completion across sessions", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      void url;
      return new Response(
        JSON.stringify({
          task: task("accepted", {
            caller: { secret: "private" },
            result: { evidence: "private" }
          })
        })
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { invoke } = await setup();
    const receipt = await invoke("memory_answer", {
      query: "prior decision",
      delivery_mode: "non_blocking"
    });
    expect(receipt.details).toMatchObject({
      status: "pending",
      task_id: taskId
    });
    expect(JSON.stringify(receipt)).not.toContain("private");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/v1/tasks/memory-answer"
    );
    const pending = await invoke("memory_answer_result", { task_id: taskId });
    expect(pending.details.status).toBe("pending");
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            task: task("completed", {
              result: {
                markdown: "The retained answer.",
                localMemoryWorker: { displayMessage: "private" }
              },
              lastErrorMessage: "private"
            })
          })
        )
    );
    const collected = await invoke(
      "memory_answer_result",
      { task_id: taskId },
      "session-b"
    );
    expect(collected.content[0]?.text).toContain("The retained answer.");
    expect(collected.details.status).toBe("completed");
    expect(JSON.stringify(collected)).not.toContain("private");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, "auto", "blocking"])(
    "keeps %s delivery blocking",
    async (mode) => {
      let finish!: (value: Response) => void;
      const fetchMock = vi.fn((url: unknown) => {
        void url;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const { invoke } = await setup();
      let settled = false;
      const result = invoke("memory_answer", {
        query: "answer",
        ...(mode ? { delivery_mode: mode } : {})
      }).finally(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
        "/v1/tools/memory_answer"
      );
      finish(new Response(JSON.stringify({ markdown: "Answer" })));
      const completed = await result;
      expect(completed.details).toEqual({ markdown: "Answer" });
      expect(completed.content[0]?.text).toContain(
        "<koed-memory-answer>\nAnswer\n</koed-memory-answer>"
      );
    }
  );

  it("cancels with sanitized status and rejects invalid or expired tasks", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            task: task("cancel_requested", {
              result: { markdown: "private" },
              lastErrorMessage: "private"
            })
          })
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const { invoke } = await setup();
    const cancellation = await invoke("memory_answer_cancel", {
      task_id: taskId
    });
    expect(cancellation.details).toMatchObject({
      status: "cancel_requested",
      task_id: taskId
    });
    expect(JSON.stringify(cancellation)).not.toContain("private");
    await expect(
      invoke("memory_answer_result", { task_id: "not-a-uuid" })
    ).rejects.toThrow("Koed unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            task: task("completed", {
              expiresAt: "2000-01-01T00:00:00Z",
              result: { markdown: "private" }
            })
          })
        )
    );
    await expect(
      invoke("memory_answer_result", { task_id: taskId })
    ).rejects.toThrow("Koed unavailable");
  });

  it.each(["failed", "cancelled"])(
    "collects sanitized %s status",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                task: task(status, {
                  lastErrorMessage: "private",
                  result: { markdown: "private" }
                })
              })
            )
        )
      );
      const { invoke } = await setup();
      const collected = await invoke("memory_answer_result", {
        task_id: taskId
      });
      expect(collected.details.status).toBe(status);
      expect(JSON.stringify(collected)).not.toContain("private");
    }
  );

  it.each([
    [{}, false, false],
    [{ response_detail: "answer_only" }, false, false],
    [{ response_detail: "with_citations" }, true, false],
    [{ response_detail: "with_evidence" }, true, true],
    [{ include_evidence: true }, true, true],
    [{ response_detail: "answer_only", include_evidence: true }, true, true]
  ] as const)(
    "matches blocking detail %j after collection from another session",
    async (input, withCitations, withEvidence) => {
      const result = {
        markdown: "The retained answer.",
        ...(withCitations ? { citations: [{ sourceId: "source-a" }] } : {}),
        ...(withEvidence ? { evidence: [{ summaryText: "Source body" }] } : {}),
        localMemoryWorker: { jobId: "INTERNAL JOB", tokenUsage: 1234 }
      };
      const fetchMock = vi.fn(
        async (url: unknown) =>
          new Response(
            JSON.stringify(
              String(url).includes("/v1/tools/")
                ? result
                : {
                    task: task(
                      String(url).includes(`/v1/tasks/${taskId}`)
                        ? "completed"
                        : "accepted",
                      {
                        result,
                        lastErrorMessage: "INTERNAL FAILURE"
                      }
                    )
                  }
            )
          )
      );
      vi.stubGlobal("fetch", fetchMock);
      const { invoke } = await setup();
      const receipt = await invoke("memory_answer", {
        query: "answer",
        delivery_mode: "non_blocking",
        ...input
      });
      expect(receipt.details).toMatchObject({
        status: "pending",
        task_id: taskId
      });
      expect(JSON.stringify(receipt)).not.toMatch(
        /retained answer|Source body|INTERNAL/
      );
      const submitInit = (
        fetchMock.mock.calls[0] as unknown as [unknown, RequestInit]
      )[1];
      const submitted = JSON.parse(String(submitInit.body)) as {
        input: Record<string, unknown>;
      };
      expect(submitted.input).toMatchObject(input);
      const collected = await invoke(
        "memory_answer_result",
        { task_id: taskId },
        "session-b"
      );
      expect(
        await invoke("memory_answer_result", { task_id: taskId }, "session-c")
      ).toEqual(collected);
      const blocking = await invoke("memory_answer", {
        query: "answer",
        delivery_mode: "blocking",
        ...input
      });
      expect(collected.content).toEqual(blocking.content);
      const text = collected.content[0]!.text;
      expect(text.includes("source-a")).toBe(withCitations);
      expect(text.includes("Source body")).toBe(withEvidence);
      expect(JSON.stringify(collected)).not.toContain("INTERNAL");
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).endsWith("/v1/tasks/memory-answer")
        )
      ).toHaveLength(1);
    }
  );

  it("sanitizes submission failures without leaking exception causes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("private provider credentials");
      })
    );
    const { invoke } = await setup();
    const error = await invoke("memory_answer", {
      query: "answer",
      delivery_mode: "non_blocking"
    }).catch((cause: Error) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Acceptance may be uncertain");
    expect(String(error)).not.toContain("private");
    expect(error).not.toHaveProperty("cause");
  });

  it("reports a queue-full rejection as definitive with its retry delay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "private queue detail",
              retryAfterMs: 5000
            }),
            { status: 429 }
          )
      )
    );
    const { invoke } = await setup();
    const error = await invoke("memory_answer", {
      query: "answer",
      delivery_mode: "non_blocking"
    }).catch((cause: Error) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("no task was created");
    expect(String(error)).toContain("after 5000 ms");
    expect(String(error)).not.toContain("uncertain");
    expect(String(error)).not.toContain("private");
    expect(error).toMatchObject({ statusCode: 429, retryAfterMs: 5000 });
    expect(error).not.toHaveProperty("cause");
  });

  it.each([408, 503])(
    "keeps HTTP %i submission failures ambiguous",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error: "private" }), { status })
        )
      );
      const { invoke } = await setup();
      const error = await invoke("memory_answer", {
        query: "answer",
        delivery_mode: "non_blocking"
      }).catch((cause: Error) => cause);
      expect(String(error)).toContain("Acceptance may be uncertain");
      expect(String(error)).not.toContain("private");
    }
  );

  it("waits beyond 30 seconds for a delayed result without submitting another recall", async () => {
    let completed = false;
    const fetchMock = vi.fn(async (url: unknown) => {
      expect(String(url)).toContain(`/v1/tasks/${taskId}`);
      return new Response(
        JSON.stringify({
          task: task(completed ? "completed" : "running", {
            result: completed ? { markdown: "Delayed answer" } : undefined
          })
        })
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { invoke } = await setup();
    vi.useFakeTimers();
    let settled = false;
    const result = invoke("memory_answer_result", {
      task_id: taskId,
      wait: true
    }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(settled).toBe(false);
    completed = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect((await result).content[0]?.text).toContain("Delayed answer");
  });

  it("stops collection on disconnect without cancelling recall and validates wait", async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toContain(`/v1/tasks/${taskId}`);
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify({ task: task("running") }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { invoke } = await setup();
    await expect(
      invoke("memory_answer_result", { task_id: taskId, wait: 31 })
    ).rejects.toThrow("wait must be a boolean");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = invoke(
      "memory_answer_result",
      { task_id: taskId, wait: true },
      "session-a",
      controller.signal
    ).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    expect(await result).toBeInstanceOf(Error);
  });

  it("stops waiting when the task expires without presenting a stale answer", async () => {
    const expiresAt = new Date(Date.now() + 2000).toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              task: task("running", {
                expiresAt,
                result: { markdown: "private stale answer" }
              })
            })
          )
      )
    );
    const { invoke } = await setup();
    vi.useFakeTimers();
    const result = invoke("memory_answer_result", {
      task_id: taskId,
      wait: true
    }).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBeInstanceOf(Error);
    expect(String(await result)).not.toContain("private stale answer");
  });
});
