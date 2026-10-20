import {
  agentsCommandChannel,
  agentsRequestSchema,
  agentsResultSchema,
  type AgentsDesktopApi,
  type AgentsRequest,
  type AgentsResult
} from "./agents-protocol.js";
import type { AgentCreate, AgentPatch } from "@koed/shared";

export const createAgentsPreloadApi = (
  invoke: (channel: string, request: AgentsRequest) => Promise<unknown>
): AgentsDesktopApi => {
  const command = async (request: AgentsRequest): Promise<AgentsResult> => {
    const result = agentsResultSchema.parse(
      await invoke(agentsCommandChannel, agentsRequestSchema.parse(request))
    );
    if (result.operation !== request.operation)
      throw new Error("Invalid Agents operation correlation.");
    return result;
  };
  return Object.freeze({
    delegations: async (projectId: string) => {
      const result = await command({ operation: "delegations", projectId });
      if (result.operation !== "delegations")
        throw new Error("Invalid Agent delegations result.");
      return result.items;
    },
    delegate: async (
      input: Omit<
        Extract<AgentsRequest, { operation: "delegate" }>,
        "operation"
      >
    ) => {
      const result = await command({ operation: "delegate", ...input });
      if (result.operation !== "delegate" || result.agentId !== input.agentId)
        throw new Error("Invalid Agent delegation result.");
      return result;
    },
    delegateCold: async (
      input: Omit<
        Extract<AgentsRequest, { operation: "delegateCold" }>,
        "operation"
      >
    ) => {
      const result = await command({ operation: "delegateCold", ...input });
      if (
        result.operation !== "delegateCold" ||
        result.agentId !== input.agentId
      )
        throw new Error("Invalid cold Agent delegation result.");
      return result;
    },
    list: async () => {
      const result = await command({ operation: "list" });
      if (result.operation !== "list")
        throw new Error("Invalid Agents list result.");
      return result.agents;
    },
    ensureChief: async () => {
      const result = await command({ operation: "ensureChief" });
      if (result.operation !== "ensureChief")
        throw new Error("Invalid Chief result.");
      return result.agent;
    },
    ensureHelpers: async () => {
      const result = await command({ operation: "ensureHelpers" });
      if (result.operation !== "ensureHelpers")
        throw new Error("Invalid Helper Agents result.");
      return result.agents;
    },
    create: async (agent: AgentCreate) => {
      const result = await command({ operation: "create", agent });
      if (result.operation !== "create")
        throw new Error("Invalid Agent create result.");
      return result.agent;
    },
    patch: async (id: string, patch: AgentPatch) => {
      const result = await command({ operation: "patch", id, patch });
      if (result.operation !== "patch" || result.agent.id !== id)
        throw new Error("Invalid Agent patch identity.");
      return result.agent;
    }
  });
};
