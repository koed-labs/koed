import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createClaudeCommandDiscoveryAdapter,
  listClaudeDraftCommands
} from "./command-discovery-adapter-claude.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("Claude command discovery adapter", () => {
  it("uses the selected config home and excludes Project commands from draft discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "koed-claude-discovery-"));
    roots.push(root);
    const configHome = join(root, "claude-home");
    await mkdir(join(configHome, "commands"), { recursive: true });
    await mkdir(join(configHome, "skills", "review"), { recursive: true });
    await writeFile(
      join(configHome, "commands", "edit.md"),
      "---\ndescription: Edit files\n---\nPrivate prompt body"
    );
    await writeFile(
      join(configHome, "skills", "review", "SKILL.md"),
      "---\ndescription: Review changes\n---\nPrivate skill body"
    );
    const registryPath = join(root, "instances.json");
    const instanceId = "claude.fixture";
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        instances: [
          {
            instanceId,
            driverId: "claude",
            displayName: "Fixture",
            executablePath: "/bin/sh",
            configHome
          }
        ]
      })
    );
    const environment = { KOED_AI_CLIENT_INSTANCE_REGISTRY: registryPath };
    const commands = await listClaudeDraftCommands({
      aiClientInstanceId: instanceId,
      environment
    });
    expect(
      commands.map((command) => [command.name, command.kind, command.scope])
    ).toEqual([
      ["edit", "command", "global"],
      ["review", "skill", "global"]
    ]);
    expect(
      commands.every(
        (command) =>
          command.source === "global-file" &&
          command.verification === "unverified"
      )
    ).toBe(true);
    expect(JSON.stringify(commands)).not.toContain("Private");
    await expect(
      createClaudeCommandDiscoveryAdapter(environment).discoverCommands({
        aiClientInstanceId: "claude.missing"
      })
    ).resolves.toEqual([]);
  });
});
