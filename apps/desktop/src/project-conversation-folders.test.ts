import { expect, it } from "vitest";
import type { PersonalDesktopProjectThread } from "@koed/shared/personal-desktop";
import type { DesktopProject } from "./project-memory-ui.js";
import {
  otherConversationFolderId,
  projectConversationFolders
} from "./project-conversation-folders.js";
const identity = (path: string, device = "local") => ({
  kind: "portable_repository" as const,
  key: "gr_same",
  root: path,
  branch: "main",
  checkoutId: `checkout_${path.replaceAll("/", "_")}`,
  originatingDeviceId: device,
  selectedRemote: "origin",
  anchorDisplay: "example.test/repo",
  reason: "origin" as const
});
const conversation = (
  id: string,
  extra: Partial<PersonalDesktopProjectThread>
): PersonalDesktopProjectThread => ({
  id,
  sessionId: null,
  name: id,
  sourceAiClient: "codex",
  projectId: "group",
  projectName: "Group",
  projectPath: null,
  projectAssignmentSource: "detected",
  eventCount: 1,
  invalidatedCount: 0,
  latestAt: "2026-10-16T00:00:00Z",
  sample: "",
  presentation: null,
  ...extra
});
const project = (threads: PersonalDesktopProjectThread[]): DesktopProject => ({
  id: "group",
  name: "Group",
  path: "/a",
  localProjectId: "a",
  catalogued: true,
  discoveredAt: null,
  lastSeenAt: null,
  branch: "main",
  remoteDisplay: null,
  isWorktree: false,
  eventCount: threads.length,
  threads,
  checkouts: ["/a", "/a/nested", "/ab"].map((path) => ({
    path,
    localProjectId: path,
    repository: identity(path)
  }))
});
it("uses captured source and the longest folder boundary instead of a moved destination", () => {
  const automatic = identity("/a");
  const moved = conversation("moved", {
    projectAssignmentSource: "user_override",
    projectPath: "/ab",
    repositoryAssignment: {
      state: "recorded",
      version: 2,
      automatic,
      override: identity("/ab"),
      effective: identity("/ab")
    }
  });
  const historical = conversation("history", {
    projectAssignmentSource: "user_override",
    projectPath: null,
    capturedCwd: "/a/nested/src"
  });
  const unknown = conversation("unknown", {
    projectAssignmentSource: "user_override",
    projectPath: "/ab"
  });
  const model = projectConversationFolders(
    project([moved, historical, unknown])
  );
  expect(model.byThread.get("moved")).toBe(
    model.folders.find((folder) => folder.path === "/a")!.id
  );
  expect(model.byThread.get("history")).toBe(
    model.folders.find((folder) => folder.path === "/a/nested")!.id
  );
  expect(model.byThread.get("unknown")).toBe(otherConversationFolderId);
});
it("retains historical folders and separates equal paths from other devices", () => {
  const remote = identity("/a", "remote");
  const model = projectConversationFolders(
    project([
      conversation("remote", {
        repositoryAssignment: {
          state: "recorded",
          version: 1,
          automatic: remote,
          override: null,
          effective: remote
        }
      }),
      conversation("history", { capturedCwd: "/old/repo" })
    ])
  );
  expect(model.folders.filter((folder) => folder.path === "/a")).toHaveLength(
    2
  );
  expect(model.byThread.get("remote")).not.toBe(model.folders[0]!.id);
  expect(
    model.folders.find((folder) => folder.path === "/old/repo")?.count
  ).toBe(1);
});
it("inherits a parent folder for child Agents without source metadata", () => {
  const model = projectConversationFolders(
    project([
      conversation("child", {
        threadKind: "subagent",
        parentThreadId: "parent"
      }),
      conversation("parent", { capturedCwd: "/ab/source" })
    ])
  );
  expect(model.byThread.get("child")).toBe(model.byThread.get("parent"));
  expect(model.folders.find((folder) => folder.path === "/ab")?.count).toBe(2);
});

it("deduplicates repeated folder identities and retains the first checkout's actions", () => {
  const source = project([conversation("one", { capturedCwd: "/a" })]);
  source.checkouts!.push({
    ...source.checkouts![0]!,
    localProjectId: "duplicate",
    path: "/a/"
  });
  const model = projectConversationFolders(source);

  expect(model.folders.filter((folder) => folder.path === "/a")).toEqual([
    expect.objectContaining({ localProjectId: "/a", count: 1 })
  ]);
  expect(new Set(model.folders.map((folder) => folder.id)).size).toBe(
    model.folders.length
  );
});

it("marks unknown-device history separately from the current checkout at the same path", () => {
  const automatic = {
    ...identity("/a", "historical_unknown_device"),
    root: null,
    checkoutId: null
  };
  const model = projectConversationFolders(
    project([
      conversation("current", { capturedCwd: "/a" }),
      conversation("history", {
        capturedCwd: "/a",
        repositoryAssignment: {
          state: "recorded",
          version: 1,
          automatic,
          override: null,
          effective: automatic
        }
      })
    ])
  );
  const current = model.folders.find(
    (folder) => folder.localProjectId === "/a"
  )!;
  const historical = model.folders.find((folder) => folder.historical)!;

  expect(historical).toMatchObject({
    path: "/a",
    count: 1,
    localProjectId: null
  });
  expect(current.count).toBe(1);
  expect(model.byThread.get("history")).toBe(historical.id);
  expect(model.byThread.get("current")).toBe(current.id);
  expect(historical.id).not.toBe(current.id);
});

it("keeps dynamically discovered folders separate across known devices", () => {
  const model = projectConversationFolders(
    project(
      ["one", "two"].map((device) => {
        const automatic = identity("/historical/path", device);
        return conversation(device, {
          repositoryAssignment: {
            state: "recorded",
            version: 1,
            automatic,
            override: null,
            effective: automatic
          }
        });
      })
    )
  );

  expect(
    model.folders.filter((folder) => folder.path === "/historical/path")
  ).toHaveLength(2);
  expect(model.byThread.get("one")).not.toBe(model.byThread.get("two"));
});
