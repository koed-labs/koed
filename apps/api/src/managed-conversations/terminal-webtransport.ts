import {
  managedTerminalServerFrameSchema,
  MANAGED_TERMINAL_MAX_FRAME_BYTES
} from "@koed/shared";
import {
  encodeDurableRealtimeStreamFrame,
  readBoundedDurableRealtimeStream
} from "@koed/shared/durable-realtime";

import type { WebTransportInteractiveStreamHandler } from "../realtime-transport/index.js";
import type { ManagedTerminalRuntime } from "./terminal-runtime.js";

const defaultReauthorizationIntervalMs = 15_000;
const defaultMaximumPendingWriteBytes = 1024 * 1024;

export const createManagedTerminalWebTransportHandler =
  (
    runtime: ManagedTerminalRuntime,
    options: {
      reauthorizationIntervalMs?: number;
      maximumPendingWriteBytes?: number;
    } = {}
  ): WebTransportInteractiveStreamHandler =>
  async ({ attach, stream, principal, reauthenticate, signal }) => {
    if (attach.channel !== "managed_terminal") {
      throw new Error("Managed terminal attach is invalid");
    }
    if (
      principal.operationFamilies !== null &&
      !principal.operationFamilies.has("managed_terminal")
    ) {
      throw new Error("Managed terminal transport is unauthorized");
    }
    const repositoryTerminal = await runtime.attach({
      ownerUserId: principal.user.id,
      executionId: attach.executionId,
      terminalId: attach.resourceId,
      lifecycleGeneration: attach.lifecycleGeneration,
      afterOutputSequence: attach.afterOutputSequence
    });
    const writer = stream.writable.getWriter();
    const controller = new AbortController();
    const reauthorizationIntervalMs =
      options.reauthorizationIntervalMs ?? defaultReauthorizationIntervalMs;
    const maximumPendingWriteBytes =
      options.maximumPendingWriteBytes ?? defaultMaximumPendingWriteBytes;
    if (
      !Number.isSafeInteger(reauthorizationIntervalMs) ||
      reauthorizationIntervalMs < 1 ||
      !Number.isSafeInteger(maximumPendingWriteBytes) ||
      maximumPendingWriteBytes < MANAGED_TERMINAL_MAX_FRAME_BYTES
    ) {
      throw new TypeError("Managed terminal transport limits are invalid");
    }
    let transportFailure: Error | null = null;
    const fail = (error: unknown) => {
      if (transportFailure) return;
      transportFailure =
        error instanceof Error
          ? error
          : new Error("Managed terminal transport failed");
      controller.abort(transportFailure);
      void writer.abort(transportFailure).catch(() => undefined);
    };
    const abortFromParent = () => fail(signal.reason);
    if (signal.aborted) abortFromParent();
    else signal.addEventListener("abort", abortFromParent, { once: true });
    const assertAuthority = async () => {
      const current = await reauthenticate();
      if (
        current.user.id !== principal.user.id ||
        (current.operationFamilies !== null &&
          !current.operationFamilies.has("managed_terminal"))
      ) {
        throw new Error("Managed terminal transport was revoked");
      }
    };
    let reauthorizing = false;
    const reauthorization = setInterval(() => {
      if (reauthorizing) return;
      reauthorizing = true;
      void assertAuthority()
        .catch(fail)
        .finally(() => {
          reauthorizing = false;
        });
    }, reauthorizationIntervalMs);
    reauthorization.unref?.();
    let writes = Promise.resolve();
    let pendingWriteBytes = 0;
    const write = (frame: unknown) => {
      const encoded = encodeDurableRealtimeStreamFrame(
        {
          event: "terminal_frame",
          id: null,
          data: JSON.stringify(managedTerminalServerFrameSchema.parse(frame))
        },
        MANAGED_TERMINAL_MAX_FRAME_BYTES
      );
      if (pendingWriteBytes + encoded.byteLength > maximumPendingWriteBytes) {
        const error = new Error("Managed terminal output queue is full");
        fail(error);
        return Promise.reject(error);
      }
      pendingWriteBytes += encoded.byteLength;
      const operation = writes
        .then(() => writer.write(encoded))
        .catch((error) => {
          fail(error);
          throw error;
        })
        .finally(() => {
          pendingWriteBytes -= encoded.byteLength;
        });
      writes = operation.catch(() => undefined);
      return operation;
    };
    let unsubscribe: () => void = () => undefined;
    try {
      for (const frame of repositoryTerminal.initialFrames) await write(frame);
      unsubscribe = repositoryTerminal.subscribe((frame) => {
        void write(frame).catch(() => undefined);
      });
      await readBoundedDurableRealtimeStream({
        body: stream.readable,
        signal: controller.signal,
        maxFrameBytes: MANAGED_TERMINAL_MAX_FRAME_BYTES,
        onFrame: async (frame) => {
          if (frame.event !== "terminal_frame" || frame.id !== null) {
            throw new Error("Managed terminal stream frame is invalid");
          }
          await assertAuthority();
          let payload: unknown;
          try {
            payload = JSON.parse(frame.data);
          } catch {
            throw new Error("Managed terminal stream frame is invalid");
          }
          for (const response of await repositoryTerminal.handle(payload)) {
            await write(response);
          }
          return "continue" as const;
        }
      });
      if (transportFailure) throw transportFailure;
    } catch (error) {
      throw transportFailure ?? error;
    } finally {
      clearInterval(reauthorization);
      signal.removeEventListener("abort", abortFromParent);
      unsubscribe();
      await repositoryTerminal.close().catch(() => undefined);
      await writes.catch(() => undefined);
      await writer.close().catch(() => undefined);
      writer.releaseLock();
    }
  };
