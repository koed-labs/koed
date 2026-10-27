import { describe, expect, it } from "vitest";
import {
  personalInventoryReference,
  partitionPersonalInventory,
  deduplicatePersonalInventoryConversations
} from "./personal-inventory.js";
import type { RepositoryIdentity } from "./repository-identity.js";
import { classifyPersonalInventory } from "./personal-inventory-classification.js";

const owner = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const repository: RepositoryIdentity = {
  kind: "portable_repository",
  key: "gr_one",
  root: "/checkout",
  branch: "main",
  checkoutId: "checkout_one",
  originatingDeviceId: "device_one",
  selectedRemote: "origin",
  anchorDisplay: "example.test/repo",
  reason: "origin"
};
const folder = {
  reference: {
    ownerUserId: owner,
    folderId: "folder",
    originatingDeviceId: "device_one",
    originatingDeploymentId: "deployment",
    originatingProfileId: "profile",
    directoryIncarnationId: "lifetime_one"
  },
  normalizedPath: "/checkout",
  capturedPath: "/checkout"
};

describe("Personal inventory identities", () => {
  it("explains repeated identities, overlapping views and recorded Git/Folder relationships independently of equal labels", () => {
    const thread = {
      id: "one",
      sessionId: "session_one",
      sourceReferences: [
        {
          sessionId: "session_one",
          logicalSessionId: "logical_one",
          logicalMemoryId: null
        }
      ],
      eventCount: 1,
      invalidatedCount: 0,
      latestAt: "2026-10-27T10:00:00.000Z",
      repositoryAssignment: {
        state: "recorded" as const,
        version: 1,
        automatic: repository,
        override: null,
        effective: repository
      }
    };
    const git = { id: "git", name: "same", repository, threads: [thread] };
    const exact = { id: "folder", name: "same", folder, threads: [thread] };
    const other = {
      ...exact,
      id: "other",
      folder: {
        ...folder,
        reference: { ...folder.reference, originatingDeviceId: "device_two" }
      }
    };
    const result = classifyPersonalInventory([
      git,
      {
        ...git,
        id: "another_checkout",
        repository: { ...repository, root: "/elsewhere", checkoutId: "another" }
      },
      exact,
      other
    ]);
    expect(result.equalIdentities).toHaveLength(1);
    expect(result.equalIdentities[0]).toMatchObject({ kind: "git", rows: 2 });
    expect(result.equalLabels[0]?.selections).toHaveLength(3);
    expect(result.overlappingViews[0]?.selections).toHaveLength(3);
    expect(result.folders).toHaveLength(2);
    expect(
      result.folders.every((entry) => entry.classification === "git_checkout")
    ).toBe(true);
    expect(result.folders[0]?.gitSources[0]?.key).toBe(
      result.folders[1]?.gitSources[0]?.key
    );
  });
  it("keeps named Projects, Git, exact Folders and unresolved history distinct despite matching labels and paths", () => {
    const named = {
      id: projectId,
      name: "Same",
      namedProject: { projectId },
      projectReference: { ownerUserId: owner, projectId },
      threads: []
    };
    const git = { id: "git", name: "Same", repository, threads: [] };
    const exact = { id: "folder", name: "Same", folder, threads: [] };
    const unresolved = { id: "unassigned", name: "Same", threads: [] };
    const inventory = partitionPersonalInventory([
      named,
      git,
      exact,
      unresolved
    ]);
    expect(inventory).toEqual({
      projects: [named],
      gitSources: [git],
      folders: [exact],
      unresolved: [unresolved]
    });
    expect(
      personalInventoryReference({
        ...git,
        repository: {
          ...repository,
          root: "/other",
          checkoutId: "checkout_two",
          originatingDeviceId: "device_two"
        }
      }).key
    ).toBe(personalInventoryReference(git).key);
    expect(
      personalInventoryReference({
        ...git,
        repository: { ...repository, key: "gr_two" }
      }).key
    ).not.toBe(personalInventoryReference(git).key);
    for (const reference of [
      { ...folder.reference, originatingDeviceId: "device_two" },
      { ...folder.reference, directoryIncarnationId: "lifetime_two" },
      {
        ...folder.reference,
        ownerUserId: "00000000-0000-4000-8000-000000000003"
      }
    ])
      expect(
        personalInventoryReference({
          ...exact,
          folder: { ...folder, reference }
        }).key
      ).not.toBe(personalInventoryReference(exact).key);
  });
  it("retains overlapping inclusion reasons and source links without inflating logical Conversation counts", () => {
    const first = {
      id: "first",
      sessionId: "session_one",
      sourceReferences: [
        {
          sessionId: "session_one",
          logicalSessionId: "logical_one",
          logicalMemoryId: null
        }
      ],
      membershipReasons: [{ kind: "repository", inclusionId: "rule_one" }],
      eventCount: 4,
      invalidatedCount: 0,
      latestAt: "2026-10-27T10:00:00.000Z"
    };
    const later = {
      ...first,
      id: "second",
      sessionId: "session_two",
      sourceReferences: [
        {
          sessionId: "session_two",
          logicalSessionId: "logical_one",
          logicalMemoryId: null
        }
      ],
      membershipReasons: [{ kind: "folder", inclusionId: "rule_two" }],
      eventCount: 5,
      latestAt: "2026-10-27T11:00:00.000Z"
    };
    const result = deduplicatePersonalInventoryConversations([
      first,
      later,
      first
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "second",
      eventCount: 5,
      sourceReferences: [...first.sourceReferences, ...later.sourceReferences],
      membershipReasons: [
        ...first.membershipReasons,
        ...later.membershipReasons
      ]
    });
    expect(
      deduplicatePersonalInventoryConversations([
        first,
        {
          ...first,
          sourceReferences: [
            { ...first.sourceReferences[0]!, logicalSessionId: "logical_two" }
          ]
        }
      ])
    ).toHaveLength(2);
  });
});
