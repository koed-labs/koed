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
const mockCodexState = {
  methods: [] as Array<{ method: string; params?: unknown }>,
  environments: [] as NodeJS.ProcessEnv[],
  skill: {
    name: "review",
    scope: "project",
    enabled: true,
    description: "Review this Project."
  } as Record<string, unknown>,
  apps: [] as unknown[],
  servers: [] as unknown[]
};
const mockClaudeState = {
  commands: [] as Array<{ name: string; description: string }>,
  options: [] as Array<Record<string, unknown>>
};
vi.mock("./codex-app-server-runner.js", () => ({
  CodexAppServerClient: class {
    constructor(
      _executablePath: string,
      _cwd: string,
      environment: NodeJS.ProcessEnv
    ) {
      mockCodexState.environments.push({ ...environment });
    }
    async initialize(clientName: string) {
      mockCodexState.methods.push({
        method: "initialize",
        params: { clientName }
      });
    }
    async listSkills(cwds: string[] = []) {
      mockCodexState.methods.push({
        method: "skills/list",
        params: { cwds, forceReload: true }
      });
      return {
        data: [
          {
            skills: [{ ...mockCodexState.skill, path: mockSkillPath.current }]
          }
        ]
      };
    }
    async listInstalledApps() {
      mockCodexState.methods.push({ method: "app/installed", params: {} });
      return { apps: mockCodexState.apps };
    }
    async listMcpServerStatuses() {
      mockCodexState.methods.push({
        method: "mcpServerStatus/list",
        params: {}
      });
      return { servers: mockCodexState.servers };
    }
    async close() {
      mockCodexState.methods.push({ method: "close" });
    }
  }
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ options }: { options: Record<string, unknown> }) => {
    mockClaudeState.options.push(options);
    return {
      supportedCommands: async () => mockClaudeState.commands,
      close: vi.fn()
    };
  })
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
  mockCodexState.methods = [];
  mockCodexState.environments = [];
  mockCodexState.skill = {
    name: "review",
    scope: "project",
    enabled: true,
    description: "Review this Project."
  };
  mockCodexState.apps = [];
  mockCodexState.servers = [];
  mockClaudeState.commands = [];
  mockClaudeState.options = [];
});

describe("native AI Client resource discovery", () => {
  it("revalidates opaque Skills against the exact owner, computer, and Project without publishing paths", async () => {
    const projectPath = temporaryProject();
    const codexHome = join(temporaryProject(), "codex-home");
    mkdirSync(codexHome);
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
      executablePath,
      configHome: realpathSync(codexHome)
    };
    const scope = {
      instance,
      ownerUserId: "00000000-0000-4000-8000-000000000001",
      hostedInstanceId: "runner-test-instance",
      computerLabel: "Test computer",
      projectId: "lp_0123456789abcdef0123456789abcdef",
      projectPath,
      environment: { ...process.env, CODEX_HOME: "/ignored/codex-home" }
    };
    const catalog = await discoverConfiguredAiClientResources(scope);
    expect(catalog.resources).toHaveLength(1);
    expect(catalog.resources[0]).toMatchObject({
      kind: "skill",
      name: "review",
      status: "ready",
      availability: "available",
      executionSupport: "koed_managed",
      invocation: "native_skill"
    });
    expect(mockCodexState.methods).toEqual([
      { method: "initialize", params: { clientName: "koed-resource-catalog" } },
      {
        method: "skills/list",
        params: { cwds: [realpathSync(projectPath)], forceReload: true }
      },
      { method: "close" },
      { method: "initialize", params: { clientName: "koed-resource-catalog" } },
      { method: "app/installed", params: {} },
      { method: "mcpServerStatus/list", params: {} },
      { method: "close" }
    ]);
    expect(mockCodexState.methods.map(({ method }) => method)).not.toEqual(
      expect.arrayContaining([
        "plugin/list",
        "plugin/read",
        "plugin/install",
        "plugin/uninstall"
      ])
    );
    expect(mockCodexState.environments).toHaveLength(2);
    expect(
      mockCodexState.environments.map((environment) => environment.CODEX_HOME)
    ).toEqual([realpathSync(codexHome), realpathSync(codexHome)]);
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

  it("maps Codex inventory states without promoting unknown or unverified resources", async () => {
    const projectPath = temporaryProject();
    const executablePath = join(projectPath, "codex");
    const skillPath = join(projectPath, "SKILL.md");
    mkdirSync(join(projectPath, ".codex"));
    writeFileSync(executablePath, "native test executable");
    chmodSync(executablePath, 0o700);
    writeFileSync(skillPath, "name: review\n");
    mockSkillPath.current = skillPath;
    mockCodexState.skill = { ...mockCodexState.skill, enabled: false };
    mockCodexState.apps = [
      { id: "editor", enabled: true, callable: false },
      { id: "drive", enabled: true, callable: true },
      { id: "disabled-app", enabled: false, callable: false }
    ];
    mockCodexState.servers = [
      { name: "docs", runtimeStatus: "connected", authStatus: "unknown" },
      {
        name: "calendar",
        runtimeStatus: "authenticationRequired",
        authStatus: "notLoggedIn"
      },
      { name: "unknown-server", runtimeStatus: null, authStatus: "unknown" }
    ];

    const catalog = await discoverConfiguredAiClientResources({
      instance: {
        instanceId: "codex.work",
        driverId: "codex",
        displayName: "Codex",
        executablePath
      },
      ownerUserId: "00000000-0000-4000-8000-000000000001",
      hostedInstanceId: "runner-test-instance",
      computerLabel: null,
      projectId: "lp_0123456789abcdef0123456789abcdef",
      projectPath
    });

    expect(catalog.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "review",
          status: "disabled",
          availability: "disabled",
          executionSupport: "koed_managed"
        }),
        expect.objectContaining({
          name: "editor",
          status: "unavailable",
          availability: "configured",
          executionSupport: "inventory_only",
          invocation: null
        }),
        expect.objectContaining({
          name: "drive",
          status: "unavailable",
          availability: "available",
          executionSupport: "inventory_only",
          invocation: null
        }),
        expect.objectContaining({
          name: "disabled-app",
          status: "disabled",
          availability: "disabled",
          executionSupport: "inventory_only",
          invocation: null
        }),
        expect.objectContaining({
          name: "docs",
          status: "unavailable",
          availability: "available",
          executionSupport: "inventory_only"
        }),
        expect.objectContaining({
          name: "calendar",
          status: "unavailable",
          availability: "needs_sign_in",
          executionSupport: "inventory_only"
        }),
        expect.objectContaining({
          name: "unknown-server",
          status: "unavailable",
          availability: "unknown",
          executionSupport: "inventory_only"
        })
      ])
    );

    mockCodexState.skill = {
      name: "unknown",
      scope: "project",
      description: "Provider omitted the required enabled state."
    };
    const unknownCatalog = await discoverConfiguredAiClientResources({
      instance: {
        instanceId: "codex.work",
        driverId: "codex",
        displayName: "Codex",
        executablePath
      },
      ownerUserId: "00000000-0000-4000-8000-000000000001",
      hostedInstanceId: "runner-test-instance",
      computerLabel: null,
      projectId: "lp_0123456789abcdef0123456789abcdef",
      projectPath
    });
    expect(unknownCatalog.resources[0]).toMatchObject({
      name: "unknown",
      status: "unavailable",
      availability: "unknown",
      executionSupport: "koed_managed"
    });
  });

  it("discovers only verified Claude native Skills from explicit isolated roots", async () => {
    const fixtureRoot = temporaryProject();
    const executablePath = join(fixtureRoot, "claude.mjs");
    const configRoot = join(fixtureRoot, "custom-profile");
    const pluginRoot = join(fixtureRoot, "plugins", "fixture-plugin");
    const unsafePluginRoot = join(fixtureRoot, "plugins", "unsafe-plugin");
    const disabledPluginRoot = join(fixtureRoot, "plugins", "disabled-plugin");
    mkdirSync(configRoot, { recursive: true });
    mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
    mkdirSync(join(unsafePluginRoot, ".claude-plugin"), { recursive: true });
    mkdirSync(join(disabledPluginRoot, ".claude-plugin"), { recursive: true });
    for (const [root, name] of [
      [pluginRoot, "fixture-plugin"],
      [unsafePluginRoot, "unsafe-plugin"],
      [disabledPluginRoot, "disabled-plugin"]
    ]) {
      writeFileSync(
        join(root, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name, version: "1.0.0" })
      );
    }
    const writeSkill = (
      root: string,
      folder: string,
      name: string,
      extraFrontmatter = ""
    ) => {
      const directory = join(root, "skills", folder);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: Fixture Skill.\n${extraFrontmatter}---\nFixture body.\n`
      );
    };
    writeSkill(configRoot, "folder-name", "config-skill");
    writeSkill(pluginRoot, "folder-name", "bounded");
    writeSkill(unsafePluginRoot, "unsafe", "unsafe", "context: fork\n");
    writeFileSync(
      executablePath,
      `if (process.argv[2] === "--version") { process.stdout.write("2.1.226 (Claude Code)\\n"); process.exit(0); }\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["plugin", "list", "--json"])) process.exit(42);\nprocess.stdout.write(JSON.stringify({ plugins: [{ enabled: true, installPath: ${JSON.stringify(pluginRoot)} }, { enabled: true, installPath: ${JSON.stringify(unsafePluginRoot)} }, { enabled: false, installPath: ${JSON.stringify(disabledPluginRoot)} }] }));\n`
    );
    mockClaudeState.commands = [
      { name: "custom-profile:config-skill", description: "A config Skill." },
      { name: "fixture-plugin:bounded", description: "A plugin Skill." },
      { name: "unsafe-plugin:unsafe", description: "Unsafe metadata." },
      { name: "unscoped:outside", description: "An unbound command." }
    ];

    const environment = {
      HOME: join(fixtureRoot, "home"),
      CLAUDE_CONFIG_DIR: configRoot,
      PATH: "/usr/bin:/bin",
      TMPDIR: fixtureRoot
    };
    mkdirSync(environment.HOME);

    const catalog = await discoverConfiguredAiClientResources({
      instance: {
        instanceId: "claude.work",
        driverId: "claude",
        displayName: "Claude Code",
        executablePath,
        configHome: configRoot
      },
      ownerUserId: "00000000-0000-4000-8000-000000000001",
      hostedInstanceId: "runner-test-instance",
      computerLabel: null,
      projectId: null,
      projectPath: null,
      environment
    });
    expect(catalog.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "custom-profile:config-skill",
          status: "ready",
          availability: "available",
          executionSupport: "koed_managed",
          invocation: "native_skill"
        }),
        expect.objectContaining({
          name: "fixture-plugin:bounded",
          status: "ready",
          availability: "available",
          executionSupport: "koed_managed",
          invocation: "native_skill"
        }),
        expect.objectContaining({
          name: "unsafe-plugin:unsafe",
          status: "unavailable",
          availability: "available",
          executionSupport: "inventory_only",
          invocation: null
        }),
        expect.objectContaining({
          name: "unscoped:outside",
          status: "unavailable",
          availability: "available",
          executionSupport: "inventory_only",
          invocation: null
        }),
        expect.objectContaining({
          name: "disabled-plugin",
          availability: "disabled",
          executionSupport: "inventory_only",
          invocation: null
        })
      ])
    );
    expect(JSON.stringify(catalog)).not.toContain(executablePath);
    expect(JSON.stringify(catalog)).not.toContain(pluginRoot);
    expect(mockClaudeState.options).toHaveLength(1);
    expect(mockClaudeState.options[0]).toMatchObject({
      settingSources: [],
      persistSession: false,
      strictMcpConfig: true,
      mcpServers: {},
      tools: [],
      allowedTools: [],
      maxTurns: 0,
      settings: { disableAllHooks: true, permissions: { ask: ["*"] } },
      plugins: [
        {
          type: "local",
          path: realpathSync(configRoot),
          skipMcpDiscovery: true
        },
        {
          type: "local",
          path: realpathSync(pluginRoot),
          skipMcpDiscovery: true
        },
        {
          type: "local",
          path: realpathSync(unsafePluginRoot),
          skipMcpDiscovery: true
        }
      ]
    });
    expect(mockClaudeState.options[0]?.plugins).not.toContainEqual(
      expect.objectContaining({ path: realpathSync(disabledPluginRoot) })
    );

    const selected = await revalidateSelectedNativeSkills({
      instance: {
        instanceId: "claude.work",
        driverId: "claude",
        displayName: "Claude Code",
        executablePath,
        configHome: configRoot
      },
      ownerUserId: "00000000-0000-4000-8000-000000000001",
      hostedInstanceId: "runner-test-instance",
      projectId: null,
      projectPath: null,
      environment,
      selectedResourceIds: [
        catalog.resources.find(
          (resource) => resource.name === "fixture-plugin:bounded"
        )!.resourceId
      ]
    });
    expect(selected).toMatchObject([
      {
        provider: "claude",
        providerKind: "plugin",
        providerPath: realpathSync(pluginRoot),
        name: "fixture-plugin:bounded"
      }
    ]);
    expect(mockClaudeState.options).toHaveLength(2);
  });

  it("qualifies same-namespace user and Project Skills by their validated definitions", async () => {
    const fixtureRoot = temporaryProject();
    const executablePath = join(fixtureRoot, "claude.mjs");
    const configRoot = join(fixtureRoot, ".claude");
    const projectPath = join(fixtureRoot, "project");
    const writeSkill = (root: string, name: string) => {
      const directory = join(root, "skills", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: fixture\n---\n${name}\n`
      );
    };
    writeSkill(configRoot, "user-only");
    writeSkill(join(projectPath, ".claude"), "project-only");
    writeSkill(configRoot, "shared");
    writeSkill(join(projectPath, ".claude"), "shared");
    writeFileSync(
      executablePath,
      `if (process.argv[2] === "--version") { process.stdout.write("2.1.226 (Claude Code)\\n"); process.exit(0); }\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["plugin", "list", "--json"])) process.exit(42);\nprocess.stdout.write(JSON.stringify({ plugins: [] }));\n`
    );
    mockClaudeState.commands = [
      { name: ".claude:user-only", description: "User Skill." },
      { name: ".claude:project-only", description: "Project Skill." },
      { name: ".claude:shared", description: "Duplicate Skill." }
    ];
    const environment = {
      HOME: join(fixtureRoot, "home"),
      CLAUDE_CONFIG_DIR: realpathSync(configRoot),
      PATH: "/usr/bin:/bin",
      TMPDIR: fixtureRoot
    };
    mkdirSync(environment.HOME);

    const catalog = await discoverConfiguredAiClientResources({
      instance: {
        instanceId: "claude.project",
        driverId: "claude",
        displayName: "Claude Code",
        executablePath,
        configHome: realpathSync(configRoot)
      },
      ownerUserId: "00000000-0000-4000-8000-000000000001",
      hostedInstanceId: "runner-test-instance",
      computerLabel: null,
      projectId: "lp_0123456789abcdef0123456789abcdef",
      projectPath,
      resourceIdentityProjectPath: projectPath,
      environment
    });
    const userSkill = catalog.resources.find(
      ({ name }) => name === ".claude:user-only"
    );
    const projectSkill = catalog.resources.find(
      ({ name }) => name === ".claude:project-only"
    );
    const sharedSkills = catalog.resources.filter(
      ({ name }) => name === ".claude:shared"
    );
    expect(userSkill).toMatchObject({
      source: "user",
      executionSupport: "koed_managed",
      invocation: "native_skill"
    });
    expect(projectSkill).toMatchObject({
      source: "project",
      executionSupport: "koed_managed",
      invocation: "native_skill"
    });
    expect(sharedSkills.length).toBeGreaterThan(0);
    expect(
      sharedSkills.every(
        ({ executionSupport }) => executionSupport === "inventory_only"
      )
    ).toBe(true);
  });

  it("keeps a Project Skill identity across its verified execution checkout", async () => {
    const sourceRoot = temporaryProject();
    const checkoutRoot = temporaryProject();
    const executablePath = join(sourceRoot, "codex");
    const relativeSkillPath = join(".agents", "skills", "review", "SKILL.md");
    const sourceSkillPath = join(sourceRoot, relativeSkillPath);
    const checkoutSkillPath = join(checkoutRoot, relativeSkillPath);
    mkdirSync(join(sourceRoot, ".agents", "skills", "review"), {
      recursive: true
    });
    mkdirSync(join(checkoutRoot, ".agents", "skills", "review"), {
      recursive: true
    });
    writeFileSync(executablePath, "native test executable");
    chmodSync(executablePath, 0o700);
    writeFileSync(sourceSkillPath, "name: review\n");
    writeFileSync(checkoutSkillPath, "name: review\n");
    mockSkillPath.current = sourceSkillPath;
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
      projectPath: sourceRoot,
      resourceIdentityProjectPath: sourceRoot
    };

    const catalog = await discoverConfiguredAiClientResources(scope);
    mockSkillPath.current = checkoutSkillPath;
    const selected = await revalidateSelectedNativeSkills({
      ...scope,
      projectPath: checkoutRoot,
      resourceIdentityProjectPath: sourceRoot,
      selectedResourceIds: [catalog.resources[0]!.resourceId]
    });

    expect(selected[0]).toMatchObject({
      resourceId: catalog.resources[0]!.resourceId,
      providerPath: realpathSync(checkoutSkillPath)
    });

    await expect(
      revalidateSelectedNativeSkills({
        ...scope,
        projectPath: checkoutRoot,
        resourceIdentityProjectPath: checkoutRoot,
        selectedResourceIds: [catalog.resources[0]!.resourceId]
      })
    ).rejects.toThrow("AiClientResourceSelectionStale");
  });

  it("binds a Claude Project Skill to its source root while revalidating the checkout root", async () => {
    const fixtureRoot = temporaryProject();
    const sourceRoot = temporaryProject();
    const checkoutRoot = temporaryProject();
    const configRoot = join(fixtureRoot, "claude-profile");
    const executablePath = join(fixtureRoot, "claude.mjs");
    const writeProjectSkill = (projectRoot: string) => {
      const skillDirectory = join(
        projectRoot,
        ".claude",
        "skills",
        "review-folder"
      );
      mkdirSync(skillDirectory, { recursive: true });
      writeFileSync(
        join(skillDirectory, "SKILL.md"),
        "---\nname: project-review\ndescription: Project fixture.\n---\nReview.\n"
      );
    };
    mkdirSync(configRoot, { recursive: true });
    writeProjectSkill(sourceRoot);
    writeProjectSkill(checkoutRoot);
    writeFileSync(
      executablePath,
      `if (process.argv[2] === "--version") { process.stdout.write("2.1.226 (Claude Code)\\n"); process.exit(0); }\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["plugin", "list", "--json"])) process.exit(42);\nprocess.stdout.write(JSON.stringify({ plugins: [] }));\n`
    );
    mockClaudeState.commands = [
      { name: ".claude:project-review", description: "Project Skill." }
    ];
    const environment = {
      HOME: join(fixtureRoot, "home"),
      CLAUDE_CONFIG_DIR: realpathSync(configRoot),
      PATH: "/usr/bin:/bin",
      TMPDIR: fixtureRoot
    };
    mkdirSync(environment.HOME);
    const scope = {
      instance: {
        instanceId: "claude.project",
        driverId: "claude",
        displayName: "Claude Code",
        executablePath,
        configHome: realpathSync(configRoot)
      },
      ownerUserId: "00000000-0000-4000-8000-000000000001",
      hostedInstanceId: "runner-test-instance",
      computerLabel: null,
      projectId: "lp_0123456789abcdef0123456789abcdef",
      projectPath: sourceRoot,
      resourceIdentityProjectPath: sourceRoot,
      environment
    };
    const catalog = await discoverConfiguredAiClientResources(scope);
    const resource = catalog.resources.find(
      ({ name }) => name === ".claude:project-review"
    );
    expect(resource).toMatchObject({
      source: "project",
      availability: "available",
      executionSupport: "koed_managed",
      invocation: "native_skill"
    });
    mockClaudeState.options = [];
    const selected = await revalidateSelectedNativeSkills({
      ...scope,
      projectPath: checkoutRoot,
      resourceIdentityProjectPath: sourceRoot,
      selectedResourceIds: [resource!.resourceId]
    });
    expect(selected[0]).toMatchObject({
      resourceId: resource!.resourceId,
      providerKind: "claude_root",
      providerPath: realpathSync(join(checkoutRoot, ".claude")),
      name: ".claude:project-review"
    });
    await expect(
      revalidateSelectedNativeSkills({
        ...scope,
        projectPath: checkoutRoot,
        resourceIdentityProjectPath: checkoutRoot,
        selectedResourceIds: [resource!.resourceId]
      })
    ).rejects.toThrow("AiClientResourceSelectionStale");
  });

  it("keeps enabled Plugin inventory but marks it unsupported on an unverified Claude CLI version", async () => {
    const fixtureRoot = temporaryProject();
    const pluginRoot = join(fixtureRoot, "plugin");
    const executablePath = join(fixtureRoot, "claude.mjs");
    mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "fixture-plugin", version: "1.0.0" })
    );
    writeFileSync(
      executablePath,
      `if (process.argv[2] === "--version") { process.stdout.write("2.1.225 (Claude Code)\\n"); process.exit(0); }\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["plugin", "list", "--json"])) process.exit(42);\nprocess.stdout.write(JSON.stringify({ plugins: [{ enabled: true, installPath: ${JSON.stringify(pluginRoot)} }] }));\n`
    );
    const home = join(fixtureRoot, "home");
    const configRoot = join(fixtureRoot, "claude-profile");
    mkdirSync(home);
    mkdirSync(configRoot);
    const catalog = await discoverConfiguredAiClientResources({
      instance: {
        instanceId: "claude.other-version",
        driverId: "claude",
        displayName: "Claude Code",
        executablePath,
        configHome: configRoot
      },
      ownerUserId: "00000000-0000-4000-8000-000000000001",
      hostedInstanceId: "runner-test-instance",
      computerLabel: null,
      projectId: null,
      projectPath: null,
      environment: {
        HOME: home,
        CLAUDE_CONFIG_DIR: configRoot,
        PATH: "/usr/bin:/bin",
        TMPDIR: fixtureRoot
      }
    });
    expect(catalog.resources).toMatchObject([
      {
        kind: "plugin",
        name: "fixture-plugin",
        availability: "configured",
        executionSupport: "inventory_only",
        invocation: null
      }
    ]);
    expect(mockClaudeState.options).toHaveLength(0);
  });

  it("rejects a Project Skill whose canonical path escapes its bound checkout", async () => {
    const sourceRoot = temporaryProject();
    const checkoutRoot = temporaryProject();
    const otherProjectRoot = temporaryProject();
    const executablePath = join(sourceRoot, "codex");
    const relativeSkillPath = join(".agents", "skills", "review", "SKILL.md");
    const sourceSkillPath = join(sourceRoot, relativeSkillPath);
    const otherSkillPath = join(otherProjectRoot, relativeSkillPath);
    mkdirSync(join(sourceRoot, ".agents", "skills", "review"), {
      recursive: true
    });
    mkdirSync(join(otherProjectRoot, ".agents", "skills", "review"), {
      recursive: true
    });
    writeFileSync(executablePath, "native test executable");
    chmodSync(executablePath, 0o700);
    writeFileSync(sourceSkillPath, "name: review\n");
    writeFileSync(otherSkillPath, "name: review\n");
    mockSkillPath.current = sourceSkillPath;
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
      projectPath: sourceRoot
    };
    const catalog = await discoverConfiguredAiClientResources(scope);
    mockSkillPath.current = otherSkillPath;

    await expect(
      revalidateSelectedNativeSkills({
        ...scope,
        projectPath: checkoutRoot,
        resourceIdentityProjectPath: sourceRoot,
        selectedResourceIds: [catalog.resources[0]!.resourceId]
      })
    ).rejects.toThrow("AiClientResourceSelectionStale");
  });
});
