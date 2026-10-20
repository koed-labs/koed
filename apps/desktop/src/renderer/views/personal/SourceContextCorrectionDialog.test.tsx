// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  PersonalDesktopApi,
  PersonalDesktopProject,
  PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
import { PersonalMemoryStore } from "../../state/personal-memory.js";
import { SourceContextCorrectionDialog } from "./SourceContextCorrectionDialog.js";
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Manage = NonNullable<PersonalDesktopApi["manageSourceContext"]>;
type Context = Awaited<ReturnType<Manage>>["context"];
const original: Context = {
  sessionId: uuid(1),
  logicalSessionId: uuid(2),
  git: {
    revision: 1,
    original: { state: "unresolved", reason: "historical_unresolved" },
    correction: { state: "original" }
  },
  folder: {
    revision: 1,
    original: { state: "unresolved", reason: "historical_unresolved" },
    correction: { state: "original" }
  }
};
const folder = {
  reference: {
    ownerUserId: uuid(3),
    folderId: "folder",
    originatingDeploymentId: "deployment",
    originatingDeviceId: "device",
    originatingProfileId: "profile",
    directoryIncarnationId: "incarnation"
  },
  normalizedPath: "/recorded/sub",
  capturedPath: "/recorded/sub"
};
const projects: PersonalDesktopProject[] = [
  {
    id: "folder_context",
    name: "Subfolder",
    path: folder.normalizedPath,
    folder,
    eventCount: 0,
    threads: []
  }
];
const thread = {
  id: "source",
  name: "Decision",
  sessionId: uuid(1)
} as PersonalDesktopProjectThread;
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
const button = (text: string) => {
  const result = [...document.querySelectorAll("button")].find(
    (node) => node.textContent === text
  );
  expect(result, text).toBeTruthy();
  return result!;
};
const click = async (text: string) => act(async () => button(text).click());
const select = async (label: string, value: string) =>
  act(async () => {
    const node = document.querySelector<HTMLSelectElement>(
      `select[aria-label="${label}"]`
    )!;
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
const store = () =>
  new PersonalMemoryStore({
    listProjects: async () => projects,
    loadEventPage: async () => [],
    subscribe: () => () => undefined
  } as unknown as PersonalDesktopApi);
it("previews a separate Folder correction and applies the reviewed source version without a Project destination", async () => {
  const after: Context = {
    ...original,
    folder: {
      ...original.folder,
      revision: 2,
      correction: {
        state: "corrected",
        revisionId: uuid(4),
        value: { state: "known", value: folder }
      }
    }
  };
  const preview = {
    reviewId: uuid(5),
    axis: "folder" as const,
    expectedVersion: 1,
    before: original,
    after,
    projects: [
      {
        projectId: uuid(6),
        name: "Release",
        version: 4,
        beforeReasons: [
          {
            kind: "session" as const,
            inclusionId: uuid(7),
            revisionId: uuid(8)
          }
        ],
        afterReasons: [
          {
            kind: "session" as const,
            inclusionId: uuid(7),
            revisionId: uuid(8)
          },
          {
            kind: "folder" as const,
            inclusionId: uuid(9),
            revisionId: uuid(10)
          }
        ],
        beforeIncluded: true,
        afterIncluded: true
      }
    ]
  };
  let current = original;
  const manage = vi.fn<Manage>(async (input) => {
    if (input.action === "get") return { context: current };
    if (input.action === "preview") return { context: current, preview };
    current = after;
    return { context: after };
  });
  await act(async () =>
    root.render(
      <SourceContextCorrectionDialog
        thread={thread}
        projects={projects}
        manage={manage}
        store={store()}
      />
    )
  );
  await click("Correct source context");
  expect(
    document.querySelector('[aria-label="Current source context"]')?.textContent
  ).toContain("Unresolved history");
  await click("Folder");
  await select("Correction", JSON.stringify(folder.reference));
  await click("Review changes");
  expect(manage).toHaveBeenLastCalledWith({
    action: "preview",
    sessionId: uuid(1),
    correction: {
      axis: "folder",
      action: "set",
      expectedVersion: 1,
      folder: folder.reference
    }
  });
  expect(document.body.textContent).toContain(
    "ReleaseDirect inclusion, FolderIncluded → Included"
  );
  expect(document.body.textContent).toContain("Direct inclusion, Folder");
  await click("Confirm");
  expect(manage).toHaveBeenLastCalledWith({
    action: "apply",
    sessionId: uuid(1),
    reviewId: uuid(5),
    expectedVersion: 1
  });
  await click("Correct source context");
  expect(
    document.querySelector('[aria-label="Current source context"]')?.textContent
  ).toContain("Unresolved history");
  expect(button("Review changes")).toBeTruthy();
  await click("Folder");
  expect(
    document.querySelector('[aria-label="Current source context"]')?.textContent
  ).toContain("/recorded/sub");
});
it("clears changed and stale previews and requires a new explicit preview", async () => {
  let context = original;
  const manage = vi.fn<Manage>(async (input) => {
    if (input.action === "get") return { context };
    if (input.action === "preview")
      return {
        context,
        preview: {
          reviewId: uuid(5),
          axis: "git",
          expectedVersion: context.git.revision,
          before: context,
          after: context,
          projects: []
        }
      };
    context = { ...original, git: { ...original.git, revision: 3 } };
    throw new Error(
      "Source context or Project membership changed. Preview the correction again."
    );
  });
  await act(async () =>
    root.render(
      <SourceContextCorrectionDialog
        thread={thread}
        projects={projects}
        manage={manage}
        store={store()}
      />
    )
  );
  await click("Correct source context");
  await click("Review changes");
  expect(button("Confirm").disabled).toBe(false);
  await select("Correction", "unresolved");
  expect(button("Review changes")).toBeTruthy();
  expect(
    [...document.querySelectorAll("button")].some(
      (node) => node.textContent === "Confirm"
    )
  ).toBe(false);
  await click("Review changes");
  await click("Confirm");
  expect(document.body.textContent).toContain(
    "Source context or Project membership changed."
  );
  expect(button("Review changes")).toBeTruthy();
  expect(
    [...document.querySelectorAll("button")].some(
      (node) => node.textContent === "Confirm"
    )
  ).toBe(false);
  expect(
    manage.mock.calls.filter(([input]) => input.action === "apply")
  ).toHaveLength(1);
  await click("Review changes");
  expect(manage).toHaveBeenLastCalledWith({
    action: "preview",
    sessionId: uuid(1),
    correction: { axis: "git", action: "unresolved", expectedVersion: 3 }
  });
});

const conflictContext = (): Context => {
  const repository = (label: string) => ({
    kind: "portable_repository" as const,
    key: `gr_${label}`,
    root: `/recorded/${label}`,
    branch: "main",
    reason: "origin" as const,
    checkoutId: `checkout_${label}`,
    originatingDeviceId: "device",
    selectedRemote: "origin",
    anchorDisplay: `example.test/${label}`
  });
  const heads = ["alpha", "beta"].map((label, index) => ({
    revisionId: uuid(20 + index),
    assignment: {
      ...original.git,
      revision: 2,
      correction: {
        state: "corrected" as const,
        revisionId: uuid(20 + index),
        value: { state: "known" as const, value: repository(label) }
      }
    }
  }));
  return {
    ...original,
    git: {
      ...original.git,
      revision: 3,
      correction: {
        state: "corrected",
        revisionId: "conflict_view",
        value: { state: "unresolved", reason: "source_context_conflict" }
      }
    },
    sync: {
      source: {
        ownerUserId: uuid(3),
        originatingDeploymentId: "deployment",
        originatingDeviceId: "device",
        logicalSessionId: "opaque/source"
      },
      availability: "available",
      git: {
        state: "conflict",
        frontier: heads.map((head) => head.revisionId),
        heads
      },
      folder: {
        state: "available",
        frontier: ["folder_original"],
        heads: [{ revisionId: "folder_original", assignment: original.folder }]
      }
    }
  };
};
it("shows synchronized conflict candidates and sends the selected candidate through explicit review", async () => {
  const context = conflictContext();
  const manage = vi.fn<Manage>(async (input) =>
    input.action === "get"
      ? { context }
      : {
          context,
          preview: {
            reviewId: uuid(30),
            axis: "git",
            expectedVersion: 3,
            before: context,
            after: context,
            projects: []
          }
        }
  );
  await act(async () =>
    root.render(
      <SourceContextCorrectionDialog
        thread={thread}
        projects={[]}
        manage={manage}
        store={store()}
      />
    )
  );
  await click("Correct source context");
  expect(document.body.textContent).toContain("has conflicting corrections");
  expect(document.body.textContent).toContain("example.test/alpha");
  expect(document.body.textContent).toContain("example.test/beta");
  const choice = [
    ...document.querySelectorAll<HTMLOptionElement>(
      'select[aria-label="Correction"] option'
    )
  ].find((option) => option.textContent === "example.test/alpha");
  expect(choice).toBeDefined();
  await select("Correction", choice!.value);
  await click("Review changes");
  const assignment = context.sync!.git.heads[0]!.assignment;
  if (
    assignment.correction.state !== "corrected" ||
    assignment.correction.value.state !== "known"
  )
    throw new Error("Expected a conflict candidate");
  expect(manage).toHaveBeenLastCalledWith({
    action: "preview",
    sessionId: uuid(1),
    correction: {
      axis: "git",
      action: "set",
      repository: assignment.correction.value.value,
      expectedVersion: 3
    }
  });
  await click("Confirm");
  expect(manage).toHaveBeenLastCalledWith({
    action: "apply",
    sessionId: uuid(1),
    reviewId: uuid(30),
    expectedVersion: 3
  });
});
it("disables correction while the synchronized source body is pending", async () => {
  const base = conflictContext();
  const context: Context = {
    ...base,
    sync: {
      ...base.sync!,
      availability: "pending",
      git: {
        state: "available",
        frontier: [base.sync!.git.frontier[0]!],
        heads: [base.sync!.git.heads[0]!]
      }
    }
  };
  const manage = vi.fn<Manage>(async () => ({ context }));
  await act(async () =>
    root.render(
      <SourceContextCorrectionDialog
        thread={thread}
        projects={[]}
        manage={manage}
        store={store()}
      />
    )
  );
  await click("Correct source context");
  expect(document.body.textContent).toContain(
    "source is waiting for synchronized content"
  );
  expect(button("Review changes").disabled).toBe(true);
  await click("Review changes");
  expect(manage).toHaveBeenCalledTimes(1);
});

it("discards a reviewed correction on Cancel without applying it", async () => {
  const manage = vi.fn<Manage>(async (input) =>
    input.action === "get"
      ? { context: original }
      : {
          context: original,
          preview: {
            reviewId: uuid(5),
            axis: "git",
            expectedVersion: 1,
            before: original,
            after: original,
            projects: []
          }
        }
  );
  await act(async () =>
    root.render(
      <SourceContextCorrectionDialog
        thread={thread}
        projects={projects}
        manage={manage}
        store={store()}
      />
    )
  );
  await click("Correct source context");
  await select("Correction", "unresolved");
  await click("Review changes");
  await click("Cancel");
  expect(manage.mock.calls.some(([input]) => input.action === "apply")).toBe(
    false
  );
  await click("Correct source context");
  expect(
    document.querySelector<HTMLSelectElement>(
      'select[aria-label="Correction"]'
    )!.value
  ).toBe("reset");
  expect(button("Review changes")).toBeTruthy();
});

it("rejects a correction preview for a different axis without applying it", async () => {
  const manage = vi.fn<Manage>(async (input) =>
    input.action === "get"
      ? { context: original }
      : {
          context: original,
          preview: {
            reviewId: uuid(5),
            axis: "folder",
            expectedVersion: 1,
            before: original,
            after: original,
            projects: []
          }
        }
  );
  await act(async () =>
    root.render(
      <SourceContextCorrectionDialog
        thread={thread}
        projects={projects}
        manage={manage}
        store={store()}
      />
    )
  );
  await click("Correct source context");
  await click("Review changes");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "could not be verified"
  );
  expect(manage.mock.calls.some(([input]) => input.action === "apply")).toBe(
    false
  );
  expect(button("Review changes")).toBeTruthy();
});
