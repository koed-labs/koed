import type { Visibility } from "@koed/core";
import type { MemorySourceRepository } from "@koed/db";
import type {
  DeviceIdentityInspection,
  EnvelopeEncryptionProvider,
  KoedWorkClass
} from "@koed/shared";
import type { AuthHelpers } from "../auth/session.js";
import type { CacheProvider } from "../infra/cache.js";
import type { RateLimitHandler, RateLimitName } from "../infra/rate-limit.js";
import type { EmbeddingSourceType, MemoryJobStatus } from "../memory/jobs.js";
import type { ApiServerConfig } from "./config.js";
import type { WorkosAuthKitClient } from "../auth/workos.js";
import type { CollaborationAdmissionController } from "../collaboration/admission.js";
import type { CollaborationActionGrantControl } from "../local-edge/collaboration-action-grant-control.js";
import type { CollaborationActionGrantLifecycle } from "../local-edge/collaboration-action-grant-lifecycle.js";
import type { CollaborationSharedMemoryControl } from "../local-edge/collaboration-shared-memory-control.js";
import type {
  PdsAuthoritySigner,
  PdsRemoteAccountLinkVerifier
} from "../personal-device-sync/index.js";
import type { PdsSecureKeyProvider } from "../personal-device-sync/local-source.js";

export type CapturePolicy = Awaited<
  ReturnType<MemorySourceRepository["getEffectiveCapturePolicy"]>
>;

export interface ApiRouteContext {
  config: ApiServerConfig;
  requireRepository(): MemorySourceRepository;
  auth: AuthHelpers;
  rateLimit: Record<RateLimitName, RateLimitHandler>;
  collaboration: {
    admission: CollaborationAdmissionController;
    actionGrantLifecycle?: CollaborationActionGrantLifecycle;
    actionGrantControl?: CollaborationActionGrantControl;
    sharedMemoryControl?: CollaborationSharedMemoryControl;
    subscribeNavigationInvalidation?: (
      listener: (backendId: string) => void
    ) => () => void;
  };
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
  encryption: {
    envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  };
  capture: {
    scheduleMemoryEventProcessing(
      repo: MemorySourceRepository,
      requesterContext: { userId: string },
      eventId: string,
      visibility: Visibility
    ): Promise<{ embedding: MemoryJobStatus; compaction: MemoryJobStatus }>;
    scheduleProjectedMemoryEventProcessing(
      repo: MemorySourceRepository,
      requesterContext: { userId: string },
      scopes: Array<{
        eventId: string;
        visibility: Visibility;
        includeInEmbedding: boolean;
        includeInLcm: boolean;
        workClass: KoedWorkClass;
      }>
    ): Promise<{
      embeddings: MemoryJobStatus[];
      compactions: MemoryJobStatus[];
    }>;
    resolveCapturePolicyForRequest(
      repo: MemorySourceRepository,
      requesterContext: { userId: string },
      input: { projectId?: string; sessionId?: string; threadId?: string }
    ): Promise<CapturePolicy>;
    rejectUnsupportedCapturePolicy(policy: { visibility: Visibility }): void;
  };
  deploymentIdentity: {
    inspect(): DeviceIdentityInspection;
  };
  managedConversations: {
    commandWakePool: {
      connect(): Promise<{
        query(sql: string): Promise<unknown>;
        on(
          event: "notification",
          listener: (message: { channel: string; payload?: string }) => void
        ): void;
        on(event: "error", listener: (error: unknown) => void): void;
        removeAllListeners(event?: "notification" | "error"): void;
        release(): void;
      }>;
    } | null;
  };
  localEdge: {
    upstreamBackendsPath: string;
    remoteOperationsAllowed(): boolean;
    fetch: typeof fetch;
    resolveUpstreamAuthorization(backend: {
      id: string;
      credential?: { status?: string; reference?: string };
    }): string | null;
    resolveUpstreamEnrollmentBinding(backendId: string): {
      backendId: string;
      enrollmentId: string;
      deviceCredentialId: string;
      principalUserId: string;
    } | null;
  };
  workos: {
    client: WorkosAuthKitClient;
  };
  personalDeviceSync: {
    /** Missing or malformed signer keeps all PDS governance routes unavailable. */
    authoritySigner: PdsAuthoritySigner | null;
    remoteAccountLinkVerifier: PdsRemoteAccountLinkVerifier | null;
    /** Optional secure runtime integration. Absence disables PDS publication only. */
    secureKeyProvider: PdsSecureKeyProvider | null;
    wakePool: ApiRouteContext["managedConversations"]["commandWakePool"];
  };
}
