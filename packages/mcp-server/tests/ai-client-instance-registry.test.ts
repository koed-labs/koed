import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  environmentForLocalAiClientInstance,
  loadLocalAiClientInstanceRegistry,
  localAiClientInstanceConfigIdentity,
  resolveConfiguredLocalAiClientInstance,
  resolveLocalAiClientInstance
} from "../src/ai-client-instance-registry.js";

const temporaryDirectories: string[] = [];

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-ai-clients-"));
  temporaryDirectories.push(root);
  const executablePath = path.join(root, "claude");
  const configHome = path.join(root, "claude-home");
  fs.writeFileSync(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.mkdirSync(configHome);
  const registryPath = path.join(root, "instances.json");
  return { root, executablePath, configHome, registryPath };
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("local AI Client instance registry", () => {
  it("resolves a canonical executable and isolated Claude configuration home", () => {
    const value = fixture();
    fs.writeFileSync(
      value.registryPath,
      JSON.stringify({
        version: 1,
        instances: [
          {
            instanceId: "claude.pro",
            driverId: "claude",
            displayName: "Claude Pro",
            executablePath: value.executablePath,
            configHome: value.configHome
          }
        ]
      })
    );
    const env = { KOED_AI_CLIENT_INSTANCE_REGISTRY: value.registryPath };
    const instance = resolveLocalAiClientInstance({
      instanceId: "claude.pro",
      driverId: "claude",
      env
    });

    expect(instance).toMatchObject({
      instanceId: "claude.pro",
      driverId: "claude",
      executablePath: fs.realpathSync(value.executablePath),
      configHome: fs.realpathSync(value.configHome)
    });
    expect(
      environmentForLocalAiClientInstance({
        instance,
        driverId: "claude",
        env: { HOME: value.root }
      })
    ).toMatchObject({
      KOED_CLAUDE_CODE_EXECUTABLE: fs.realpathSync(value.executablePath),
      CLAUDE_CONFIG_DIR: fs.realpathSync(value.configHome)
    });
  });

  it("requires exact registry entries for Worker resolution, including defaults", () => {
    const env = {
      KOED_AI_CLIENT_INSTANCE_REGISTRY: "/missing/registry.json"
    };
    expect(
      resolveLocalAiClientInstance({
        instanceId: "claude.default",
        driverId: "claude",
        env
      })
    ).toBeNull();
    expect(() =>
      resolveConfiguredLocalAiClientInstance({
        instanceId: "claude.default",
        driverId: "claude",
        env
      })
    ).toThrow("not configured");
  });

  it("changes canonical identity when selected executable configuration changes", () => {
    const value = fixture();
    const env = { KOED_AI_CLIENT_INSTANCE_REGISTRY: value.registryPath };
    const write = (executablePath: string) =>
      fs.writeFileSync(
        value.registryPath,
        JSON.stringify({
          version: 1,
          instances: [
            {
              instanceId: "claude.pro",
              driverId: "claude",
              displayName: "Claude Pro",
              executablePath
            }
          ]
        })
      );
    write(value.executablePath);
    const first = resolveConfiguredLocalAiClientInstance({
      instanceId: "claude.pro",
      driverId: "claude",
      env
    });
    const firstIdentity = localAiClientInstanceConfigIdentity(first);
    const secondExecutable = path.join(value.root, "claude-v2");
    fs.writeFileSync(secondExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    write(secondExecutable);
    const second = resolveConfiguredLocalAiClientInstance({
      instanceId: "claude.pro",
      driverId: "claude",
      env
    });
    expect(localAiClientInstanceConfigIdentity(second)).not.toBe(firstIdentity);
  });

  it("changes identity when executable is replaced at the same path", () => {
    const value = fixture();
    const env = { KOED_AI_CLIENT_INSTANCE_REGISTRY: value.registryPath };
    const write = () =>
      fs.writeFileSync(
        value.registryPath,
        JSON.stringify({
          version: 1,
          instances: [
            {
              instanceId: "claude.pro",
              driverId: "claude",
              displayName: "Claude Pro",
              executablePath: value.executablePath
            }
          ]
        })
      );
    write();
    const first = resolveConfiguredLocalAiClientInstance({
      instanceId: "claude.pro",
      driverId: "claude",
      env
    });
    const firstIdentity = localAiClientInstanceConfigIdentity(first);
    fs.unlinkSync(value.executablePath);
    fs.writeFileSync(value.executablePath, "#!/bin/sh\nexit 1\n", {
      mode: 0o700
    });
    const second = resolveConfiguredLocalAiClientInstance({
      instanceId: "claude.pro",
      driverId: "claude",
      env
    });
    expect(localAiClientInstanceConfigIdentity(second)).not.toBe(firstIdentity);
  });

  it("isolates multiple instances of the same AI Client", () => {
    const value = fixture();
    const secondExecutable = path.join(value.root, "claude-work");
    const secondHome = path.join(value.root, "claude-work-home");
    fs.writeFileSync(secondExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    fs.mkdirSync(secondHome);
    fs.writeFileSync(
      value.registryPath,
      JSON.stringify({
        version: 1,
        instances: [
          {
            instanceId: "claude.personal",
            driverId: "claude",
            displayName: "Personal Claude",
            executablePath: value.executablePath,
            configHome: value.configHome
          },
          {
            instanceId: "claude.work",
            driverId: "claude",
            displayName: "Work Claude",
            executablePath: secondExecutable,
            configHome: secondHome
          }
        ]
      })
    );
    const env = { KOED_AI_CLIENT_INSTANCE_REGISTRY: value.registryPath };
    const personal = resolveLocalAiClientInstance({
      instanceId: "claude.personal",
      driverId: "claude",
      env
    });
    const work = resolveLocalAiClientInstance({
      instanceId: "claude.work",
      driverId: "claude",
      env
    });

    expect(personal?.executablePath).not.toBe(work?.executablePath);
    expect(personal?.configHome).not.toBe(work?.configHome);
    expect(
      environmentForLocalAiClientInstance({
        instance: personal,
        driverId: "claude",
        env
      })
    ).toMatchObject({
      KOED_CLAUDE_CODE_EXECUTABLE: fs.realpathSync(value.executablePath),
      CLAUDE_CONFIG_DIR: fs.realpathSync(value.configHome)
    });
    expect(
      environmentForLocalAiClientInstance({
        instance: work,
        driverId: "claude",
        env
      })
    ).toMatchObject({
      KOED_CLAUDE_CODE_EXECUTABLE: fs.realpathSync(secondExecutable),
      CLAUDE_CONFIG_DIR: fs.realpathSync(secondHome)
    });
  });

  it("isolates missing executable probes from valid registry entries", () => {
    const value = fixture();
    fs.writeFileSync(
      value.registryPath,
      JSON.stringify({
        version: 1,
        instances: [
          {
            instanceId: "claude.missing",
            driverId: "claude",
            displayName: "Missing Claude",
            executablePath: path.join(value.root, "missing")
          },
          {
            instanceId: "claude.valid",
            driverId: "claude",
            displayName: "Valid Claude",
            executablePath: value.executablePath
          }
        ]
      })
    );
    const registry = loadLocalAiClientInstanceRegistry({
      KOED_AI_CLIENT_INSTANCE_REGISTRY: value.registryPath
    });
    expect(registry.instances).toHaveLength(2);
    expect(registry.instances[0]).toMatchObject({
      instanceId: "claude.missing"
    });
    expect(typeof registry.instances[0]?.configurationError).toBe("string");
    expect(registry.instances[1]).toMatchObject({ instanceId: "claude.valid" });
  });

  it("rejects unknown fields, duplicate IDs, relative executables, and driver mismatch", () => {
    const value = fixture();
    const write = (instances: unknown[]) =>
      fs.writeFileSync(
        value.registryPath,
        JSON.stringify({ version: 1, instances })
      );
    write([
      {
        instanceId: "claude.pro",
        driverId: "claude",
        displayName: "Claude Pro",
        executablePath: value.executablePath,
        unexpected: true
      }
    ]);
    const malformed = loadLocalAiClientInstanceRegistry({
      KOED_AI_CLIENT_INSTANCE_REGISTRY: value.registryPath
    });
    expect(malformed.instances[0]).toMatchObject({
      instanceId: "claude.pro",
      driverId: "claude"
    });
    expect(malformed.instances[0]?.configurationError).toContain(
      "unknown or missing fields"
    );
    expect(() =>
      resolveLocalAiClientInstance({
        instanceId: "claude.pro",
        driverId: "claude",
        env: { KOED_AI_CLIENT_INSTANCE_REGISTRY: value.registryPath }
      })
    ).toThrow("configuration is unavailable");

    write([
      {
        instanceId: "claude.pro",
        driverId: "claude",
        displayName: "Claude Pro",
        executablePath: "./claude"
      }
    ]);
    expect(
      loadLocalAiClientInstanceRegistry({
        KOED_AI_CLIENT_INSTANCE_REGISTRY: value.registryPath
      }).instances[0]?.configurationError
    ).toContain("must be absolute");

    write([
      {
        instanceId: "claude.pro",
        driverId: "claude",
        displayName: "Claude Pro",
        executablePath: value.executablePath
      },
      {
        instanceId: "claude.pro",
        driverId: "claude",
        displayName: "Duplicate",
        executablePath: value.executablePath
      }
    ]);
    expect(() =>
      loadLocalAiClientInstanceRegistry({
        KOED_AI_CLIENT_INSTANCE_REGISTRY: value.registryPath
      })
    ).toThrow("Duplicate AI Client instance ID");

    write([
      {
        instanceId: "claude.pro",
        driverId: "claude",
        displayName: "Claude Pro",
        executablePath: value.executablePath
      }
    ]);
    expect(() =>
      resolveLocalAiClientInstance({
        instanceId: "claude.pro",
        driverId: "codex",
        env: { KOED_AI_CLIENT_INSTANCE_REGISTRY: value.registryPath }
      })
    ).toThrow('belongs to driver "claude"');
  });
});
