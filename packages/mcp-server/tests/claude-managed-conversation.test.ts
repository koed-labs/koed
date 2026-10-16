import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  Options,
  Query,
  SDKMessage,
  SessionStore
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  query: vi.fn(),
  forkSession: vi.fn(),
  createSdkMcpServer: vi.fn()
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...actual,
    query: sdk.query,
    forkSession: sdk.forkSession,
    createSdkMcpServer: (
      ...args: Parameters<typeof actual.createSdkMcpServer>
    ) => {
      sdk.createSdkMcpServer(...args);
      return actual.createSdkMcpServer(...args);
    }
  };
});

import {
  ClaudeManagedConversationCancelledError,
  ClaudeManagedConversationInstructionIsolationError,
  ClaudeManagedConversationSession,
  cleanupAbandonedManagedClaudeHomes,
  createManagedClaudeSessionStore,
  destroyManagedClaudeHome,
  forkClaudeTranscript,
  managedClaudeInstructionHomeVersion,
  markManagedClaudeInstructionHome,
  prepareManagedClaudeHome,
  releaseManagedClaudeHomeLease,
  retainManagedClaudeHome,
  reuseManagedClaudeHome,
  resolveClaudeManagedConversationSource
} from "../src/claude-managed-conversation.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  sdk.query.mockReset();
  sdk.forkSession.mockReset();
  sdk.createSdkMcpServer.mockClear();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const fixture = () => {
  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "koed-claude-managed-conversation-")
  );
  temporaryDirectories.push(cwd);
  const executable = path.join(cwd, "claude-real");
  const configuredExecutable = path.join(cwd, "claude-configured");
  fs.writeFileSync(executable, "not executed by these tests", { mode: 0o700 });
  fs.symlinkSync(executable, configuredExecutable);
  const managedHome = path.join(cwd, "managed-session-store");
  fs.mkdirSync(path.join(managedHome, "projects"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".claude"));
  return {
    cwd,
    managedHome,
    executable,
    configuredExecutable,
    config: {
      cwd,
      model: "claude-test-model",
      permissionMode: "dontAsk" as const,
      clientName: "managed-conversation-test",
      env: {
        HOME: cwd,
        PATH: process.env.PATH,
        KOED_CLAUDE_CODE_EXECUTABLE: configuredExecutable,
        ANTHROPIC_API_KEY: "must-not-leak",
        UNRELATED_SECRET: "also-must-not-leak"
      },
      managedHome
    }
  };
};

const managedHomeFixture = () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "koed-claude-home-lease-")
  );
  temporaryDirectories.push(root);
  const sourceHome = path.join(root, "source-claude");
  fs.mkdirSync(sourceHome);
  fs.writeFileSync(
    path.join(sourceHome, ".credentials.json"),
    JSON.stringify({ token: "test-only" }),
    { mode: 0o600 }
  );
  return {
    root,
    env: {
      HOME: root,
      KOED_HOME: path.join(root, "koed"),
      CLAUDE_CONFIG_DIR: sourceHome
    }
  };
};

const successResult = (sessionId: string, text = "done"): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: text,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {},
    modelUsage: { "claude-result-model": {} },
    permission_denials: [],
    uuid: randomUUID(),
    session_id: sessionId
  }) as unknown as SDKMessage;

const queryFrom = (messages: SDKMessage[]): Query => {
  async function* generate(): AsyncGenerator<SDKMessage, void> {
    for (const message of messages) {
      yield message;
    }
  }
  const stream = generate() as Query;
  stream.close = vi.fn();
  return stream;
};

const queryOptions = (callIndex = 0): Options => {
  const invocation = sdk.query.mock.calls[callIndex]?.[0] as
    | { options?: Options }
    | undefined;
  if (!invocation?.options) {
    throw new Error(`SDK query ${callIndex} has no options`);
  }
  return invocation.options;
};

describe("ClaudeManagedConversationSession", () => {
  it("reports live Bash tool-use and tool-result messages without transcript parsing", async () => {
    const { config } = fixture();
    const publicProgress =
      vi.fn<(event: { turnId: string; id: string; title: string }) => void>();
    const commandEvents: Array<{
      phase: string;
      command: string;
      result?: string;
    }> = [];
    sdk.query.mockImplementation(({ options }: { options?: Options }) =>
      queryFrom([
        {
          type: "assistant",
          session_id: options!.sessionId!,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-use-1",
                name: "Bash",
                input: { command: "pnpm test" }
              }
            ]
          }
        } as unknown as SDKMessage,
        {
          type: "user",
          session_id: options!.sessionId!,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-use-1",
                content: "3 tests passed"
              }
            ]
          }
        } as unknown as SDKMessage,
        successResult(options!.sessionId!)
      ])
    );
    const session = new ClaudeManagedConversationSession({
      ...config,
      onCommandExecutionEvent: (event) => commandEvents.push(event),
      onUserFacingProgress: publicProgress
    });
    try {
      await session.start();
      await session.prompt("Run the tests");
      expect(
        publicProgress.mock.calls.map(([event]) => ({
          id: event.id,
          title: event.title
        }))
      ).toEqual([
        { id: "tool-use-1", title: "Using Bash" },
        { id: "tool-use-1", title: "Tool finished" }
      ]);
      expect(commandEvents).toEqual([
        { phase: "started", command: "pnpm test" },
        {
          phase: "completed",
          command: "pnpm test",
          result: "3 tests passed"
        }
      ]);
    } finally {
      await session.closeAndWait();
    }
  });

  it("preserves Claude's native HOME default secure-storage namespace", async () => {
    const { config } = fixture();
    const callerOverride = path.join(
      config.managedHome,
      "other-claude-profile"
    );
    fs.mkdirSync(callerOverride);
    config.env = {
      ...config.env,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: callerOverride
    };
    sdk.query.mockImplementation(({ options }: { options?: Options }) =>
      queryFrom([successResult(options?.sessionId as string, "hello")])
    );
    const session = new ClaudeManagedConversationSession(config);

    try {
      await session.start("Hello");

      expect(queryOptions().env?.HOME).toBe(config.env.HOME);
      expect(queryOptions().env?.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(queryOptions().env?.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(
        process.platform === "darwin" || process.platform === "win32"
          ? ""
          : undefined
      );
    } finally {
      await session.closeAndWait();
    }
  });

  it("pins secure storage to the configured Claude profile without changing hook isolation", async () => {
    const { config, cwd } = fixture();
    const selectedProfile = path.join(cwd, "selected-claude-profile");
    const selectedProfileAlias = path.join(
      cwd,
      "selected-claude-profile-alias"
    );
    const callerOverride = path.join(cwd, "other-claude-profile");
    fs.mkdirSync(selectedProfile);
    fs.mkdirSync(callerOverride);
    fs.symlinkSync(selectedProfile, selectedProfileAlias);
    config.env = {
      ...config.env,
      CLAUDE_CONFIG_DIR: selectedProfileAlias,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: callerOverride
    };
    config.instructionOnly = true;
    sdk.query.mockImplementation(({ options }: { options?: Options }) =>
      queryFrom([successResult(options?.sessionId as string, "hello")])
    );
    const session = new ClaudeManagedConversationSession(config);

    try {
      await session.start("Hello");

      const options = queryOptions();
      const canonicalProfile = fs.realpathSync(selectedProfile);
      expect(options.env?.CLAUDE_CONFIG_DIR).toBe(canonicalProfile);
      expect(options.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(
        process.platform === "darwin" || process.platform === "win32"
          ? canonicalProfile
          : undefined
      );
      expect(options.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR).not.toBe(
        callerOverride
      );
      expect(options.settingSources).toEqual([]);
      expect(options.settings).toEqual({
        disableAllHooks: true,
        permissions: { ask: ["*"] }
      });
    } finally {
      await session.closeAndWait();
    }
  });

  it("isolates instruction-only prompts while preserving permissions, tools, prompt, and response identity", async () => {
    const { config, cwd } = fixture();
    const userHome = path.join(cwd, "user-home");
    fs.mkdirSync(path.join(userHome, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(userHome, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Bash"], defaultMode: "bypassPermissions" },
        hooks: { PreToolUse: [{ command: "must-not-run" }] }
      })
    );
    fs.writeFileSync(
      path.join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Bash"], defaultMode: "bypassPermissions" },
        hooks: { PreToolUse: [{ command: "must-not-run" }] }
      })
    );
    const publicPrompt = "Keep this exact public prompt";
    const systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: "Project guidance snapshot"
    } as const;
    const tools = ["Read", "Grep"] as Options["tools"];
    const allowedTools = ["Read"];
    const canUseTool = vi.fn() as unknown as NonNullable<Options["canUseTool"]>;
    const configuredMcpServers = {
      allowed_runtime: { command: "/koed/test-runtime", args: [] }
    };
    const progress: Array<{ turnId: string; id: string; title: string }> = [];
    sdk.query.mockImplementation(({ options }: { options?: Options }) =>
      queryFrom([successResult(options?.sessionId as string, "reply")])
    );
    const session = new ClaudeManagedConversationSession({
      ...config,
      env: { ...config.env, HOME: userHome },
      instructionOnly: true,
      projectInstructionStatus: "loaded",
      settingSources: ["user", "project"],
      tools,
      allowedTools,
      canUseTool,
      mcpServers: configuredMcpServers,
      systemPrompt,
      onUserFacingProgress: (event) => progress.push(event)
    });

    try {
      const started = await session.start(publicPrompt);
      const result = started.initialResult;
      const options = queryOptions();
      const invocation = sdk.query.mock.calls[0]?.[0] as { prompt: string };

      expect(invocation.prompt).toBe(publicPrompt);
      expect(options.systemPrompt).toBe(systemPrompt);
      expect(options.settingSources).toEqual([]);
      expect(options.permissionMode).toBe("dontAsk");
      expect(options.allowDangerouslySkipPermissions).toBeUndefined();
      expect(options.tools).toEqual(tools);
      expect(options.allowedTools).toEqual(allowedTools);
      expect(options.canUseTool).toBe(canUseTool);
      expect(options.mcpServers).toMatchObject(configuredMcpServers);
      expect(options.strictMcpConfig).toBe(true);
      expect(result).toMatchObject({
        provider: "claude",
        sessionId: started.identity.sessionId,
        model: "claude-result-model",
        text: "reply"
      });
      expect(progress).toHaveLength(1);
      expect(progress[0]).toMatchObject({
        title:
          "Loaded the root CLAUDE.md snapshot only; imports and nested rules were not loaded"
      });
      expect(progress[0]?.id).toBe(
        `project-instructions-${progress[0]?.turnId}`
      );
      expect(progress[0]?.title).not.toContain(cwd);
      expect(progress[0]?.title).not.toContain("Project guidance snapshot");
    } finally {
      await session.closeAndWait();
    }
  });

  it("fails before SDK submission when instruction-only isolation has selected skills", async () => {
    const { config } = fixture();
    const progress = vi.fn();
    const session = new ClaudeManagedConversationSession({
      ...config,
      instructionOnly: true,
      projectInstructionStatus: "loaded",
      settingSources: ["user", "project"],
      onUserFacingProgress: progress
    });

    try {
      const failure = await session
        .prompt("Run the selected skill", ["project:skill"])
        .then(
          () => undefined,
          (error: unknown) => error as Error
        );
      expect(failure).toBeInstanceOf(
        ClaudeManagedConversationInstructionIsolationError
      );
      expect(failure?.message).toContain(
        "Selected Claude Skills require a verified native Claude definition"
      );
      expect(failure?.message.length).toBeLessThan(200);
      expect(failure?.message).not.toContain("project:skill");
      expect(sdk.query).not.toHaveBeenCalled();
      expect(progress).not.toHaveBeenCalled();
    } finally {
      await session.closeAndWait();
    }
  });

  it("keeps ordinary managed turns isolated and rejects selected skills before a follow-up query", async () => {
    const { config } = fixture();
    sdk.query.mockImplementation(({ options }: { options?: Options }) =>
      queryFrom([successResult(options?.sessionId as string, "hello")])
    );
    const session = new ClaudeManagedConversationSession(config);

    try {
      await session.prompt("Ordinary isolated prompt");
      expect(queryOptions().settingSources).toEqual([]);
      expect(queryOptions().strictMcpConfig).toBe(true);
      expect(queryOptions().skills).toBeUndefined();

      const failure = await session
        .prompt("Use the selected skill", ["skill"])
        .then(
          () => undefined,
          (error: unknown) => error as Error
        );
      expect(failure).toBeInstanceOf(
        ClaudeManagedConversationInstructionIsolationError
      );
      expect(failure?.message).toContain("filesystem settings are disabled");
      expect(sdk.query).toHaveBeenCalledTimes(1);
    } finally {
      await session.closeAndWait();
    }
  });

  it("loads only revalidated plugin and raw .claude Skills without widening turn permissions", async () => {
    const { config, cwd } = fixture();
    const canonicalCwd = fs.realpathSync(cwd);
    const pluginRoot = path.join(canonicalCwd, "configured-plugin");
    const projectClaudeRoot = path.join(canonicalCwd, ".claude");
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), {
      recursive: true
    });
    fs.writeFileSync(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "review-plugin" })
    );
    fs.mkdirSync(path.join(pluginRoot, "skills", "bounded-review"), {
      recursive: true
    });
    fs.writeFileSync(
      path.join(pluginRoot, "skills", "bounded-review", "SKILL.md"),
      "---\nname: bounded-review\ndescription: fixture\n---\n"
    );
    fs.mkdirSync(path.join(projectClaudeRoot, "skills", "local-review"), {
      recursive: true
    });
    fs.writeFileSync(
      path.join(projectClaudeRoot, "skills", "local-review", "SKILL.md"),
      "---\nname: local-review\ndescription: fixture\n---\n"
    );

    const tools: NonNullable<Options["tools"]> = ["Read", "Grep"];
    const allowedTools = ["Read", "Grep"];
    const canUseTool: NonNullable<Options["canUseTool"]> = vi.fn(async () => ({
      behavior: "deny",
      message: "Denied in fixture"
    }));
    const configuredMcpServers = {
      koed: { type: "http" as const, url: "http://127.0.0.1:3300/mcp" }
    };
    sdk.query.mockImplementation(({ options }: { options?: Options }) =>
      queryFrom([successResult(options?.sessionId as string, "hello")])
    );
    const session = new ClaudeManagedConversationSession({
      ...config,
      tools,
      allowedTools,
      canUseTool,
      mcpServers: configuredMcpServers,
      settingSources: []
    });

    try {
      await session.prompt(
        "Use selected plugin Skill",
        ["review-plugin:bounded-review"],
        [
          {
            name: "review-plugin:bounded-review",
            providerKind: "plugin",
            providerPath: pluginRoot
          }
        ]
      );

      const options = queryOptions(0);
      expect(options.settingSources).toEqual([]);
      expect(options.settings).toEqual({
        disableAllHooks: true,
        permissions: { ask: ["*"] }
      });
      expect(options.plugins).toEqual([
        { type: "local", path: pluginRoot, skipMcpDiscovery: true }
      ]);
      expect(options.skills).toEqual(["review-plugin:bounded-review"]);
      expect(
        (sdk.query.mock.calls[0]?.[0] as { prompt?: unknown } | undefined)
          ?.prompt
      ).toBe("/review-plugin:bounded-review Use selected plugin Skill");
      expect(options.strictMcpConfig).toBe(true);
      expect(options.mcpServers).toMatchObject(configuredMcpServers);
      expect(options.tools).toEqual(tools);
      expect(options.allowedTools).toEqual(allowedTools);
      expect(options.canUseTool).toBe(canUseTool);
      expect(options.allowDangerouslySkipPermissions).toBeUndefined();

      await session.prompt(
        "Use selected Project Skill",
        [".claude:local-review"],
        [
          {
            name: ".claude:local-review",
            providerKind: "claude_root",
            providerPath: projectClaudeRoot
          }
        ]
      );
      expect(queryOptions(1).plugins).toEqual([
        { type: "local", path: projectClaudeRoot, skipMcpDiscovery: true }
      ]);
      expect(queryOptions(1).skills).toEqual([".claude:local-review"]);
      expect(
        (sdk.query.mock.calls[1]?.[0] as { prompt?: unknown } | undefined)
          ?.prompt
      ).toBe("/.claude:local-review Use selected Project Skill");
    } finally {
      await session.closeAndWait();
    }
  });

  it("keeps isolated query controls active when no Skill is selected", async () => {
    const { config } = fixture();
    sdk.query.mockImplementation(({ options }: { options?: Options }) =>
      queryFrom([successResult(options?.sessionId as string, "hello")])
    );
    const session = new ClaudeManagedConversationSession(config);
    try {
      await session.start("Hello");
      expect(queryOptions().settingSources).toEqual([]);
      expect(queryOptions().settings).toEqual({
        disableAllHooks: true,
        permissions: { ask: ["*"] }
      });
      expect(queryOptions().skills).toBeUndefined();
    } finally {
      await session.closeAndWait();
    }
  });

  it("does not override explicit nonempty filesystem setting sources", async () => {
    const { config } = fixture();
    sdk.query.mockImplementation(({ options }: { options?: Options }) =>
      queryFrom([successResult(options?.sessionId as string, "hello")])
    );
    const session = new ClaudeManagedConversationSession({
      ...config,
      settingSources: ["user", "project"]
    });
    try {
      await session.start("Hello");
      expect(queryOptions().settingSources).toEqual(["user", "project"]);
      expect(queryOptions().settings).toBeUndefined();
    } finally {
      await session.closeAndWait();
    }
  });

  it("rejects ambiguous duplicate native names before SDK submission", async () => {
    const { config, cwd } = fixture();
    const homeClaudeRoot = path.join(cwd, "home", ".claude");
    const projectClaudeRoot = path.join(cwd, ".claude");
    for (const root of [homeClaudeRoot, projectClaudeRoot]) {
      fs.mkdirSync(path.join(root, "skills", "shared"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "skills", "shared", "SKILL.md"),
        "---\nname: shared\ndescription: fixture\n---\n"
      );
    }
    const session = new ClaudeManagedConversationSession({
      ...config,
      settingSources: []
    });

    try {
      await expect(
        session.prompt(
          "Use the ambiguous Skill",
          [".claude:shared"],
          [
            {
              name: ".claude:shared",
              providerKind: "claude_root",
              providerPath: homeClaudeRoot
            },
            {
              name: ".claude:shared",
              providerKind: "claude_root",
              providerPath: projectClaudeRoot
            }
          ]
        )
      ).rejects.toBeInstanceOf(
        ClaudeManagedConversationInstructionIsolationError
      );
      expect(sdk.query).not.toHaveBeenCalled();
    } finally {
      await session.closeAndWait();
    }
  });

  it.each([
    ["without the managed tool callback", false, false],
    ["multiple selected Skills", true, true]
  ])(
    "fails closed for native Skill selection %s",
    async (_label, hasCallback, multipleSkills) => {
      const { config, cwd } = fixture();
      const pluginRoot = path.join(cwd, "bounded-plugin");
      fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), {
        recursive: true
      });
      fs.writeFileSync(
        path.join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "bounded-plugin" })
      );
      for (const name of ["first", "second"]) {
        const directory = path.join(pluginRoot, "skills", name);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
          path.join(directory, "SKILL.md"),
          `---\nname: ${name}\ndescription: fixture\n---\n`
        );
      }
      const selectedNames = multipleSkills
        ? ["bounded-plugin:first", "bounded-plugin:second"]
        : ["bounded-plugin:first"];
      const session = new ClaudeManagedConversationSession({
        ...config,
        settingSources: [],
        ...(hasCallback
          ? {
              canUseTool: async () => ({
                behavior: "deny" as const,
                message: "Denied in fixture"
              })
            }
          : {})
      });
      try {
        await expect(
          session.prompt(
            "Use the selected native Skill",
            selectedNames,
            selectedNames.map((name) => ({
              name,
              providerKind: "plugin" as const,
              providerPath: pluginRoot
            }))
          )
        ).rejects.toBeInstanceOf(
          ClaudeManagedConversationInstructionIsolationError
        );
        expect(sdk.query).not.toHaveBeenCalled();
      } finally {
        await session.closeAndWait();
      }
    }
  );

  it("rejects selected skills with explicitly empty settings sources before SDK submission", async () => {
    const { config } = fixture();
    const session = new ClaudeManagedConversationSession({
      ...config,
      settingSources: []
    });

    try {
      const failure = await session
        .prompt("Run the selected skill", ["skill"])
        .then(
          () => undefined,
          (error: unknown) => error as Error
        );
      expect(failure).toBeInstanceOf(
        ClaudeManagedConversationInstructionIsolationError
      );
      expect(sdk.query).not.toHaveBeenCalled();
    } finally {
      await session.closeAndWait();
    }
  });

  it("rejects selected skills before SDK submission on a resumed isolated session", async () => {
    const { config } = fixture();
    const session = new ClaudeManagedConversationSession({
      ...config,
      resumeSessionId: randomUUID()
    });

    try {
      const failure = await session
        .prompt("Continue with the selected skill", ["skill"])
        .then(
          () => undefined,
          (error: unknown) => error as Error
        );
      expect(failure).toBeInstanceOf(
        ClaudeManagedConversationInstructionIsolationError
      );
      expect(sdk.query).not.toHaveBeenCalled();
    } finally {
      await session.closeAndWait();
    }
  });

  it("preserves explicitly configured settings sources for generic selected-skill callers", async () => {
    const { config } = fixture();
    sdk.query.mockImplementation(({ options }: { options?: Options }) =>
      queryFrom([successResult(options?.sessionId as string, "hello")])
    );
    const session = new ClaudeManagedConversationSession({
      ...config,
      settingSources: ["user"]
    });

    try {
      await session.prompt("Use the selected skill", ["skill"]);
      expect(queryOptions().settingSources).toEqual(["user"]);
      expect(queryOptions().skills).toEqual(["skill"]);
      expect(
        (sdk.query.mock.calls[0]?.[0] as { prompt?: unknown } | undefined)
          ?.prompt
      ).toBe("Use the selected skill");
      expect(queryOptions().settings).toBeUndefined();
    } finally {
      await session.closeAndWait();
    }
  });

  it.each([
    ["absent", "No root CLAUDE.md snapshot was found"],
    [
      "standalone",
      "Standalone Conversation; no Project instructions were loaded"
    ]
  ] as const)(
    "shows the bounded %s instruction status",
    async (status, expectedTitle) => {
      const { config, cwd } = fixture();
      const progress: Array<{ turnId: string; id: string; title: string }> = [];
      sdk.query.mockImplementation(({ options }: { options?: Options }) =>
        queryFrom([successResult(options?.sessionId as string, "hello")])
      );
      const session = new ClaudeManagedConversationSession({
        ...config,
        instructionOnly: true,
        projectInstructionStatus: status,
        onUserFacingProgress: (event) => progress.push(event)
      });

      try {
        await session.start("Hello");
        expect(progress).toHaveLength(1);
        expect(progress[0]?.title).toBe(expectedTitle);
        expect(progress[0]?.title).not.toContain(cwd);
      } finally {
        await session.closeAndWait();
      }
    }
  );

  it("retains main and child transcripts for exact managed resume and capture", async () => {
    const { managedHome } = fixture();
    const store = createManagedClaudeSessionStore(managedHome);
    const key = { projectKey: "/test-project", sessionId: randomUUID() };
    const parent = [
      { type: "user", uuid: randomUUID(), message: { content: "Parent" } }
    ];
    const child = [
      { type: "assistant", uuid: randomUUID(), message: { content: "Child" } }
    ];
    await store.append(key, parent);
    await store.append(
      { ...key, subpath: "subagents/agent-child1.jsonl" },
      child
    );
    expect(await store.load(key)).toEqual(parent);
    expect(await store.listSubkeys!(key)).toEqual([
      "subagents/agent-child1.jsonl"
    ]);
    expect(
      await store.load({ ...key, subpath: "subagents/agent-child1.jsonl" })
    ).toEqual(child);
  });

  it.each(["default", "acceptEdits", "auto", "bypassPermissions"] as const)(
    "runs with native permission mode %s",
    async (permissionMode) => {
      const { config } = fixture();
      sdk.query.mockImplementation(({ options }: { options?: Options }) =>
        queryFrom([successResult(options?.sessionId as string, "hello")])
      );
      const session = new ClaudeManagedConversationSession({
        ...config,
        permissionMode
      });
      try {
        await session.start("Hello");
        expect(queryOptions().permissionMode).toBe(
          permissionMode === "default" ? undefined : permissionMode
        );
        expect(queryOptions().allowDangerouslySkipPermissions).toBe(
          permissionMode === "bypassPermissions" ? true : undefined
        );
      } finally {
        await session.closeAndWait();
      }
    }
  );

  it.each(["low", "high", "xhigh", "max", "none"])(
    "passes the selected reasoning effort %s to the native SDK",
    async (reasoningEffort) => {
      const { config } = fixture();
      sdk.query.mockImplementation(({ options }: { options?: Options }) =>
        queryFrom([successResult(options?.sessionId as string, "hello")])
      );
      const session = new ClaudeManagedConversationSession({
        ...config,
        reasoningEffort
      });
      try {
        await session.start("Hello");
        expect(queryOptions().effort).toBe(
          reasoningEffort === "none" ? undefined : reasoningEffort
        );
      } finally {
        await session.closeAndWait();
      }
    }
  );

  it("preserves an actionable authentication failure after successful start without replaying the prompt", async () => {
    const { config } = fixture();
    sdk.query.mockImplementation(({ options }: { options?: Options }) =>
      queryFrom([
        {
          type: "assistant",
          session_id: options!.sessionId!,
          error: "authentication_failed",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Not logged in · Please run /login secret diagnostic"
              }
            ]
          }
        } as unknown as SDKMessage
      ])
    );
    const session = new ClaudeManagedConversationSession(config);
    try {
      await session.start();
      await expect(
        session.prompt("Preserve this first prompt")
      ).rejects.toMatchObject({
        name: "ManagedConversationAuthenticationError",
        message: "ManagedConversationAuthenticationError"
      });
      expect(sdk.query).toHaveBeenCalledTimes(1);
    } finally {
      await session.closeAndWait();
    }
  });

  it("uses the official SessionStore fork path and returns SDK-remapped JSONL", async () => {
    const { cwd } = fixture();
    const parentSessionId = randomUUID();
    const childSessionId = randomUUID();
    const parentMessageId = randomUUID();
    sdk.forkSession.mockImplementation(
      async (sessionId: string, options?: { sessionStore?: SessionStore }) => {
        const store = options?.sessionStore;
        if (!store) throw new Error("missing SessionStore");
        const entries = await store.load({
          projectKey: "sdk-owned-project-key",
          sessionId
        });
        await store.append(
          { projectKey: "sdk-owned-project-key", sessionId: childSessionId },
          (entries ?? []).map((entry) => ({
            ...entry,
            sessionId: childSessionId,
            uuid: randomUUID()
          }))
        );
        return { sessionId: childSessionId };
      }
    );

    const fork = await forkClaudeTranscript({
      parentSessionId,
      cwd,
      transcriptBytes: Buffer.from(
        `${JSON.stringify({
          type: "user",
          uuid: parentMessageId,
          sessionId: parentSessionId,
          message: { role: "user", content: "hello" }
        })}\n`
      )
    });

    const forkInvocation = sdk.forkSession.mock.calls[0] as unknown as [
      string,
      { dir?: string; sessionStore?: SessionStore }
    ];
    expect(forkInvocation[0]).toBe(parentSessionId);
    expect(forkInvocation[1].dir).toBe(fs.realpathSync(cwd));
    expect(forkInvocation[1].sessionStore).toBeDefined();
    expect(fork.sessionId).toBe(childSessionId);
    expect(fork.bytes.at(-1)).toBe(0x0a);
    const forkedEntry: unknown = JSON.parse(fork.bytes.toString("utf8"));
    expect(forkedEntry).toMatchObject({
      type: "user",
      sessionId: childSessionId
    });
  });

  it("forwards the canonical executable identity and a bounded, keyless environment", async () => {
    const { config, cwd, executable } = fixture();
    sdk.query.mockImplementation(({ options }: { options?: Options }) =>
      queryFrom([successResult(options?.sessionId as string, "hello")])
    );

    const session = new ClaudeManagedConversationSession(config);
    const started = await session.start("Say hello");

    expect(started.identity).toMatchObject({
      provider: "claude",
      model: config.model,
      executablePath: fs.realpathSync(executable),
      resumed: false
    });
    expect(started.identity.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    expect(started.initialResult).toMatchObject({
      provider: "claude",
      sessionId: started.identity.sessionId,
      model: "claude-result-model",
      text: "hello"
    });

    const options = queryOptions();
    expect(options.pathToClaudeCodeExecutable).toBe(
      fs.realpathSync(executable)
    );
    expect(options.cwd).toBe(fs.realpathSync(cwd));
    expect(options.model).toBe(config.model);
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.sessionId).toBe(started.identity.sessionId);
    expect(options.resume).toBeUndefined();
    expect(options.env).toMatchObject({
      HOME: cwd,
      CLAUDE_AGENT_SDK_CLIENT_APP: "koed/managed-conversation-test"
    });
    expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(options.env).not.toHaveProperty("UNRELATED_SECRET");
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.persistSession).toBe(true);
  });

  it("provides Koed recall through the selected local runtime without forwarding API credentials", async () => {
    const { config, cwd } = fixture();
    sdk.query.mockImplementation(({ options }: { options?: Options }) =>
      queryFrom([successResult(options?.sessionId as string, "hello")])
    );
    const session = new ClaudeManagedConversationSession({
      ...config,
      env: {
        ...config.env,
        KOED_HOME: cwd,
        MEMORY_API_TOKEN: "test-private-token"
      }
    });
    await session.start("Recall the Project");
    expect(queryOptions().mcpServers?.koed).toEqual({
      type: "stdio",
      command: process.execPath,
      args: [expect.stringMatching(/\/cli\.js$/)],
      env: { KOED_HOME: cwd }
    });
    session.close();
  });

  it("resumes and forks only within the exact configured Claude home", async () => {
    const { config, cwd, managedHome } = fixture();
    const sourceSessionId = randomUUID();
    const forkSessionId = randomUUID();
    const canonicalClaudeHome = path.join(cwd, "exact-claude-home");
    const claudeHome = path.join(cwd, "exact-claude-home-alias");
    fs.mkdirSync(canonicalClaudeHome);
    // macOS commonly exposes a configured home through a symlink such as
    // /var -> /private/var; the SDK must receive the canonical exact home.
    fs.symlinkSync(canonicalClaudeHome, claudeHome);
    const projectHome = path.join(managedHome, "projects", "exact-project");
    fs.mkdirSync(projectHome, { recursive: true });
    fs.writeFileSync(
      path.join(projectHome, `${sourceSessionId}.jsonl`),
      `${JSON.stringify({
        type: "user",
        sessionId: sourceSessionId,
        message: { role: "user", content: "source" }
      })}\n`
    );
    sdk.query.mockImplementation(({ options }: { options?: Options }) =>
      queryFrom([
        successResult(
          (options?.resume ?? options?.sessionId) as string,
          "continued"
        )
      ])
    );
    sdk.forkSession.mockImplementation(
      async (sessionId: string, options?: { sessionStore?: SessionStore }) => {
        const store = options?.sessionStore;
        if (!store) throw new Error("missing exact SessionStore");
        const entries = await store.load({
          projectKey: "exact-project",
          sessionId
        });
        await store.append(
          { projectKey: "exact-project", sessionId: forkSessionId },
          (entries ?? []).map((entry) => ({
            ...entry,
            sessionId: forkSessionId
          }))
        );
        return { sessionId: forkSessionId };
      }
    );

    const source = new ClaudeManagedConversationSession({
      ...config,
      env: { ...config.env, CLAUDE_CONFIG_DIR: claudeHome },
      resumeSessionId: sourceSessionId
    });
    const sourceResult = await source.prompt("Continue");
    const fork = await source.fork();
    const forkResult = await fork.prompt("Branch");

    expect(sourceResult.sessionId).toBe(sourceSessionId);
    expect(queryOptions(0).resume).toBe(sourceSessionId);
    expect(queryOptions(0).env?.CLAUDE_CONFIG_DIR).toBe(
      fs.realpathSync(claudeHome)
    );
    expect(queryOptions(0).sessionStore).toBeDefined();
    expect(queryOptions(0).sessionId).toBeUndefined();
    expect(sdk.forkSession).toHaveBeenCalledOnce();
    expect(
      fs.readFileSync(
        resolveClaudeManagedConversationSource(forkSessionId, {
          KOED_CLAUDE_SESSION_STORE_DIR: managedHome
        }).transcriptPath,
        "utf8"
      )
    ).toContain(forkSessionId);
    expect(fork.identity).toMatchObject({
      provider: "claude",
      sessionId: forkSessionId,
      resumed: true,
      forkedFromSessionId: sourceSessionId
    });
    expect(forkResult.sessionId).toBe(forkSessionId);
    expect(queryOptions(1).resume).toBe(forkSessionId);
    expect(queryOptions(1).env?.CLAUDE_CONFIG_DIR).toBe(
      fs.realpathSync(claudeHome)
    );
    expect(queryOptions(1).sessionStore).toBeDefined();
    expect(queryOptions(1).sessionId).toBeUndefined();
  });

  it("fails clearly when the configured Claude home is missing", () => {
    const { config, cwd } = fixture();

    expect(
      () =>
        new ClaudeManagedConversationSession({
          ...config,
          env: {
            ...config.env,
            CLAUDE_CONFIG_DIR: path.join(cwd, "missing-claude-home")
          }
        })
    ).toThrow("Claude config home does not exist:");
  });

  it("starts with an exact caller-owned session identity without treating it as a resume", async () => {
    const { config } = fixture();
    const sessionId = randomUUID();
    sdk.query.mockImplementation(() =>
      queryFrom([successResult(sessionId, "started")])
    );
    const session = new ClaudeManagedConversationSession({
      ...config,
      sessionId
    });

    await session.prompt("Start exactly here");

    expect(session.identity).toMatchObject({ sessionId, resumed: false });
    expect(queryOptions().sessionId).toBe(sessionId);
    expect(queryOptions().resume).toBeUndefined();
  });

  it("loads the same managed SessionStore when subsequent turns resume", async () => {
    const { config, managedHome } = fixture();
    const sessionId = randomUUID();
    const loadedEntryCounts: number[] = [];
    sdk.query.mockImplementation(({ options }: { options?: Options }) => {
      async function* run(): AsyncGenerator<SDKMessage, void> {
        const store = options?.sessionStore;
        if (!store) throw new Error("missing managed SessionStore");
        const key = { projectKey: "same-store", sessionId };
        const previous = await store.load(key);
        loadedEntryCounts.push(previous?.length ?? 0);
        await store.append(key, [
          {
            type: "user",
            sessionId,
            message: { role: "user", content: "persisted" }
          }
        ]);
        yield successResult(sessionId);
      }
      const stream = run() as Query;
      stream.close = vi.fn();
      return stream;
    });
    const session = new ClaudeManagedConversationSession({
      ...config,
      sessionId
    });

    await session.prompt("first");
    await session.prompt("second");

    expect(loadedEntryCounts).toEqual([0, 1]);
    expect(queryOptions(1).resume).toBe(sessionId);
    expect(queryOptions(1).sessionStore).toBe(queryOptions(0).sessionStore);
    expect(queryOptions(1).env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(
      resolveClaudeManagedConversationSource(sessionId, {
        KOED_CLAUDE_SESSION_STORE_DIR: managedHome
      }).managedHome
    ).toBe(fs.realpathSync(managedHome));
  });

  it("loads the exact managed Claude history after resuming from a different cwd", async () => {
    const { config, cwd, managedHome } = fixture();
    const destinationCwd = path.join(cwd, "destination-project");
    fs.mkdirSync(path.join(destinationCwd, ".claude"), { recursive: true });
    const sessionId = randomUUID();
    const projectKeyForCwd = (queryCwd: string | undefined) =>
      path.resolve(queryCwd ?? cwd);
    const loadedHistory: Array<{ cwd: string; entries: string[] }> = [];
    sdk.query.mockImplementation(
      ({ prompt, options }: { prompt: string; options?: Options }) => {
        async function* run(): AsyncGenerator<SDKMessage, void> {
          const store = options?.sessionStore;
          if (!store) throw new Error("missing managed SessionStore");
          if (options?.resume && options.resume !== sessionId) {
            throw new Error("provider was asked to resume a different session");
          }
          // The native SDK resume implementation keys its isolated transcript
          // lookup by the project key derived from options.cwd.
          const key = {
            projectKey: projectKeyForCwd(options?.cwd),
            sessionId
          };
          const previous = (await store.load(key)) ?? [];
          const history = previous.map((entry) =>
            typeof entry.message === "object" &&
            entry.message !== null &&
            "content" in entry.message
              ? String(entry.message.content)
              : "unknown"
          );
          loadedHistory.push({ cwd: key.projectKey, entries: history });
          await store.append(key, [
            {
              type: "user",
              sessionId,
              message: { role: "user", content: prompt }
            }
          ]);
          yield successResult(sessionId, `continued ${prompt}`);
        }
        const stream = run() as Query;
        stream.close = vi.fn();
        return stream;
      }
    );

    const source = new ClaudeManagedConversationSession({
      ...config,
      sessionId
    });
    await source.prompt("first project prompt");
    const resumed = new ClaudeManagedConversationSession({
      ...config,
      cwd: destinationCwd,
      resumeSessionId: sessionId
    });
    await resumed.prompt("second project prompt");

    expect(loadedHistory).toEqual([
      { cwd: fs.realpathSync(cwd), entries: [] },
      {
        cwd: fs.realpathSync(destinationCwd),
        entries: ["first project prompt"]
      }
    ]);
    expect(queryOptions(0).sessionId).toBe(sessionId);
    expect(queryOptions(0).resume).toBeUndefined();
    expect(queryOptions(1).resume).toBe(sessionId);
    expect(queryOptions(1).sessionId).toBeUndefined();
    expect(queryOptions(1).cwd).toBe(fs.realpathSync(destinationCwd));
    expect(queryOptions(1).sessionStore).not.toBe(queryOptions(0).sessionStore);
    const persisted = await createManagedClaudeSessionStore(managedHome).load({
      projectKey: fs.realpathSync(destinationCwd),
      sessionId
    });
    expect(persisted).toHaveLength(2);
    expect(resumed.identity).toMatchObject({
      provider: "claude",
      sessionId,
      cwd: fs.realpathSync(destinationCwd),
      resumed: true
    });
    await source.closeAndWait();
    await resumed.closeAndWait();
  });

  it("resolves exactly one regular transcript beneath the Claude projects home", () => {
    const { cwd } = fixture();
    const sessionId = randomUUID();
    const claudeHome = path.join(cwd, ".claude-test");
    const project = path.join(claudeHome, "projects", "fixture");
    fs.mkdirSync(project, { recursive: true });
    const transcriptPath = path.join(project, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, "{}\n");

    expect(
      resolveClaudeManagedConversationSource(sessionId, {
        KOED_CLAUDE_SESSION_STORE_DIR: claudeHome
      })
    ).toEqual({
      transcriptPath: fs.realpathSync(transcriptPath),
      managedHome: fs.realpathSync(claudeHome)
    });
  });

  it("rejects ambiguous transcript identity across Claude projects", () => {
    const { cwd } = fixture();
    const sessionId = randomUUID();
    const claudeHome = path.join(cwd, ".claude-test");
    for (const name of ["one", "two"]) {
      const project = path.join(claudeHome, "projects", name);
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), "{}\n");
    }

    expect(() =>
      resolveClaudeManagedConversationSource(sessionId, {
        KOED_CLAUDE_SESSION_STORE_DIR: claudeHome
      })
    ).toThrow("resolves to multiple transcripts");
  });

  it("fails closed when the SDK fork does not return a distinct session", async () => {
    const { config, cwd, managedHome } = fixture();
    const sourceSessionId = randomUUID();
    const claudeHome = path.join(cwd, ".claude");
    const projectHome = path.join(managedHome, "projects", "fixture");
    fs.mkdirSync(projectHome, { recursive: true });
    fs.writeFileSync(
      path.join(projectHome, `${sourceSessionId}.jsonl`),
      `${JSON.stringify({ type: "user", sessionId: sourceSessionId })}\n`
    );
    sdk.forkSession.mockResolvedValue({ sessionId: sourceSessionId });
    const source = new ClaudeManagedConversationSession({
      ...config,
      env: { ...config.env, CLAUDE_CONFIG_DIR: claudeHome },
      resumeSessionId: sourceSessionId
    });

    await expect(source.fork()).rejects.toThrow(
      "fork did not create a distinct session"
    );
    expect(sdk.query).not.toHaveBeenCalled();
  });

  it("prevents the SDK fork path from mutating its parent transcript", async () => {
    const { config, managedHome } = fixture();
    const sourceSessionId = randomUUID();
    const projectHome = path.join(managedHome, "projects", "fixture");
    const transcriptPath = path.join(projectHome, `${sourceSessionId}.jsonl`);
    const original = `${JSON.stringify({
      type: "user",
      sessionId: sourceSessionId
    })}\n`;
    fs.mkdirSync(projectHome, { recursive: true });
    fs.writeFileSync(transcriptPath, original);
    sdk.forkSession.mockImplementation(
      async (_sessionId: string, options?: { sessionStore?: SessionStore }) => {
        await options?.sessionStore?.append(
          { projectKey: "fixture", sessionId: sourceSessionId },
          [{ type: "user", sessionId: sourceSessionId }]
        );
        return { sessionId: randomUUID() };
      }
    );
    const source = new ClaudeManagedConversationSession({
      ...config,
      resumeSessionId: sourceSessionId
    });

    await expect(source.fork()).rejects.toThrow("mutate the fork parent");
    expect(fs.readFileSync(transcriptPath, "utf8")).toBe(original);
  });

  it("fails closed when the SDK reports a different session identity", async () => {
    const { config } = fixture();
    sdk.query.mockReturnValue(queryFrom([successResult(randomUUID())]));
    const session = new ClaudeManagedConversationSession(config);

    await expect(session.prompt("Check identity")).rejects.toThrow(
      "unexpected session ID"
    );
  });

  it("cancels an active SDK query through its AbortController and closes it", async () => {
    const { config } = fixture();
    let abortSignal: AbortSignal | undefined;
    const close = vi.fn();
    sdk.query.mockImplementation(({ options }: { options?: Options }) => {
      abortSignal = options?.abortController?.signal;
      async function* hang(): AsyncGenerator<SDKMessage, void> {
        await new Promise<void>((_resolve, reject) => {
          abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("aborted by test")),
            { once: true }
          );
        });
        yield successResult(randomUUID());
      }
      const stream = hang() as Query;
      stream.close = close;
      return stream;
    });

    const session = new ClaudeManagedConversationSession(config);
    const pending = session.prompt("Wait");
    await vi.waitFor(() => expect(abortSignal).toBeDefined());
    session.cancel();

    await expect(pending).rejects.toBeInstanceOf(
      ClaudeManagedConversationCancelledError
    );
    expect(abortSignal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes interrupted SDK output and resumes the exact session on retry", async () => {
    const { config } = fixture();
    const close = vi.fn();
    sdk.query
      .mockImplementationOnce(({ options }: { options?: Options }) => {
        async function* interrupt(): AsyncGenerator<SDKMessage, void> {
          yield {
            type: "system",
            subtype: "init",
            session_id: options?.sessionId
          } as unknown as SDKMessage;
          throw new Error("provider process exited during output");
        }
        const stream = interrupt() as Query;
        stream.close = close;
        return stream;
      })
      .mockImplementationOnce(({ options }: { options?: Options }) =>
        queryFrom([successResult(options?.resume as string, "recovered")])
      );

    const session = new ClaudeManagedConversationSession(config);
    await expect(session.prompt("First attempt")).rejects.toThrow(
      "provider process exited during output"
    );
    expect(close).toHaveBeenCalledOnce();

    await expect(session.prompt("Retry")).resolves.toMatchObject({
      sessionId: session.identity.sessionId,
      text: "recovered"
    });
    expect(queryOptions(1)).toMatchObject({
      resume: session.identity.sessionId
    });
    expect(queryOptions(1).sessionId).toBeUndefined();
  });

  it("propagates SDK startup failures without attempting another transport", async () => {
    const { config } = fixture();
    sdk.query.mockImplementation(() => {
      throw new Error("SDK transport unavailable");
    });
    const session = new ClaudeManagedConversationSession(config);

    await expect(session.prompt("Fail")).rejects.toThrow(
      "SDK transport unavailable"
    );
    expect(sdk.query).toHaveBeenCalledOnce();
  });
});

describe("managed Claude home leases", () => {
  it("preserves an active preparing home even when a cleanup observer reports a stale owner", () => {
    const { env } = managedHomeFixture();
    const managedHome = prepareManagedClaudeHome(env);

    expect(
      cleanupAbandonedManagedClaudeHomes(env, {
        staleAfterMs: 0,
        isProcessAlive: () => false
      })
    ).toEqual([]);
    expect(fs.existsSync(managedHome)).toBe(true);

    destroyManagedClaudeHome(managedHome, env);
  });

  it("marks new instruction homes in the signed marker and preserves legacy homes", () => {
    const { env } = managedHomeFixture();
    const managedHome = prepareManagedClaudeHome(env);

    expect(
      managedClaudeInstructionHomeVersion(managedHome, env)
    ).toBeUndefined();
    expect(markManagedClaudeInstructionHome(managedHome, env)).toBe(
      managedHome
    );
    expect(managedClaudeInstructionHomeVersion(managedHome, env)).toBe(1);

    retainManagedClaudeHome(managedHome, env);
    expect(managedClaudeInstructionHomeVersion(managedHome, env)).toBe(1);
    releaseManagedClaudeHomeLease(managedHome, env);
    expect(reuseManagedClaudeHome(managedHome, env)).toBe(managedHome);
    expect(managedClaudeInstructionHomeVersion(managedHome, env)).toBe(1);
    destroyManagedClaudeHome(managedHome, env);
  });

  it("refuses to mark a home that is no longer actively owned by this process", () => {
    const { env } = managedHomeFixture();
    const managedHome = prepareManagedClaudeHome(env);
    releaseManagedClaudeHomeLease(managedHome, env);

    expect(() => markManagedClaudeInstructionHome(managedHome, env)).toThrow(
      "not a new preparing home owned by this process"
    );
    expect(
      managedClaudeInstructionHomeVersion(managedHome, env)
    ).toBeUndefined();
  });

  it("removes a verified stale preparing home after its owner lease is abandoned", () => {
    const { env } = managedHomeFixture();
    const managedHome = prepareManagedClaudeHome(env);
    releaseManagedClaudeHomeLease(managedHome, env);

    expect(
      cleanupAbandonedManagedClaudeHomes(env, {
        staleAfterMs: 0,
        isProcessAlive: () => false
      })
    ).toEqual([managedHome]);
    expect(fs.existsSync(managedHome)).toBe(false);
  });

  it("preserves a retained home when its former owner is stale", () => {
    const { env } = managedHomeFixture();
    const managedHome = prepareManagedClaudeHome(env);
    retainManagedClaudeHome(managedHome, env);
    releaseManagedClaudeHomeLease(managedHome, env);

    expect(
      cleanupAbandonedManagedClaudeHomes(env, {
        staleAfterMs: 0,
        isProcessAlive: () => false
      })
    ).toEqual([]);
    expect(fs.existsSync(managedHome)).toBe(true);
  });

  it("refuses a forged marker and leaves the directory untouched", () => {
    const { env } = managedHomeFixture();
    prepareManagedClaudeHome(env);
    const forged = path.join(
      env.KOED_HOME,
      "run",
      "managed-claude",
      `session-${randomUUID()}`
    );
    fs.mkdirSync(forged, { mode: 0o700 });
    fs.writeFileSync(
      path.join(forged, ".koed-managed-claude-home"),
      `${JSON.stringify({ version: 2, kind: "koed-managed-claude-home" })}\n`
    );

    expect(() => destroyManagedClaudeHome(forged, env)).toThrow();
    expect(fs.existsSync(forged)).toBe(true);
  });

  it("never creates credential bytes, files, or symlinks in a managed home", () => {
    const { env } = managedHomeFixture();
    const managedHome = prepareManagedClaudeHome(env);
    const credentials = path.join(managedHome, ".credentials.json");

    expect(fs.existsSync(credentials)).toBe(false);
    expect(fs.readdirSync(managedHome)).not.toContain(".credentials.json");
    expect(
      fs
        .readdirSync(managedHome, { withFileTypes: true })
        .some((entry) => entry.isSymbolicLink())
    ).toBe(false);
    destroyManagedClaudeHome(managedHome, env);

    expect(fs.existsSync(managedHome)).toBe(false);
  });
});

describe("Claude managed Agent execution", () => {
  it("does not register a separate Agent Job protocol", async () => {
    const { config } = fixture();
    sdk.query.mockImplementation(({ options }: { options?: Options }) =>
      queryFrom([successResult(options?.sessionId as string)])
    );
    const session = new ClaudeManagedConversationSession(config);

    await session.start("Continue the conversation");

    expect(queryOptions().allowedTools).not.toContain(
      "mcp__koed_agent_assignment__koed_agent_intent"
    );
    expect(queryOptions().allowedTools).not.toContain(
      "mcp__koed_agent_assignment__koed_agent_turn_status"
    );
    expect(queryOptions().mcpServers?.koed_agent_assignment).toBeUndefined();
    expect(sdk.createSdkMcpServer).not.toHaveBeenCalled();
    await session.closeAndWait();
  });
});
