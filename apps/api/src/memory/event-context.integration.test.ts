import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LcmSourceItem, MemoryEventRecord } from "@koed/core";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "@koed/db";
import { buildServer } from "../server/index.js";

vi.mock("node-pty", () => ({
  spawn: () => {
    throw new Error("Unexpected terminal launch in event context test");
  }
}));

interface Hit {
  sourceId: string;
  summaryText: string;
  sourceItems?: LcmSourceItem[];
}

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("authenticated canonical event context", () => {
  const pool = createDbPool({ connectionString: databaseUrl! });
  beforeAll(() => runDbMigrations(pool), 120_000);
  afterAll(() => pool.end());

  it("returns full matched events and adjacent context without changing diagnostic fragments or authorization", async () => {
    const home = mkdtempSync(join(tmpdir(), "koed-event-context-api-"));
    vi.stubEnv("KOED_HOME", home);
    vi.stubEnv("KOED_DEPLOYMENT_PROFILE", "developer");
    vi.stubEnv("API_TOKEN_PEPPER", "synthetic-event-context-pepper");
    vi.stubEnv(
      "EMBEDDING_SERVICE_URL",
      "http://embedding.event-context.fixture"
    );
    vi.stubEnv("EMBEDDING_MODEL", "qwen3-0.6b");
    vi.stubEnv("MEMORY_LCM_LEAF_EVENT_THRESHOLD", "2");
    vi.stubEnv("MEMORY_LCM_FRESH_EVENT_TAIL", "1");
    vi.stubEnv("MEMORY_LCM_DEPTH1_FANOUT", "2");
    const repo = createMemorySourceRepository(pool);
    const createIdentity = async () => {
      const user = await repo.createUser({
        email: `event-context-api-${randomUUID()}@example.test`
      });
      const token = `synthetic-${randomUUID()}`;
      await repo.createApiToken({
        ownerUserId: user.id,
        name: "Synthetic event context",
        tokenHash: createHash("sha256")
          .update(`synthetic-event-context-pepper${token}`)
          .digest("hex"),
        tokenPrefix: token.slice(0, 12)
      });
      return { actor: { userId: user.id }, token };
    };
    const owner = await createIdentity();
    const other = await createIdentity();
    const session = await repo.createCapturedSession(owner.actor, {
      sourceRuntime: "codex",
      externalSessionId: randomUUID()
    });
    const contents = [
      "Synthetic preceding statement: ticket T12 concerns boundary context.",
      "Synthetic canonical statement: the complete boundary value is 4254, not the fragment alone.",
      "Synthetic following statement: this completes the preceding boundary statement."
    ];
    const events: MemoryEventRecord[] = [];
    for (const [index, content] of contents.entries()) {
      events.push(
        await repo.createMemoryEvent(owner.actor, {
          visibility: "personal",
          sessionId: session.id,
          projectId: "synthetic-event-context",
          actor: index === 2 ? "assistant" : "user",
          eventType: "captured",
          rawEventType: "user_prompt",
          content,
          capturedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
          captureMethod: "api",
          idempotencyKey: randomUUID()
        })
      );
    }
    const source = await repo.getEmbeddableSource(
      "memory_event",
      events[1]!.id
    );
    expect(source).not.toBeNull();
    const vector = Array<number>(1024).fill(0);
    vector[0] = 1;
    const fragment =
      "Synthetic embedding fragment without the complete boundary value.";
    await repo.replaceSourceEmbeddings({
      source: source!,
      model: "qwen3-0.6b",
      dimensions: 1024,
      version: "qwen3-0.6b",
      modelArtifactHash: "a".repeat(64),
      tokenizer: "qwen3-embedding-0.6b-gguf",
      inputTransform: "qwen3-retrieval-document-v1",
      pooling: "last",
      normalization: "l2",
      chunks: [
        {
          vector,
          chunkIndex: 0,
          chunkCount: 1,
          inputTokenCount: 12,
          sourceText: fragment
        }
      ]
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          model: "qwen3-0.6b",
          dimensions: 1024,
          vectors: [vector],
          measuredTokens: 5
        })
      )
    );
    const app = await buildServer({
      repository: repo,
      runMemoryJobsInlineForTests: true
    });
    try {
      const payload = {
        query: "synthetic boundary value",
        search_domain: "session",
        session_id: session.id,
        retrieval_stage: "raw_fallback_search",
        limit: 5
      };
      const request = (
        url: string,
        token: string,
        extra: Record<string, unknown> = {}
      ) =>
        app.inject({
          method: "POST",
          url,
          headers: { authorization: `Bearer ${token}` },
          payload: { ...payload, ...extra }
        });
      const search = await request("/v1/memory/search", owner.token, {
        include_event_context: true
      });
      expect(search.statusCode).toBe(200);
      const hit = search
        .json<{ hits: Hit[] }>()
        .hits.find((item) => item.sourceId === events[1]!.id);
      expect(hit?.summaryText).toBe(contents[1]);
      expect(hit?.sourceItems?.map((item) => item.sourceId)).toEqual(
        events.map((event) => event.id)
      );
      expect(hit?.sourceItems?.map((item) => item.text)).toEqual(contents);
      expect(
        hit?.sourceItems?.map((item) => item.provenance?.contextRole)
      ).toEqual(["preceding", "matched", "following"]);

      const answer = await request("/v1/memory/answer", owner.token);
      expect(answer.statusCode).toBe(200);
      const answerHit = answer
        .json<{ evidence: Hit[] }>()
        .evidence.find((item) => item.sourceId === events[1]!.id);
      expect(answerHit?.summaryText).toBe(contents[1]);
      expect(answerHit?.sourceItems?.map((item) => item.sourceId)).toEqual(
        events.map((event) => event.id)
      );

      const diagnostic = await request("/v1/memory/search", owner.token, {
        include_event_context: false
      });
      expect(diagnostic.statusCode).toBe(200);
      const diagnosticHit = diagnostic
        .json<{ hits: Hit[] }>()
        .hits.find((item) => item.sourceId === events[1]!.id);
      expect(diagnosticHit?.summaryText).toBe(fragment);
      expect(diagnosticHit?.sourceItems).toBeUndefined();

      const denied = await request("/v1/memory/search", other.token, {
        include_event_context: true
      });
      expect(denied.statusCode).toBe(200);
      expect(denied.json<{ hits: Hit[] }>().hits).toEqual([]);
      const deniedAnswer = await request("/v1/memory/answer", other.token);
      expect(deniedAnswer.statusCode).toBe(200);
      expect(deniedAnswer.json<{ evidence: Hit[] }>().evidence).toEqual([]);

      const compacted = await repo.createLcmNodes(owner.actor, {
        visibility: "personal",
        sessionId: session.id
      });
      expect(compacted.leafNodeIds).toHaveLength(1);
      const claimed = await app.inject({
        method: "POST",
        url: "/v1/memory/lcm/summary-claims",
        headers: { authorization: `Bearer ${owner.token}` },
        payload: {
          claimantId: "synthetic-api-context-test",
          compatibilityContractHash: "b".repeat(64),
          limit: 1
        }
      });
      expect(claimed.statusCode).toBe(200);
      const claims = claimed.json<{
        claims: Array<{
          node: { sourceItems: LcmSourceItem[]; contextItems: LcmSourceItem[] };
        }>;
      }>().claims;
      expect(claims).toHaveLength(1);
      expect(claims[0]!.node.sourceItems.map((item) => item.sourceId)).toEqual(
        events.slice(0, 2).map((event) => event.id)
      );
      expect(claims[0]!.node.contextItems.map((item) => item.sourceId)).toEqual(
        [events[2]!.id]
      );
    } finally {
      await app.close();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
