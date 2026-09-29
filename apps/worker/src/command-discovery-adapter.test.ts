import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCommandDiscoveryAdapter } from "./command-discovery-adapter.js";

const roots: string[] = [];
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "koed-command-discovery-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const configureInstance = (
  root: string,
  driverId: string,
  configHome: string
) => {
  mkdirSync(configHome, { recursive: true });
  const executable = join(root, "client");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(executable, 0o755);
  const registryPath = join(root, "instances.json");
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      instances: [
        {
          instanceId: `${driverId}.work`,
          driverId,
          displayName: "Work",
          executablePath: executable,
          configHome
        }
      ]
    })
  );
  return { KOED_AI_CLIENT_INSTANCE_REGISTRY: registryPath };
};

const writeCommand = (path: string, description: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `---\ndescription: ${description}\nargument-hint: <target>\n---\nPrompt body is not exposed.\n`
  );
};

describe("AI Client command discovery adapters", () => {
  it("returns Codex global prompt commands without requiring a Project", async () => {
    const root = makeRoot();
    const configHome = join(root, "codex-home");
    writeCommand(join(configHome, "prompts", "review.md"), "Review changes");
    const environment = configureInstance(root, "codex", configHome);
    const adapter = createCommandDiscoveryAdapter("codex", environment);

    await expect(
      adapter.discoverCommands({ aiClientInstanceId: "codex.work" })
    ).resolves.toEqual([
      {
        name: "review",
        description: "Review changes",
        argumentHint: "<target>",
        kind: "command",
        source: "provider",
        scope: "global"
      }
    ]);
  });

  it("combines project and global commands, preferring the project definition on name collisions", async () => {
    const root = makeRoot();
    const configHome = join(root, "codex-home");
    const projectRoot = join(root, "project");
    writeCommand(join(configHome, "prompts", "review.md"), "Global review");
    writeCommand(
      join(projectRoot, ".codex", "prompts", "review.md"),
      "Project review"
    );
    writeCommand(
      join(projectRoot, ".codex", "prompts", "test.md"),
      "Project test"
    );
    const environment = configureInstance(root, "codex", configHome);
    const adapter = createCommandDiscoveryAdapter("codex", environment);

    await expect(
      adapter.discoverCommands({
        aiClientInstanceId: "codex.work",
        projectRoot
      })
    ).resolves.toEqual([
      {
        name: "review",
        description: "Project review",
        argumentHint: "<target>",
        kind: "command",
        source: "provider",
        scope: "project"
      },
      {
        name: "test",
        description: "Project test",
        argumentHint: "<target>",
        kind: "command",
        source: "provider",
        scope: "project"
      }
    ]);
  });

  it("discovers Claude commands and skills from global and Project configuration", async () => {
    const root = makeRoot();
    const configHome = join(root, "claude-home");
    const projectRoot = join(root, "project");
    writeCommand(join(configHome, "commands", "review.md"), "Global review");
    writeCommand(
      join(configHome, "skills", "explain", "SKILL.md"),
      "Explain code"
    );
    writeCommand(
      join(projectRoot, ".claude", "commands", "test.md"),
      "Project test"
    );
    writeCommand(
      join(projectRoot, ".claude", "skills", "audit", "SKILL.md"),
      "Audit code"
    );
    const environment = configureInstance(root, "claude", configHome);
    const adapter = createCommandDiscoveryAdapter("claude", environment);

    await expect(
      adapter.discoverCommands({
        aiClientInstanceId: "claude.work",
        projectRoot
      })
    ).resolves.toEqual([
      {
        name: "review",
        description: "Global review",
        argumentHint: "<target>",
        kind: "command",
        source: "provider",
        scope: "global"
      },
      {
        name: "explain",
        description: "Explain code",
        argumentHint: "<target>",
        kind: "skill",
        source: "provider",
        scope: "global"
      },
      {
        name: "test",
        description: "Project test",
        argumentHint: "<target>",
        kind: "command",
        source: "provider",
        scope: "project"
      },
      {
        name: "audit",
        description: "Audit code",
        argumentHint: "<target>",
        kind: "skill",
        source: "provider",
        scope: "project"
      }
    ]);
  });

  it("discovers Pi global prompts and skills without requiring a Project", async () => {
    const root = makeRoot();
    const configHome = join(root, "pi-home");
    writeCommand(join(configHome, "prompts", "review.md"), "Review changes");
    writeCommand(
      join(configHome, "skills", "explain", "SKILL.md"),
      "Explain code"
    );
    const environment = configureInstance(root, "pi", configHome);
    const adapter = createCommandDiscoveryAdapter("pi", environment);

    await expect(
      adapter.discoverCommands({ aiClientInstanceId: "pi.work" })
    ).resolves.toEqual([
      {
        name: "review",
        description: "Review changes",
        argumentHint: "<target>",
        kind: "command",
        source: "provider",
        scope: "global"
      },
      {
        name: "explain",
        description: "Explain code",
        argumentHint: "<target>",
        kind: "skill",
        source: "provider",
        scope: "global"
      }
    ]);
  });

  it("bounds file metadata and rejects unsafe command names", async () => {
    const root = makeRoot();
    const configHome = join(root, "codex-home");
    const promptRoot = join(configHome, "prompts");
    const longDescription = "x".repeat(600);
    const longHint = "y".repeat(100);
    writeCommand(join(promptRoot, "valid.md"), longDescription);
    writeFileSync(
      join(promptRoot, "valid.md"),
      `---\ndescription: ${longDescription}\nargument-hint: ${longHint}\n---\nPrompt body.\n`
    );
    writeCommand(join(promptRoot, "bad name.md"), "Not a slash command");
    writeFileSync(
      join(promptRoot, "oversized.md"),
      `---\ndescription: too large\n---\n${"x".repeat(64 * 1024)}`
    );
    const environment = configureInstance(root, "codex", configHome);
    const adapter = createCommandDiscoveryAdapter("codex", environment);

    const commands = await adapter.discoverCommands({
      aiClientInstanceId: "codex.work"
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      name: "valid",
      description: "x".repeat(512),
      argumentHint: "y".repeat(64),
      scope: "global"
    });
  });

  it("fails closed for unconfigured instances and out-of-root project symlinks", async () => {
    const root = makeRoot();
    const configHome = join(root, "codex-home");
    const projectRoot = join(root, "project");
    const outsideProject = join(root, "outside");
    writeCommand(join(configHome, "prompts", "review.md"), "Review changes");
    mkdirSync(projectRoot, { recursive: true });
    writeCommand(
      join(outsideProject, "prompts", "attack.md"),
      "Must not escape project"
    );
    symlinkSync(outsideProject, join(projectRoot, ".codex"), "dir");
    const environment = configureInstance(root, "codex", configHome);
    const adapter = createCommandDiscoveryAdapter("codex", environment);

    await expect(
      adapter.discoverCommands({ aiClientInstanceId: "codex.unconfigured" })
    ).resolves.toEqual([]);

    await expect(
      adapter.discoverCommands({
        aiClientInstanceId: "codex.work",
        projectRoot
      })
    ).resolves.toEqual([
      {
        name: "review",
        description: "Review changes",
        argumentHint: "<target>",
        kind: "command",
        source: "provider",
        scope: "global"
      }
    ]);
  });
});
