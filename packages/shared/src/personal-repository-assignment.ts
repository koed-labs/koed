import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  effectiveRepositoryIdentity,
  repositoryAssignmentSchema,
  type RepositoryAssignment
} from "./repository-assignment.js";
import { repositoryIdentitySchema } from "./repository-identity.js";
import { decodePdsBase64url } from "./personal-device-sync.js";
import { parsePdsUint64 } from "./personal-device-sync-jcs.js";

const decimal = z.string().refine((value) => {
  try {
    parsePdsUint64(value);
    return true;
  } catch {
    return false;
  }
}, "Expected a canonical uint64");
export const pdsRepositoryKeyHistorySchema = z.record(
  decimal,
  z.string().refine((value) => {
    try {
      decodePdsBase64url(value, 32);
      return true;
    } catch {
      return false;
    }
  }, "Invalid Project epoch key")
);
export const pdsRepositoryAssignmentSchema = z
  .object({
    version: z.literal("1"),
    state: z.enum(["recorded", "historical_unresolved"]),
    assignmentVersion: decimal,
    capturedCwd: z.string().max(8192).nullable(),
    branchObservation: z.string().max(512).nullable(),
    automatic: repositoryIdentitySchema.nullable(),
    override: repositoryIdentitySchema.nullable(),
    selectedAnchor: z
      .object({ epoch: decimal, token: z.string() })
      .strict()
      .nullable()
  })
  .strict()
  .superRefine((value, ctx) => {
    const effective = effectiveRepositoryIdentity(value);
    if (
      !Number.isSafeInteger(Number(value.assignmentVersion)) ||
      Number(value.assignmentVersion) < 1 ||
      Number(value.assignmentVersion) > 2147483647
    )
      ctx.addIssue({
        code: "custom",
        message: "Assignment version is outside the supported range"
      });
    if (value.state === "historical_unresolved" && value.automatic !== null)
      ctx.addIssue({
        code: "custom",
        message: "Historical automatic assignment must remain unresolved"
      });
    if (
      (effective?.kind === "portable_repository") !==
      (value.selectedAnchor !== null)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Only the effective portable repository carries an anchor token"
      });
    if (
      value.branchObservation !== null &&
      (!value.automatic || value.branchObservation !== value.automatic.branch)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Branch observation must belong to the recorded automatic repository"
      });
    if (value.selectedAnchor) {
      try {
        decodePdsBase64url(value.selectedAnchor.token, 32);
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid anchor token" });
      }
    }
  });
export type PdsRepositoryAssignment = z.infer<
  typeof pdsRepositoryAssignmentSchema
>;
export const pdsSelectedRepositoryToken = (
  key: string,
  fingerprint: string
): string =>
  createHmac("sha256", decodePdsBase64url(key, 32))
    .update("koed/pds/v1/selected-repository\0")
    .update(fingerprint)
    .digest("base64url");
export const createPdsRepositoryAssignment = (
  assignment: RepositoryAssignment,
  epoch: string,
  key: string,
  provenance: {
    capturedCwd?: string | null;
    branchObservation?: string | null;
  } = {}
): PdsRepositoryAssignment => {
  const parsed = repositoryAssignmentSchema.parse(assignment);
  const effective = effectiveRepositoryIdentity(parsed);
  return pdsRepositoryAssignmentSchema.parse({
    version: "1",
    capturedCwd: provenance.capturedCwd ?? null,
    branchObservation:
      provenance.branchObservation !== undefined
        ? provenance.branchObservation
        : (parsed.automatic?.branch ?? null),
    state: parsed.state,
    assignmentVersion: String(parsed.version),
    automatic: parsed.automatic,
    override: parsed.override,
    selectedAnchor:
      effective?.kind === "portable_repository"
        ? { epoch, token: pdsSelectedRepositoryToken(key, effective.key!) }
        : null
  });
};
/** Call only after package/device authorization. The caller supplies a verified epoch key. */
export const verifyPdsRepositoryAssignment = (
  value: unknown,
  contentEpoch: string,
  verifiedEpoch: string,
  key: string
): RepositoryAssignment => {
  const parsed = pdsRepositoryAssignmentSchema.parse(value);
  const effective = effectiveRepositoryIdentity(parsed);
  if (parsed.selectedAnchor) {
    if (
      parsed.selectedAnchor.epoch !== contentEpoch ||
      contentEpoch !== verifiedEpoch
    )
      throw new TypeError("PDS repository key epoch is unavailable");
    const expected = decodePdsBase64url(
      pdsSelectedRepositoryToken(key, effective!.key!),
      32
    );
    if (
      !timingSafeEqual(
        expected,
        decodePdsBase64url(parsed.selectedAnchor.token, 32)
      )
    )
      throw new TypeError("PDS repository anchor token is invalid");
  }
  return {
    state: parsed.state,
    version: Number(parsed.assignmentVersion),
    automatic: parsed.automatic,
    override: parsed.override,
    effective
  };
};

/** Keys come from the authenticated group's private secret provider, never the package. */
export const verifyPdsRepositoryAssignmentWithKeyHistory = (
  value: unknown,
  contentEpoch: string,
  keys: {
    currentEpoch: string;
    projectKey: string;
    historicalProjectKeys?: Record<string, string>;
  }
): RepositoryAssignment => {
  const assignment = pdsRepositoryAssignmentSchema.parse(value);
  const key =
    contentEpoch === keys.currentEpoch
      ? keys.projectKey
      : keys.historicalProjectKeys?.[contentEpoch];
  if (assignment.selectedAnchor && !key)
    throw new TypeError("PDS repository key epoch is unavailable");
  return verifyPdsRepositoryAssignment(
    assignment,
    contentEpoch,
    contentEpoch,
    key ?? keys.projectKey
  );
};
