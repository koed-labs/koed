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
