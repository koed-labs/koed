import { describe, expect, it } from "vitest";
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
