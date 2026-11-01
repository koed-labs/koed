// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CliInstallApi,
  PrivacyInstallStatus
} from "../../../cli-install/protocol.js";
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
    installPrivacy: vi.fn(
      async (): Promise<PrivacyInstallStatus> => ({
        available: true,
        state: "ready" as const,
        message: "Ready"
      })
    ),
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
      template: null,
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
const confirmSetup = async () => {
  const dialog = document.body.querySelector('[role="dialog"]');
  expect(dialog).toBeTruthy();
  const confirm = [...dialog!.querySelectorAll("button")].find(
    (item) => item.textContent === "Set up Koed"
  )!;
  await click(confirm);
};

describe("Initial setup optional tools", () => {
  it("keeps optional tools out of Personal-only initial setup", async () => {
    const api = makeApi();
    const run = await render(false, api);
    expect(container.textContent).not.toContain("Optional tools");
    expect(container.textContent).not.toContain("Privacy Filter");
    expect(container.textContent).not.toContain("Command line");
    expect(api.getStatus).not.toHaveBeenCalled();
    expect(api.launcher).not.toHaveBeenCalled();
    expect(api.installPrivacy).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    await click(button("Set up Koed"));
    expect(run).not.toHaveBeenCalled();
    await confirmSetup();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("makes required Privacy installation reachable with separate consent before Team setup", async () => {
    const api = makeApi();
    const staged = {
      available: true,
      state: "not_installed" as const,
      installationState: "staged" as const,
      message: "Privacy assets staged. Complete core setup."
    };
    vi.mocked(api.installPrivacy).mockResolvedValue(staged);
    const run = await render(true, api);
    expect(container.textContent).toContain("Privacy Filter");
    expect(container.textContent).not.toContain("Optional tools");
    expect(container.textContent).not.toContain("Command line");
    expect(api.installPrivacy).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();

    await click(
      container.querySelector<HTMLElement>(
        '[aria-label="Privacy Filter: Set up or manage"]'
      )!
    );
    expect(api.installPrivacy).not.toHaveBeenCalled();
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const install = [...dialog.querySelectorAll("button")].find(
      (item) => item.textContent === "Download and install"
    )!;
    await click(install);
    expect(api.installPrivacy).toHaveBeenCalledWith(true);
    expect(dialog.textContent).toContain(staged.message);
    expect(run).not.toHaveBeenCalled();
    expect(button("Continue")).toBeUndefined();
    await click(dialog.querySelector<HTMLElement>('[aria-label="Close"]')!);
    await click(button("Set up Koed"));
    await confirmSetup();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports a missing installer bridge without bypassing Team setup", async () => {
    const run = await render(true);
    expect(container.textContent).toContain(
      "Desktop installer bridge unavailable"
    );
    await click(button("Set up Koed"));
    await confirmSetup();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
