import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
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
        enqueueConversationSourceArtifactReplication
      } as never,
      localOwnerUserId: "00000000-0000-4000-8000-000000000001",
      apiUrl: "http://127.0.0.1:3300",
      apiToken: "cmt_local",
      appServerBinary: "codex",
      model: "gpt-test",
      claudeModel: "claude-haiku-4-5-20251001",
      reasoningEffort: "low",
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
    };
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
});
