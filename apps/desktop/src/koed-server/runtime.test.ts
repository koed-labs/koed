import { describe, expect, it } from "vitest";
import {
  createElectronNodeEnv,
  createKoedServerCliInvocation,
  resolveElectronNodeExecPath
} from "./runtime.js";

describe("Koed Desktop Node entrypoint runtime", () => {
  it("marks Electron child processes as Node-compatible", () => {
    expect(createElectronNodeEnv({ FOO: "bar" })).toMatchObject({
      FOO: "bar",
      ELECTRON_RUN_AS_NODE: "1"
    });
  });

  it("uses explicit KOED_NODE_COMMAND when configured", () => {
    const invocation = createKoedServerCliInvocation(
      "/repo/cli.js",
      ["status"],
      {
        appIsPackaged: false,
        electronExecPath: "/Applications/Koed.app/Contents/MacOS/Koed",
        platform: "darwin",
        environment: { KOED_NODE_COMMAND: "/opt/node/bin/node" }
      }
    );

    expect(invocation).toEqual({
      command: "/opt/node/bin/node",
      args: ["/repo/cli.js", "status"],
      env: { KOED_NODE_COMMAND: "/opt/node/bin/node" }
    });
  });

  it("uses Electron in explicit Node mode for development", () => {
    const invocation = createKoedServerCliInvocation(
      "/repo/packages/koed-server/dist/cli.js",
      ["doctor", "--json"],
      {
        appIsPackaged: false,
        electronExecPath: "/repo/node_modules/.bin/electron",
        platform: "darwin",
        environment: { KOED_REPO_ROOT: "/repo" }
      }
    );

    expect(invocation.command).toBe("/repo/node_modules/.bin/electron");
    expect(invocation.args).toEqual([
      "/repo/packages/koed-server/dist/cli.js",
      "doctor",
      "--json"
    ]);
    expect(invocation.env).toMatchObject({
      KOED_REPO_ROOT: "/repo",
      ELECTRON_RUN_AS_NODE: "1"
    });
  });

  it("uses the macOS Helper executable for packaged Electron node mode", () => {
    const execPath = resolveElectronNodeExecPath({
      appIsPackaged: true,
      electronExecPath: "/Applications/Koed.app/Contents/MacOS/Koed",
      platform: "darwin",
      existsSync: (path) => path.endsWith("Koed Helper")
    });

    expect(execPath).toBe(
      "/Applications/Koed.app/Contents/Frameworks/Koed Helper.app/Contents/MacOS/Koed Helper"
    );
  });

  it("wraps packaged script entrypoints with the runner", () => {
    const invocation = createKoedServerCliInvocation(
      "/app/cli.js",
      ["status"],
      {
        appIsPackaged: true,
        electronExecPath: "/Applications/Koed.app/Contents/MacOS/Koed",
        platform: "linux",
        resourcesPath: "/Applications/Koed.app/Contents/Resources",
        environment: {}
      }
    );

    expect(invocation.args).toEqual([
      "/Applications/Koed.app/Contents/Resources/app.asar.unpacked/dist-electron/koed-server/node-entrypoint-runner.js",
      "node-script",
      "/app/cli.js",
      "status"
    ]);
    expect(invocation.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });
});
