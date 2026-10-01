import { MemoryAnswerDelivery } from "../integrations/pi/memory-answer-delivery.mjs";
import type http from "node:http";
import {
  memoryAnswerTaskIsTerminal,
  type MemoryAnswerTask
} from "@koed/shared";
import type { LocalRuntimeCallerContext } from "./local-runtime-protocol.js";
import { MemoryAnswerTaskScheduler } from "./memory-answer-task-scheduler.js";
import { memoryAnswerInputSchema } from "./memory-tool-schemas.js";

export interface MemoryAnswerTaskRuntimeExecutor {
  durableMemoryAnswerEligible?(
    input: Record<string, unknown>,
    caller: LocalRuntimeCallerContext
  ): boolean;
}

export interface MemoryAnswerTaskStartRequest {
  input: Record<string, unknown>;
  caller: LocalRuntimeCallerContext;
  invocationKey?: string;
}

type JsonWriter = (
  response: http.ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
) => void;

export class MemoryAnswerTaskRuntime {
  constructor(
    private readonly scheduler: MemoryAnswerTaskScheduler,
    private readonly executor: MemoryAnswerTaskRuntimeExecutor
  ) {}

  eligible(request: MemoryAnswerTaskStartRequest): boolean {
    return (
      !this.executor.durableMemoryAnswerEligible ||
      this.executor.durableMemoryAnswerEligible(request.input, request.caller)
    );
  }

  async start(
    request: MemoryAnswerTaskStartRequest
  ): Promise<MemoryAnswerTask> {
    const parsed = memoryAnswerInputSchema.safeParse(request.input);
    if (!parsed.success) {
      throw Object.assign(new Error("Invalid Memory Answer task input"), {
        statusCode: 400
      });
    }
    const normalized = { ...request, input: parsed.data };
    if (!this.eligible(normalized)) {
      throw Object.assign(
        new Error(
          "Team Workspace Memory Answer does not support detached tasks"
        ),
        { statusCode: 409 }
      );
    }
    return await this.scheduler.start({
      origin: request.caller.clientInfo?.name === "pi" ? "pi_extension" : "mcp",
      invocationKey: request.invocationKey,
      toolInput: normalized.input,
      caller: request.caller
    });
  }

  async executeBlocking(
    request: MemoryAnswerTaskStartRequest,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const delivery = new MemoryAnswerDelivery<
      MemoryAnswerTask,
      Record<string, unknown>,
      LocalRuntimeCallerContext
    >({
      start: (input, caller, invocationKey) =>
        this.start({ input, caller, invocationKey }),
      get: (taskId) => this.scheduler.get(taskId),
      cancel: (taskId) => this.scheduler.cancel(taskId)
    });
    const task = await delivery.accept(
      request.input,
      request.caller,
      request.invocationKey,
      signal
    );
    const observed = await delivery.observe(task.id, { signal });
    if (observed.kind === "detached") {
      throw Object.assign(new Error("Koed Memory Answer waiter detached"), {
        statusCode: observed.reason === "expired" ? 410 : 409
      });
    }
    const terminal = observed.task;
    if (terminal.status === "completed" && terminal.result) {
      return terminal.result;
    }
    throw Object.assign(
      new Error(
        terminal.lastErrorMessage ??
          (terminal.status === "cancelled"
            ? "Memory Answer task was cancelled"
            : "Memory Answer task failed")
      ),
      { statusCode: terminal.status === "cancelled" ? 409 : 500 }
    );
  }

  async handleResourceRoute(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    requestUrl: URL,
    json: JsonWriter
  ): Promise<boolean> {
    const match = requestUrl.pathname.match(
      /^\/v1\/tasks\/([0-9a-f-]{36})(?:\/(events|cancel))?$/i
    );
    if (!match) return false;
    const taskId = match[1]!;
    const action = match[2];
    if (request.method === "GET" && !action) {
      json(response, 200, { task: await this.scheduler.get(taskId) });
      return true;
    }
    if (request.method === "POST" && action === "cancel") {
      json(response, 200, { task: await this.scheduler.cancel(taskId) });
      return true;
    }
    if (request.method !== "GET" || action !== "events") return false;

    // Resolve ownership and retention before committing a successful stream.
    const initial = await this.scheduler.get(taskId);
    if (Date.parse(initial.expiresAt) <= Date.now()) {
      throw Object.assign(new Error("Memory Answer task expired"), {
        statusCode: 410
      });
    }
    if (response.destroyed || response.writableEnded) return true;
    const resume = request.headers["last-event-id"];
    let lastVersion =
      typeof resume === "string" &&
      /^\d+$/.test(resume) &&
      Number.isSafeInteger(Number(resume))
        ? Number(resume)
        : 0;
    let closed = false;
    let pending = false;
    let keepalivePending = false;
    let checking = false;
    let unsubscribe = () => undefined as void;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      clearTimeout(expiry);
      unsubscribe();
    };
    const finish = () => {
      cleanup();
      if (!response.destroyed && !response.writableEnded) response.end();
    };
    const writeTask = (task: MemoryAnswerTask, heartbeat = false) => {
      if (closed || response.destroyed || response.writableEnded) return;
      if (Date.parse(task.expiresAt) <= Date.now()) {
        finish();
        return;
      }
      if (task.version > lastVersion) {
        lastVersion = task.version;
        response.write(
          `id: ${task.version}\nevent: task\ndata: ${JSON.stringify(task)}\n\n`
        );
      } else if (heartbeat && !memoryAnswerTaskIsTerminal(task)) {
        response.write(": keepalive\n\n");
      }
      if (memoryAnswerTaskIsTerminal(task)) finish();
    };
    // Notifications are wakeups only. Never deliver their cached payloads.
    // Coalesce wakeups and serialize current-authority reads to prevent both
    // unbounded queues and delayed-read version regressions.
    const refresh = (heartbeat = false) => {
      if (closed) return;
      pending = true;
      keepalivePending ||= heartbeat;
      if (checking) return;
      checking = true;
      void (async () => {
        try {
          while (pending && !closed) {
            pending = false;
            const sendHeartbeat = keepalivePending;
            keepalivePending = false;
            writeTask(await this.scheduler.get(taskId), sendHeartbeat);
          }
        } catch {
          // Authority denial, expiry and backend failures end observation.
          // They never fall back to a previously admitted result.
          finish();
        } finally {
          checking = false;
        }
      })();
    };
    response.once("close", cleanup);
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-content-type-options": "nosniff"
    });
    unsubscribe = this.scheduler.subscribe(taskId, () => refresh());
    const keepalive = setInterval(() => refresh(true), 15_000);
    keepalive.unref?.();
    // Retention must end observation even without another scheduler event.
    const expiry = setTimeout(
      finish,
      Math.min(
        2_147_483_647,
        Math.max(1, Date.parse(initial.expiresAt) - Date.now())
      )
    );
    expiry.unref?.();
    writeTask(initial);
    if (!closed) {
      response.flushHeaders();
      refresh(); // Reconcile changes between the preflight read and subscription.
    }
    return true;
  }
}
