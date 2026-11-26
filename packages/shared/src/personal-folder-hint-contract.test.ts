import { describe, expect, it } from "vitest";
import { personalSourceContextCommandSchema } from "./personal-source-correction-contract.js";
import {
  PERSONAL_FOLDER_HINT_BATCH_SIZE,
  personalFolderHintSchema,
  personalFolderHintsDataSchema
} from "./personal-folder-hint-contract.js";

const session = "00000000-0000-4000-8000-000000000001";
const folder = {
  ownerUserId: "00000000-0000-4000-8000-000000000002",
  folderId: "folder",
  originatingDeploymentId: "deployment",
  originatingDeviceId: "device",
  originatingProfileId: "profile",
  directoryIncarnationId: "incarnation"
};
const base = { sessionId: session, score: 4, reasons: [] };

describe("personalFolderHintSchema", () => {
  it("accepts exactly the candidate each kind describes", () => {
    for (const hint of [
      { ...base, tier: "none" },
      { ...base, tier: "medium", folder },
      { ...base, tier: "medium", kind: "worktree-parent", folder },
      { ...base, tier: "medium", kind: "create", directory: "/work/x" },
      {
        ...base,
        tier: "medium",
        kind: "repository",
        repositoryKey: "gr_x",
        directory: "/work/x"
      }
    ])
      expect(personalFolderHintSchema.safeParse(hint).success).toBe(true);
  });

  it("rejects a hint that names the wrong candidate for its kind", () => {
    for (const hint of [
      { ...base, tier: "none", folder },
      { ...base, tier: "medium" },
      { ...base, tier: "medium", kind: "create", folder },
      { ...base, tier: "medium", kind: "repository", folder },
      { ...base, tier: "medium", kind: "repository" },
      { ...base, tier: "medium", folder, repositoryKey: "gr_x" }
    ])
      expect(personalFolderHintSchema.safeParse(hint).success).toBe(false);
  });
});

it("distinguishes assumed-local inference from explicit unknown-device checkout review", () => {
  const preview = {
    sessionId: session,
    action: "preview",
    correction: {
      axis: "git",
      action: "set",
      expectedVersion: 1,
      repository: {
        kind: "portable_repository",
        key: "gr_x",
        root: "/work/x",
        branch: null,
        reason: "origin",
        checkoutId: null,
        originatingDeviceId: "device",
        selectedRemote: "origin",
        anchorDisplay: "example.test/repo"
      },
      inferenceIntent: "assumed-local-import"
    }
  };
  expect(personalSourceContextCommandSchema.safeParse(preview).success).toBe(
    false
  );
  const scoped = { ...preview, expectedScopeKey: "a".repeat(64) };
  expect(personalSourceContextCommandSchema.safeParse(scoped).success).toBe(
    true
  );
  expect(
    personalSourceContextCommandSchema.safeParse({
      ...scoped,
      correction: {
        ...preview.correction,
        localImportBasis: {
          artifactId: session,
          importSourceId: session,
          startedAt: "2024-01-01T00:00:00.000001Z",
          deviceId: "device",
          deploymentId: "deployment"
        }
      }
    }).success
  ).toBe(false);
  const reviewedCheckout = {
    directory: "/work/x",
    incarnation: "b".repeat(64)
  };
  expect(
    personalSourceContextCommandSchema.safeParse({
      ...scoped,
      reviewedCheckout
    }).success
  ).toBe(true);
  expect(
    personalSourceContextCommandSchema.safeParse({
      ...scoped,
      reviewedCheckout,
      correction: { ...preview.correction, inferenceIntent: "recording-device" }
    }).success
  ).toBe(false);
  expect(
    personalSourceContextCommandSchema.safeParse({
      ...preview,
      correction: { ...preview.correction, inferenceIntent: "recording-device" }
    }).success
  ).toBe(true);
  const manual = {
    ...preview,
    correction: {
      ...preview.correction,
      inferenceIntent: "user-confirmed-unknown"
    }
  };
  expect(personalSourceContextCommandSchema.safeParse(manual).success).toBe(
    false
  );
  expect(
    personalSourceContextCommandSchema.safeParse({
      ...manual,
      reviewedCheckout
    }).success
  ).toBe(false);
  expect(
    personalSourceContextCommandSchema.safeParse({
      ...manual,
      expectedScopeKey: scoped.expectedScopeKey,
      reviewedCheckout
    }).success
  ).toBe(true);
  expect(
    personalSourceContextCommandSchema.safeParse({
      ...manual,
      expectedScopeKey: scoped.expectedScopeKey,
      reviewedCheckout: { ...reviewedCheckout, incarnation: "missing" }
    }).success
  ).toBe(false);
});

describe("personalFolderHintsDataSchema", () => {
  it("allows several hints per Conversation in a full batch", () => {
    const hint = { ...base, tier: "medium", folder };
    const full = Array.from(
      { length: PERSONAL_FOLDER_HINT_BATCH_SIZE * 4 },
      () => hint
    );
    expect(
      personalFolderHintsDataSchema.safeParse({ hints: full }).success
    ).toBe(true);
    expect(
      personalFolderHintsDataSchema.safeParse({ hints: [...full, hint] })
        .success
    ).toBe(false);
  });
});
