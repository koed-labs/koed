// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import { PersonalMemoryStore } from "../../state/personal-memory.js";
import { ProjectSyncDetails } from "./ProjectSyncDetails.js";
type Manage = NonNullable<PersonalDesktopApi["manageMembershipSync"]>;
type State = Awaited<ReturnType<Manage>>["state"];
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = uuid(1),
  projectId = uuid(2),
  stamp = "2026-10-19T12:00:00.000Z";
const named = {
  projectId,
  name: "Planning",
  version: 1,
  headRevisionId: uuid(3),
  deletedAt: null,
  createdAt: stamp,
  updatedAt: stamp
};
const project: DesktopProject = {
  id: projectId,
  name: named.name,
  namedProject: named,
  threads: [],
  path: null,
  eventCount: 0,
  catalogued: true,
  discoveredAt: null,
  lastSeenAt: null,
  localProjectId: null,
  branch: null,
  remoteDisplay: null,
  isWorktree: false
};
const revision = (
  id: string,
  name: string
): NonNullable<State["catalog"]>["heads"][number] => ({
  version: 1,
  project: { ownerUserId: owner, projectId },
  entityId: projectId,
  revisionId: id,
  authorDeviceId: "origin_device",
  replaces: [],
  operation: { kind: "set_project", name }
});
const baseline = (): State => ({
  project: named,
  projectIdentity: projectId,
  catalog: {
    entityId: projectId,
    entityKind: "project",
    state: "available",
    heads: [revision(uuid(3), named.name)],
    source: null
  },
  memberships: [],
  nextEntityId: null
});
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
const click = async (label: string) =>
  act(async () => {
    const button = [...document.querySelectorAll("button")].find(
      (value) => value.textContent === label
    );
    expect(button, label).toBeTruthy();
    button!.click();
  });
const store = () =>
  new PersonalMemoryStore({
    listProjects: async () => [],
    loadEventPage: async () => [],
    subscribe: () => () => undefined
  } as unknown as PersonalDesktopApi);
it("reviews a pending reference removal without opening or inventing a Conversation", async () => {
  const state = baseline(),
    source = {
      ownerUserId: owner,
      originatingDeploymentId: "origin_deployment",
      originatingDeviceId: "origin_device",
      logicalSessionId: "opaque_original_source"
    };
  const entity: State["memberships"][number] = {
    entityId: "pending_inclusion",
    entityKind: "direct",
    state: "available",
    source: { reference: source, ready: false, localSessionId: null },
    heads: [
      {
        version: 1,
        project: { ownerUserId: owner, projectId },
        entityId: "pending_inclusion",
        revisionId: "include_revision",
        authorDeviceId: "origin_device",
        replaces: [],
        operation: { kind: "include", selector: { kind: "session", source } }
      }
    ]
  };
  state.memberships = [entity];
  const preview: NonNullable<Awaited<ReturnType<Manage>>["preview"]> = {
    reviewId: uuid(6),
    expectedVersion: 1,
    projectIdentity: projectId,
    entityId: entity.entityId,
    before: entity,
    after: {
      ...entity.heads[0]!,
      revisionId: uuid(7),
      replaces: ["include_revision"],
      operation: { kind: "remove_inclusion" }
    },
    effect: { catalogActive: true, sourceReady: false, included: false }
  };
  const manage = vi.fn<Manage>(async (input) =>
    input.action === "list" ? { state } : { state, preview }
  );
  const memory = store(),
    refresh = vi.spyOn(memory, "loadProjects");
  await act(async () =>
    root.render(
      <ProjectSyncDetails
        project={project}
        manage={manage}
        store={memory}
        onDeleted={vi.fn()}
      />
    )
  );
  await click("Sync details");
  expect(document.body.textContent).toContain("Conversation awaiting source");
  expect(document.body.textContent).toContain("adds no Memory");
  await click("Review removal");
  expect(manage).toHaveBeenLastCalledWith({
    action: "preview",
    projectId,
    review: {
      entityId: entity.entityId,
      expectedVersion: 1,
      expectedHeads: ["include_revision"],
      change: { kind: "remove_inclusion" }
    }
  });
  await click("Apply reviewed change");
  expect(manage).toHaveBeenLastCalledWith({
    action: "apply",
    projectId,
    reviewId: uuid(6),
    expectedVersion: 1
  });
  expect(refresh).toHaveBeenCalledOnce();
});
it("shows both catalog choices and discards a stale preview without applying another choice", async () => {
  const state = baseline();
  state.catalog = {
    entityId: projectId,
    entityKind: "project",
    state: "conflict",
    source: null,
    heads: [revision("name_a", "First name"), revision("name_b", "Second name")]
  };
  const preview: NonNullable<Awaited<ReturnType<Manage>>["preview"]> = {
    reviewId: uuid(8),
    expectedVersion: 1,
    projectIdentity: projectId,
    entityId: projectId,
    before: state.catalog,
    after: {
      ...state.catalog.heads[0]!,
      revisionId: uuid(9),
      replaces: ["name_a", "name_b"]
    },
    effect: { catalogActive: true, sourceReady: null, included: false }
  };
  const manage = vi.fn<Manage>(async (input) => {
    if (input.action === "apply")
      throw new Error("Project changed. Review the current revisions again.");
    return input.action === "preview" ? { state, preview } : { state };
  });
  await act(async () =>
    root.render(
      <ProjectSyncDetails
        project={project}
        manage={manage}
        store={store()}
        onDeleted={vi.fn()}
      />
    )
  );
  await click("Sync details");
  expect(document.body.textContent).toContain("First name");
  expect(document.body.textContent).toContain("Second name");
  await click("Review this choice");
  expect(manage).toHaveBeenLastCalledWith({
    action: "preview",
    projectId,
    review: {
      entityId: projectId,
      expectedVersion: 1,
      expectedHeads: ["name_a", "name_b"],
      change: { kind: "set_project", name: "First name" }
    }
  });
  await click("Apply reviewed change");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Review the current revisions again"
  );
  expect(
    [...document.querySelectorAll("button")].some(
      (value) => value.textContent === "Apply reviewed change"
    )
  ).toBe(false);
  expect(
    manage.mock.calls.filter(([input]) => input.action === "apply")
  ).toHaveLength(1);
});
it("reviews a retained Folder candidate and clears an exclusion without promising membership", async () => {
  const state = baseline();
  const candidate: NonNullable<State["catalog"]>["heads"][number] = {
    ...revision("folder_include", "unused"),
    entityId: "folder_rule",
    operation: {
      kind: "include",
      selector: {
        kind: "folder",
        folder: {
          ownerUserId: owner,
          folderId: "folder",
          originatingDeploymentId: "deployment",
          originatingDeviceId: "remote_device",
          originatingProfileId: "remote_profile",
          directoryIncarnationId: "incarnation"
        }
      }
    }
  };
  const rule: State["memberships"][number] = {
    entityId: "folder_rule",
    entityKind: "rule",
    state: "available",
    source: null,
    heads: [
      {
        ...candidate,
        revisionId: "folder_removed",
        replaces: [candidate.revisionId],
        operation: { kind: "remove_inclusion" }
      }
    ],
    ruleCandidates: [candidate]
  };
  const exclusion: State["memberships"][number] = {
    entityId: "exclusion",
    entityKind: "exclusion",
    state: "conflict",
    source: {
      reference: {
        ownerUserId: owner,
        originatingDeploymentId: "deployment",
        originatingDeviceId: "remote_device",
        logicalSessionId: "missing_source"
      },
      ready: false,
      localSessionId: null
    },
    heads: [
      {
        ...revision("exclude_a", "unused"),
        entityId: "exclusion",
        operation: {
          kind: "exclude",
          source: {
            ownerUserId: owner,
            originatingDeploymentId: "deployment",
            originatingDeviceId: "remote_device",
            logicalSessionId: "missing_source"
          }
        }
      },
      {
        ...revision("clear_b", "unused"),
        entityId: "exclusion",
        replaces: ["old_exclusion"],
        operation: { kind: "clear_exclusion" }
      }
    ]
  };
  state.memberships = [rule, exclusion];
  const manage = vi.fn<Manage>(async (input) => {
    if (input.action !== "preview") return { state };
    const before = state.memberships.find(
      (e) => e.entityId === input.review.entityId
    )!;
    return {
      state,
      preview: {
        reviewId: uuid(10),
        expectedVersion: 1,
        projectIdentity: projectId,
        entityId: before.entityId,
        before,
        after: {
          ...before.heads[0]!,
          revisionId: uuid(11),
          replaces: before.heads.map((h) => h.revisionId),
          operation:
            input.review.change.kind === "clear_exclusion"
              ? { kind: "clear_exclusion" }
              : candidate.operation
        },
        effect: {
          catalogActive: true,
          sourceReady: before.source?.ready ?? null,
          included: false,
          blockedByExclusion: false
        }
      }
    };
  });
  await act(async () =>
    root.render(
      <ProjectSyncDetails
        project={project}
        manage={manage}
        store={store()}
        onDeleted={vi.fn()}
      />
    )
  );
  await click("Sync details");
  await click(
    "Review Include Folder on device remote_device, profile remote_profile"
  );
  expect(manage).toHaveBeenLastCalledWith({
    action: "preview",
    projectId,
    review: {
      entityId: rule.entityId,
      expectedVersion: 1,
      expectedHeads: ["folder_removed"],
      change: { kind: "include", candidateRevisionId: "folder_include" }
    }
  });
  expect(document.body.textContent).toContain("matching verified sources");
  await click("Back");
  await click("Review clearing exclusion");
  expect(manage).toHaveBeenLastCalledWith({
    action: "preview",
    projectId,
    review: {
      entityId: exclusion.entityId,
      expectedVersion: 1,
      expectedHeads: ["exclude_a", "clear_b"],
      change: { kind: "clear_exclusion" }
    }
  });
  expect(document.body.textContent).toContain(
    "still needs an inclusion reason"
  );
  await click("Apply reviewed change");
  expect(manage).toHaveBeenLastCalledWith({
    action: "apply",
    projectId,
    reviewId: uuid(10),
    expectedVersion: 1
  });
});
