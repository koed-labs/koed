import {
  pinRepositoryRecallContext,
  resolveRequestedProjectRoot
} from "./repository-recall-context.js";
import os from "node:os";
import path from "node:path";
import {
  isTeamMemoryAnswerTaskCapability,
  readLocalEdgeClientCredentialAuthorization,
  readLocalEdgeUpstreamRegistry,
  type ClaimedMemoryAnswerTask,
  type MemoryAnswerTask,
  type MemoryAnswerTaskExecutionAuthority
} from "@koed/shared";
import { MemoryApiClient } from "./index.js";
import type { MemoryAnswerRetrievalClient } from "./answer-worker.js";
import type {
  MemoryAnswerTaskApi,
  MemoryAnswerTaskExecutionContext
} from "./memory-answer-task-scheduler.js";
import { memoryAnswerInputSchema } from "./memory-tool-schemas.js";
import { resolveProjectTeamWorkspaceRoute } from "./project-team-workspace-links.js";
import {
  backendForDiscoveredWorkspace,
  discoverTeamWorkspaces
} from "./team-workspace-discovery.js";

export interface MemoryAnswerTaskBackend {
  id: string;
  scope: "personal" | "team";
  api: MemoryAnswerTaskApi;
  retrieval: MemoryAnswerRetrievalClient;
}

export interface MemoryAnswerTaskCoordinatorOptions {
  /** Every enumeration must recheck enrollment, policy, capabilities and custody. */
  backends(): Promise<readonly MemoryAnswerTaskBackend[]>;
  resolveStart(
    input: Parameters<MemoryAnswerTaskApi["acceptMemoryAnswerTask"]>[0]
  ): Promise<{
    backendId: string;
    input: Parameters<MemoryAnswerTaskApi["acceptMemoryAnswerTask"]>[0];
  }>;
  maxRoutes?: number;
}

const unavailable = (message: string, status = 403): Error =>
  Object.assign(new Error(message), { status, statusCode: status });
const statusOf = (error: unknown): unknown =>
  error && typeof error === "object"
    ? ((error as { status?: number; statusCode?: number }).status ??
      (error as { statusCode?: number }).statusCode)
    : undefined;
const scopeOf = (task: MemoryAnswerTask) =>
  task.teamWorkspaceId ? "team" : "personal";

/** One scheduler uses this adapter; the cache contains routing IDs, never Memory. */
export class MemoryAnswerTaskCoordinator implements MemoryAnswerTaskApi {
  private readonly routes = new Map<string, string>();
  private readonly retrieval = new Map<string, MemoryAnswerRetrievalClient>();
  private cursor = 0;
  private readonly maxRoutes: number;

  constructor(private readonly options: MemoryAnswerTaskCoordinatorOptions) {
    this.maxRoutes = Math.max(1, Math.min(4096, options.maxRoutes ?? 4096));
  }

  private async backends() {
    const backends = await this.options.backends();
    if (
      backends.length > 64 ||
      new Set(backends.map((backend) => backend.id)).size !== backends.length
    )
      throw unavailable("Memory Answer backend registry is ambiguous");
    const authorized = new Set(backends.map((backend) => backend.id));
    for (const id of this.retrieval.keys()) {
      if (!authorized.has(id)) this.retrieval.delete(id);
    }
    return backends;
  }

  private remember(task: MemoryAnswerTask, backend: MemoryAnswerTaskBackend) {
    if (scopeOf(task) !== backend.scope)
      throw unavailable("Memory Answer task scope does not match its backend");
    const previous = this.routes.get(task.id);
    if (previous && previous !== backend.id)
      throw unavailable("Memory Answer task route is ambiguous");
    this.routes.delete(task.id);
    this.routes.set(task.id, backend.id);
    this.retrieval.set(backend.id, backend.retrieval);
    while (this.routes.size > this.maxRoutes)
      this.routes.delete(this.routes.keys().next().value!);
  }

  private async locate(taskId: string): Promise<MemoryAnswerTaskBackend> {
    const backends = await this.backends();
    const remembered = this.routes.get(taskId);
    if (remembered) {
      const backend = backends.find((candidate) => candidate.id === remembered);
      if (!backend)
        throw unavailable("Memory Answer task backend is no longer authorized");
      return backend;
    }
    const matches: Array<{
      backend: MemoryAnswerTaskBackend;
      task: MemoryAnswerTask;
    }> = [];
    let denied = false;
    for (const backend of backends) {
      try {
        const { task } = await backend.api.getMemoryAnswerTask(taskId);
        if (scopeOf(task) === backend.scope) matches.push({ backend, task });
      } catch (error) {
        const status = Number(statusOf(error));
        if (status === 403) denied = true;
        else if (status !== 404) throw error;
      }
    }
    if (matches.length !== 1)
      throw unavailable(
        matches.length
          ? "Memory Answer task route is ambiguous"
          : "Memory Answer task not found",
        matches.length ? 409 : denied ? 403 : 404
      );
    this.remember(matches[0]!.task, matches[0]!.backend);
    return matches[0]!.backend;
  }

  async acceptMemoryAnswerTask(
    input: Parameters<MemoryAnswerTaskApi["acceptMemoryAnswerTask"]>[0]
  ) {
    await this.backends();
    const resolved = await this.options.resolveStart(input);
    const backend = (await this.backends()).find(
      (candidate) => candidate.id === resolved.backendId
    );
    if (!backend)
      throw unavailable("Memory Answer task backend is not authorized");
    const response = await backend.api.acceptMemoryAnswerTask(resolved.input);
    this.remember(response.task, backend);
    return response;
  }

  async getMemoryAnswerTask(taskId: string) {
    const backend = await this.locate(taskId);
    const response = await backend.api.getMemoryAnswerTask(taskId);
    this.remember(response.task, backend);
    return response;
  }

  async claimMemoryAnswerTask(
    input: Parameters<MemoryAnswerTaskApi["claimMemoryAnswerTask"]>[0]
  ) {
    const backends = await this.backends();
    const reconciled: MemoryAnswerTask[] = [];
    const start = this.cursor;
    for (let offset = 0; offset < backends.length; offset++) {
      const index = (start + offset) % backends.length;
      const backend = backends[index]!;
      this.cursor = (index + 1) % backends.length;
      const response = await backend.api.claimMemoryAnswerTask({
        ...input,
        scope_filter: backend.scope
      });
      for (const task of response.reconciled) {
        this.remember(task, backend);
        reconciled.push(task);
      }
      if (response.task) {
        const authority = response.task.executionAuthority;
        if (
          backend.scope === "team"
            ? authority?.scope !== "team" ||
              authority.teamWorkspaceId !== response.task.teamWorkspaceId
            : authority && authority.scope !== "personal"
        ) {
          throw unavailable(
            "Memory Answer claim authority does not match its task"
          );
        }
        this.remember(response.task, backend);
        return { task: response.task, reconciled };
      }
    }
    if (backends.length) this.cursor = (this.cursor + 1) % backends.length;
    return { task: null, reconciled };
  }

  async cancelMemoryAnswerTask(taskId: string) {
    const backend = await this.locate(taskId);
    const response = await backend.api.cancelMemoryAnswerTask(taskId);
    this.remember(response.task, backend);
    return response;
  }

  async heartbeatMemoryAnswerTask(
    taskId: string,
    input: Parameters<MemoryAnswerTaskApi["heartbeatMemoryAnswerTask"]>[1]
  ) {
    return (await this.locate(taskId)).api.heartbeatMemoryAnswerTask(
      taskId,
      input
    );
  }

  async completeMemoryAnswerTask(
    taskId: string,
    input: Parameters<MemoryAnswerTaskApi["completeMemoryAnswerTask"]>[1]
  ) {
    return (await this.locate(taskId)).api.completeMemoryAnswerTask(
      taskId,
      input
    );
  }

  async failMemoryAnswerTask(
    taskId: string,
    input: Parameters<MemoryAnswerTaskApi["failMemoryAnswerTask"]>[1]
  ) {
    return (await this.locate(taskId)).api.failMemoryAnswerTask(taskId, input);
  }

  async deleteExpiredMemoryAnswerTasks() {
    let deleted = 0;
    // Direct Personal/Team bindings can share one endpoint; cleanup once per API.
    const seen = new Set<MemoryAnswerTaskApi>();
    for (const backend of await this.backends()) {
      if (seen.has(backend.api)) continue;
      seen.add(backend.api);
      deleted += (await backend.api.deleteExpiredMemoryAnswerTasks()).deleted;
    }
    return { deleted };
  }

  executionContextForTask = (
    task: ClaimedMemoryAnswerTask,
    getExecutionAuthority: () => MemoryAnswerTaskExecutionAuthority
  ): MemoryAnswerTaskExecutionContext => {
    const route = this.routes.get(task.id);
    const taskBackend = route ? this.retrieval.get(route) : undefined;
    if (!taskBackend)
      throw unavailable("Memory Answer execution route is unavailable");
    return { getExecutionAuthority, taskBackend };
  };
}

/** Fixed local-edge methods only; no caller-supplied endpoint or upstream URL. */
class UpstreamMemoryAnswerTaskClient extends MemoryApiClient {
  constructor(
    client: MemoryApiClient,
    private readonly backendId: string,
    private readonly authorization: () => string
  ) {
    super(client.config);
  }

  protected override async request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    pathname: string,
    body?: unknown
  ): Promise<T> {
    const root = "/v1/memory/answer-tasks";
    let operation: string;
    let taskId: string | undefined;
    if (pathname === root && method === "POST") operation = "accept";
    else if (pathname === `${root}/claim` && method === "POST")
      operation = "claim";
    else if (pathname === `${root}/expired` && method === "DELETE")
      operation = "expired";
    else {
      const match = pathname.match(
        /^\/v1\/memory\/answer-tasks\/([0-9a-f-]{36})(?:\/(cancel|heartbeat|complete|fail))?$/i
      );
      if (!match || (match[2] ? method !== "POST" : method !== "GET"))
        throw unavailable("Unsupported Memory Answer task operation");
      taskId = match[1];
      operation = match[2] ?? "get";
    }
    return super.request(
      "POST",
      `/v1/local-edge/memory-answer-tasks/${operation}`,
      {
        upstream_backend_id: this.backendId,
        ...(taskId ? { task_id: taskId } : {}),
        ...(["accept", "claim", "heartbeat", "complete", "fail"].includes(
          operation
        )
          ? { input: body }
          : {})
      },
      { authorization: this.authorization() }
    );
  }
}

class ScopedTeamRetrievalClient implements MemoryAnswerRetrievalClient {
  constructor(
    private readonly client: MemoryApiClient,
    private readonly backendId: string,
    private readonly authorization: () => string
  ) {}
  search(input: Record<string, unknown>) {
    return this.client.teamMemorySearch(
      this.backendId,
      input,
      this.authorization()
    );
  }
  expand(
    nodeId: string,
    input: Parameters<MemoryAnswerRetrievalClient["expand"]>[1] = {}
  ) {
    return this.client.teamMemoryExpand(
      this.backendId,
      nodeId,
      {
        search_domain: input?.searchDomain,
        session_id: input?.sessionId,
        project_id: input?.projectId,
        team_workspace_id: input?.teamWorkspaceId,
        recent_days: input?.recentDays,
        source_after: input?.sourceAfter,
        source_before: input?.sourceBefore,
        authorization_boundary: input?.authorizationBoundary
      },
      this.authorization()
    );
  }
}

export const supportsTeamMemoryAnswerTasks = (
  payload: Record<string, unknown>
): boolean => {
  const capabilities = payload.capabilities as
    | Record<string, unknown>
    | undefined;
  return isTeamMemoryAnswerTaskCapability(capabilities?.["memory.answerTasks"]);
};

export const createMemoryAnswerTaskCoordinator = (
  client: MemoryApiClient,
  environment: NodeJS.ProcessEnv,
  allowTeamRuntime = false
): MemoryAnswerTaskCoordinator => {
  const koedHome = path.resolve(
    environment.KOED_HOME?.trim() || path.join(os.homedir(), ".koed")
  );
  const registryPath = path.join(koedHome, "config", "upstream-backends.json");
  const boundClients = new Map<string, MemoryAnswerTaskBackend>();
  const authorizedBackends = () =>
    readLocalEdgeUpstreamRegistry(registryPath).backends.filter((backend) => {
      const credential = readLocalEdgeClientCredentialAuthorization(
        koedHome,
        backend.id
      );
      return (
        backend.routePolicy.memoryAnswerExecution === "enabled" &&
        backend.routePolicy.teamWorkspaceRead === "enabled" &&
        backend.capabilities?.state === "validated" &&
        Boolean(
          backend.capabilities.expiresAt &&
          Date.parse(backend.capabilities.expiresAt) > Date.now()
        ) &&
        supportsTeamMemoryAnswerTasks(
          (backend.capabilities.payload ?? {}) as Record<string, unknown>
        ) &&
        credential?.operationFamilies.includes("memory_answer_execution") &&
        credential.operationFamilies.includes("team_workspace_read")
      );
    });
  const backends = async (): Promise<MemoryAnswerTaskBackend[]> => {
    const result: MemoryAnswerTaskBackend[] = [
      { id: "personal", scope: "personal", api: client, retrieval: client }
    ];
    if (allowTeamRuntime) {
      if (supportsTeamMemoryAnswerTasks(await client.capabilities()))
        result.push({
          id: "remote-team",
          scope: "team",
          api: client,
          retrieval: client
        });
      return result;
    }
    const authorized = authorizedBackends();
    for (const id of boundClients.keys()) {
      if (!authorized.some((backend) => backend.id === id))
        boundClients.delete(id);
    }
    for (const backend of authorized) {
      let binding = boundClients.get(backend.id);
      if (!binding) {
        const authorization = () => {
          if (
            !authorizedBackends().some(
              (candidate) => candidate.id === backend.id
            )
          )
            throw unavailable("Memory Answer backend is no longer authorized");
          return readLocalEdgeClientCredentialAuthorization(
            koedHome,
            backend.id
          )!.authorization;
        };
        binding = {
          id: `upstream:${backend.id}`,
          scope: "team",
          api: new UpstreamMemoryAnswerTaskClient(
            client,
            backend.id,
            authorization
          ),
          retrieval: new ScopedTeamRetrievalClient(
            client,
            backend.id,
            authorization
          )
        };
        boundClients.set(backend.id, binding);
      }
      result.push(binding);
    }
    return result;
  };
  return new MemoryAnswerTaskCoordinator({
    backends,
    resolveStart: async (request) => {
      const input = memoryAnswerInputSchema.parse(request.request.input);
      const caller = request.request.caller as { cwd?: string } | undefined;
      const projectRoot =
        input.search_domain === "project"
          ? resolveRequestedProjectRoot(
              input,
              { cwd: caller?.cwd ?? "" },
              environment
            )
          : undefined;
      const route = resolveProjectTeamWorkspaceRoute({
        projectRoot,
        requestedTeamWorkspaceId: input.team_workspace_id,
        env: environment
      });
      if (!route.teamWorkspaceId) {
        if (input.team_backend_id)
          throw unavailable(
            "A Team Workspace is required for Team recall",
            400
          );
        const pinned = await pinRepositoryRecallContext(
          input,
          { cwd: caller?.cwd ?? "" },
          environment
        );
        return {
          backendId: "personal",
          input: { ...request, request: { ...request.request, input: pinned } }
        };
      }
      let backendId = "remote-team";
      if (!allowTeamRuntime) {
        const requestedBackend = input.team_backend_id ?? route.backendId;
        const eligible = authorizedBackends();
        if (
          eligible.length > 63 ||
          (requestedBackend &&
            !eligible.some((backend) => backend.id === requestedBackend))
        ) {
          throw unavailable("Team Workspace route is not currently authorized");
        }
        const results = await Promise.all(
          eligible
            .filter(
              (backend) => !requestedBackend || backend.id === requestedBackend
            )
            .map((backend) =>
              discoverTeamWorkspaces(client, environment, backend.id)
            )
        );
        const discovery = {
          workspaces: results.flatMap((result) => result.workspaces),
          unavailable_backends: results.flatMap(
            (result) => result.unavailable_backends
          )
        };
        const selected =
          input.team_backend_id ??
          route.backendId ??
          backendForDiscoveredWorkspace(discovery, route.teamWorkspaceId);
        if (
          !selected ||
          !discovery.workspaces.some(
            (workspace) =>
              workspace.team_backend_id === selected &&
              workspace.team_workspace_id === route.teamWorkspaceId
          )
        )
          throw unavailable("Team Workspace route is not currently authorized");
        backendId = `upstream:${selected}`;
      } else if (input.team_backend_id && input.team_backend_id !== "remote") {
        throw unavailable("Requested Team backend is not available");
      }
      const normalized = { ...input };
      delete normalized.team_backend_id;
      return {
        backendId,
        input: {
          ...request,
          request: {
            ...request.request,
            input: {
              ...normalized,
              team_workspace_id: route.teamWorkspaceId,
              ...(projectRoot ? { project_id: projectRoot } : {})
            }
          }
        }
      };
    }
  });
};
