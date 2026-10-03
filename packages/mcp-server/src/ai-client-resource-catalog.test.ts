import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  realpathSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockSkillPath = { current: "" };
vi.mock("./codex-app-server-runner.js", () => ({
  CodexAppServerClient: class {
    async initialize() {}
    async listSkills() {
      return {
        data: [
          {
            skills: [
              {
                name: "review",
                path: mockSkillPath.current,
                scope: "project",
                description: "Review this Project."
              }
            ]
          }
        ]
      };
    }
    async listInstalledApps() {
      return { apps: [] };
    }
    async listMcpServerStatuses() {
      return { servers: [] };
    }
    async close() {}
  }
}));

import {
  discoverConfiguredAiClientResources,
  revalidateSelectedNativeSkills
} from "./ai-client-resource-catalog.js";

const directories: string[] = [];
const temporaryProject = () => {
  const directory = mkdtempSync(join(tmpdir(), "ai-client-resources-"));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("native AI Client resource discovery", () => {
  it("revalidates opaque Skills against the exact owner, computer, and Project without publishing paths", async () => {
    const projectPath = temporaryProject();
    const executablePath = join(projectPath, "codex");
    const skillPath = join(projectPath, "SKILL.md");
    mkdirSync(join(projectPath, ".codex"));
    writeFileSync(executablePath, "native test executable");
    chmodSync(executablePath, 0o700);
    writeFileSync(skillPath, "name: review\n");
    mockSkillPath.current = skillPath;
    const instance = {
      instanceId: "codex.work",
      driverId: "codex",
      displayName: "Codex",
      executablePath
    };
    const scope = {
      instance,
      ownerUserId: "00000000-0000-4000-8000-000000000001",
      hostedInstanceId: "runner-test-instance",
      computerLabel: "Test computer",
      projectId: "lp_0123456789abcdef0123456789abcdef",
      projectPath
    };
    const catalog = await discoverConfiguredAiClientResources(scope);
    expect(catalog.resources).toHaveLength(1);
    expect(catalog.resources[0]).toMatchObject({
      kind: "skill",
      name: "review",
      invocation: "native_skill"
    });
    expect(JSON.stringify(catalog)).not.toContain(projectPath);

    const selected = await revalidateSelectedNativeSkills({
      ...scope,
      selectedResourceIds: [catalog.resources[0]!.resourceId]
    });
    expect(selected).toEqual([
      expect.objectContaining({
        resourceId: catalog.resources[0]!.resourceId,
        provider: "codex",
        name: "review",
        providerPath: realpathSync(skillPath)
      })
    ]);

    await expect(
      revalidateSelectedNativeSkills({
        ...scope,
        projectId: "lp_abcdef0123456789abcdef0123456789",
        selectedResourceIds: [catalog.resources[0]!.resourceId]
      })
    ).rejects.toThrow("AiClientResourceSelectionStale");
  });
});
