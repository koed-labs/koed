// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@koed/shared/project-contract";
import type { ProjectsDesktopApi } from "../../ipc/projects-protocol.js";
import { ProjectsStore } from "./useProjects.js";
import { useProjectMenuActions } from "./useProjectMenuActions.js";

const id = "123e4567-e89b-42d3-a456-426614174000";
const now = "2026-10-20T00:00:00.000Z";
const active: Project = {
  id,
  name: "koed-mobile",
  key: "MOBILE",
  folderPath: null,
  lifecycle: "active",
  deletionPhase: null,
  deleteBatchId: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
  version: 1
};
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("Personal Project actions", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container?.remove();
    root = null;
    container = null;
  });
  it("uses a real completed batch before Undo and restores the same Project", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    let current = active;
    const batch = { value: "" };
    const status = (deleted: Project) => ({
      project: deleted,
      operation: { batchId: batch.value, state: "complete" as const },
      complete: true,
      retryable: false,
      pendingFreezeCount: 0,
      pendingExecutionCount: 0,
      pendingReviews: [],
      cancellationPending: false
    });
    const api: ProjectsDesktopApi = {
      sourceList: vi.fn(async () => []),
      sourceDiscoverRepos: vi.fn(async () => []),
      sourceCreate: vi.fn(),
      sourceRemove: vi.fn(),
      sourceRetry: vi.fn(),
      list: vi.fn(async () =>
        current.lifecycle === "active" ? [current] : []
      ),
      pickFolder: vi.fn(),
      hq: vi.fn(),
      create: vi.fn(),
      deletePreview: vi.fn(async () => ({
        project: current,
        executionSetHash: "b".repeat(64),
        activeExecutions: []
      })),
      delete: vi.fn(async (_id, value) => {
        batch.value = value.batchId;
        current = {
          ...current,
          lifecycle: "deleted",
          deletionPhase: "complete",
          deleteBatchId: batch.value,
          deletedAt: now,
          version: 2
        };
        return status(current);
      }),
      deleteProgress: vi.fn(),
      deleteStatus: vi.fn(async () =>
        current.lifecycle === "deleted"
          ? status(current)
          : {
              ...status(current),
              operation: {
                batchId: batch.value,
                state: "restore_releasing" as const
              },
              complete: false,
              cancellationPending: true
            }
      ),
      deleteCancel: vi.fn(),
      restore: vi.fn(async () => {
        current = { ...active, version: 3 };
        return current;
      }),
      restoreReconcile: vi
        .fn()
        .mockImplementationOnce(async () => ({
          project: current,
          released: false
        }))
        .mockImplementationOnce(async () => ({
          project: current,
          released: true
        }))
    };
    const store = new ProjectsStore(api);
    store.setOwner("owner", "profile");
    await vi.waitFor(() => expect(store.current().loaded).toBe(true));
    function Harness() {
      const actions = useProjectMenuActions({
        api,
        store,
        ownerId: "owner",
        profileKey: "profile",
        onOpenProject: vi.fn()
      });
      return (
        <>
          <button onClick={() => actions.openDelete(id)}>
            Open menu delete
          </button>
          {actions.ui}
        </>
      );
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));
    await act(async () =>
      container!.querySelector<HTMLButtonElement>("button")!.click()
    );
    await flush();
    expect(container.textContent).toContain("Delete koed-mobile?");
    expect(container.textContent).toContain("Koed keeps what it learned.");
    expect(container.textContent).not.toContain("Undo");
    const confirm = [
      ...container.querySelectorAll<HTMLButtonElement>("button")
    ].find((button) => button.textContent === "Delete project")!;
    await act(async () => confirm.click());
    await flush();
    expect(api.delete).toHaveBeenCalledOnce();
    expect(store.current().projects).toEqual([]);
    const undo = [
      ...container.querySelectorAll<HTMLButtonElement>("button")
    ].find((button) => button.textContent === "Undo");
    expect(undo).toBeDefined();
    await act(async () => undo!.click());
    await flush();
    expect(api.restore).toHaveBeenCalledWith(id, {
      version: 2,
      batchId: batch.value
    });
    expect(container.textContent).toContain("Restore is finishing");
    const checkRestore = [
      ...container.querySelectorAll<HTMLButtonElement>("button")
    ].find((button) => button.textContent === "Check restore")!;
    await act(async () => checkRestore.click());
    await flush();
    expect(api.restore).toHaveBeenCalledTimes(1);
    expect(store.current().projects).toEqual([current]);
  });

  it("keeps one creation idempotency key across an uncertain response", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const created = { ...active, name: "New work" };
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce(created);
    const api = {
      sourceList: vi.fn(async () => []),
      sourceDiscoverRepos: vi.fn(async () => []),
      sourceCreate: vi.fn(),
      sourceRemove: vi.fn(),
      sourceRetry: vi.fn(),
      list: vi.fn(async () => []),
      hq: vi.fn(),
      create,
      pickFolder: vi.fn(),
      deletePreview: vi.fn(),
      delete: vi.fn(),
      deleteProgress: vi.fn(),
      deleteStatus: vi.fn(),
      deleteCancel: vi.fn(),
      restore: vi.fn(),
      restoreReconcile: vi.fn()
    } as ProjectsDesktopApi;
    const store = new ProjectsStore(api);
    store.setOwner("owner", "profile");
    await vi.waitFor(() => expect(store.current().loaded).toBe(true));
    const opened = vi.fn();
    function Harness() {
      const actions = useProjectMenuActions({
        api,
        store,
        ownerId: "owner",
        profileKey: "profile",
        onOpenProject: opened
      });
      return (
        <>
          <button onClick={actions.openCreate}>New project</button>
          {actions.ui}
        </>
      );
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));
    await act(async () =>
      container!.querySelector<HTMLButtonElement>("button")!.click()
    );
    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!;
      setter.call(input, "New work");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = () =>
      [...container!.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Create project"
      )!;
    await act(async () => submit().click());
    await flush();
    expect(container.textContent).toContain("Retry uses the same request");
    expect(input.disabled).toBe(true);
    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Choose folder…"
      )?.disabled
    ).toBe(true);
    await act(async () => submit().click());
    await flush();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]![0]).toEqual(create.mock.calls[1]![0]);
    expect(opened).toHaveBeenCalledWith(id);
  });

  it("reconciles an uncertain submitted delete before showing Undo or retrying", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    let batchId = "";
    const deleted: Project = {
      ...active,
      lifecycle: "deleted",
      deletionPhase: "complete",
      deletedAt: now,
      version: 2
    };
    const pending = () => ({
      project: {
        ...active,
        deletionPhase: "preparing" as const,
        deleteBatchId: batchId,
        version: 2
      },
      operation: { batchId, state: "preparing" as const },
      complete: false,
      retryable: false,
      pendingFreezeCount: 1,
      pendingExecutionCount: 0,
      pendingReviews: [],
      cancellationPending: false
    });
    const complete = () => ({
      ...pending(),
      project: { ...deleted, deleteBatchId: batchId },
      operation: { batchId, state: "complete" as const },
      complete: true,
      pendingFreezeCount: 0
    });
    const deleteCall = vi.fn(
      async (_id: string, value: { batchId: string }) => {
        batchId = value.batchId;
        throw new Error("response lost");
      }
    );
    const deleteStatus = vi
      .fn()
      .mockImplementationOnce(async () => pending())
      .mockImplementationOnce(async () => complete());
    const api = {
      list: vi.fn(async () => [active]),
      pickFolder: vi.fn(),
      hq: vi.fn(),
      create: vi.fn(),
      deletePreview: vi.fn(async () => ({
        project: active,
        executionSetHash: "b".repeat(64),
        activeExecutions: []
      })),
      delete: deleteCall,
      deleteStatus,
      deleteProgress: vi.fn(),
      deleteCancel: vi.fn(),
      restore: vi.fn(),
      restoreReconcile: vi.fn()
    } as unknown as ProjectsDesktopApi;
    const store = new ProjectsStore(api);
    store.setOwner("owner", "profile");
    await vi.waitFor(() => expect(store.current().loaded).toBe(true));
    function Harness() {
      const actions = useProjectMenuActions({
        api,
        store,
        ownerId: "owner",
        profileKey: "profile",
        onOpenProject: vi.fn()
      });
      return (
        <>
          <button onClick={() => actions.openDelete(id)}>Delete</button>
          {actions.ui}
        </>
      );
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));
    await act(async () =>
      container!.querySelector<HTMLButtonElement>("button")!.click()
    );
    await flush();
    const confirm = [
      ...container.querySelectorAll<HTMLButtonElement>("button")
    ].find((button) => button.textContent === "Delete project")!;
    await act(async () => confirm.click());
    await flush();
    expect(deleteCall).toHaveBeenCalledOnce();
    expect(deleteStatus).toHaveBeenCalledWith(id, batchId);
    expect(container.textContent).not.toContain("Undo");
    const check = [
      ...container.querySelectorAll<HTMLButtonElement>("button")
    ].find((button) => button.textContent === "Check status")!;
    await act(async () => check.click());
    await flush();
    expect(deleteCall).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Undo");
  });

  it("does not submit deletion when confirmation preview cannot be refreshed", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const preview = {
      project: active,
      executionSetHash: "b".repeat(64),
      activeExecutions: []
    };
    const api = {
      list: vi.fn(async () => [active]),
      pickFolder: vi.fn(),
      hq: vi.fn(),
      create: vi.fn(),
      deletePreview: vi
        .fn()
        .mockResolvedValueOnce(preview)
        .mockRejectedValueOnce(new Error("offline")),
      delete: vi.fn(),
      deleteProgress: vi.fn(),
      deleteStatus: vi.fn(),
      deleteCancel: vi.fn(),
      restore: vi.fn(),
      restoreReconcile: vi.fn()
    } as unknown as ProjectsDesktopApi;
    const store = new ProjectsStore(api);
    store.setOwner("owner", "profile");
    await vi.waitFor(() => expect(store.current().loaded).toBe(true));
    function Harness() {
      const actions = useProjectMenuActions({
        api,
        store,
        ownerId: "owner",
        profileKey: "profile",
        onOpenProject: vi.fn()
      });
      return (
        <>
          <button onClick={() => actions.openDelete(id)}>Delete</button>
          {actions.ui}
        </>
      );
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));
    await act(async () =>
      container!.querySelector<HTMLButtonElement>("button")!.click()
    );
    await flush();
    const confirm = [
      ...container.querySelectorAll<HTMLButtonElement>("button")
    ].find((button) => button.textContent === "Delete project")!;
    await act(async () => confirm.click());
    await flush();
    expect(container.textContent).toContain(
      "Project details could not be verified"
    );
    expect(api.delete).not.toHaveBeenCalled();
    expect(api.deleteStatus).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Undo");
  });

  it("drops a folder result from a previous profile after the owner context switches", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    let resolveFolder!: (path: string) => void;
    const picked = new Promise<string>((resolve) => {
      resolveFolder = resolve;
    });
    const api = {
      list: vi.fn(async () => []),
      pickFolder: vi.fn().mockReturnValueOnce(picked),
      hq: vi.fn(),
      create: vi.fn(),
      deletePreview: vi.fn(),
      delete: vi.fn(),
      deleteProgress: vi.fn(),
      deleteStatus: vi.fn(),
      deleteCancel: vi.fn(),
      restore: vi.fn(),
      restoreReconcile: vi.fn()
    } as unknown as ProjectsDesktopApi;
    const store = new ProjectsStore(api);
    store.setOwner("owner", "profile-a");
    await vi.waitFor(() => expect(store.current().loaded).toBe(true));
    function Harness({ profileKey }: { profileKey: string }) {
      const actions = useProjectMenuActions({
        api,
        store,
        ownerId: "owner",
        profileKey,
        onOpenProject: vi.fn()
      });
      return (
        <>
          <button onClick={actions.openCreate}>New project</button>
          {actions.ui}
        </>
      );
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<Harness profileKey="profile-a" />));
    await act(async () =>
      container!.querySelector<HTMLButtonElement>("button")!.click()
    );
    const choose = [
      ...container.querySelectorAll<HTMLButtonElement>("button")
    ].find((button) => button.textContent === "Choose folder…")!;
    await act(async () => choose.click());
    store.setOwner("owner", "profile-b");
    await act(async () => root!.render(<Harness profileKey="profile-b" />));
    await vi.waitFor(() => expect(store.current().loaded).toBe(true));
    await act(async () =>
      container!.querySelector<HTMLButtonElement>("button")!.click()
    );
    await act(async () => resolveFolder("/old-profile/private"));
    expect(container.textContent).toContain(
      "No folder. Chats and memory only."
    );
    expect(container.textContent).not.toContain("/old-profile/private");
  });

  it("advances the bound pending delete batch after an approval", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    let batchId = "";
    let current = active;
    const pending = () => ({
      project: {
        ...active,
        deletionPhase: "freezing" as const,
        deleteBatchId: batchId,
        version: 2
      },
      operation: { batchId, state: "freezing" as const },
      complete: false,
      retryable: true,
      pendingFreezeCount: 1,
      pendingExecutionCount: 0,
      pendingReviews: [
        { backendId: "team", shareGrantId: id, actionGrantId: id }
      ],
      cancellationPending: false
    });
    const complete = () => ({
      ...pending(),
      project: current,
      operation: { batchId, state: "complete" as const },
      complete: true,
      retryable: false,
      pendingFreezeCount: 0,
      pendingReviews: []
    });
    const progress = vi.fn(async (_id: string, suppliedBatch: string) => {
      expect(suppliedBatch).toBe(batchId);
      current = {
        ...active,
        lifecycle: "deleted",
        deletionPhase: "complete",
        deletedAt: now,
        deleteBatchId: batchId,
        version: 3
      };
      return complete();
    });
    const api = {
      list: vi.fn(async () =>
        current.lifecycle === "active" ? [current] : []
      ),
      pickFolder: vi.fn(),
      hq: vi.fn(),
      create: vi.fn(),
      deletePreview: vi.fn(async () => ({
        project: active,
        executionSetHash: "b".repeat(64),
        activeExecutions: []
      })),
      delete: vi.fn(async (_id: string, value: { batchId: string }) => {
        batchId = value.batchId;
        return pending();
      }),
      deleteProgress: progress,
      deleteStatus: vi.fn(),
      deleteCancel: vi.fn(),
      restore: vi.fn(),
      restoreReconcile: vi.fn()
    } as unknown as ProjectsDesktopApi;
    const store = new ProjectsStore(api);
    store.setOwner("owner", "profile");
    await vi.waitFor(() => expect(store.current().loaded).toBe(true));
    function Harness() {
      const actions = useProjectMenuActions({
        api,
        store,
        ownerId: "owner",
        profileKey: "profile",
        onOpenProject: vi.fn()
      });
      return (
        <>
          <button onClick={() => actions.openDelete(id)}>Open delete</button>
          {actions.ui}
        </>
      );
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));
    await act(async () =>
      container!.querySelector<HTMLButtonElement>("button")!.click()
    );
    await flush();
    await act(async () =>
      [...container!.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Delete project")!
        .click()
    );
    await flush();
    expect(container.textContent).toContain("waiting for approval");
    expect(progress).not.toHaveBeenCalled();
    await act(async () =>
      [...container!.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Check approval")!
        .click()
    );
    await flush();
    expect(progress).toHaveBeenCalledExactlyOnceWith(id, batchId);
    expect(container.textContent).toContain("Undo");
    expect(store.current().projects).toEqual([]);
  });

  it("retries cancellation of the same batch until release is confirmed", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    let batchId = "";
    const pending = () => ({
      project: {
        ...active,
        deletionPhase: "preparing" as const,
        deleteBatchId: batchId,
        version: 2
      },
      operation: { batchId, state: "preparing" as const },
      complete: false,
      retryable: false,
      pendingFreezeCount: 1,
      pendingExecutionCount: 0,
      pendingReviews: [],
      cancellationPending: false
    });
    const cancel = vi
      .fn()
      .mockImplementationOnce(async (_id: string, suppliedBatch: string) => {
        expect(suppliedBatch).toBe(batchId);
        return {
          ...pending(),
          operation: { batchId, state: "cancelled" as const },
          cancellationPending: true
        };
      })
      .mockImplementationOnce(async (_id: string, suppliedBatch: string) => {
        expect(suppliedBatch).toBe(batchId);
        return {
          ...pending(),
          operation: { batchId, state: "cancelled" as const },
          cancellationPending: false
        };
      });
    const api = {
      list: vi.fn(async () => [active]),
      pickFolder: vi.fn(),
      hq: vi.fn(),
      create: vi.fn(),
      deletePreview: vi.fn(async () => ({
        project: active,
        executionSetHash: "b".repeat(64),
        activeExecutions: []
      })),
      delete: vi.fn(async (_id: string, value: { batchId: string }) => {
        batchId = value.batchId;
        return pending();
      }),
      deleteProgress: vi.fn(),
      deleteStatus: vi.fn(),
      deleteCancel: cancel,
      restore: vi.fn(),
      restoreReconcile: vi.fn()
    } as unknown as ProjectsDesktopApi;
    const store = new ProjectsStore(api);
    store.setOwner("owner", "profile");
    await vi.waitFor(() => expect(store.current().loaded).toBe(true));
    function Harness() {
      const actions = useProjectMenuActions({
        api,
        store,
        ownerId: "owner",
        profileKey: "profile",
        onOpenProject: vi.fn()
      });
      return (
        <>
          <button onClick={() => actions.openDelete(id)}>Open delete</button>
          {actions.ui}
        </>
      );
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));
    await act(async () =>
      container!.querySelector<HTMLButtonElement>("button")!.click()
    );
    await flush();
    await act(async () =>
      [...container!.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Delete project")!
        .click()
    );
    await flush();
    await act(async () =>
      [...container!.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Cancel")!
        .click()
    );
    await flush();
    expect(container.textContent).toContain("Cancellation is finishing");
    expect(container.textContent).toContain("Check cancellation");
    expect(container.textContent).not.toContain("Undo");
    await act(async () =>
      [...container!.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Check cancellation")!
        .click()
    );
    await flush();
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(cancel.mock.calls[0]).toEqual(cancel.mock.calls[1]);
    expect(container.textContent).not.toContain("Delete koed-mobile?");
    expect(store.current().projects).toEqual([active]);
  });
});
