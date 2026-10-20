import { agentSchema } from "@koed/shared/agent-contract";
import { z } from "zod";
import {
  agentsRequestSchema,
  agentsResultSchema,
  type AgentsRequest,
  type AgentsResult
} from "../ipc/agents-protocol.js";

export type AgentsAuthority = Readonly<{
  key: string;
  ownerId: string;
  apiOrigin: string;
  authorization: string;
}>;
type RequestJson = (
  path: string,
  init: RequestInit,
  authority: AgentsAuthority
) => Promise<Record<string, unknown>>;
const listResponse = z.object({ agents: z.array(agentSchema) }).strict();
const oneResponse = z.object({ agent: agentSchema }).strict();

export const createAgentsClient =
  (input: {
    requestJson: RequestJson;
    authority: () => Promise<AgentsAuthority>;
    defaultInstance: (authority: AgentsAuthority) => Promise<string | null>;
  }) =>
  async (value: AgentsRequest): Promise<AgentsResult> => {
    const request = agentsRequestSchema.parse(value);
    const initialAuthority = await input.authority();
    const read = async () => {
      const agents = listResponse.parse(
        await input.requestJson(
          "/v1/agents",
          { method: "GET" },
          initialAuthority
        )
      ).agents;
      if (
        agents.some((agent) => agent.ownerUserId !== initialAuthority.ownerId)
      )
        throw new Error("Agents owner identity mismatch.");
      if (
        new Set(agents.map((agent) => agent.id)).size !== agents.length ||
        agents.filter((agent) => agent.isChiefOfStaff).length > 1
      )
        throw new Error("Agents list contains duplicate identities or Chiefs.");
      return agents;
    };
    const checked = async <T>(work: () => Promise<T>): Promise<T> => {
      if ((await input.authority()).key !== initialAuthority.key)
        throw new Error("Agents profile changed during request.");
      const result = await work();
      if ((await input.authority()).key !== initialAuthority.key)
        throw new Error("Agents profile changed during request.");
      return result;
    };
    if (request.operation === "list")
      return agentsResultSchema.parse({
        operation: "list",
        agents: await checked(read)
      });
    if (request.operation === "ensureChief") {
      const existing = (await checked(read)).find(
        (agent) => agent.isChiefOfStaff
      );
      if (existing)
        return agentsResultSchema.parse({
          operation: "ensureChief",
          agent: existing
        });
      const instanceId = await checked(() =>
        input.defaultInstance(initialAuthority)
      );
      if (!instanceId)
        throw new Error(
          "The conversations AI Client instance is unavailable. Configure it before creating a Chief of Staff."
        );
      const response = await checked(() =>
        input.requestJson(
          "/v1/agents/chief:ensure",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ aiClientInstanceId: instanceId })
          },
          initialAuthority
        )
      );
      const agent = oneResponse.parse(response).agent;
      if (agent.ownerUserId !== initialAuthority.ownerId)
        throw new Error("Agent owner identity mismatch.");
      if (!agent.isChiefOfStaff)
        throw new Error("Chief of Staff identity mismatch.");
      return agentsResultSchema.parse({ operation: "ensureChief", agent });
    }
    if (request.operation === "create") {
      const response = await checked(() =>
        input.requestJson(
          "/v1/agents",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request.agent)
          },
          initialAuthority
        )
      );
      const agent = oneResponse.parse(response).agent;
      if (agent.ownerUserId !== initialAuthority.ownerId)
        throw new Error("Agent owner identity mismatch.");
      return agentsResultSchema.parse({ operation: "create", agent });
    }
    const response = await checked(() =>
      input.requestJson(
        `/v1/agents/${encodeURIComponent(request.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request.patch)
        },
        initialAuthority
      )
    );
    const agent = oneResponse.parse(response).agent;
    if (
      agent.id !== request.id ||
      agent.ownerUserId !== initialAuthority.ownerId
    )
      throw new Error("Agent identity mismatch.");
    return agentsResultSchema.parse({ operation: "patch", agent });
  };
