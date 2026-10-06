import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parsePiModelListOutput,
  piPackageIsListed,
  removePi,
  resolvePiSetupExecutable,
  resolvePiSetupLauncher,
  setupPi
} from "./pi-setup.js";

const temporaryDirectories: string[] = [];
const spawnResult = (stdout = "", status = 0) =>
  ({ stdout, stderr: "", status, signal: null, pid: 1, output: [] }) as never;

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Pi setup", () => {
  it("parses model and package listings without substring matches", async () => {
    expect(parsePiModelListOutput("provider model\nopenai gpt-5.4\n")).toEqual({
      valid: true,
      models: ["openai/gpt-5.4"]
    });
    expect(parsePiModelListOutput("No models available.\n")).toEqual({
      valid: true,
      models: []
    });
    expect(parsePiModelListOutput("provider model\nmalformed\n")).toEqual({
      valid: false,
      models: []
    });
    expect(parsePiModelListOutput("unexpected output\n")).toEqual({
      valid: false,
      models: []
    });
    expect(
      piPackageIsListed(
        "/tmp/koed/integrations/pi-old\n",
        "/tmp/koed/integrations/pi"
      )
    ).toBe(false);
    expect(
      piPackageIsListed(
        "/tmp/koed/integrations/pi\n",
        "/tmp/koed/integrations/pi"
      )
    ).toBe(true);
  });

  it.each([
    "explicit",
    "resources",
    "koed-home",
    "server-package",
    "legacy-flat"
  ])(
    "uses the explicit source checkout despite %s packaged flags",
    async (layout) => {
      const root = mkdtempSync(resolve(tmpdir(), "koed-pi-packaged-"));
      temporaryDirectories.push(root);
      const koedHome = resolve(root, "koed");
      const runtimeRoot =
        layout === "koed-home"
          ? resolve(koedHome, "runtime/koed-runtime")
          : layout === "server-package"
            ? resolve(koedHome, "runtime/koed-server/current/koed-runtime")
            : resolve(root, "resources/koed-runtime");
      const source = resolve(
        runtimeRoot,
        layout === "legacy-flat"
          ? "mcp-server/integrations/pi"
          : "node_modules/@koed/mcp-server/integrations/pi"
      );
      mkdirSync(resolve(source, "extensions"), { recursive: true });
      writeFileSync(resolve(source, "package.json"), "{}\n");
      writeFileSync(
        resolve(source, "extensions/koed.mjs"),
        "// selected runtime\n"
      );
      // A checkout package must not supersede the selected packaged runtime.
      const decoy = resolve(
        root,
        "checkout/packages/mcp-server/integrations/pi"
      );
      mkdirSync(resolve(decoy, "extensions"), { recursive: true });
      writeFileSync(resolve(decoy, "package.json"), "{}\n");
      writeFileSync(
        resolve(decoy, "extensions/koed.mjs"),
        "// wrong checkout\n"
      );
      const result = await setupPi(
        {
          HOME: root,
          KOED_HOME: koedHome,
          KOED_REPO_ROOT: resolve(root, "checkout"),
          KOED_PACKAGED_DESKTOP: "1",
          KOED_PACKAGED_RESOURCES_PATH: resolve(root, "resources"),
          ...(layout === "explicit"
            ? { KOED_JS_RUNTIME_ROOT: runtimeRoot }
            : {}),
          KOED_PI_EXECUTABLE: "/bin/sh"
        },
        ((_command: string, args: string[]) =>
          args[0] === "--version"
            ? spawnResult("0.84.2\n")
            : args[0] === "--list-models"
              ? spawnResult("No models available.\n")
              : args[0] === "list"
                ? spawnResult(`${resolve(koedHome, "integrations/pi")}\n`)
                : spawnResult()) as never
      );
      expect(result.ok).toBe(true);
      expect(
        readFileSync(
          resolve(koedHome, "integrations/pi/extensions/koed.mjs"),
          "utf8"
        )
      ).toBe("// wrong checkout\n");
    }
  );

  it("fails when explicit source checkout lacks Pi and ignores packaged runtime roots", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-pi-source-missing-"));
    temporaryDirectories.push(root);
    const spawn = vi.fn();
    const result = await setupPi(
      {
        HOME: root,
        KOED_HOME: resolve(root, "koed"),
        KOED_REPO_ROOT: root,
        KOED_JS_RUNTIME_ROOT: resolve(root, "missing-runtime")
      },
      spawn as never
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Pi integration package is missing");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("finds and stores Pi from a macOS fallback directory", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-pi-macos-discovery-"));
    temporaryDirectories.push(root);
    const source = resolve(root, "packages/mcp-server/integrations/pi");
    const executable = resolve(root, ".local/bin/pi");
    mkdirSync(resolve(source, "extensions"), { recursive: true });
    mkdirSync(resolve(executable, ".."), { recursive: true });
    writeFileSync(resolve(source, "package.json"), "{}\n");
    writeFileSync(resolve(source, "extensions/koed.mjs"), "export {};\n");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    const result = await setupPi(
      {
        HOME: root,
        PATH: "/usr/bin:/bin",
        KOED_HOME: resolve(root, "koed"),
        KOED_REPO_ROOT: root
      },
      ((_command: string, args: string[]) =>
        args[0] === "--version"
          ? spawnResult("0.84.2\n")
          : args[0] === "--list-models"
            ? spawnResult("provider model\nopenai gpt-5.4\n")
            : args[0] === "list"
              ? spawnResult(`${resolve(root, "koed/integrations/pi")}\n`)
              : spawnResult("installed\n")) as never
    );

    expect(result).toMatchObject({
      ok: true,
      executablePath: realpathSync(executable)
    });
    expect(
      JSON.parse(
        readFileSync(
          resolve(root, "koed/config/ai-client-instances.json"),
          "utf8"
        )
      )
    ).toMatchObject({
      instances: [
        {
          instanceId: "pi.default",
          executablePath: executable
        }
      ]
    });
  });

  it("canonicalizes Pi and invokes it with an authenticated, secret-free environment", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-pi-setup-"));
    temporaryDirectories.push(root);
    const source = resolve(root, "packages/mcp-server/integrations/pi");
    const executable = resolve(root, "pi-real");
    const link = resolve(root, "pi");
    mkdirSync(resolve(source, "extensions"), { recursive: true });
    writeFileSync(resolve(source, "package.json"), "{}\n");
    writeFileSync(resolve(source, "extensions/koed.mjs"), "export {};\n");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);
    symlinkSync(executable, link);
    const calls: Array<{
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];

    const result = await setupPi(
      {
        HOME: root,
        PATH: process.env.PATH,
        KOED_HOME: resolve(root, "koed"),
        KOED_REPO_ROOT: root,
        KOED_PI_EXECUTABLE: link,
        PI_CODING_AGENT_DIR: resolve(root, "pi-profile"),
        MEMORY_API_TOKEN: "must-not-leak",
        ANTHROPIC_API_KEY: "must-not-leak",
        DATABASE_URL: "postgres://must-not-leak"
      },
      ((
        command: string,
        args: string[],
        options?: { env?: NodeJS.ProcessEnv }
      ) => {
        calls.push({ command, args, env: options?.env });
        if (args[0] === "--version") return spawnResult("0.84.2\n");
        if (args[0] === "--list-models") {
          return spawnResult("provider model\nopenai gpt-5.4\n");
        }
        if (args[0] === "list") {
          return spawnResult(`${resolve(root, "koed/integrations/pi")}\n`);
        }
        return spawnResult("installed\n");
      }) as never
    );

    expect(result).toMatchObject({
      ok: true,
      executablePath: realpathSync(executable),
      modelCount: 1
    });
    expect(
      calls.every(({ command }) => command === realpathSync(executable))
    ).toBe(true);
    expect(
      JSON.parse(
        readFileSync(
          resolve(root, "koed/config/ai-client-instances.json"),
          "utf8"
        )
      )
    ).toMatchObject({
      instances: [
        {
          instanceId: "pi.default",
          executablePath: link
        }
      ]
    });
    for (const { env } of calls) {
      expect(env).not.toHaveProperty("MEMORY_API_TOKEN");
      expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(env).not.toHaveProperty("DATABASE_URL");
      expect(env).toMatchObject({
        KOED_HOME: resolve(root, "koed"),
        PI_CODING_AGENT_DIR: resolve(root, "pi-profile")
      });
    }
  });

  it("configures the Pi profile while no models are authenticated", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-pi-models-"));
    temporaryDirectories.push(root);
    const source = resolve(root, "packages/mcp-server/integrations/pi");
    const executable = resolve(root, "pi");
    mkdirSync(resolve(source, "extensions"), { recursive: true });
    writeFileSync(resolve(source, "package.json"), "{}\n");
    writeFileSync(resolve(source, "extensions/koed.mjs"), "export {};\n");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);

    const calls: string[][] = [];
    const result = await setupPi(
      {
        HOME: root,
        KOED_HOME: resolve(root, "koed"),
        KOED_REPO_ROOT: root,
        KOED_PI_EXECUTABLE: executable
      },
      ((_command: string, args: string[]) => {
        calls.push(args);
        return args[0] === "--version"
          ? spawnResult("0.84.2\n")
          : args[0] === "--list-models"
            ? spawnResult("No models available.\n")
            : args[0] === "list"
              ? spawnResult(`${resolve(root, "koed/integrations/pi")}\n`)
              : spawnResult("installed\n");
      }) as never
    );

    expect(result).toMatchObject({
      ok: true,
      state: "needs_attention",
      profileConfigured: true,
      authenticationState: "unauthenticated",
      executionCapabilities: "unavailable",
      modelCount: 0
    });
    expect(result.action).toContain("Authenticate at least one Pi model");
    expect(calls).toContainEqual([
      "install",
      resolve(root, "koed/integrations/pi")
    ]);
    expect(
      JSON.parse(
        readFileSync(
          resolve(root, "koed/config/ai-client-instances.json"),
          "utf8"
        )
      )
    ).toMatchObject({ instances: [{ instanceId: "pi.default" }] });
  });

  it("configures the Pi profile when model discovery fails but reports unknown authentication", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-pi-model-probe-"));
    temporaryDirectories.push(root);
    const source = resolve(root, "packages/mcp-server/integrations/pi");
    const target = resolve(root, "koed/integrations/pi");
    const executable = resolve(root, "pi");
    mkdirSync(resolve(source, "extensions"), { recursive: true });
    writeFileSync(resolve(source, "package.json"), "{}\n");
    writeFileSync(resolve(source, "extensions/koed.mjs"), "export {};\n");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);

    const result = await setupPi(
      {
        HOME: root,
        KOED_HOME: resolve(root, "koed"),
        KOED_REPO_ROOT: root,
        KOED_PI_EXECUTABLE: executable
      },
      ((_command: string, args: string[]) =>
        args[0] === "--version"
          ? spawnResult("0.84.2\n")
          : args[0] === "--list-models"
            ? spawnResult("", 1)
            : args[0] === "list"
              ? spawnResult(`${target}\n`)
              : spawnResult("installed\n")) as never
    );

    expect(result).toMatchObject({
      ok: true,
      state: "needs_attention",
      profileConfigured: true,
      authenticationState: "unknown",
      executionCapabilities: "unavailable",
      modelDiscoveryError: "Pi model discovery exited with code 1."
    });
    expect(result.action).toContain("Fix Pi model discovery");
  });

  it("rolls back an unverified Pi profile installation", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-pi-profile-verify-"));
    temporaryDirectories.push(root);
    const source = resolve(root, "packages/mcp-server/integrations/pi");
    const target = resolve(root, "koed/integrations/pi");
    const executable = resolve(root, "pi");
    mkdirSync(resolve(source, "extensions"), { recursive: true });
    writeFileSync(resolve(source, "package.json"), "{}\n");
    writeFileSync(resolve(source, "extensions/koed.mjs"), "export {};\n");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);

    const result = await setupPi(
      {
        HOME: root,
        KOED_HOME: resolve(root, "koed"),
        KOED_REPO_ROOT: root,
        KOED_PI_EXECUTABLE: executable
      },
      ((_command: string, args: string[]) =>
        args[0] === "--version"
          ? spawnResult("0.84.2\n")
          : args[0] === "--list-models"
            ? spawnResult("provider model\n")
            : args[0] === "list"
              ? spawnResult("unrelated-package\n")
              : spawnResult("installed\n")) as never
    );

    expect(result).toMatchObject({
      ok: false,
      state: "needs_attention",
      profileConfigured: false
    });
    expect(result.error).toContain(
      "Pi active profile does not reference the installed Koed package"
    );
    expect(existsSync(target)).toBe(false);
    expect(
      existsSync(resolve(root, "koed/config/ai-client-instances.json"))
    ).toBe(false);
  });

  it("preserves fnm launcher while resolving its canonical invocation target", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-pi-fnm-launcher-"));
    temporaryDirectories.push(root);
    const launcher = resolve(root, ".local/share/fnm/aliases/default/bin/pi");
    const target = resolve(root, ".local/share/fnm/node-versions/v1/bin/pi");
    mkdirSync(resolve(launcher, ".."), { recursive: true });
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, "#!/bin/sh\nexit 0\n");
    chmodSync(target, 0o700);
    symlinkSync(target, launcher);

    expect(
      resolvePiSetupLauncher({ HOME: root, PATH: "/usr/bin:/bin" }, "darwin")
    ).toBe(launcher);
    expect(
      resolvePiSetupExecutable({ HOME: root, PATH: "/usr/bin:/bin" }, "darwin")
    ).toBe(realpathSync(target));
  });

  it("resolves Windows npm launchers to the package Node entry", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-pi-win-setup-"));
    temporaryDirectories.push(root);
    const shim = resolve(root, "pi.cmd");
    const entry = resolve(
      root,
      "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
    );
    mkdirSync(resolve(entry, ".."), { recursive: true });
    writeFileSync(shim, "@echo off\r\n");
    writeFileSync(entry, "console.log('0.84.2');\n");

    expect(resolvePiSetupExecutable({ PATH: root }, "win32")).toBe(
      realpathSync(entry)
    );
  });

  it("runs trusted Pi removal, verifies active profile, and preserves unrelated registry entries", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-pi-remove-"));
    temporaryDirectories.push(root);
    const executable = resolve(root, "pi");
    const target = resolve(root, "koed/integrations/pi");
    const registry = resolve(root, "koed/config/ai-client-instances.json");
    mkdirSync(target, { recursive: true });
    mkdirSync(resolve(target, "extensions"), { recursive: true });
    writeFileSync(resolve(target, "package.json"), '{"name":"koed"}\n');
    writeFileSync(resolve(target, "extensions/koed.mjs"), "export {};\n");
    writeFileSync(executable, "#!/bin/sh\\nexit 0\\n");
    chmodSync(executable, 0o700);
    mkdirSync(resolve(registry, ".."), { recursive: true });
    writeFileSync(
      registry,
      JSON.stringify({
        version: 1,
        instances: [
          {
            instanceId: "pi.default",
            driverId: "pi",
            displayName: "Pi",
            executablePath: executable
          },
          {
            instanceId: "other.default",
            driverId: "other",
            displayName: "Other",
            executablePath: executable
          }
        ]
      })
    );
    const calls: string[][] = [];
    const result = removePi(
      {
        HOME: root,
        PATH: root,
        KOED_HOME: resolve(root, "koed"),
        KOED_PI_EXECUTABLE: executable,
        KOED_AI_CLIENT_INSTANCE_REGISTRY: registry
      },
      ((_command: string, args: string[]) => {
        calls.push(args);
        return args[0] === "list"
          ? spawnResult("other-package\n")
          : spawnResult("removed\n");
      }) as never
    );

    expect(result).toMatchObject({
      ok: true,
      executablePath: realpathSync(executable)
    });
    expect(calls[0]).toEqual(["remove", target]);
    expect(existsSync(target)).toBe(false);
    const afterRegistry = JSON.parse(readFileSync(registry, "utf8")) as {
      instances: Array<{ instanceId: string }>;
    };
    expect(afterRegistry.instances).toHaveLength(1);
    expect(afterRegistry.instances[0]?.instanceId).toBe("other.default");
  });

  it("rolls back Pi package and registry when command verification fails", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-pi-remove-fail-"));
    temporaryDirectories.push(root);
    const executable = resolve(root, "pi");
    const target = resolve(root, "koed/integrations/pi");
    const registry = resolve(root, "koed/config/ai-client-instances.json");
    mkdirSync(target, { recursive: true });
    writeFileSync(resolve(target, "package.json"), '{"name":"koed"}\n');
    writeFileSync(executable, "#!/bin/sh\\nexit 0\\n");
    chmodSync(executable, 0o700);
    mkdirSync(resolve(registry, ".."), { recursive: true });
    const registryContent = JSON.stringify({
      version: 1,
      instances: [
        {
          instanceId: "pi.default",
          driverId: "pi",
          displayName: "Pi",
          executablePath: executable
        }
      ]
    });
    writeFileSync(registry, registryContent);

    const result = removePi(
      {
        HOME: root,
        PATH: root,
        KOED_HOME: resolve(root, "koed"),
        KOED_PI_EXECUTABLE: executable,
        KOED_AI_CLIENT_INSTANCE_REGISTRY: registry
      },
      ((_command: string, args: string[]) =>
        args[0] === "remove"
          ? spawnResult("", 1)
          : spawnResult("koed-package\n")) as never
    );

    expect(result.ok).toBe(false);
    expect(readFileSync(resolve(target, "package.json"), "utf8")).toContain(
      '"koed"'
    );
    expect(readFileSync(registry, "utf8")).toBe(registryContent);
  });

  it("restores package and re-registers Pi after removal verification fails", async () => {
    const root = mkdtempSync(
      resolve(tmpdir(), "koed-pi-remove-profile-rollback-")
    );
    temporaryDirectories.push(root);
    const executable = resolve(root, "pi");
    const target = resolve(root, "koed/integrations/pi");
    const registry = resolve(root, "koed/config/ai-client-instances.json");
    mkdirSync(target, { recursive: true });
    writeFileSync(resolve(target, "package.json"), '{"name":"koed"}\\n');
    writeFileSync(executable, "#!/bin/sh\\nexit 0\\n");
    chmodSync(executable, 0o700);
    mkdirSync(resolve(registry, ".."), { recursive: true });
    writeFileSync(
      registry,
      JSON.stringify({
        version: 1,
        instances: [
          {
            instanceId: "pi.default",
            driverId: "pi",
            displayName: "Pi",
            executablePath: executable
          }
        ]
      })
    );
    const calls: string[][] = [];
    let listCalls = 0;
    const result = removePi(
      {
        HOME: root,
        PATH: root,
        KOED_HOME: resolve(root, "koed"),
        KOED_PI_EXECUTABLE: executable,
        KOED_AI_CLIENT_INSTANCE_REGISTRY: registry
      },
      ((_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "remove") return spawnResult("removed\\n");
        if (args[0] === "list") {
          listCalls += 1;
          return listCalls === 1
            ? spawnResult("profile check failed", 1)
            : spawnResult(`${target}\\n`);
        }
        return spawnResult("installed\\n");
      }) as never
    );

    expect(result.ok).toBe(false);
    expect(calls).toContainEqual(["install", target]);
    expect(calls.filter((args) => args[0] === "list")).toHaveLength(2);
    expect(readFileSync(resolve(target, "package.json"), "utf8")).toContain(
      '"koed"'
    );
  });

  it("restores the last working package when replacement fails", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-pi-rollback-"));
    temporaryDirectories.push(root);
    const source = resolve(root, "packages/mcp-server/integrations/pi");
    const target = resolve(root, "koed/integrations/pi");
    const executable = resolve(root, "pi");
    mkdirSync(resolve(source, "extensions"), { recursive: true });
    mkdirSync(resolve(target, "extensions"), { recursive: true });
    writeFileSync(resolve(source, "package.json"), '{"version":"new"}\n');
    writeFileSync(resolve(source, "extensions/koed.mjs"), "// new\n");
    writeFileSync(resolve(target, "package.json"), '{"version":"old"}\n');
    writeFileSync(resolve(target, "extensions/koed.mjs"), "// old\n");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);
    let installs = 0;

    const result = await setupPi(
      {
        HOME: root,
        KOED_HOME: resolve(root, "koed"),
        KOED_REPO_ROOT: root,
        KOED_PI_EXECUTABLE: executable
      },
      ((_command: string, args: string[]) => {
        if (args[0] === "--version") return spawnResult("0.84.2\n");
        if (args[0] === "--list-models")
          return spawnResult("provider model\nopenai gpt-5.4\n");
        if (args[0] === "list") return spawnResult(`${target}\n`);
        installs += 1;
        return installs === 1 ? spawnResult("", 1) : spawnResult("restored\n");
      }) as never
    );

    expect(result).toMatchObject({ ok: false, state: "needs_attention" });
    expect(installs).toBe(2);
    expect(readFileSync(join(target, "package.json"), "utf8")).toContain(
      '"old"'
    );
  });
});
