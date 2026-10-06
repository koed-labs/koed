import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn
}));
import {
  PiManagedConversationSession,
  type PiManagedConversationConfig
} from "../src/pi-managed-conversation.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  mocks.spawn.mockReset();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(startupDelayMs = 0, bundled = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-pi-managed-test-"));
  directories.push(root);
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      exports: { ".": { import: "./dist/index.js" } }
    })
  );
  if (bundled) fs.mkdirSync(path.join(root, "dist", "bundle"));
  const executable = path.join(
    root,
    "dist",
    ...(bundled ? ["bundle"] : []),
    "cli.js"
  );
  fs.writeFileSync(executable, "", { mode: 0o700 });
  fs.writeFileSync(path.join(root, "dist", "index.js"), "");
  const child = Object.assign(new EventEmitter(), {
    pid: 99999999,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  });
  vi.spyOn(process, "kill").mockImplementation(() => {
    child.emit("close");
    return true;
  });
  mocks.spawn.mockReturnValue(child);
  const requests: Record<string, unknown>[] = [];
  const emit = (event: Record<string, unknown>) =>
    child.stdout.write(`${JSON.stringify(event)}\n`);
  let sessionId = "11111111-1111-4111-8111-111111111111";
  child.stdin.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString("utf8")) as Record<
      string,
      unknown
    >;
    requests.push(request);
    if (request.type === "extension_ui_response") return;
    const response = {
      type: "response",
      id: request.id,
      success: true,
      data:
        request.type === "get_state"
          ? {
              sessionId,
              sessionFile:
                (
                  JSON.parse(
                    (mocks.spawn.mock.calls.at(-1)?.[1] as string[]).at(-1)!
                  ) as { resumeSessionPath?: string }
                ).resumeSessionPath ??
                path.join(root, "sessions", "session.jsonl")
            }
          : {}
    };
    if (request.type === "get_state" && startupDelayMs) {
      setTimeout(() => emit(response), startupDelayMs);
    } else emit(response);
  });
  const onTextDelta = vi.fn();
  const onUserFacingProgress =
    vi.fn<(event: { turnId: string; id: string; title: string }) => void>();
  const onUiRequest = vi.fn().mockResolvedValue({ value: "Approve" });
  const config: PiManagedConversationConfig = {
    cwd: root,
    sessionDirectory: path.join(root, "sessions"),
    model: "test/model",
    permissionMode: "full_access",
    env: { PATH: process.env.PATH, KOED_PI_EXECUTABLE: executable },
    onTextDelta,
    onUserFacingProgress,
    onUiRequest,
    ...(startupDelayMs ? { requestTimeoutMs: 50, startupTimeoutMs: 500 } : {})
  };
  const session = new PiManagedConversationSession(config);
  return {
    root,
    config,
    session,
    emit,
    child,
    requests,
    onTextDelta,
    onUserFacingProgress,
    onUiRequest,
    changeIdentity: () => {
      sessionId = "22222222-2222-4222-8222-222222222222";
    }
  };
}

describe("Pi managed RPC conversation", () => {
  it.each(["outside", "symlink"])(
    "requires a contained resume transcript before launching (%s)",
    async (kind) => {
      const f = fixture();
      fs.mkdirSync(f.config.sessionDirectory);
      const outside = path.join(f.root, "unmanaged.jsonl");
      fs.writeFileSync(outside, "");
      const link = path.join(f.config.sessionDirectory, "session.jsonl");
      if (kind === "symlink") fs.symlinkSync(outside, link);
      const session = new PiManagedConversationSession({
        ...f.config,
        resumeSessionPath: kind === "outside" ? outside : link,
        expectedSessionId: "11111111-1111-4111-8111-111111111111"
      });
      await expect(session.start()).rejects.toThrow(
        "outside its managed session directory"
      );
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(fs.readFileSync(outside, "utf8")).toBe("");
    }
  );

  it.each([false, true])(
    "resumes an independently writable managed copy (hard link: %s)",
    async (hardLink) => {
      const f = fixture();
      fs.mkdirSync(f.config.sessionDirectory);
      const transcriptPath = path.join(
        f.config.sessionDirectory,
        "session.jsonl"
      );
      fs.writeFileSync(
        transcriptPath,
        JSON.stringify({
          type: "session",
          version: 3,
          id: "11111111-1111-4111-8111-111111111111",
          cwd: f.root
        }) + "\n"
      );
      if (hardLink) {
        const originalPath = path.join(f.root, "original.jsonl");
        fs.renameSync(transcriptPath, originalPath);
        fs.linkSync(originalPath, transcriptPath);
      }
      const directoryAlias = path.join(f.root, "sessions-alias");
      fs.symlinkSync(f.config.sessionDirectory, directoryAlias, "dir");
      const session = new PiManagedConversationSession({
        ...f.config,
        sessionDirectory: directoryAlias,
        resumeSessionPath: path.join(directoryAlias, "session.jsonl"),
        expectedSessionId: "11111111-1111-4111-8111-111111111111"
      });
      const identity = await session.start();
      expect(identity.transcriptPath).not.toBe(transcriptPath);
      expect(fs.readFileSync(identity.transcriptPath!, "utf8")).toBe(
        fs.readFileSync(transcriptPath, "utf8")
      );
      const args = mocks.spawn.mock.calls[0]?.[1] as string[];
      const passedConfig = JSON.parse(args.at(-1)!) as Record<string, unknown>;
      expect(passedConfig).toMatchObject({
        sessionDirectory: fs.realpathSync(f.config.sessionDirectory),
        resumeSessionPath: identity.transcriptPath
      });
      const original = fs.readFileSync(transcriptPath, "utf8");
      fs.appendFileSync(identity.transcriptPath!, "\n");
      expect(fs.readFileSync(transcriptPath, "utf8")).toBe(original);
      await session.closeAndWait();
    }
  );
  it("reuses the durable private transcript path across resumes while preserving source inodes", async () => {
    const f = fixture();
    fs.mkdirSync(f.config.sessionDirectory);
    const source = path.join(f.config.sessionDirectory, "original.jsonl");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const original =
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        cwd: f.root
      }) + "\n";
    fs.writeFileSync(source, original);
    let current = source;
    let expected = original;
    let privatePath: string | undefined;
    for (let iteration = 0; iteration < 6; iteration += 1) {
      const retained = path.join(f.root, `retained-${iteration}.jsonl`);
      fs.linkSync(current, retained);
      const session = new PiManagedConversationSession({
        ...f.config,
        resumeSessionPath: current,
        expectedSessionId: sessionId,
        onResumeIdentity: async (identity) => {
          current = identity.transcriptPath!;
        }
      });
      const identity = await session.start();
      expect(current).toBe(identity.transcriptPath);
      if (privatePath) expect(current).toBe(privatePath);
      privatePath = current;
      expect(fs.readFileSync(current, "utf8")).toBe(expected);
      fs.appendFileSync(current, "\n");
      expect(fs.readFileSync(retained, "utf8")).toBe(expected);
      expected += "\n";
      await session.closeAndWait();
      expect(
        fs
          .readdirSync(f.config.sessionDirectory)
          .filter((name) => name.startsWith(".resume-"))
      ).toHaveLength(1);
    }
    expect(fs.readFileSync(source, "utf8")).toBe(original);
  });

  it.each([false, true])(
    "waits for durable resume identity adoption (failure: %s)",
    async (failure) => {
      const f = fixture();
      fs.mkdirSync(f.config.sessionDirectory);
      const source = path.join(f.config.sessionDirectory, "original.jsonl");
      const sessionId = "11111111-1111-4111-8111-111111111111";
      const original =
        JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          cwd: f.root
        }) + "\n";
      fs.writeFileSync(source, original);
      let finish: (() => void) | undefined;
      const onResumeIdentity = vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            finish = () =>
              failure
                ? reject(new Error("Identity adoption failed"))
                : resolve();
          })
      );
      const session = new PiManagedConversationSession({
        ...f.config,
        resumeSessionPath: source,
        expectedSessionId: sessionId,
        onResumeIdentity
      });
      let settled = false;
      const started = session.start().finally(() => {
        settled = true;
      });
      const result = failure
        ? expect(started).rejects.toThrow("Identity adoption failed")
        : expect(started).resolves.toMatchObject({ sessionId });
      await vi.waitFor(() => expect(onResumeIdentity).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      finish!();
      await result;
      expect(fs.readFileSync(source, "utf8")).toBe(original);
      await session.closeAndWait();
    }
  );

  it("resolves the public SDK for a bundled native launcher", async () => {
    const { session } = fixture(0, true);
    await expect(session.start()).resolves.toMatchObject({
      sessionId: "11111111-1111-4111-8111-111111111111"
    });
    await session.closeAndWait();
  });

  it("reports a provider-error turn as unsuccessful after it settles", async () => {
    const { session, emit } = fixture();
    await session.start();
    const turn = session.prompt("A test prompt");
    const failed = expect(turn).rejects.toMatchObject({
      name: "PiManagedConversationProviderError"
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Provider authentication unavailable"
      }
    });
    emit({ type: "agent_settled" });
    await failed;
  });

  it("allows cold startup beyond the ordinary RPC acknowledgement timeout", async () => {
    const { session } = fixture(100);
    try {
      await expect(session.start()).resolves.toMatchObject({ provider: "pi" });
    } finally {
      await session.closeAndWait();
    }
  });

  it("closes active work synchronously and can await teardown repeatedly", async () => {
    const f = fixture();
    await f.session.start();
    const prompt = f.session.prompt("hello");
    f.session.close();
    await expect(prompt).rejects.toThrow("closed");
    await f.session.closeAndWait();
    await f.session.closeAndWait();
    await expect(f.session.prompt("again")).rejects.toThrow("closed");
  });
  it("aborts active work and reports cancellation after settling", async () => {
    const f = fixture();
    await f.session.start();
    const prompt = f.session.prompt("hello");
    await f.session.cancel();
    f.emit({ type: "agent_settled" });
    await expect(prompt).rejects.toThrow("canceled");
    expect(
      f.requests.filter((request) => request.type === "abort")
    ).toHaveLength(1);
  });
  it("waits for settled output, not prompt acceptance or intermediate agent completion", async () => {
    const f = fixture();
    await f.session.start();
    let completed = false;
    const prompt = f.session.prompt("hello").then((result) => {
      completed = true;
      return result;
    });
    f.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello\u2028world" }
    });
    f.emit({ type: "agent_end" });
    await Promise.resolve();
    expect(completed).toBe(false);
    f.emit({ type: "agent_settled" });
    expect(await prompt).toMatchObject({ text: "hello\u2028world" });
    expect(f.onTextDelta).toHaveBeenCalledWith(
      "hello\u2028world",
      expect.any(String)
    );
    await f.session.closeAndWait();
  });
  it("correlates extension UI replies to the native request", async () => {
    const f = fixture();
    await f.session.start();
    f.emit({
      type: "extension_ui_request",
      id: "approval-7",
      method: "select",
      options: ["Approve", "Decline"]
    });
    await vi.waitFor(() =>
      expect(f.requests).toContainEqual({
        type: "extension_ui_response",
        id: "approval-7",
        value: "Approve"
      })
    );
    await f.session.closeAndWait();
  });
  it("cancels the native UI request when the interaction handler fails", async () => {
    const f = fixture();
    f.onUiRequest.mockRejectedValueOnce(new Error("interaction closed"));
    await f.session.start();
    f.emit({
      type: "extension_ui_request",
      id: "approval-closed",
      method: "select",
      options: ["Approve", "Decline"]
    });
    await vi.waitFor(() =>
      expect(f.requests).toContainEqual({
        type: "extension_ui_response",
        id: "approval-closed",
        cancelled: true
      })
    );
    await f.session.closeAndWait();
  });
  it("preserves text when UTF-8 records arrive across pipe chunks", async () => {
    const f = fixture();
    await f.session.start();
    const prompt = f.session.prompt("hello");
    const bytes = Buffer.from(
      `${JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hello 🌏" }
      })}\n`
    );
    const split = bytes.indexOf(Buffer.from("🌏")) + 2;
    f.child.stdout.write(bytes.subarray(0, split));
    expect(f.onTextDelta).not.toHaveBeenCalled();
    f.child.stdout.write(bytes.subarray(split));
    f.emit({ type: "agent_settled" });
    expect(await prompt).toMatchObject({ text: "Hello 🌏" });
    expect(f.onTextDelta).toHaveBeenCalledExactlyOnceWith(
      "Hello 🌏",
      expect.any(String)
    );
    await f.session.closeAndWait();
  });
  it("closes instead of replaying a prompt when identity changes", async () => {
    const f = fixture();
    await f.session.start();
    const prompt = f.session.prompt("hello");
    f.changeIdentity();
    f.emit({ type: "agent_settled" });
    await expect(prompt).rejects.toThrow("identity changed");
    expect(
      f.requests.filter((request) => request.type === "prompt")
    ).toHaveLength(1);
  });
  it("rejects pending work when the provider closes", async () => {
    const f = fixture();
    await f.session.start();
    const prompt = f.session.prompt("hello");
    f.child.emit("close");
    await expect(prompt).rejects.toThrow("closed");
  });
});

describe("Pi managed native Agent signals", () => {
  it("awaits command authority in the existing turn without routing metadata to human UI", async () => {
    const f = fixture();
    const assignment = {
      jobId: "job",
      attemptId: "attempt",
      title: "Review",
      state: "running" as const,
      continuation: false
    };
    const intent = vi.fn(async () => assignment);
    const outcome = vi.fn(async () => {});
    f.config.personalAgentIntentHandler = intent;
    f.config.personalAgentTurnStatusHandler = outcome;
    await f.session.start();
    const pending = f.session.prompt("Perform the discussed work");
    f.emit({
      type: "extension_ui_request",
      id: "intent",
      method: "input",
      title: JSON.stringify({
        kind: "koed_agent_intent",
        signal: { kind: "assign", goal: "Review" }
      })
    });
    await vi.waitFor(() =>
      expect(f.requests.find((r) => r.id === "intent")).toMatchObject({
        type: "extension_ui_response",
        value: JSON.stringify({ recorded: true, ...assignment })
      })
    );
    f.emit({
      type: "extension_ui_request",
      id: "outcome",
      method: "input",
      title: JSON.stringify({
        kind: "koed_agent_turn_status",
        status: "complete"
      })
    });
    await vi.waitFor(() =>
      expect(f.requests.find((r) => r.id === "outcome")).toMatchObject({
        value: JSON.stringify({ recorded: true, status: "complete" })
      })
    );
    expect(intent).toHaveBeenCalledExactlyOnceWith({
      kind: "assign",
      goal: "Review"
    });
    expect(outcome).toHaveBeenCalledExactlyOnceWith("complete");
    expect(f.onUiRequest).not.toHaveBeenCalled();
    f.emit({ type: "agent_settled" });
    await pending;
    expect(f.requests.filter((r) => r.type === "prompt")).toHaveLength(1);
    f.emit({
      type: "extension_ui_request",
      id: "late",
      method: "input",
      title: JSON.stringify({
        kind: "koed_agent_intent",
        signal: { kind: "continue" }
      })
    });
    await vi.waitFor(() =>
      expect(f.requests.find((r) => r.id === "late")).toMatchObject({
        cancelled: true
      })
    );
    expect(intent).toHaveBeenCalledTimes(1);
    await f.session.closeAndWait();
  });

  it("rejects forged input and authority failure without forwarding it to human approvals", async () => {
    const f = fixture();
    const handler = vi.fn(async () => {
      throw new Error("Stale claim");
    });
    f.config.personalAgentIntentHandler = handler;
    await f.session.start();
    const pending = f.session.prompt("Discuss the work");
    f.emit({
      type: "extension_ui_request",
      id: "forged",
      method: "input",
      title: JSON.stringify({
        kind: "koed_agent_intent",
        signal: { kind: "assign", goal: "Review", jobId: "forged" }
      })
    });
    await vi.waitFor(() =>
      expect(f.requests.find((r) => r.id === "forged")).toMatchObject({
        cancelled: true
      })
    );
    expect(handler).not.toHaveBeenCalled();
    f.emit({
      type: "extension_ui_request",
      id: "failed",
      method: "input",
      title: JSON.stringify({
        kind: "koed_agent_intent",
        signal: { kind: "assign", goal: "Review" }
      })
    });
    await vi.waitFor(() =>
      expect(f.requests.find((r) => r.id === "failed")).toMatchObject({
        cancelled: true
      })
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(f.onUiRequest).not.toHaveBeenCalled();
    f.emit({ type: "agent_settled" });
    await pending;
    await f.session.closeAndWait();
  });
});

it("reports tool phases without exposing thinking deltas or tool arguments", async () => {
  const f = fixture();
  await f.session.start();
  const prompt = f.session.prompt("hello");
  f.emit({
    type: "tool_execution_start",
    toolCallId: "tool",
    toolName: "read",
    args: { path: "private" }
  });
  f.emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_delta",
      delta: "private reasoning"
    }
  });
  f.emit({
    type: "tool_execution_end",
    toolCallId: "tool",
    result: { content: "private result" }
  });
  f.emit({ type: "agent_settled" });
  await prompt;
  expect(
    f.onUserFacingProgress.mock.calls.map(([event]) => ({
      id: event.id,
      title: event.title
    }))
  ).toEqual([
    { id: "tool", title: "Using read" },
    { id: "tool", title: "Tool finished" }
  ]);
  await f.session.closeAndWait();
});
