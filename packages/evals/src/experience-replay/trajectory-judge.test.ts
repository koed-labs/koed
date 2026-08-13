import { describe, expect, it } from "vitest";
import type { SanitizedAtifTrajectory } from "./atif/index.js";
import {
  buildTrajectoryJudgePrompt,
  parseTrajectoryJudgeOutput,
  runTrajectoryJudge,
  TRAJECTORY_JUDGE_SCHEMA_VERSION,
  type TrajectoryJudgeInput
} from "./trajectory-judge.js";

const trajectory = (message: string): SanitizedAtifTrajectory => ({
  schema_version: "ATIF-v1.7",
  agent: { name: "codex", version: "1.0.0" },
  steps: [
    { step_id: 1, source: "user", message: "Fix the parser." },
    {
      step_id: 2,
      source: "agent",
      message,
      tool_calls: [
        {
          tool_call_id: "call-1",
          function_name: "exec_command",
          arguments: { cmd: "test" }
        }
      ],
      observation: {
        results: [{ source_call_id: "call-1", content: "known error" }]
      }
    }
  ]
});

const input = (): TrajectoryJudgeInput => ({
  runSeed: "blind-seed",
  taskDigest: "a".repeat(64),
  repeat: 0,
  comparison: { left: "relevant", right: "cold" },
  sourceTrajectory: trajectory("The first parser approach failed."),
  left: {
    condition: "relevant",
    reward: 0,
    passed: false,
    trajectory: trajectory("Avoid the failed parser approach.")
  },
  right: {
    condition: "cold",
    reward: 0,
    passed: false,
    trajectory: trajectory("Try the first parser approach.")
  }
});

const output = (preference: "A" | "B" | "tie" = "A") => ({
  schema_version: TRAJECTORY_JUDGE_SCHEMA_VERSION,
  preference,
  confidence: 0.8,
  candidates: {
    A: {
      progress_quality: 2,
      efficiency: 3,
      error_recognition: 3,
      failed_approach_avoidance: 4,
      informed_failure: 3,
      retrieval_quality: 3,
      correct_prior_experience_reuse: 4,
      distraction_resistance: 3,
      evidence_refs: ["A:step:2", "source:step:2"]
    },
    B: {
      progress_quality: 2,
      efficiency: 1,
      error_recognition: 1,
      failed_approach_avoidance: 0,
      informed_failure: 0,
      retrieval_quality: null,
      correct_prior_experience_reuse: null,
      distraction_resistance: null,
      evidence_refs: ["B:step:2:tool-result:0"]
    }
  },
  rationale: "A avoided a source-supported failed approach."
});

describe("blinded Experience Replay trajectory judge", () => {
  it("builds deterministic opaque A/B input without condition names", () => {
    const first = buildTrajectoryJudgePrompt(input());
    const second = buildTrajectoryJudgePrompt(input());
    expect(first).toEqual(second);
    expect(first.prompt).not.toContain('"condition"');
    expect(first.prompt).not.toContain('"relevant"');
    expect(first.prompt).not.toContain('"cold"');
    expect(first.prompt).toContain("source:step:2");
    expect(
      new Set([first.labels.A.condition, first.labels.B.condition])
    ).toEqual(new Set(["relevant", "cold"]));
  });

  it("strictly rejects invalid scores, references, and extra fields", () => {
    expect(() =>
      parseTrajectoryJudgeOutput(JSON.stringify({ ...output(), extra: true }))
    ).toThrow();
    const invalidScore = output();
    invalidScore.candidates.A.efficiency = 5;
    expect(() =>
      parseTrajectoryJudgeOutput(JSON.stringify(invalidScore))
    ).toThrow();
    const invalidRef = output();
    invalidRef.candidates.A.evidence_refs = ["relevant:step:2"];
    expect(() =>
      parseTrajectoryJudgeOutput(JSON.stringify(invalidRef))
    ).toThrow();
    const crossCandidateRef = output();
    crossCandidateRef.candidates.A.evidence_refs = ["B:step:2"];
    expect(() =>
      parseTrajectoryJudgeOutput(JSON.stringify(crossCandidateRef))
    ).toThrow("cannot cite the other candidate");
    const unsupported = output();
    unsupported.candidates.A.evidence_refs = [];
    expect(() =>
      parseTrajectoryJudgeOutput(JSON.stringify(unsupported))
    ).toThrow("require cited evidence");
  });

  it("restores treatment identities only after judging and measures judge cost", async () => {
    const assessment = await runTrajectoryJudge(input(), {
      config: {
        appServerBinary: "/bin/codex",
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
        timeoutMs: 1_000,
        cwd: "/tmp",
        env: {}
      },
      runner: async (prompt) => {
        const labels = buildTrajectoryJudgePrompt(input()).labels;
        expect(prompt).not.toContain(labels.A.condition);
        return {
          text: JSON.stringify(output("A")),
          model: "codex-app-server:gpt-5.6-luna:medium",
          tokenUsage: {
            total: {
              inputTokens: 100,
              cachedInputTokens: 40,
              outputTokens: 20,
              reasoningOutputTokens: 5
            }
          }
        };
      },
      price: {
        uncached_input_usd_per_million: 1,
        cached_input_usd_per_million: 0.1,
        output_usd_per_million: 4
      }
    });
    expect(assessment.status).toBe("judged");
    expect(assessment.preferredCondition).toBe(
      buildTrajectoryJudgePrompt(input()).labels.A.condition
    );
    const preferredCondition =
      buildTrajectoryJudgePrompt(input()).labels.A.condition;
    expect(assessment.assessments[preferredCondition]).toMatchObject({
      informed_failure: 3,
      failed_approach_avoidance: 4,
      distraction_resistance: 3
    });
    expect(assessment.tokenUsage).toEqual({
      uncachedInput: 60,
      cachedInput: 40,
      output: 20,
      reasoning: 5
    });
    expect(assessment.costUsd).toBeCloseTo(0.000144);
  });

  it("keeps judge errors as missing secondary outcomes", async () => {
    const assessment = await runTrajectoryJudge(input(), {
      config: {
        appServerBinary: "/bin/codex",
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
        timeoutMs: 1_000,
        cwd: "/tmp",
        env: {}
      },
      runner: async () => {
        throw new Error("judge unavailable");
      }
    });
    expect(assessment).toMatchObject({
      status: "error",
      preferredCondition: null,
      costUsd: null,
      error: "judge unavailable"
    });
  });

  it("rejects a judge result from a different app-server model identity", async () => {
    const assessment = await runTrajectoryJudge(input(), {
      config: {
        appServerBinary: "/bin/codex",
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
        timeoutMs: 1_000,
        cwd: "/tmp",
        env: {}
      },
      runner: async () => ({
        text: JSON.stringify(output("A")),
        model: "codex-app-server:gpt-5.6-luna:low"
      })
    });
    expect(assessment).toMatchObject({
      status: "error",
      error: "Trajectory judge returned an unexpected model"
    });
  });
});
