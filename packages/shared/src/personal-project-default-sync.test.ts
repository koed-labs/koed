import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { personalProjectDefaultIdentity } from "./personal-project-default.js";
import {
  personalMembershipSelectorKey,
  evaluatePersonalMembershipRevisions,
  encodePdsPersonalMembershipEntitySnapshot,
  decodePdsPersonalMembershipEntitySnapshot
} from "./personal-membership-transport.js";
import {
  personalMembershipRevisionSchema,
  type PersonalMembershipRevision
} from "./personal-membership-contract.js";
import { personalMembershipSyncEntitySchema } from "./personal-membership-review-contract.js";
import type { PersonalGitContext } from "./personal-source-contract.js";
const owner = "00000000-0000-4000-8000-000000000001";
const git: PersonalGitContext = {
  kind: "portable_repository",
  key: "gr_sync",
  root: "/recorded/koed",
  branch: "main",
  checkoutId: "checkout",
  originatingDeviceId: "device_one",
  reason: "origin",
  selectedRemote: "origin",
  anchorDisplay: "example.test/koed"
};
const target = { kind: "repository" as const, repository: git };
const identity = personalProjectDefaultIdentity(target);
const root = (
  revisionId: string,
  device: string,
  name: string
): PersonalMembershipRevision =>
  personalMembershipRevisionSchema.parse({
    version: 1,
    project: { ownerUserId: owner, projectId: identity.projectIdentity },
    entityId: identity.projectIdentity,
    revisionId,
    authorDeviceId: device,
    replaces: [],
    operation: { kind: "set_project", name },
    automaticDefault: { sourceKey: identity.sourceKey, target }
  });

describe("default Project causal provenance", () => {
  it("preserves the initialized identity across canonical selectors and independent checkout labels", () => {
    const oldKey = `source_default_${createHash("sha256")
      .update(
        `koed/personal-project-default/v1\n${personalMembershipSelectorKey(target)}`
      )
      .digest("hex")}`;
    expect(identity.sourceKey).toBe(oldKey);
    expect(
      personalProjectDefaultIdentity({
        kind: "repository",
        repository: {
          ...git,
          root: "/other/path",
          checkoutId: "other",
          selectedRemote: "upstream",
          originatingDeviceId: "other",
          anchorDisplay: "example.test/other-name"
        }
      })
    ).toEqual(identity);
    const folder = {
      ownerUserId: owner,
      folderId: "folder",
      originatingDeviceId: "device",
      originatingDeploymentId: "deployment",
      originatingProfileId: "profile",
      directoryIncarnationId: "lifetime"
    };
    const one = personalProjectDefaultIdentity({ kind: "folder", folder });
    expect(
      personalProjectDefaultIdentity({
        kind: "folder",
        folder: {
          ...folder,
          ownerUserId: "00000000-0000-4000-8000-000000000002"
        }
      }).sourceKey
    ).toBe(one.sourceKey);
    expect(
      personalProjectDefaultIdentity({
        kind: "folder",
        folder: { ...folder, directoryIncarnationId: "replacement" }
      }).sourceKey
    ).not.toBe(one.sourceKey);
  });
  it("converges automatic roots in either order, retains both authors and heads, and lets reviewed User intent supersede an unseen initialization", () => {
    const a = root("initial_A", "device_A", "koed"),
      b = root("initial_B", "device_B", "clone-label");
    const first = evaluatePersonalMembershipRevisions([a, b]);
    expect(first).toEqual(evaluatePersonalMembershipRevisions([b, a]));
    expect(first).toMatchObject({
      state: "available",
      heads: ["initial_A", "initial_B"],
      revision: a
    });
    const snapshot = {
      version: 1 as const,
      project: a.project,
      entityKind: "project" as const,
      entityId: a.entityId,
      revisions: [a, b]
    };
    expect(
      decodePdsPersonalMembershipEntitySnapshot(
        encodePdsPersonalMembershipEntitySnapshot(snapshot)
      )
    ).toEqual(snapshot);
    expect(
      personalMembershipSyncEntitySchema.parse({
        entityId: a.entityId,
        entityKind: "project",
        state: first.state,
        heads: [a, b],
        source: null
      }).heads
    ).toHaveLength(2);
    const rename: PersonalMembershipRevision = {
      ...a,
      automaticDefault: undefined,
      revisionId: "rename_A",
      replaces: [a.revisionId],
      operation: { kind: "set_project", name: "My name" }
    };
    expect(evaluatePersonalMembershipRevisions([b, rename, a])).toMatchObject({
      state: "available",
      heads: ["initial_B", "rename_A"],
      revision: rename
    });
    const deletion: PersonalMembershipRevision = {
      ...b,
      automaticDefault: undefined,
      revisionId: "delete_B",
      replaces: [b.revisionId],
      operation: { kind: "delete_project" }
    };
    expect(
      evaluatePersonalMembershipRevisions([a, b, rename, deletion])
    ).toMatchObject({
      state: "conflict",
      heads: ["delete_B", "rename_A"],
      revision: null
    });
  });
  it("distinguishes automatic retirement from User deletion and never disguises a later edit as initialization", () => {
    const a = root("initial_A", "device_A", "koed"),
      b = root("initial_B", "device_B", "clone");
    const retired: PersonalMembershipRevision = {
      ...a,
      automaticDefault: undefined,
      automaticRetirement: { sourceKey: identity.sourceKey, target },
      revisionId: "retire_A",
      replaces: [a.revisionId],
      operation: { kind: "delete_project" }
    };
    expect(evaluatePersonalMembershipRevisions([a, b, retired])).toMatchObject({
      state: "available",
      revision: retired
    });
    const rename: PersonalMembershipRevision = {
      ...b,
      automaticDefault: undefined,
      revisionId: "rename_B",
      replaces: [b.revisionId],
      operation: { kind: "set_project", name: "Keep my Project" }
    };
    expect(
      evaluatePersonalMembershipRevisions([a, b, retired, rename])
    ).toMatchObject({ state: "available", revision: rename });
    expect(
      personalMembershipRevisionSchema.safeParse({
        ...a,
        replaces: [b.revisionId]
      }).success
    ).toBe(false);
    expect(
      personalMembershipRevisionSchema.safeParse({
        ...a,
        automaticDefault: {
          ...a.automaticDefault,
          sourceKey: `source_default_${"0".repeat(64)}`
        }
      }).success
    ).toBe(false);
    expect(
      personalMembershipRevisionSchema.safeParse({
        ...a,
        project: { ...a.project, projectId: owner },
        entityId: owner
      }).success
    ).toBe(false);
  });
});
