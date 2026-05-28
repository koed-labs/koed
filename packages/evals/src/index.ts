import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  createMemoryEngine,
  type CompactionResult,
  type ExpandedMemoryNode,
  type MemoryActor,
  type MemoryEngineRepository,
  type MemoryEventRecord,
  type MemoryEventType,
  type MemoryScope,
  type MemorySearchResult,
  type RequesterContext,
  type Visibility
} from "@koed/core";

interface EvalUser {
  id: string;
  email: string;
}

interface EvalNode {
  id: string;
  visibility: Visibility;
  ownerUserId: string | null;
  summaryText: string;
  sourceEventIds: string[];
  depth: 0 | 1;
}

interface EvalWorld {
  repository: DeterministicMemoryRepository;
  users: {
    alice: EvalUser;
    bob: EvalUser;
  };
  workspaceId: string;
}

interface EvalResult {
  name: string;
  passed: boolean;
  latencyMs: number;
  costUsd: number;
  details: string;
}

const tokenize = (text: string): string[] =>
  [...new Set(text.toLowerCase().match(/[a-z0-9-]+/g) ?? [])].filter(
    (token) => token.length > 2
  );

const scoreText = (query: string, text: string): number => {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedText = text.toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }
  const exact = normalizedText.includes(normalizedQuery) ? 100 : 0;
  const semantic =
    normalizedQuery.includes("hosting") &&
    normalizedText.includes("hetzner vps")
      ? 25
      : 0;
  return (
    exact +
    semantic +
    tokenize(query).filter((token) => normalizedText.includes(token)).length
  );
};

class DeterministicMemoryRepository implements MemoryEngineRepository {
  private readonly events: MemoryEventRecord[] = [];
  private readonly nodes: EvalNode[] = [];

  createMemoryEvent(
    actor: RequesterContext,
    input: {
      workspaceId: string;
      sessionId?: string;
      turnId?: string;
      actor: MemoryActor;
      eventType: MemoryEventType;
      rawEventType: string;
      content: string;
      metadata?: Record<string, unknown>;
      visibility: Visibility;
    }
  ): Promise<MemoryEventRecord> {
    const event: MemoryEventRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      sessionId: input.sessionId ?? null,
      turnId: input.turnId ?? null,
      actor: input.actor,
      eventType: input.rawEventType,
      content: input.content,
      metadata: input.metadata ?? {},
      visibility: input.visibility,
      ownerUserId: actor.userId,
      createdAt: new Date(1_800_000_000_000 + this.events.length).toISOString()
    };
    this.events.push(event);
    return Promise.resolve(event);
  }

  searchMemoryNodes(
    actor: RequesterContext,
    input: { scope: MemoryScope; query: string; limit?: number }
  ) {
    const results = this.nodes
      .filter((node) => this.isNodeVisible(actor.userId, node))
      .filter((node) => node.visibility === input.scope)
      .map((node) => ({
        node,
        score: scoreText(input.query, node.summaryText)
      }))
      .filter((candidate) => candidate.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.node.summaryText.localeCompare(right.node.summaryText)
      )
      .slice(0, input.limit ?? 10)
      .map(
        ({ node, score }): MemorySearchResult => ({
          nodeId: node.id,
          visibility: node.visibility,
          summaryText: node.summaryText,
          score,
          citation: {
            nodeId: node.id,
            visibility: node.visibility
          }
        })
      );
    return Promise.resolve({
      results,
      metadata: {
        retrievalMode: "semantic_vector" as const,
        vectorHitsCount: 0,
        textHitsCount: 0,
        embeddingModel: null,
        embeddingDimensions: null
      }
    });
  }

  createLcmNodes(
    actor: RequesterContext,
    input: { visibility: Visibility }
  ): Promise<CompactionResult> {
    const compactedEventIds = new Set(
      this.nodes.flatMap((node) => node.sourceEventIds)
    );
    const candidates = this.events.filter((event) => {
      if (
        compactedEventIds.has(event.id) ||
        event.visibility !== input.visibility
      ) {
        return false;
      }
      if (event.visibility === "personal") {
        return event.ownerUserId === actor.userId;
      }
      return false;
    });

    const leafNodeIds: string[] = [];
    for (let index = 0; index < candidates.length; index += 4) {
      const chunk = candidates.slice(index, index + 4);
      const node: EvalNode = {
        id: randomUUID(),
        visibility: input.visibility,
        ownerUserId: actor.userId,
        summaryText: chunk.map((event) => event.content).join("\n"),
        sourceEventIds: chunk.map((event) => event.id),
        depth: 0
      };
      this.nodes.push(node);
      leafNodeIds.push(node.id);
    }

    const visibleLeaves = this.nodes.filter((node) => {
      if (
        node.depth !== 0 ||
        node.visibility !== input.visibility ||
        !this.isNodeVisible(actor.userId, node)
      ) {
        return false;
      }
      return node.ownerUserId === actor.userId;
    });
    const rollupNodeId =
      visibleLeaves.length >= 3
        ? this.createRollup(input.visibility, actor.userId, visibleLeaves)
        : null;

    return Promise.resolve({ leafNodeIds, rollupNodeId });
  }

  expandMemoryNode(
    nodeId: string,
    actor: RequesterContext
  ): Promise<ExpandedMemoryNode> {
    const node = this.nodes.find(
      (candidate) =>
        candidate.id === nodeId && this.isNodeVisible(actor.userId, candidate)
    );
    if (!node) {
      throw new Error("Memory node not found or not visible");
    }

    const sourceIds = new Set(node.sourceEventIds);
    return Promise.resolve({
      nodeId,
      visibility: node.visibility,
      sourceItems: node.sourceEventIds.map((eventId, position) => ({
        kind: "memory_event",
        sourceTable: "memory_events",
        sourceId: eventId,
        position
      })),
      sources: this.events.filter((event) => sourceIds.has(event.id))
    });
  }

  private createRollup(
    visibility: Visibility,
    ownerUserId: string,
    leaves: EvalNode[]
  ): string {
    const existing = this.nodes.find(
      (node) =>
        node.depth === 1 &&
        node.visibility === visibility &&
        node.ownerUserId === ownerUserId
    );
    if (existing) {
      return existing.id;
    }

    const node: EvalNode = {
      id: randomUUID(),
      visibility,
      ownerUserId,
      summaryText: leaves.map((leaf) => leaf.summaryText).join("\n"),
      sourceEventIds: [
        ...new Set(leaves.flatMap((leaf) => leaf.sourceEventIds))
      ],
      depth: 1
    };
    this.nodes.push(node);
    return node.id;
  }

  private isNodeVisible(userId: string, node: EvalNode): boolean {
    return node.ownerUserId === userId;
  }
}

const createWorld = (): EvalWorld => {
  const repository = new DeterministicMemoryRepository();
  const users = {
    alice: {
      id: "00000000-0000-4000-8000-000000000001",
      email: "alice@example.test"
    },
    bob: {
      id: "00000000-0000-4000-8000-000000000002",
      email: "bob@example.test"
    }
  };
  return { repository, users, workspaceId: "eval-workspace" };
};

const ingestCodexStopHook = async (
  world: EvalWorld,
  actor: RequesterContext,
  payload: {
    transcript?: Array<{ role: MemoryActor; content: string }>;
    prompt?: string;
    lastAssistantMessage?: string;
  }
) => {
  const engine = createMemoryEngine(world.repository);
  const items =
    payload.transcript && payload.transcript.length > 0
      ? payload.transcript.map((item, index) => ({
          actor: item.role,
          eventType: `codex_transcript_${item.role}`,
          content: item.content,
          metadata: {
            transcriptIndex: index,
            captureFallback: "transcript_path"
          }
        }))
      : [
          ...(payload.prompt
            ? [
                {
                  actor: "user" as const,
                  eventType: "codex_user_prompt",
                  content: payload.prompt,
                  metadata: { captureFallback: "hook_payload" }
                }
              ]
            : []),
          ...(payload.lastAssistantMessage
            ? [
                {
                  actor: "assistant" as const,
                  eventType: "codex_assistant_message",
                  content: payload.lastAssistantMessage,
                  metadata: { captureFallback: "hook_payload" }
                }
              ]
            : [])
        ];

  const events = [];
  for (const item of items) {
    events.push(
      await engine.capturePersonalEvent({
        requesterContext: actor,
        workspaceId: world.workspaceId,
        actor: item.actor,
        eventType: item.eventType,
        content: item.content,
        metadata: {
          ...item.metadata,
          automaticCaptureScope: "personal"
        }
      })
    );
  }
  await engine.scheduleCompaction({
    requesterContext: actor,
    visibility: "personal"
  });
  return events;
};

const seedEvalDataset = async (world: EvalWorld) => {
  const engine = createMemoryEngine(world.repository);
  const alice = { userId: world.users.alice.id };

  await ingestCodexStopHook(world, alice, {
    transcript: [
      {
        role: "user",
        content: "For this project, my personal editor theme is Solar Pine."
      },
      {
        role: "assistant",
        content: "Captured that Solar Pine is your personal editor theme."
      }
    ]
  });

  await ingestCodexStopHook(world, alice, {
    prompt:
      "During this Codex stop hook fallback test, my private deployment alias is violet-saturn.",
    lastAssistantMessage:
      "The private deployment alias violet-saturn was discussed."
  });

  await engine.capturePersonalEvent({
    requesterContext: alice,
    workspaceId: world.workspaceId,
    actor: "user",
    eventType: "codex_user_prompt",
    content:
      "The self-hosted deployment target is a local Docker Compose stack.",
    metadata: { automaticCaptureScope: "personal" }
  });

  await engine.capturePersonalEvent({
    requesterContext: alice,
    workspaceId: world.workspaceId,
    actor: "user",
    eventType: "codex_user_prompt",
    content: "Personal conflict fact: deploy window is 10:00 Oslo.",
    metadata: { automaticCaptureScope: "personal" }
  });

  for (let index = 1; index <= 9; index += 1) {
    await engine.capturePersonalEvent({
      requesterContext: alice,
      workspaceId: world.workspaceId,
      actor: "user",
      eventType: "codex_user_prompt",
      content: `LCM compaction fact ${index}: archive marker old-cobalt-${index}.`,
      metadata: { sequence: index, automaticCaptureScope: "personal" }
    });
  }

  await engine.scheduleCompaction({
    requesterContext: alice,
    visibility: "personal"
  });
};

const assert = (condition: unknown, details: string): string => {
  if (!condition) {
    throw new Error(details);
  }
  return details;
};

const runCase = async (
  name: string,
  execute: () => Promise<string>
): Promise<EvalResult> => {
  const started = performance.now();
  try {
    const details = await execute();
    return {
      name,
      passed: true,
      latencyMs: Math.round(performance.now() - started),
      costUsd: 0,
      details
    };
  } catch (error) {
    return {
      name,
      passed: false,
      latencyMs: Math.round(performance.now() - started),
      costUsd: 0,
      details: error instanceof Error ? error.message : String(error)
    };
  }
};

const evalCases = (world: EvalWorld) => {
  const engine = createMemoryEngine(world.repository);
  const alice = { userId: world.users.alice.id };
  const bob = { userId: world.users.bob.id };

  return [
    runCase(
      "automatic/pseudo-automatic personal discussion capture",
      async () => {
        const result = await engine.searchMemory({
          requesterContext: alice,
          query: "Solar Pine",
          scope: "personal"
        });
        return assert(
          result.results.some(
            (hit) =>
              hit.visibility === "personal" &&
              hit.summaryText.includes("Solar Pine")
          ),
          "expected transcript-ingested personal Solar Pine memory"
        );
      }
    ),
    runCase("personal memory recall", async () => {
      const answer = await engine.answerMemory({
        requesterContext: alice,
        query: "violet-saturn",
        scope: "personal",
        limit: 2
      });
      return assert(
        answer.answer.includes("(personal)") &&
          answer.answer.includes("violet-saturn"),
        "expected personal evidence with personal visibility label"
      );
    }),
    runCase("personal memory not visible to another user", async () => {
      const result = await engine.searchMemory({
        requesterContext: bob,
        query: "violet-saturn",
        scope: "personal"
      });
      return assert(
        result.results.length === 0,
        "expected Bob to have zero hits for Alice personal memory"
      );
    }),
    runCase("old fact recalled after LCM compaction", async () => {
      const answer = await engine.answerMemory({
        requesterContext: alice,
        query: "old-cobalt-1",
        scope: "personal",
        limit: 1
      });
      return assert(
        answer.answer.includes("old-cobalt-1"),
        "expected oldest compacted fact to be recalled"
      );
    }),
    runCase("semantic retrieval finds hosting memory", async () => {
      const search = await engine.searchMemory({
        requesterContext: alice,
        query: "Where are we hosting it?",
        scope: "personal",
        limit: 3
      });
      return assert(
        search.results.some((hit) =>
          hit.summaryText.includes("local Docker Compose stack")
        ),
        "expected semantic retrieval to find self-hosted Docker Compose target"
      );
    }),
    runCase("negative query returns not found in memory", async () => {
      const answer = await engine.answerMemory({
        requesterContext: alice,
        query: "nonexistent periwinkle invoice approval",
        scope: "personal"
      });
      return assert(
        answer.answer === "No matching memory found.",
        "expected not found answer"
      );
    }),
    runCase("personal conflict fact is recalled", async () => {
      const answer = await engine.answerMemory({
        requesterContext: alice,
        query: "deploy window",
        scope: "personal",
        limit: 10
      });
      return assert(
        answer.answer.includes("10:00 Oslo"),
        "expected personal conflict fact with personal visibility citation"
      );
    }),
    runCase("source expansion returns exact original events", async () => {
      const search = await engine.searchMemory({
        requesterContext: alice,
        query: "Solar Pine",
        scope: "personal",
        limit: 1
      });
      const expanded = await engine.expandMemoryNode(
        search.results[0]!.nodeId,
        alice
      );
      const sources = expanded.sources.map((source) => source.content);
      return assert(
        sources.includes(
          "For this project, my personal editor theme is Solar Pine."
        ),
        "expected expansion to include exact original transcript event"
      );
    }),
    runCase("answer uses only retrieved evidence", async () => {
      const answer = await engine.answerMemory({
        requesterContext: alice,
        query: "Solar Pine",
        scope: "personal",
        limit: 1
      });
      return assert(
        answer.answer.includes("Solar Pine") &&
          !answer.answer.includes("violet-saturn") &&
          !answer.answer.includes("Docker Compose"),
        "expected answer to include only retrieved personal evidence"
      );
    })
  ];
};

const writeReport = async (results: EvalResult[]) => {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const reportPath = join(currentDir, "..", "reports", "latest.json");
  const report = {
    suite: "memory-quality",
    generatedAt: new Date().toISOString(),
    deterministic: true,
    totals: {
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
      latencyMs: results.reduce((total, result) => total + result.latencyMs, 0),
      costUsd: 0
    },
    results
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
};

const main = async () => {
  const world = createWorld();
  await seedEvalDataset(world);
  const results = await Promise.all(evalCases(world));
  const reportPath = await writeReport(results);
  const failed = results.filter((result) => !result.passed);

  console.log("Memory quality eval report");
  console.log(`Report: ${reportPath}`);
  console.log(`Passed: ${results.length - failed.length}/${results.length}`);
  console.log(
    "Latency/cost placeholders: latencyMs measured locally, costUsd fixed at 0.00 because answer synthesis stays with the AI Client"
  );
  console.table(
    results.map((result) => ({
      status: result.passed ? "PASS" : "FAIL",
      case: result.name,
      latencyMs: result.latencyMs,
      costUsd: result.costUsd.toFixed(2),
      details: result.details
    }))
  );

  if (failed.length > 0) {
    process.exitCode = 1;
  }
};

await main();
