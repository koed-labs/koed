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
  summarizeRepeatedComparison,
  taskFirstResourceDeltas,
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

  it("preserves equal Terminal-Bench reward while exposing lower whole-system resource usage", () => {
    const resourceOutcomes: ReplayOutcome[] = ["t1", "t2"].flatMap(
      (taskDigest, taskIndex) =>
        (["relevant", "placebo"] as const).flatMap((condition) =>
          [0, 1].map((repeat) => {
            const amount =
              (condition === "relevant" ? 10 : 20) + taskIndex * 4 + repeat * 2;
            const tokens = {
              uncachedInput: amount,
              cachedInput: amount + 1,
              output: amount + 2,
              reasoning: amount + 3
            };
            const costs = {
              providerBilledUsd: amount / 100,
              apiEquivalentUsd: amount / 50,
              subscriptionUsd: amount / 25
            };
            return {
              taskDigest,
              condition,
              repeat,
              reward: 1,
              latencyMs: amount * 10,
              durations: {
                agentMs: amount * 2,
                setupMs: amount * 3,
                verifierMs: amount * 4
              },
              tokenUsage: tokens,
              costs,
              interactions: {
                turns: amount,
                toolCalls: amount + 1,
                toolFailures: amount + 2,
                mcpCalls: amount + 3,
                mcpFailures: amount + 4,
                memoryAnswerCalls: amount + 5,
                memoryAnswerFailures: amount + 6
              },
              workers: {
                memoryAnswer: {
                  calls: amount,
                  failures: amount + 1,
                  durationMs: amount * 5,
                  tokens,
                  costs
                },
                lcmSummary: {
                  calls: null,
                  failures: null,
                  durationMs: null,
                  tokens: {
                    uncachedInput: null,
                    cachedInput: null,
                    output: null,
                    reasoning: null
                  },
                  costs: {
                    providerBilledUsd: null,
                    apiEquivalentUsd: null,
                    subscriptionUsd: null
                  }
                },
                sessionTitle: {
                  calls: null,
                  failures: null,
                  durationMs: null,
                  tokens: {
                    uncachedInput: null,
                    cachedInput: null,
                    output: null,
                    reasoning: null
                  },
                  costs: {
                    providerBilledUsd: null,
                    apiEquivalentUsd: null,
                    subscriptionUsd: null
                  }
                }
              },
              recall: {
                searches: amount,
                expansions: amount + 1,
                stages: amount + 2,
                evidenceCount: amount + 3
              }
            } satisfies ReplayOutcome;
          })
        )
    );
    const summary = summarizeComparison(
      resourceOutcomes,
      contracts,
      PRIMARY_COMPARISON,
      2
    );

    expect(summary.meanDelta).toBe(0);
    expect(summary.ties).toBe(2);
    expect(summary.resourceDeltas).toEqual({
      durations: {
        replayElapsedMs: -100,
        trialElapsedMs: -90,
        agentMs: -20,
        setupMs: -30,
        verifierMs: -40
      },
      tokenUsage: {
        uncachedInput: -10,
        cachedInput: -10,
        output: -10,
        reasoning: -10
      },
      costs: {
        providerBilledUsd: -0.1,
        apiEquivalentUsd: -0.2,
        subscriptionUsd: -0.4
      },
      interactions: {
        turns: -10,
        toolCalls: -10,
        toolFailures: -10,
        mcpCalls: -10,
        mcpFailures: -10,
        memoryAnswerCalls: -10,
        memoryAnswerFailures: -10
      },
      memoryAnswerWorker: {
        calls: -10,
        failures: -10,
        durationMs: -50,
        tokens: {
          uncachedInput: -10,
          cachedInput: -10,
          output: -10,
          reasoning: -10
        },
        costs: {
          providerBilledUsd: -0.1,
          apiEquivalentUsd: -0.2,
          subscriptionUsd: -0.4
        }
      },
      recall: {
        searches: -10,
        expansions: -10,
        stages: -10,
        evidenceCount: -10
      }
    });
    expect(summary.latencyMsDelta).toBe(-100);
  });

  it("uses paired complete tasks per metric and returns null instead of zero for missing telemetry", () => {
    const withPartialTokens = outcomes.map((outcome) => ({
      ...outcome,
      tokenUsage: {
        uncachedInput:
          outcome.taskDigest === "t2" ? null : (outcome.tokens ?? null),
        cachedInput: null,
        output: null,
        reasoning: null
      }
    }));
    const deltas = taskFirstResourceDeltas(
      withPartialTokens,
      PRIMARY_COMPARISON,
      2
    );

    expect(deltas.tokenUsage.uncachedInput).toBeCloseTo(40);
    expect(deltas.tokenUsage.cachedInput).toBeNull();
    expect(deltas.durations.agentMs).toBeNull();
    expect(deltas.interactions.toolCalls).toBeNull();
    expect(deltas.memoryAnswerWorker.calls).toBeNull();
    expect(deltas.recall.searches).toBeNull();
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
      judgeOverheadCostUsd: 0.001,
      comparisons: [comparison],
      trajectoryJudgments: [
        {
          schemaVersion: "experience-replay-trajectory-judge-v1",
          taskDigest: "t1",
          repeat: 0,
          comparison: "relevant - placebo",
          status: "judged",
          preferredCondition: "relevant",
          confidence: 0.8,
          assessments: {
            relevant: {
              progress_quality: 3,
              efficiency: 3,
              error_recognition: 2,
              failed_approach_avoidance: 4,
              informed_failure: 0,
              retrieval_quality: 3,
              correct_prior_experience_reuse: 4,
              distraction_resistance: 3,
              evidence_refs: ["A:step:2", "source:step:1"]
            }
          },
          rationale: "The preferred attempt avoided a supported dead end.",
          latencyMs: 12,
          model: "gpt-5.6-luna",
          tokenUsage: {
            uncachedInput: 20,
            cachedInput: 10,
            output: 5,
            reasoning: 2
          },
          costUsd: 0.001,
          error: null
        }
      ],
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
    expect(() =>
      createMachineReport({
        ...machine,
        executionKind: "oracle_seeded_repeated_study",
        profile: "full",
        intervals: undefined
      })
    ).not.toThrow();
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
      judgeOverheadCostUsd: 0.001,
      comparisons: [comparison],
      trajectoryJudgments: [
        {
          schemaVersion: "experience-replay-trajectory-judge-v1",
          taskDigest: "t1",
          repeat: 0,
          comparison: "relevant - placebo",
          status: "judged",
          preferredCondition: "relevant",
          confidence: 0.8,
          assessments: {
            relevant: {
              progress_quality: 3,
              efficiency: 3,
              error_recognition: 2,
              failed_approach_avoidance: 4,
              informed_failure: 0,
              retrieval_quality: 3,
              correct_prior_experience_reuse: 4,
              distraction_resistance: 3,
              evidence_refs: ["A:step:2", "source:step:1"]
            }
          },
          rationale: "The preferred attempt avoided a supported dead end.",
          latencyMs: 12,
          model: "gpt-5.6-luna",
          tokenUsage: {
            uncachedInput: 20,
            cachedInput: 10,
            output: 5,
            reasoning: 2
          },
          costUsd: 0.001,
          error: null
        }
      ],
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
      trajectoryJudgments: [
        {
          status: "judged",
          preferredCondition: "relevant",
          rationale: "The preferred attempt avoided a supported dead end."
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
    expect(publishedComparison.resourceDeltas).toMatchObject({
      durations: { replayElapsedMs: 100 },
      tokenUsage: { uncachedInput: null },
      costs: { apiEquivalentUsd: null }
    });
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
      judgeOverheadCostUsd: 0,
      comparisons: [comparison],
      trajectoryJudgments: [],
      exclusions: []
    };
    expect(() =>
      createMachineReport({ ...base, attempts: outcomes.slice(1) })
    ).toThrow("every replay attempt");
    expect(() =>
      createMachineReport({
        ...base,
        judgeOverheadCostUsd: 1,
        attempts: outcomes
      })
    ).toThrow("overhead must match");
    const duplicateJudgment = {
      schemaVersion: "experience-replay-trajectory-judge-v1" as const,
      taskDigest: "t1",
      repeat: 0,
      comparison: `${PRIMARY_COMPARISON.left} - ${PRIMARY_COMPARISON.right}`,
      status: "error" as const,
      preferredCondition: null,
      confidence: null,
      assessments: {},
      rationale: null,
      latencyMs: 0,
      model: "test-model",
      tokenUsage: {
        uncachedInput: null,
        cachedInput: null,
        output: null,
        reasoning: null
      },
      costUsd: null,
      error: "judge unavailable"
    };
    expect(() =>
      createMachineReport({
        ...base,
        judgeOverheadCostUsd: null,
        trajectoryJudgments: [duplicateJudgment, duplicateJudgment],
        attempts: outcomes
      })
    ).toThrow("duplicate result");
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

  it("reports matched repeat outcomes for one-task oracle calibration", () => {
    const repeated: ReplayOutcome[] = Array.from(
      { length: 10 },
      (_, repeat) => [
        {
          taskDigest: "task",
          condition: "direct_guidance" as const,
          repeat,
          reward: repeat < 2 ? 1 : 0
        },
        {
          taskDigest: "task",
          condition: "relevant_guidance" as const,
          repeat,
          reward: repeat === 0 ? 1 : 0
        },
        { taskDigest: "task", condition: "empty" as const, repeat, reward: 0 }
      ]
    ).flat();
    const summary = summarizeRepeatedComparison(
      repeated,
      [{ taskDigest: "task", rewardMin: 0, rewardMax: 1 }],
      { left: "direct_guidance", right: "relevant_guidance" },
      10
    );
    expect(summary.taskDeltas).toHaveLength(10);
    expect(summary.taskDeltas[1]).toMatchObject({ repeat: 1, delta: 1 });
    expect(summary).toMatchObject({ wins: 1, losses: 0, ties: 9 });
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
