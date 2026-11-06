// Sample capabilities for renderer tests and the Desktop validation entry.
import {
  codeDefaultAssignmentFor,
  documentDefault,
  environmentDefaultFor,
  localAiClientFlowKeys,
  memoryModelFlowKeys
} from "@koed/shared/ai-client-flow-defaults";
import type {
  LocalAiClientReadModel,
  MemoryModelInput
} from "../../../ipc/local-ai-client-protocol.js";
import { clients, type ClientId } from "./model.js";

const gpt = {
  model: "gpt-5.6-luna",
  displayName: "GPT-5.6 Luna",
  provider: "openai"
};
const sonnet = {
  model: "sonnet",
  displayName: "Sonnet",
  provider: "anthropic"
};
const fixtureModels = {
  codex: [gpt, { ...gpt, model: "gpt-6-luna", displayName: "GPT-6 Luna" }],
  claude: [sonnet, { ...sonnet, model: "haiku", displayName: "Haiku 5.5" }],
  pi: [gpt, sonnet]
};

export function memoryModelFixture(connected: () => readonly ClientId[]) {
  let settings: LocalAiClientReadModel["settings"] = [];
  const defaults = Object.fromEntries(
    localAiClientFlowKeys.map((key) => [
      key,
      environmentDefaultFor(
        key,
        documentDefault(codeDefaultAssignmentFor(key)),
        {
          MEMORY_LCM_SUMMARY_PROVIDER: "pi",
          MEMORY_LCM_SUMMARY_TIMEOUT_MS: "240000",
          MEMORY_LCM_SUMMARY_MAX_ATTEMPTS: "4"
        }
      )
    ])
  ) as LocalAiClientReadModel["defaults"];
  const read = (): LocalAiClientReadModel => {
    const instances = clients
      .filter((c) => connected().includes(c.id))
      .map((c) => ({
        instanceId: c.id + ".default",
        driverId: c.id,
        displayName: c.label,
        enabled: true
      }));
    return {
      instances,
      settings,
      defaults,
      capabilitySnapshots: instances.map((i) => ({
        instanceId: i.instanceId,
        healthState: "healthy",
        authenticationState: "authenticated",
        stale: false,
        observedAt: new Date().toISOString(),
        expiresAt: "2099-01-01T00:00:00Z",
        localSynthesis: { support: "supported", readiness: "ready" },
        models: fixtureModels[i.driverId].map((model) => {
          const fullId = model.provider + "/" + model.model;
          return {
            ...model,
            id: i.driverId === "pi" ? fullId : model.model,
            fullId,
            reasoningEfforts: ["low", "medium", "high"]
          };
        })
      }))
    };
  };
  return {
    list: async () => ({ operation: "list" as const, readModel: read() }),
    refresh: async () => ({ operation: "refresh" as const, readModel: read() }),
    setMemoryModel: async (input: MemoryModelInput) => {
      settings = memoryModelFlowKeys.map((flowKey) => ({
        flowKey,
        provider: input.provider,
        aiClientInstanceId: input.ai_client_instance_id,
        model: input.model,
        reasoningEffort: input.reasoning_effort,
        timeoutMs: input.limits[flowKey].timeout_ms,
        maxAttempts: input.limits[flowKey].max_attempts,
        createdAt: "",
        updatedAt: ""
      }));
      return { operation: "setMemoryModel" as const, readModel: read() };
    }
  };
}
