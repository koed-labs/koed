import type { MemorySourceRepository } from "@koed/db";
import {
  aiClientResourceCatalogSchema,
  aiClientResourceDiscoveryRunnerClaimPageSchema,
  aiClientResourceDiscoveryOperationSchema,
  type AiClientResourceCatalog,
  type AiClientResourceDiscoveryRunnerClaim
} from "@koed/shared";
import { fetchBoundedJsonObject, upstreamApiUrl } from "@koed/shared";

export interface AiClientResourceRunnerAuthority {
  claim(input: {
    runnerId: string;
    limit: number;
    leaseMs: number;
  }): Promise<AiClientResourceDiscoveryRunnerClaim[]>;
  heartbeat(
    claim: AiClientResourceDiscoveryRunnerClaim,
    runnerId: string,
    leaseMs: number
  ): Promise<boolean>;
  complete(
    claim: AiClientResourceDiscoveryRunnerClaim,
    runnerId: string,
    catalog: AiClientResourceCatalog
  ): Promise<void>;
  fail(
    claim: AiClientResourceDiscoveryRunnerClaim,
    runnerId: string,
    errorCode: string
  ): Promise<void>;
}

export const createAiClientResourceRunnerAuthority = (options: {
  repository: MemorySourceRepository;
  ownerUserId: string;
  deviceId: string;
  deploymentId: string;
  remote?: { baseUrl: string; authorization: string; fetch?: typeof fetch };
}): AiClientResourceRunnerAuthority => {
  const fetchFn = options.remote?.fetch ?? globalThis.fetch.bind(globalThis);
  const request = async (
    path: string,
    body: unknown
  ): Promise<Record<string, unknown>> => {
    if (!options.remote)
      throw new Error("AiClientResourceRemoteAuthorityRequired");
    const { response, payload } = await fetchBoundedJsonObject(
      fetchFn,
      upstreamApiUrl(options.remote.baseUrl, path),
      {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: options.remote.authorization,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      },
      { timeoutMs: 30_000, maxBytes: 1024 * 1024, readErrorBody: true }
    );
    if (!response.ok)
      throw Object.assign(
        new Error(
          typeof payload.error === "string"
            ? payload.error
            : "AI Client resource authority failed"
        ),
        { statusCode: response.status }
      );
    return payload;
  };
  return {
    async claim(input) {
      const result = options.remote
        ? aiClientResourceDiscoveryRunnerClaimPageSchema.parse(
            await request(
              "/v1/ai-client-resources/runner/operations/claim",
              input
            )
          )
        : {
            operations:
              await options.repository.claimAiClientResourceDiscoveryOperations(
                {
                  ownerUserId: options.ownerUserId,
                  deploymentId: options.deploymentId,
                  deviceId: options.deviceId,
                  ...input
                }
              )
          };
      return result.operations;
    },
    async heartbeat(claim, runnerId, leaseMs) {
      const body = {
        runnerId,
        leaseToken: claim.leaseToken,
        revision: claim.revision,
        leaseMs
      };
      if (options.remote) {
        const result = await request(
          `/v1/ai-client-resources/runner/operations/${encodeURIComponent(claim.operationId)}/heartbeat`,
          body
        );
        return result.accepted === true;
      }
      return options.repository.heartbeatAiClientResourceDiscoveryOperation({
        operationId: claim.operationId,
        ownerUserId: options.ownerUserId,
        deploymentId: options.deploymentId,
        deviceId: options.deviceId,
        ...body
      });
    },
    async complete(claim, runnerId, catalog) {
      const body = {
        runnerId,
        leaseToken: claim.leaseToken,
        revision: claim.revision,
        catalog: aiClientResourceCatalogSchema.parse(catalog)
      };
      const result = options.remote
        ? await request(
            `/v1/ai-client-resources/runner/operations/${encodeURIComponent(claim.operationId)}/complete`,
            body
          )
        : {
            operation:
              await options.repository.completeAiClientResourceDiscoveryOperation(
                {
                  operationId: claim.operationId,
                  ownerUserId: options.ownerUserId,
                  deploymentId: options.deploymentId,
                  deviceId: options.deviceId,
                  ...body
                }
              )
          };
      const operation = aiClientResourceDiscoveryOperationSchema.parse(
        result.operation
      );
      if (operation.state !== "completed")
        throw new Error("AiClientResourceCompletionRejected");
    },
    async fail(claim, runnerId, errorCode) {
      const body = {
        runnerId,
        leaseToken: claim.leaseToken,
        revision: claim.revision,
        errorCode
      };
      if (options.remote) {
        await request(
          `/v1/ai-client-resources/runner/operations/${encodeURIComponent(claim.operationId)}/fail`,
          body
        );
        return;
      }
      await options.repository.failAiClientResourceDiscoveryOperation({
        operationId: claim.operationId,
        ownerUserId: options.ownerUserId,
        deploymentId: options.deploymentId,
        deviceId: options.deviceId,
        ...body
      });
    }
  };
};
