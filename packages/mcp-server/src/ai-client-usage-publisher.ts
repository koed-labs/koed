import type { MemoryApiClient } from "./index.js";
import { tmpdir } from "node:os";
import type { LocalAiClientInstanceConfiguration } from "./ai-client-instance-registry.js";
import { environmentForLocalAiClientInstance } from "./ai-client-instance-registry.js";
import {
  probeCodexAppServerUsage,
  type CodexUsageProbeResult
} from "./codex-app-server-runner.js";
import { resolveKoedHome } from "./local-runtime-protocol.js";
import {
  aiClientProfileScopeHash,
  codexAccountIdentity,
  codexUsageReadings,
  hashAiClientAccountIdentity,
  usageReadingPayload
} from "./ai-client-usage-readers.js";

export type UsageProbeOutcome = "checked" | "failed" | "unsupported";

/** Bounded official-source read; the caller schedules it after publication. */
export const publishCodexUsage = async (
  apiClient: MemoryApiClient,
  instance: LocalAiClientInstanceConfiguration,
  environment: NodeJS.ProcessEnv,
  probeOnTurnClient?: () => Promise<CodexUsageProbeResult>
): Promise<UsageProbeOutcome> => {
  const observedAt = new Date().toISOString();
  const profileScopeHash = aiClientProfileScopeHash(
    resolveKoedHome(environment)
  );
  const instanceEnvironment = environmentForLocalAiClientInstance({
    instance,
    driverId: "codex",
    env: environment
  });
  const probe = probeOnTurnClient
    ? await probeOnTurnClient()
    : await probeCodexAppServerUsage({
        appServerBinary: instance.executablePath,
        model: instanceEnvironment.MEMORY_CODEX_MODEL ?? "gpt-5.6-luna",
        cwd: tmpdir(),
        env: instanceEnvironment
      });
  if (probe.outcome !== "checked") {
    await apiClient.publishAiClientUsageCompletion(instance.instanceId, {
      outcome: probe.outcome,
      profile_scope_hash: profileScopeHash,
      observed_at: observedAt
    });
    return probe.outcome;
  }
  const before = codexAccountIdentity(probe.before);
  const after = codexAccountIdentity(probe.after);
  const responseAccountId =
    typeof probe.limits.accountId === "string" ? probe.limits.accountId : null;
  const access = await apiClient.accessCheck();
  const identity =
    before && after && before === after
      ? JSON.stringify([before, responseAccountId])
      : null;
  const accountIdentityHash = hashAiClientAccountIdentity(
    {
      ownerId: access.user.id,
      backendId: apiClient.config.apiUrl,
      profileId: resolveKoedHome(environment),
      instanceId: instance.instanceId,
      provider: "codex"
    },
    identity
  );
  const binding = await apiClient.bindAiClientUsageAccount(
    instance.instanceId,
    {
      account_identity_hash: accountIdentityHash,
      profile_scope_hash: profileScopeHash,
      observed_at: observedAt
    }
  );
  if (!binding.accepted || !accountIdentityHash) return "unsupported";
  const readings = codexUsageReadings(probe.limits, {
    instanceId: instance.instanceId,
    accountIdentityHash,
    observedAt
  });
  if (readings.length === 0) {
    await apiClient.publishAiClientUsageCompletion(instance.instanceId, {
      outcome: "unsupported",
      profile_scope_hash: profileScopeHash,
      observed_at: observedAt
    });
    return "unsupported";
  }
  const { snapshots } = await apiClient.recordAiClientUsageSnapshots(
    instance.instanceId,
    {
      account_identity_hash: accountIdentityHash,
      profile_scope_hash: profileScopeHash,
      observed_at: observedAt,
      readings: readings.map(usageReadingPayload)
    }
  );
  return snapshots.length ? "checked" : "unsupported";
};
