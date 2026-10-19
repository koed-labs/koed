// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import type { ProjectSelectionCommandResult } from "@koed/shared/project-selection";
import { ProjectAssociationPanel } from "./ProjectAssociationPanel.js";
const localProjectId = `lp_${"a".repeat(32)}`;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
const accepted = {
  groupId: "group",
  associationId: "association",
  selectionId: "selection"
};
const fixture = (conflict = true): ProjectSelectionCommandResult => ({
  groupId: "group",
  checkoutId: "checkout",
  defaultRemote: "origin",
  deviceLabels: {},
  remotes: [
    {
      name: "origin",
      fingerprint: "gr_project",
      display: "example.test/team/project"
    }
  ],
  accepted,
  associations: [
    {
      associationId: "association",
      selectionId: "selection",
      state: {
        state: conflict ? "conflict" : "deleted",
        heads: conflict ? ["rA", "rB"] : ["rDeleted"],
        revisions: conflict
          ? [
              {
                revisionId: "rA",
                authorDeviceId: "deviceA",
                replaces: [],
                operation: { kind: "set", anchorFingerprint: "gr_project" }
              },
              {
                revisionId: "rB",
                authorDeviceId: "deviceB",
                replaces: [],
                operation: { kind: "delete" }
              }
            ]
          : [
              {
                revisionId: "rDeleted",
                authorDeviceId: "deviceA",
                replaces: [],
                operation: { kind: "delete" }
              }
            ]
      }
    }
  ]
});
const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((entry) =>
    entry.textContent?.startsWith(text)
  )!;

it("reviews set/delete heads, rejects stale resolution, and requires another explicit choice", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const changed = fixture();
  changed.associations[0]!.state.heads.push("rC");
  changed.associations[0]!.state.revisions.push({
    revisionId: "rC",
    authorDeviceId: "deviceC",
    replaces: [],
    operation: { kind: "set", anchorFingerprint: "gr_other" }
  });
  const onAssociation = vi
    .fn()
    .mockResolvedValueOnce(fixture())
    .mockRejectedValueOnce(new Error("Project selection changed; review again"))
    .mockResolvedValueOnce(changed)
    .mockResolvedValue(fixture(false));
  try {
    await act(async () =>
      root.render(
        <ProjectAssociationPanel
          localProjectId={localProjectId}
          onAssociation={onAssociation}
        />
      )
    );
    expect(container.textContent).toContain("changes conflict");
    expect(container.textContent).toContain("Remove shared choice");
    await act(async () => button(container, "Resolve").click());
    expect(onAssociation.mock.calls[1]?.[0]).toEqual({
      operation: "set",
      localProjectId,
      expectedCheckoutId: "checkout",
      ...accepted,
      remoteName: "origin",
      reviewedHeads: ["rA", "rB"]
    });
    expect(onAssociation.mock.calls).toHaveLength(3); // Refresh, never a retry with new heads.
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "changed"
    );
    expect(container.textContent).toContain("deviceC");
    await act(async () =>
      button(container, "Resolve by removing shared choice").click()
    );
    expect(onAssociation.mock.calls[3]?.[0]).toMatchObject({
      remoteName: null,
      reviewedHeads: ["rA", "rB", "rC"]
    });
    expect(container.textContent).toContain("Share again");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("keeps deletion recreation and local forgetting distinct", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onAssociation = vi.fn().mockResolvedValue(fixture(false));
  try {
    await act(async () =>
      root.render(
        <ProjectAssociationPanel
          localProjectId={localProjectId}
          onAssociation={onAssociation}
        />
      )
    );
    await act(async () => button(container, "Share again").click());
    expect(onAssociation).toHaveBeenLastCalledWith({
      operation: "set",
      localProjectId,
      expectedCheckoutId: "checkout",
      ...accepted,
      remoteName: "origin",
      reviewedHeads: ["rDeleted"]
    });
    await act(async () => button(container, "Unlink this folder").click());
    expect(onAssociation).toHaveBeenLastCalledWith({
      operation: "forget",
      localProjectId,
      expectedCheckoutId: "checkout"
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("requires acceptance instead of silently linking an equal anchor", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const offered = fixture();
  offered.accepted = null;
  const onAssociation = vi.fn().mockResolvedValue(offered);
  try {
    await act(async () =>
      root.render(
        <ProjectAssociationPanel
          localProjectId={localProjectId}
          onAssociation={onAssociation}
        />
      )
    );
    expect(onAssociation).toHaveBeenCalledTimes(1);
    expect(button(container, "Link folder").disabled).toBe(true);
    const select = container.querySelector<HTMLSelectElement>(
      '[aria-label="Available shared choice"]'
    )!;
    await act(async () => {
      select.value = "association";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button(container, "Link folder").click());
    expect(onAssociation).toHaveBeenLastCalledWith({
      operation: "accept",
      localProjectId,
      expectedCheckoutId: "checkout",
      ...accepted
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("separates new sharing from linking and uses the inspected default remote", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const offered = fixture();
  offered.accepted = null;
  offered.remotes.push({
    name: "upstream",
    fingerprint: "gr_other",
    display: "example.test/team/other"
  });
  offered.defaultRemote = "upstream";
  const linked = { ...offered, accepted };
  linked.associations[0]!.state = {
    ...linked.associations[0]!.state,
    state: "selected",
    heads: ["rA"],
    anchorFingerprint: "gr_project"
  };
  const onAssociation = vi
    .fn()
    .mockResolvedValueOnce(offered)
    .mockResolvedValue(linked);
  try {
    await act(async () =>
      root.render(
        <ProjectAssociationPanel
          localProjectId={localProjectId}
          onAssociation={onAssociation}
        />
      )
    );
    expect(
      container.querySelector('[aria-label="Repository remote"]')
    ).toBeNull();
    expect(button(container, "Link folder").disabled).toBe(true);
    await act(async () => button(container, "Share new").click());
    expect(
      container.querySelector('[aria-label="Available shared choice"]')
    ).toBeNull();
    expect(
      container.querySelector<HTMLSelectElement>(
        '[aria-label="Repository remote"]'
      )!.value
    ).toBe("upstream");
    await act(async () => button(container, "Share and link").click());
    expect(onAssociation).toHaveBeenLastCalledWith({
      operation: "create",
      localProjectId,
      expectedCheckoutId: "checkout",
      remoteName: "upstream"
    });
    expect(container.textContent).toContain(
      "Updates apply to all linked folders."
    );
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps shared edits unavailable while history is incomplete", async () => {
  const container = document.createElement("div"),
    root = createRoot(container);
  const incomplete = fixture();
  incomplete.associations[0]!.state.state = "incomplete";
  const onAssociation = vi.fn().mockResolvedValue(incomplete);
  try {
    await act(async () =>
      root.render(
        <ProjectAssociationPanel
          localProjectId={localProjectId}
          onAssociation={onAssociation}
        />
      )
    );
    expect(button(container, "Save changes").disabled).toBe(true);
    expect(button(container, "Remove shared choice").disabled).toBe(true);
    expect(button(container, "Unlink this folder").disabled).toBe(false);
    expect(onAssociation).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});
