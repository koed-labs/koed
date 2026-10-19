import { expect, it } from "vitest";
import type { RepositoryIdentity } from "@koed/shared";
import type { PersonalDesktopProjectThread } from "@koed/shared/personal-desktop";
import type { DesktopProject } from "./project-memory-ui.js";
import { projectRowPresentation } from "./project-row-presentation.js";

const manual: RepositoryIdentity = {
  kind: "local_project",
  key: "manual",
  root: null,
  branch: null,
  checkoutId: null,
  originatingDeviceId: "local",
  reason: "manual",
  selectedRemote: null,
  anchorDisplay: null
};
const repository = (
  overrides: Partial<
    Extract<RepositoryIdentity, { kind: "portable_repository" }>
  > = {}
): Extract<RepositoryIdentity, { kind: "portable_repository" }> => ({
  kind: "portable_repository",
  key: "koed",
  root: "/code/koed",
  branch: "main",
  checkoutId: "checkout_koed",
  originatingDeviceId: "local",
  reason: "origin",
  selectedRemote: "origin",
  anchorDisplay: "github.com/koed-labs/koed",
  ...overrides
});
const thread = (
  id: string,
  automatic: RepositoryIdentity | null,
  overrides: Partial<PersonalDesktopProjectThread> = {}
): PersonalDesktopProjectThread => ({
  id,
  sessionId: null,
  name: id,
  sourceAiClient: "codex",
  projectId: "manual",
  projectName: "koed",
  projectPath: null,
  projectAssignmentSource: "user_override",
  repositoryAssignment: {
    state: "recorded",
    version: 2,
    automatic,
    override: manual,
    effective: manual
  },
  eventCount: 42,
  invalidatedCount: 0,
  latestAt: "2026-10-19T09:00:00Z",
  sample: "",
  presentation: null,
  ...overrides
});
const project = (overrides: Partial<DesktopProject> = {}): DesktopProject => ({
  id: "manual",
  name: "koed",
  repository: manual,
  path: null,
  eventCount: 0,
  threads: [],
  catalogued: false,
  discoveredAt: null,
  lastSeenAt: null,
  localProjectId: null,
  branch: null,
  remoteDisplay: null,
  isWorktree: false,
  ...overrides
});

it("keeps manual Projects distinct from Git and folder groups with the same name", () => {
  const git = repository();
  expect(
    projectRowPresentation(project({ threads: [thread("one", git)] }))
  ).toMatchObject({ kind: "project", context: "koed-labs/koed" });
  expect(projectRowPresentation(project({ repository: git }))).toMatchObject({
    kind: "git",
    context: "koed-labs/koed"
  });
  expect(
    projectRowPresentation(
      project({
        repository: {
          ...git,
          kind: "non_git_project",
          reason: "non_git",
          anchorDisplay: null
        }
      })
    )
  ).toMatchObject({ kind: "folder", context: "/code/koed" });
});

it("omits context for a rootless manual Project and counts Conversations without child Agents", () => {
  expect(
    projectRowPresentation(
      project({
        threads: [
          thread("parent", null),
          thread("child", null, {
            threadKind: "subagent",
            parentThreadId: "parent"
          })
        ]
      })
    )
  ).toMatchObject({ kind: "project", context: null, conversationCount: 1 });
});

it("collapses multiple checkouts and devices of one portable repository without counting their folders", () => {
  const first = repository();
  const second = repository({
    root: "/other/koed",
    checkoutId: "checkout_two",
    originatingDeviceId: "remote"
  });
  expect(
    projectRowPresentation(
      project({
        checkouts: [
          { localProjectId: "first", path: first.root!, repository: first }
        ],
        threads: [thread("first", first), thread("second", second)]
      })
    )
  ).toMatchObject({ context: "koed-labs/koed", contextKind: "repository" });
});

it("summarizes distinct repositories even when their displayed names match", () => {
  expect(
    projectRowPresentation(
      project({
        threads: [
          thread("first", repository()),
          thread(
            "second",
            repository({ key: "other", root: "/other", checkoutId: "other" })
          )
        ]
      })
    )
  ).toMatchObject({ context: "2 repositories", contextKind: "repository" });
});

it("shows a repository and a separate folder together", () => {
  expect(
    projectRowPresentation(
      project({
        threads: [
          thread("git", repository()),
          thread("folder", null, { capturedCwd: "/notes" })
        ]
      })
    )
  ).toMatchObject({
    context: "koed-labs/koed · 1 folder",
    contextKind: "mixed"
  });
});

it("does not hide an unrelated folder at the same path on a different device", () => {
  expect(
    projectRowPresentation(
      project({
        threads: [
          thread("git", repository()),
          thread("folder", null, {
            capturedCwd: "/code/koed",
            originDevice: { id: "remote", name: "Remote" }
          })
        ]
      })
    ).context
  ).toBe("koed-labs/koed · 1 folder");
});

it("deduplicates plain folders on the same device but preserves distinct devices", () => {
  const first = thread("first", null, {
    capturedCwd: "/notes",
    originDevice: { id: "local", name: "Local" }
  });
  const second = thread("second", null, {
    capturedCwd: "/notes/",
    originDevice: first.originDevice
  });
  expect(
    projectRowPresentation(project({ threads: [first, second] })).context
  ).toBe("/notes");
  expect(
    projectRowPresentation(
      project({
        threads: [
          first,
          second,
          thread("remote", null, {
            capturedCwd: "/notes",
            originDevice: { id: "remote", name: "Remote" }
          })
        ]
      })
    ).context
  ).toBe("2 folders");
});

it("keeps device-local Git identities distinct and does not infer a portable anchor", () => {
  const local: RepositoryIdentity = {
    ...repository(),
    kind: "device_local_repository",
    anchorDisplay: null,
    reason: "local_fallback"
  };
  expect(
    projectRowPresentation(project({ repository: local, path: local.root }))
  ).toMatchObject({ kind: "git", context: "/code/koed" });
  expect(
    projectRowPresentation(
      project({
        threads: [
          thread("one", local),
          thread("two", { ...local, originatingDeviceId: "remote" })
        ]
      })
    ).context
  ).toBe("2 repositories");
});

it("keeps unresolved history and independent Conversations distinct from folder groups", () => {
  expect(
    projectRowPresentation(
      project({ id: "unassigned", repository: undefined, path: "/old/path" })
    )
  ).toMatchObject({ kind: "unresolved", context: null });
  expect(
    projectRowPresentation(
      project({ contextKind: "independent", path: "/koed/internal" })
    )
  ).toMatchObject({ kind: "independent", context: null });
});
