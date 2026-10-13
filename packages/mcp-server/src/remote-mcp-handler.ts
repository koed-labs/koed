import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import {
  createKoedMcpServer,
  type KoedMcpRuntimeClient
} from "./mcp-server-factory.js";

export interface RemoteMcpPrincipal {
  readonly userId: string;
  readonly tokenId: string;
}

export interface AuthenticatedRemoteMcpRequest {
  readonly principal: RemoteMcpPrincipal;
  readonly runtimeClient: KoedMcpRuntimeClient;
}

export interface RemoteKoedMcpHandlerOptions {
  /** Validate current credentials and bind the executor to their authority. */
  authenticate: (
    request: Request
  ) => Promise<AuthenticatedRemoteMcpRequest | null>;
  /** Trusted public authority names, including a non-default port. */
  allowedHosts: readonly string[];
  /** Browser Origins are denied unless explicitly allowlisted. */
  allowedOrigins?: readonly string[];
  maxBodyBytes?: number;
  environment?: NodeJS.ProcessEnv;
  protectedResourceMetadataUrl?: string;
}

export const REMOTE_MCP_MAX_BODY_BYTES = 1_048_576;

const rejection = (
  status: number,
  error: string,
  challenge = "Bearer"
): Response =>
  Response.json(
    { error },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...(status === 401 ? { "www-authenticate": challenge } : {})
      }
    }
  );

export const createRemoteKoedMcpHandler = ({
  authenticate,
  allowedHosts,
  allowedOrigins = [],
  maxBodyBytes = REMOTE_MCP_MAX_BODY_BYTES,
  environment = {},
  protectedResourceMetadataUrl
}: RemoteKoedMcpHandlerOptions) => {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("Remote MCP body limit must be a positive integer");
  }
  const origins = new Set(allowedOrigins);
  const hosts = new Set(allowedHosts.map((host) => host.toLowerCase()));
  const challenge = protectedResourceMetadataUrl
    ? `Bearer resource_metadata="${new URL(protectedResourceMetadataUrl).href.replaceAll('"', "%22")}"`
    : "Bearer";
  const authenticated = new WeakMap<AuthInfo, AuthenticatedRemoteMcpRequest>();
  const activeRequests = new Set<AbortController>();
  let closed = false;
  const handler = createMcpHandler(
    async (context) => {
      const binding = context.authInfo
        ? authenticated.get(context.authInfo)
        : undefined;
      if (!binding) throw new Error("Remote MCP request is not authenticated");
      return createKoedMcpServer(context, {
        runtimeClient: binding.runtimeClient,
        // Remote recall cannot create local Codex receipt files or workers.
        environment: { ...environment, KOED_CODEX_STOP_DELIVERY: "0" },
        callerContextResolver: ({ defaultContext }) => ({
          ...defaultContext,
          cwd: ""
        })
      });
    },
    { legacy: "stateless" }
  );

  return {
    close: async (): Promise<void> => {
      closed = true;
      for (const controller of activeRequests) controller.abort();
      await handler.close();
    },
    fetch: async (request: Request): Promise<Response> => {
      if (closed) return rejection(503, "MCP handler is closed");
      const host = new URL(request.url).host.toLowerCase();
      const hostHeader = request.headers.get("host")?.toLowerCase();
      if (
        !hosts.has(host) ||
        (hostHeader !== undefined && hostHeader !== host)
      ) {
        return rejection(403, "Host is not allowed");
      }
      const origin = request.headers.get("origin");
      if (origin !== null && !origins.has(origin)) {
        return rejection(403, "Origin is not allowed");
      }
      let binding: AuthenticatedRemoteMcpRequest | null;
      try {
        binding = await authenticate(request);
      } catch {
        return rejection(401, "Authentication required", challenge);
      }
      if (!binding) return rejection(401, "Authentication required", challenge);

      const length = request.headers.get("content-length");
      if (
        length !== null &&
        (!/^\d+$/.test(length) || Number(length) > maxBodyBytes)
      ) {
        return rejection(413, "Request body is too large");
      }
      let body: Uint8Array<ArrayBuffer> | undefined;
      if (request.body) {
        const reader = request.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > maxBodyBytes) {
              await reader.cancel();
              return rejection(413, "Request body is too large");
            }
            chunks.push(chunk.value);
          }
        } catch {
          return rejection(400, "Invalid request body");
        } finally {
          reader.releaseLock();
        }
        body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
      }
      if (closed) return rejection(503, "MCP handler is closed");
      const controller = new AbortController();
      const boundedRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
        signal: AbortSignal.any([request.signal, controller.signal])
      });
      // Each factory retains only this request's executor. No principal is
      // cached across requests, including the initialize-based protocol leg.
      // SDK legacy routing may clone Request; its validated authInfo retains
      // identity on both protocol legs. This carrier contains no credential.
      const authInfo: AuthInfo = Object.freeze({
        token: "",
        clientId: binding.principal.tokenId,
        scopes: []
      });
      authenticated.set(
        authInfo,
        Object.freeze({
          principal: Object.freeze({
            userId: binding.principal.userId,
            tokenId: binding.principal.tokenId
          }),
          runtimeClient: binding.runtimeClient
        })
      );
      activeRequests.add(controller);
      try {
        const response = await handler.fetch(boundedRequest, { authInfo });
        response.headers.set("cache-control", "private, no-store");
        if (!response.body) {
          activeRequests.delete(controller);
          return response;
        }
        // Legacy SSE returns before tool completion. Keep its request alive
        // until the response finishes so shutdown also detaches that waiter.
        const reader = response.body.getReader();
        const stream = new ReadableStream<Uint8Array>({
          async pull(output) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                activeRequests.delete(controller);
                output.close();
              } else {
                output.enqueue(chunk.value);
              }
            } catch (error) {
              activeRequests.delete(controller);
              output.error(error);
            }
          },
          async cancel(reason) {
            controller.abort(reason);
            activeRequests.delete(controller);
            await reader.cancel(reason);
          }
        });
        return new Response(stream, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      } catch (error) {
        activeRequests.delete(controller);
        throw error;
      } finally {
        authenticated.delete(authInfo);
      }
    }
  };
};
