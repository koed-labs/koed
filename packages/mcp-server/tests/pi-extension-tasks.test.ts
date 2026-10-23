import {
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { storeDesktopLocalCredential } from "@koed/shared";
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
  delete process.env.KOED_MANAGED_MEMORY_ACTIONS;
  delete process.env.KOED_MANAGED_TEXT_ACTIONS;
  delete process.env.KOED_MANAGED_DOC_EXECUTION_ID;
  delete process.env.KOED_MANAGED_DOC_EXECUTION_GENERATION;
  delete process.env.KOED_MANAGED_DOC_API_URL;
  delete process.env.KOED_MANAGED_DOC_HELPER_URL;
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
    signal = new AbortController().signal
  ) =>
    tools.get(name)!.execute("call-1", params, signal, undefined, {
      cwd: "/work/project",
      sessionManager: { getSessionId: () => session }
    });
  return { invoke, tools, home };
};

describe("Pi installed document Work Item tool", () => {
  it("registers only with a managed selector, reads through the packaged helper, and emits a fixed apply receipt", async () => {
    const ordinary = await setup();
    expect(ordinary.tools.has("work_items_from_doc")).toBe(false);
    const executionId = "ae4e3f31-7300-49b9-ab81-a4df03d9bdd7";
    const sourceId = "ce4e3f31-7300-49b9-ab81-a4df03d9bdd7";
    process.env.KOED_MANAGED_DOC_EXECUTION_ID = executionId;
    process.env.KOED_MANAGED_DOC_EXECUTION_GENERATION = "2";
    process.env.KOED_MANAGED_DOC_API_URL = "http://127.0.0.1:32123";
    // Pi imports its installed helper through native ESM, outside Vitest's
    // source aliases. Compile the real helper into this fixture instead of
    // depending on stale workspace dist output in a fresh checkout.
    const helperPath = join(ordinary.home, "work-items-from-doc-tool.mjs");
    await build({
      entryPoints: [
        fileURLToPath(
          new URL("../src/work-items-from-doc-tool.ts", import.meta.url)
        )
      ],
      outfile: helperPath,
      bundle: true,
      platform: "node",
      format: "esm",
      alias: {
        "@koed/shared": fileURLToPath(
          new URL("../../shared/src/index.ts", import.meta.url)
        )
      }
    });
    process.env.KOED_MANAGED_DOC_HELPER_URL = pathToFileURL(helperPath).href;
    const managed = await setup();
    expect(managed.tools.has("work_items_from_doc")).toBe(true);
    expect(managed.tools.has("flashcard_sources")).toBe(true);
    storeDesktopLocalCredential(managed.home, {
      ownerUserId: executionId,
      operationFamilies: ["personal_collaboration_read", "managed_execution"]
    });
    const send = vi.fn(
      async (url: Parameters<typeof fetch>[0]) =>
        new Response(
          String(url).includes("/list")
            ? JSON.stringify({
                documents: [
                  {
                    sourceId,
                    name: "Syllabus.txt",
                    noteRevisionId: executionId
                  }
                ],
                nextCursor: null
              })
            : JSON.stringify({
                sourceId,
                sourceRevisionId: executionId,
                noteRevisionId: executionId,
                name: "Syllabus.txt",
                lines: [{ lineNumber: 1, text: "Paper due Friday" }],
                nextCursor: null,
                remaining: false
              }),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", send);
    const discovered = await managed.invoke("work_items_from_doc", {
      mode: "list"
    });
    expect(discovered.details).toEqual({
      documents: [
        { sourceId, name: "Syllabus.txt", noteRevisionId: executionId }
      ],
      nextCursor: null
    });
    expect(String(send.mock.calls[0]?.[0])).toContain(
      `/${executionId}/work-items-from-doc/list`
    );
    const page = await managed.invoke("work_items_from_doc", {
      mode: "read",
      source_id: sourceId
    });
    expect(page.details).toMatchObject({
      sourceId,
      lines: [{ text: "Paper due Friday" }]
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(String(send.mock.calls[1]?.[0])).toContain(
      `/${executionId}/work-items-from-doc/read`
    );
    const flashcards = await managed.invoke("flashcard_sources", {
      mode: "read",
      source_id: sourceId,
      cursor: 0
    });
    expect(flashcards.details).toMatchObject({
      sourceId,
      lines: [{ lineNumber: 1, text: "Paper due Friday" }]
    });
    expect(String(send.mock.calls[2]?.[0])).toContain(
      `/${executionId}/work-items-from-doc/read`
    );
    send.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            newCount: 1,
            alreadyExistingCount: 0,
            removedCount: 0,
            candidates: [{ lineNumber: 1, title: "Paper", status: "new" }]
          }),
          { status: 200 }
        )
    );
    const preview = await managed.invoke("work_items_from_doc", {
      mode: "preview",
      source_id: sourceId,
      source_revision_id: executionId,
      note_revision_id: executionId,
      proposals: [
        {
          line_number: 1,
          source_line: "Paper due Friday",
          title: "Paper",
          goal: "Write paper",
          due_text: null
        }
      ]
    });
    expect(preview.details).toMatchObject({ newCount: 1 });
    expect(String(send.mock.calls[3]?.[0])).toContain(
      `/${executionId}/work-items-from-doc/preview`
    );
    const apply = await managed.invoke("work_items_from_doc", {
      mode: "apply",
      source_id: sourceId,
      source_revision_id: executionId,
      note_revision_id: executionId,
      proposals: [
        {
          line_number: 1,
          source_line: "Paper due Friday",
          title: "Paper",
          goal: "Write paper",
          due_text: null
        }
      ]
    });
    expect(apply.details).toEqual({ status: "requested" });
    expect(send).toHaveBeenCalledTimes(4);
    send.mockImplementationOnce(
      async () => new Response("{}", { status: 409 })
    );
    await expect(
      managed.invoke("work_items_from_doc", {
        mode: "read",
        source_id: sourceId
      })
    ).rejects.toThrow("409");
    const noCredential = await setup();
    await expect(
      noCredential.invoke("work_items_from_doc", {
        mode: "read",
        source_id: sourceId
      })
    ).rejects.toThrow("lacks local owner authority");
    await expect(
      noCredential.invoke("flashcard_sources", {
        mode: "read",
        source_id: sourceId
      })
    ).rejects.toThrow("lacks local owner authority");
  });
});

describe("Pi explicit Memory Answer tasks", () => {
  it("gates typed Koed text actions and emits only request receipts", async () => {
    const ordinary = await setup();
    expect(ordinary.tools.has("koed_todo_add")).toBe(false);
    process.env.KOED_MANAGED_TEXT_ACTIONS = "1";
    const managed = await setup();
    expect(managed.tools.has("koed_todo_add")).toBe(true);
    expect(managed.tools.has("koed_job_create")).toBe(false);
    expect(
      await managed.invoke("koed_hq_open", {
        projectId: "90fd9cee-d5b1-4dda-9675-c044e4613ed7"
      })
    ).toEqual({
      content: [
        {
          type: "text",
          text: 'Koed koed_hq_open request v1: {"status":"requested"}'
        }
      ],
      details: { status: "requested" }
    });
  });
  it("gates native managed memory tools and emits request-only receipts", async () => {
    const ordinary = await setup();
    expect(ordinary.tools.has("memory_forget")).toBe(false);
    process.env.KOED_MANAGED_MEMORY_ACTIONS = "1";
    const managed = await setup();
    expect(managed.tools.has("memory_forget")).toBe(true);
    expect(managed.tools.has("memory_correct")).toBe(true);
    expect(await managed.invoke("memory_forget", {})).toEqual({
      content: [
        {
          type: "text",
          text: 'Koed memory_forget request v1: {"status":"requested"}'
        }
      ],
      details: { status: "requested" }
    });
    expect(
      await managed.invoke("memory_correct", {
        correction: "New wording",
        user_statement: "Correct that to New wording"
      })
    ).toMatchObject({ details: { status: "requested" } });
  });
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
