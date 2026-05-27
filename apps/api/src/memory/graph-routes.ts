import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import {
  clusterIdParamsSchema,
  clusterMemoriesQuerySchema,
  graphEventDetailQuerySchema,
  graphEventParamsSchema,
  graphEventPatchSchema,
  graphEventsQuerySchema,
  graphNodesQuerySchema,
  graphQuerySchema,
  memoryBrowserQuerySchema,
  memoryClusterQuerySchema,
  nodeIdParamsSchema,
  updateMemorySchema
} from "./graph-schemas.js";

export const registerGraphRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticate, authenticateApiToken },
    graph: { cacheProvider, graphCacheTtlSeconds, hashCacheKey },
    rateLimit: {
      memoryRead: memoryReadRateLimit,
      memoryWrite: memoryWriteRateLimit
    }
  } = context;

  app.get(
    "/v1/memory/clusters",
    { preHandler: memoryReadRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const query = memoryClusterQuerySchema.parse(request.query);
      reply.header("deprecation", "true");
      reply.header("x-koed-deprecated", "Use /v1/memory/graph/nodes");
      return {
        clusters: await repo.listMemoryClusters({ userId: user.id }, query)
      };
    }
  );

  app.get(
    "/v1/memory/clusters/:clusterId/memories",
    { preHandler: memoryReadRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = clusterIdParamsSchema.parse(request.params);
      const query = clusterMemoriesQuerySchema.parse(request.query);
      reply.header("deprecation", "true");
      reply.header("x-koed-deprecated", "Use /v1/memory/graph/nodes");
      return {
        memories: await repo.listMemoriesInCluster(
          { userId: user.id },
          params.clusterId,
          query
        )
      };
    }
  );

  app.get(
    "/v1/memory/items",
    { preHandler: memoryReadRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const query = memoryBrowserQuerySchema.parse(request.query);
      reply.header("deprecation", "true");
      reply.header("x-koed-deprecated", "Use /v1/memory/graph/nodes");
      return {
        memories: await repo.listMemoryBrowserItems({ userId: user.id }, query)
      };
    }
  );

  app.get(
    "/v1/memory/graph/overview",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const cacheKey = `koed:graph:overview:${user.id}`;
      const cached = await cacheProvider.getJson<{ overview: unknown }>(
        cacheKey
      );
      if (cached) {
        return cached;
      }
      const response = {
        overview: await repo.getLcmGraphOverview({ userId: user.id })
      };
      await cacheProvider.setJson(cacheKey, response, graphCacheTtlSeconds);
      return response;
    }
  );

  app.get(
    "/v1/memory/graph/nodes",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const query = graphNodesQuerySchema.parse(request.query);
      return {
        nodes: await repo.listLcmGraphNodes(
          { userId: user.id },
          {
            ...query,
            nodeIds: query.ids
          }
        )
      };
    }
  );

  app.get(
    "/v1/memory/graph/nodes/:nodeId",
    { preHandler: memoryReadRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = nodeIdParamsSchema.parse(request.params);
      const query = graphEventDetailQuerySchema.parse(request.query);
      const node = await repo.getLcmGraphNode(
        { userId: user.id },
        params.nodeId,
        {
          includeInvalidated: query.includeInvalidated
        }
      );
      return node
        ? { node }
        : reply
            .status(404)
            .send({ error: "LCM node not found or not visible" });
    }
  );

  app.get(
    "/v1/memory/graph/events",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const query = graphEventsQuerySchema.parse(request.query);
      return {
        events: await repo.listLcmGraphEvents({ userId: user.id }, query)
      };
    }
  );

  app.get(
    "/v1/memory/graph/threads",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const query = graphQuerySchema.parse(request.query);
      const cacheKey = `koed:graph:threads:${user.id}:${hashCacheKey(
        JSON.stringify(query)
      )}`;
      const cached = await cacheProvider.getJson<{ projects: unknown }>(
        cacheKey
      );
      if (cached) {
        return cached;
      }
      const response = {
        projects: await repo.listLcmGraphThreads({ userId: user.id }, query)
      };
      await cacheProvider.setJson(cacheKey, response, graphCacheTtlSeconds);
      return response;
    }
  );

  app.get(
    "/v1/memory/graph/events/:eventId",
    { preHandler: memoryReadRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = graphEventParamsSchema.parse(request.params);
      const query = graphEventDetailQuerySchema.parse(request.query);
      const event = await repo.getLcmGraphEvent(
        { userId: user.id },
        params.eventId,
        query
      );
      return event
        ? { event }
        : reply
            .status(404)
            .send({ error: "Captured event not found or not visible" });
    }
  );

  app.patch(
    "/v1/memory/graph/events/:eventId",
    { preHandler: memoryWriteRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = graphEventParamsSchema.parse(request.params);
      const input = graphEventPatchSchema.parse(request.body);
      const event = await repo.updateLcmGraphEvent(
        { userId: user.id },
        params.eventId,
        input
      );
      return event
        ? { event }
        : reply
            .status(404)
            .send({ error: "Captured event not found or not visible" });
    }
  );

  app.delete(
    "/v1/memory/graph/events/:eventId",
    { preHandler: memoryWriteRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = graphEventParamsSchema.parse(request.params);
      const deleted = await repo.invalidateLcmGraphEvent(
        { userId: user.id },
        params.eventId
      );
      return reply.status(deleted ? 200 : 404).send({ ok: deleted });
    }
  );

  app.get(
    "/v1/memory/export",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      return await repo.exportMemoryRecords({ userId: user.id });
    }
  );

  app.get(
    "/v1/memory/nodes/:nodeId",
    { preHandler: memoryReadRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const params = nodeIdParamsSchema.parse(request.params);
      const node = await repo.getLcmGraphNode(
        { userId: user.id },
        params.nodeId
      );

      return node
        ? { node }
        : reply
            .status(404)
            .send({ error: "Memory node not found or not visible" });
    }
  );

  app.patch(
    "/v1/memory/nodes/:nodeId",
    { preHandler: memoryWriteRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = nodeIdParamsSchema.parse(request.params);
      const input = updateMemorySchema.parse(request.body);
      const node =
        input.summaryText !== undefined || input.visibility !== undefined
          ? await repo.updateLcmGraphNode({ userId: user.id }, params.nodeId, {
              summaryText: input.summaryText,
              visibility: input.visibility
            })
          : null;
      const memory =
        input.pinned !== undefined
          ? await repo.updateMemoryPresentation(
              { userId: user.id },
              params.nodeId,
              { pinned: input.pinned }
            )
          : null;
      const result = node ?? memory;
      return result
        ? { node: node ?? undefined, memory: memory ?? undefined }
        : reply
            .status(404)
            .send({ error: "Memory node not found or not visible" });
    }
  );

  app.delete(
    "/v1/memory/nodes/:nodeId",
    { preHandler: memoryWriteRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = nodeIdParamsSchema.parse(request.params);
      const deleted = await repo.invalidateLcmGraphNode(
        { userId: user.id },
        params.nodeId
      );
      return reply.status(deleted ? 200 : 404).send({ ok: deleted });
    }
  );

  app.get(
    "/v1/memory/nodes/:nodeId/expand",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const params = nodeIdParamsSchema.parse(request.params);
      const expanded = await repo.expandMemoryNode(params.nodeId, {
        userId: user.id
      });

      return { expanded };
    }
  );
};
