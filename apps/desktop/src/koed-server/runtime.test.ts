import { describe, expect, it } from "vitest";
import {
  createElectronNodeEnv,
  createNodeEntrypointInvocation,
  createKoedServerCliInvocation,
  resolveElectronNodeExecPath,
  resolveKoedServerPaths
} from "./runtime.js";

describe("Koed Desktop Node entrypoint runtime", () => {
  it("resolves the development koed-server CLI from the checkout", () => {
    expect(
      resolveKoedServerPaths({
        appDir: "/repo/apps/desktop/dist-electron",
        appIsPackaged: false,
        environment: {}
      })
    ).toEqual({
      repoRoot: "/repo",
      cliPath: "/repo/packages/koed-server/dist/cli.js"
    });
  });

  it("resolves the packaged koed-server CLI from app.asar node_modules", () => {
    expect(
      resolveKoedServerPaths({
        appDir:
          "/Applications/Koed.app/Contents/Resources/app.asar/dist-electron",
        appIsPackaged: true,
        environment: {},
        resourcesPath: "/Applications/Koed.app/Contents/Resources"
      })
    ).toEqual({
      repoRoot: "/Applications/Koed.app/Contents/Resources",
      cliPath:
        "/Applications/Koed.app/Contents/Resources/app.asar/node_modules/@koed/koed-server/dist/cli.js"
    });
  });

  it("preserves explicit koed-server CLI override and infers its checkout root", () => {
    expect(
      resolveKoedServerPaths({
        appDir:
          "/Applications/Koed.app/Contents/Resources/app.asar/dist-electron",
        appIsPackaged: true,
        environment: {
          KOED_SERVER_CLI: "/repo/packages/koed-server/dist/cli.js"
        },
        resourcesPath: "/Applications/Koed.app/Contents/Resources"
      })
    ).toEqual({
      repoRoot: "/repo",
      cliPath: "/repo/packages/koed-server/dist/cli.js"
    });
  });

  it("preserves explicit checkout root override", () => {
    expect(
      resolveKoedServerPaths({
        appDir:
          "/Applications/Koed.app/Contents/Resources/app.asar/dist-electron",
        appIsPackaged: true,
        environment: { KOED_REPO_ROOT: "/debug/repo" },
        resourcesPath: "/Applications/Koed.app/Contents/Resources"
      })
    ).toEqual({
      repoRoot: "/debug/repo",
      cliPath: "/debug/repo/packages/koed-server/dist/cli.js"
    });
  });

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

  it("uses the checkout Node runtime for development", () => {
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

    expect(invocation.command).toBe("node");
    expect(invocation.args).toEqual([
      "/repo/packages/koed-server/dist/cli.js",
      "doctor",
      "--json"
    ]);
    expect(invocation.env).toEqual({ KOED_REPO_ROOT: "/repo" });
  });

  it("uses the checkout Node runtime for development support scripts", () => {
    const invocation = createNodeEntrypointInvocation(
      "/repo/apps/desktop/dist-electron/pds-secret-bridge-provider.js",
      [],
      {
        appIsPackaged: false,
        electronExecPath: "/repo/node_modules/.bin/electron",
        platform: "darwin",
        environment: { KOED_REPO_ROOT: "/repo" }
      }
    );

    expect(invocation).toEqual({
      command: "node",
      args: ["/repo/apps/desktop/dist-electron/pds-secret-bridge-provider.js"],
      env: { KOED_REPO_ROOT: "/repo" }
    });
  });

  it("uses the app executable for packaged Electron node mode", () => {
    const execPath = resolveElectronNodeExecPath({
      appIsPackaged: true,
      electronExecPath: "/Applications/Koed.app/Contents/MacOS/Koed",
      platform: "darwin",
      existsSync: (path) => path.endsWith("Koed Helper")
    });

    expect(execPath).toBe("/Applications/Koed.app/Contents/MacOS/Koed");
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

  it("wraps packaged support scripts with the runner", () => {
    const invocation = createNodeEntrypointInvocation(
      "/app/pds-secret-bridge-provider.js",
      [],
      {
        appIsPackaged: true,
        electronExecPath: "/Applications/Koed.app/Contents/MacOS/Koed",
        platform: "darwin",
        resourcesPath: "/Applications/Koed.app/Contents/Resources",
        environment: {}
      }
    );

    expect(invocation).toEqual({
      command: "/Applications/Koed.app/Contents/MacOS/Koed",
      args: [
        "/Applications/Koed.app/Contents/Resources/app.asar.unpacked/dist-electron/koed-server/node-entrypoint-runner.js",
        "node-script",
        "/app/pds-secret-bridge-provider.js"
      ],
      env: { ELECTRON_RUN_AS_NODE: "1" }
    });
  });
});
