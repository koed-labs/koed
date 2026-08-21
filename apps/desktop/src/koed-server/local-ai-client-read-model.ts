import {
  localAiClientDefaultSchema,
  localAiClientFlowKeys,
  localAiClientReadModelSchema,
  localAiClientRuntimeAssignmentSchema,
  type LocalAiClientFlowKey,
  type LocalAiClientReadModel
} from "../ipc/local-ai-client-protocol.js";
import { environmentDefaultFor } from "./local-ai-client-defaults.js";

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const provider = (value: unknown): "codex" | "claude" | "pi" | null =>
  value === "codex" || value === "claude" || value === "pi" ? value : null;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

const readInstances = (value: unknown) =>
  Array.isArray(value)
    ? value.flatMap((candidate) => {
        const item = objectValue(candidate);
        const driverId = provider(item?.driverId);
        const instanceId = text(item?.instanceId);
        if (!item || !driverId || !instanceId) return [];
        return [
          {
            instanceId,
            driverId,
            displayName: text(item.displayName) ?? instanceId,
            enabled: item.enabled === true
          }
        ];
      })
    : [];

const readReasoningEfforts = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((candidate) => {
        if (typeof candidate === "string") return [candidate];
        return [text(objectValue(candidate)?.reasoningEffort)].filter(
          (effort): effort is string => effort !== null
        );
      })
    : [];

const readModels = (value: unknown) =>
  Array.isArray(value)
    ? value.flatMap((candidate) => {
        const item = objectValue(candidate);
        const provider = text(item?.provider);
        const model = text(item?.model);
        const composedFullId = [provider, model].filter(Boolean).join("/");
        const fullId = text(item?.fullId) ?? (composedFullId || text(item?.id));
        const id = text(item?.id) ?? fullId;
        if (!item || !id || !fullId) return [];
        return [
          {
            id,
            displayName: text(item.displayName),
            provider,
            model,
            fullId,
            reasoningEfforts: readReasoningEfforts(
              item.supportedReasoningEfforts
            )
          }
        ];
      })
    : [];

const readSnapshots = (value: unknown) =>
  Array.isArray(value)
    ? value.flatMap((candidate) => {
        const item = objectValue(candidate);
        const instanceId = text(item?.instanceId);
        if (!item || !instanceId) return [];
        const capabilities = objectValue(item.capabilities);
        const descriptors = objectValue(capabilities?.descriptors);
        const synthesis = objectValue(descriptors?.local_synthesis);
        const managedDescriptor = (id: string) =>
          objectValue(descriptors?.[id]);
        const managedStart = managedDescriptor("managed_conversation_start");
        const managedResume = managedDescriptor("managed_conversation_resume");
        const managedSend = managedDescriptor("managed_conversation_send");
        const managedHandoff = managedDescriptor("handoff");
        const managedFork = managedDescriptor("fork");
        return [
          {
            instanceId,
            authenticationState: readAuthentication(item.authenticationState),
            healthState: readHealth(item.healthState),
            models: readModels(item.models),
            localSynthesis: {
              support: readSupport(synthesis?.support),
              readiness: readReadiness(synthesis?.readiness)
            },
            managedConversationStart: {
              support: readSupport(managedStart?.support),
              readiness: readReadiness(managedStart?.readiness)
            },
            managedConversationResume: {
              support: readSupport(managedResume?.support),
              readiness: readReadiness(managedResume?.readiness)
            },
            managedConversationSend: {
              support: readSupport(managedSend?.support),
              readiness: readReadiness(managedSend?.readiness)
            },
            managedConversationHandoff: {
              support: readSupport(managedHandoff?.support),
              readiness: readReadiness(managedHandoff?.readiness)
            },
            managedConversationFork: {
              support: readSupport(managedFork?.support),
              readiness: readReadiness(managedFork?.readiness)
            },
            observedAt: text(item.observedAt) ?? "",
            expiresAt: text(item.expiresAt) ?? "",
            stale: item.stale === true
          }
        ];
      })
    : [];

const readAuthentication = (value: unknown) =>
  value === "authenticated" || value === "unauthenticated" ? value : "unknown";
const readHealth = (value: unknown) =>
  value === "healthy" ||
  value === "unavailable" ||
  value === "incompatible" ||
  value === "error"
    ? value
    : "unavailable";
const readSupport = (value: unknown) =>
  value === "supported" || value === "unsupported" ? value : "unknown";
const readReadiness = (value: unknown) =>
  value === "ready" || value === "not_ready" ? value : "unknown";

const readSettings = (value: unknown) =>
  Array.isArray(value)
    ? value.flatMap((candidate) => {
        const item = objectValue(candidate);
        if (
          !item ||
          !localAiClientFlowKeys.includes(item.flowKey as LocalAiClientFlowKey)
        )
          return [];
        const assignment = localAiClientRuntimeAssignmentSchema.safeParse({
          provider: item.provider,
          ai_client_instance_id: item.aiClientInstanceId,
          model: item.model,
          reasoning_effort: item.reasoningEffort,
          timeout_ms: item.timeoutMs,
          max_attempts: item.maxAttempts
        });
        if (!assignment.success) return [];
        return [
          {
            flowKey: item.flowKey,
            provider: assignment.data.provider,
            aiClientInstanceId: assignment.data.ai_client_instance_id,
            model: assignment.data.model,
            reasoningEffort: assignment.data.reasoning_effort,
            timeoutMs: assignment.data.timeout_ms,
            maxAttempts: assignment.data.max_attempts,
            createdAt: text(item.createdAt) ?? "",
            updatedAt: text(item.updatedAt) ?? ""
          }
        ];
      })
    : [];

const readDocumentedDefault = (value: unknown) => {
  const item = objectValue(value);
  const assignment = objectValue(item?.assignment) ?? item;
  const parsed = localAiClientRuntimeAssignmentSchema.safeParse({
    provider: assignment?.provider,
    ai_client_instance_id:
      assignment?.ai_client_instance_id ?? assignment?.aiClientInstanceId,
    model: assignment?.model,
    reasoning_effort:
      assignment?.reasoning_effort ?? assignment?.reasoningEffort,
    timeout_ms: assignment?.timeout_ms ?? assignment?.timeoutMs,
    max_attempts: assignment?.max_attempts ?? assignment?.maxAttempts
  });
  if (item?.source !== "code" || item.available !== true || !parsed.success)
    return undefined;
  return localAiClientDefaultSchema.parse({
    source: "code",
    available: true,
    persistable: item.persistable !== false,
    assignment: parsed.data,
    reason: typeof item.reason === "string" ? item.reason : null
  });
};

export const readLocalAiClientReadModel = (
  payload: Record<string, unknown>,
  environment: NodeJS.ProcessEnv
): LocalAiClientReadModel => {
  const rawDefaults = objectValue(payload.defaults) ?? {};
  const defaults = Object.fromEntries(
    localAiClientFlowKeys.map((flowKey) => [
      flowKey,
      environmentDefaultFor(
        flowKey,
        readDocumentedDefault(rawDefaults[flowKey]),
        environment
      )
    ])
  );
  return localAiClientReadModelSchema.parse({
    instances: readInstances(payload.instances),
    capabilitySnapshots: readSnapshots(payload.capabilitySnapshots),
    settings: readSettings(payload.settings),
    defaults
  });
};
