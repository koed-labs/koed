import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  nodeCliInvocation,
  nodeCliProcessEnvironment,
  resolveThirdPartyNodeCliExecutable,
  resolveThirdPartyNodeCliExecutableInternal
} from "./node-cli-invocation.js";

describe("Node CLI invocation", () => {
  it.each(["cli.js", "cli.mjs", "cli.cjs"])(
    "runs a canonical %s entry through the trusted Node executable",
    (entry) => {
      expect(
        nodeCliInvocation(`/opt/client/${entry}`, ["--version"], "/node")
      ).toEqual({
        command: "/node",
        args: [`/opt/client/${entry}`, "--version"],
        nodeExecutable: "/node"
      });
    }
  );

  it("runs a native executable directly", () => {
    expect(
      nodeCliInvocation("/opt/client/bin", ["--version"], "/node")
    ).toEqual({
      command: "/opt/client/bin",
      args: ["--version"]
    });
  });

  it("resolves a stable launcher before selecting the runtime", () => {
    const directory = mkdtempSync(join(tmpdir(), "koed-node-cli-"));
    try {
      const entry = join(directory, "cli-v1.js");
      const upgradedEntry = join(directory, "cli-v2.js");
      const launcher = join(directory, "cli");
      writeFileSync(entry, "process.exit(0);\n");
      writeFileSync(upgradedEntry, "process.exit(0);\n");
      symlinkSync(entry, launcher);

      expect(nodeCliInvocation(launcher, ["--version"], "/node")).toEqual({
        command: "/node",
        args: [realpathSync(entry), "--version"],
        nodeExecutable: "/node"
      });

      rmSync(launcher);
      rmSync(entry);
      symlinkSync(upgradedEntry, launcher);
      expect(nodeCliInvocation(launcher, ["--version"], "/node")).toEqual({
        command: "/node",
        args: [realpathSync(upgradedEntry), "--version"],
        nodeExecutable: "/node"
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves Electron Node mode only for trusted runtime invocations", () => {
    const runtimeEnvironment = { ELECTRON_RUN_AS_NODE: "1" };
    const childEnvironment = { PATH: "/usr/bin:/bin" };

    expect(
      nodeCliProcessEnvironment(
        nodeCliInvocation("/opt/client/cli.js", [], "/electron"),
        childEnvironment,
        runtimeEnvironment,
        "/electron"
      )
    ).toEqual({
      PATH: "/usr/bin:/bin",
      ELECTRON_RUN_AS_NODE: "1"
    });
    expect(
      nodeCliProcessEnvironment(
        nodeCliInvocation("/opt/client/bin", [], "/electron"),
        childEnvironment,
        runtimeEnvironment,
        "/electron"
      )
    ).toBe(childEnvironment);
  });

  it("preserves Electron Node mode for a selected Helper interpreter", () => {
    const invocation = nodeCliInvocation(
      "/opt/client/cli.js",
      [],
      "/Koed Helper"
    );
    expect(
      nodeCliProcessEnvironment(invocation, {}, { ELECTRON_RUN_AS_NODE: "1" })
    ).toEqual({
      ELECTRON_RUN_AS_NODE: "1"
    });
  });

  it("enables Node mode for a selected Helper without affecting native CLIs", () => {
    const helper =
      "/Applications/Renamed.app/Contents/Frameworks/Koed Helper.app/Contents/MacOS/Koed Helper";
    expect(
      nodeCliProcessEnvironment(
        nodeCliInvocation("/client/cli.js", [], helper),
        {},
        {}
      )
    ).toEqual({
      ELECTRON_RUN_AS_NODE: "1"
    });
    expect(
      nodeCliProcessEnvironment(
        nodeCliInvocation("/client/native", [], helper),
        { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" },
        {}
      )
    ).toEqual({ PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" });
  });

  it("enables Node mode for Electron fallback without inherited flag, but not native Node", () => {
    const runtime = "/Applications/Koed.app/Contents/MacOS/Koed";
    const invocation = nodeCliInvocation("/client/cli.js", [], runtime);
    const descriptor = Object.getOwnPropertyDescriptor(
      process.versions,
      "electron"
    );
    const execDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "execPath"
    )!;
    try {
      Object.defineProperty(process, "execPath", {
        value: runtime,
        configurable: true
      });
      Object.defineProperty(process.versions, "electron", {
        value: "30.0.0",
        configurable: true
      });
      expect(
        nodeCliProcessEnvironment(invocation, { PATH: "/bin" }, {})
      ).toEqual({ PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" });
      delete (process.versions as Record<string, string | undefined>).electron;
      expect(
        nodeCliProcessEnvironment(invocation, { PATH: "/bin" }, {})
      ).toEqual({ PATH: "/bin" });
    } finally {
      Object.defineProperty(process, "execPath", execDescriptor);
      if (descriptor)
        Object.defineProperty(process.versions, "electron", descriptor);
      else
        delete (process.versions as Record<string, string | undefined>)
          .electron;
    }
  });

  it("records exact interpreter for wrapped JS invocations", () => {
    const invocation = nodeCliInvocation(
      "/opt/client/cli.js",
      ["--verbose"],
      "/usr/local/node/bin/node"
    );
    expect(invocation).toEqual({
      command: "/usr/local/node/bin/node",
      args: ["/opt/client/cli.js", "--verbose"],
      nodeExecutable: "/usr/local/node/bin/node"
    });
  });
});

describe("resolveThirdPartyNodeCliExecutableInternal", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "koed-helper-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createMockAppBundle(
    productName: string,
    opts: { helperExists?: boolean; helperExecutable?: boolean } = {}
  ): { appPath: string; helperPath: string } {
    const { helperExists = false, helperExecutable = true } = opts;

    const appPath = join(tmpDir, `${productName}.app`);
    const helperPath = join(
      appPath,
      "Contents",
      "Frameworks",
      `${productName} Helper.app`,
      "Contents",
      "MacOS",
      `${productName} Helper`
    );
    const electronPath = join(
      appPath,
      "Contents",
      "Frameworks",
      "Electron.framework",
      "Versions",
      "A",
      "Electron"
    );

    // Create Electron executable (directory first, then file)
    mkdirSync(dirname(electronPath), { recursive: true });
    writeFileSync(electronPath, "#!/bin/sh\n");

    if (helperExists) {
      mkdirSync(dirname(helperPath), { recursive: true });
      writeFileSync(helperPath, "#!/bin/sh\n");
      chmodSync(helperPath, 0o755); // ensure executable
      if (!helperExecutable) {
        const { mode } = statSync(helperPath);
        chmodSync(helperPath, mode & ~0o111); // remove execute bits
      }
    }

    // Make Helper executable (only relevant when helperExists is true and helperExecutable is true)
    if (helperExists && helperExecutable) {
      chmodSync(helperPath, 0o755);
    }

    return { appPath, helperPath };
  }

  it("selects Helper for the packaged main executable", () => {
    const { appPath, helperPath } = createMockAppBundle("Koed", {
      helperExists: true
    });
    const runtime = join(appPath, "Contents", "MacOS", "Koed");
    expect(resolveThirdPartyNodeCliExecutableInternal(runtime, "darwin")).toBe(
      helperPath
    );
  });

  it("finds the original Helper after the outer app is renamed", () => {
    const { appPath } = createMockAppBundle("Koed", { helperExists: true });
    const renamed = join(tmpDir, "Renamed.app");
    renameSync(appPath, renamed);
    const helper = join(
      renamed,
      "Contents",
      "Frameworks",
      "Koed Helper.app",
      "Contents",
      "MacOS",
      "Koed Helper"
    );
    for (const runtime of [
      join(renamed, "Contents", "MacOS", "Koed"),
      join(
        renamed,
        "Contents",
        "Frameworks",
        "Electron.framework",
        "Versions",
        "A",
        "Electron"
      )
    ]) {
      expect(
        resolveThirdPartyNodeCliExecutableInternal(runtime, "darwin")
      ).toBe(helper);
    }
  });

  it("falls back for a framework runtime when Helper identity is ambiguous", () => {
    const { appPath } = createMockAppBundle("Koed", { helperExists: true });
    mkdirSync(join(appPath, "Contents", "Frameworks", "Other Helper.app"));
    const runtime = join(
      appPath,
      "Contents",
      "Frameworks",
      "Electron.framework",
      "Versions",
      "A",
      "Electron"
    );
    expect(resolveThirdPartyNodeCliExecutableInternal(runtime, "darwin")).toBe(
      runtime
    );
  });

  it("rejects non-app Frameworks paths even when a matching Helper exists", () => {
    const { appPath } = createMockAppBundle("Koed", { helperExists: true });
    const fakeBundle = join(tmpDir, "Koed");
    symlinkSync(appPath, fakeBundle);
    const runtime = join(
      fakeBundle,
      "Contents",
      "Frameworks",
      "Electron.framework",
      "Versions",
      "A",
      "Electron"
    );
    expect(resolveThirdPartyNodeCliExecutableInternal(runtime, "darwin")).toBe(
      runtime
    );
  });

  it("falls back for a non-executable Helper or unrelated main executable", () => {
    const { appPath } = createMockAppBundle("Koed", {
      helperExists: true,
      helperExecutable: false
    });
    const runtime = join(appPath, "Contents", "MacOS", "Koed");
    expect(resolveThirdPartyNodeCliExecutableInternal(runtime, "darwin")).toBe(
      runtime
    );
    const unrelated = join(appPath, "Contents", "MacOS", "other");
    expect(
      resolveThirdPartyNodeCliExecutableInternal(unrelated, "darwin")
    ).toBe(unrelated);
  });

  it("selects Frameworks Helper for darwin app-bundled Electron", () => {
    const { appPath, helperPath } = createMockAppBundle("Koed", {
      helperExists: true
    });

    const electronPath = join(
      appPath,
      "Contents",
      "Frameworks",
      "Electron.framework",
      "Versions",
      "A",
      "Electron"
    );

    const result = resolveThirdPartyNodeCliExecutableInternal(
      electronPath,
      "darwin"
    );
    expect(result).toBe(helperPath);
  });

  it("resolves Helper path with spaces in product name", () => {
    const { appPath, helperPath } = createMockAppBundle("Koed Pro", {
      helperExists: true
    });

    const electronPath = join(
      appPath,
      "Contents",
      "Frameworks",
      "Electron.framework",
      "Versions",
      "A",
      "Electron"
    );

    const result = resolveThirdPartyNodeCliExecutableInternal(
      electronPath,
      "darwin"
    );
    expect(result).toBe(helperPath);
  });

  it("falls back on non-Darwin platform", () => {
    const appPath = "/path/to/app";
    expect(resolveThirdPartyNodeCliExecutableInternal(appPath, "linux")).toBe(
      appPath
    );
    expect(resolveThirdPartyNodeCliExecutableInternal(appPath, "win32")).toBe(
      appPath
    );
  });

  it("falls back when executable is not in an app bundle", () => {
    const nodePath = "/opt/homebrew/bin/node";
    expect(resolveThirdPartyNodeCliExecutableInternal(nodePath, "darwin")).toBe(
      nodePath
    );
  });

  it("falls back when Helper app does not exist", () => {
    const { appPath } = createMockAppBundle("Koed", { helperExists: false });

    const electronPath = join(
      appPath,
      "Contents",
      "Frameworks",
      "Electron.framework",
      "Versions",
      "A",
      "Electron"
    );

    const result = resolveThirdPartyNodeCliExecutableInternal(
      electronPath,
      "darwin"
    );
    expect(result).toBe(electronPath);
  });

  it("selects Helper when it is executable", () => {
    const { appPath, helperPath } = createMockAppBundle("Koed", {
      helperExists: true
    });

    const electronPath = join(
      appPath,
      "Contents",
      "Frameworks",
      "Electron.framework",
      "Versions",
      "A",
      "Electron"
    );

    const result = resolveThirdPartyNodeCliExecutableInternal(
      electronPath,
      "darwin"
    );
    expect(result).toBe(helperPath);
  });

  it("falls back when executable path has no .app bundle", () => {
    const tmpSub = join(tmpDir, "no-app");
    mkdirSync(tmpSub, { recursive: true });

    const electronPath = join(
      tmpSub,
      "Contents",
      "Frameworks",
      "Electron.framework",
      "Versions",
      "A",
      "Electron"
    );
    mkdirSync(dirname(electronPath), { recursive: true });
    writeFileSync(electronPath, "");

    const result = resolveThirdPartyNodeCliExecutableInternal(
      electronPath,
      "darwin"
    );
    expect(result).toBe(electronPath);
  });
});

describe("resolveThirdPartyNodeCliExecutable (public)", () => {
  it("uses process defaults for first-party callers", () => {
    expect(resolveThirdPartyNodeCliExecutable()).toBe(process.execPath);
  });
});
