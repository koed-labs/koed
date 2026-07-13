import { describe, expect, it, vi } from "vitest";
import { MemoryApiError, type MemoryApiClient } from "../src/index.js";
import { startCuratedMemoryReviewService } from "../src/curated-memory-review-service.js";
import {
  resolveCuratedMemoryReviewConfig,
  type CuratedMemoryReviewBundle,
  type CuratedMemoryReviewConfig
} from "../src/curated-memory-review-worker.js";

const evidenceId = "11111111-1111-4111-8111-111111111111";
const proposalId = "22222222-2222-4222-8222-222222222222";

const reviewBundle = (): CuratedMemoryReviewBundle => ({
  proposal: {
    id: proposalId,
    proposedClaim: "window seat",
    proposedTopic: "Travel",
    rationale: null,
    tags: ["travel"],
    sensitivityHint: "normal",
    expiresAt: null,
    operation: "store",
    targetAssertionId: null,
    attemptCount: 1
  },
  evidence: [
    {
      sourceType: "conversation_item",
      sourceId: evidenceId,
      sourceHash: "source-hash-1",
      text: "I strongly prefer a window seat when flying.",
      occurredAt: "2026-07-13T10:00:00.000Z",
      sessionId: null,
      metadata: { sourceEventType: "user_message" }
    }
  ],
  rejectedSourceCount: 0,
  currentAssertions: []
});

const serviceConfig = () =>
  resolveCuratedMemoryReviewConfig(
    {},
    { model: "gpt-5.4-mini", timeoutMs: 1_000, maxAttempts: 2 }
  );

const client = (submit: ReturnType<typeof vi.fn>) =>
  ({
    listLocalMemoryAgentSettings: vi.fn().mockResolvedValue({ settings: [] }),
    claimPendingCuratedMemoryReviews: vi
      .fn()
      .mockResolvedValue({ reviews: [reviewBundle()] }),
    submitCuratedMemoryReview: submit
  }) as unknown as MemoryApiClient;

describe("Curated Memory review service", () => {
  it("claims, reviews, and submits selected evidence asynchronously", async () => {
    const submit = vi
      .fn()
      .mockResolvedValue({ proposal: { status: "stored" } });
    const reviewer = vi.fn().mockResolvedValue({
      decision: {
        outcome: "accepted",
        operation: "store",
        target_assertion_id: null,
        selected_evidence_ids: [evidenceId],
        assertion_text: "The user strongly prefers window seats when flying.",
        topic_title: "Travel preferences",
        tags: ["travel"],
        sensitivity: "normal",
        confidence: 95,
        expires_at: null,
        reason_category: "new_durable_memory",
        decision_reason: "Supported durable preference."
      },
      model: "gpt-5.4-mini",
      promptTokens: 420,
      inputTokens: 450,
      outputTokens: 90,
      latencyMs: 1_200,
      attemptIndex: 1
    });
    const service = startCuratedMemoryReviewService(client(submit), {
      workerConfig: serviceConfig(),
      reviewer
    });
    try {
      await expect(service.trigger("test")).resolves.toMatchObject({
        ran: true,
        result: { claimed: 1 }
      });
      expect(reviewer).toHaveBeenCalledOnce();
      expect(submit).toHaveBeenCalledWith(
        proposalId,
        expect.objectContaining({
          outcome: "accepted",
          attempt_count: 1,
          selected_evidence_ids: [evidenceId],
          evidence_revisions: [
            {
              source_type: "conversation_item",
              source_id: evidenceId,
              source_hash: "source-hash-1"
            }
          ],
          assertion_text: "The user strongly prefers window seats when flying."
        })
      );
    } finally {
      service.stop();
    }
  });

  it("releases a stale review for a fresh evidence retry", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(
        new MemoryApiError("evidence changed during review", { status: 409 })
      )
      .mockResolvedValueOnce({ proposal: { status: "pending" } });
    const reviewer = vi.fn().mockResolvedValue({
      decision: {
        outcome: "accepted",
        operation: "store",
        target_assertion_id: null,
        selected_evidence_ids: [evidenceId],
        assertion_text: "The user prefers window seats.",
        topic_title: null,
        tags: [],
        sensitivity: "normal",
        confidence: 90,
        expires_at: null,
        reason_category: "new_durable_memory",
        decision_reason: "Supported."
      },
      model: "gpt-5.4-mini",
      promptTokens: 300,
      inputTokens: 320,
      outputTokens: 70,
      latencyMs: 800,
      attemptIndex: 1
    });
    const service = startCuratedMemoryReviewService(client(submit), {
      workerConfig: serviceConfig(),
      reviewer
    });
    try {
      await service.trigger("test-stale");
      expect(submit).toHaveBeenCalledTimes(2);
      expect(submit.mock.calls[1]).toEqual([
        proposalId,
        {
          outcome: "retry",
          attempt_count: 1,
          error_message: "evidence changed during review"
        }
      ]);
    } finally {
      service.stop();
    }
  });

  it("applies stored reviewer selection without losing resolved runtime fields", async () => {
    const submit = vi
      .fn()
      .mockResolvedValue({ proposal: { status: "stored" } });
    const apiClient = client(submit);
    vi.mocked(apiClient.listLocalMemoryAgentSettings).mockResolvedValue({
      settings: [
        {
          ownerUserId: "44444444-4444-4444-8444-444444444444",
          flowKey: "curated_memory_review",
          provider: "codex",
          model: "selected-review-model",
          reasoningEffort: "high",
          timeoutMs: 2_000,
          maxAttempts: 3,
          createdAt: "2026-07-13T00:00:00.000Z",
          updatedAt: "2026-07-13T00:00:00.000Z"
        }
      ]
    });
    const reviewer = vi.fn().mockResolvedValue({
      decision: {
        outcome: "rejected",
        reason_category: "not_durable_memory",
        decision_reason: "Not durable."
      },
      model: "selected-review-model",
      promptTokens: 100,
      inputTokens: 120,
      outputTokens: 20,
      latencyMs: 100,
      attemptIndex: 1
    });
    const workerConfig = resolveCuratedMemoryReviewConfig(
      { TEST_CURATED_RUNTIME: "preserved" },
      {
        model: "fallback-model",
        appServerBinary: "/opt/koed/bin/codex",
        cwd: "/opt/koed/runtime",
        maxPromptTokens: 12_345,
        retryDelayMs: 321
      }
    );
    const service = startCuratedMemoryReviewService(apiClient, {
      workerConfig,
      reviewer
    });
    try {
      await service.trigger("test-selection");
      const receivedConfig = reviewer.mock.calls[0]?.[1] as
        | CuratedMemoryReviewConfig
        | undefined;
      expect(receivedConfig).toMatchObject({
        model: "selected-review-model",
        reasoningEffort: "high",
        timeoutMs: 2_000,
        maxAttempts: 3,
        appServerBinary: "/opt/koed/bin/codex",
        cwd: "/opt/koed/runtime",
        maxPromptTokens: 12_345,
        retryDelayMs: 321,
        env: { TEST_CURATED_RUNTIME: "preserved" }
      });
    } finally {
      service.stop();
    }
  });
});
