import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiRouteContext } from "../server/context.js";
import {
  hostedPersonalSemanticImportIsCurrent,
  registerConversationSourceReplicationRoutes
} from "./routes.js";

const deploymentId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";

const contract = {
  artifactClass: "memory_embedding/v1" as const,
  modelKey: "qwen3-0.6b",
  modelArtifactHash: "a".repeat(64),
  dimensions: "1024",
  tokenizer: "qwen3-embedding-0.6b-gguf",
  inputTransform: "qwen3-retrieval-document-v1",
  pooling: "last",
  normalization: "l2",
  embeddingVersion: "qwen3-0.6b"
};

const recipientKey = {
  algorithm: "RSA-OAEP-SHA256" as const,
  keyId: "recipient-key",
  keyVersion: 1,
  publicJwk: {
    kty: "RSA" as const,
    n: "test-modulus",
    e: "AQAB",
    alg: "RSA-OAEP-256" as const,
    key_ops: ["encrypt"] as ["encrypt"],
    ext: true as const,
    kid: "recipient-key",
    use: "enc" as const
  }
};

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const appFor = (input: {
  profile: "team_self_hosted" | "local_personal";
  repository: Record<string, unknown>;
}) => {
  const app = Fastify();
  apps.push(app);
  const authenticateDeviceCredential = vi.fn(
    async (request: { headers: Record<string, unknown> }) => {
      if (
        !String(request.headers.authorization ?? "").startsWith("Koed-Device ")
      ) {
        throw Object.assign(new Error("Device credential required"), {
          statusCode: 401
        });
      }
      return {
        user: { id: userId },
        credential: {
          operationFamilies: ["sync"],
          metadata: { protocolDeploymentId: deploymentId },
          deviceInstanceId: "device-1"
        }
      };
    }
  );
  const context = {
    config: { deploymentProfile: input.profile },
    requireRepository: () => input.repository,
    rateLimit: new Proxy({}, { get: () => async () => undefined }),
    auth: {
      authenticateDeviceCredential,
      authenticateApiToken: vi.fn(async () => ({ id: userId })),
      authenticateSession: vi.fn()
    },
    localEdge: {
      upstreamBackendsPath: "/tmp/no-upstreams.json",
      remoteOperationsAllowed: () => true,
      fetch,
      resolveUpstreamAuthorization: () => null
    }
  } as unknown as ApiRouteContext;
  registerConversationSourceReplicationRoutes(app, context);
  return { app, authenticateDeviceCredential };
};

describe("Personal semantic artifact authority routes", () => {
  it("requires a sync-capable device credential, not a personal API Token", async () => {
    const { app } = appFor({
      profile: "team_self_hosted",
      repository: { resolvePersonalEmbeddingArtifact: vi.fn() }
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/personal-semantic-artifacts/resolve",
      headers: { authorization: "Bearer personal-api-token" },
      payload: {
        sourceType: "memory_event",
        sourceContentHash: "A".repeat(43),
        contract,
        targetDeploymentId: deploymentId,
        recipientKey
      }
    });
    expect(response.statusCode).toBe(401);
  });

  it("binds the encrypted artifact recipient to the enrolled deployment", async () => {
    const resolvePersonalEmbeddingArtifact = vi.fn();
    const { app } = appFor({
      profile: "team_self_hosted",
      repository: { resolvePersonalEmbeddingArtifact }
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/personal-semantic-artifacts/resolve",
      headers: { authorization: "Koed-Device key:secret" },
      payload: {
        sourceType: "memory_event",
        sourceContentHash: "A".repeat(43),
        contract,
        targetDeploymentId: "00000000-0000-4000-8000-000000000099",
        recipientKey
      }
    });
    expect(response.statusCode).toBe(403);
    expect(resolvePersonalEmbeddingArtifact).not.toHaveBeenCalled();
  });

  it("returns only the authenticated owner's compatible artifact state", async () => {
    const resolvePersonalEmbeddingArtifact = vi.fn().mockResolvedValue(null);
    const { app } = appFor({
      profile: "team_self_hosted",
      repository: { resolvePersonalEmbeddingArtifact }
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/personal-semantic-artifacts/resolve",
      headers: { authorization: "Koed-Device key:secret" },
      payload: {
        sourceType: "memory_event",
        sourceContentHash: "A".repeat(43),
        contract,
        targetDeploymentId: deploymentId,
        recipientKey
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ state: "pending" });
    expect(resolvePersonalEmbeddingArtifact).toHaveBeenCalledWith(
      { userId },
      expect.objectContaining({
        sourceType: "memory_event",
        sourceContentHash: "A".repeat(43)
      })
    );
  });

  it("keeps local inference authoritative without explicit hosted source replication", async () => {
    const repository = {
      getEmbeddableSource: vi.fn().mockResolvedValue({
        sourceType: "memory_event",
        sourceId: "00000000-0000-4000-8000-000000000003",
        ownerUserId: userId,
        visibility: "personal",
        text: "Local Personal source",
        sourceHash: "source-hash"
      }),
      getPersonalSourceReplicationPolicy: vi.fn().mockResolvedValue(null)
    };
    const { app } = appFor({ profile: "local_personal", repository });
    const response = await app.inject({
      method: "POST",
      url: "/v1/personal-semantic-artifacts/import",
      headers: { authorization: "Bearer local-api-token" },
      payload: {
        sourceType: "memory_event",
        sourceId: "00000000-0000-4000-8000-000000000003",
        contract
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ state: "local_authority" });
  });

  it("rejects stale hosted completions after policy or source changes", () => {
    const policy = {
      enabled: true,
      mode: "hosted_personal",
      targetUpstreamId: "hosted-a",
      updatedAt: "2026-08-17T00:00:00.000Z"
    };
    const currentSource = { ownerUserId: userId, text: "stable source" };
    const sourceContentHash = "OIGclMW99jcc7PBQbTsTfMqcb21dcP9jbWP2BCnxYMc";
    const isCurrent = (overrides: Record<string, unknown> = {}) =>
      hostedPersonalSemanticImportIsCurrent({
        ownerUserId: userId,
        sourceContentHash,
        policySnapshot: policy,
        currentPolicy: policy,
        currentSource,
        ...overrides
      });

    expect(isCurrent()).toBe(true);
    expect(isCurrent({ currentPolicy: { ...policy, enabled: false } })).toBe(
      false
    );
    expect(
      isCurrent({
        currentPolicy: { ...policy, targetUpstreamId: "hosted-b" }
      })
    ).toBe(false);
    expect(
      isCurrent({
        currentPolicy: {
          ...policy,
          updatedAt: "2026-08-17T00:00:01.000Z"
        }
      })
    ).toBe(false);
    expect(
      isCurrent({ currentSource: { ...currentSource, text: "new source" } })
    ).toBe(false);
    expect(
      isCurrent({ currentSource: { ...currentSource, ownerUserId: "other" } })
    ).toBe(false);
  });
});
