import { describe, expect, it, vi } from "vitest";
import type { PersonalFolderHint } from "@koed-labs/shared";
import type { PersonalDesktopApi } from "@koed-labs/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import {
  INFERRED_GIT_ANCHOR_CHECKS,
  inferredGitAnchorKey,
  recordInferredGitAnchors
} from "./infer-git-anchor.js";

const { KEY, repository } = vi.hoisted(() => ({
  KEY: "gr_lyons",
  repository: { key: "gr_lyons", kind: "portable_repository" }
}));
vi.mock("./repository-project.js", () => ({
  repositoryTargetFor: (_: unknown, key: string) =>
    key === KEY ? { sourceId: "s", repository } : undefined
}));
const hint = (
  overrides: Partial<PersonalFolderHint> = {},
  outcomes: Record<string, string> = {}
): PersonalFolderHint =>
  ({
    sessionId: "11111111-1111-4111-8111-111111111111",
    tier: "medium",
    kind: "repository",
    repositoryKey: KEY,
    score: 70,
    reasons: [
      ...INFERRED_GIT_ANCHOR_CHECKS.map((code) => ({
        code,
        outcome: outcomes[code] ?? "agrees"
      })),
      { code: "contained-transcript-file", outcome: "does-not-agree" }
    ],
    ...overrides
  }) as unknown as PersonalFolderHint;

describe("inferredGitAnchorKey", () => {
  it("proves a Git Anchor only when every check agrees", () => {
    expect(inferredGitAnchorKey(hint())).toBe(KEY);
    for (const code of INFERRED_GIT_ANCHOR_CHECKS) {
      expect(inferredGitAnchorKey(hint({}, { [code]: "unavailable" }))).toBe(
        undefined
      );
      expect(inferredGitAnchorKey(hint({}, { [code]: "does-not-agree" }))).toBe(
        undefined
      );
    }
  });

  it("ignores Folder hints, tier none, and any rejecting evidence", () => {
    expect(inferredGitAnchorKey(hint({ kind: "registered" }))).toBe(undefined);
    expect(inferredGitAnchorKey(hint({ tier: "none" }))).toBe(undefined);
    const rejected = hint();
    rejected.reasons.push({
      code: "git-remote",
      outcome: "rejects"
    } as PersonalFolderHint["reasons"][number]);
    expect(inferredGitAnchorKey(rejected)).toBe(undefined);
  });
});

describe("recordInferredGitAnchors", () => {
  const projects = [
    {
      id: "repo",
      name: "github.com/diffhq/lyons-mouth",
      threads: [],
      repository: { key: KEY },
      sources: []
    }
  ] as unknown as DesktopProject[];

  const api = (git: { original: object; correction: object }) => {
    const manageSourceContext = vi.fn(
      async (input: { action: string }): Promise<unknown> => {
        if (input.action === "get")
          return { context: { git: { revision: 3, ...git } } };
        if (input.action === "preview")
          return {
            context: {},
            preview: { reviewId: "review-1", expectedVersion: 3 }
          };
        return { context: {} };
      }
    );
    return {
      manageSourceContext
    } as unknown as PersonalDesktopApi & {
      manageSourceContext: typeof manageSourceContext;
    };
  };
  const hints = new Map([["session-1", [hint()]]]);

  it("records a proven Git Anchor on an unresolved, uncorrected Conversation", async () => {
    const a = api({
      original: { state: "unresolved", reason: "historical_unresolved" },
      correction: { state: "original" }
    });
    const result = await recordInferredGitAnchors(a, projects, hints);
    expect(result).toEqual({ recorded: ["session-1"], failed: 0 });
    expect(a.manageSourceContext).toHaveBeenCalledWith({
      action: "preview",
      sessionId: "session-1",
      correction: {
        axis: "git",
        action: "set",
        repository,
        expectedVersion: 3
      }
    });
    expect(a.manageSourceContext).toHaveBeenLastCalledWith({
      action: "apply",
      sessionId: "session-1",
      reviewId: "review-1",
      expectedVersion: 3
    });
  });

  it("never touches a known Git Anchor or one the User corrected", async () => {
    for (const git of [
      {
        original: { state: "known", value: {} },
        correction: { state: "original" }
      },
      {
        original: { state: "unresolved", reason: "historical_unresolved" },
        correction: { state: "corrected", value: { state: "unresolved" } }
      }
    ]) {
      const a = api(git);
      const result = await recordInferredGitAnchors(a, projects, hints);
      expect(result.recorded).toEqual([]);
      expect(a.manageSourceContext).toHaveBeenCalledTimes(1);
    }
  });

  it("skips a Git Anchor no Project knows and conflicting proofs", async () => {
    const a = api({
      original: { state: "unresolved", reason: "historical_unresolved" },
      correction: { state: "original" }
    });
    const unknown = new Map([
      ["session-1", [hint({ repositoryKey: "gr_unknown" })]]
    ]);
    const conflicting = new Map([
      ["session-1", [hint(), hint({ repositoryKey: "gr_other" })]]
    ]);
    expect(
      (await recordInferredGitAnchors(a, projects, unknown)).recorded
    ).toEqual([]);
    expect(
      (await recordInferredGitAnchors(a, projects, conflicting)).recorded
    ).toEqual([]);
    expect(a.manageSourceContext).not.toHaveBeenCalled();
  });
});
