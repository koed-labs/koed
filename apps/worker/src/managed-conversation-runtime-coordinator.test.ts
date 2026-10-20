import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import type { MemorySourceRepository } from "@koed/db";
import {
  storeDesktopLocalCredential,
  storeLocalEdgeClientCredential
} from "@koed/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createManagedConversationRuntimeCoordinator } from "./managed-conversation-runtime-coordinator.js";

const timeout = <T>(promise: Promise<T>): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("Timed out waiting for file event")),
        5_000
      );
    })
  ]);

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("Managed Conversation runtime coordinator", () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(
      homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
  });

  it("fences and replaces the runner when upstream authority changes", async () => {
    const home = await mkdtemp(join(tmpdir(), "koed-managed-authority-"));
    homes.push(home);
    let authority: {
      backendId: string;
      baseUrl: string;
      authorization: string;
    } | null = null;
    const starts: Array<() => void> = [];
    const started = [deferred<void>(), deferred<void>()];
    const stopped: number[] = [];
    const sourceGenerationId = "00000000-0000-4000-8000-000000000005";
    const getConversationSourceArtifactByGeneration = vi.fn(async () => ({
      id: "00000000-0000-4000-8000-000000000006"
    }));
    const enqueueConversationSourceArtifactReplication = vi.fn(async () => 2);
    const completeForManagedExecutionLease = vi.fn(async () => ({}) as never);
    const putManagedConversationRuntimeItem = vi.fn(async () => ({}) as never);
    let created = 0;
    const createService = vi.fn((input: unknown) => {
      void input;
      const index = created++;
      return {
        start() {
          starts.push(() => started[index]?.resolve());
          starts.at(-1)?.();
        },
        async stop() {
          stopped.push(index);
        },
        async processOnce() {
          return { completed: 0, failed: 0 };
        }
      };
    });
    const coordinator = createManagedConversationRuntimeCoordinator({
      localRepository: {
        getConversationSourceArtifactByGeneration,
        enqueueConversationSourceArtifactReplication,
        completeForManagedExecutionLease,
        getSharedWorkItemDispatchForExecution: vi.fn(async () => null),
        putManagedConversationRuntimeItem
      } as never,
      localOwnerUserId: "00000000-0000-4000-8000-000000000001",
      apiUrl: "http://127.0.0.1:3300",
      apiToken: "cmt_local",
      appServerBinary: "codex",
      deviceId: "00000000-0000-4000-8000-000000000002",
      deploymentId: "00000000-0000-4000-8000-000000000003",
      koedHome: home,
      envelopeEncryptionProvider: {} as never,
      commandWakePool: {} as never,
      logger: pino({ enabled: false }),
      createService: createService as never,
      resolveAuthority: () => authority
    });

    coordinator.start();
    await timeout(started[0]!.promise);
    expect(createService).toHaveBeenCalledOnce();
    const localServiceOptions = createService.mock.calls[0]?.[0] as {
      onKoedToolCompleted?: (event: unknown) => Promise<void>;
    };
    expect(localServiceOptions.onKoedToolCompleted).toBeTypeOf("function");
    await localServiceOptions.onKoedToolCompleted?.({
      execution: {
        id: "00000000-0000-4000-8000-000000000007",
        ownerUserId: "00000000-0000-4000-8000-000000000001",
        executionGeneration: 1
      },
      command: {
        id: "00000000-0000-4000-8000-000000000008",
        leaseToken: "00000000-0000-4000-8000-000000000009"
      },
      providerTurnId: "provider-turn-1",
      toolCallId: "koed-call-1",
      toolName: "work_item_complete",
      arguments: {},
      result: { structuredContent: { status: "requested" } }
    });
    expect(completeForManagedExecutionLease).toHaveBeenCalledWith({
      ownerUserId: "00000000-0000-4000-8000-000000000001",
      executionId: "00000000-0000-4000-8000-000000000007",
      commandId: "00000000-0000-4000-8000-000000000008",
      leaseToken: "00000000-0000-4000-8000-000000000009"
    });
    expect(putManagedConversationRuntimeItem).toHaveBeenCalledOnce();

    authority = {
      backendId: "00000000-0000-4000-8000-000000000004",
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device key:secret"
    };
    await writeFile(
      join(home, "config", "upstream-backends.json"),
      "{}",
      "utf8"
    );
    await timeout(started[1]!.promise);

    expect(stopped).toEqual([0]);
    expect(createService).toHaveBeenCalledTimes(2);
    expect(createService.mock.calls[1]?.[0]).toMatchObject({
      remoteWake: {
        baseUrl: "https://team.example.test",
        authorization: "Koed-Device key:secret"
      }
    });
    const remoteServiceOptions = createService.mock.calls[1]?.[0] as {
      sourcePublishControl: {
        ensure(input: { sourceGenerationId: string }): Promise<void>;
      };
      onKoedToolCompleted?: (event: unknown) => Promise<void>;
    };
    expect(remoteServiceOptions.onKoedToolCompleted).toBeUndefined();
    await remoteServiceOptions.sourcePublishControl.ensure({
      sourceGenerationId
    });
    expect(getConversationSourceArtifactByGeneration).toHaveBeenCalledWith(
      { userId: "00000000-0000-4000-8000-000000000001" },
      sourceGenerationId
    );
    expect(enqueueConversationSourceArtifactReplication).toHaveBeenCalledWith(
      { userId: "00000000-0000-4000-8000-000000000001" },
      {
        artifactId: "00000000-0000-4000-8000-000000000006",
        targetUpstreamId: "00000000-0000-4000-8000-000000000004",
        mode: "hosted_personal"
      }
    );

    await coordinator.stop();
    expect(stopped).toEqual([0, 1]);
  });

  it("uses the guarded repository in the actual local coordinator before launching a shared command", async () => {
    const home = await mkdtemp(join(tmpdir(), "koed-shared-local-runner-"));
    homes.push(home);
    const ownerUserId = "00000000-0000-4000-8000-000000000021";
    const executionId = "00000000-0000-4000-8000-000000000022";
    const commandId = "00000000-0000-4000-8000-000000000023";
    storeDesktopLocalCredential(home, {
      ownerUserId,
      operationFamilies: ["personal_collaboration_write", "managed_execution"]
    });
    storeLocalEdgeClientCredential(home, {
      backendId: "team-vps",
      secret: "team-secret",
      operationFamilies: ["team_workspace_write"]
    });
    let allowed = false;
    const send = vi.fn(async (url: RequestInfo | URL) => {
      if (!allowed)
        return Response.json({ message: "revoked" }, { status: 409 });
      return Response.json(
        new URL(String(url)).pathname.endsWith("shared-progress")
          ? { published: true }
          : { allowed: true }
      );
    });
    const command = {
      id: commandId,
      executionId,
      leaseToken: "00000000-0000-4000-8000-000000000024",
      execution: { id: executionId }
    };
    const fail = vi.fn(async () => ({ updated: true }));
    const putRuntimeItem = vi.fn<
      MemorySourceRepository["putManagedConversationRuntimeItem"]
    >(async () => ({}) as never);
    const localRepository = {
      getSharedWorkItemDispatchForExecution: vi.fn(async () => ({
        teamBackendId: "team-vps"
      })),
      claimManagedConversationCommands: vi.fn(async () => [command]),
      failManagedConversationCommand: fail,
      renewManagedConversationCommandLease: vi.fn(async () => true),
      getManagedConversationExecution: vi.fn(async () => ({
        id: executionId,
        executionGeneration: 1
      })),
      getManagedConversationCommand: vi.fn(async () => ({
        ...command,
        state: "dispatching"
      })),
      putManagedConversationRuntimeItem: putRuntimeItem,
      completeForManagedExecutionLease: vi.fn(async () => ({}))
    };
    let guarded: MemorySourceRepository | null = null;
    let completedTool: ((event: unknown) => Promise<void>) | undefined;
    const coordinator = createManagedConversationRuntimeCoordinator({
      localRepository: localRepository as never,
      localOwnerUserId: ownerUserId,
      apiUrl: "http://127.0.0.1:3300/",
      apiToken: "unused",
      appServerBinary: "codex",
      deviceId: "device",
      deploymentId: "deployment",
      koedHome: home,
      envelopeEncryptionProvider: {} as never,
      commandWakePool: {} as never,
      fetch: send as unknown as typeof fetch,
      logger: pino({ enabled: false }),
      createService: ((input: {
        repository: MemorySourceRepository;
        onKoedToolCompleted?: (event: unknown) => Promise<void>;
      }) => {
        guarded = input.repository;
        completedTool = input.onKoedToolCompleted;
        return {
          start() {},
          async stop() {},
          async processOnce() {
            return { completed: 0, failed: 0 };
          }
        };
      }) as never,
      resolveAuthority: () => null
    });
    coordinator.start();
    await vi.waitFor(() => expect(guarded).not.toBeNull());
    const claimInput = {
      runnerId: "runner",
      deploymentId: "deployment",
      deviceId: "device",
      leaseMs: 30_000
    };
    expect(await guarded!.claimManagedConversationCommands(claimInput)).toEqual(
      []
    );
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId,
        state: "failed",
        errorCode: "SharedDispatchAuthorityUnavailable"
      })
    );
    allowed = true;
    expect(
      await guarded!.claimManagedConversationCommands(claimInput)
    ).toHaveLength(1);
    const event = {
      execution: { id: executionId, ownerUserId, executionGeneration: 1 },
      command: { id: commandId, leaseToken: command.leaseToken },
      toolName: "work_item_complete",
      arguments: {},
      result: { structuredContent: { status: "requested" } },
      toolCallId: "provider-tool-1"
    };
    await completedTool?.(event);
    expect(putRuntimeItem).toHaveBeenCalledWith(
      { userId: ownerUserId },
      expect.objectContaining({
        providerRequestId: `shared-work-item-complete:${commandId}:provider-tool-1`,
        payload: { sharedWorkItemCompletion: "accepted" }
      })
    );
    allowed = false;
    const acceptedBeforeRevoke = putRuntimeItem.mock.calls.filter(
      (call) =>
        (call[1] as { payload?: { sharedWorkItemCompletion?: string } }).payload
          ?.sharedWorkItemCompletion === "accepted"
    ).length;
    await completedTool?.({ ...event, toolCallId: "provider-tool-2" });
    expect(
      putRuntimeItem.mock.calls.filter(
        (call) =>
          (call[1] as { payload?: { sharedWorkItemCompletion?: string } })
            .payload?.sharedWorkItemCompletion === "accepted"
      )
    ).toHaveLength(acceptedBeforeRevoke);
    await expect(
      guarded!.renewManagedConversationCommandLease({
        commandId,
        executionId,
        leaseToken: command.leaseToken,
        runnerId: "runner",
        leaseMs: 30_000
      })
    ).rejects.toThrow("SharedDispatchAuthorityUnavailable");
    expect(
      localRepository.renewManagedConversationCommandLease
    ).not.toHaveBeenCalled();
    await coordinator.stop();
  });
});
