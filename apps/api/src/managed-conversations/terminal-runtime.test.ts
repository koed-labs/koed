import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { MemorySourceRepository } from "@koed/db";
import type {
  ManagedTerminalRecord,
  ManagedTerminalServerFrame
} from "@koed/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createManagedTerminalRuntime } from "./terminal-runtime.js";
import { terminalPreviewUrls } from "./terminal-runtime.js";
import { createManagedDevelopmentPreviewRuntime } from "./preview-runtime.js";

const roots: string[] = [];
const childPids: number[] = [];

const eventually = async <T>(
  read: () => T | undefined | Promise<T | undefined>
): Promise<T> => {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("Expected terminal event did not arrive");
};

const availableLoopbackPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Loopback test listener did not expose a port");
  }
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose()))
  );
  return address.port;
};

afterEach(async () => {
  delete process.env.KOED_TERMINAL_TEST_SECRET;
  for (const pid of childPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The terminal runtime already reaped it.
    }
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  );
});

describe("managed terminal runtime", () => {
  it("extracts only credential-free loopback preview candidates", () => {
    expect(
      terminalPreviewUrls(
        "\u001b[32mLocal: http://localhost:5173/app?test=1\u001b[0m\n" +
          "http://0.0.0.0:5173 http://user:secret@127.0.0.1:5173"
      )
    ).toEqual(["http://localhost:5173/app?test=1"]);
  });

  it("runs in the exact workspace, keeps secrets out of the shell, replays output, and fences input", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "koed-terminal-runtime-"));
    roots.push(root);
    const projectPath = resolve(root, "project");
    await mkdir(projectPath);
    const ownerUserId = randomUUID();
    const executionId = randomUUID();
    const workspaceId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const terminalId = randomUUID();
    let record: ManagedTerminalRecord = {
      id: terminalId,
      executionId,
      executionGeneration: 1,
      workspaceId,
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
      createdAt: new Date().toISOString(),
      startedAt: null,
      detachedAt: null,
      stoppedAt: null,
      updatedAt: new Date().toISOString()
    };
    const transition = vi.fn(async (input: Record<string, unknown>) => {
      if (
        input.fromStates instanceof Array &&
        !input.fromStates.includes(record.state)
      ) {
        return null;
      }
      const state = input.state as ManagedTerminalRecord["state"];
      record = {
        ...record,
        state,
        columns: (input.columns as number | undefined) ?? record.columns,
        rows: (input.rows as number | undefined) ?? record.rows,
        exitCode: (input.exitCode as number | null | undefined) ?? null,
        exitSignal: (input.exitSignal as number | null | undefined) ?? null,
        failureCode: (input.failureCode as string | null | undefined) ?? null,
        startedAt:
          state === "running"
            ? (record.startedAt ?? new Date().toISOString())
            : record.startedAt,
        detachedAt: state === "detached" ? new Date().toISOString() : null,
        stoppedAt:
          state === "exited" || state === "failed"
            ? new Date().toISOString()
            : record.stoppedAt,
        updatedAt: new Date().toISOString()
      };
      return record;
    });
    const repository = {
      reconcileManagedTerminalsForRunner: vi.fn(async () => 0),
      createManagedTerminal: vi.fn(async () => record),
      getManagedTerminal: vi.fn(async () => record),
      transitionManagedTerminal: transition,
      getManagedConversationExecution: vi.fn(async () => ({
        id: executionId,
        executionGeneration: 1
      })),
      getManagedConversationRuntimeBinding: vi.fn(async () => ({
        executionId,
        ownerUserId,
        deploymentId,
        deviceId,
        executionGeneration: 1,
        sourceProjectPath: projectPath,
        projectPath,
        workspaceId,
        workspaceKind: "non_vcs_directory",
        workspaceLifecycle: "ready",
        cleanupState: "not_requested",
        vcsDriver: null,
        localRepositoryCommonDirectory: null,
        localGitDirectory: null,
        repositoryIdentityHash: null,
        worktreeIdentityHash: null,
        baseRef: null,
        baseObjectId: null,
        branchRef: null,
        headObjectId: null,
        creationOperationId: randomUUID(),
        localSessionId: null,
        providerThreadId: null,
        transcriptPath: null,
        managedHome: null,
        providerCliVersion: null,
        sourceGenerationId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }))
    } as unknown as MemorySourceRepository;
    process.env.KOED_TERMINAL_TEST_SECRET = "must-not-leak";
    const runtime = createManagedTerminalRuntime({
      requireRepository: () => repository,
      inspectIdentity: () => ({
        health: "healthy",
        deploymentId,
        deviceInstanceId: deviceId,
        remoteOperationsAllowed: true,
        message: "ready",
        platformProtection: "verified"
      }),
      koedHome: root,
      detachedTtlMs: 50
    });
    await runtime.create(ownerUserId, executionId, {
      executionGeneration: 1,
      idempotencyKey: "terminal-runtime-test-0001",
      shellProfileId: "system_default",
      columns: 120,
      rows: 40
    });
    expect(record.state).toBe("running");
    expect(
      runtime.hasLiveExecutionTerminal({
        ownerUserId,
        executionId,
        executionGeneration: 1
      })
    ).toBe(true);
    const first = await runtime.attach({
      ownerUserId,
      executionId,
      terminalId,
      lifecycleGeneration: 1,
      afterOutputSequence: 0
    });
    const frames: ManagedTerminalServerFrame[] = [];
    const unsubscribe = first.subscribe((frame) => frames.push(frame));
    const inputEpoch = first.initialFrames.find(
      (frame) => frame.type === "terminal.ready"
    );
    if (inputEpoch?.type !== "terminal.ready")
      throw new Error("ready frame missing");
    const command =
      'sleep 30 & child=$!; printf \'KOED_RESULT:%s:%s:CHILD:%s\\n\' "$PWD" "${KOED_TERMINAL_TEST_SECRET:-redacted}" "$child"\n';
    const input = {
      protocolVersion: 1,
      terminalId,
      lifecycleGeneration: 1,
      type: "terminal.input",
      inputEpoch: inputEpoch.inputEpoch,
      sequence: 1,
      dataBase64: Buffer.from(command).toString("base64")
    };
    await expect(first.handle(input)).resolves.toMatchObject([
      { type: "terminal.input_ack", sequence: 1 }
    ]);
    await expect(first.handle(input)).resolves.toMatchObject([
      { type: "terminal.input_ack", sequence: 1 }
    ]);
    const output = await eventually(() => {
      const text = frames
        .filter((frame) => frame.type === "terminal.output")
        .map((frame) =>
          Buffer.from(frame.dataBase64, "base64").toString("utf8")
        )
        .join("");
      return text.includes(`KOED_RESULT:${projectPath}:redacted`)
        ? text
        : undefined;
    });
    expect(output).toContain(projectPath);
    expect(output).not.toContain("must-not-leak");
    expect(
      output.match(new RegExp(`KOED_RESULT:${projectPath}:redacted`, "g"))
    ).toHaveLength(1);
    const childPid = Number(/:CHILD:(\d+)/.exec(output)?.[1]);
    expect(Number.isSafeInteger(childPid)).toBe(true);
    childPids.push(childPid);
    const outputFrames = frames.filter(
      (
        frame
      ): frame is Extract<
        ManagedTerminalServerFrame,
        { type: "terminal.output" }
      > => frame.type === "terminal.output"
    );
    const from = outputFrames[0]!.sequence;
    const to = outputFrames.at(-1)!.sequence;
    const context = await first.handle({
      protocolVersion: 1,
      terminalId,
      lifecycleGeneration: 1,
      type: "terminal.context.capture",
      requestId: randomUUID(),
      fromOutputSequence: from,
      toOutputSequence: to
    });
    expect(context).toMatchObject([{ type: "terminal.context.captured" }]);
    const captured = context[0];
    if (captured?.type !== "terminal.context.captured") {
      throw new Error("context frame missing");
    }
    expect(
      runtime.resolveContext({
        ownerUserId,
        executionId,
        contextReference: captured.contextReference
      }).content
    ).toContain(`KOED_RESULT:${projectPath}:redacted`);
    expect(() =>
      runtime.resolveContext({
        ownerUserId: randomUUID(),
        executionId,
        contextReference: captured.contextReference
      })
    ).toThrow("unavailable");

    const previewChanges: string[] = [];
    const previewRuntime = createManagedDevelopmentPreviewRuntime({
      requireRepository: () => repository,
      terminalRuntime: runtime,
      onChange: (preview) =>
        previewChanges.push(
          preview.state === "available" ? "running" : "exited"
        )
    });
    const previewPort = await availableLoopbackPort();
    const previewCommand =
      `${process.execPath} -e 'const http=require("http");` +
      `http.createServer((_q,r)=>r.end("koed-preview-ready"))` +
      `.listen(${previewPort},"127.0.0.1",()=>console.log("http://localhost:${previewPort}"))' ` +
      `& preview_child=$!; printf 'PREVIEW_CHILD:%s\\n' "$preview_child"\n`;
    await expect(
      first.handle({
        protocolVersion: 1,
        terminalId,
        lifecycleGeneration: 1,
        type: "terminal.input",
        inputEpoch: inputEpoch.inputEpoch,
        sequence: 2,
        dataBase64: Buffer.from(previewCommand).toString("base64")
      })
    ).resolves.toMatchObject([{ type: "terminal.input_ack", sequence: 2 }]);
    const discoveredPreview = await eventually(async () => {
      const [preview] = await previewRuntime.list(ownerUserId, executionId);
      return preview?.state === "available" ? preview : undefined;
    });
    expect(previewChanges).toContain("running");
    const previewAccess = await previewRuntime.access({
      ownerUserId,
      executionId,
      previewId: discoveredPreview.id,
      lifecycleGeneration: discoveredPreview.lifecycleGeneration
    });
    expect(await (await fetch(previewAccess.navigationUrl)).text()).toBe(
      "koed-preview-ready"
    );
    const previewOutput = await eventually(() => {
      const text = frames
        .filter((frame) => frame.type === "terminal.output")
        .map((frame) =>
          Buffer.from(frame.dataBase64, "base64").toString("utf8")
        )
        .join("");
      return text.includes("PREVIEW_CHILD:") ? text : undefined;
    });
    const previewChildPid = Number(
      /PREVIEW_CHILD:(\d+)/.exec(previewOutput)?.[1]
    );
    expect(Number.isSafeInteger(previewChildPid)).toBe(true);
    childPids.push(previewChildPid);

    unsubscribe();
    await first.close();
    expect(record.state).toBe("detached");
    const second = await runtime.attach({
      ownerUserId,
      executionId,
      terminalId,
      lifecycleGeneration: 1,
      afterOutputSequence: 0
    });
    expect(
      second.initialFrames.some((frame) => frame.type === "terminal.output")
    ).toBe(true);
    await second.close();
    await runtime.stop({ ownerUserId, executionId, terminalId });
    await eventually(() => (record.state === "exited" ? record : undefined));
    expect(
      runtime.hasLiveExecutionTerminal({
        ownerUserId,
        executionId,
        executionGeneration: 1
      })
    ).toBe(false);
    await eventually(async () => {
      const [preview] = await previewRuntime.list(ownerUserId, executionId);
      return preview?.state === "closed" ? preview : undefined;
    });
    await eventually(() => {
      try {
        process.kill(childPid, 0);
        return undefined;
      } catch (error) {
        return error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ESRCH"
          ? true
          : undefined;
      }
    });
    childPids.splice(childPids.indexOf(childPid), 1);
    childPids.splice(childPids.indexOf(previewChildPid), 1);
    previewRuntime.close();

    const expiringTerminalId = randomUUID();
    record = {
      ...record,
      id: expiringTerminalId,
      state: "creating",
      exitCode: null,
      exitSignal: null,
      failureCode: null,
      startedAt: null,
      detachedAt: null,
      stoppedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await runtime.create(ownerUserId, executionId, {
      executionGeneration: 1,
      idempotencyKey: "terminal-runtime-test-0002",
      shellProfileId: "system_default",
      columns: 80,
      rows: 24
    });
    const expiring = await runtime.attach({
      ownerUserId,
      executionId,
      terminalId: expiringTerminalId,
      lifecycleGeneration: 1,
      afterOutputSequence: 0
    });
    await expiring.close();
    expect(record.state).toBe("detached");
    await eventually(() => (record.state === "exited" ? record : undefined));
    await runtime.close();
  });
});
