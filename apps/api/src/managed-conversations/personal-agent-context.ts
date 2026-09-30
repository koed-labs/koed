import { randomUUID } from "node:crypto";
import { searchMemory } from "@koed/core";
import type {
  MemorySourceRepository,
  SharedMemorySemanticCandidate
} from "@koed/db";
import {
  personalAgentExecutionContextSchema,
  personalMemoryTurnContextSchema,
  type PersonalMemoryTurnContext,
  type PersonalAgentExecutionContext
} from "@koed/shared";
import { embedTeamSemanticQuery } from "../memory/team-semantic-embedding.js";

const MAX_EVIDENCE_BYTES = 24 * 1024;
const MAX_EVIDENCE_ITEMS = 5;
const MAX_QUERY_CHARS = 4_000;
const MAX_EVIDENCE_ITEM_CHARS = 3_500;
const MAX_SHARED_MEMORY_GRANTS_PER_WORKSPACE = 128;
const MEMORY_RECALL_TIMEOUT_MS = 12_000;

const clipUtf8 = (value: string, maximumBytes: number): string => {
  let clipped = value;
  while (Buffer.byteLength(clipped, "utf8") > maximumBytes) {
    clipped = clipped.slice(0, Math.max(0, clipped.length - 64));
  }
  return clipped;
};

const statusCodeOf = (error: unknown): number | undefined =>
  error && typeof error === "object" && "statusCode" in error
    ? Number((error as { statusCode?: unknown }).statusCode)
    : undefined;

const isAuthorizationDenial = (error: unknown): boolean => {
  const statusCode = statusCodeOf(error);
  return statusCode !== undefined && statusCode >= 400 && statusCode < 500;
};

const withTimeout = async <T>(work: Promise<T>): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            Object.assign(new Error("Personal Memory recall timed out"), {
              statusCode: 503,
              code: "memory_recall_timeout"
            })
          );
        }, MEMORY_RECALL_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const teamSourceType = (
  representation: SharedMemorySemanticCandidate["representation"]
): "memory_node" | "memory_event" | "curated_memory" =>
  representation === "memory_events"
    ? "memory_event"
    : representation === "curated_assertions"
      ? "curated_memory"
      : "memory_node";

type ScoredEvidence = {
  score: number;
  lane: string;
  dedupeKey: string;
  evidence: PersonalMemoryTurnContext["evidence"][number];
};

const boundedEvidence = (
  input: ScoredEvidence[]
): PersonalMemoryTurnContext["evidence"] => {
  const unique = new Map<string, ScoredEvidence>();
  for (const item of input) {
    if (!unique.has(item.dedupeKey)) unique.set(item.dedupeKey, item);
  }
  const lanes = new Map<string, ScoredEvidence[]>();
  for (const item of unique.values()) {
    const lane = lanes.get(item.lane) ?? [];
    lane.push(item);
    lanes.set(item.lane, lane);
  }
  // Personal search and Team semantic search use different ranking pipelines,
  // so their raw scores are not a reliable cross-source comparison. Keep each
  // source's relevance order and take one item per source in a round-robin.
  // This gives each authorized Workspace and Personal Memory a fair chance at
  // the shared evidence budget.
  const rankedLanes = [...lanes.entries()]
    .map(([name, lane]) => ({ name, lane }))
    .map(({ name, lane }) => ({
      name,
      lane: lane.sort(
        (left, right) =>
          right.score - left.score ||
          left.evidence.nodeId.localeCompare(right.evidence.nodeId)
      )
    }))
    .sort((left, right) => {
      if (left.name === "personal") return right.name === "personal" ? 0 : -1;
      if (right.name === "personal") return 1;
      const topScore = (right.lane[0]?.score ?? 0) - (left.lane[0]?.score ?? 0);
      return topScore || left.name.localeCompare(right.name);
    })
    .map(({ lane }) => lane);
  const merged: ScoredEvidence[] = [];
  for (
    let index = 0;
    rankedLanes.some((lane) => lane[index] !== undefined);
    index += 1
  ) {
    for (const lane of rankedLanes) {
      if (lane[index]) merged.push(lane[index]!);
    }
  }

  let remainingEvidenceBytes = MAX_EVIDENCE_BYTES;
  const evidence: PersonalMemoryTurnContext["evidence"] = [];
  for (const candidate of merged) {
    if (evidence.length >= MAX_EVIDENCE_ITEMS || remainingEvidenceBytes <= 0) {
      break;
    }
    const item = {
      ...candidate.evidence,
      summaryText: clipUtf8(
        candidate.evidence.summaryText,
        MAX_EVIDENCE_ITEM_CHARS
      )
    };
    let itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (itemBytes > remainingEvidenceBytes) {
      item.summaryText = clipUtf8(
        item.summaryText,
        Math.max(0, remainingEvidenceBytes - 1_024)
      );
      itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    }
    if (itemBytes > remainingEvidenceBytes) continue;
    evidence.push(item);
    remainingEvidenceBytes -= itemBytes;
  }
  return evidence;
};

const recallPersonalAndTeamEvidence = async (input: {
  repository: MemorySourceRepository;
  ownerUserId: string;
  projectId: string | null;
  projectName?: string | null;
  prompt: string;
  fetchFn?: typeof fetch;
  workspaces?: Awaited<ReturnType<typeof freezeAccessibleTeamWorkspaces>>;
}): Promise<ScoredEvidence[]> => {
  const actor = { userId: input.ownerUserId };
  const workspaces =
    input.workspaces ??
    (await freezeAccessibleTeamWorkspaces(input.repository, actor));

  const projectHint = input.projectName?.trim()
    ? `Project context: ${input.projectName.trim()}\n`
    : "";
  const query = clipUtf8(
    `${projectHint}${input.prompt.trim()}`,
    MAX_QUERY_CHARS
  );
  const personalPromise = searchMemory({
    repository: input.repository,
    requesterContext: actor,
    query,
    scope: "personal",
    // Project is relevance context only. It does not narrow private or Team
    // Memory visibility for a Personal Agent Job.
    searchDomain: "global",
    limit: MAX_EVIDENCE_ITEMS,
    strictLimit: true
  });

  const teamPromise = workspaces.length
    ? (async () => {
        const embedding = await embedTeamSemanticQuery(query, input.fetchFn);
        return Promise.all(
          workspaces.map(async ({ workspace, authorizationBoundary }) => {
            const candidates =
              await input.repository.searchAuthorizedSharedMemorySemanticItems(
                actor,
                {
                  teamWorkspaceId: workspace.teamWorkspaceId,
                  queryVector: embedding.vector,
                  model: embedding.model,
                  dimensions: embedding.dimensions,
                  version: embedding.version,
                  limit: MAX_EVIDENCE_ITEMS,
                  strictLimit: true,
                  searchDomain: "global",
                  authorizationBoundary
                }
              );
            return candidates.map((candidate): ScoredEvidence => {
              const sourceType = teamSourceType(candidate.representation);
              const citation = {
                nodeId: candidate.candidateId,
                sourceType,
                sourceId: candidate.pseudonymousSourceId,
                sourceChunkIndex: candidate.sourceItemIndex,
                sourceChunkCount: 1,
                visibility: "team",
                teamWorkspaceId: workspace.teamWorkspaceId
              };
              return {
                score: candidate.score,
                lane: `team:${workspace.teamWorkspaceId}`,
                dedupeKey: `team:${candidate.source.logicalMemoryId}:${candidate.sourceItemIndex}`,
                evidence: {
                  nodeId: candidate.candidateId,
                  sourceType,
                  sourceId: candidate.pseudonymousSourceId,
                  summaryText: candidate.text,
                  visibility: "team",
                  teamWorkspaceId: workspace.teamWorkspaceId,
                  citation,
                  ...(candidate.occurredAt
                    ? { sourceTime: candidate.occurredAt }
                    : {})
                }
              };
            });
          })
        );
      })()
    : Promise.resolve([] as ScoredEvidence[][]);

  const [personal, team] = await Promise.all([personalPromise, teamPromise]);
  const personalEvidence = personal.results
    .filter((hit) => hit.visibility === "personal")
    .map(
      (hit): ScoredEvidence => ({
        score: hit.score,
        lane: "personal",
        dedupeKey: `personal:${hit.sourceType ?? "memory_node"}:${hit.sourceId ?? hit.nodeId}:${hit.sourceChunkIndex ?? 0}`,
        evidence: {
          nodeId: hit.nodeId,
          ...(hit.sourceType ? { sourceType: hit.sourceType } : {}),
          ...(hit.sourceId ? { sourceId: hit.sourceId } : {}),
          summaryText: hit.summaryText,
          visibility: "personal",
          citation: {
            nodeId: hit.citation.nodeId,
            ...(hit.citation.sourceType
              ? { sourceType: hit.citation.sourceType }
              : {}),
            ...(hit.citation.sourceId
              ? { sourceId: hit.citation.sourceId }
              : {}),
            ...(hit.citation.sourceChunkIndex !== undefined
              ? { sourceChunkIndex: hit.citation.sourceChunkIndex }
              : {}),
            visibility: "personal"
          },
          ...(hit.occurredAt ? { sourceTime: hit.occurredAt } : {})
        }
      })
    );
  return [...personalEvidence, ...team.flat()];
};

const freezeAccessibleTeamWorkspaces = async (
  repository: MemorySourceRepository,
  actor: { userId: string }
) => {
  const workspaceContexts = await repository.listTeamWorkspaceContexts(actor);
  return Promise.all(
    workspaceContexts.map(async (workspace) => ({
      workspace,
      authorizationBoundary:
        await repository.freezeSharedMemorySemanticRecallBoundary(actor, {
          teamWorkspaceId: workspace.teamWorkspaceId,
          maximumGrantCount: MAX_SHARED_MEMORY_GRANTS_PER_WORKSPACE
        })
    }))
  );
};

export type PersonalAgentTurnContextResult = {
  expectedAgentVersion: number;
  context: PersonalAgentExecutionContext;
  memoryContext: PersonalMemoryTurnContext;
};

export const buildPersonalAgentMemoryTurnContext = async (input: {
  repository: MemorySourceRepository;
  ownerUserId: string;
  projectId: string | null;
  projectName?: string | null;
  prompt: string;
  fetchFn?: typeof fetch;
  continueWithoutMemory?: boolean;
}): Promise<PersonalMemoryTurnContext> => {
  try {
    if (input.continueWithoutMemory) {
      // Verify every currently listed Team Workspace before honoring the
      // one-request bypass. It skips retrieval only; it never skips authority.
      await withTimeout(
        freezeAccessibleTeamWorkspaces(input.repository, {
          userId: input.ownerUserId
        })
      );
      return personalMemoryTurnContextSchema.parse({
        schemaVersion: 1,
        status: "skipped",
        attributionNonce: randomUUID(),
        searchDomain: "global",
        projectId: input.projectId,
        evidence: []
      });
    }
    const retrieval = await withTimeout(recallPersonalAndTeamEvidence(input));
    return personalMemoryTurnContextSchema.parse({
      schemaVersion: 1,
      status: "available",
      attributionNonce: randomUUID(),
      searchDomain: "global",
      projectId: input.projectId,
      evidence: boundedEvidence(retrieval)
    });
  } catch (error) {
    // Authorization failures must fail closed and cannot be bypassed by the
    // one-request Continue without Memory option.
    if (isAuthorizationDenial(error)) throw error;
    return personalMemoryTurnContextSchema.parse({
      schemaVersion: 1,
      status: "unavailable",
      attributionNonce: randomUUID(),
      searchDomain: "global",
      projectId: input.projectId,
      evidence: []
    });
  }
};

/** The existing non-Agent chat path remains Personal-only and Project-scoped. */
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
    const evidence = retrieval.results
      .filter((hit) => hit.visibility === "personal")
      .map(
        (hit): ScoredEvidence => ({
          score: hit.score,
          lane: "personal",
          dedupeKey: `personal:${hit.sourceType ?? "memory_node"}:${hit.sourceId ?? hit.nodeId}:${hit.sourceChunkIndex ?? 0}`,
          evidence: {
            nodeId: hit.nodeId,
            ...(hit.sourceType ? { sourceType: hit.sourceType } : {}),
            ...(hit.sourceId ? { sourceId: hit.sourceId } : {}),
            summaryText: clipUtf8(hit.summaryText, MAX_EVIDENCE_ITEM_CHARS),
            visibility: "personal",
            citation: {
              nodeId: hit.citation.nodeId,
              ...(hit.citation.sourceType
                ? { sourceType: hit.citation.sourceType }
                : {}),
              ...(hit.citation.sourceId
                ? { sourceId: hit.citation.sourceId }
                : {}),
              visibility: "personal"
            },
            ...(hit.occurredAt ? { sourceTime: hit.occurredAt } : {})
          }
        })
      );
    return personalMemoryTurnContextSchema.parse({
      schemaVersion: 1,
      status: "available",
      attributionNonce: randomUUID(),
      searchDomain,
      projectId: input.projectId,
      evidence: boundedEvidence(evidence)
    });
  } catch (error) {
    if (isAuthorizationDenial(error)) throw error;
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
  fetchFn?: typeof fetch;
  continueWithoutMemory?: boolean;
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

  const memoryContext = await buildPersonalAgentMemoryTurnContext({
    repository: input.repository,
    ownerUserId: input.ownerUserId,
    projectId: input.projectId,
    projectName,
    prompt: input.prompt,
    fetchFn: input.fetchFn,
    continueWithoutMemory: input.continueWithoutMemory
  });

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
    memory: { searchDomain: "global", evidence: memoryContext.evidence }
  });

  return { expectedAgentVersion, context, memoryContext };
};
