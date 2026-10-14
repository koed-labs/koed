// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ProjectSelectionCommandResult } from "@koed/shared/project-selection";
import { ProjectAssociationPanel } from "./ProjectAssociationPanel.js";
const localProjectId = `lp_${"a".repeat(32)}`;
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
  [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === text
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
    await act(async () =>
      button(container, "Refresh shared selections").click()
    );
    expect(container.textContent).toContain("Concurrent changes");
    expect(container.textContent).toContain("Remove shared selection");
    await act(async () =>
      button(container, "Resolve with chosen anchor").click()
    );
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
      button(container, "Resolve by removing shared selection").click()
    );
    expect(onAssociation.mock.calls[3]?.[0]).toMatchObject({
      remoteName: null,
      reviewedHeads: ["rA", "rB", "rC"]
    });
    expect(container.textContent).toContain("Re-create shared selection");
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
    await act(async () =>
      button(container, "Refresh shared selections").click()
    );
    await act(async () =>
      button(container, "Re-create shared selection").click()
    );
    expect(onAssociation).toHaveBeenLastCalledWith({
      operation: "set",
      localProjectId,
      expectedCheckoutId: "checkout",
      ...accepted,
      remoteName: "origin",
      reviewedHeads: ["rDeleted"]
    });
    await act(async () =>
      button(container, "Forget association on this checkout").click()
    );
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
    await act(async () =>
      button(container, "Refresh shared selections").click()
    );
    expect(onAssociation).toHaveBeenCalledTimes(1);
    expect(
      button(container, "Accept association for this checkout").disabled
    ).toBe(true);
    const select = container.querySelector<HTMLSelectElement>(
      '[aria-label="Available Project association"]'
    )!;
    await act(async () => {
      select.value = "association";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      button(container, "Accept association for this checkout").click()
    );
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
