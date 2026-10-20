import { expect, it } from "vitest";
import {
  repositoryIdentitySchema,
  type RepositoryIdentity
} from "./repository-identity.js";
import {
  repositoryAssignmentSchema,
  createRepositoryAssignment
} from "./repository-assignment.js";
import {
  planRepositorySearch,
  repositoryScopeId
} from "./repository-recall.js";
import {
  normalizePersonalSelection,
  personalRecallTargetsEqual,
  personalSelectionSchema,
  type PersonalRecallTarget
} from "./personal-selection-contract.js";
import {
  effectivePersonalSourceFact,
  personalSourceContextSchema,
  type PersonalSourceReference
} from "./personal-source-contract.js";
import {
  personalInclusionSelectorSchema,
  personalMembershipRevisionSchema,
  personalSourceBindingSchema
} from "./personal-membership-contract.js";

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

const owner = "00000000-0000-4000-8000-000000000001";
const otherOwner = "00000000-0000-4000-8000-000000000002";
const localSessionId = "00000000-0000-4000-8000-000000000003";
const source: PersonalSourceReference = {
  ownerUserId: owner,
  originatingDeploymentId: "deployment_a",
  originatingDeviceId: "device_a",
  logicalSessionId: "logical:conversation_a"
};
const project = { ownerUserId: owner, projectId: "project_a" };
const folder = {
  ownerUserId: owner,
  folderId: "folder_a",
  originatingDeploymentId: "deployment_a",
  originatingDeviceId: "device_a",
  originatingProfileId: "profile_a",
  directoryIncarnationId: "directory_a"
};
const targets: PersonalRecallTarget[] = [
  { kind: "global" },
  { kind: "project", project },
  { kind: "repository", repository: portable },
  { kind: "folder", folder },
  { kind: "session", source }
];
it.each(targets)(
  "keeps explicit $kind target separate from caller context",
  (target) => {
    const caller = { ...portable, key: "gr_caller" };
    expect(
      normalizePersonalSelection(
        { recall_target: target, repository_context: caller },
        owner
      )
    ).toEqual({
      version: 1,
      ownerUserId: owner,
      target,
      callerRepositoryContext: caller
    });
  }
);
it("decodes exact legacy Git scopes, roots and established aliases without changing selected-anchor matching", () => {
  for (const id of [repositoryScopeId(portable), portable.root!, "lp_alias"]) {
    const selection = normalizePersonalSelection(
      {
        search_domain: "project",
        project_id: id,
        repository_context: portable
      },
      owner,
      {
        project: (alias) =>
          alias === "lp_alias"
            ? { kind: "repository", repository: portable }
            : undefined
      }
    );
    expect(selection.target).toEqual({
      kind: "repository",
      repository: portable
    });
  }
  expect(
    normalizePersonalSelection(
      { search_domain: "global", repository_context: portable },
      owner
    ).target
  ).toEqual({ kind: "global" });
  expect(
    normalizePersonalSelection(
      { search_domain: "session", session_id: localSessionId },
      owner,
      {
        session: (id) => (id === localSessionId ? source : undefined)
      }
    ).target
  ).toEqual({ kind: "session", source });
});
it("decodes legacy named and non-Git identities only through exact established mappings", () => {
  const named = repositoryIdentitySchema.parse({
    ...portable,
    kind: "local_project",
    reason: "manual",
    key: "named_a",
    root: null,
    branch: null,
    checkoutId: null,
    selectedRemote: null,
    anchorDisplay: null
  });
  const nonGit = repositoryIdentitySchema.parse({
    ...portable,
    kind: "non_git_project",
    reason: "non_git"
  });
  for (const [identity, target] of [
    [named, targets[1]!],
    [nonGit, targets[3]!]
  ] as const) {
    const scope = repositoryScopeId(identity);
    expect(
      normalizePersonalSelection(
        { repository_context: identity, project_id: scope },
        owner,
        {
          project: (id) => (id === scope ? target : undefined)
        }
      )
    ).toEqual({
      version: 1,
      ownerUserId: owner,
      target,
      callerRepositoryContext: null
    });
    expect(() =>
      normalizePersonalSelection({ repository_context: identity }, owner)
    ).toThrow("identity mapping");
  }
});
it("defaults only to trusted Git or exact Folder context and never to Global", () => {
  const unresolved = {
    ...portable,
    kind: "unresolved",
    key: null,
    reason: "probe_failed"
  };
  expect(
    normalizePersonalSelection(
      { search_domain: "global", repository_context: unresolved },
      owner
    )
  ).toMatchObject({
    target: { kind: "global" },
    callerRepositoryContext: null
  });
  expect(() =>
    normalizePersonalSelection({ repository_context: unresolved }, owner)
  ).toThrow("resolved source context");
  expect(
    normalizePersonalSelection({}, owner, {
      defaultTarget: { kind: "folder", folder }
    }).target
  ).toEqual({ kind: "folder", folder });
  expect(
    normalizePersonalSelection({}, owner, {
      defaultTarget: { kind: "repository", repository: portable }
    }).target
  ).toEqual({ kind: "repository", repository: portable });
  expect(() => normalizePersonalSelection({}, owner)).toThrow(
    "Trusted Git or exact Folder"
  );
  expect(() =>
    normalizePersonalSelection({ repository_context: null }, owner)
  ).toThrow("resolved source context");
});
it.each([
  { search_domain: "global", project_id: "project_a" },
  { search_domain: "project", session_id: localSessionId },
  { search_domain: "session" },
  { search_domain: "session", session_id: localSessionId },
  { project_id: "unknown" },
  { recall_target: { kind: "global" }, search_domain: "global" },
  { recall_target: { kind: "folder", folder }, project_id: "project_a" },
  {
    recall_target: {
      kind: "repository",
      repository: { ...portable, kind: "non_git_project" }
    }
  },
  { recall_target: { kind: "unknown" } },
  { recall_target: { kind: "global", folder } },
  { team_workspace_id: localSessionId }
])("rejects invalid or ambiguous selection without widening: %j", (input) => {
  expect(() => normalizePersonalSelection(input, owner)).toThrow();
});
it("rejects conflicting aliases, cross-owner mappings and unsupported contract versions", () => {
  expect(() =>
    normalizePersonalSelection(
      { project_id: "lp_alias", repository_context: portable },
      owner,
      {
        project: () => ({
          kind: "repository",
          repository: { ...portable, key: "gr_other" }
        })
      }
    )
  ).toThrow("conflicts");
  for (const target of [
    { kind: "project", project: { ...project, ownerUserId: otherOwner } },
    { kind: "folder", folder: { ...folder, ownerUserId: otherOwner } },
    { kind: "session", source: { ...source, ownerUserId: otherOwner } }
  ])
    expect(() =>
      normalizePersonalSelection({ recall_target: target }, owner)
    ).toThrow("another owner");
  expect(
    personalSelectionSchema.safeParse({
      version: 2,
      ownerUserId: owner,
      target: { kind: "global" },
      callerRepositoryContext: null
    }).success
  ).toBe(false);
});
it("compares exact Folder identity without borrowing paths, device identity, or directory incarnations", () => {
  const target: PersonalRecallTarget = { kind: "folder", folder };
  expect(
    personalRecallTargetsEqual(target, {
      kind: "folder",
      folder: { ...folder }
    })
  ).toBe(true);
  for (const changed of [
    { folderId: "folder_parent" },
    { folderId: "folder_child" },
    { originatingDeviceId: "device_b" },
    { originatingProfileId: "profile_b" },
    { directoryIncarnationId: "replacement" },
    { ownerUserId: otherOwner }
  ])
    expect(
      personalRecallTargetsEqual(target, {
        kind: "folder",
        folder: { ...folder, ...changed }
      })
    ).toBe(false);
  expect(
    personalRecallTargetsEqual(
      { kind: "repository", repository: portable },
      {
        kind: "repository",
        repository: {
          ...portable,
          root: "/another_clone",
          originatingDeviceId: "device_b"
        }
      }
    )
  ).toBe(true);
});
it("retains original context and lets an explicit unresolved correction suppress it", () => {
  const original = { state: "known" as const, value: portable };
  const context = personalSourceContextSchema.parse({
    version: 1,
    source,
    git: {
      revision: 2,
      original,
      correction: {
        state: "corrected",
        revisionId: "revision_b",
        value: { state: "unresolved", reason: "explicit_unresolved" }
      }
    },
    folder: {
      revision: 1,
      original: { state: "unresolved", reason: "historical_unresolved" },
      correction: { state: "original" }
    }
  });
  expect(effectivePersonalSourceFact(context.git)).toEqual({
    state: "unresolved",
    reason: "explicit_unresolved"
  });
  expect(context.git.original).toEqual(original);
  expect(
    effectivePersonalSourceFact({
      ...context.git,
      correction: { state: "original" }
    })
  ).toEqual(original);
  expect(effectivePersonalSourceFact(context.folder)).toEqual({
    state: "unresolved",
    reason: "historical_unresolved"
  });
  expect(
    personalSourceContextSchema.safeParse({
      ...context,
      folder: {
        revision: 1,
        original: {
          state: "known",
          value: {
            reference: { ...folder, ownerUserId: otherOwner },
            normalizedPath: "/current",
            capturedPath: "/current"
          }
        },
        correction: { state: "original" }
      }
    }).success
  ).toBe(false);
});
it("versions membership operations, retains removals and rejects nested Projects or foreign references", () => {
  const revision = {
    version: 1,
    project,
    entityId: "inclusion_a",
    revisionId: "revision_b",
    authorDeviceId: "device_a",
    replaces: ["revision_a"]
  };
  expect(
    personalMembershipRevisionSchema.parse({
      ...revision,
      operation: { kind: "remove_inclusion" }
    }).replaces
  ).toEqual(["revision_a"]);
  expect(
    personalMembershipRevisionSchema.safeParse({
      ...revision,
      replaces: [],
      operation: { kind: "remove_inclusion" }
    }).success
  ).toBe(false);
  for (const replaces of [["revision_b"], ["revision_a", "revision_a"]]) {
    expect(
      personalMembershipRevisionSchema.safeParse({
        ...revision,
        replaces,
        operation: { kind: "include", selector: { kind: "session", source } }
      }).success
    ).toBe(false);
  }
  expect(
    personalInclusionSelectorSchema.safeParse({ kind: "project", project })
      .success
  ).toBe(false);
  expect(
    personalMembershipRevisionSchema.safeParse({
      ...revision,
      operation: {
        kind: "exclude",
        source: { ...source, ownerUserId: otherOwner }
      }
    }).success
  ).toBe(false);
  expect(
    personalMembershipRevisionSchema.safeParse({
      ...revision,
      operation: {
        kind: "include",
        selector: {
          kind: "folder",
          folder: { ...folder, ownerUserId: otherOwner }
        }
      }
    }).success
  ).toBe(false);
});
it("retains an unavailable logical source as pending without inventing a local Session", () => {
  expect(
    personalSourceBindingSchema.parse({ state: "pending", source })
  ).toEqual({ state: "pending", source });
  expect(
    personalSourceBindingSchema.safeParse({
      state: "pending",
      source,
      localSessionId
    }).success
  ).toBe(false);
});
