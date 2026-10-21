import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  createInstalledDesktopEnvironment,
  resolveInstalledDesktopResources
} from "./desktop-cli-authority.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }))
);

const linuxInstallation = () => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch", "desktop authority linux "));
  roots.push(root);
  const resources = resolve(root, "resources");
  const entry = resolve(
    resources,
    "app.asar/node_modules/@koed-labs/server/dist/desktop-cli-entrypoint.js"
  );
  const executable = resolve(root, "@koeddesktop");
  mkdirSync(resolve(entry, ".."), { recursive: true });
  mkdirSync(resolve(executable, ".."), { recursive: true });
  writeFileSync(entry, "");
  writeFileSync(executable, "");
  return { root, resources, entry, executable };
};

const installation = (appName = "Koed.app") => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch", "desktop authority "));
  roots.push(root);
  const resources = resolve(root, appName, "Contents/Resources");
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

it("binds packaged CLI code to the executable in the same installation", () => {
  const { resources, entry, executable } = installation("Spaced Koed.app");
  const input = {
    moduleUrl: pathToFileURL(entry).href,
    executable,
    platform: "darwin" as const,
    electronVersion: "39.8.10"
  };
  expect(resolveInstalledDesktopResources(input)).toEqual({
    resourcesPath: resources,
    entrypoint: entry
  });
  expect(() =>
    resolveInstalledDesktopResources({ ...input, executable: process.execPath })
  ).toThrow(/installation/);
  expect(() =>
    resolveInstalledDesktopResources({ ...input, electronVersion: undefined })
  ).toThrow(/Electron/);
  expect(() =>
    resolveInstalledDesktopResources({ ...input, moduleUrl: import.meta.url })
  ).toThrow(/packaged/);
  expect(() =>
    resolveInstalledDesktopResources({ ...input, platform: "win32" })
  ).toThrow(/installation/);
});

it("binds Linux CLI authority to the exact packaged executable", () => {
  const { root, resources, entry, executable } = linuxInstallation();
  const input = {
    moduleUrl: pathToFileURL(entry).href,
    executable,
    platform: "linux" as const,
    electronVersion: "39.8.10"
  };

  expect(resolveInstalledDesktopResources(input)).toEqual({
    resourcesPath: resources,
    entrypoint: entry
  });
  const siblingExecutable = resolve(root, "unrelated-helper");
  writeFileSync(siblingExecutable, "");
  expect(() =>
    resolveInstalledDesktopResources({
      ...input,
      executable: siblingExecutable
    })
  ).toThrow(/mismatch/u);
});

it("rejects an executable from another installation even through a symlink", () => {
  const first = installation();
  const second = installation();
  const linked = resolve(first.root, "koed-link");
  symlinkSync(second.executable, linked);
  expect(() =>
    resolveInstalledDesktopResources({
      moduleUrl: pathToFileURL(first.entry).href,
      executable: linked,
      platform: "darwin",
      electronVersion: "39.8.10"
    })
  ).toThrow(/mismatch/);
});

it("strips runtime overrides and applies Desktop-managed instance defaults", () => {
  const environment = createInstalledDesktopEnvironment({
    KOED_HOME: "/tmp/home with space",
    KOED_PACKAGED_RESOURCES_PATH: "/tmp/fake",
    KOED_ALLOW_PACKAGED_SOURCE_FALLBACK: "1",
    KOED_REPO_ROOT: "/tmp/repo",
    KOED_SERVER_CLI: "/tmp/cli.js",
    KOED_NODE_COMMAND: "node",
    KOED_SERVER_DAEMON_COMMAND: "/bin/sh",
    KOED_SERVER_DAEMON_ARGS_JSON: "[]"
  });
  expect(environment).toEqual({
    KOED_HOME: "/tmp/home with space",
    KOED_AUTO_PORTS: "1",
    KOED_RUNTIME_MODE: "local-personal",
    KOED_DEPENDENCY_MODE: "bundled-local",
    KOED_TEAM_COLLABORATION_ENABLED: "false",
    WORK_QUEUE_BACKEND: "local",
    KOED_PACKAGED_DESKTOP: "1",
    ELECTRON_RUN_AS_NODE: "1"
  });
});
