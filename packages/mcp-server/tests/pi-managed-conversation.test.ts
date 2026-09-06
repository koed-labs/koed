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
import { PiManagedConversationSession } from "../src/pi-managed-conversation.js";

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
              sessionFile: path.join(root, "sessions", "session.jsonl")
            }
          : {}
    };
    if (request.type === "get_state" && startupDelayMs) {
      setTimeout(() => emit(response), startupDelayMs);
    } else emit(response);
  });
  const onTextDelta = vi.fn();
  const onUiRequest = vi.fn().mockResolvedValue({ value: "Approve" });
  const session = new PiManagedConversationSession({
    cwd: root,
    sessionDirectory: path.join(root, "sessions"),
    model: "test/model",
    permissionMode: "full_access",
    env: { PATH: process.env.PATH, KOED_PI_EXECUTABLE: executable },
    onTextDelta,
    onUiRequest,
    ...(startupDelayMs ? { requestTimeoutMs: 50, startupTimeoutMs: 500 } : {})
  });
  return {
    session,
    emit,
    child,
    requests,
    onTextDelta,
    onUiRequest,
    changeIdentity: () => {
      sessionId = "22222222-2222-4222-8222-222222222222";
    }
  };
}

describe("Pi managed RPC conversation", () => {
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
