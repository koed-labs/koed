import { describe, expect, it } from "vitest";
import {
  chunkTextForModel,
  countTokensForModel,
  createMemoryEngine,
  estimateTokens,
  memorySourceInputSchema,
  resolveTokenEncodingForModel,
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
});

const createFakeRepository = (
  memberships = new Map<string, Set<string>>()
): MemoryEngineRepository => {
  const events: MemoryEventRecord[] = [];
  const nodes: Array<{
    id: string;
    visibility: Visibility;
    teamId: string | null;
    sourceEventIds: string[];
    summaryText: string;
    lcmNodeSummaryStatus?: "pending" | "summarized";
  }> = [];

  const assertTeamMember = (userId: string, teamId: string) => {
    if (!memberships.get(teamId)?.has(userId)) {
      throw new Error("User is not an active member of the requested team");
    }
  };

  return {
    async createMemoryEvent(actor, input) {
      if (input.visibility === "team") {
        if (!input.teamId) {
          throw new Error("Team visibility requires a teamId");
        }
        assertTeamMember(actor.userId, input.teamId);
      }
      const event: MemoryEventRecord = {
        id: `event-${events.length + 1}`,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId ?? null,
        turnId: input.turnId ?? null,
        actor: input.actor,
        eventType: input.rawEventType,
        content: input.content,
        metadata: input.metadata ?? {},
        visibility: input.visibility,
        ownerUserId: input.visibility === "personal" ? actor.userId : null,
        teamId: input.visibility === "team" ? input.teamId! : null,
        createdAt: new Date(events.length).toISOString()
      };
      events.push(event);
      return event;
    },
    async searchMemoryNodes(actor, input) {
      const results = nodes
        .filter((node) => {
          if (
            input.scope !== "personal_and_team" &&
            node.visibility !== input.scope
          ) {
            return false;
          }
          if (node.visibility === "team") {
            return Boolean(
              node.teamId && memberships.get(node.teamId)?.has(actor.userId)
            );
          }
          return true;
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
      if (input.visibility === "team") {
        if (!input.teamId) {
          throw new Error("Team visibility requires a teamId");
        }
        assertTeamMember(actor.userId, input.teamId);
      }
      const scoped = events.filter((event) =>
        input.visibility === "personal"
          ? event.ownerUserId === actor.userId
          : event.teamId === input.teamId
      );
      const leafNodeIds = scoped.map((event) => {
        const id = `node-${nodes.length + 1}`;
        nodes.push({
          id,
          visibility: input.visibility,
          teamId: input.teamId ?? null,
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
          teamId: input.teamId ?? null,
          sourceEventIds: scoped.map((event) => event.id),
          summaryText: scoped.map((event) => event.content).join("\n"),
          lcmNodeSummaryStatus: "pending"
        });
      }
      return { leafNodeIds, rollupNodeId };
    },
    async expandMemoryNode(nodeId, actor) {
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (
        !node ||
        (node.visibility === "team" &&
          (!node.teamId || !memberships.get(node.teamId)?.has(actor.userId)))
      ) {
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
    input: { workspaceId?: string; sessionId?: string } = {}
  ) =>
    engine.capturePersonalEvent({
      requesterContext: { userId },
      workspaceId: input.workspaceId ?? "w",
      sessionId: input.sessionId,
      actor: "user",
      eventType: "user_prompt",
      content
    });

  it("captures personal events as personal memory", async () => {
    const engine = createMemoryEngine(createFakeRepository());
    const event = await engine.capturePersonalEvent({
      requesterContext: { userId: "alice" },
      workspaceId: "workspace-1",
      actor: "assistant",
      eventType: "message",
      content: "Alice prefers concise summaries."
    });

    expect(event.visibility).toBe("personal");
    expect(event.ownerUserId).toBe("alice");
    expect(event.teamId).toBeNull();
  });

  it("allows repositories to enforce team visibility for captured events", async () => {
    const memberships = new Map([["team-1", new Set(["alice"])]]);
    const repository = createFakeRepository(memberships);

    await expect(
      repository.createMemoryEvent(
        { userId: "bob" },
        {
          actor: "user",
          eventType: "captured",
          rawEventType: "user_prompt",
          visibility: "team",
          teamId: "team-1",
          workspaceId: "workspace-1",
          content: "Team deploys on Fridays."
        }
      )
    ).rejects.toThrow("not an active member");

    const event = await repository.createMemoryEvent(
      { userId: "alice" },
      {
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        visibility: "team",
        teamId: "team-1",
        workspaceId: "workspace-1",
        content: "Team deploys on Fridays."
      }
    );
    expect(event.visibility).toBe("team");
  });

  it("creates LCM leaves and rollups without mixing visibility", async () => {
    const memberships = new Map([["team-1", new Set(["alice"])]]);
    const repository = createFakeRepository(memberships);
    const engine = createMemoryEngine(repository);
    await captureUserEvent(engine, "alice", "Personal fact one");
    await captureUserEvent(engine, "alice", "Personal fact two");
    await repository.createMemoryEvent(
      { userId: "alice" },
      {
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        visibility: "team",
        teamId: "team-1",
        workspaceId: "w",
        content: "Team fact"
      }
    );

    const personal = await engine.scheduleCompaction({
      requesterContext: { userId: "alice" },
      visibility: "personal"
    });
    const team = await engine.scheduleCompaction({
      requesterContext: { userId: "alice" },
      visibility: "team",
      teamId: "team-1"
    });

    expect(personal.leafNodeIds).toHaveLength(2);
    expect(personal.rollupNodeId).not.toBeNull();
    expect(team.leafNodeIds).toHaveLength(1);
    expect(team.rollupNodeId).toBeNull();
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

  it("keeps personal and team retrieval isolated unless mixed scope is requested", async () => {
    const memberships = new Map([["team-1", new Set(["alice"])]]);
    const repository = createFakeRepository(memberships);
    const engine = createMemoryEngine(repository);
    await captureUserEvent(engine, "alice", "alpha personal");
    await repository.createMemoryEvent(
      { userId: "alice" },
      {
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        visibility: "team",
        teamId: "team-1",
        workspaceId: "w",
        content: "alpha team"
      }
    );
    await engine.scheduleCompaction({
      requesterContext: { userId: "alice" },
      visibility: "personal"
    });
    await engine.scheduleCompaction({
      requesterContext: { userId: "alice" },
      visibility: "team",
      teamId: "team-1"
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
    expect(
      (
        await engine.searchMemory({
          requesterContext: { userId: "alice" },
          query: "alpha",
          scope: "team"
        })
      ).results
    ).toHaveLength(1);
    expect(
      (
        await engine.searchMemory({
          requesterContext: { userId: "alice" },
          query: "alpha",
          scope: "personal_and_team"
        })
      ).results.map((result) => result.citation.visibility)
    ).toEqual(["personal", "team"]);
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
