import { aiClientModelLabel } from "@koed/shared/ai-client-contract";
import type {
  LocalAiClientAssignment,
  LocalAiClientFlowKey,
  LocalAiClientResponse
} from "../../../ipc/local-ai-client-protocol.js";

export type ReadModel = LocalAiClientResponse["readModel"];
export type Draft = LocalAiClientAssignment;
export type FlowState = {
  pending: boolean;
  error: string | null;
  saved: boolean;
  dirty: boolean;
};
export type Flow = {
  key: LocalAiClientFlowKey;
  label: string;
  description: string;
};

export const flows: readonly Flow[] = [
  {
    key: "mcp_memory_answer",
    label: "Memory Answer",
    description:
      "Sets the agent, model, and reasoning effort for answers from recalled evidence."
  },
  {
    key: "lcm_summary",
    label: "LCM Summary",
    description:
      "Sets the agent, model, and reasoning effort for summaries of stored memory."
  },
  {
    key: "session_title",
    label: "Session Title",
    description:
      "Sets the agent, model, and reasoning effort for titles of captured sessions."
  },
  {
    key: "curated_memory_review",
    label: "Curated Memory Review",
    description:
      "Sets the agent, model, and reasoning effort for reviews of Curated Memory proposals."
  }
];

export const emptyFlowStates = (): Record<LocalAiClientFlowKey, FlowState> =>
  Object.fromEntries(
    flows.map(({ key }) => [
      key,
      { pending: false, error: null, saved: false, dirty: false }
    ])
  ) as Record<LocalAiClientFlowKey, FlowState>;

export const modelId = (
  model: ReadModel["capabilitySnapshots"][number]["models"][number]
): string => model.id;

export const modelLabel = (
  model: ReadModel["capabilitySnapshots"][number]["models"][number]
): string => aiClientModelLabel({ ...model, id: model.fullId });

export const modelMatches = (
  model: ReadModel["capabilitySnapshots"][number]["models"][number],
  candidate: string
): boolean =>
  [model.id, model.fullId, model.model].some((value) => value === candidate);

export const snapshotFor = (readModel: ReadModel, instanceId: string) =>
  readModel.capabilitySnapshots.find(
    (snapshot) => snapshot.instanceId === instanceId
  );

export const statusFor = (readModel: ReadModel, instanceId: string) => {
  const instance = readModel.instances.find(
    (candidate) => candidate.instanceId === instanceId
  );
  if (!instance) return { available: false, text: "instance unavailable" };
  if (!instance.enabled) return { available: false, text: "disabled" };
  const snapshot = snapshotFor(readModel, instanceId);
  if (!snapshot)
    return { available: false, text: "missing capability snapshot" };
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (
    snapshot.stale ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now()
  ) {
    return {
      available: false,
      text: snapshot.stale
        ? "stale capability snapshot"
        : "invalid capability snapshot"
    };
  }
  if (snapshot.authenticationState !== "authenticated") {
    return { available: false, text: `auth ${snapshot.authenticationState}` };
  }
  if (snapshot.healthState !== "healthy") {
    return { available: false, text: `health ${snapshot.healthState}` };
  }
  if (
    snapshot.localSynthesis.support !== "supported" ||
    snapshot.localSynthesis.readiness !== "ready"
  ) {
    return { available: false, text: "local synthesis unavailable" };
  }
  return { available: true, text: "ready" };
};

export const assignmentStatusFor = (
  readModel: ReadModel,
  draft: Draft,
  selectedModel:
    | ReadModel["capabilitySnapshots"][number]["models"][number]
    | undefined
) => {
  const instanceStatus = statusFor(readModel, draft.ai_client_instance_id);
  if (!instanceStatus.available) return instanceStatus;
  const instance = readModel.instances.find(
    (candidate) => candidate.instanceId === draft.ai_client_instance_id
  );
  if (instance?.driverId !== draft.provider) {
    return {
      available: false,
      text: `provider mismatch (${instance?.driverId})`
    };
  }
  if (!selectedModel)
    return { available: false, text: `missing model ${draft.model}` };
  const modelHasNoReasoningEfforts =
    selectedModel.reasoningEfforts.length === 0;
  const reasoningEffortValid = modelHasNoReasoningEfforts
    ? draft.reasoning_effort === "none"
    : selectedModel.reasoningEfforts.includes(draft.reasoning_effort);
  if (!reasoningEffortValid) {
    return {
      available: false,
      text: `unsupported reasoning effort ${draft.reasoning_effort}`
    };
  }
  return instanceStatus;
};

export const assignmentFrom = (
  readModel: ReadModel,
  flowKey: LocalAiClientFlowKey
): Draft | null => {
  const setting = readModel.settings.find((item) => item.flowKey === flowKey);
  if (setting) {
    const reportedModel = snapshotFor(
      readModel,
      setting.aiClientInstanceId
    )?.models.find((model) => modelMatches(model, setting.model));
    return {
      provider: setting.provider,
      ai_client_instance_id: setting.aiClientInstanceId,
      model: reportedModel ? modelId(reportedModel) : setting.model,
      reasoning_effort: setting.reasoningEffort,
      timeout_ms: setting.timeoutMs,
      max_attempts: setting.maxAttempts
    };
  }
  return readModel.defaults[flowKey].assignment;
};

export const optionValue = (instanceId: string, model: string): string =>
  `${instanceId}\u0000${model}`;

const searchableModel = (
  model: ReadModel["capabilitySnapshots"][number]["models"][number]
): (string | null)[] => [
  model.provider,
  model.model,
  model.id,
  model.displayName,
  model.fullId,
  ...model.reasoningEfforts
];

export const searchableInstance = (
  instance: ReadModel["instances"][number],
  snapshot: ReadModel["capabilitySnapshots"][number] | undefined
): string =>
  [
    instance.instanceId,
    instance.driverId,
    instance.displayName,
    instance.enabled ? "enabled" : "disabled",
    snapshot?.authenticationState,
    snapshot?.healthState,
    snapshot?.observedAt,
    snapshot?.expiresAt,
    snapshot?.stale ? "stale" : "current",
    snapshot?.localSynthesis.support,
    snapshot?.localSynthesis.readiness,
    ...(snapshot?.models ?? []).flatMap(searchableModel)
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

export const searchableModelText = (
  model: ReadModel["capabilitySnapshots"][number]["models"][number]
): string => searchableModel(model).filter(Boolean).join(" ").toLowerCase();
