import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePiSdkInstallation } from "./pi-sdk-installation.js";

const temporaryDirectories: string[] = [];

const fixtureDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "koed-pi-sdk-installation-")
  );
  temporaryDirectories.push(directory);
  return directory;
};

describe("Pi SDK installation resolution", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it("keeps the configured local-only sandbox launcher, runtime, and environment", async () => {
    const root = await fixtureDirectory();
    const packageRoot = path.join(
      root,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent"
    );
    const bin = path.join(root, "bin");
    const packageBin = path.join(packageRoot, "dist");
    await mkdir(bin, { recursive: true });
    await mkdir(packageBin, { recursive: true });
    const wrapper = path.join(bin, "pi");
    const sandbox = path.join(bin, "sandbox-exec");
    const runtime = path.join(bin, "node");
    const profile = path.join(root, "local-only.sb");
    await writeFile(sandbox, "");
    await writeFile(runtime, "");
    await writeFile(profile, "sandbox profile fixture");
    await writeFile(path.join(packageBin, "cli.js"), "");
    await writeFile(path.join(packageBin, "index.js"), "");
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        exports: { ".": { import: "./dist/index.js" } }
      })
    );
    await writeFile(
      wrapper,
      [
        "#!/bin/sh",
        "export PI_OFFLINE=1",
        "export PI_TELEMETRY=0",
        `exec ${sandbox} -f ${profile} \\`,
        `  ${runtime} \\`,
        `  ${path.join(packageRoot, "dist/cli.js")} "$@"`,
        ""
      ].join("\n")
    );
    await chmod(wrapper, 0o755);

    const resolved = resolvePiSdkInstallation({
      executablePath: wrapper,
      environment: { KEEP_EXISTING: "present" }
    });

    expect(resolved.sdkEntryPath).toBe(
      await realpath(path.join(packageBin, "index.js"))
    );
    expect(resolved.execPath).toBe(await realpath(sandbox));
    expect(resolved.execArgv).toEqual([
      "-f",
      await realpath(profile),
      await realpath(runtime)
    ]);
    expect(resolved.environment).toMatchObject({
      KEEP_EXISTING: "present",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0"
    });
  });
});
