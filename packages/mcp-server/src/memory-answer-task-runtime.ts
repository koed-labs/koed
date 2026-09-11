import type http from "node:http";
import {
  memoryAnswerTaskIsTerminal,
  type MemoryAnswerTask
} from "@koed/shared";
import type { LocalRuntimeCallerContext } from "./local-runtime-protocol.js";
import { MemoryAnswerTaskScheduler } from "./memory-answer-task-scheduler.js";

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
    if (!this.eligible(request)) {
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
      toolInput: request.input,
      caller: request.caller
    });
  }

  async executeBlocking(
    request: MemoryAnswerTaskStartRequest,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const task = await this.start(request);
    const terminal = await this.scheduler.waitForTerminal(task.id, signal);
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

    const writeTask = (task: MemoryAnswerTask) => {
      if (response.writableEnded) return;
      response.write(
        `id: ${task.version}\nevent: task\ndata: ${JSON.stringify(task)}\n\n`
      );
      if (memoryAnswerTaskIsTerminal(task)) response.end();
    };
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-content-type-options": "nosniff"
    });
    const unsubscribe = this.scheduler.subscribe(taskId, writeTask);
    const keepalive = setInterval(() => {
      if (!response.writableEnded) response.write(": keepalive\n\n");
    }, 15_000);
    keepalive.unref?.();
    response.once("close", () => {
      clearInterval(keepalive);
      unsubscribe();
    });
    writeTask(await this.scheduler.get(taskId));
    return true;
  }
}
