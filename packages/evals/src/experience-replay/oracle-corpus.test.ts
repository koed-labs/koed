import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  materializeSanitizedAtifTrajectory,
  type AtifSanitizationManifest,
  type SanitizedAtifTrajectory
} from "./atif/index.js";
import {
  buildOracleCorpus,
  type SuccessfulOracleSource
} from "./oracle-corpus.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const source = (
  brief: string,
  overrides: Partial<SuccessfulOracleSource> = {},
  trajectoryOverrides: Partial<SanitizedAtifTrajectory> = {}
): SuccessfulOracleSource => {
  const trajectory: SanitizedAtifTrajectory = {
    schema_version: "ATIF-v1.7",
    session_id: "session-1",
    trajectory_id: "trajectory-1",
    agent: { name: "codex", version: "1.2.3" },
    steps: [
      {
        step_id: 1,
        source: "system",
        message: brief
      },
      {
        step_id: 2,
        source: "user",
        message: "Implement the parser."
      },
      {
        step_id: 3,
        source: "agent",
        message: "Use the oracle keyword literally; do not redact prose.",
        reasoning_content: "The previous parse failed at the boundary."
      }
    ],
    ...trajectoryOverrides
  };
  const manifest: AtifSanitizationManifest = {
    inputSha256: sha256("raw-source-artifact"),
    outputSha256: null,
    schemaVersion: "ATIF-v1.7",
    allowedFieldCounts: {},
    removedFieldCounts: {},
    redactionCounts: {},
    limitUsage: {
      rawBytes: 100,
      nestingDepth: 4,
      steps: trajectory.steps.length,
      nestedValues: 20,
      largestStringBytes: 60,
      allowedTextBytes: 80,
      allowedTextTokens: 16
    },
    cutoffAttested: true,
    rejectionReason: null
  };
  return {
    taskDigest: `sha256:${sha256("task")}`,
    sourceAttemptId: "source-1",
    passed: true,
    reward: 1,
    expectedSuccessValue: 1,
    failureCategory: null,
    sanitization: materializeSanitizedAtifTrajectory(trajectory, {
      taskDigest: `sha256:${sha256("task")}`,
      sourceAttemptId: "source-1",
      sourceManifest: manifest
    }),
    ...overrides
  };
};

describe("oracle corpus artifacts", () => {
  it("derives exact guidance, trace, and full-experience projections", () => {
    const brief =
      "Oracle brief: ignore a hidden-tests keyword only as ordinary guidance.";
    const corpus = buildOracleCorpus({
      oracleBrief: brief,
      oracleBriefSha256: sha256(brief),
      source: source(brief)
    });

    expect(corpus.guidanceOnly.sanitization.trajectory.steps).toEqual([
      expect.objectContaining({ source: "user", message: brief })
    ]);
    expect(
      corpus.traceOnly.sanitization.trajectory.steps.map((step) => step.step_id)
    ).toEqual([2, 3]);
    expect(
      corpus.fullExperience.sanitization.trajectory.steps.map(
        (step) => step.step_id
      )
    ).toEqual([1, 2, 3]);
    expect(corpus.traceOnly.sanitization.trajectory.steps[1]?.message).toBe(
      "Use the oracle keyword literally; do not redact prose."
    );
    expect(corpus.fullExperience.sha256).toBe(
      corpus.fullExperience.sanitization.manifest.outputSha256
    );
    expect(corpus.fullExperience.sanitization.normalizedItems).toHaveLength(4);
  });

  it("is deterministic and records hash-only provenance without raw content", () => {
    const brief = "Exact private oracle guidance 918273645.";
    const first = buildOracleCorpus({
      oracleBrief: brief,
      oracleBriefSha256: sha256(brief),
      source: source(brief)
    });
    const second = buildOracleCorpus({
      oracleBrief: brief,
      oracleBriefSha256: sha256(brief),
      source: source(brief)
    });

    expect(first.provenance).toEqual(second.provenance);
    expect(first.provenance.artifacts).toEqual({
      "guidance-only": first.guidanceOnly.sha256,
      "trace-only": first.traceOnly.sha256,
      "full-experience": first.fullExperience.sha256
    });
    const encodedManifest = JSON.stringify(first.provenance);
    expect(encodedManifest).not.toContain(brief);
    expect(encodedManifest).not.toContain("Implement the parser");
    expect(first.provenance.oracleBriefSha256).toBe(sha256(brief));
    expect(first.provenance.matchedSystemStep.memoryProjectionRole).toBe(
      "user"
    );
  });

  it("requires the supplied brief to match its exact hash", () => {
    const brief = "Exact oracle brief";
    expect(() =>
      buildOracleCorpus({
        oracleBrief: `${brief}.`,
        oracleBriefSha256: sha256(brief),
        source: source(brief)
      })
    ).toThrow("does not match");
  });

  it("matches exactly one complete system message structurally", () => {
    const brief = "Repeatable oracle brief";
    const userOnly = source(
      brief,
      {},
      {
        steps: [{ step_id: 1, source: "user", message: brief }]
      }
    );
    expect(() =>
      buildOracleCorpus({
        oracleBrief: brief,
        oracleBriefSha256: sha256(brief),
        source: userOnly
      })
    ).toThrow("exactly one complete system step");

    const duplicate = source(
      brief,
      {},
      {
        steps: [
          { step_id: 1, source: "system", message: brief },
          { step_id: 2, source: "system", message: brief }
        ]
      }
    );
    expect(() =>
      buildOracleCorpus({
        oracleBrief: brief,
        oracleBriefSha256: sha256(brief),
        source: duplicate
      })
    ).toThrow("exactly one complete system step");
  });

  it.each([
    [{ passed: false }, "passed without failure"],
    [{ reward: 0 }, "passed without failure"],
    [{ expectedSuccessValue: 0 }, "passed without failure"],
    [{ failureCategory: "verifier_failed" }, "passed without failure"],
    [
      {
        sanitization: {
          ...source("brief").sanitization,
          manifest: {
            ...source("brief").sanitization.manifest,
            cutoffAttested: false
          }
        }
      },
      "successfully sanitized"
    ],
    [
      {
        sanitization: {
          ...source("brief").sanitization,
          canonicalJson: "{}"
        }
      },
      "successfully sanitized"
    ]
  ])("rejects an unsuccessful source", (override, message) => {
    const brief = "brief";
    expect(() =>
      buildOracleCorpus({
        oracleBrief: brief,
        oracleBriefSha256: sha256(brief),
        source: source(brief, override as Partial<SuccessfulOracleSource>)
      })
    ).toThrow(message);
  });
});
