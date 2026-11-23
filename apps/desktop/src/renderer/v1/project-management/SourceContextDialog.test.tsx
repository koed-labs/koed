// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  personalFolderScopeId,
  type PersonalFolderHint
} from "@koed-labs/shared";
import type { PersonalDesktopApi } from "@koed-labs/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import { SourceContextDialog } from "./SourceContextDialog.js";
import { projectsForFolder } from "./folder-project.js";

vi.mock("./folder-project.js", () => ({
  projectsForFolder: vi.fn(() => [])
}));
const projectNames = vi.mocked(projectsForFolder);
vi.mock("./repository-project.js", () => ({
  repositoryTargetFor: vi.fn((_projects: unknown, key: string) =>
    key === "gr_lyons"
      ? { sourceId: "repo-source", repository: { key } }
      : undefined
  ),
  projectsForRepository: vi.fn((_projects: unknown, key: string) =>
    key === "gr_lyons" ? [{ id: "lyons", name: "lyons-mouth" }] : []
  )
}));

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const folder = {
  reference: {
    ownerUserId: id(1),
    folderId: "api",
    originatingDeploymentId: "deployment",
    originatingDeviceId: "device",
    originatingProfileId: "profile",
    directoryIncarnationId: "api-lifetime"
  },
  normalizedPath: "/work/koed/api",
  capturedPath: "/work/koed/api"
};
const axis = {
  revision: 1,
  original: { state: "unresolved", reason: "missing" },
  correction: { state: "original" }
};
const projects = [
  {
    id: personalFolderScopeId(folder.reference),
    name: "API",
    folder,
    path: folder.normalizedPath,
    eventCount: 1,
    threads: []
  }
] as unknown as DesktopProject[];
const hint = (
  overrides: Partial<PersonalFolderHint> = {}
): PersonalFolderHint => ({
  sessionId: id(50),
  tier: "strong",
  score: 6,
  folder: folder.reference,
  reasons: [{ code: "git-remote", outcome: "agrees" }],
  ...overrides
});

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  projectNames.mockImplementation(() => []);
  act(() => root.unmount());
  host.remove();
});

const render = async (
  folderHints?: PersonalDesktopApi["folderHints"],
  confirmFolderHint?: PersonalDesktopApi["confirmFolderHint"]
) => {
  const api = {
    manageSourceContext: vi.fn(async () => ({
      context: {
        sessionId: id(50),
        logicalSessionId: id(51),
        git: {
          ...axis,
          original: { state: "unresolved", reason: "historical_unresolved" }
        },
        folder: axis
      }
    })),
    manageProject: vi.fn(),
    ...(folderHints ? { folderHints } : {}),
    ...(confirmFolderHint ? { confirmFolderHint } : {})
  } as unknown as PersonalDesktopApi;
  await act(async () => {
    root.render(
      <SourceContextDialog
        api={api}
        projects={projects}
        target={{ sessionId: id(50), title: "Conversation" }}
        axis="folder"
        onClose={() => {}}
        onApply={async () => {}}
      />
    );
  });
  await act(async () => {});
  return api;
};

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === label);
const accepted = { folder: folder.reference };

describe("SourceContextDialog Folder suggestion", () => {
  it("shows one short suggestion and makes it a choice only when the User accepts it", async () => {
    const folderHints = vi.fn(async () => [
      hint({ directory: "/work/koed/api" })
    ]);
    const confirmFolderHint = vi.fn(async () => accepted);
    await render(folderHints, confirmFolderHint);
    expect(folderHints).toHaveBeenCalledWith({ sessionIds: [id(50)] });
    const text = document.body.textContent ?? "";
    expect(text).toContain("Suggested Folder: api");
    // No evidence on the page, and the `?` is hidden until its wording is ready.
    expect(text).not.toContain("Same Git remote");
    expect(
      document.querySelector('button[aria-label="Why this suggestion"]')
    ).toBeNull();
    expect(confirmFolderHint).not.toHaveBeenCalled();
    expect(button("Review changes")?.hasAttribute("disabled")).toBe(true);
    await act(async () => button("Use")!.click());
    expect(confirmFolderHint).toHaveBeenCalledWith({
      sessionId: id(50),
      kind: "registered",
      folder: folder.reference
    });
    expect(button("Review changes")?.hasAttribute("disabled")).toBe(false);
    expect(document.body.textContent).not.toContain("Suggested ");
  });

  it("names a worktree's suggestion after its project and accepts it as the main checkout", async () => {
    const confirmFolderHint = vi.fn(async () => accepted);
    await render(
      vi.fn(async () => [
        hint(),
        hint({
          kind: "worktree-parent",
          directory: "/Users/me/agents/koed"
        })
      ]),
      confirmFolderHint
    );
    expect(document.body.textContent).toContain("Suggested Folder: koed");
    await act(async () => button("Use")!.click());
    expect(confirmFolderHint).toHaveBeenCalledExactlyOnceWith({
      sessionId: id(50),
      kind: "worktree-parent",
      folder: folder.reference
    });
  });

  it("shows nothing for a tier-none hint, without the bridge method, or when hints fail", async () => {
    await render(
      vi.fn(async () => [hint({ tier: "none", folder: undefined })]),
      vi.fn()
    );
    expect(document.body.textContent).not.toContain("Suggested ");
    act(() => root.unmount());
    root = createRoot(host);
    await render(vi.fn(async () => [hint()]));
    expect(document.body.textContent).not.toContain("Suggested ");
    act(() => root.unmount());
    root = createRoot(host);
    await render(
      vi.fn(async () => Promise.reject(new Error("offline"))),
      vi.fn()
    );
    expect(document.body.textContent).not.toContain("Suggested ");
    expect(document.body.textContent).toContain("Correct source context");
  });
});

describe("SourceContextDialog Project suggestion", () => {
  it("names the Project the suggested Folder is already in", async () => {
    projectNames.mockReturnValue([{ id: "koed", name: "Koed" }]);
    await render(
      vi.fn(async () => [hint({ directory: "/work/koed/api" })]),
      vi.fn()
    );
    expect(projectNames).toHaveBeenCalledWith(projects, folder.reference);
    expect(document.body.textContent).toContain("Suggested Project: Koed");
    expect(document.body.textContent).not.toContain("Suggested Folder");
  });
});

describe("SourceContextDialog Git Anchor suggestion", () => {
  const anchorHint = () =>
    hint({
      kind: "repository",
      folder: undefined,
      repositoryKey: "gr_lyons",
      directory: "/repos/lyons-mouth",
      tier: "medium",
      reasons: [{ code: "directory-remote", outcome: "agrees" }]
    });

  it("suggests the Project whose Git Anchor matches, and selects it without registering anything", async () => {
    const confirmFolderHint = vi.fn();
    const api = await render(
      vi.fn(async () => [anchorHint()]),
      confirmFolderHint
    );
    expect(document.body.textContent).toContain(
      "Suggested Project: lyons-mouth"
    );
    expect(button("Review changes")?.hasAttribute("disabled")).toBe(true);
    await act(async () => button("Use")!.click());
    expect(confirmFolderHint).not.toHaveBeenCalled();
    expect(button("Review changes")?.hasAttribute("disabled")).toBe(false);
    expect(document.body.textContent).not.toContain("Suggested Project");
    await act(async () => button("Review changes")!.click());
    expect(api.manageSourceContext).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "preview",
        correction: {
          axis: "git",
          action: "set",
          expectedVersion: 1,
          repository: { key: "gr_lyons" }
        }
      })
    );
  });

  it("shows the suggestion without the Folder bridge, since an anchor needs none", async () => {
    await render(vi.fn(async () => [anchorHint()]));
    expect(document.body.textContent).toContain(
      "Suggested Project: lyons-mouth"
    );
  });
});

it("does not offer unregistered directories even with confirmation available", async () => {
  await render(
    vi.fn(async () => [
      hint({ kind: "create", folder: undefined, directory: "/work/history" })
    ]),
    vi.fn()
  );
  expect(document.body.textContent).not.toContain("Suggested ");
  expect(button("Use")).toBeUndefined();
});

it("shows confirmation failure without staging the Folder correction", async () => {
  await render(
    vi.fn(async () => [hint()]),
    vi.fn().mockRejectedValue(new Error("no longer matches"))
  );
  await act(async () => button("Use")!.click());
  expect(document.body.textContent).toContain("no longer matches");
  expect(button("Review changes")?.hasAttribute("disabled")).toBe(true);
});
