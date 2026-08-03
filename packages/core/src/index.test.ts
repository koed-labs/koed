import { describe, expect, it } from "vitest";
import {
  chunkTextForModel,
  codexIdePromptUserText,
  countTokensForModel,
  createMemoryEngine,
  estimateTokens,
  memorySourceInputSchema,
  resolveTokenEncodingForModel,
  splitCodexIdePrompt,
  type ExpandedMemoryNode,
  type MemoryEngineRepository,
  type MemoryEventRecord,
  type MemorySearchResult,
  type Visibility
} from "./index.js";

describe("core schemas", () => {
  it("defaults memories to personal scope", () => {
    expect(memorySourceInputSchema.parse({ text: "hello" }).scope).toBe(
      "personal"
    );
  });

  it("counts tokens with the default Codex tokenizer", () => {
    expect(estimateTokens("hello world")).toBe(2);
  });

  it("resolves explicit Codex model tokenizers", () => {
    expect(resolveTokenEncodingForModel("gpt-5.4-mini")).toEqual({
      model: "gpt-5.4-mini",
      encoding: "o200k_base",
      exactModelMatch: true
    });
    expect(resolveTokenEncodingForModel("gpt-5.3-codex-spark")).toEqual({
      model: "gpt-5.3-codex-spark",
      encoding: "o200k_base",
      exactModelMatch: true
    });
  });

  it("keeps legacy GPT models on cl100k_base", () => {
    expect(resolveTokenEncodingForModel("gpt-3.5-turbo")).toEqual({
      model: "gpt-3.5-turbo",
      encoding: "cl100k_base",
      exactModelMatch: true
    });
  });

  it("uses different encodings when model families need them", () => {
    const text = "お誕生日おめでとう";
    expect(countTokensForModel(text, { model: "gpt-5.4-mini" })).toMatchObject({
      tokens: 8,
      encoding: "o200k_base",
      tokenizer: "js-tiktoken"
    });
    expect(countTokensForModel(text, { model: "gpt-3.5-turbo" })).toMatchObject(
      {
        tokens: 9,
        encoding: "cl100k_base",
        tokenizer: "js-tiktoken"
      }
    );
  });

  it("falls forward to o200k_base for unknown Codex-like models", () => {
    expect(resolveTokenEncodingForModel("gpt-5.9-codex")).toEqual({
      model: "gpt-5.9-codex",
      encoding: "o200k_base",
      exactModelMatch: false
    });
  });

  it("chunks oversized text by the selected model tokenizer", () => {
    const chunks = chunkTextForModel("Aston Villa ".repeat(200), {
      model: "gpt-5.4-mini",
      maxTokens: 50
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(" ")).toContain("Aston Villa");
    for (const chunk of chunks) {
      expect(
        countTokensForModel(chunk, { model: "gpt-5.4-mini" }).tokens
      ).toBeLessThanOrEqual(50);
    }
  });

  it("splits the rendered Codex IDE prompt wrapper", () => {
    const wrapped = `# Context from my IDE setup:

## Active file: koed-self-hosted/SECURITY.md

## Open tabs:
- SECURITY.md: koed-self-hosted/SECURITY.md

## My request for Codex:
Coffee cardamom sounds interesting - should I cool the coffee first?`;

    expect(splitCodexIdePrompt(wrapped)).toEqual({
      ideContext: `# Context from my IDE setup:

## Active file: koed-self-hosted/SECURITY.md

## Open tabs:
- SECURITY.md: koed-self-hosted/SECURITY.md`,
      userPrompt:
        "Coffee cardamom sounds interesting - should I cool the coffee first?"
    });
    expect(codexIdePromptUserText(wrapped)).toBe(
      "Coffee cardamom sounds interesting - should I cool the coffee first?"
    );
    expect(
      codexIdePromptUserText(
        "A normal prompt mentioning My request for Codex remains intact."
      )
    ).toBe("A normal prompt mentioning My request for Codex remains intact.");
  });

  it("uses the final rendered Codex request separator", () => {
    const wrapped = `# Context from my IDE setup:

## Selected text:
const fixture = "## My request for Codex:";

## Open tabs:
- prompt-template.ts

## My request for Codex:
Review the prompt template.`;

    expect(splitCodexIdePrompt(wrapped)).toEqual({
      ideContext: `# Context from my IDE setup:

## Selected text:
const fixture = "## My request for Codex:";

## Open tabs:
- prompt-template.ts`,
      userPrompt: "Review the prompt template."
    });
    expect(codexIdePromptUserText(wrapped)).toBe("Review the prompt template.");
  });

  it("splits rendered IDE prompts after leading environment context", () => {
    const wrapped = `<environment_context>
  <cwd>/Users/jacobo/Coding/koed</cwd>
</environment_context>

# Context from my IDE setup:

## Active file: koed-self-hosted/SECURITY.md

## My request for Codex:
Review the active file.`;

    expect(splitCodexIdePrompt(wrapped)).toEqual({
      ideContext: `# Context from my IDE setup:

## Active file: koed-self-hosted/SECURITY.md`,
      userPrompt: "Review the active file."
    });
    expect(codexIdePromptUserText(wrapped)).toBe("Review the active file.");
  });

  it("splits rendered IDE prompts with un-hashed section headings", () => {
    const wrapped = `Context from my IDE setup:

Active file: koed-self-hosted/SECURITY.md

Open tabs:
- SECURITY.md: koed-self-hosted/SECURITY.md

My request for Codex:
Review the active file.`;

    expect(splitCodexIdePrompt(wrapped)).toEqual({
      ideContext: `Context from my IDE setup:

Active file: koed-self-hosted/SECURITY.md

Open tabs:
- SECURITY.md: koed-self-hosted/SECURITY.md`,
      userPrompt: "Review the active file."
    });
    expect(codexIdePromptUserText(wrapped)).toBe("Review the active file.");
  });

  it("preserves literal image tags in user-authored requests", () => {
    const wrapped = `# Context from my IDE setup:

## Active file: koed-self-hosted/fixture.html

## My request for Codex:
Please explain why <image>logo</image> is invalid HTML in this fixture.`;

    expect(splitCodexIdePrompt(wrapped)).toMatchObject({
      userPrompt:
        "Please explain why <image>logo</image> is invalid HTML in this fixture."
    });
    expect(codexIdePromptUserText(wrapped)).toBe(
      "Please explain why <image>logo</image> is invalid HTML in this fixture."
    );
  });

  it("splits image-only wrapped prompts without exposing IDE context", () => {
    const wrapped = `# Context from my IDE setup:

## Active file: koed-self-hosted/SECURITY.md

## My request for Codex:
<image name=[Image #1]>raw image metadata</image>`;

    expect(splitCodexIdePrompt(wrapped)).toEqual({
      ideContext: `# Context from my IDE setup:

## Active file: koed-self-hosted/SECURITY.md`,
      userPrompt: ""
    });
    expect(codexIdePromptUserText(wrapped)).toBe("");
  });

  it("does not split user-authored text that only resembles IDE markers", () => {
    const markerLikePrompt = `# Context from my IDE setup:

This is a markdown example, not client-provided IDE context.

## My request for Codex:
Explain why this template exists.`;
    const fencedExample = `Please review this fixture:

\`\`\`text
# Context from my IDE setup:

## Active file: example.ts

## My request for Codex:
Do the thing.
\`\`\``;

    expect(splitCodexIdePrompt(markerLikePrompt)).toBeNull();
    expect(codexIdePromptUserText(markerLikePrompt)).toBe(markerLikePrompt);
    expect(splitCodexIdePrompt(fencedExample)).toBeNull();
    expect(codexIdePromptUserText(fencedExample)).toBe(fencedExample);
  });
});

const createFakeRepository = (): MemoryEngineRepository => {
  const events: MemoryEventRecord[] = [];
  const nodes: Array<{
    id: string;
    visibility: Visibility;
    sourceEventIds: string[];
    summaryText: string;
    lcmNodeSummaryStatus?: "pending" | "summarized";
  }> = [];

  return {
    async createMemoryEvent(actor, input) {
      const event: MemoryEventRecord = {
        id: `event-${events.length + 1}`,
        projectId: input.projectId,
        sessionId: input.sessionId ?? null,
        turnId: input.turnId ?? null,
        actor: input.actor,
        eventType: input.rawEventType,
        content: input.content,
        metadata: input.metadata ?? {},
        visibility: input.visibility,
        ownerUserId: actor.userId,
        createdAt: new Date(events.length).toISOString()
      };
      events.push(event);
      return event;
    },
    async searchMemoryNodes(actor, input) {
      const results = nodes
        .filter((node) => {
          return node.visibility === input.scope;
        })
        .filter((node) => node.summaryText.includes(input.query))
        .map(
          (node): MemorySearchResult => ({
            nodeId: node.id,
            visibility: node.visibility,
            summaryText: node.summaryText,
            lcmNodeSummaryStatus: node.lcmNodeSummaryStatus,
            score: 1,
            citation: { nodeId: node.id, visibility: node.visibility }
          })
        );
      return {
        results,
        metadata: {
          retrievalMode: "semantic_vector",
          vectorHitsCount: 0,
          textHitsCount: 0,
          embeddingModel: null,
          embeddingDimensions: null
        }
      };
    },
    async createLcmNodes(actor, input) {
      const scoped = events.filter(
        (event) => event.ownerUserId === actor.userId
      );
      const leafNodeIds = scoped.map((event) => {
        const id = `node-${nodes.length + 1}`;
        nodes.push({
          id,
          visibility: input.visibility,
          sourceEventIds: [event.id],
          summaryText: event.content,
          lcmNodeSummaryStatus: "pending"
        });
        return id;
      });
      let rollupNodeId: string | null = null;
      if (leafNodeIds.length > 1) {
        rollupNodeId = `node-${nodes.length + 1}`;
        nodes.push({
          id: rollupNodeId,
          visibility: input.visibility,
          sourceEventIds: scoped.map((event) => event.id),
          summaryText: scoped.map((event) => event.content).join("\n"),
          lcmNodeSummaryStatus: "pending"
        });
      }
      return { leafNodeIds, rollupNodeId };
    },
    async expandMemoryNode(nodeId) {
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        throw new Error("Memory node not found or not visible");
      }
      return {
        nodeId,
        visibility: node.visibility,
        sourceItems: node.sourceEventIds.map((eventId, position) => ({
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: eventId,
          position
        })),
        sources: node.sourceEventIds.map(
          (eventId) => events.find((event) => event.id === eventId)!
        )
      } satisfies ExpandedMemoryNode;
    }
  };
};

describe("provider-neutral memory engine", () => {
  const captureUserEvent = (
    engine: ReturnType<typeof createMemoryEngine>,
    userId: string,
    content: string,
    input: { projectId?: string; sessionId?: string } = {}
  ) =>
    engine.capturePersonalEvent({
      requesterContext: { userId },
      projectId: input.projectId ?? "w",
      sessionId: input.sessionId,
      actor: "user",
      eventType: "user_prompt",
      content
    });

  it("captures personal events as personal memory", async () => {
    const engine = createMemoryEngine(createFakeRepository());
    const event = await engine.capturePersonalEvent({
      requesterContext: { userId: "alice" },
      projectId: "workspace-1",
      actor: "assistant",
      eventType: "message",
      content: "Alice prefers concise summaries."
    });

    expect(event.visibility).toBe("personal");
    expect(event.ownerUserId).toBe("alice");
  });

  it("forwards source chronology when capturing personal events", async () => {
    let capturedInput:
      | Parameters<MemoryEngineRepository["createMemoryEvent"]>[1]
      | undefined;
    const repository = createFakeRepository();
    const createMemoryEvent = repository.createMemoryEvent.bind(repository);
    repository.createMemoryEvent = async (actor, input) => {
      capturedInput = input;
      return createMemoryEvent(actor, input);
    };
    const engine = createMemoryEngine(repository);

    await engine.capturePersonalEvent({
      requesterContext: { userId: "alice" },
      projectId: "workspace-1",
      actor: "assistant",
      eventType: "message",
      content: "Alice prefers concise summaries.",
      sourceEventTime: "2026-05-01T10:00:00.000Z",
      sourceSequence: 42
    });

    expect(capturedInput).toMatchObject({
      capturedAt: undefined,
      sourceEventTime: "2026-05-01T10:00:00.000Z",
      sourceSequence: 42
    });
  });

  it("creates LCM leaves and rollups for the requesting user", async () => {
    const repository = createFakeRepository();
    const engine = createMemoryEngine(repository);
    await captureUserEvent(engine, "alice", "Personal fact one");
    await captureUserEvent(engine, "alice", "Personal fact two");
    await captureUserEvent(engine, "bob", "Other user fact");

    const personal = await engine.scheduleCompaction({
      requesterContext: { userId: "alice" },
      visibility: "personal"
    });

    expect(personal.leafNodeIds).toHaveLength(2);
    expect(personal.rollupNodeId).not.toBeNull();
  });

  it("expands cited nodes into exact ordered source events", async () => {
    const engine = createMemoryEngine(createFakeRepository());
    await captureUserEvent(engine, "alice", "First source");
    await captureUserEvent(engine, "alice", "Second source");
    const compacted = await engine.scheduleCompaction({
      requesterContext: { userId: "alice" },
      visibility: "personal"
    });

    const expanded = await engine.expandMemoryNode(compacted.rollupNodeId!, {
      userId: "alice"
    });

    expect(expanded.sources.map((source) => source.content)).toEqual([
      "First source",
      "Second source"
    ]);
  });

  it("searches personal memory only", async () => {
    const repository = createFakeRepository();
    const engine = createMemoryEngine(repository);
    await captureUserEvent(engine, "alice", "alpha personal");
    await engine.scheduleCompaction({
      requesterContext: { userId: "alice" },
      visibility: "personal"
    });

    expect(
      (
        await engine.searchMemory({
          requesterContext: { userId: "alice" },
          query: "alpha",
          scope: "personal"
        })
      ).results
    ).toHaveLength(1);
  });

  it("returns a cited evidence bundle without requiring an answer provider", async () => {
    const engine = createMemoryEngine(createFakeRepository());
    await captureUserEvent(
      engine,
      "alice",
      "Project Zephyr uses local retrieval."
    );
    await engine.scheduleCompaction({
      requesterContext: { userId: "alice" },
      visibility: "personal"
    });

    const answer = await engine.answerMemory({
      requesterContext: { userId: "alice" },
      query: "Zephyr",
      scope: "personal"
    });

    expect(answer.answer).toContain("Evidence bundle returned");
    expect(answer.evidenceBundle.instructions).toContain(
      "Codex should synthesize"
    );
    expect(answer.evidenceBundle.evidence[0]?.summaryText).toContain(
      "Project Zephyr"
    );
    expect(answer.citations[0]?.visibility).toBe("personal");
  });

  it("surfaces pending LCM placeholders as degraded evidence for client synthesis", async () => {
    const engine = createMemoryEngine(createFakeRepository());
    await captureUserEvent(
      engine,
      "alice",
      "Project Borealis has pending source evidence."
    );
    await engine.scheduleCompaction({
      requesterContext: { userId: "alice" },
      visibility: "personal"
    });

    const answer = await engine.answerMemory({
      requesterContext: { userId: "alice" },
      query: "Borealis",
      scope: "personal"
    });

    expect(answer.evidenceBundle.evidence[0]).toMatchObject({
      summaryText: "Project Borealis has pending source evidence.",
      lcmNodeSummaryStatus: "pending"
    });
    expect(answer.evidenceBundle.instructions).toContain(
      "lcmNodeSummaryStatus=pending"
    );
    expect(answer.answer).toContain("pending_lcm_summary");
  });
});
