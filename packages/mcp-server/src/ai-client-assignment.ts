import { aiClientCapabilityIds } from "@koed/shared";
import type {
  LocalMemoryAgentFlowKey,
  LocalMemoryAgentSettingRecord,
  MemoryApiClient
} from "./index.js";

export class AiClientAssignmentError extends Error {
  readonly code = "ai_client_assignment_unavailable";
}

interface AssignedInstance {
  instanceId: string;
  driverId: string;
  enabled: boolean;
  configIdentityHash?: string | null;
}

interface AssignedSnapshot {
  instanceId: string;
  installationIdentityHash?: string;
  healthState: string;
  authenticationState: string;
  models: Array<Record<string, unknown>>;
  capabilities: Record<string, unknown>;
  expiresAt: string;
  stale: boolean;
}

const blocked = (message: string): never => {
  throw new AiClientAssignmentError(message);
};

const modelId = (model: Record<string, unknown>): string | null => {
  for (const value of [model.fullId, model.id, model.model]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

const effortMetadata = (model: Record<string, unknown>): string[] | null => {
  if (!Array.isArray(model.supportedReasoningEfforts)) return null;
  const efforts = model.supportedReasoningEfforts.flatMap((candidate) => {
    if (typeof candidate === "string" && candidate.trim()) {
      return [candidate.trim()];
    }
    if (candidate && typeof candidate === "object") {
      const value = (candidate as Record<string, unknown>).reasoningEffort;
      return typeof value === "string" && value.trim() ? [value.trim()] : [];
    }
    return [];
  });
  return efforts.length > 0 ? efforts : null;
};

const requiredCapabilityForFlow: Record<
  LocalMemoryAgentFlowKey,
  keyof typeof aiClientCapabilityIds
> = {
  mcp_memory_answer: "localSynthesis",
  manual_memory_answer: "localSynthesis",
  lcm_summary: "localSynthesis",
  curated_memory_review: "localSynthesis",
  session_title: "localSynthesis"
};

const capabilityIsReady = (
  snapshot: AssignedSnapshot,
  flowKey: LocalMemoryAgentFlowKey
): boolean => {
  const descriptors = snapshot.capabilities.descriptors;
  if (!descriptors || typeof descriptors !== "object") return false;
  const capabilityId =
    aiClientCapabilityIds[requiredCapabilityForFlow[flowKey]];
  const descriptor = (descriptors as Record<string, unknown>)[capabilityId];
  if (!descriptor || typeof descriptor !== "object") return false;
  const value = descriptor as Record<string, unknown>;
  return value.support === "supported" && value.readiness === "ready";
};

const validateInstance = (
  setting: LocalMemoryAgentSettingRecord,
  instances: AssignedInstance[]
): void => {
  const instance = instances.find(
    (candidate) => candidate.instanceId === setting.aiClientInstanceId
  );
  if (!instance) {
    throw new AiClientAssignmentError(
      `AI Client instance "${setting.aiClientInstanceId}" is not configured`
    );
  }
  if (!instance.enabled) {
    blocked(`AI Client instance "${setting.aiClientInstanceId}" is disabled`);
  }
  if (instance.driverId !== setting.provider) {
    blocked(
      `AI Client instance "${setting.aiClientInstanceId}" belongs to driver "${instance.driverId}"`
    );
  }
};

const validateSnapshot = (
  setting: LocalMemoryAgentSettingRecord,
  instances: AssignedInstance[],
  snapshots: AssignedSnapshot[],
  now: number
): AssignedSnapshot => {
  const snapshot = snapshots.find(
    (candidate) => candidate.instanceId === setting.aiClientInstanceId
  );
  const instance = instances.find(
    (candidate) => candidate.instanceId === setting.aiClientInstanceId
  );
  if (
    !snapshot ||
    snapshot.stale ||
    Date.parse(snapshot.expiresAt) <= now ||
    !instance ||
    !instance.configIdentityHash ||
    !snapshot.installationIdentityHash ||
    snapshot.installationIdentityHash !== instance.configIdentityHash
  ) {
    throw new AiClientAssignmentError(
      `AI Client instance "${setting.aiClientInstanceId}" capability snapshot is stale or unavailable`
    );
  }
  if (
    snapshot.healthState !== "healthy" ||
    snapshot.authenticationState !== "authenticated"
  ) {
    blocked(
      `AI Client instance "${setting.aiClientInstanceId}" is not healthy and authenticated`
    );
  }
  if (!capabilityIsReady(snapshot, setting.flowKey)) {
    const capabilityId =
      aiClientCapabilityIds[requiredCapabilityForFlow[setting.flowKey]];
    blocked(
      `AI Client instance "${setting.aiClientInstanceId}" does not report ready ${capabilityId.replaceAll("_", " ")} for ${setting.flowKey}`
    );
  }
  return snapshot;
};

const validateModel = (
  setting: LocalMemoryAgentSettingRecord,
  snapshot: AssignedSnapshot
): void => {
  const selectedModel = snapshot.models.find(
    (candidate) => modelId(candidate) === setting.model
  );
  if (!selectedModel) {
    throw new AiClientAssignmentError(
      `Model "${setting.model}" is not reported for AI Client instance "${setting.aiClientInstanceId}"`
    );
  }
  const efforts = effortMetadata(selectedModel);
  if (!efforts || !efforts.includes(setting.reasoningEffort)) {
    blocked(
      `Reasoning effort "${setting.reasoningEffort}" is not reported for model "${setting.model}" on AI Client instance "${setting.aiClientInstanceId}"`
    );
  }
};

const validateAssignment = (
  setting: LocalMemoryAgentSettingRecord,
  instances: AssignedInstance[],
  snapshots: AssignedSnapshot[],
  now = Date.now()
): void => {
  validateInstance(setting, instances);
  const snapshot = validateSnapshot(setting, instances, snapshots, now);
  validateModel(setting, snapshot);
};

export const resolveLocalMemoryAgentConfig = async <T>(input: {
  client: Pick<
    MemoryApiClient,
    "listLocalMemoryAgentSettings" | "listAiClientInstances"
  >;
  flowKey: LocalMemoryAgentFlowKey;
  fallback: () => T;
  fromSetting: (setting: LocalMemoryAgentSettingRecord) => T;
}): Promise<T> => {
  let settings: { settings: LocalMemoryAgentSettingRecord[] };
  try {
    settings = await input.client.listLocalMemoryAgentSettings();
  } catch (error) {
    throw new AiClientAssignmentError(
      `AI Client settings API failed; assigned ${input.flowKey} flow cannot be resolved`,
      { cause: error }
    );
  }
  const setting = settings.settings.find(
    (candidate) => candidate.flowKey === input.flowKey
  );
  if (!setting) return input.fallback();
  let current: Awaited<ReturnType<MemoryApiClient["listAiClientInstances"]>>;
  try {
    current = await input.client.listAiClientInstances();
  } catch (error) {
    throw new AiClientAssignmentError(
      `AI Client capability API failed; assigned ${input.flowKey} flow cannot be revalidated`,
      { cause: error }
    );
  }
  validateAssignment(setting, current.instances, current.capabilitySnapshots);
  return input.fromSetting(setting);
};
