// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@koed/shared/project-contract";
import type {
  CuratedAssertion,
  CuratedMemoryDesktopApi,
  CuratedMemoryPage
} from "../../../ipc/curated-memory-protocol.js";
import { WhatKoedKnows } from "./WhatKoedKnows.js";

const owner = "00000000-0000-4000-8000-000000000101";
const projectId = "00000000-0000-4000-8000-000000000102";
const secondProjectId = "00000000-0000-4000-8000-000000000103";
const project = {
  id: projectId,
  name: "Atlas",
  lifecycle: "active"
} as Project;
const secondProject = {
  id: secondProjectId,
  name: "Comet",
  lifecycle: "active"
} as Project;
const item = (
  text: string,
  scope: CuratedAssertion["scope"] = "project",
  overrides: Partial<CuratedAssertion> = {}
): CuratedAssertion => ({
  id: crypto.randomUUID(),
  ownerUserId: owner,
  visibility: "personal",
  scope,
  projectId: scope === "project" ? projectId : null,
  kind: "decision",
  authorKind: "user",
  authorRef: owner,
  classificationVersion: 1,
  assertionText: text,
  status: "current",
  createdAt: "2026-10-20T08:00:00.000Z",
  observedAt: "2026-10-20T08:00:00.000Z",
  updatedAt: "2026-10-20T08:00:00.000Z",
  suppressionToken: null,
  sources: [],
  replaces: [],
  ...overrides
});
const page = (
  assertions: CuratedAssertion[],
  nextCursor: CuratedMemoryPage["nextCursor"] = null
): CuratedMemoryPage => ({ assertions, nextCursor });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const api = (
  getPage: CuratedMemoryDesktopApi["page"],
  detail: CuratedMemoryDesktopApi["detail"] = async () => item("Detail")
) =>
  ({
    page: vi.fn(getPage),
    list: vi.fn(async () => []),
    detail: vi.fn(detail),
    forget: vi.fn(async (id: string) =>
      item("Forgotten", "project", {
        id,
        status: "suppressed",
        suppressionToken: "1"
      })
    ),
    undo: vi.fn(async (id: string) => item("Restored", "project", { id })),
    move: vi.fn(
      async (
        id: string,
        scope: "project" | "me",
        version: number,
        target?: string
      ) => ({
        assertion: item("Moved", scope, {
          id,
          projectId: target ?? null,
          classificationVersion: version + 1
        }),
        pending: false
      })
    )
  }) satisfies CuratedMemoryDesktopApi;

describe("What Koed knows identity and ownership", () => {
  let node: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    node.remove();
  });
  const render = async (
    memoryApi: CuratedMemoryDesktopApi,
    overrides: {
      ownerId?: string;
      project?: Project;
      profileKey?: string;
      open?: boolean;
      openRequest?: { id: number; item: CuratedAssertion } | null;
    } = {}
  ) =>
    act(async () =>
      root.render(
        <WhatKoedKnows
          api={memoryApi}
          project={overrides.project ?? project}
          projects={[project, secondProject]}
          ownerId={overrides.ownerId ?? owner}
          profileKey={overrides.profileKey ?? "profile-a"}
          open={overrides.open ?? true}
          openRequest={overrides.openRequest}
          onClose={() => {}}
        />
      )
    );
  it("gates old rows and late detail after a tab switch", async () => {
    const lateDetail = deferred<CuratedAssertion>();
    const me = deferred<CuratedMemoryPage>();
    const projectRow = item("Private Project decision");
    const memoryApi = api(
      async (scope) =>
        scope === "project"
          ? page([projectRow])
          : scope === "me"
            ? me.promise
            : page([]),
      async () => lateDetail.promise
    );
    await render(memoryApi);
    expect(node.textContent).toContain(projectRow.assertionText);
    await act(async () =>
      (node.querySelector(".hq-knows__item") as HTMLButtonElement).click()
    );
    await act(async () =>
      (
        node.querySelector(
          '[role="tab"][aria-selected="false"]'
        ) as HTMLButtonElement
      ).click()
    );
    expect(node.textContent).not.toContain(projectRow.assertionText);
    await act(async () => lateDetail.resolve(projectRow));
    expect(node.querySelector(".hq-knows__origin")).toBeNull();
    await act(async () => me.resolve(page([item("Me preference", "me")])));
    expect(node.textContent).toContain("Me preference");
  });
  it("opens an external Project selection after Me and does not reopen after Back", async () => {
    const projectRow = item("Project learning");
    const meRow = item("Me preference", "me");
    const memoryApi = api(
      async (scope) =>
        page(
          scope === "project" ? [projectRow] : scope === "me" ? [meRow] : []
        ),
      async () => projectRow
    );
    await render(memoryApi);
    await act(async () =>
      (node.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click()
    );
    expect(node.textContent).toContain("Me preference");
    await render(memoryApi, { open: false });
    await render(memoryApi, {
      open: true,
      openRequest: { id: 1, item: projectRow }
    });
    expect(node.querySelector(".hq-knows__origin")).not.toBeNull();
    expect(node.querySelector(".hq-knows h2")?.textContent).toBe(
      "Project learning"
    );
    await act(async () =>
      (node.querySelector(".hq-knows__back") as HTMLButtonElement).click()
    );
    expect(node.querySelector(".hq-knows__origin")).toBeNull();
    await act(async () =>
      (node.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click()
    );
    await act(async () =>
      (node.querySelectorAll('[role="tab"]')[0] as HTMLButtonElement).click()
    );
    expect(node.querySelector(".hq-knows__origin")).toBeNull();
  });
  it("gates private rows on owner, profile, Project and API changes, including ABA", async () => {
    const old = deferred<CuratedMemoryPage>();
    const current = deferred<CuratedMemoryPage>();
    let oldCalls = 0;
    const memoryApi = api(async (scope) =>
      scope === "project"
        ? ++oldCalls === 1
          ? old.promise
          : current.promise
        : page([])
    );
    await render(memoryApi);
    const replacement = api(async () =>
      page([
        item("New identity decision", "project", { projectId: secondProjectId })
      ])
    );
    await render(replacement, {
      ownerId: "00000000-0000-4000-8000-000000000104",
      project: secondProject,
      profileKey: "profile-b"
    });
    expect(node.textContent).not.toContain("Old private decision");
    await render(memoryApi);
    await act(async () => old.resolve(page([item("Old private decision")])));
    expect(node.textContent).not.toContain("Old private decision");
    await act(async () => current.resolve(page([item("Current decision")])));
    expect(node.textContent).toContain("Current decision");
    await render(replacement, {
      ownerId: "00000000-0000-4000-8000-000000000104",
      project: secondProject,
      profileKey: "profile-b"
    });
    expect(node.textContent).not.toContain("Old private decision");
  });
  it.each([
    ["owner", { ownerId: "00000000-0000-4000-8000-000000000104" }],
    ["profile", { profileKey: "profile-b" }],
    ["Project", { project: secondProject }]
  ] as const)(
    "rejects an old %s page after identity changes",
    async (_label, changes) => {
      const old = deferred<CuratedMemoryPage>();
      const next = deferred<CuratedMemoryPage>();
      let calls = 0;
      const memoryApi = api(async (scope) =>
        scope === "project"
          ? ++calls === 1
            ? old.promise
            : next.promise
          : page([])
      );
      await render(memoryApi);
      await render(memoryApi, changes);
      await act(async () => old.resolve(page([item("Old private row")])));
      expect(node.textContent).not.toContain("Old private row");
      await act(async () =>
        next.resolve(
          page([
            item("New private row", "project", {
              projectId: "project" in changes ? changes.project.id : projectId,
              ownerUserId: "ownerId" in changes ? changes.ownerId : owner
            })
          ])
        )
      );
      expect(node.textContent).toContain("New private row");
    }
  );
  it("shows null-kind legacy rows and keeps a colliding Team row read-only", async () => {
    const legacy = item("Legacy note", "unscoped", {
      kind: null,
      authorKind: "agent",
      authorRef: "agent-id"
    });
    const shared = item("Shared decision", "project", {
      visibility: "shared-summary",
      sharedBy: "Mark",
      ownerUserId: owner
    });
    const memoryApi = api(async (scope) =>
      page(
        scope === "project" ? [shared] : scope === "unscoped" ? [legacy] : []
      )
    );
    await render(memoryApi);
    expect(node.textContent).toContain("Shared by Mark");
    expect(node.textContent).toContain("Ask Mark");
    expect(
      node.querySelector('[aria-label="Forget: Shared decision"]')
    ).toBeNull();
    await act(async () =>
      (node.querySelectorAll('[role="tab"]')[2] as HTMLButtonElement).click()
    );
    expect(node.textContent).toContain("Earlier memory");
    expect(node.textContent).toContain("Legacy note");
    expect(node.textContent).toContain("Your agent");
    expect(
      node.querySelector('[aria-label="Move Legacy note to"]')
    ).not.toBeNull();
  });
  it("loads older memory without duplicating rows or trusting a repeated cursor", async () => {
    const first = item("Newest decision");
    const older = item("Older decision", "project", {
      updatedAt: "2026-10-19T08:00:00.000Z"
    });
    const firstCursor = { updatedAt: first.updatedAt, id: first.id };
    const memoryApi = api(async (scope, _projectId, cursor) =>
      scope !== "project"
        ? page([])
        : cursor
          ? page([older])
          : page([first], firstCursor)
    );
    await render(memoryApi);
    expect(node.textContent).toContain("Load more memory");
    await act(async () =>
      (node.querySelector(".hq-knows__load-more") as HTMLButtonElement).click()
    );
    expect(node.textContent).toContain("Older decision");
    expect(node.querySelector(".hq-knows__load-more")).toBeNull();
    expect(memoryApi.page).toHaveBeenCalledWith(
      "project",
      projectId,
      firstCursor
    );
  });
  it("rejects a repeated page cursor without duplicating visible memory", async () => {
    const first = item("Only decision");
    const firstCursor = { updatedAt: first.updatedAt, id: first.id };
    const memoryApi = api(async (scope, _projectId, cursor) =>
      scope !== "project"
        ? page([])
        : cursor
          ? page([first], firstCursor)
          : page([first], firstCursor)
    );
    await render(memoryApi);
    await act(async () =>
      (node.querySelector(".hq-knows__load-more") as HTMLButtonElement).click()
    );
    expect(node.querySelectorAll(".hq-knows__row")).toHaveLength(1);
    expect(node.textContent).toContain("Memory pagination did not advance");
  });
  it("shares only the current generation's three first pages", async () => {
    const row = item("Forget then reload");
    let projectFetches = 0;
    const memoryApi = api(async (scope) => {
      if (scope !== "project") return page([]);
      return page(++projectFetches === 1 ? [row] : []);
    });
    await render(memoryApi);
    expect(projectFetches).toBe(1);
    await act(async () =>
      (
        node.querySelector(
          '[aria-label="Forget: Forget then reload"]'
        ) as HTMLButtonElement
      ).click()
    );
    expect(projectFetches).toBe(2);
    expect(node.textContent).not.toContain("Forget then reload");
  });
});
