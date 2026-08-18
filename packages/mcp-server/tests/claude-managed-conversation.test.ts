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
  forkSession: vi.fn()
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: sdk.query,
  forkSession: sdk.forkSession
}));

import {
  ClaudeManagedConversationCancelledError,
  ClaudeManagedConversationSession,
  cleanupAbandonedManagedClaudeHomes,
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
    const { config, cwd, managedHome } = fixture();
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
    expect(queryOptions(1).env?.CLAUDE_CONFIG_DIR).toBe(
      fs.realpathSync(path.join(cwd, ".claude"))
    );
    expect(
      resolveClaudeManagedConversationSource(sessionId, {
        KOED_CLAUDE_SESSION_STORE_DIR: managedHome
      }).managedHome
    ).toBe(fs.realpathSync(managedHome));
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
