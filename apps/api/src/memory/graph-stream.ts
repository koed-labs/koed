import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthHelpers } from "../auth/session.js";
import type { CacheProvider } from "../infra/cache.js";

export interface GraphUpdatePayload {
  table?: string;
  operation?: string;
  id?: string | null;
  eventRefs?: GraphUpdateEventRef[];
  eventIds?: string[];
  questionIds?: string[];
  ownerUserId?: string | null;
  projectId?: string | null;
  threadId?: string | null;
  visibility?: "personal" | string | null;
  changedAt?: string;
  coalesced?: boolean;
}

interface GraphUpdateEventRef {
  id: string;
  projectId: string;
  threadId: string;
}

export interface GraphStreamClient {
  userId: string;
  reply: FastifyReply;
}

interface GraphListenClient {
  query(sql: string): Promise<unknown>;
  on(
    event: "notification",
    callback: (message: { channel: string; payload?: string }) => void
  ): void;
  on(event: "error", callback: (error: unknown) => void): void;
  release(): void;
}

interface GraphListenPool {
  connect(): Promise<GraphListenClient>;
}

interface GraphStreamServiceOptions {
  app: FastifyInstance;
  auth: AuthHelpers;
  pool: GraphListenPool | null;
  cacheProvider: CacheProvider;
  corsOrigins: Set<string>;
  graphUpdateDebounceMs: number;
  memoryEventGraphUpdateDebounceMs: number;
}

export const shouldIgnoreGraphStreamPayload = (
  payload: GraphUpdatePayload
): boolean => payload.table === "memory_embeddings";

export const graphUpdateActionForPayload = (payload: GraphUpdatePayload) => ({
  broadcast: !shouldIgnoreGraphStreamPayload(payload),
  invalidateCache: payload.table !== "memory_questions"
});

export const canReceiveGraphStreamPayload = (
  client: { userId: string },
  payload: GraphUpdatePayload
): boolean => {
  if (payload.visibility === "personal") {
    return Boolean(
      payload.ownerUserId && payload.ownerUserId === client.userId
    );
  }
  if (payload.visibility) {
    return false;
  }
  return true;
};

const writeGraphStreamEvent = (
  reply: FastifyReply,
  event: string,
  payload: unknown
) => {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
};

export const graphUpdateKey = (payload: GraphUpdatePayload): string => {
  if (payload.visibility === "personal" && payload.ownerUserId) {
    return `personal:${payload.ownerUserId}`;
  }
  return "global";
};

export const guardedBroadcastGraphUpdate = ({
  app,
  clients,
  payload
}: {
  app: Pick<FastifyInstance, "log">;
  clients: Iterable<GraphStreamClient>;
  payload: GraphUpdatePayload;
}) => {
  for (const client of clients) {
    if (!canReceiveGraphStreamPayload(client, payload)) {
      continue;
    }
    try {
      writeGraphStreamEvent(client.reply, "graph_update", payload);
    } catch (error) {
      app.log.warn(
        {
          event: {
            name: "graph_stream.broadcast_failed",
            category: "stream"
          },
          component: "graph_stream",
          err: error
        },
        "could not broadcast graph update"
      );
    }
  }
};

export const createGraphStreamService = async ({
  app,
  auth,
  pool,
  cacheProvider,
  corsOrigins,
  graphUpdateDebounceMs,
  memoryEventGraphUpdateDebounceMs
}: GraphStreamServiceOptions) => {
  const graphStreamClients = new Set<GraphStreamClient>();
  const pendingGraphUpdates = new Map<
    string,
    {
      eventRefs: Map<string, GraphUpdateEventRef>;
      questionIds: Set<string>;
      payload: GraphUpdatePayload;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let graphListenClient: GraphListenClient | null = null;

  const scheduleGraphUpdate = (payload: GraphUpdatePayload) => {
    const action = graphUpdateActionForPayload(payload);
    if (action.invalidateCache) {
      void cacheProvider
        .deleteByPrefix("koed:graph:")
        .catch((error: unknown) => {
          app.log.warn(
            {
              event: {
                name: "graph.cache.invalidate_failed",
                category: "cache"
              },
              component: "graph_stream",
              cache: { prefix: "koed:graph:" },
              err: error
            },
            "could not invalidate graph cache"
          );
        });
    }
    if (!action.broadcast) {
      return;
    }
    const key = graphUpdateKey(payload);
    const eventRef =
      payload.table === "memory_events" &&
      payload.operation !== "DELETE" &&
      payload.id &&
      payload.projectId &&
      payload.threadId
        ? {
            id: payload.id,
            projectId: payload.projectId,
            threadId: payload.threadId
          }
        : null;
    const questionId =
      payload.table === "memory_questions" && payload.id ? payload.id : null;
    const current = pendingGraphUpdates.get(key);
    if (current) {
      if (eventRef) {
        current.eventRefs.set(eventRef.id, eventRef);
      }
      if (questionId) {
        current.questionIds.add(questionId);
      }
      pendingGraphUpdates.set(key, { ...current, payload });
      return;
    }
    const timer = setTimeout(
      () => {
        const pending = pendingGraphUpdates.get(key);
        pendingGraphUpdates.delete(key);
        if (pending) {
          guardedBroadcastGraphUpdate({
            app,
            clients: graphStreamClients,
            payload: {
              ...pending.payload,
              coalesced: true,
              ...(pending.eventRefs.size > 0
                ? {
                    eventIds: [...pending.eventRefs.keys()],
                    eventRefs: [...pending.eventRefs.values()]
                  }
                : {}),
              ...(pending.questionIds.size > 0
                ? { questionIds: [...pending.questionIds] }
                : {}),
              changedAt: new Date().toISOString()
            }
          });
        }
      },
      eventRef ? memoryEventGraphUpdateDebounceMs : graphUpdateDebounceMs
    );
    pendingGraphUpdates.set(key, {
      eventRefs: new Map(eventRef ? [[eventRef.id, eventRef]] : []),
      questionIds: new Set(questionId ? [questionId] : []),
      payload,
      timer
    });
  };

  if (pool) {
    try {
      graphListenClient = await pool.connect();
      await graphListenClient.query("LISTEN koed_graph_updates");
      graphListenClient.on("notification", (message) => {
        if (message.channel !== "koed_graph_updates" || !message.payload) {
          return;
        }
        try {
          scheduleGraphUpdate(
            JSON.parse(message.payload) as GraphUpdatePayload
          );
        } catch (error) {
          app.log.warn(
            {
              event: {
                name: "graph_stream.notification.parse_failed",
                category: "stream"
              },
              component: "graph_stream",
              notification: {
                channel: message.channel,
                payload_length: message.payload.length
              },
              err: error
            },
            "could not parse graph update notification"
          );
        }
      });
      graphListenClient.on("error", (error) => {
        app.log.warn(
          {
            event: {
              name: "graph_stream.listener.failed",
              category: "stream"
            },
            component: "graph_stream",
            err: error
          },
          "graph update listener failed"
        );
      });
    } catch (error) {
      graphListenClient?.release();
      graphListenClient = null;
      app.log.warn(
        {
          event: {
            name: "graph_stream.listener.start_failed",
            category: "stream"
          },
          component: "graph_stream",
          err: error
        },
        "could not start graph update listener"
      );
    }
  }

  const registerRoutes = () => {
    app.get("/v1/memory/graph/stream", async (request, reply) => {
      const user = await auth.authenticate(request);
      const origin = request.headers.origin?.replace(/\/+$/, "");
      const streamCorsHeaders =
        origin && corsOrigins.has(origin)
          ? {
              "access-control-allow-origin": origin,
              "access-control-allow-credentials": "true",
              vary: "Origin"
            }
          : {};

      reply.hijack();
      reply.raw.writeHead(200, {
        ...streamCorsHeaders,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });

      const client = { userId: user.id, reply };
      graphStreamClients.add(client);
      writeGraphStreamEvent(reply, "ready", {
        ok: true,
        changedAt: new Date().toISOString()
      });

      const heartbeat = setInterval(() => {
        writeGraphStreamEvent(reply, "heartbeat", {
          changedAt: new Date().toISOString()
        });
      }, 15_000);

      request.raw.on("close", () => {
        clearInterval(heartbeat);
        graphStreamClients.delete(client);
      });
    });
  };

  const close = () => {
    for (const client of graphStreamClients) {
      client.reply.raw.end();
    }
    graphStreamClients.clear();
    for (const pending of pendingGraphUpdates.values()) {
      clearTimeout(pending.timer);
    }
    pendingGraphUpdates.clear();
    graphListenClient?.release();
  };

  return { registerRoutes, close };
};
