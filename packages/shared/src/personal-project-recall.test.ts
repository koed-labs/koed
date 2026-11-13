import { describe, expect, it } from "vitest";
import {
  personalRecallTargetsEqual,
  personalSelectionSchema,
  personalProjectRecallResolutionInputSchema
} from "./personal-selection-contract.js";
import {
  personalSelectionLegacyScope,
  authorizedPersonalSelectionSnapshot,
  assertPersonalSelectionInput
} from "./personal-selection-snapshot.js";
import { personalSelectionConsumerTargetSchema } from "./personal-selection-consumer-contract.js";

const owner = "11111111-1111-4111-8111-111111111111";
const target = {
  kind: "projects" as const,
  callerSessionId: "22222222-2222-4222-8222-222222222222",
  projects: [
    { ownerUserId: owner, projectId: "a" },
    { ownerUserId: owner, projectId: "b" }
  ]
};
const selection = {
  version: 1,
  ownerUserId: owner,
  target,
  callerRepositoryContext: null
};
describe("pinned Project union", () => {
  it("pins a set of owner-bound references without inventing a repository identity", () => {
    const parsed = personalSelectionSchema.parse(selection);
    expect(personalSelectionLegacyScope(parsed)).toEqual({
      searchDomain: "project"
    });
    expect(() =>
      assertPersonalSelectionInput(parsed, { search_domain: "project" })
    ).not.toThrow();
    expect(
      personalRecallTargetsEqual(target, {
        ...target,
        projects: [...target.projects].reverse()
      })
    ).toBe(true);
    expect(
      personalRecallTargetsEqual(target, { ...target, callerSessionId: owner })
    ).toBe(false);
  });
  it("rejects empty, duplicate and mixed-owner scopes", () => {
    for (const projects of [
      [],
      [target.projects[0], target.projects[0]],
      [{ ownerUserId: target.callerSessionId, projectId: "a" }]
    ])
      expect(
        personalSelectionSchema.safeParse({
          ...selection,
          target: { ...target, projects }
        }).success
      ).toBe(false);
    expect(() =>
      authorizedPersonalSelectionSnapshot(selection, target.callerSessionId)
    ).toThrow("another owner");
    expect(
      personalSelectionConsumerTargetSchema.safeParse(target).success
    ).toBe(false);
  });
  it("requires one explicit capture binding and never accepts an owner override", () => {
    expect(
      personalProjectRecallResolutionInputSchema.safeParse({
        externalSessionId: "native",
        sourceRuntime: "codex-cli"
      }).success
    ).toBe(true);
    for (const input of [
      {},
      { sessionId: target.callerSessionId, ownerUserId: owner },
      {
        sessionId: target.callerSessionId,
        externalSessionId: "native",
        sourceRuntime: "codex-cli"
      }
    ])
      expect(
        personalProjectRecallResolutionInputSchema.safeParse(input).success
      ).toBe(false);
  });
});
