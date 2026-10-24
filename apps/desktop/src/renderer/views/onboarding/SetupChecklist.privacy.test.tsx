// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliInstallApi } from "../../../cli-install/protocol.js";
import type { DesktopSetupSnapshot } from "../../../types.js";
import { DesktopStatusStore } from "../../services/desktop-commands.js";
import { SetupChecklist } from "./SetupChecklist.js";

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
  delete window.koedDesktop;
});

const makeApi = () =>
  ({
    getStatus: vi.fn(async () => ({
      available: true,
      state: "not_installed" as const,
      message: "Privacy Filter assets are missing."
    })),
    installPrivacy: vi.fn(async () => ({
      available: true,
      state: "ready" as const,
      message: "Ready"
    })),
    cancel: vi.fn(async () => undefined),
    selectOffline: vi.fn(async () => ({
      archivePath: "/tmp/privacy.tar.gz",
      manifestPath: "/tmp/privacy.manifest.json"
    })),
    launcher: vi.fn(async () => ({
      ownership: "absent" as const,
      target: "missing" as const,
      helper: "unsupported" as const,
      version: null,
      pathVisible: false,
      fingerprint: null
    })),
    updatePath: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined)
  }) satisfies CliInstallApi;

const render = async (
  teamCollaborationEnabled: boolean,
  api?: CliInstallApi
) => {
  const snapshot: DesktopSetupSnapshot = {
    activeStage: null,
    error: null,
    runId: "fresh-install",
    sequence: 1,
    state: "ready",
    stages: [
      "package",
      "runtime",
      "model",
      "services",
      "integration",
      "verification"
    ].map((id) => ({
      id: id as DesktopSetupSnapshot["stages"][number]["id"],
      state: "pending",
      message: "Needs setup",
      completedBytes: null,
      totalBytes: null
    }))
  };
  const run = vi.fn(async () => snapshot);
  window.koedDesktop = {
    invoke: vi.fn(),
    cliInstall: api,
    setup: {
      inspect: async () => snapshot,
      run,
      subscribe: () => () => undefined
    }
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <SetupChecklist
        onComplete={vi.fn()}
        statusStore={new DesktopStatusStore()}
        teamCollaborationEnabled={teamCollaborationEnabled}
      />
    )
  );
  return run;
};

const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label
  )!;
const click = async (element: HTMLElement) => act(async () => element.click());

describe("Team onboarding Privacy installer", () => {
  it("offers pinned installation before services without automatic download or setup", async () => {
    const api = makeApi();
    const run = await render(true, api);
    expect(container.textContent).toContain(
      "Privacy Filter assets are missing."
    );
    expect(button("Install Privacy Filter").disabled).toBe(true);
    expect(api.installPrivacy).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    await click(button("Choose offline component files"));
    await click(
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    );
    await click(button("Install Privacy Filter"));
    expect(api.installPrivacy).toHaveBeenCalledWith(true, {
      archivePath: "/tmp/privacy.tar.gz",
      manifestPath: "/tmp/privacy.manifest.json"
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps missing installer bridge actionable before onboarding completes", async () => {
    await render(true);
    expect(container.textContent).toContain(
      "Desktop installer bridge unavailable"
    );
    expect(button("Install Privacy Filter").disabled).toBe(true);
    expect(button("Set up Koed")).toBeDefined();
  });

  it("reports failed verification and allows explicit retry without starting services", async () => {
    const api = makeApi();
    api.installPrivacy.mockRejectedValueOnce(
      new Error("component manifest pin mismatch.")
    );
    const run = await render(true, api);
    await click(
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    );
    await click(button("Install Privacy Filter"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "component manifest pin mismatch."
    );
    await click(button("Retry install"));
    expect(api.installPrivacy).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });

  it("leaves Personal-only onboarding free of Privacy installation", async () => {
    const api = makeApi();
    await render(false, api);
    expect(container.textContent).not.toContain("Privacy Filter assets");
    expect(api.getStatus).not.toHaveBeenCalled();
    expect(api.installPrivacy).not.toHaveBeenCalled();
    expect(button("Set up Koed")).toBeDefined();
  });
});
