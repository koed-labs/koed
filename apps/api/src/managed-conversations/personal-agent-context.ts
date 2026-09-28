import { randomUUID } from "node:crypto";
import { searchMemory } from "@koed/core";
import type { MemorySourceRepository } from "@koed/db";
import {
  personalAgentExecutionContextSchema,
  personalMemoryTurnContextSchema,
  type PersonalMemoryTurnContext,
  type PersonalAgentExecutionContext
} from "@koed/shared";

const MAX_EVIDENCE_BYTES = 24 * 1024;
const MAX_EVIDENCE_ITEMS = 5;
const MAX_QUERY_CHARS = 4_000;
const MAX_EVIDENCE_ITEM_CHARS = 3_500;

const clipUtf8 = (value: string, maximumBytes: number): string => {
  let clipped = value;
  while (Buffer.byteLength(clipped, "utf8") > maximumBytes) {
    clipped = clipped.slice(0, Math.max(0, clipped.length - 64));
  }
  return clipped;
};

export type PersonalAgentTurnContextResult = {
  expectedAgentVersion: number;
  context: PersonalAgentExecutionContext;
  memoryContext: PersonalMemoryTurnContext;
};

export const buildPersonalMemoryTurnContext = async (input: {
  repository: MemorySourceRepository;
  ownerUserId: string;
  projectId: string | null;
  prompt: string;
}): Promise<PersonalMemoryTurnContext> => {
  const searchDomain = input.projectId ? "project" : "global";
  try {
    const retrieval = await searchMemory({
      repository: input.repository,
      requesterContext: { userId: input.ownerUserId },
      query: input.prompt.trim().slice(0, MAX_QUERY_CHARS),
      scope: "personal",
      searchDomain,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      limit: MAX_EVIDENCE_ITEMS,
      strictLimit: true
    });

    let remainingEvidenceBytes = MAX_EVIDENCE_BYTES;
    const evidence: PersonalMemoryTurnContext["evidence"] = [];
    for (const hit of retrieval.results) {
      if (hit.visibility !== "personal" || remainingEvidenceBytes <= 0)
        continue;
      const summaryText = clipUtf8(hit.summaryText, MAX_EVIDENCE_ITEM_CHARS);
      const item = {
        nodeId: hit.nodeId,
        ...(hit.sourceType ? { sourceType: hit.sourceType } : {}),
        ...(hit.sourceId ? { sourceId: hit.sourceId } : {}),
        summaryText,
        citation: {
          nodeId: hit.citation.nodeId,
          ...(hit.citation.sourceType
            ? { sourceType: hit.citation.sourceType }
            : {}),
          ...(hit.citation.sourceId ? { sourceId: hit.citation.sourceId } : {}),
          visibility: hit.citation.visibility
        },
        ...(hit.occurredAt ? { sourceTime: hit.occurredAt } : {})
      };
      const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (itemBytes > remainingEvidenceBytes) {
        item.summaryText = clipUtf8(
          summaryText,
          Math.max(0, remainingEvidenceBytes - 1_024)
        );
      }
      const boundedBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (boundedBytes > remainingEvidenceBytes) break;
      evidence.push(item);
      remainingEvidenceBytes -= boundedBytes;
    }

    return personalMemoryTurnContextSchema.parse({
      schemaVersion: 1,
      status: "available",
      attributionNonce: randomUUID(),
      searchDomain,
      projectId: input.projectId,
      evidence
    });
  } catch (error) {
    const statusCode =
      error && typeof error === "object" && "statusCode" in error
        ? Number((error as { statusCode?: unknown }).statusCode)
        : undefined;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      throw error;
    }
    return personalMemoryTurnContextSchema.parse({
      schemaVersion: 1,
      status: "unavailable",
      attributionNonce: randomUUID(),
      searchDomain,
      projectId: input.projectId,
      evidence: []
    });
  }
};

export const buildPersonalAgentTurnContext = async (input: {
  repository: MemorySourceRepository;
  ownerUserId: string;
  agentId: string;
  expectedAgentVersion?: number;
  projectId: string | null;
  prompt: string;
}): Promise<PersonalAgentTurnContextResult> => {
  const actor = { userId: input.ownerUserId };
  const agentDetail = await input.repository.getPersonalAgent(
    actor,
    input.agentId
  );
  if (!agentDetail || agentDetail.agent.lifecycle !== "active") {
    throw Object.assign(new Error("Personal Agent is unavailable"), {
      statusCode: 404
    });
  }
  const expectedAgentVersion = agentDetail.agent.currentVersion;
  if (
    input.expectedAgentVersion !== undefined &&
    input.expectedAgentVersion !== expectedAgentVersion
  ) {
    throw Object.assign(
      new Error("Personal Agent changed; reload it before sending"),
      {
        statusCode: 409
      }
    );
  }
  const identityVersion = await input.repository.getPersonalAgentVersion(
    actor,
    {
      agentId: input.agentId,
      version: expectedAgentVersion
    }
  );
  if (
    !identityVersion ||
    identityVersion.agentId !== input.agentId ||
    identityVersion.ownerUserId !== input.ownerUserId
  ) {
    throw Object.assign(new Error("Personal Agent version is unavailable"), {
      statusCode: 404
    });
  }

  let projectName: string | null = null;
  if (input.projectId) {
    const projects = await input.repository.listLcmGraphThreads(actor, {
      projectId: input.projectId,
      limit: 1
    });
    const project = projects.find(
      (candidate) => candidate.id === input.projectId
    );
    projectName = project?.name ?? null;
  }

  const memoryContext = await buildPersonalMemoryTurnContext({
    repository: input.repository,
    ownerUserId: input.ownerUserId,
    projectId: input.projectId,
    prompt: input.prompt
  });
  const searchDomain = memoryContext.searchDomain;

  const context = personalAgentExecutionContextSchema.parse({
    schemaVersion: 1,
    identity: {
      agentId: identityVersion.agentId,
      version: identityVersion.version,
      identityVersionId: identityVersion.id,
      name: identityVersion.name,
      role: identityVersion.role,
      soulInstructions: identityVersion.soulInstructions
    },
    project: {
      projectId: input.projectId,
      name: projectName
    },
    memory: { searchDomain, evidence: memoryContext.evidence }
  });

  return { expectedAgentVersion, context, memoryContext };
};
