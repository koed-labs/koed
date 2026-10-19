import { expect, it } from "vitest";
import {
  repositoryIdentitySchema,
  type RepositoryIdentity
} from "./repository-identity.js";
import {
  repositoryAssignmentSchema,
  createRepositoryAssignment
} from "./repository-assignment.js";
import { planRepositorySearch } from "./repository-recall.js";

const portable: RepositoryIdentity = {
  kind: "portable_repository",
  key: "gr_current",
  root: "/current",
  branch: "main",
  reason: "origin",
  checkoutId: "checkout_current",
  originatingDeviceId: "device_current",
  selectedRemote: "origin",
  anchorDisplay: null
};
it.each(["personal", "team"])(
  "plans %s score scans and one-result searches as one pass",
  (retrievalScope) => {
    const common = {
      retrievalScope,
      searchDomain: "global",
      repositoryContext: portable,
      limit: 10
    };
    expect(
      planRepositorySearch({ ...common, retrievalStage: "score_scan" })
    ).toEqual({ global: 10, current: 0, searchPasses: 1 });
    expect(planRepositorySearch({ ...common, limit: 1 })).toEqual({
      global: 1,
      current: 0,
      searchPasses: 1
    });
    expect(planRepositorySearch({ ...common, maxSearchPasses: 1 })).toEqual({
      global: 10,
      current: 0,
      searchPasses: 1
    });
    expect(planRepositorySearch(common)).toEqual({
      global: 8,
      current: 2,
      searchPasses: 2
    });
  }
);
it("keeps device-local context out of Team preference without weakening Personal scope", () => {
  const context: RepositoryIdentity = {
    ...portable,
    kind: "device_local_repository"
  };
  const common = {
    searchDomain: "global",
    repositoryContext: context,
    limit: 10
  };
  expect(
    planRepositorySearch({ ...common, retrievalScope: "team" }).current
  ).toBe(0);
  expect(
    planRepositorySearch({ ...common, retrievalScope: "personal" }).current
  ).toBe(2);
});
it("rejects impossible identity variants and derives effective assignment", () => {
  expect(
    repositoryIdentitySchema.safeParse({ ...portable, key: null }).success
  ).toBe(false);
  expect(
    repositoryIdentitySchema.safeParse({ ...portable, kind: "unresolved" })
      .success
  ).toBe(false);
  expect(
    repositoryIdentitySchema.safeParse({
      ...portable,
      kind: "local_project",
      reason: "manual"
    }).success
  ).toBe(false);
  const other: RepositoryIdentity = { ...portable, key: "gr_other" };
  expect(() =>
    repositoryAssignmentSchema.parse({
      state: "recorded",
      version: 1,
      automatic: portable,
      override: other,
      effective: portable
    })
  ).toThrow("Effective repository");
  expect(
    createRepositoryAssignment({
      state: "recorded",
      version: 1,
      automatic: portable,
      override: other
    }).effective
  ).toEqual(other);
  expect(
    createRepositoryAssignment({
      state: "recorded",
      version: 1,
      automatic: portable,
      override: null
    }).effective
  ).toEqual(portable);
});
