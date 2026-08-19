import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryApiError, type MemoryApiClient } from "../src/index.js";
import { startCuratedMemoryReviewService } from "../src/curated-memory-review-service.js";
import {
  resolveCuratedMemoryReviewConfig,
  type CuratedMemoryReviewBundle,
  type CuratedMemoryReviewConfig
} from "../src/curated-memory-review-worker.js";

const identityHash = "f".repeat(64);
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
    listAiClientInstances: vi.fn().mockResolvedValue({
      instances: [],
      capabilitySnapshots: []
    }),
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

  it("resolves stored Claude settings without inheriting the startup Codex runtime", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-curated-claude-")
    );
    const claudeExecutable = path.join(directory, "claude");
    fs.writeFileSync(claudeExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const submit = vi
      .fn()
      .mockResolvedValue({ proposal: { status: "stored" } });
    const apiClient = client(submit);
    vi.mocked(apiClient.listLocalMemoryAgentSettings).mockResolvedValue({
      settings: [
        {
          ownerUserId: "44444444-4444-4444-8444-444444444444",
          flowKey: "curated_memory_review",
          provider: "claude",
          aiClientInstanceId: "claude.default",
          model: "selected-review-model",
          reasoningEffort: "high",
          timeoutMs: 2_000,
          maxAttempts: 3,
          createdAt: "2026-07-13T00:00:00.000Z",
          updatedAt: "2026-07-13T00:00:00.000Z"
        }
      ]
    });
    vi.mocked(apiClient.listAiClientInstances).mockResolvedValue({
      instances: [
        {
          instanceId: "claude.default",
          driverId: "claude",
          enabled: true,
          configIdentityHash: identityHash
        }
      ],
      capabilitySnapshots: [
        {
          instanceId: "claude.default",
          installationIdentityHash: identityHash,
          healthState: "healthy",
          authenticationState: "authenticated",
          stale: false,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          models: [
            {
              id: "selected-review-model",
              fullId: "selected-review-model",
              supportedReasoningEfforts: ["high"]
            }
          ],
          capabilities: {
            descriptors: {
              local_synthesis: {
                id: "local_synthesis",
                support: "supported",
                readiness: "ready",
                diagnostics: []
              }
            }
          }
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
      {
        TEST_CURATED_RUNTIME: "preserved",
        KOED_CLAUDE_CODE_EXECUTABLE: claudeExecutable
      },
      {
        model: "fallback-model",
        executablePath: "/opt/koed/bin/codex",
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
        provider: "claude",
        aiClientInstanceId: "claude.default",
        model: "selected-review-model",
        reasoningEffort: "high",
        timeoutMs: 2_000,
        maxAttempts: 3,
        executablePath: fs.realpathSync(claudeExecutable),
        cwd: process.cwd(),
        maxPromptTokens: 12_345,
        retryDelayMs: 321,
        env: {
          TEST_CURATED_RUNTIME: "preserved",
          KOED_CLAUDE_CODE_EXECUTABLE: claudeExecutable
        }
      });
      expect(submit).toHaveBeenCalledOnce();
      expect(submit.mock.calls[0]?.[0]).toBe(proposalId);
      expect(submit.mock.calls[0]?.[1]).toMatchObject({
        worker_result: {
          reviewer: "local_claude_agent_sdk",
          provider: "claude",
          aiClientInstanceId: "claude.default",
          transport: "agent_sdk"
        }
      });
    } finally {
      service.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
