import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { runInstalledDesktopCli } from "./desktop-cli-entrypoint.js";
import type { DesktopRuntimeCapability } from "./desktop-runtime-capability.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }))
);

const installation = () => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch", "desktop cli "));
  roots.push(root);
  const resources = resolve(root, "My Apps/Koed.app/Contents/Resources");
  const entry = resolve(
    resources,
    "app.asar/node_modules/@koed-labs/server/dist/desktop-cli-entrypoint.js"
  );
  const executable = resolve(resources, "../MacOS/Koed");
  for (const path of [entry, executable]) {
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, "");
  }
  return { root, resources, entry, executable };
};

it("runs shared CLI commands with a verified capability and supervisor command", async () => {
  const { root, resources, entry, executable } = installation();
  const capability = { resourcesPath: resources } as DesktopRuntimeCapability;
  const verifyBundle = vi.fn(() => capability);
  const runCli = vi.fn(async () => 0);
  const home = resolve(root, "Desktop Home");
  const environment: NodeJS.ProcessEnv = {
    KOED_HOME: home,
    KOED_SERVER_DAEMON_COMMAND: "/bin/sh",
    KOED_PACKAGED_RESOURCES_PATH: "/tmp/elsewhere"
  };
  await expect(
    runInstalledDesktopCli(["status", "--json"], {
      moduleUrl: pathToFileURL(entry).href,
      executable,
      platform: "darwin",
      electronVersion: "39.8.10",
      environment,
      verifyBundle,
      runCli
    })
  ).resolves.toBe(0);
  expect(verifyBundle).toHaveBeenCalledWith(resources);
  expect(runCli).toHaveBeenCalledWith(["status", "--json"], {
    desktopRuntimeCapability: capability,
    supervisorInvocation: { startCommand: entry, cwd: home }
  });
  expect(environment.KOED_SERVER_DAEMON_COMMAND).toBeUndefined();
  expect(environment.KOED_PACKAGED_RESOURCES_PATH).toBeUndefined();
  expect(environment.KOED_PACKAGED_DESKTOP).toBe("1");
});

it("starts the detached host only after verifying the packaged installation", async () => {
  const { resources, entry, executable } = installation();
  const capability = { resourcesPath: resources } as DesktopRuntimeCapability;
  const host = vi.fn(async () => 0);
  const runCli = vi.fn(async () => 0);
  const environment: NodeJS.ProcessEnv = {};
  await expect(
    runInstalledDesktopCli(["__control-plane-host"], {
      moduleUrl: pathToFileURL(entry).href,
      executable,
      platform: "darwin",
      electronVersion: "39.8.10",
      environment,
      verifyBundle: () => capability,
      runControlPlaneHost: host,
      runCli
    })
  ).resolves.toBe(0);
  expect(host).toHaveBeenCalledWith({ capability, environment });
  expect(runCli).not.toHaveBeenCalled();
});

it("runs migration only after explicit confirmation and installation verification", async () => {
  const { root, resources, entry, executable } = installation();
  const capability = { resourcesPath: resources } as DesktopRuntimeCapability;
  const migrate = vi.fn();
  const stderr = { write: vi.fn() };
  const options = {
    moduleUrl: pathToFileURL(entry).href,
    executable,
    platform: "darwin" as const,
    electronVersion: "39.8.10",
    environment: { KOED_HOME: resolve(root, "home") },
    verifyBundle: () => capability,
    migrateStoppedLegacyAgent: migrate,
    stderr,
    stdout: { write: vi.fn() }
  };
  expect(await runInstalledDesktopCli(["migrate"], options)).toBe(1);
  expect(migrate).not.toHaveBeenCalled();
  expect(
    await runInstalledDesktopCli(
      ["migrate", "--confirm-legacy-stopped"],
      options
    )
  ).toBe(0);
  expect(migrate).toHaveBeenCalledOnce();
});

it("reports Agent eligibility only after verifying the installed bundle", async () => {
  const { resources, entry, executable } = installation();
  const capability = { resourcesPath: resources } as DesktopRuntimeCapability;
  const stdout = { write: vi.fn() };
  const team = vi.fn(() => "ABCDE12345");
  await expect(
    runInstalledDesktopCli(["__control-plane-agent-eligibility"], {
      moduleUrl: pathToFileURL(entry).href,
      executable,
      platform: "darwin",
      electronVersion: "39.8.10",
      environment: {},
      verifyBundle: () => capability,
      agentTeamId: team,
      stdout
    })
  ).resolves.toBe(0);
  expect(team).toHaveBeenCalledWith(capability);
  expect(JSON.parse(String(stdout.write.mock.calls[0]![0]))).toMatchObject({
    ok: true,
    teamId: "ABCDE12345"
  });
});

it("routes packaged macOS start and stop to the control plane", async () => {
  const { resources, entry, executable } = installation();
  const capability = { resourcesPath: resources } as DesktopRuntimeCapability;
  const runControlPlaneCli = vi.fn(async () => 0);
  const runCli = vi.fn(async () => 0);
  for (const args of [["start", "--daemon"], ["stop"]]) {
    await expect(
      runInstalledDesktopCli(args, {
        moduleUrl: pathToFileURL(entry).href,
        executable,
        platform: "darwin",
        electronVersion: "39.8.10",
        environment: {},
        verifyBundle: () => capability,
        runControlPlaneCli,
        runCli
      })
    ).resolves.toBe(0);
  }
  expect(runControlPlaneCli).toHaveBeenCalledTimes(2);
  expect(runCli).not.toHaveBeenCalled();
});

it("probes startup status without launching a missing control plane", async () => {
  const { resources, entry, executable } = installation();
  const capability = { resourcesPath: resources } as DesktopRuntimeCapability;
  const installed = await import("./control-plane/installed-client.js");
  const open = vi
    .spyOn(installed, "openInstalledControlPlane")
    .mockResolvedValue({} as never);
  const runControlPlaneCli = vi.fn(
    async (
      args: string[],
      deps: Parameters<
        typeof import("./control-plane/cli.js").runControlPlaneCli
      >[1]
    ) => {
      expect(args).toEqual(["agent-status", "--json"]);
      await deps.connect("start");
      return 0;
    }
  );
  try {
    expect(
      await runInstalledDesktopCli(
        ["__control-plane-startup-status", "--json"],
        {
          moduleUrl: pathToFileURL(entry).href,
          executable,
          platform: "darwin",
          electronVersion: "39.8.10",
          environment: {},
          verifyBundle: () => capability,
          runControlPlaneCli
        }
      )
    ).toBe(0);
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ launchIfMissing: false })
    );
  } finally {
    open.mockRestore();
  }
});

it("fails closed before running any command outside its installation", async () => {
  const { entry } = installation();
  const runCli = vi.fn(async () => 0);
  const verifyBundle = vi.fn();
  const stderr = { write: vi.fn(() => true) };
  await expect(
    runInstalledDesktopCli(["stop"], {
      moduleUrl: pathToFileURL(entry).href,
      executable: process.execPath,
      platform: "darwin",
      electronVersion: "39.8.10",
      environment: {},
      verifyBundle,
      runCli,
      stderr
    })
  ).resolves.toBe(1);
  expect(verifyBundle).not.toHaveBeenCalled();
  expect(runCli).not.toHaveBeenCalled();
  expect(stderr.write).toHaveBeenCalledWith(
    expect.stringMatching(/could not verify its installation/)
  );
});
