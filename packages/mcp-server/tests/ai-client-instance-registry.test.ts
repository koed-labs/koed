import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  environmentForLocalAiClientInstance,
  loadLocalAiClientInstanceRegistry,
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

  it("keeps built-in default instances configuration-free", () => {
    expect(
      resolveLocalAiClientInstance({
        instanceId: "claude.default",
        driverId: "claude",
        env: { KOED_AI_CLIENT_INSTANCE_REGISTRY: "/missing/registry.json" }
      })
    ).toBeNull();
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
    expect(() =>
      loadLocalAiClientInstanceRegistry({
        KOED_AI_CLIENT_INSTANCE_REGISTRY: value.registryPath
      })
    ).toThrow("unknown or missing fields");

    write([
      {
        instanceId: "claude.pro",
        driverId: "claude",
        displayName: "Claude Pro",
        executablePath: "./claude"
      }
    ]);
    expect(() =>
      loadLocalAiClientInstanceRegistry({
        KOED_AI_CLIENT_INSTANCE_REGISTRY: value.registryPath
      })
    ).toThrow("must be absolute");

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
