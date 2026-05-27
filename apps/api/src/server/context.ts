import type { Visibility } from "@koed/core";
import type { MemorySourceRepository } from "@koed/db";
import type { AuthHelpers } from "../auth/session.js";
import type { CacheProvider } from "../infra/cache.js";
import type { RateLimitHandler, RateLimitName } from "../infra/rate-limit.js";
import type { EmbeddingSourceType, MemoryJobStatus } from "../memory/jobs.js";
import type { ApiServerConfig } from "./config.js";

export type CapturePolicy = Awaited<
  ReturnType<MemorySourceRepository["getEffectiveCapturePolicy"]>
>;

export interface ApiRouteContext {
  config: ApiServerConfig;
  requireRepository(): MemorySourceRepository;
  auth: AuthHelpers;
  rateLimit: Record<RateLimitName, RateLimitHandler>;
  jobs: {
    enqueueEmbedding(
      sourceType: EmbeddingSourceType,
      sourceId: string
    ): Promise<MemoryJobStatus>;
  };
  graph: {
    cacheProvider: CacheProvider;
    graphCacheTtlSeconds: number;
    hashCacheKey(value: string): string;
  };
  capture: {
    scheduleMemoryEventProcessing(
      repo: MemorySourceRepository,
      requesterContext: { userId: string },
      eventId: string,
      visibility: Visibility,
      teamId?: string
    ): Promise<{ embedding: MemoryJobStatus; compaction: MemoryJobStatus }>;
    scheduleProjectedMemoryEventProcessing(
      repo: MemorySourceRepository,
      requesterContext: { userId: string },
      scopes: Array<{
        eventId: string;
        visibility: Visibility;
        teamId: string | null;
      }>
    ): Promise<{
      embeddings: MemoryJobStatus[];
      compactions: MemoryJobStatus[];
    }>;
    resolveCapturePolicyForRequest(
      repo: MemorySourceRepository,
      requesterContext: { userId: string },
      input: { workspaceId?: string; sessionId?: string; threadId?: string }
    ): Promise<CapturePolicy>;
    rejectUnsupportedCapturePolicy(policy: { visibility: Visibility }): void;
  };
}
