import type { FastifyInstance } from "fastify";
import { createEncryptedJsonPackage } from "@koed/shared";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import {
  canonicalEvidenceSourceIdentity,
  teamEvidenceSourceContract
} from "./evidence-source-contract.js";
import { rejectUnavailableTeamSharedMemorySurface } from "./team-shared-memory-surface.js";
import {
  clusterIdParamsSchema,
  clusterMemoriesQuerySchema,
  graphEventDetailQuerySchema,
  graphEventParamsSchema,
  graphEventPatchSchema,
  graphEventsQuerySchema,
  graphThreadIndexResponseSchema,
  graphSessionParamsSchema,
  graphSessionProjectPatchSchema,
  graphSessionTitlePatchSchema,
  graphNodesQuerySchema,
  graphQuerySchema,
  expandMemoryNodeQuerySchema,
  memoryBrowserQuerySchema,
  memoryClusterQuerySchema,
  nodeIdParamsSchema,
  updateMemorySchema
} from "./graph-schemas.js";
import {
  memoryAnswerAuthorizationBoundarySecret,
  verifyMemoryAnswerAuthorizationBoundary
} from "./memory-answer-authorization-boundary.js";

const hostedExportProfiles = new Set([
  "private_vps",
  "team_self_hosted",
  "koed_managed_cloud"
]);

const memoryExportQuerySchema = z.object({
  reason: z.string().trim().min(1).max(160).optional(),
  target: z.string().trim().min(1).max(160).optional(),
  expires_at: z.coerce.date().optional()
});

export const registerGraphRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    config,
    auth: {
      authenticate,
      authenticateApiToken,
      authenticateSessionOrDeviceCredential
    },
    graph: { cacheProvider, graphCacheTtlSeconds, hashCacheKey },
    encryption: { envelopeEncryptionProvider },
    rateLimit: {
      memoryRead: memoryReadRateLimit,
      memoryWrite: memoryWriteRateLimit
    }
  } = context;
  const authenticateGraphRead = async (
    request: Parameters<typeof authenticate>[0],
    teamWorkspaceId?: string
  ) =>
    teamWorkspaceId
      ? authenticateSessionOrDeviceCredential(request, "team_workspace_read")
      : authenticate(request);

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
      const query = graphNodesQuerySchema.parse(request.query);
      const user = await authenticateGraphRead(request, query.teamWorkspaceId);
      rejectUnavailableTeamSharedMemorySurface(query.teamWorkspaceId, "graph");
      const personalQuery = { ...query };
      delete personalQuery.teamWorkspaceId;
      const { ids, ...listQuery } = personalQuery;
      return {
        nodes: await repo.listLcmGraphNodes(
          { userId: user.id },
          {
            ...listQuery,
            nodeIds: ids
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
      const params = nodeIdParamsSchema.parse(request.params);
      const query = graphEventDetailQuerySchema.parse(request.query);
      const user = await authenticateGraphRead(request, query.teamWorkspaceId);
      rejectUnavailableTeamSharedMemorySurface(query.teamWorkspaceId, "graph");
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
      const query = graphEventsQuerySchema.parse(request.query);
      const user = await authenticateGraphRead(request, query.teamWorkspaceId);
      rejectUnavailableTeamSharedMemorySurface(query.teamWorkspaceId, "graph");
      const personalQuery = { ...query };
      delete personalQuery.teamWorkspaceId;
      return {
        events: await repo.listLcmGraphEvents(
          { userId: user.id },
          personalQuery
        )
      };
    }
  );

  app.get(
    "/v1/memory/graph/threads",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const query = graphQuerySchema.parse(request.query);
      const user = await authenticateGraphRead(request, query.teamWorkspaceId);
      rejectUnavailableTeamSharedMemorySurface(query.teamWorkspaceId, "graph");
      const personalQuery = { ...query };
      delete personalQuery.teamWorkspaceId;
      const cacheKey = `koed:graph:threads:${user.id}:${hashCacheKey(
        JSON.stringify(personalQuery)
      )}`;
      const cached = await cacheProvider.getJson<{ projects: unknown }>(
        cacheKey
      );
      if (cached) {
        return cached;
      }
      const response = graphThreadIndexResponseSchema.parse({
        projects: await repo.listLcmGraphThreads(
          { userId: user.id },
          personalQuery
        )
      });
      await cacheProvider.setJson(cacheKey, response, graphCacheTtlSeconds);
      return response;
    }
  );

  app.get(
    "/v1/memory/graph/events/:eventId",
    { preHandler: memoryReadRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const params = graphEventParamsSchema.parse(request.params);
      const query = graphEventDetailQuerySchema.parse(request.query);
      const user = await authenticateGraphRead(request, query.teamWorkspaceId);
      rejectUnavailableTeamSharedMemorySurface(query.teamWorkspaceId, "graph");
      const personalQuery = { ...query };
      delete personalQuery.teamWorkspaceId;
      const event = await repo.getLcmGraphEvent(
        { userId: user.id },
        params.eventId,
        personalQuery
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

  app.patch(
    "/v1/memory/graph/sessions/:sessionId/title",
    { preHandler: memoryWriteRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = graphSessionParamsSchema.parse(request.params);
      const input = graphSessionTitlePatchSchema.parse(request.body);
      const session = await repo.updateCapturedSessionTitle(
        { userId: user.id },
        params.sessionId,
        input
      );
      return session
        ? { session }
        : reply
            .status(404)
            .send({ error: "Captured session not found or not visible" });
    }
  );

  app.patch(
    "/v1/memory/graph/sessions/:sessionId/project",
    { preHandler: memoryWriteRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = graphSessionParamsSchema.parse(request.params);
      const input = graphSessionProjectPatchSchema.parse(request.body);
      const session =
        input.action === "move"
          ? await repo.moveCapturedSessionToProject(
              { userId: user.id },
              params.sessionId,
              input.project
            )
          : await repo.resetCapturedSessionProject(
              { userId: user.id },
              params.sessionId
            );
      if (!session) {
        return reply
          .status(404)
          .send({ error: "Captured session not found or not visible" });
      }
      await cacheProvider.deleteByPrefix("koed:graph:");
      return { session };
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
      const query = memoryExportQuerySchema.parse(request.query);
      if (
        hostedExportProfiles.has(config.deploymentProfile) &&
        !envelopeEncryptionProvider
      ) {
        throw Object.assign(
          new Error("Encrypted export package provider required"),
          { statusCode: 503 }
        );
      }
      const records = await repo.exportMemoryRecords({ userId: user.id });
      if (!envelopeEncryptionProvider) {
        return records;
      }
      const now = new Date();
      const expiresAt =
        query.expires_at ?? new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const reason = query.reason ?? "user_requested_export";
      const target = query.target ?? "self";
      const encryptedPackage = await createEncryptedJsonPackage(
        envelopeEncryptionProvider,
        {
          objectClass: "memory_export",
          payload: records,
          scope: {
            tenantId: user.id
          },
          provenance: {
            rowFamily: "memory_exports",
            sourceId: user.id
          },
          ciphertextLocation: "memory_export.payload",
          aad: {
            route: "/v1/memory/export",
            actorUserId: user.id,
            reason,
            target
          },
          metadata: {
            exportedAt: records.exportedAt,
            nodeCount: records.nodes.length,
            eventCount: records.events.length,
            actorUserId: user.id,
            reason,
            target,
            expiresAt: expiresAt.toISOString()
          },
          expiresAt,
          now
        }
      );
      await repo.recordAuditEvent({
        actorUserId: user.id,
        ownerUserId: user.id,
        visibility: "personal",
        action: "memory.export.created",
        targetTable: "memory_exports",
        targetId: encryptedPackage.manifest.packageId,
        metadata: {
          objectClass: encryptedPackage.manifest.objectClass,
          packageId: encryptedPackage.manifest.packageId,
          reason,
          target,
          expiresAt: encryptedPackage.manifest.expiresAt,
          nodeCount: records.nodes.length,
          eventCount: records.events.length,
          providerMode: encryptedPackage.manifest.payload.providerMode,
          keyId: encryptedPackage.manifest.payload.keyId,
          keyVersion: encryptedPackage.manifest.payload.keyVersion
        }
      });
      return encryptedPackage;
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
      const params = nodeIdParamsSchema.parse(request.params);
      const query = expandMemoryNodeQuerySchema.parse(request.query);
      const user = query.team_workspace_id
        ? await authenticateSessionOrDeviceCredential(
            request,
            "team_workspace_read"
          )
        : await authenticateApiToken(request);
      if (query.team_workspace_id) {
        const authorizationBoundary = query.authorization_boundary
          ? verifyMemoryAnswerAuthorizationBoundary({
              token: query.authorization_boundary,
              secret: memoryAnswerAuthorizationBoundarySecret(
                context.config.apiTokenPepper
              ),
              subjectUserId: user.id,
              teamWorkspaceId: query.team_workspace_id
            })
          : undefined;
        const expansion = await repo.expandAuthorizedSharedMemorySemanticItem(
          { userId: user.id },
          {
            teamWorkspaceId: query.team_workspace_id,
            candidateId: params.nodeId,
            searchDomain: query.search_domain,
            sessionId: query.session_id,
            projectId: query.project_id,
            recentDays: query.recent_days,
            sourceAfter: query.source_after?.toISOString(),
            sourceBefore: query.source_before?.toISOString(),
            authorizationBoundary
          }
        );
        return {
          expanded: expansion
            ? {
                nodeId: expansion.parent.candidateId,
                visibility: "team",
                freshness: expansion.parent.freshness,
                sourceTime: expansion.parent.occurredAt,
                sourceRevision: expansion.parent.sourceRevision,
                visibilityProvenance: {
                  shareGrantId: expansion.parent.shareGrantId,
                  representationId: expansion.parent.representationId,
                  representation: expansion.parent.representation,
                  provenanceHash: expansion.parent.provenanceHash
                },
                generation: {
                  representationPolicyRevision:
                    expansion.parent.representationPolicyRevision,
                  contentPolicyVersion: expansion.parent.contentPolicyVersion,
                  classifierVersion: expansion.parent.classifierVersion,
                  embeddingModel: expansion.parent.embeddingModel,
                  embeddingDimensions: expansion.parent.embeddingDimensions,
                  embeddingVersion: expansion.parent.embeddingVersion
                },
                sourceItems: expansion.items.map((item, position) => {
                  const sourceType =
                    item.itemType === "lcm_leaf" ||
                    item.itemType === "lcm_rollup"
                      ? "memory_node"
                      : "memory_event";
                  return {
                    kind:
                      sourceType === "memory_node"
                        ? "lcm_child"
                        : "memory_event",
                    sourceTable: "team_memory_representations",
                    sourceId: item.pseudonymousSourceId,
                    canonicalSourceIdentity: canonicalEvidenceSourceIdentity(
                      sourceType,
                      item.pseudonymousSourceId,
                      item.sourceChunkIndex
                    ),
                    visibility: "team",
                    createdAt: item.occurredAt,
                    text: item.text,
                    position,
                    payload: {
                      representation: expansion.parent.representation,
                      sourceRevision: expansion.parent.sourceRevision,
                      freshness: expansion.parent.freshness,
                      provenanceHash: expansion.parent.provenanceHash,
                      representationPolicyRevision:
                        expansion.parent.representationPolicyRevision,
                      contentPolicyVersion:
                        expansion.parent.contentPolicyVersion,
                      classifierVersion: expansion.parent.classifierVersion,
                      embeddingVersion: expansion.parent.embeddingVersion,
                      sourceContract: teamEvidenceSourceContract(
                        sourceType === "memory_node"
                          ? "lcm_leaves"
                          : "memory_events"
                      )
                    }
                  };
                }),
                sources: []
              }
            : null
        };
      }
      const expanded = await repo.expandMemoryNode(
        params.nodeId,
        {
          userId: user.id
        },
        {
          searchDomain: query.search_domain,
          sessionId: query.session_id,
          projectId: query.project_id,
          recentDays: query.recent_days,
          sourceAfter: query.source_after?.toISOString(),
          sourceBefore: query.source_before?.toISOString()
        }
      );

      return { expanded };
    }
  );
};
