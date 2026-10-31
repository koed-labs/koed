// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type {
  CliInstallApi,
  CliInstallProgressEnvelope,
  PrivacyInstallStatus
} from "../../../cli-install/protocol.js";
import { CliInstallSettingsSection } from "./CliInstallSettingsSection.js";
import { getInstallSetupStore } from "./install-setup-store.js";
function fixture() {
  let listener: (event: CliInstallProgressEnvelope) => void = () => {};
  let installed = false;
  let pathAdded = false;
  const owned = {
    ownership: "koed" as const,
    target: "valid" as const,
    helper: "supported" as const,
    version: "0.9.2",
    template: "current" as const,
    pathVisible: false,
    fingerprint: "owned"
  };
  const api: CliInstallApi = {
    getStatus: vi.fn(async () => ({
      available: true,
      state: "not_installed" as const,
      message: "Not installed"
    })),
    installPrivacy: vi.fn(async () => ({
      available: true,
      state: "ready" as const,
      message: "Ready"
    })),
    cancel: vi.fn(async () => {}),
    selectOffline: vi.fn(async () => null),
    launcher: vi.fn(async (operation) => {
      if (operation === "install") installed = true;
      if (operation === "remove") installed = false;
      return installed
        ? { ...owned, pathConfigured: pathAdded }
        : { ...owned, ownership: "absent" as const };
    }),
    updatePath: vi.fn(async (operation) => {
      pathAdded = operation === "add";
    }),
    subscribe: vi.fn((callback) => {
      listener = callback;
      return () => {};
    })
  };
  return {
    api,
    owned,
    emit: (event: Partial<CliInstallProgressEnvelope>) =>
      listener({
        requestId: "test",
        stage: "download",
        message: "Downloading",
        completedBytes: null,
        totalBytes: null,
        ...event
      })
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe("General setup flows", () => {
  it("refreshes Privacy and launcher status after returning to Preferences and reopening a dialog", async () => {
    const { api, owned } = fixture();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const openPrivacy = () =>
      act(async () => {
        host
          .querySelector<HTMLElement>(
            '[aria-label="Privacy Filter: Set up or manage"]'
          )!
          .click();
      });
    try {
      await act(async () =>
        root.render(<CliInstallSettingsSection api={api} />)
      );
      expect(host.textContent).toContain("Set up");
      await act(async () => root.render(null));
      vi.mocked(api.getStatus).mockResolvedValue({
        available: true,
        state: "ready",
        message: "Filtering is healthy"
      });
      vi.mocked(api.launcher).mockResolvedValue({
        ...owned,
        pathVisible: true
      });
      await act(async () =>
        root.render(<CliInstallSettingsSection api={api} />)
      );
      expect(host.querySelectorAll(".koed-general-action")).toHaveLength(2);
      expect(
        [...host.querySelectorAll(".koed-general-action")].every(
          (button) => button.textContent === "Manage"
        )
      ).toBe(true);
      await openPrivacy();
      expect(document.body.textContent).toContain("Privacy Filter is ready");
      await act(async () =>
        document.body
          .querySelector<HTMLElement>('[role="dialog"] [aria-label="Close"]')!
          .click()
      );
      vi.mocked(api.getStatus).mockResolvedValue({
        available: true,
        state: "failed",
        message: "Filtering service stopped"
      });
      await openPrivacy();
      const dialog = document.body.querySelector('[role="dialog"]')!;
      expect(dialog.textContent).toContain("Filtering service stopped");
      expect(
        [...dialog.querySelectorAll("button")].some(
          (button) => button.textContent === "Retry download"
        )
      ).toBe(true);
      expect(api.installPrivacy).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each([false, true])(
    "ignores a late Privacy status response after installation (rejected: %s)",
    async (rejected) => {
      const { api } = fixture();
      const store = getInstallSetupStore(api);
      await store.refresh();
      const stale = deferred<PrivacyInstallStatus>();
      vi.mocked(api.getStatus).mockReturnValueOnce(stale.promise);
      const refreshing = store.refresh();
      await store.installPrivacy();
      if (rejected) stale.reject(new Error("Old status failed"));
      else
        stale.resolve({
          available: true,
          state: "not_installed",
          message: "Old missing assets"
        });
      await refreshing;
      expect(store.snapshot().privacy).toMatchObject({
        stage: "ready",
        running: false,
        checking: false,
        unavailable: false
      });
      expect(store.snapshot().privacyStatus?.state).toBe("ready");
    }
  );

  it("preserves active progress during refresh and ignores stale launcher status after install and removal", async () => {
    const { api, owned, emit } = fixture();
    const store = getInstallSetupStore(api);
    await store.refresh();
    const installing = deferred<PrivacyInstallStatus>();
    vi.mocked(api.installPrivacy).mockReturnValueOnce(installing.promise);
    const installation = store.installPrivacy();
    emit({ completedBytes: 46, totalBytes: 100 });
    const reads = vi.mocked(api.getStatus).mock.calls.length;
    await store.refresh();
    expect(api.getStatus).toHaveBeenCalledTimes(reads);
    expect(store.snapshot().privacy).toMatchObject({
      stage: "progress",
      running: true,
      percent: 46
    });
    installing.resolve({ available: true, state: "ready", message: "Ready" });
    await installation;

    for (const operation of ["install", "remove"] as const) {
      const stale = deferred<typeof owned>();
      vi.mocked(api.launcher).mockReturnValueOnce(stale.promise);
      const refreshing = store.refresh();
      if (operation === "install") await store.installCli();
      else await store.removeCli();
      stale.resolve(owned);
      await refreshing;
      expect(store.snapshot().cli).toMatchObject({
        stage: operation === "install" ? "ready" : "idle",
        checking: false,
        running: false
      });
      expect(store.snapshot().launcher?.ownership).toBe(
        operation === "install" ? "koed" : "absent"
      );
    }
  });

  it("opens an explicit Privacy install action without consent or offline controls", async () => {
    const { api } = fixture();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(<CliInstallSettingsSection api={api} />)
      );
      await act(async () =>
        (
          host.querySelector(
            '[aria-label="Privacy Filter: Set up or manage"]'
          ) as HTMLElement
        ).click()
      );
      expect(document.body.textContent).toContain(
        "personally identifiable information"
      );
      expect(document.body.querySelector('input[type="checkbox"]')).toBeNull();
      expect(document.body.textContent).not.toContain("offline");
      expect(
        [...document.body.querySelectorAll("button")].some(
          (button) => button.textContent === "Done"
        )
      ).toBe(false);
      const install = [...document.body.querySelectorAll("button")].find(
        (button) => button.textContent === "Download and install"
      )!;
      await act(async () => install.click());
      expect(api.installPrivacy).toHaveBeenCalledWith(true);
      expect(document.body.textContent).toContain("Privacy Filter is ready");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
  it("explains packaged-app-only installation without offering a futile retry", async () => {
    const { api } = fixture();
    vi.mocked(api.getStatus).mockResolvedValue({
      available: false,
      state: "unavailable",
      reason: "packaged_app_required",
      message: "Install Privacy Filter from a packaged Koed app."
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(<CliInstallSettingsSection api={api} />)
      );
      await act(async () =>
        (
          host.querySelector(
            '[aria-label="Privacy Filter: Set up or manage"]'
          ) as HTMLElement
        ).click()
      );
      const dialog = document.body.querySelector('[role="dialog"]')!;
      expect(dialog.textContent).toContain("packaged Koed app");
      expect([...dialog.querySelectorAll("button")]).toHaveLength(1);
      expect(dialog.querySelector("button")?.getAttribute("aria-label")).toBe(
        "Close"
      );
      expect(api.installPrivacy).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("retains launcher success on PATH failure and retries PATH without reinstalling", async () => {
    const { api, owned } = fixture();
    const store = getInstallSetupStore(api);
    await store.refresh();
    vi.mocked(api.updatePath).mockRejectedValueOnce(
      new Error("Permission denied")
    );
    await store.installCli();
    expect(store.snapshot().cli).toMatchObject({ stage: "failed", step: 1 });
    expect(store.snapshot().cli.message).toContain("launcher was installed");
    vi.mocked(api.launcher).mockResolvedValue({
      ...owned,
      pathConfigured: true
    });
    await store.installCli();
    expect(
      vi
        .mocked(api.launcher)
        .mock.calls.filter(([operation]) => operation === "install")
    ).toHaveLength(1);
    expect(api.updatePath).toHaveBeenLastCalledWith("add", true);
    expect(store.snapshot().cli.stage).toBe("ready");
  });
  it("does not report CLI ready until inspection confirms PATH reaches new shells", async () => {
    const { api, owned } = fixture();
    const store = getInstallSetupStore(api);
    await store.refresh();
    vi.mocked(api.launcher).mockResolvedValue({
      ...owned,
      pathConfigured: false
    });
    await store.installCli();
    expect(api.updatePath).toHaveBeenCalledWith("add", true);
    expect(store.snapshot().cli).toMatchObject({ stage: "failed", step: 1 });
    expect(store.snapshot().cli.message).toMatch(/shell startup file/);
    vi.mocked(api.launcher).mockResolvedValue({
      ...owned,
      pathConfigured: true
    });
    await store.installCli();
    expect(store.snapshot().cli.stage).toBe("ready");
  });
  it("allows cancellation to be retried after the cancel request fails", async () => {
    const { api } = fixture();
    const store = getInstallSetupStore(api);
    await store.refresh();
    const install = deferred<PrivacyInstallStatus>();
    vi.mocked(api.installPrivacy).mockReturnValue(install.promise);
    const installing = store.installPrivacy();
    vi.mocked(api.cancel).mockRejectedValueOnce(new Error("bridge busy"));
    await store.cancelPrivacy();
    expect(store.snapshot().cancelling).toBe(false);
    expect(store.snapshot().privacy.message).toContain("bridge busy");
    await store.cancelPrivacy();
    expect(api.cancel).toHaveBeenCalledTimes(2);
    expect(store.snapshot().cancelling).toBe(true);
    install.reject(new Error("Privacy Filter installation cancelled."));
    await installing;
    expect(store.snapshot()).toMatchObject({
      cancelling: false,
      privacy: { stage: "idle", running: false }
    });
  });
  it("does not modify PATH when launcher installation fails", async () => {
    const { api } = fixture();
    const store = getInstallSetupStore(api);
    await store.refresh();
    vi.mocked(api.launcher).mockRejectedValue(
      new Error("Destination conflict")
    );
    await store.installCli();
    expect(api.updatePath).not.toHaveBeenCalled();
    expect(store.snapshot().cli).toMatchObject({ stage: "failed", step: 0 });
  });
  it("keeps real progress after subscribers leave and reports activation failures", async () => {
    const { api, emit } = fixture();
    const store = getInstallSetupStore(api);
    await store.refresh();
    let reject!: (error: Error) => void;
    vi.mocked(api.installPrivacy).mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        })
    );
    const unsubscribe = store.subscribe(() => {});
    const installing = store.installPrivacy();
    unsubscribe();
    emit({ completedBytes: 46, totalBytes: 100 });
    expect(getInstallSetupStore(api).snapshot().privacy).toMatchObject({
      stage: "progress",
      percent: 46
    });
    emit({ stage: "restart", message: "Restarting services" });
    await store.cancelPrivacy();
    expect(api.cancel).not.toHaveBeenCalled();
    reject(new Error("Restart failed; previous runtime restored"));
    await installing;
    expect(store.snapshot().privacy).toMatchObject({
      stage: "failed",
      step: 2
    });
    expect(store.snapshot().privacy.message).toContain(
      "previous runtime restored"
    );
  });
  it("retains removal failures and removes PATH before the launcher", async () => {
    const { api } = fixture();
    const store = getInstallSetupStore(api);
    await store.refresh();
    vi.mocked(api.updatePath).mockRejectedValueOnce(
      new Error("Edited PATH block")
    );
    await store.removeCli();
    expect(store.snapshot().cli).toMatchObject({
      stage: "failed",
      removing: true
    });
    expect(
      vi
        .mocked(api.launcher)
        .mock.calls.some(([operation]) => operation === "remove")
    ).toBe(false);
    await store.removeCli();
    expect(api.launcher).toHaveBeenLastCalledWith("remove");
    expect(store.snapshot().cli.stage).toBe("idle");
  });
});
