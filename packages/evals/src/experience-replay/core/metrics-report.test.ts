import { describe, expect, it } from "vitest";
import {
  completeTaskBootstrap,
  matchedRepeatBlockBootstrap
} from "./bootstrap.js";
import {
  PRIMARY_COMPARISON,
  REQUIRED_COMPARISONS,
  missingOutcomeBounds,
  summarizeComparison,
  taskFirstResourceDelta,
  type ReplayOutcome,
  type TaskRewardContract
} from "./metrics.js";
import {
  SCIENTIFIC_DISCLOSURE,
  assertPublicationHasNoSecrets,
  createMachineReport,
  redactPublicationReport,
  renderMarkdownReport
} from "./report.js";
import { CONDITIONS } from "./schedule.js";

const contracts: TaskRewardContract[] = [
  { taskDigest: "t1", rewardMin: 0, rewardMax: 1 },
  { taskDigest: "t2", rewardMin: 0, rewardMax: 1 }
];

const rewards: Record<string, Record<(typeof CONDITIONS)[number], number[]>> = {
  t1: {
    cold: [0.1, 0.3],
    empty: [0.2, 0.3],
    placebo: [0.2, 0.4],
    relevant: [0.8, 0.6]
  },
  t2: {
    cold: [0.3, 0.3],
    empty: [0.4, 0.4],
    placebo: [0.6, 0.4],
    relevant: [0.4, 0.2]
  }
};

const outcomes: ReplayOutcome[] = Object.entries(rewards).flatMap(
  ([taskDigest, byCondition]) =>
    CONDITIONS.flatMap((condition) =>
      byCondition[condition].map((reward, repeat) => ({
        taskDigest,
        condition,
        repeat,
        reward,
        passed: reward >= 0.5,
        latencyMs: reward * 1_000 + 100,
        tokens: reward * 100 + 10,
        costUsd: reward + 0.1
      }))
    )
);

const detailedAttempt: ReplayOutcome = {
  ...(outcomes[0] as ReplayOutcome),
  durations: { setupMs: 11, agentMs: 22, verifierMs: 33 },
  tokenUsage: {
    uncachedInput: 101,
    cachedInput: 102,
    output: 103,
    reasoning: 104
  },
  costs: {
    providerBilledUsd: 1.01,
    apiEquivalentUsd: 2.02,
    subscriptionUsd: 3.03
  },
  interactions: {
    turns: 4,
    toolCalls: 5,
    toolFailures: 1,
    mcpCalls: 6,
    mcpFailures: 2,
    memoryAnswerCalls: 7,
    memoryAnswerFailures: 3
  },
  workers: {
    memoryAnswer: {
      calls: 8,
      failures: 1,
      durationMs: 81,
      tokens: { uncachedInput: 82, cachedInput: 83, output: 84, reasoning: 85 },
      costs: {
        providerBilledUsd: 8.1,
        apiEquivalentUsd: 8.2,
        subscriptionUsd: 8.3
      }
    },
    lcmSummary: {
      calls: 9,
      failures: 2,
      durationMs: 91,
      tokens: { uncachedInput: 92, cachedInput: 93, output: 94, reasoning: 95 },
      costs: {
        providerBilledUsd: 9.1,
        apiEquivalentUsd: 9.2,
        subscriptionUsd: 9.3
      }
    },
    sessionTitle: {
      calls: 10,
      failures: 3,
      durationMs: 101,
      tokens: {
        uncachedInput: 102,
        cachedInput: 103,
        output: 104,
        reasoning: 105
      },
      costs: {
        providerBilledUsd: 10.1,
        apiEquivalentUsd: 10.2,
        subscriptionUsd: 10.3
      }
    }
  },
  recall: { searches: 11, expansions: 12, stages: 13, evidenceCount: 14 },
  embedding: { calls: 15, tokens: 16, durationMs: 17 },
  pipeline: { projectionMs: 18, lcmMs: 19, queueMs: 20 },
  rss: { apiBytes: 21, runtimeBytes: 22, workerBytes: 23 },
  failureCategory: "agent_timeout",
  failureKind: "agent",
  failurePhase: "agent",
  source: {
    sourceTaskDigest: "source-t1",
    sourcePassed: true,
    sourceCategory: "shell",
    sourcePassFailSplit: "passed",
    sourceCategorySplit: "shell-passed"
  }
};

describe("task-first analysis", () => {
  it("averages repeats within tasks before comparing tasks", () => {
    const summary = summarizeComparison(
      outcomes,
      contracts,
      PRIMARY_COMPARISON,
      2
    );
    expect(summary.taskDeltas[0]?.delta).toBeCloseTo(0.4);
    expect(summary.taskDeltas[1]?.delta).toBeCloseTo(-0.2);
    expect(summary.meanDelta).toBeCloseTo(0.1);
    expect(summary.medianDelta).toBeCloseTo(0.1);
    expect([summary.wins, summary.losses, summary.ties]).toEqual([1, 1, 0]);
    expect(
      taskFirstResourceDelta(outcomes, PRIMARY_COMPARISON, "tokens", 2)
    ).toBeCloseTo(10);
    expect(summary.tokensDelta).toBeCloseTo(10);
    expect(summary.latencyMsDelta).toBeCloseTo(100);
    expect(summary.costUsdDelta).toBeCloseTo(0.1);
  });

  it("keeps every required comparison task-first", () => {
    expect(
      REQUIRED_COMPARISONS.map(
        (comparison) =>
          summarizeComparison(outcomes, contracts, comparison, 2).comparison
      )
    ).toEqual([
      "relevant - placebo",
      "relevant - cold",
      "relevant - empty",
      "empty - cold",
      "placebo - empty"
    ]);
  });

  it("keeps missing outcomes missing and reports complete-case plus best/worst bounds", () => {
    const incomplete = outcomes.map((outcome) =>
      outcome.taskDigest === "t2" &&
      outcome.condition === "relevant" &&
      outcome.repeat === 1
        ? { ...outcome, reward: null }
        : outcome
    );
    const bounds = missingOutcomeBounds(
      incomplete,
      contracts,
      PRIMARY_COMPARISON,
      2
    );
    expect(bounds.completeCaseEstimate).toBeCloseTo(0.4);
    expect(bounds.worstCaseEstimate).toBeCloseTo(0.05);
    expect(bounds.bestCaseEstimate).toBeCloseTo(0.3);
    expect(bounds.missingOutcomeCount).toBe(1);
    expect(bounds.completeTaskCount).toBe(1);
  });
});

describe("cluster-preserving bootstrap", () => {
  it("resamples matched four-arm repeat blocks and complete task records deterministically", () => {
    const repeat = matchedRepeatBlockBootstrap(
      outcomes,
      contracts,
      PRIMARY_COMPARISON,
      { seed: "repeat", resamples: 500 }
    );
    const tasks = completeTaskBootstrap(
      outcomes,
      contracts,
      PRIMARY_COMPARISON,
      { seed: "tasks", resamples: 500 }
    );
    expect(
      matchedRepeatBlockBootstrap(outcomes, contracts, PRIMARY_COMPARISON, {
        seed: "repeat",
        resamples: 500
      })
    ).toEqual(repeat);
    expect(
      completeTaskBootstrap(outcomes, contracts, PRIMARY_COMPARISON, {
        seed: "tasks",
        resamples: 500
      })
    ).toEqual(tasks);
    expect(repeat.method).toBe("matched-repeat-block");
    expect(tasks.method).toBe("complete-task");
    expect(repeat.lower).toBeLessThanOrEqual(repeat.upper);
    expect(tasks.lower).toBeLessThanOrEqual(tasks.upper);
  });

  it("fails closed rather than breaking a matched block around a missing arm", () => {
    const incomplete = outcomes.filter(
      (outcome) =>
        !(outcome.taskDigest === "t2" && outcome.condition === "empty")
    );
    expect(() =>
      matchedRepeatBlockBootstrap(incomplete, contracts, PRIMARY_COMPARISON, {
        seed: "x",
        resamples: 10
      })
    ).toThrow("complete four-condition block");

    const incompleteTask = outcomes.filter(
      (outcome) =>
        !(
          outcome.taskDigest === "t2" &&
          outcome.condition === "empty" &&
          outcome.repeat === 1
        )
    );
    expect(() =>
      completeTaskBootstrap(incompleteTask, contracts, PRIMARY_COMPARISON, {
        seed: "x",
        resamples: 10
      })
    ).toThrow("complete task records");
  });
});

describe("report and disclosure", () => {
  it("sets non-leaderboard flags and begins Markdown with the mandatory disclosure", () => {
    const comparison = summarizeComparison(
      outcomes,
      contracts,
      PRIMARY_COMPARISON,
      2
    );
    const machine = createMachineReport({
      runId: "run-1",
      executionKind: "benchmark_profile",
      codexAuthMode: "api_key",
      profile: "quick",
      model: "gpt-5.6-luna",
      taskCount: 2,
      attemptedReplayCount: 16,
      failureCount: 0,
      preparationCostUsd: 1.25,
      comparisons: [comparison],
      attempts: outcomes,
      exclusions: []
    });
    expect(machine.benchmark_kind).toBe("koed_experience_replay");
    expect(machine.standard_leaderboard_comparable).toBe(false);
    expect(
      renderMarkdownReport(machine).startsWith(SCIENTIFIC_DISCLOSURE)
    ).toBe(true);
    expect(() =>
      createMachineReport({
        ...machine,
        profile: "standard",
        intervals: undefined
      })
    ).toThrow("require");
  });

  it("projects the publication schema while retaining statistical and resource metrics", () => {
    const comparison = summarizeComparison(
      outcomes,
      contracts,
      PRIMARY_COMPARISON,
      2
    );
    const repeat = matchedRepeatBlockBootstrap(
      outcomes,
      contracts,
      PRIMARY_COMPARISON,
      { seed: "publication-repeat", resamples: 20 }
    );
    const task = completeTaskBootstrap(
      outcomes,
      contracts,
      PRIMARY_COMPARISON,
      { seed: "publication-task", resamples: 20 }
    );
    const report = createMachineReport({
      runId: "run-publication",
      executionKind: "benchmark_profile",
      codexAuthMode: "api_key",
      profile: "standard",
      model: "test-model",
      taskCount: 2,
      attemptedReplayCount: 16,
      failureCount: 1,
      preparationCostUsd: 1.25,
      comparisons: [comparison],
      intervals: { [comparison.comparison]: { repeat, task } },
      attempts: [detailedAttempt, ...outcomes.slice(1)],
      exclusions: [
        {
          taskDigest: "excluded-task",
          category: "source_unavailable",
          phase: "preparation",
          source: {
            sourceTaskDigest: null,
            sourcePassed: false,
            sourceCategory: "database",
            sourcePassFailSplit: "failed",
            sourceCategorySplit: "database-failed"
          }
        }
      ]
    });
    const publication = redactPublicationReport({
      ...report,
      payload: { transcript: "private" },
      config: { model_api_key: "not-published" },
      trajectory: ["private"],
      comparisons: [
        {
          ...comparison,
          prompt: "private",
          payload: { toolOutput: "private" }
        }
      ]
    }) as Record<string, unknown>;

    expect(publication).toMatchObject({
      disclosure: SCIENTIFIC_DISCLOSURE,
      failureCount: 1,
      preparationCostUsd: 1.25,
      comparisons: [
        {
          comparison: "relevant - placebo",
          tokensDelta: 10,
          latencyMsDelta: 100,
          completeTaskCount: 2,
          missingOutcomeCount: 0
        }
      ],
      intervals: {
        "relevant - placebo": {
          repeat: { method: "matched-repeat-block", resamples: 20 },
          task: { method: "complete-task", resamples: 20 }
        }
      }
    });
    expect(publication).not.toHaveProperty("payload");
    expect(publication).not.toHaveProperty("config");
    expect(publication).not.toHaveProperty("trajectory");
    expect(JSON.stringify(publication)).not.toContain("private");
    const publishedComparison = (
      publication.comparisons as Record<string, unknown>[]
    )[0] as Record<string, number>;
    expect(publishedComparison.costUsdDelta).toBeCloseTo(0.1);
    expect(publishedComparison.worstCaseEstimate).toBeCloseTo(0.1);
    expect(publishedComparison.bestCaseEstimate).toBeCloseTo(0.1);
    expect(
      (publication.attempts as Record<string, unknown>[])[0]
    ).toMatchObject({
      durations: { setupMs: 11, agentMs: 22, verifierMs: 33 },
      tokenUsage: {
        uncachedInput: 101,
        cachedInput: 102,
        output: 103,
        reasoning: 104
      },
      costs: {
        providerBilledUsd: 1.01,
        apiEquivalentUsd: 2.02,
        subscriptionUsd: 3.03
      },
      interactions: {
        turns: 4,
        toolCalls: 5,
        toolFailures: 1,
        mcpCalls: 6,
        mcpFailures: 2,
        memoryAnswerCalls: 7,
        memoryAnswerFailures: 3
      },
      workers: {
        memoryAnswer: { calls: 8, failures: 1, durationMs: 81 },
        lcmSummary: { calls: 9, failures: 2, durationMs: 91 },
        sessionTitle: { calls: 10, failures: 3, durationMs: 101 }
      },
      recall: { searches: 11, expansions: 12, stages: 13, evidenceCount: 14 },
      embedding: { calls: 15, tokens: 16, durationMs: 17 },
      pipeline: { projectionMs: 18, lcmMs: 19, queueMs: 20 },
      rss: { apiBytes: 21, runtimeBytes: 22, workerBytes: 23 },
      failureCategory: "agent_timeout",
      failureKind: "agent",
      failurePhase: "agent",
      source: {
        sourceTaskDigest: "source-t1",
        sourcePassed: true,
        sourceCategory: "shell",
        sourcePassFailSplit: "passed",
        sourceCategorySplit: "shell-passed"
      }
    });
    expect(publication).toMatchObject({
      exclusions: [
        {
          taskDigest: "excluded-task",
          category: "source_unavailable",
          phase: "preparation"
        }
      ]
    });
    expect(publication.attempts as unknown[]).toHaveLength(outcomes.length);
  });

  it("drops type-confused payloads from telemetry and enum slots", () => {
    const publication = redactPublicationReport({
      report_version: 1,
      benchmark_kind: "koed_experience_replay",
      standard_leaderboard_comparable: false,
      disclosure: SCIENTIFIC_DISCLOSURE,
      scope: "safe",
      taskCount: { payload: "private" },
      comparisons: [],
      attempts: [
        {
          taskDigest: "t1",
          condition: "relevant",
          repeat: 0,
          reward: 1,
          durations: { agentMs: { payload: "private" }, setupMs: 2 },
          interactions: { turns: "private", toolCalls: 3 },
          failureCategory: "private-payload",
          pipeline: { queueMs: 4, trajectory: "private" }
        }
      ],
      exclusions: []
    }) as { attempts: Record<string, unknown>[] };
    expect(publication.attempts[0]).toEqual({
      taskDigest: "t1",
      condition: "relevant",
      repeat: 0,
      reward: 1,
      durations: { setupMs: 2 },
      interactions: { toolCalls: 3 },
      pipeline: { queueMs: 4 }
    });
    expect(JSON.stringify(publication)).not.toContain("private");
  });

  it("requires every attempt and failure to be structurally represented", () => {
    const comparison = summarizeComparison(
      outcomes,
      contracts,
      PRIMARY_COMPARISON,
      2
    );
    const base = {
      runId: "ledger-check",
      executionKind: "benchmark_profile" as const,
      codexAuthMode: "api_key" as const,
      profile: "quick" as const,
      model: "test-model",
      taskCount: 2,
      attemptedReplayCount: outcomes.length,
      failureCount: 0,
      preparationCostUsd: 0,
      comparisons: [comparison],
      exclusions: []
    };
    expect(() =>
      createMachineReport({ ...base, attempts: outcomes.slice(1) })
    ).toThrow("every replay attempt");
    expect(() =>
      createMachineReport({
        ...base,
        failureCount: 1,
        attempts: [
          { ...(outcomes[0] as ReplayOutcome), reward: null },
          ...outcomes.slice(1)
        ]
      })
    ).toThrow("category, kind and phase");
    expect(() =>
      createMachineReport({
        ...base,
        attemptedReplayCount: outcomes.length,
        attempts: [...outcomes.slice(0, -1), outcomes[0] as ReplayOutcome]
      })
    ).toThrow("duplicate replay attempt");
    expect(() =>
      createMachineReport({
        ...base,
        failureCount: 1,
        attempts: outcomes
      })
    ).toThrow("every failure");
    expect(() =>
      createMachineReport({
        ...base,
        failureCount: 1,
        attempts: [
          {
            ...(outcomes[0] as ReplayOutcome),
            reward: null,
            failureCategory: "agent_timeout",
            failureKind: "agent",
            failurePhase: "agent"
          },
          ...outcomes.slice(1)
        ]
      })
    ).not.toThrow();
  });

  it.each([
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.dGVzdHNpZ25hdHVyZQ"],
    ["GitHub", `github_pat_${"a".repeat(30)}`],
    ["Slack", ["xoxb", "1234567890", "abcdefghijklmnop"].join("-")],
    ["npm", `npm_${"a".repeat(36)}`],
    ["AWS", "AKIAABCDEFGHIJKLMNOP"],
    ["Google Cloud", `AIza${"a".repeat(35)}`],
    ["Azure", `AccountKey=${"a".repeat(32)}`],
    ["Koed", `cmt_${"a".repeat(43)}`],
    ["credential URL", "postgresql://operator:supersecret@db.example/koed"]
  ])(
    "fails closed on an unresolved %s credential in final output",
    (_, secret) => {
      expect(() =>
        assertPublicationHasNoSecrets(`safe prefix ${secret}`)
      ).toThrow("Publication blocked");
      expect(() =>
        redactPublicationReport({
          report_version: 1,
          benchmark_kind: "koed_experience_replay",
          standard_leaderboard_comparable: false,
          disclosure: SCIENTIFIC_DISCLOSURE,
          scope: `otherwise allowed ${secret}`,
          comparisons: [],
          attempts: [],
          exclusions: []
        })
      ).toThrow("Publication blocked");
    }
  );
});
