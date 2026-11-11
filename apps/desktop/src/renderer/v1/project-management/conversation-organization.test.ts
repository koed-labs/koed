import { describe, expect, it, vi } from "vitest";
import {
  personalConversationOrganizationInputSchema,
  type PersonalProjectMembershipExplanation
} from "@koed-labs/shared";
import type { DesktopProject } from "../../../project-memory-ui.js";
import {
  inverseOrganizationEdit,
  moveConversationEdit,
  reviewConversationOrganization,
  type OrganizationReview
} from "./conversation-organization.js";
import { combineCorrectionPreviews } from "./correction-review.js";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stamp = "2026-11-04T12:00:00.000Z";
const project = (n: number) =>
  ({
    id: id(n),
    name: `Project ${n}`,
    namedProject: {
      projectId: id(n),
      name: `Project ${n}`,
      version: 1,
      headRevisionId: id(100 + n),
      deletedAt: null,
      createdAt: stamp,
      updatedAt: stamp
    },
    threads: []
  }) as unknown as DesktopProject;
const reason = (kind: "session" | "folder" | "repository", n: number) => ({
  kind,
  inclusionId: id(n),
  revisionId: id(100 + n)
});
const explanation = (
  reasons: PersonalProjectMembershipExplanation["reasons"],
  excluded = false
): PersonalProjectMembershipExplanation => ({
  sessionId: id(50),
  logicalSessionId: id(51),
  reasons,
  included: !!reasons.length && !excluded,
  exclusion: excluded
    ? {
        projectId: id(2),
        logicalSessionId: id(51),
        exclusionId: id(90),
        version: 1,
        headRevisionId: id(91),
        sourceReference: null,
        clearedAt: null
      }
    : null
});
const review = (): OrganizationReview => ({
  context: {
    sessionId: id(50),
    logicalSessionId: id(51),
    git: {
      revision: 1,
      original: { state: "unresolved", reason: "historical_unresolved" },
      correction: { state: "original" }
    },
    folder: {
      revision: 1,
      original: { state: "unresolved", reason: "historical_unresolved" },
      correction: { state: "original" }
    }
  },
  projects: [project(1), project(2), project(3)],
  memberships: [
    {
      project: project(1),
      explanation: explanation([reason("folder", 10), reason("session", 11)])
    },
    { project: project(2), explanation: explanation([]) },
    {
      project: project(3),
      explanation: explanation([reason("repository", 12)])
    }
  ]
});
describe("Conversation organization drafts", () => {
  it("moves only the originating membership and keeps both source axes unchanged", () => {
    const before = review();
    const edit = moveConversationEdit(before, id(1), id(2))!;
    expect(edit.memberships).toEqual([
      { projectId: id(1), direct: false, excluded: true },
      { projectId: id(2), direct: true, excluded: false }
    ]);
    expect(edit.corrections).toEqual([]);
    expect(edit.reviewedProjects.map((p) => p.projectId)).toEqual([
      id(1),
      id(2)
    ]);
    expect(
      personalConversationOrganizationInputSchema.safeParse(edit).success
    ).toBe(true);
    expect(before.memberships[0]!.explanation.included).toBe(true);
  });
  it("does nothing on the same Project and still removes the source when destination already includes it", () => {
    const data = review();
    data.memberships[1]!.explanation = explanation([reason("session", 13)]);
    expect(moveConversationEdit(data, id(1), id(1))).toBeNull();
    expect(
      moveConversationEdit(data, id(1), id(2))!.memberships[0]
    ).toMatchObject({ projectId: id(1), direct: false });
    expect(
      moveConversationEdit(data, undefined, id(2))!.memberships
    ).toHaveLength(1);
  });
  it("requires explicit restoration and rejects unresolved exclusions", () => {
    const data = review();
    data.memberships[1]!.explanation = explanation([], true);
    expect(() => moveConversationEdit(data, id(1), id(2))).toThrow("Restore");
    expect(
      moveConversationEdit(data, id(1), id(2), { restore: true })!
        .memberships[1]!.restoreExclusion
    ).toEqual({ exclusionId: id(90), expectedExclusionRevisionId: id(91) });
    data.memberships[1]!.explanation.syncExclusion = {
      entityId: id(90),
      state: "conflict",
      blocked: true,
      heads: [id(91), id(92)]
    };
    expect(() =>
      moveConversationEdit(data, id(1), id(2), { restore: true })
    ).toThrow("sync conflict");
  });
  it("pins the entire Project catalog when removing source tags", () => {
    const edit = moveConversationEdit(review(), id(1), id(2), {
      removeGit: true,
      removeFolder: true
    })!;
    expect(edit.reviewedProjects).toHaveLength(3);
    expect(edit.corrections).toEqual([
      { axis: "git", action: "unresolved", expectedVersion: 1 },
      { axis: "folder", action: "unresolved", expectedVersion: 1 }
    ]);
  });
  it("makes Undo a guarded inverse, including previously excluded destinations and previous direct inclusions", () => {
    const data = review();
    const before = {
      context: data.context,
      projects: data.memberships.slice(0, 2).map((m) => ({
        project: m.project.namedProject!,
        explanation: m.explanation
      }))
    };
    const after = structuredClone(before);
    after.projects[0]!.project.version = 3;
    after.projects[0]!.explanation = explanation([reason("folder", 10)], true);
    after.projects[1]!.project.version = 2;
    after.projects[1]!.explanation = explanation([reason("session", 21)]);
    const inverse = inverseOrganizationEdit({ before, after })!;
    expect(inverse.memberships[0]).toMatchObject({
      projectId: id(1),
      direct: true,
      excluded: false,
      restoreExclusion: { expectedExclusionRevisionId: id(91) }
    });
    expect(inverse.memberships[1]).toEqual({
      projectId: id(2),
      direct: false,
      excluded: false
    });
    expect(inverse.reviewedProjects[0]!.expectedVersion).toBe(3);
    expect(
      personalConversationOrganizationInputSchema.safeParse(inverse).success
    ).toBe(true);
    expect(inverseOrganizationEdit({ before, after: before })).toBeNull();
  });
  it("does not lose direct membership or another retained axis when combining correction previews", () => {
    const data = review();
    const previews = [
      {
        axis: "folder",
        projects: data.memberships.map((m) => ({
          projectId: m.project.id,
          afterReasons: m.explanation.reasons.filter((r) => r.kind !== "folder")
        }))
      }
    ];
    const combined = combineCorrectionPreviews(data, [], previews as never);
    expect(combined.projects.map((p) => p.after)).toEqual([true, false, true]);
  });
  it("rejects mismatched identities or stale versions returned during review", async () => {
    const data = review();
    const api = {
      manageSourceContext: vi.fn(async () => ({ context: data.context })),
      manageProject: vi.fn(async () => ({
        project: { ...project(1).namedProject!, version: 2 },
        explanation: data.memberships[0]!.explanation
      }))
    };
    await expect(
      reviewConversationOrganization(api as never, data.projects, id(50), [
        id(1)
      ])
    ).rejects.toThrow("membership changed");
  });
});
