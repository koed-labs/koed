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
  ClaudeManagedConversationSession,
  cleanupAbandonedManagedClaudeHomes,
  createManagedClaudeSessionStore,
  destroyManagedClaudeHome,
  forkClaudeTranscript,
  prepareManagedClaudeHome,
  releaseManagedClaudeHomeLease,
  retainManagedClaudeHome,
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

  it("leaves CLAUDE_CONFIG_DIR unset when using Claude's native HOME default", async () => {
    const { config } = fixture();
    sdk.query.mockImplementation(({ options }: { options?: Options }) =>
      queryFrom([successResult(options?.sessionId as string, "hello")])
    );
    const session = new ClaudeManagedConversationSession(config);

    try {
      await session.start("Hello");

      expect(queryOptions().env?.HOME).toBe(config.env.HOME);
      expect(queryOptions().env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    } finally {
      await session.closeAndWait();
    }
  });

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

describe("Claude Agent assignment native tool", () => {
  const currentIntentTool = () => {
    const configuration = sdk.createSdkMcpServer.mock.calls.at(-1)?.[0] as
      | Parameters<
          (typeof import("@anthropic-ai/claude-agent-sdk"))["createSdkMcpServer"]
        >[0]
      | undefined;
    const registered = configuration?.tools?.[0];
    if (!registered)
      throw new Error("No native Agent intent tool was registered");
    return registered;
  };
  const assignment = () => ({
    jobId: randomUUID(),
    attemptId: randomUUID(),
    title: "Review work",
    state: "running" as const,
    continuation: false
  });

  it("awaits authority before returning a native tool result in the existing query", async () => {
    const { config } = fixture();
    const result = assignment();
    let committed = false;
    const handler = vi.fn(async () => {
      committed = true;
      return result;
    });
    sdk.query.mockImplementation(({ options }: { options: Options }) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        const response = await currentIntentTool().handler(
          { kind: "assign", goal: "Review work" },
          {}
        );
        expect(committed).toBe(true);
        expect(response.content).toEqual([
          { type: "text", text: JSON.stringify(result) }
        ]);
        yield successResult(options.sessionId!, "Assigned");
      }
      const stream = generate() as Query;
      stream.close = vi.fn();
      return stream;
    });
    const session = new ClaudeManagedConversationSession({
      ...config,
      personalAgentIntentHandler: handler
    });
    await session.start("Perform the discussed work");
    expect(handler).toHaveBeenCalledExactlyOnceWith({
      kind: "assign",
      goal: "Review work"
    });
    expect(sdk.query).toHaveBeenCalledTimes(1);
    expect(queryOptions().allowedTools).toContain(
      "mcp__koed_agent_assignment__koed_agent_intent"
    );
    expect(queryOptions().mcpServers?.koed_agent_assignment?.type).toBe("sdk");
    await expect(
      currentIntentTool().handler({ kind: "assign", goal: "Late work" }, {})
    ).rejects.toThrow("inactive Claude turn");
    expect(handler).toHaveBeenCalledTimes(1);
    await session.closeAndWait();
  });

  it("rejects invalid provider signals without calling runner authority", async () => {
    const { config } = fixture();
    const handler = vi.fn(async () => assignment());
    sdk.query.mockImplementation(({ options }: { options: Options }) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        await expect(
          currentIntentTool().handler(
            { kind: "assign", goal: "Work", ownerUserId: randomUUID() },
            {}
          )
        ).rejects.toThrow();
        await expect(
          currentIntentTool().handler({ kind: "assign" }, {})
        ).rejects.toThrow();
        yield successResult(options.sessionId!, "Clarify the work");
      }
      const stream = generate() as Query;
      stream.close = vi.fn();
      return stream;
    });
    const session = new ClaudeManagedConversationSession({
      ...config,
      personalAgentIntentHandler: handler
    });
    await session.start("Discuss an approach");
    expect(handler).not.toHaveBeenCalled();
    expect(sdk.query).toHaveBeenCalledTimes(1);
    await session.closeAndWait();
  });

  it("propagates authority failure and retires the tool with the failed turn", async () => {
    const { config } = fixture();
    const handler = vi.fn(async () => {
      throw new Error("Stale command fence");
    });
    sdk.query.mockImplementation(({ options }: { options: Options }) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        await currentIntentTool().handler(
          { kind: "new_job", goal: "Additional work" },
          {}
        );
        yield successResult(options.sessionId!, "Unexpected authority success");
      }
      const stream = generate() as Query;
      stream.close = vi.fn();
      return stream;
    });
    const session = new ClaudeManagedConversationSession({
      ...config,
      personalAgentIntentHandler: handler
    });
    await expect(session.start("Do additional work")).rejects.toThrow(
      "Stale command fence"
    );
    await expect(
      currentIntentTool().handler({ kind: "continue" }, {})
    ).rejects.toThrow("inactive Claude turn");
    expect(handler).toHaveBeenCalledTimes(1);
    await session.closeAndWait();
  });
});

describe("Claude Agent native Job outcome", () => {
  const statusTool = () => {
    const configuration = sdk.createSdkMcpServer.mock.calls.at(-1)?.[0] as
      | Parameters<
          (typeof import("@anthropic-ai/claude-agent-sdk"))["createSdkMcpServer"]
        >[0]
      | undefined;
    const registered = configuration?.tools?.find(
      (entry) => entry.name === "koed_agent_turn_status"
    );
    if (!registered) throw new Error("No native Job outcome tool registered");
    return registered;
  };

  it("records a bounded outcome in the existing query and rejects stale or forged calls", async () => {
    const { config } = fixture();
    const handler = vi.fn(async () => {});
    sdk.query.mockImplementation(({ options }: { options: Options }) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        await expect(
          statusTool().handler({ status: "complete", jobId: randomUUID() }, {})
        ).rejects.toThrow();
        await expect(
          statusTool().handler({ status: "failed" }, {})
        ).rejects.toThrow();
        await statusTool().handler({ status: "awaiting_owner" }, {});
        expect(handler).toHaveBeenCalledExactlyOnceWith("awaiting_owner");
        yield successResult(options.sessionId!, "Which option should I use?");
      }
      const stream = generate() as Query;
      stream.close = vi.fn();
      return stream;
    });
    const session = new ClaudeManagedConversationSession({
      ...config,
      personalAgentTurnStatusHandler: handler
    });
    await session.start("Continue the assigned work");
    expect(sdk.query).toHaveBeenCalledTimes(1);
    expect(queryOptions().allowedTools).toContain(
      "mcp__koed_agent_assignment__koed_agent_turn_status"
    );
    await expect(
      statusTool().handler({ status: "complete" }, {})
    ).rejects.toThrow("inactive Claude turn");
    expect(handler).toHaveBeenCalledTimes(1);
    await session.closeAndWait();
  });
});

describe("Claude per-turn planning and summary tool policy", () => {
  it("limits pending review to read tools, disables tools for summary, and restores selected execution controls", async () => {
    const { config } = fixture();
    let policy: "work" | "planning" | "summary" = "planning";
    let agentToolsEnabled = true;
    sdk.query.mockImplementation(({ options }: { options: Options }) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield successResult(options.sessionId!, "Reviewed");
      }
      const stream = generate() as Query;
      stream.close = vi.fn();
      return stream;
    });
    const session = new ClaudeManagedConversationSession({
      ...config,
      permissionMode: "bypassPermissions",
      tools: ["Bash", "Read", "Write"],
      allowedTools: ["Bash"],
      executionPolicy: () => policy,
      personalAgentToolsEnabled: () => agentToolsEnabled,
      personalAgentTurnStatusHandler: vi.fn(async () => {})
    });
    await session.start("Review a Team request");
    expect(queryOptions().tools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "LS",
      "AskUserQuestion"
    ]);
    expect(queryOptions().allowDangerouslySkipPermissions).toBeUndefined();
    expect(queryOptions().mcpServers).toEqual({});
    expect(queryOptions().allowedTools).not.toContain("Bash");
    policy = "summary";
    await session.prompt("Draft a summary");
    expect(queryOptions(1).tools).toEqual([]);
    expect(queryOptions(1).allowedTools).toEqual([]);
    expect(queryOptions(1).mcpServers).toEqual({});
    policy = "work";
    await session.prompt("Owner accepted the work");
    expect(queryOptions(2).tools).toEqual(["Bash", "Read", "Write"]);
    expect(queryOptions(2).permissionMode).toBe("bypassPermissions");
    expect(queryOptions(2).allowDangerouslySkipPermissions).toBe(true);
    agentToolsEnabled = false;
    await session.prompt("Continue a direct AI Client chat");
    expect(queryOptions(3).mcpServers?.koed_agent_assignment).toBeUndefined();
    expect(queryOptions(3).allowedTools).not.toContain(
      "mcp__koed_agent_assignment__koed_agent_turn_status"
    );
    expect(queryOptions(3).tools).toEqual(["Bash", "Read", "Write"]);
    await session.closeAndWait();
  });
});

describe("Claude Pull Request review policy", () => {
  it("keeps Agent Job reporting available while excluding file and command writes", async () => {
    const { config } = fixture();
    sdk.query.mockImplementation(({ options }: { options: Options }) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield successResult(options.sessionId!, "Reviewed");
      }
      const stream = generate() as Query;
      stream.close = vi.fn();
      return stream;
    });
    const session = new ClaudeManagedConversationSession({
      ...config,
      permissionMode: "bypassPermissions",
      tools: ["Bash", "Read", "Write"],
      allowedTools: ["Bash"],
      executionPolicy: () => "review",
      personalAgentToolsEnabled: () => true,
      personalAgentIntentHandler: vi.fn(async () => ({ recorded: true })),
      personalAgentTurnStatusHandler: vi.fn(async () => {})
    });
    await session.start("Review the PR");
    expect(queryOptions().tools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "LS",
      "AskUserQuestion"
    ]);
    expect(queryOptions().allowedTools).toContain(
      "mcp__koed_agent_assignment__koed_agent_turn_status"
    );
    expect(queryOptions().allowedTools).toContain(
      "mcp__koed_agent_assignment__koed_agent_intent"
    );
    expect(queryOptions().allowedTools).not.toContain("Bash");
    expect(queryOptions().allowDangerouslySkipPermissions).toBeUndefined();
    await session.closeAndWait();
  });
});
