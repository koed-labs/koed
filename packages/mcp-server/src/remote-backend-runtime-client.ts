import { pinRepositoryRecallContext } from "./repository-recall-context.js";
import path from "node:path";
import {
  isTeamMemoryAnswerTaskCapability,
  requirePortableTeamRepositoryContext,
  type MemoryAnswerTask
} from "@koed/shared";
import { MemoryAnswerDelivery } from "../integrations/pi/memory-answer-delivery.mjs";
import type { MemoryApiClient } from "./index.js";
import { LocalAiRuntimeError } from "./local-runtime-client.js";
import type { KoedMcpRuntimeClient } from "./mcp-server-factory.js";
import type {
  LocalRuntimeCallerContext,
  LocalRuntimeCapabilities,
  LocalRuntimeToolName
} from "./local-runtime-protocol.js";
import {
  memoryAccessCheckInputSchema,
  memoryAnswerInputSchema,
  memoryExpandInputSchema,
  memoryIntakeProposeInputSchema,
  memorySearchInputSchema,
  memoryWorkspacesInputSchema,
  type MemoryAnswerToolInput
} from "./memory-tool-schemas.js";

export type RemoteMemoryApiClient = Pick<
  MemoryApiClient,
  | "capabilities"
  | "accessCheck"
  | "search"
  | "expand"
  | "proposeCuratedMemory"
  | "acceptMemoryAnswerTask"
  | "getMemoryAnswerTask"
  | "cancelMemoryAnswerTask"
>;

export interface RemoteBackendRuntimeClientOptions {
  /** Every API operation must revalidate the request principal's authority. */
  client: RemoteMemoryApiClient;
  discoverWorkspaces?: (
    input: { team_backend_id?: string },
    signal?: AbortSignal
  ) => Promise<Record<string, unknown>>;
  /** Serving capabilities only; API task operations revalidate authority. */
  supportedTaskScopes?: {
    readonly personal: true;
    readonly team?: { readonly backendId: string };
  };
  observationTimeoutMs?: number;
  pollMs?: number;
  maxQueued?: number;
}

const requireProject = (input: {
  search_domain: string;
  project_id?: string;
  repository_context?: unknown;
}): void => {
  if (input.search_domain === "project" && !input.project_id) {
    throw new LocalAiRuntimeError(
      "project_id is required for remote Project recall",
      400
    );
  }
  if (
    input.search_domain === "project" &&
    input.project_id &&
    !input.repository_context &&
    !path.posix.isAbsolute(input.project_id) &&
    !path.win32.isAbsolute(input.project_id)
  ) {
    throw new LocalAiRuntimeError(
      "project_id must be an absolute source Project path",
      400
    );
  }
};

const safeCaller = (
  input: MemoryAnswerToolInput,
  caller: LocalRuntimeCallerContext
): LocalRuntimeCallerContext => {
  const clientInfo: Record<string, string> = {};
  for (const key of ["name", "version", "title"]) {
    const value = caller.clientInfo?.[key];
    if (typeof value === "string" && value.length <= 160)
      clientInfo[key] = value;
  }
  return {
    cwd:
      input.search_domain === "project"
        ? (input.repository_context?.root ?? input.project_id!)
        : "",
    ...(caller.protocolVersion && caller.protocolVersion.length <= 128
      ? { protocolVersion: caller.protocolVersion }
      : {}),
    ...(Object.keys(clientInfo).length ? { clientInfo } : {})
  };
};

const assertActive = (signal?: AbortSignal): void => signal?.throwIfAborted();

export class RemoteBackendRuntimeClient implements KoedMcpRuntimeClient {
  private readonly delivery: MemoryAnswerDelivery<
    MemoryAnswerTask,
    Record<string, unknown>,
    LocalRuntimeCallerContext
  >;
  private readonly maxQueued: number;
  readonly memoryAnswerObservation: {
    maxObservationMs: number;
    pollMs?: number;
  };

  constructor(private readonly options: RemoteBackendRuntimeClientOptions) {
    this.maxQueued = options.maxQueued ?? 100;
    if (
      !Number.isInteger(this.maxQueued) ||
      this.maxQueued < 1 ||
      this.maxQueued > 10_000
    ) {
      throw new Error("Remote Memory Answer queue limit must be 1-10000");
    }
    this.memoryAnswerObservation = {
      maxObservationMs: options.observationTimeoutMs ?? 60_000,
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {})
    };
    this.delivery = new MemoryAnswerDelivery(
      {
        start: (input, caller, key, signal) =>
          this.startMemoryAnswerTask(input, caller, key, signal),
        get: (id, signal) => this.getMemoryAnswerTask(id, signal),
        cancel: (id, signal) => this.cancelMemoryAnswerTask(id, signal)
      },
      this.memoryAnswerObservation
    );
  }

  async capabilities(): Promise<LocalRuntimeCapabilities> {
    const payload = await this.options.client.capabilities();
    const capabilities = payload.capabilities as
      | Record<string, { availability?: unknown }>
      | undefined;
    const curatedMemoryIntakeAvailable =
      typeof payload.capabilitySchemaVersion === "number" &&
      payload.capabilitySchemaVersion >= 4 &&
      capabilities?.["memory.curatedIntake"]?.availability === "available";
    const teamTasksAvailable =
      Boolean(this.options.supportedTaskScopes?.team) &&
      isTeamMemoryAnswerTaskCapability(capabilities?.["memory.answerTasks"]);
    return {
      protocolVersion: 1,
      curatedMemoryIntakeAvailable,
      memoryAnswerTeamBackendAvailable: teamTasksAvailable,
      supportedTools: [
        "memory_answer",
        "memory_access_check",
        "memory_search",
        "memory_expand",
        ...(curatedMemoryIntakeAvailable
          ? ["memory_intake_propose" as const]
          : []),
        ...(this.options.discoverWorkspaces
          ? ["memory_workspaces" as const]
          : [])
      ]
    };
  }

  async startMemoryAnswerTask(
    rawInput: Record<string, unknown>,
    caller: LocalRuntimeCallerContext,
    invocationKey?: string,
    signal?: AbortSignal
  ): Promise<MemoryAnswerTask> {
    assertActive(signal);
    let input = memoryAnswerInputSchema.parse(rawInput);
    input = await pinRepositoryRecallContext(input, caller, process.env);
    requireProject(input);
    if (
      (input.team_workspace_id || input.team_backend_id) &&
      input.search_domain === "project"
    )
      requirePortableTeamRepositoryContext(input.repository_context);
    if (input.team_workspace_id || input.team_backend_id) {
      const support = this.options.supportedTaskScopes?.team;
      if (
        !support ||
        !(await this.capabilities()).memoryAnswerTeamBackendAvailable
      )
        throw new LocalAiRuntimeError(
          "Team Memory Answer tasks are unavailable",
          503
        );
      if (input.team_backend_id && input.team_backend_id !== support.backendId)
        throw new LocalAiRuntimeError(
          "Requested Team backend is unavailable",
          400
        );
      // The task executes on this enrolled backend. Client routing metadata is
      // not authority and must not invoke local-edge credential discovery.
      const { team_backend_id: _backendId, ...taskInput } = input;
      void _backendId;
      input = taskInput;
    }
    const { task } = await this.options.client.acceptMemoryAnswerTask({
      origin: "mcp",
      ...(invocationKey ? { invocation_key: invocationKey } : {}),
      request: { input, caller: safeCaller(input, caller) },
      max_queued: this.maxQueued
    });
    return task;
  }

  async getMemoryAnswerTask(
    id: string,
    signal?: AbortSignal
  ): Promise<MemoryAnswerTask> {
    assertActive(signal);
    return (await this.options.client.getMemoryAnswerTask(id)).task;
  }

  async cancelMemoryAnswerTask(
    id: string,
    signal?: AbortSignal
  ): Promise<MemoryAnswerTask> {
    assertActive(signal);
    return (await this.options.client.cancelMemoryAnswerTask(id)).task;
  }

  async callTool(
    name: LocalRuntimeToolName,
    rawInput: Record<string, unknown>,
    caller: LocalRuntimeCallerContext,
    signal?: AbortSignal,
    invocationKey?: string
  ): Promise<Record<string, unknown>> {
    assertActive(signal);
    switch (name) {
      case "memory_answer": {
        const input = memoryAnswerInputSchema.parse(rawInput);
        requireProject(input);
        const task = await this.delivery.accept(
          input,
          caller,
          invocationKey,
          signal
        );
        const observed = await this.delivery.observe(task.id, { signal });
        if (observed.kind === "detached") {
          return {
            status: "pending",
            task_id: task.id,
            message:
              "Memory Answer remains pending. The existing Local AI Runtime must execute the accepted task. Request closure does not cancel it."
          };
        }
        if (observed.task.status === "completed" && observed.task.result)
          return observed.task.result;
        throw new LocalAiRuntimeError(
          observed.task.status === "cancelled"
            ? "Memory Answer was cancelled"
            : "Memory Answer failed",
          409
        );
      }
      case "memory_workspaces": {
        const input = memoryWorkspacesInputSchema.parse(rawInput);
        if (!this.options.discoverWorkspaces)
          throw new LocalAiRuntimeError(
            "Team Workspace discovery is unavailable",
            503
          );
        return this.options.discoverWorkspaces(input, signal);
      }
      case "memory_access_check": {
        memoryAccessCheckInputSchema.parse(rawInput);
        return {
          ...(await this.options.client.accessCheck()),
          mcpTransport: "remote_http"
        };
      }
      case "memory_intake_propose": {
        const input = memoryIntakeProposeInputSchema.parse(rawInput);
        if (!(await this.capabilities()).curatedMemoryIntakeAvailable)
          throw new LocalAiRuntimeError(
            "Curated Memory intake is unavailable",
            503
          );
        return this.options.client.proposeCuratedMemory(input);
      }
      case "memory_search": {
        const input = memorySearchInputSchema.parse(rawInput);
        requireProject(input);
        const pinned = await pinRepositoryRecallContext(
          input,
          caller,
          process.env
        );
        requireProject(pinned);
        if (input.search_domain === "session" && !input.session_id)
          throw new LocalAiRuntimeError(
            "session_id is required for Session recall",
            400
          );
        const { repository_context: _context, ...search } = input;
        void _context;
        return this.options.client.search({
          ...search,
          project_id: pinned.project_id,
          retrieval_scope: "personal"
        });
      }
      case "memory_expand": {
        const input = memoryExpandInputSchema.parse(rawInput);
        const pinned = await pinRepositoryRecallContext(
          input,
          caller,
          process.env
        );
        return this.options.client.expand(input.nodeId, {
          searchDomain: input.search_domain,
          projectId: pinned.project_id,
          sessionId: input.session_id,
          recentDays: input.recent_days,
          sourceAfter: input.source_after,
          sourceBefore: input.source_before
        });
      }
    }
  }
}
