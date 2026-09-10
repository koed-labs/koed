import {
  readLocalRuntimeRegistration,
  type LocalRuntimeCapabilities,
  type LocalRuntimeCallerContext,
  type LocalRuntimeToolName
} from "./local-runtime-protocol.js";
import {
  memoryAnswerTaskIsTerminal,
  type MemoryAnswerTaskView
} from "./memory-answer-task-scheduler.js";

const responseJson = async (
  response: Response
): Promise<Record<string, unknown>> => {
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Koed local AI runtime request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Koed local AI runtime returned an invalid response");
  }
  return body as Record<string, unknown>;
};

const taskFromUnknown = (value: unknown): MemoryAnswerTaskView => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { id?: unknown }).id !== "string" ||
    typeof (value as { version?: unknown }).version !== "number" ||
    ![
      "accepted",
      "running",
      "cancel_requested",
      "completed",
      "failed",
      "cancelled"
    ].includes(String((value as { status?: unknown }).status))
  ) {
    throw new Error("Koed local AI runtime returned an invalid task");
  }
  return value as MemoryAnswerTaskView;
};

const taskFromRuntimeResponse = (
  response: Record<string, unknown>
): MemoryAnswerTaskView => taskFromUnknown(response.task);

const retryDelay = async (
  delayMs: number,
  signal?: AbortSignal
): Promise<void> =>
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(
        new Error("Koed memory request was cancelled", {
          cause: signal?.reason
        })
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });

const requestSignal = (
  callerSignal: AbortSignal | undefined,
  timeoutMs?: number
): { signal: AbortSignal; dispose: () => void } => {
  const controller = new AbortController();
  const timeout =
    timeoutMs === undefined
      ? undefined
      : setTimeout(
          () =>
            controller.abort(
              new Error("Koed local AI runtime request timed out")
            ),
          timeoutMs
        );
  timeout?.unref?.();
  const abort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) {
    abort();
  } else {
    callerSignal?.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timeout) clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abort);
    }
  };
};

export class LocalAiRuntimeClient {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async request(
    pathname: string,
    init: RequestInit,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<Record<string, unknown>> {
    const registration = readLocalRuntimeRegistration(this.environment);
    const bounded = requestSignal(signal, timeoutMs);
    try {
      return await responseJson(
        await this.fetchImpl(new URL(pathname, registration.url), {
          ...init,
          headers: {
            "content-type": "application/json",
            ...(init.headers ?? {}),
            authorization: registration.authorization
          },
          signal: bounded.signal
        })
      );
    } catch (error) {
      if (bounded.signal.aborted) {
        throw new Error(
          signal?.aborted
            ? "Koed memory request was cancelled"
            : "Koed local AI runtime request timed out",
          { cause: error }
        );
      }
      throw error;
    } finally {
      bounded.dispose();
    }
  }

  async capabilities(): Promise<LocalRuntimeCapabilities> {
    return (await this.request(
      "/v1/capabilities",
      { method: "GET" },
      undefined,
      10_000
    )) as unknown as LocalRuntimeCapabilities;
  }

  async refreshCapabilities(
    signal?: AbortSignal,
    timeoutMs = 5_000
  ): Promise<Record<string, unknown>> {
    return this.request(
      "/v1/capabilities/refresh",
      { method: "POST" },
      signal,
      timeoutMs
    );
  }

  async callTool(
    name: LocalRuntimeToolName,
    input: Record<string, unknown>,
    caller: LocalRuntimeCallerContext,
    signal?: AbortSignal,
    invocationKey?: string
  ): Promise<Record<string, unknown>> {
    return await this.request(
      `/v1/tools/${encodeURIComponent(name)}`,
      {
        method: "POST",
        body: JSON.stringify({ input, caller, invocationKey })
      },
      signal
    );
  }

  async startMemoryAnswerTask(
    input: Record<string, unknown>,
    caller: LocalRuntimeCallerContext,
    invocationKey?: string,
    signal?: AbortSignal
  ): Promise<MemoryAnswerTaskView> {
    return taskFromRuntimeResponse(
      await this.request(
        "/v1/tasks/memory-answer",
        {
          method: "POST",
          body: JSON.stringify({ input, caller, invocationKey })
        },
        signal,
        10_000
      )
    );
  }

  async getMemoryAnswerTask(
    taskId: string,
    signal?: AbortSignal
  ): Promise<MemoryAnswerTaskView> {
    return taskFromRuntimeResponse(
      await this.request(
        `/v1/tasks/${encodeURIComponent(taskId)}`,
        { method: "GET" },
        signal,
        10_000
      )
    );
  }

  async cancelMemoryAnswerTask(
    taskId: string,
    signal?: AbortSignal
  ): Promise<MemoryAnswerTaskView> {
    return taskFromRuntimeResponse(
      await this.request(
        `/v1/tasks/${encodeURIComponent(taskId)}/cancel`,
        { method: "POST" },
        signal,
        10_000
      )
    );
  }

  async waitForMemoryAnswerTask(
    taskId: string,
    signal?: AbortSignal
  ): Promise<MemoryAnswerTaskView> {
    let lastVersion = 0;
    let retryMs = 250;
    while (!signal?.aborted) {
      const current = await this.getMemoryAnswerTask(taskId, signal);
      lastVersion = Math.max(lastVersion, current.version);
      if (memoryAnswerTaskIsTerminal(current)) return current;
      try {
        const terminal = await this.listenForMemoryAnswerTask(
          taskId,
          lastVersion,
          signal
        );
        if (terminal) return terminal;
      } catch (error) {
        if (signal?.aborted) throw error;
      }
      await retryDelay(retryMs, signal);
      retryMs = Math.min(retryMs * 2, 4_000);
    }
    throw new Error("Koed memory request was cancelled", {
      cause: signal?.reason
    });
  }

  private async listenForMemoryAnswerTask(
    taskId: string,
    afterVersion: number,
    signal?: AbortSignal
  ): Promise<MemoryAnswerTaskView | null> {
    const registration = readLocalRuntimeRegistration(this.environment);
    const response = await this.fetchImpl(
      new URL(
        `/v1/tasks/${encodeURIComponent(taskId)}/events`,
        registration.url
      ),
      {
        method: "GET",
        headers: { authorization: registration.authorization },
        signal
      }
    );
    if (!response.ok || !response.body) {
      await responseJson(response);
      throw new Error("Koed task event stream returned no body");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!signal?.aborted) {
      const part = await reader.read();
      buffer += decoder.decode(part.value, { stream: !part.done });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const task = taskFromUnknown(JSON.parse(data));
        if (task.version <= afterVersion) continue;
        afterVersion = task.version;
        if (memoryAnswerTaskIsTerminal(task)) return task;
      }
      if (part.done) return null;
    }
    throw new Error("Koed memory request was cancelled", {
      cause: signal?.reason
    });
  }

  async askDesktop(
    input: {
      askThreadId?: string;
      idempotencyKey: string;
      query: string;
    },
    caller: LocalRuntimeCallerContext,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return await this.request(
      "/v1/desktop/ask",
      {
        method: "POST",
        body: JSON.stringify({ input, caller })
      },
      signal
    );
  }
}
