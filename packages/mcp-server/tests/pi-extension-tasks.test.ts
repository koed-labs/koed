import {
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
      on: unknown;
    }) => void;
  };
  const tools = new Map<string, Tool>();
  extension.default({
    registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
    on: vi.fn()
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
  return { invoke, tools };
};

describe("Pi explicit Memory Answer tasks", () => {
  it.each(["blocking", "non_blocking"])(
    "uses each Pi Conversation directory for %s recall, including concurrent sessions",
    async (delivery_mode) => {
      const requests: Array<{
        caller: { cwd: string };
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
        ["/work/alpha", "/work/beta/subdirectory"].map((cwd, index) =>
          invoke(
            "memory_answer",
            { query: cwd, delivery_mode },
            `session-${index}`,
            new AbortController().signal,
            cwd
          )
        )
      );
      expect(requests).toHaveLength(2);
      for (const request of requests)
        expect(request.caller.cwd).toBe(request.input.query);
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
