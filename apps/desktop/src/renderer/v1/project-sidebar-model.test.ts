import { describe, expect, it } from "vitest";
import type { DesktopProject } from "../../project-memory-ui.js";
import type { V1ConversationIntent } from "../../ipc/v1-state-protocol.js";
import {
  buildProjectSidebar,
  filterSidebar,
  pinnedConversations
} from "./project-sidebar-model.js";

const thread = (id: string, latestAt: string, sourceAiClient = "codex") => ({
  id,
  sessionId: id,
  name: id,
  latestAt,
  sourceAiClient,
  sample: "",
  eventCount: 1,
  invalidatedCount: 0
});
const named = (id: string, threads: ReturnType<typeof thread>[]) =>
  ({
    id,
    name: id,
    namedProject: { projectId: id },
    threads
  }) as DesktopProject;
const before = "2026-10-29T12:00:00Z";
const after = "2026-10-29T13:00:00Z";
const intent = {
  idempotencyKey: "launch",
  executionId: "execution",
  projectId: "folder",
  presentationProjectId: "project",
  aiClientDriverId: "pi",
  createdAt: before
} as V1ConversationIntent;

describe("Project sidebar inventory", () => {
  it("preserves Git, Folder and multiple manual memberships without requiring launch provenance", () => {
    const manual = named("Manual", [thread("shared", before)]);
    const second = named("Second membership", [thread("shared", before)]);
    const git = {
      id: "git",
      name: "koed",
      repository: {
        kind: "portable_repository",
        key: "gr_anchor",
        root: "/checkout",
        branch: "main",
        checkoutId: "checkout_one",
        originatingDeviceId: "device_one",
        selectedRemote: "origin",
        anchorDisplay: "example.test/repo",
        reason: "origin"
      },
      threads: [thread("capture", after, "claude-code")]
    } as DesktopProject;
    const folder = {
      id: "folder",
      name: "Local files",
      folder: {
        reference: {
          folderId: "folder-id",
          ownerUserId: "00000000-0000-4000-8000-000000000001",
          originatingDeviceId: "device",
          originatingDeploymentId: "deployment",
          originatingProfileId: "profile",
          directoryIncarnationId: "lifetime"
        }
      },
      threads: [thread("pi-session", before, "pi")]
    } as DesktopProject;
    const source = [manual, second, git, folder, named("Empty", [])];
    const original = structuredClone(source);
    const groups = buildProjectSidebar(source, [], new Map());
    expect(groups.map((p) => p.id)).toEqual([
      "git",
      "folder",
      "Manual",
      "Second membership",
      "Empty"
    ]);
    expect(
      groups.filter((p) =>
        p.conversations.some((r) => r.key === "session:shared")
      )
    ).toHaveLength(2);
    expect(groups.find((p) => p.id === "git")!.conversations[0]!.client).toBe(
      "claude"
    );
    expect(
      groups.find((p) => p.id === "folder")!.conversations[0]!.client
    ).toBe("pi");
    expect(source).toEqual(original);
  });
  it("does not duplicate named memberships in raw source fallback groups", () => {
    const first = named("First", [thread("shared", before)]);
    const second = named("Second", [thread("shared", before)]);
    const raw = {
      id: "raw",
      name: "Raw inventory",
      threads: [thread("shared", before), thread("unassigned", after)]
    } as DesktopProject;
    const groups = buildProjectSidebar([raw, first, second], [], new Map());
    expect(
      groups
        .find((p) => p.id === "no-project")!
        .conversations.map((row) => row.title)
    ).toEqual(["unassigned"]);
    expect(
      groups.filter((p) =>
        p.conversations.some((row) => row.title === "shared")
      )
    ).toHaveLength(2);
  });
  it("keeps a pending selected Project entry while capture awaits membership reconciliation", () => {
    const target = named("project", []);
    const raw = {
      id: "raw",
      name: "Raw inventory",
      threads: [thread("captured", after)]
    } as DesktopProject;
    const groups = buildProjectSidebar(
      [target, raw],
      [{ ...intent, capturedSessionId: "captured" }],
      new Map()
    );
    expect(
      groups.find((p) => p.id === "project")!.conversations[0]!.route
        .executionId
    ).toBe("execution");
    target.threads = raw.threads;
    const reconciled = buildProjectSidebar(
      [target, raw],
      [
        {
          ...intent,
          capturedSessionId: "captured",
          projectMembershipConfirmed: true
        }
      ],
      new Map()
    );
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]!.conversations).toHaveLength(1);
  });
  it("does not restore a membership that was removed after launch", () => {
    const groups = buildProjectSidebar(
      [named("project", []), named("Moved", [thread("captured", after)])],
      [
        {
          ...intent,
          capturedSessionId: "captured",
          projectMembershipConfirmed: true
        }
      ],
      new Map()
    );
    expect(groups.find((p) => p.id === "project")!.conversations).toEqual([]);
    expect(groups.find((p) => p.id === "Moved")!.conversations).toHaveLength(1);
  });
  it("sorts from activity, preserves stable ties, and reacts to ingestion", () => {
    const source = [
      named("older", [thread("a", before)]),
      named("newer", [thread("c", after), thread("b", after)])
    ];
    const first = buildProjectSidebar(source, [], new Map());
    expect(first[0]!.id).toBe("newer");
    expect(first[0]!.conversations.map((r) => r.title)).toEqual(["b", "c"]);
    source[0]!.threads[0]!.latestAt = "2026-10-29T14:00:00Z";
    expect(buildProjectSidebar(source, [], new Map())[0]!.id).toBe("older");
  });
  it("keeps uncategorized captures in No project, without merging named memberships", () => {
    const source = [
      { id: "raw", name: "raw", threads: [thread("same", before)] },
      { id: "other", name: "other", threads: [thread("same", after)] }
    ] as DesktopProject[];
    const groups = buildProjectSidebar(source, [], new Map());
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe("No project");
    expect(groups[0]!.conversations).toHaveLength(1);
    expect(groups[0]!.conversations[0]!.route.projectId).toBe("other");
  });
  it("replaces a pending launch with capture and retains its pin alias", () => {
    const project = named("project", []);
    const pending = buildProjectSidebar([project], [intent], new Map());
    expect(pending[0]!.conversations[0]!.key).toBe("execution:execution");
    project.threads.push(
      thread("captured", after, "pi") as DesktopProject["threads"][number]
    );
    const captured = buildProjectSidebar(
      [project],
      [{ ...intent, capturedSessionId: "captured" }],
      new Map()
    );
    expect(captured[0]!.conversations).toHaveLength(1);
    expect(pinnedConversations(captured, ["execution:execution"])[0]!.key).toBe(
      "session:captured"
    );
  });
  it("does not match unrelated legacy threads to an intent with no capture ID", () => {
    const legacy = named("project", [
      { ...thread("legacy", after), sessionId: undefined } as never
    ]);
    const groups = buildProjectSidebar([legacy], [intent], new Map());
    expect(groups[0]!.conversations).toHaveLength(2);
    expect(groups[0]!.conversations[0]!.route.executionId).toBeUndefined();
  });
  it("searches titles and Project names and keeps pins in saved order", () => {
    const groups = buildProjectSidebar(
      [named("Koed", [thread("Privacy", after), thread("Build", before)])],
      [],
      new Map()
    );
    expect(filterSidebar(groups, "privacy")[0]!.conversations).toHaveLength(1);
    expect(filterSidebar(groups, "KOED")[0]!.conversations).toHaveLength(2);
    expect(
      pinnedConversations(groups, ["session:Build", "session:Privacy"]).map(
        (r) => r.title
      )
    ).toEqual(["Build", "Privacy"]);
  });
});
