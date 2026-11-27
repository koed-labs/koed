import { describe, expect, it } from "vitest";
import {
  MAX_PROGRESSIVE_EVIDENCE_READS,
  ProgressiveWorkerEvidence,
  workerEvidencePageBytes
} from "../src/progressive-worker-evidence.js";
import {
  answerWithMemoryWorker,
  resolveMemoryAnswerWorkerConfig
} from "../src/answer-worker.js";
import { evidenceSize } from "../src/progressive-evidence.js";

describe("progressive Memory worker evidence reader", () => {
  it("reports separately labelled tokenizer counts, never a made-up Haiku mapping", () => {
    expect(evidenceSize("😀", "gpt-5.5")).toEqual({
      bytes: 4,
      model_encoding: "o200k_base",
      token_counts: { o200k_base: 1, cl100k_base: 2 }
    });
    expect(evidenceSize("😀", "haiku")).toEqual({
      bytes: 4,
      token_counts: { o200k_base: 1, cl100k_base: 2 }
    });
  });
  it("keeps context sizing separate from the investigation work counter", () => {
    const store = new ProgressiveWorkerEvidence();
    expect(workerEvidencePageBytes(8_192)).toBeLessThan(
      workerEvidencePageBytes(128_000)
    );
    expect(workerEvidencePageBytes()).toBe(workerEvidencePageBytes(128_000));
    for (let i = 0; i < MAX_PROGRESSIVE_EVIDENCE_READS; i++)
      expect(store.consumeRead()).toBe(true);
    store.resetAttempt();
    expect(store.consumeRead()).toBe(false);
    expect(store.remainingReads).toBe(0);
  });
  it("requires the complete source before returning it as observed", () => {
    const store = new ProgressiveWorkerEvidence();
    const original = {
      summaryText: "first " + "evidence 😀 ".repeat(800) + " last"
    };
    const [id] = store.register([original], (item) => item);
    expect(store.register([original], (item) => item)).toEqual([id]);
    expect(() => store.read(id!, 100, 4_000)).toThrow();
    let page = store.read(id!, 0, 4_000);
    let reconstructed = page.page.text;
    expect(page.complete).toBeUndefined();
    while (page.page.next_offset !== undefined) {
      page.advance();
      page = store.read(id!, page.page.next_offset, 4_000);
      reconstructed += page.page.text;
    }
    expect(page.complete).toBe(original);
    expect(JSON.parse(reconstructed)).toEqual(original);
    store.resetAttempt();
    expect(() => store.read(id!, 100, 4_000)).toThrow();
  });

  it("does not register oversized store entries or resolve invented source IDs", () => {
    const store = new ProgressiveWorkerEvidence();
    expect(
      store.register(
        [{ summaryText: "x".repeat(16 * 1024 * 1024) }],
        (item) => item
      )
    ).toEqual([]);
    expect(store.full).toBe(true);
    expect(() => store.read(1, 0, 4_000)).toThrow();
  });
});

const liveProvider = process.env.KOED_PROGRESSIVE_LIVE_PROVIDER;

it.runIf(liveProvider === "codex" || liveProvider === "claude")(
  "reads exact details beyond the first page through the real Memory worker",
  async () => {
    const body =
      "The accepted Kestrel migration decision was recorded below. " +
      "Old notes about unrelated configuration do not supersede it. ".repeat(
        215
      ) +
      "Final accepted deployment command: kestrel migrate --lane indigo-721.";
    const hit = {
      nodeId: "kestrel-migration",
      sourceType: "memory_node",
      sourceId: "kestrel-migration",
      sourceChunkIndex: 0,
      sourceGeneration: "fixture-v1",
      visibility: "personal",
      summaryRepresentation: "complete_summary",
      summaryText: body
    };
    const config = resolveMemoryAnswerWorkerConfig(
      {
        ...process.env,
        KOED_EXPERIMENTAL_PROGRESSIVE_EVIDENCE: "1",
        MEMORY_ANSWER_PROVIDER: liveProvider!,
        MEMORY_ANSWER_MAX_ATTEMPTS: "1",
        MEMORY_ANSWER_MAX_PROMPT_TOKENS: "12000",
        MEMORY_ANSWER_MAX_EVIDENCE_TOKENS: "256"
      },
      {
        model: liveProvider === "codex" ? "gpt-6-luna" : "haiku",
        reasoningEffort: "low",
        timeoutMs: 90_000
      }
    );
    const response = await answerWithMemoryWorker(
      {
        evidenceBundle: {
          query:
            "What exact deployment command did we accept for the Kestrel migration?",
          evidence: []
        }
      },
      {
        config,
        searchDomain: "global",
        responseDetail: "internal",
        client: {
          async search(input) {
            const available = ["leaf_search"];
            return input.retrieval_stage === "score_scan"
              ? {
                  retrieval: {
                    stages: available.map((name) => ({
                      name,
                      countAboveThreshold: 1,
                      maxAllowed: 1
                    }))
                  }
                }
              : {
                  hits: available.includes(String(input.retrieval_stage))
                    ? [hit]
                    : []
                };
          },
          async expand() {
            return { evidence: [] };
          }
        }
      }
    );
    expect(response.localMemoryWorker.errorMessage).toBeUndefined();
    expect(response.localMemoryWorker).toMatchObject({
      usedFallback: false,
      memoryStatus: "found"
    });
    expect(response.markdown).toContain("kestrel migrate --lane indigo-721");
    expect(response.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ summaryText: body })])
    );
  },
  110_000
);
