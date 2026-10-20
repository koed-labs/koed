// @vitest-environment happy-dom
import { randomUUID } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectsDesktopApi } from "../../../ipc/projects-protocol.js";
import { HqProjectSources } from "./HqProjectSources.js";

const projectId = randomUUID();
const skill = {
  id: randomUUID(),
  projectId,
  kind: "skill" as const,
  name: "code-review",
  uri: null,
  currentRevisionId: null,
  status: "ready" as const,
  failureReason: null,
  addedBy: randomUUID(),
  uses: 0,
  deletedAt: null,
  createdAt: "2026-10-20T00:00:00.000Z"
};
const docSource = {
  ...skill,
  id: randomUUID(),
  kind: "doc" as const,
  name: "Plan.md",
  uses: 12,
  currentRevisionId: randomUUID()
};
const api = (sources = [skill, docSource]) =>
  ({
    sourceList: vi.fn(async () => sources),
    sourceDiscoverRepos: vi.fn(async () => [
      { name: "example.org/team/repo", uri: "example.org/team/repo" }
    ]),
    sourceCreate: vi.fn(async () => skill),
    sourceRemove: vi.fn(async () => ({
      ...skill,
      deletedAt: "2026-10-20T00:00:00.000Z"
    })),
    sourceRetry: vi.fn(async () => skill),
    pickFolder: vi.fn(async () => null)
  }) as unknown as ProjectsDesktopApi;

describe("Project Sources in HQ", () => {
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
  it("shows count, doc key item, skill group and its honest contribution explanation", async () => {
    await act(async () =>
      root.render(
        <HqProjectSources
          projectId={projectId}
          projectName="Atlas"
          api={api()}
        />
      )
    );
    expect(node.textContent).toContain("2 sources");
    expect(
      node.querySelector(".hq-project-sources__key")?.textContent
    ).toContain("Plan.md");
    await act(async () =>
      (
        node.querySelector(
          '[aria-label="Open 2 Project sources"]'
        ) as HTMLButtonElement
      ).click()
    );
    expect(node.textContent).toContain("Skills used here");
    expect(node.textContent).toContain("code-review");
    const rows = [...node.querySelectorAll(".hq-project-sources__row")];
    await act(async () =>
      (
        rows.find((row) =>
          row.textContent?.includes("code-review")
        ) as HTMLButtonElement
      ).click()
    );
    expect(node.textContent).toContain(
      "Listing it does not run the skill or add its outputs to memory"
    );
  });
  it("keeps document action visibly unavailable and links a discovered repo", async () => {
    const client = api([]);
    await act(async () =>
      root.render(
        <HqProjectSources
          projectId={projectId}
          projectName="Atlas"
          api={client}
        />
      )
    );
    await act(async () =>
      (
        node.querySelector(
          '[aria-label="Open 0 Project sources"]'
        ) as HTMLButtonElement
      ).click()
    );
    expect(
      (
        node.querySelector(
          '[title="Document ingestion is not available yet"]'
        ) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    await act(async () =>
      (
        Array.from(node.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Link a repo")
        ) as HTMLButtonElement
      ).click()
    );
    expect(node.textContent).toContain("example.org/team/repo");
    expect(client.sourceDiscoverRepos).toHaveBeenCalledWith(projectId);
  });
  it("discards an old folder choice when profile identity changes on the same Project", async () => {
    let choose!: (folder: string) => void;
    const client = api([]);
    client.pickFolder = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          choose = resolve;
        })
    );
    await act(async () =>
      root.render(
        <HqProjectSources
          projectId={projectId}
          projectName="Atlas"
          api={client}
          visibilityProfileKey="first"
        />
      )
    );
    await act(async () =>
      (
        node.querySelector(
          '[aria-label="Open 0 Project sources"]'
        ) as HTMLButtonElement
      ).click()
    );
    await act(async () => {
      Array.from(node.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Add a folder"))!
        .click();
    });
    await act(async () =>
      root.render(
        <HqProjectSources
          projectId={projectId}
          projectName="Atlas"
          api={client}
          visibilityProfileKey="second"
        />
      )
    );
    await act(async () => choose("/old-profile/private"));
    expect(client.sourceCreate).not.toHaveBeenCalled();
    expect(node.querySelector('[aria-label="Sources"]')).toBeNull();
  });
  it("drops delayed discovery results after a Project switch", async () => {
    let discover!: (repos: { name: string; uri: string }[]) => void;
    const client = api([]);
    client.sourceDiscoverRepos = vi.fn(
      () =>
        new Promise<{ name: string; uri: string }[]>((resolve) => {
          discover = resolve;
        })
    );
    await act(async () =>
      root.render(
        <HqProjectSources
          projectId={projectId}
          projectName="Atlas"
          api={client}
        />
      )
    );
    await act(async () =>
      (
        node.querySelector(
          '[aria-label="Open 0 Project sources"]'
        ) as HTMLButtonElement
      ).click()
    );
    await act(async () => {
      Array.from(node.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Link a repo"))!
        .click();
    });
    await act(async () =>
      root.render(
        <HqProjectSources
          projectId={randomUUID()}
          projectName="Other"
          api={client}
        />
      )
    );
    await act(async () =>
      discover([{ name: "private", uri: "example.org/private/repo" }])
    );
    expect(node.textContent).not.toContain("private");
    expect(node.querySelector('[aria-label="Sources"]')).toBeNull();
  });
  it("ignores a completed old removal after a Project switch", async () => {
    let remove!: (source: typeof skill) => void;
    const client = api([skill]);
    client.sourceRemove = vi.fn(
      () =>
        new Promise<typeof skill>((resolve) => {
          remove = resolve;
        })
    );
    await act(async () =>
      root.render(
        <HqProjectSources
          projectId={projectId}
          projectName="Atlas"
          api={client}
        />
      )
    );
    await act(async () =>
      (
        node.querySelector(
          '[aria-label="Open 1 Project sources"]'
        ) as HTMLButtonElement
      ).click()
    );
    await act(async () =>
      (
        node.querySelector(".hq-project-sources__row") as HTMLButtonElement
      ).click()
    );
    await act(async () => {
      Array.from(node.querySelectorAll("button"))
        .find((button) => button.textContent === "Remove")!
        .click();
    });
    const nextProjectId = randomUUID();
    await act(async () =>
      root.render(
        <HqProjectSources
          projectId={nextProjectId}
          projectName="Other"
          api={api([])}
        />
      )
    );
    await act(async () => remove(skill));
    expect(node.textContent).toContain("0 sources");
    expect(node.textContent).not.toContain("code-review");
    expect(client.sourceList).toHaveBeenCalledTimes(1);
  });
});
