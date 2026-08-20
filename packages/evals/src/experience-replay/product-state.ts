import type {
  ActorContext,
  ConversationItemRecord,
  MemorySourceRepository
} from "@koed/db";
import type { MemorySearchResult, RetrievalMetadata } from "@koed/core";
import type { NormalizedImportClient } from "./ingestion.js";
import type {
  ProductApiHandle,
  ProductApiJson
} from "./product-api-process.js";
import type { MemoryReplayCondition } from "./core/schedule.js";

type Repository = Pick<
  MemorySourceRepository,
  | "createTrustedNormalizedImport"
  | "getCapturedSession"
  | "findConversationItemByStableIdentity"
  | "getLcmGraphEvent"
  | "listLcmGraphNodes"
  | "getLcmGraphNode"
  | "getEmbeddableSource"
  | "getCurrentSourceEmbeddingChunkCount"
  | "searchMemoryNodes"
>;

export interface ProductionNormalizedImportClientOptions {
  api: Pick<ProductApiHandle, "request">;
  repository: Pick<MemorySourceRepository, "createTrustedNormalizedImport">;
  /** The actor authenticated by `authorization`. */
  actor: ActorContext;
  authorization: string;
}

/**
 * Production boundary for Experience Replay normalized imports. Session
 * admission and Projection remain API-owned; only the deliberately trusted
 * normalized adapter capability crosses directly into the repository.
 */
export const createProductionNormalizedImportClient = (
  options: ProductionNormalizedImportClientOptions
): NormalizedImportClient => ({
  async createSession(input) {
    return (await options.api.request({
      method: "POST",
      path: "/v1/sessions",
      headers: { authorization: options.authorization },
      body: input as ProductApiJson
    })) as Awaited<ReturnType<NormalizedImportClient["createSession"]>>;
  },
  async createTrustedNormalizedImport(input) {
    const stored = await options.repository.createTrustedNormalizedImport(
      options.actor,
      input as Parameters<
        MemorySourceRepository["createTrustedNormalizedImport"]
      >[1]
    );
    return { items: stored.map(({ id }) => ({ id })) };
  },
  async projectConversationItems(input) {
    return options.api.request({
      method: "POST",
      path: "/v1/memory/conversation-items/project",
      headers: { authorization: options.authorization },
      body: input as ProductApiJson
    });
  }
});

export interface ExpectedConversationItem {
  id: string;
  canonicalStableItemId: string;
  sourceSequence: number;
  sourceEventType: string;
}

export interface ExpectedProjectionDisposition {
  eventId: string;
  includeInEmbedding: boolean;
  includeInLcm: boolean;
}

export interface ExperienceReplayProductStateExpectation {
  condition: MemoryReplayCondition;
  actor: ActorContext;
  projectId: string;
  sessionId?: string;
  conversationItems?: readonly ExpectedConversationItem[];
  projectionDispositions?: readonly ExpectedProjectionDisposition[];
  /** Exact Memory Events for which the production Projection response scheduled LCM work. */
  scheduledLcmEventIds?: readonly string[];
  embedding: { model: string; dimensions: number; version: string };
  recall: {
    query: string;
    /** Relevant/placebo must name at least one source; empty must name none. */
    expectedSourceIds: readonly string[];
    limit?: number;
  };
}

export interface SemanticRecallProbe {
  results: MemorySearchResult[];
  metadata: RetrievalMetadata;
  resolvedSourceIds: string[];
}

export interface ExperienceReplayProductStateAttestation {
  condition: ExperienceReplayProductStateExpectation["condition"];
  ready: true;
  attempts: number;
  sessionId: string | null;
  conversationItemIds: string[];
  projectedEventIds: string[];
  embeddedChunkCounts: Record<string, number>;
  summarizedLcmNodeIds: string[];
  recall: SemanticRecallProbe;
}

export interface ProductStateReadinessOptions {
  repository: Repository;
  expectation: ExperienceReplayProductStateExpectation;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface Observation {
  failures: string[];
  conversationItemIds: string[];
  projectedEventIds: string[];
  embeddedChunkCounts: Record<string, number>;
  summarizedLcmNodeIds: string[];
  recall: SemanticRecallProbe;
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const resolveRecallSourceIds = async (
  repository: Repository,
  actor: ActorContext,
  results: readonly MemorySearchResult[]
): Promise<string[]> => {
  const ids = results.flatMap((result) => [
    result.nodeId,
    ...(result.sourceId ? [result.sourceId] : []),
    ...(result.citation.sourceId ? [result.citation.sourceId] : [])
  ]);
  for (const nodeId of unique(results.map((result) => result.nodeId))) {
    const detail = await repository.getLcmGraphNode(actor, nodeId);
    if (detail) ids.push(...detail.sources.map((source) => source.id));
  }
  return unique(ids);
};

const observe = async (
  repository: Repository,
  expectation: ExperienceReplayProductStateExpectation
): Promise<Observation> => {
  const failures: string[] = [];
  const expectedItems = expectation.conversationItems ?? [];
  const dispositions = expectation.projectionDispositions ?? [];
  const conversationItemIds: string[] = [];
  const projectedEventIds: string[] = [];
  const embeddedChunkCounts: Record<string, number> = {};
  const summarizedLcmNodeIds: string[] = [];

  if (expectation.condition === "empty") {
    if (expectation.sessionId || expectedItems.length || dispositions.length) {
      failures.push("empty condition declares product sources");
    }
  } else if (!expectation.sessionId) {
    failures.push(`${expectation.condition} condition has no Captured Session`);
  }

  if (expectation.sessionId) {
    const session = await repository.getCapturedSession(
      expectation.actor,
      expectation.sessionId
    );
    if (!session) {
      failures.push(
        "Captured Session is not visible to the authenticated actor"
      );
    } else {
      if (session.ownerUserId !== expectation.actor.userId)
        failures.push(
          "Captured Session owner does not match authenticated actor"
        );
      if (session.project?.id !== expectation.projectId)
        failures.push("Captured Session Project disposition does not match");
      if (session.visibility !== "personal")
        failures.push("Captured Session is not Personal Memory");
    }
  }

  const seenItemIds = new Set<string>();
  for (const expected of expectedItems) {
    const item = expectation.sessionId
      ? await repository.findConversationItemByStableIdentity(
          expectation.actor,
          {
            sessionId: expectation.sessionId,
            canonicalStableItemId: expected.canonicalStableItemId
          }
        )
      : null;
    if (!item) {
      failures.push(
        `Conversation Item ${expected.canonicalStableItemId} missing`
      );
      continue;
    }
    conversationItemIds.push(item.id);
    seenItemIds.add(item.id);
    const exact: Partial<ConversationItemRecord> = {
      id: expected.id,
      sessionId: expectation.sessionId ?? null,
      sourceKind: "codex",
      sourceAdapterVersion: "koed-normalized-import-v1",
      sourceTransport: "normalized_import",
      sourceRecordType: "normalized_import_item",
      sourceEventType: expected.sourceEventType,
      sourceSequence: expected.sourceSequence,
      canonicalStableItemId: expected.canonicalStableItemId
    };
    for (const [field, value] of Object.entries(exact)) {
      if (item[field as keyof ConversationItemRecord] !== value)
        failures.push(`Conversation Item ${expected.id} has wrong ${field}`);
    }
  }
  if (seenItemIds.size !== expectedItems.length)
    failures.push("Conversation Item identity set is not exact");

  for (const disposition of dispositions) {
    const event = await repository.getLcmGraphEvent(
      expectation.actor,
      disposition.eventId,
      { includeContent: true }
    );
    if (!event) {
      failures.push(`projected Memory Event ${disposition.eventId} missing`);
      continue;
    }
    projectedEventIds.push(event.id);
    if (
      event.sessionId !== expectation.sessionId ||
      event.projectId !== expectation.projectId ||
      event.visibility !== "personal"
    ) {
      failures.push(
        `Memory Event ${event.id} owner/Project/session scope mismatch ` +
          `(expected session=${expectation.sessionId}, project=${expectation.projectId}, visibility=personal; ` +
          `received session=${event.sessionId}, project=${event.projectId}, visibility=${event.visibility})`
      );
    }
    if (
      event.metadata.includeInEmbedding !== disposition.includeInEmbedding ||
      event.metadata.includeInLcm !== disposition.includeInLcm ||
      typeof event.metadata.projectionPolicyKey !== "string" ||
      typeof event.metadata.projectionPolicyRevision !== "number"
    ) {
      failures.push(
        `Memory Event ${event.id} source policy disposition mismatch`
      );
    }
    if (disposition.includeInEmbedding) {
      const source = await repository.getEmbeddableSource(
        "memory_event",
        event.id
      );
      if (!source || source.ownerUserId !== expectation.actor.userId) {
        failures.push(`required embedding source ${event.id} missing`);
      } else {
        const count = await repository.getCurrentSourceEmbeddingChunkCount({
          source,
          ...expectation.embedding
        });
        if (count === null || count < 1) {
          failures.push(
            `required embedding chunks for ${event.id} are not ready`
          );
        } else {
          embeddedChunkCounts[event.id] = count;
        }
      }
    }
  }

  const lcmRequired = expectation.scheduledLcmEventIds ?? [];
  const dispositionById = new Map(
    dispositions.map((disposition) => [disposition.eventId, disposition])
  );
  for (const eventId of lcmRequired) {
    if (!dispositionById.get(eventId)?.includeInLcm) {
      failures.push(`scheduled LCM event ${eventId} is not policy-eligible`);
    }
  }
  if (lcmRequired.length > 0) {
    const nodes = await repository.listLcmGraphNodes(expectation.actor, {
      visibility: "personal",
      projectId: expectation.projectId,
      limit: 500
    });
    const covered = new Set<string>();
    for (const node of nodes) {
      if (node.sessionId !== expectation.sessionId) continue;
      const detail = await repository.getLcmGraphNode(
        expectation.actor,
        node.id
      );
      if (!detail) continue;
      const sourceIds = new Set(detail.sources.map((source) => source.id));
      if (lcmRequired.some((id) => sourceIds.has(id))) {
        if (node.summaryStatus !== "summarized" || !node.summaryModel) continue;
        summarizedLcmNodeIds.push(node.id);
        for (const id of lcmRequired) if (sourceIds.has(id)) covered.add(id);
      }
    }
    for (const id of lcmRequired)
      if (!covered.has(id))
        failures.push(`scheduled LCM for ${id} is incomplete`);
  }

  const searched = await repository.searchMemoryNodes(expectation.actor, {
    scope: "personal",
    searchDomain: "project",
    projectId: expectation.projectId,
    query: expectation.recall.query,
    limit: expectation.recall.limit ?? 10,
    strictLimit: true
  });
  const resolvedSourceIds = await resolveRecallSourceIds(
    repository,
    expectation.actor,
    searched.results
  );
  const recall: SemanticRecallProbe = { ...searched, resolvedSourceIds };
  if (
    searched.metadata.retrievalMode === "embedding_unavailable" ||
    searched.metadata.textHitsCount !== 0 ||
    searched.metadata.semanticRetrievalComplete === false
  ) {
    failures.push("Recall probe was not completed as semantic-only retrieval");
  }
  if (expectation.condition === "empty") {
    if (expectation.recall.expectedSourceIds.length !== 0)
      failures.push("empty Recall probe declares expected sources");
    if (searched.results.length !== 0)
      failures.push("empty Recall probe unexpectedly hit product Memory");
  } else {
    if (expectation.recall.expectedSourceIds.length === 0) {
      failures.push(
        `${expectation.condition} Recall probe has no expected source`
      );
    } else if (
      !expectation.recall.expectedSourceIds.some((id) =>
        resolvedSourceIds.includes(id)
      )
    ) {
      failures.push(
        `${expectation.condition} Recall probe missed expected source`
      );
    }
  }

  return {
    failures,
    conversationItemIds,
    projectedEventIds,
    embeddedChunkCounts,
    summarizedLcmNodeIds: unique(summarizedLcmNodeIds),
    recall
  };
};

export const awaitExperienceReplayProductState = async (
  options: ProductStateReadinessOptions
): Promise<ExperienceReplayProductStateAttestation> => {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 250;
  if (timeoutMs < 0 || intervalMs < 0)
    throw new TypeError("readiness bounds must be non-negative");
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;
  let attempts = 0;
  let last: Observation;
  for (;;) {
    attempts += 1;
    last = await observe(options.repository, options.expectation);
    if (last.failures.length === 0) {
      return {
        condition: options.expectation.condition,
        ready: true,
        attempts,
        sessionId: options.expectation.sessionId ?? null,
        conversationItemIds: last.conversationItemIds,
        projectedEventIds: last.projectedEventIds,
        embeddedChunkCounts: last.embeddedChunkCounts,
        summarizedLcmNodeIds: last.summarizedLcmNodeIds,
        recall: last.recall
      };
    }
    if (now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  throw new Error(
    `Experience Replay product state was not ready after ${attempts} attempts: ${last.failures.join("; ")}`
  );
};
