// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { DesktopProject } from "../../../project-memory-ui.js";
import { RepositoryAnchorPanel } from "./RepositoryAnchorPanel.js";

it("shows unresolved identity and sends checkout-bound edits and reset while surfacing stale errors", async () => {
  const project: DesktopProject = {
    id: "project",
    name: "Example",
    path: "/checkout",
    eventCount: 0,
    threads: [],
    catalogued: true,
    discoveredAt: null,
    lastSeenAt: null,
    localProjectId: `lp_${"1".repeat(32)}`,
    branch: "main",
    remoteDisplay: null,
    isWorktree: false,
    repository: {
      kind: "unresolved",
      key: null,
      root: "/checkout",
      branch: "main",
      reason: "selection_missing",
      checkoutId: "checkout_one",
      originatingDeviceId: "device_one",
      selectedRemote: "missing",
      anchorDisplay: null
    }
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onSetAnchor = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(
      new Error("Checkout changed. Inspect the Project again.")
    );
  try {
    await act(async () =>
      root.render(
        <RepositoryAnchorPanel project={project} onSetAnchor={onSetAnchor} />
      )
    );
    expect(container.textContent).toContain("Unresolved");
    expect(container.textContent).toContain("selection missing");
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    );
    expect(onSetAnchor).toHaveBeenLastCalledWith({
      localProjectId: project.localProjectId,
      expectedCheckoutId: "checkout_one",
      remoteName: "missing"
    });
    const reset = [...container.querySelectorAll("button")].find(
      (element) => element.textContent === "Use automatic selection"
    )!;
    await act(async () => reset.click());
    expect(onSetAnchor).toHaveBeenLastCalledWith({
      localProjectId: project.localProjectId,
      expectedCheckoutId: "checkout_one",
      remoteName: null
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Checkout changed"
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("inspects and edits the selected checkout in a shared repository group", async () => {
  const repository = {
    kind: "portable_repository" as const,
    key: "github.com/example/repo",
    root: "/first",
    branch: "main",
    reason: "origin" as const,
    checkoutId: "checkout_one",
    originatingDeviceId: "device_one",
    selectedRemote: "origin",
    anchorDisplay: "example/repo"
  };
  const project: DesktopProject = {
    id: "repository-group",
    catalogued: true,
    discoveredAt: null,
    lastSeenAt: null,
    branch: "main",
    remoteDisplay: null,
    isWorktree: false,
    name: "Example",
    path: "/first",
    eventCount: 0,
    threads: [],
    localProjectId: "local_one",
    repository,
    checkouts: [
      { localProjectId: "local_one", path: "/first", repository },
      {
        localProjectId: "local_two",
        path: "/second",
        repository: {
          ...repository,
          root: "/second",
          branch: "feature",
          checkoutId: "checkout_two",
          selectedRemote: "upstream"
        }
      }
    ]
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  const onSetAnchor = vi.fn().mockResolvedValue(undefined);
  try {
    await act(async () =>
      root.render(
        <RepositoryAnchorPanel project={project} onSetAnchor={onSetAnchor} />
      )
    );
    const select = container.querySelector<HTMLSelectElement>(
      '[aria-label="Repository checkout"]'
    )!;
    await act(async () => {
      select.value = "local_two";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("feature");
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="Selected repository remote"]'
      )!.value
    ).toBe("upstream");
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    );
    expect(onSetAnchor).toHaveBeenCalledWith({
      localProjectId: "local_two",
      expectedCheckoutId: "checkout_two",
      remoteName: "upstream"
    });
  } finally {
    await act(async () => root.unmount());
  }
});
