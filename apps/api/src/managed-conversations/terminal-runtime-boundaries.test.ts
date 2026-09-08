import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemorySourceRepository } from "@koed/db";
import {
  MANAGED_TERMINAL_CONTEXT_TTL_SECONDS,
  MANAGED_TERMINAL_MAX_DATA_BYTES,
  type ManagedTerminalRecord
} from "@koed/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const pty = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node-pty", () => pty);
import { createManagedTerminalRuntime } from "./terminal-runtime.js";

const fixtures: Array<{
  root: string;
  runtime: ReturnType<typeof createManagedTerminalRuntime>;
}> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fixture of fixtures.splice(0)) {
    await fixture.runtime.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  pty.spawn.mockReset();
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "koed-terminal-boundaries-"));
  const deploymentId = randomUUID();
  const deviceId = randomUUID();
  const records = new Map<string, ManagedTerminalRecord>();
  const owners = new Map<string, string>();
  const children: Array<{
    data: (text: string) => void;
    write: ReturnType<typeof vi.fn>;
  }> = [];
  vi.spyOn(process, "kill").mockImplementation(() => true);
  pty.spawn.mockImplementation(() => {
    const child = {
      data: (() => {}) as (text: string) => void,
      write: vi.fn()
    };
    children.push(child);
    return {
      pid: 99999999,
      write: child.write,
      resize: vi.fn(),
      kill: vi.fn(),
      onData: (callback: (text: string) => void) => {
        child.data = callback;
      },
      onExit: vi.fn()
    };
  });
  const repository = {
    reconcileManagedTerminalsForRunner: async () => 0,
    createManagedTerminal: async (
      _actor: unknown,
      input: { executionId: string }
    ) => records.get(input.executionId)!,
    getManagedTerminal: async (
      actor: { userId: string },
      input: { executionId: string }
    ) =>
      owners.get(input.executionId) === actor.userId
        ? records.get(input.executionId)!
        : null,
    getManagedConversationExecution: async (_actor: unknown, id: string) => ({
      id,
      executionGeneration: 1,
      runnerDeploymentId: deploymentId,
      runnerDeviceId: deviceId,
      state: "running"
    }),
    getManagedConversationRuntimeBinding: async (
      _actor: unknown,
      id: string
    ) => ({
      executionId: id,
      executionGeneration: 1,
      deploymentId,
      deviceId,
      projectPath: root,
      sourceProjectPath: root,
      checkoutId: records.get(id)!.checkoutId,
      checkoutKind: "non_vcs_directory",
      checkoutLifecycle: "ready",
      vcsDriver: null,
      localRepositoryCommonDirectory: null,
      localGitDirectory: null,
      repositoryIdentityHash: null,
      worktreeIdentityHash: null,
      baseRef: null,
      baseObjectId: null,
      branchRef: null,
      headObjectId: null
    }),
    transitionManagedTerminal: async (input: {
      terminalId: string;
      fromStates: string[];
      state: ManagedTerminalRecord["state"];
    }) => {
      const record = [...records.values()].find(
        (entry) => entry.id === input.terminalId
      )!;
      if (!input.fromStates.includes(record.state)) return null;
      const updated = { ...record, state: input.state };
      records.set(record.executionId, updated);
      return updated;
    }
  } as unknown as MemorySourceRepository;
  const runtime = createManagedTerminalRuntime({
    requireRepository: () => repository,
    koedHome: root,
    inspectIdentity: () => ({
      health: "healthy",
      deploymentId,
      deviceInstanceId: deviceId,
      remoteOperationsAllowed: true,
      message: "ready",
      platformProtection: "verified"
    })
  });
  fixtures.push({ root, runtime });
  const add = (ownerUserId = randomUUID()) => {
    const executionId = randomUUID();
    const now = new Date().toISOString();
    const record: ManagedTerminalRecord = {
      id: randomUUID(),
      executionId,
      executionGeneration: 1,
      checkoutId: randomUUID(),
      runnerDeploymentId: deploymentId,
      runnerDeviceId: deviceId,
      lifecycleGeneration: 1,
      shellProfileId: "system_default",
      state: "creating",
      columns: 120,
      rows: 40,
      exitCode: null,
      exitSignal: null,
      failureCode: null,
      createdAt: now,
      startedAt: null,
      detachedAt: null,
      stoppedAt: null,
      updatedAt: now
    };
    records.set(executionId, record);
    owners.set(executionId, ownerUserId);
    return {
      ownerUserId,
      executionId,
      terminalId: record.id,
      lifecycleGeneration: 1,
      afterOutputSequence: 0
    };
  };
  const create = async (input: ReturnType<typeof add>) =>
    runtime.create(input.ownerUserId, input.executionId, {
      executionGeneration: 1,
      idempotencyKey: input.executionId,
      shellProfileId: "system_default",
      columns: 120,
      rows: 40
    });
  return { runtime, add, create, children };
};

describe("terminal lifecycle and output boundaries", () => {
  it("shares one fully activated PTY across concurrent idempotent creates", async () => {
    const f = await fixture();
    const input = f.add();
    const records = await Promise.all(
      Array.from({ length: 12 }, () => f.create(input))
    );
    expect(pty.spawn).toHaveBeenCalledTimes(1);
    expect(
      records.every(
        (record) => record.id === input.terminalId && record.state === "running"
      )
    ).toBe(true);
    expect(
      f.runtime.hasLiveExecutionTerminal({ ...input, executionGeneration: 1 })
    ).toBe(true);
    const attachment = await f.runtime.attach(input);
    const ready = attachment.initialFrames.find(
      (frame) => frame.type === "terminal.ready"
    )!;
    await attachment.handle({
      protocolVersion: 1,
      terminalId: input.terminalId,
      lifecycleGeneration: 1,
      type: "terminal.input",
      inputEpoch: ready.inputEpoch,
      sequence: 1,
      dataBase64: Buffer.from("pwd\n").toString("base64")
    });
    expect(f.children[0]!.write).toHaveBeenCalledTimes(1);
  });

  it("returns individually decodable UTF-8 output and replay frames", async () => {
    const f = await fixture();
    const input = f.add();
    await f.create(input);
    const text =
      "x".repeat(MANAGED_TERMINAL_MAX_DATA_BYTES - 1) +
      "😀第二行\n" +
      "é".repeat(MANAGED_TERMINAL_MAX_DATA_BYTES);
    f.children[0]!.data(text);
    const attachment = await f.runtime.attach(input);
    const output = attachment.initialFrames.filter(
      (frame) => frame.type === "terminal.output"
    );
    const decoded = output
      .map((frame) => {
        const bytes = Buffer.from(frame.dataBase64, "base64");
        expect(bytes.length).toBeLessThanOrEqual(
          MANAGED_TERMINAL_MAX_DATA_BYTES
        );
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      })
      .join("");
    expect(decoded).toBe(text);
  });

  it("applies content policy before issuing a terminal context reference", async () => {
    const f = await fixture();
    const input = f.add();
    await f.create(input);
    f.children[0]!.data(["-----BEGIN", "PRIVATE KEY-----"].join(" "));
    const attachment = await f.runtime.attach(input);
    await expect(
      attachment.handle({
        protocolVersion: 1,
        terminalId: input.terminalId,
        lifecycleGeneration: 1,
        type: "terminal.context.capture",
        requestId: randomUUID(),
        fromOutputSequence: 1,
        toOutputSequence: 1
      })
    ).rejects.toMatchObject({ code: "context_content_denied" });
  });

  it("bounds cached context bytes by owner and globally", async () => {
    const f = await fixture();
    const sessions = await Promise.all(
      Array.from({ length: 9 }, async () => {
        const input = f.add();
        await f.create(input);
        return { input, attachment: await f.runtime.attach(input) };
      })
    );
    for (const child of f.children) child.data("x".repeat(128 * 1024));
    const capture = (owner: number) => {
      const { input, attachment } = sessions[owner]!;
      return attachment.handle({
        protocolVersion: 1,
        terminalId: input.terminalId,
        lifecycleGeneration: 1,
        type: "terminal.context.capture",
        requestId: randomUUID(),
        fromOutputSequence: 1,
        toOutputSequence: 4
      });
    };
    for (let count = 0; count < 8; count++) await capture(0);
    await expect(capture(0)).rejects.toMatchObject({
      code: "context_capacity"
    });
    for (let owner = 1; owner < 8; owner++)
      for (let count = 0; count < 8; count++) await capture(owner);
    await expect(capture(8)).rejects.toMatchObject({
      code: "context_capacity"
    });
  });

  it("bounds context entries by owner and globally, and expires unconsumed entries", async () => {
    const f = await fixture();
    const sessions = await Promise.all(
      Array.from({ length: 9 }, async () => {
        const input = f.add();
        await f.create(input);
        return { input, attachment: await f.runtime.attach(input) };
      })
    );
    for (const child of f.children) child.data("bounded context\n");
    const capture = (index: number) => {
      const { input, attachment } = sessions[index]!;
      return attachment.handle({
        protocolVersion: 1,
        terminalId: input.terminalId,
        lifecycleGeneration: 1,
        type: "terminal.context.capture",
        requestId: randomUUID(),
        fromOutputSequence: 1,
        toOutputSequence: 1
      });
    };
    vi.useFakeTimers();
    for (let i = 0; i < 16; i++) await capture(0);
    await expect(capture(0)).rejects.toMatchObject({
      code: "context_capacity"
    });
    for (let owner = 1; owner < 8; owner++)
      for (let i = 0; i < 16; i++) await capture(owner);
    await expect(capture(8)).rejects.toMatchObject({
      code: "context_capacity"
    });
    await vi.advanceTimersByTimeAsync(
      MANAGED_TERMINAL_CONTEXT_TTL_SECONDS * 1_000
    );
    expect(vi.getTimerCount()).toBe(0);
    await expect(capture(8)).resolves.toMatchObject([
      { type: "terminal.context.captured" }
    ]);
  });
});
