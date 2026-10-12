import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { MemoryApiClient } from "@koed/mcp-server";
import {
  createRemoteKoedMcpHandler,
  LocalAiRuntimeError,
  RemoteBackendRuntimeClient,
  REMOTE_MCP_MAX_BODY_BYTES
} from "@koed/mcp-server/runtime-contracts";
import type { AuthHelpers } from "../auth/index.js";
import { searchMemorySchema } from "../memory/recall-schemas.js";

const remoteBackendId = "remote";
const workspaceContextsSchema = z.object({
  workspaces: z
    .array(
      z.object({
        teamId: z.string().uuid(),
        teamName: z.string(),
        teamWorkspaceId: z.string().uuid(),
        teamWorkspaceName: z.string(),
        access: z.enum(["read", "write"])
      })
    )
    .max(2000)
});

/** This adapter dispatches only existing API methods, never arbitrary URLs. */
class RequestBoundMemoryApiClient extends MemoryApiClient {
  constructor(
    private readonly app: FastifyInstance,
    private readonly authorization: string,
    resourceUrl: string,
    private readonly captureAllowed: boolean
  ) {
    super({ apiUrl: new URL(resourceUrl).origin });
  }

  protected override async request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    pathname: string,
    body?: unknown,
    options: { authorization?: string; signal?: AbortSignal } = {}
  ): Promise<T> {
    options.signal?.throwIfAborted();
    if (!pathname.startsWith("/v1/"))
      throw new Error("Unsupported memory API operation");
    const response = await this.app.inject({
      method,
      url: pathname,
      headers: { authorization: this.authorization },
      ...(body === undefined
        ? {}
        : {
            payload: JSON.stringify(body),
            headers: {
              authorization: this.authorization,
              "content-type": "application/json"
            }
          })
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const seconds = Number(response.headers["retry-after"]);
      throw new LocalAiRuntimeError(
        "Authorized memory API operation was unavailable",
        response.statusCode,
        undefined,
        response.statusCode === 429 &&
          Number.isFinite(seconds) &&
          seconds > 0 &&
          seconds <= 300
          ? Math.ceil(seconds * 1000)
          : undefined
      );
    }
    return response.json<T>();
  }

  override async capabilities(): Promise<Record<string, unknown>> {
    const payload = await super.capabilities();
    if (this.captureAllowed) return payload;
    const capabilities =
      payload.capabilities && typeof payload.capabilities === "object"
        ? (payload.capabilities as Record<string, unknown>)
        : {};
    return {
      ...payload,
      capabilities: {
        ...capabilities,
        "memory.curatedIntake": { availability: "unavailable" }
      }
    };
  }

  teamContexts(signal?: AbortSignal): Promise<unknown> {
    return this.request("GET", "/v1/team-context", undefined, { signal });
  }

  teamAnswer(
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      "/v1/memory/answer",
      searchMemorySchema.parse({ ...input, retrieval_scope: "personal" }),
      { signal }
    );
  }
}

export const registerRemoteMcpRoutes = (
  app: FastifyInstance,
  options: {
    resourceUrl: URL;
    auth: AuthHelpers;
    allowedOrigins: readonly string[];
    teamCollaborationEnabled: boolean;
    environment?: NodeJS.ProcessEnv;
  }
) => {
  const requestContexts = new WeakMap<Request, FastifyRequest>();
  const handler = createRemoteKoedMcpHandler({
    allowedHosts: [options.resourceUrl.host],
    allowedOrigins: options.allowedOrigins,
    environment: options.environment,
    protectedResourceMetadataUrl: new URL(
      "/.well-known/oauth-protected-resource/mcp",
      options.resourceUrl
    ).href,
    authenticate: async (request) => {
      const context = requestContexts.get(request);
      if (!context) return null;
      const principal = await options.auth.resolveDelegatedPrincipal(context);
      if (!principal || !principal.scopes.includes("koed:memory:read"))
        return null;
      const authorization = request.headers.get("authorization");
      if (!authorization) return null;
      const client = new RequestBoundMemoryApiClient(
        app,
        authorization,
        options.resourceUrl.href,
        principal.scopes.includes("koed:capture")
      );
      const teamAllowed =
        options.teamCollaborationEnabled &&
        principal.scopes.includes("koed:team:read");
      return {
        principal: { userId: principal.userId, tokenId: principal.grantId },
        runtimeClient: new RemoteBackendRuntimeClient({
          client,
          ...(teamAllowed
            ? {
                discoverWorkspaces: async (
                  input: { team_backend_id?: string },
                  signal?: AbortSignal
                ) => {
                  if (
                    input.team_backend_id &&
                    input.team_backend_id !== remoteBackendId
                  )
                    return {
                      workspaces: [],
                      unavailable_backends: [
                        {
                          team_backend_id: input.team_backend_id,
                          reason: "backend_not_registered"
                        }
                      ]
                    };
                  const contexts = workspaceContextsSchema.parse(
                    await client.teamContexts(signal)
                  );
                  return {
                    workspaces: contexts.workspaces.map((workspace) => ({
                      team_backend_id: remoteBackendId,
                      team_id: workspace.teamId,
                      team_name: workspace.teamName,
                      team_workspace_id: workspace.teamWorkspaceId,
                      team_workspace_name: workspace.teamWorkspaceName,
                      access: workspace.access
                    })),
                    unavailable_backends: []
                  };
                },
                teamEvidence: async (
                  input: Record<string, unknown>,
                  signal?: AbortSignal
                ) => {
                  if (
                    input.team_backend_id &&
                    input.team_backend_id !== remoteBackendId
                  )
                    throw new Error("Requested Team backend is not available");
                  return client.teamAnswer(input, signal);
                }
              }
            : {})
        })
      };
    }
  });
  app.addHook("preClose", async () => {
    await handler.close();
  });
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    bodyLimit: REMOTE_MCP_MAX_BODY_BYTES,
    handler: async (request, reply) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const closed = () => {
        if (!reply.raw.writableEnded) abort();
      };
      request.raw.once("aborted", abort);
      reply.raw.once("close", closed);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(","));
      }
      const body =
        request.body === undefined ? undefined : JSON.stringify(request.body);
      const webRequest = new Request(options.resourceUrl, {
        method: request.method,
        headers,
        body,
        signal: controller.signal
      });
      requestContexts.set(webRequest, request);
      try {
        const response = await handler.fetch(webRequest);
        reply.code(response.status);
        response.headers.forEach((value, key) => {
          reply.header(key, value);
        });
        if (!response.body) return reply.send();
        const stream = Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream<Uint8Array>
        );
        stream.once("close", () => {
          if (stream.destroyed && !stream.readableEnded) abort();
          request.raw.removeListener("aborted", abort);
          reply.raw.removeListener("close", closed);
        });
        return reply.send(stream);
      } finally {
        requestContexts.delete(webRequest);
      }
    }
  });
  return handler;
};
