import { describe, expect, it } from "vitest";
import type { PersonalFolderHint } from "@koed-labs/shared";
import {
  folderProposal,
  suggestionApprovalKey
} from "./folder-hint-suggestion.js";

const folder = {
  ownerUserId: "00000000-0000-4000-8000-000000000001",
  folderId: "api",
  originatingDeploymentId: "deployment",
  originatingDeviceId: "device",
  originatingProfileId: "profile",
  directoryIncarnationId: "api-lifetime"
};
const session = "00000000-0000-4000-8000-000000000002";
const hint = (
  overrides: Partial<PersonalFolderHint> = {}
): PersonalFolderHint => ({
  sessionId: session,
  tier: "strong",
  score: 6,
  folder,
  reasons: [
    { code: "git-remote", outcome: "agrees" },
    { code: "directory-birthtime", outcome: "agrees" },
    { code: "directory-activity", outcome: "does-not-agree" }
  ],
  ...overrides
});

const create = (overrides: Partial<PersonalFolderHint> = {}) =>
  hint({
    kind: "create",
    folder: undefined,
    directory: "/work/x",
    tier: "medium",
    ...overrides
  });

const koed = { id: "koed", name: "Koed" };
const lyons = { id: "lyons", name: "lyons-mouth" };

describe("folderProposal", () => {
  it("proposes using an existing Folder, with its evidence strongest first", () => {
    expect(folderProposal([hint({ directory: "/work/api" })])).toEqual({
      action: "use",
      kind: "registered",
      folder,
      tier: "strong",
      directory: "/work/api",
      projects: [],
      evidence: ["git-remote", "directory-birthtime"]
    });
  });

  it("never proposes using an unregistered directory", () => {
    expect(folderProposal([create()])).toBeUndefined();
    expect(folderProposal([create(), hint()])?.kind).toBe("registered");
  });

  it("prefers a worktree's main checkout over an existing Folder", () => {
    const parent = hint({ kind: "worktree-parent", directory: "/work/main" });
    expect(folderProposal([hint(), create(), parent])?.kind).toBe(
      "worktree-parent"
    );
    expect(folderProposal([create(), hint()])?.kind).toBe("registered");
  });

  it("prefers a candidate that lands in a Project over one that does not", () => {
    const own = { ...folder, folderId: "worktree-own" };
    const hints = [
      hint({ folder: own, directory: "/work/wt" }),
      hint({ kind: "worktree-parent", directory: "/work/main" })
    ];
    const inProject = (f: typeof folder) =>
      f.folderId === "api" ? [koed] : [];
    expect(folderProposal(hints, { folder: inProject })).toMatchObject({
      kind: "worktree-parent",
      projects: [koed]
    });
    // With no Project anywhere, the worktree-parent rank decides.
    expect(folderProposal(hints)?.kind).toBe("worktree-parent");
    expect(
      folderProposal([hints[0]!, create()], { folder: inProject })?.kind
    ).toBe("registered");
    expect(
      folderProposal([create(), hints[1]!], {
        folder: (f) => (f.folderId === "api" ? [] : [{ id: "x", name: "x" }])
      })?.kind
    ).toBe("worktree-parent");
  });

  it("proposes a Git Anchor only when a Project already uses it", () => {
    const repository = hint({
      kind: "repository",
      folder: undefined,
      repositoryKey: "gr_lyons",
      gitRevision: 3,
      directory: "/repos/lyons-mouth",
      tier: "medium"
    });
    const resolve = {
      repository: (key: string) => (key === "gr_lyons" ? [lyons] : [])
    };
    expect(folderProposal([create(), repository], resolve)).toMatchObject({
      action: "anchor",
      kind: "repository",
      repositoryKey: "gr_lyons",
      gitRevision: 3,
      projects: [lyons]
    });
    // An anchor no Project uses has nothing to select, so it is dropped.
    expect(folderProposal([repository], {})).toBeUndefined();
    expect(folderProposal([create(), repository], {})).toBeUndefined();
    // A Folder that already lands in a Project still wins over the anchor.
    const inProject = { folder: () => [koed], ...resolve };
    expect(folderProposal([repository, hint()], inProject)?.kind).toBe(
      "registered"
    );
  });

  it.each(["unknown", "assumed-local-import"] as const)(
    "binds eligible %s batch approvals to the proposed checkout and leaves copies advisory",
    (provenance) => {
      const unknown = hint({
        kind: "repository",
        repositoryKey: "gr_lyons",
        directory: "/work/a",
        recordingDeviceProvenance: provenance,
        gitRevision: 1,
        gitInferenceEligibility: true,
        manualGitReview: {
          intent: "user-confirmed-unknown",
          incarnation: "a".repeat(64)
        }
      });
      const advisory = { repository: () => [lyons] };
      const batch = { ...advisory, reviewBatch: true };
      const proposal = folderProposal([unknown], batch)!;
      expect(proposal).toMatchObject({
        kind: "repository",
        manualGitReview: unknown.manualGitReview,
        gitRevision: 1
      });
      const changed = folderProposal(
        [{ ...unknown, directory: "/work/b" }],
        batch
      )!;
      expect(
        suggestionApprovalKey(lyons.id, { sessionId: session, proposal })
      ).not.toBe(
        suggestionApprovalKey(lyons.id, {
          sessionId: session,
          proposal: changed
        })
      );
      expect(folderProposal([unknown], advisory)).toBeUndefined();
      for (const change of [
        { gitRevision: 2 },
        { manualGitReview: undefined },
        { directory: undefined }
      ])
        expect(
          folderProposal([{ ...unknown, ...change }], batch)
        ).toBeUndefined();
      const copy = {
        ...unknown,
        recordingDeviceProvenance: "known-copy" as const
      };
      expect(folderProposal([copy], batch)).toBeUndefined();
      expect(folderProposal([copy], advisory)).toMatchObject({
        kind: "repository"
      });
      expect(folderProposal([copy], advisory)).not.toHaveProperty(
        "manualGitReview"
      );
    }
  );

  it.each(["does-not-agree", "unavailable"] as const)(
    "requires explicit guarded approval when Git directory age is %s",
    (outcome) => {
      const candidate = hint({
        kind: "repository",
        repositoryKey: "gr_lyons",
        gitRevision: 1,
        gitInferenceEligibility: false,
        recordingDeviceProvenance: "assumed-local-import",
        manualGitReview: {
          intent: "assumed-local-import",
          incarnation: "a".repeat(64)
        },
        directory: "/work/a",
        reasons: [{ code: "git-directory-birthtime", outcome }]
      });
      const resolve = { repository: () => [lyons], reviewBatch: true };
      const proposal = folderProposal([candidate], resolve)!;
      expect(proposal).toMatchObject({
        kind: "repository",
        gitRevision: 1,
        manualGitReview: candidate.manualGitReview
      });
      const changed = folderProposal(
        [
          {
            ...candidate,
            manualGitReview: {
              ...candidate.manualGitReview!,
              incarnation: "b".repeat(64)
            }
          }
        ],
        resolve
      )!;
      expect(
        suggestionApprovalKey(lyons.id, { sessionId: session, proposal })
      ).not.toBe(
        suggestionApprovalKey(lyons.id, {
          sessionId: session,
          proposal: changed
        })
      );
      expect(
        folderProposal(
          [
            {
              ...candidate,
              recordingDeviceProvenance: "unknown",
              manualGitReview: undefined
            }
          ],
          resolve
        )
      ).toBeUndefined();
    }
  );

  it("proposes nothing for tier none, an unusable hint, or no hints", () => {
    expect(
      folderProposal([hint({ tier: "none", folder: undefined })])
    ).toBeUndefined();
    expect(folderProposal([create({ directory: undefined })])).toBeUndefined();
    expect(folderProposal([hint({ folder: undefined })])).toBeUndefined();
    expect(folderProposal([])).toBeUndefined();
  });
});
