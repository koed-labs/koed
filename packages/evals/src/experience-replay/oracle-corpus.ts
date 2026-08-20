import { createHash } from "node:crypto";
import {
  materializeSanitizedAtifTrajectory,
  type AtifSanitizationResult,
  type SanitizedAtifStep,
  type SanitizedAtifTrajectory
} from "./atif/index.js";
import { canonicalJson } from "./core/hash.js";

const SHA256 = /^[a-f0-9]{64}$/u;

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export type OracleCorpusVariant =
  | "guidance-only"
  | "trace-only"
  | "full-experience";

export interface SuccessfulOracleSource {
  taskDigest: string;
  sourceAttemptId: string;
  passed: boolean;
  reward: number | null;
  expectedSuccessValue: number;
  failureCategory: string | null;
  sanitization: AtifSanitizationResult;
}

export interface OracleCorpusArtifact {
  variant: OracleCorpusVariant;
  sha256: string;
  sanitization: AtifSanitizationResult;
}

export interface OracleCorpusProvenanceManifest {
  schemaVersion: "koed-oracle-corpus-v1";
  taskDigest: string;
  sourceAttemptId: string;
  oracleBriefSha256: string;
  matchedSystemStep: {
    stepId: number;
    messageSha256: string;
    memoryProjectionRole: "user";
  };
  verifierQualification: {
    passed: true;
    reward: number;
    expectedSuccessValue: number;
  };
  sanitizedSource: {
    inputSha256: string;
    outputSha256: string;
  };
  artifacts: Record<OracleCorpusVariant, string>;
  manifestSha256: string;
}

export interface OracleCorpus {
  guidanceOnly: OracleCorpusArtifact;
  traceOnly: OracleCorpusArtifact;
  fullExperience: OracleCorpusArtifact;
  provenance: OracleCorpusProvenanceManifest;
}

const DISTRACTOR_TEXT =
  "Unrelated prior work adjusted a calendar export title and replaced a presentation color token. It contains no guidance for the current task.";

export const buildOracleDistractor = (
  taskDigest: string,
  sourceAttemptId: string
): AtifSanitizationResult =>
  materializeSanitizedAtifTrajectory(
    {
      schema_version: "ATIF-v1.7",
      agent: { name: "codex", version: "benchmark-control-v1" },
      steps: [{ step_id: 1, source: "user", message: DISTRACTOR_TEXT }]
    },
    {
      taskDigest,
      sourceAttemptId,
      sourceManifest: {
        inputSha256: sha256(DISTRACTOR_TEXT),
        outputSha256: null,
        schemaVersion: "ATIF-v1.7",
        allowedFieldCounts: { "step.message": 1 },
        removedFieldCounts: {},
        redactionCounts: {},
        limitUsage: {
          rawBytes: Buffer.byteLength(DISTRACTOR_TEXT),
          nestingDepth: 4,
          steps: 1,
          nestedValues: 8,
          largestStringBytes: Buffer.byteLength(DISTRACTOR_TEXT),
          allowedTextBytes: Buffer.byteLength(DISTRACTOR_TEXT),
          allowedTextTokens: 0
        },
        cutoffAttested: true,
        rejectionReason: null
      }
    }
  );

export const combineOracleMemory = (
  distractor: AtifSanitizationResult,
  relevant: AtifSanitizationResult,
  input: { taskDigest: string; sourceAttemptId: string }
): AtifSanitizationResult => {
  const distractorSteps = distractor.trajectory.steps.map((step, index) => ({
    ...step,
    step_id: index + 1
  }));
  const relevantSteps = relevant.trajectory.steps.map((step, index) => ({
    ...step,
    step_id: distractorSteps.length + index + 1
  }));
  return materializeSanitizedAtifTrajectory(
    {
      schema_version: "ATIF-v1.7",
      agent: { ...relevant.trajectory.agent },
      steps: [...distractorSteps, ...relevantSteps]
    },
    {
      ...input,
      sourceManifest: relevant.manifest
    }
  );
};

export interface BuildOracleCorpusInput {
  oracleBrief: string;
  oracleBriefSha256: string;
  source: SuccessfulOracleSource;
}

const projectedTrajectory = (
  source: SanitizedAtifTrajectory,
  steps: SanitizedAtifStep[]
): SanitizedAtifTrajectory => ({
  schema_version: source.schema_version,
  ...(source.session_id === undefined ? {} : { session_id: source.session_id }),
  ...(source.trajectory_id === undefined
    ? {}
    : { trajectory_id: source.trajectory_id }),
  agent: { ...source.agent },
  steps
});

const artifact = (
  variant: OracleCorpusVariant,
  trajectory: SanitizedAtifTrajectory,
  source: SuccessfulOracleSource
): OracleCorpusArtifact => {
  const sanitization = materializeSanitizedAtifTrajectory(trajectory, {
    taskDigest: source.taskDigest,
    sourceAttemptId: source.sourceAttemptId,
    sourceManifest: source.sanitization.manifest
  });
  return {
    variant,
    sha256: sha256(sanitization.canonicalJson),
    sanitization
  };
};

export const buildOracleCorpus = (
  input: BuildOracleCorpusInput
): OracleCorpus => {
  if (!SHA256.test(input.oracleBriefSha256)) {
    throw new Error("Oracle brief SHA-256 is invalid");
  }
  const computedBriefSha256 = sha256(input.oracleBrief);
  if (computedBriefSha256 !== input.oracleBriefSha256) {
    throw new Error("Oracle brief does not match its SHA-256");
  }
  if (
    !input.source.passed ||
    input.source.failureCategory !== null ||
    input.source.reward === null ||
    input.source.reward !== input.source.expectedSuccessValue
  ) {
    throw new Error("Oracle corpus source must have passed without failure");
  }
  if (
    input.source.sanitization.manifest.rejectionReason !== null ||
    !input.source.sanitization.manifest.cutoffAttested ||
    input.source.sanitization.manifest.outputSha256 === null ||
    input.source.sanitization.manifest.schemaVersion !==
      input.source.sanitization.trajectory.schema_version ||
    canonicalJson(input.source.sanitization.trajectory) !==
      input.source.sanitization.canonicalJson ||
    sha256(input.source.sanitization.canonicalJson) !==
      input.source.sanitization.manifest.outputSha256
  ) {
    throw new Error("Oracle corpus source must be successfully sanitized");
  }

  const matches = input.source.sanitization.trajectory.steps.filter(
    (step) =>
      step.source === "system" && sha256(step.message) === computedBriefSha256
  );
  if (matches.length !== 1) {
    throw new Error("Oracle brief must match exactly one complete system step");
  }
  const matched = matches[0]!;
  const sourceTrajectory = input.source.sanitization.trajectory;
  const guidanceMemoryStep: SanitizedAtifStep = {
    ...matched,
    source: "user"
  };
  const traceSteps = sourceTrajectory.steps.filter((step) => step !== matched);
  const guidanceOnly = artifact(
    "guidance-only",
    projectedTrajectory(sourceTrajectory, [guidanceMemoryStep]),
    input.source
  );
  const traceOnly = artifact(
    "trace-only",
    projectedTrajectory(sourceTrajectory, traceSteps),
    input.source
  );
  const fullExperience = artifact(
    "full-experience",
    projectedTrajectory(sourceTrajectory, [guidanceMemoryStep, ...traceSteps]),
    input.source
  );

  const provenanceWithoutHash = {
    schemaVersion: "koed-oracle-corpus-v1" as const,
    taskDigest: input.source.taskDigest,
    sourceAttemptId: input.source.sourceAttemptId,
    oracleBriefSha256: input.oracleBriefSha256,
    matchedSystemStep: {
      stepId: matched.step_id,
      messageSha256: computedBriefSha256,
      memoryProjectionRole: "user" as const
    },
    verifierQualification: {
      passed: true as const,
      reward: input.source.reward,
      expectedSuccessValue: input.source.expectedSuccessValue
    },
    sanitizedSource: {
      inputSha256: input.source.sanitization.manifest.inputSha256,
      outputSha256: input.source.sanitization.manifest.outputSha256
    },
    artifacts: {
      "guidance-only": guidanceOnly.sha256,
      "trace-only": traceOnly.sha256,
      "full-experience": fullExperience.sha256
    }
  };
  const provenance: OracleCorpusProvenanceManifest = {
    ...provenanceWithoutHash,
    manifestSha256: sha256(canonicalJson(provenanceWithoutHash))
  };
  return { guidanceOnly, traceOnly, fullExperience, provenance };
};
