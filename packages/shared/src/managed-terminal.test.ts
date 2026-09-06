import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createManagedTerminalInputSchema,
  managedTerminalClientFrameSchema,
  managedTerminalServerFrameSchema,
  MANAGED_TERMINAL_MAX_DATA_BYTES,
  MANAGED_TERMINAL_MAX_FRAME_BYTES
} from "./managed-terminal.js";
import { encodeDurableRealtimeStreamFrame } from "./durable-realtime.js";
import { webTransportInteractiveAttachSchema } from "./realtime-transport.js";

describe("managed terminal contracts", () => {
  it("accepts a bounded terminal creation request", () => {
    expect(
      createManagedTerminalInputSchema.parse({
        executionGeneration: 2,
        idempotencyKey: "terminal-create-0001",
        shellProfileId: "system_default",
        columns: 120,
        rows: 40
      })
    ).toEqual({
      executionGeneration: 2,
      idempotencyKey: "terminal-create-0001",
      shellProfileId: "system_default",
      columns: 120,
      rows: 40
    });
  });

  it("rejects unbounded dimensions and unknown shell profiles", () => {
    expect(() =>
      createManagedTerminalInputSchema.parse({
        executionGeneration: 1,
        idempotencyKey: "terminal-create-0001",
        shellProfileId: "/bin/bash",
        columns: 10_000,
        rows: 40
      })
    ).toThrow();
  });

  it("requires explicit terminal authority in interactive attach frames", () => {
    const resourceId = randomUUID();
    expect(
      webTransportInteractiveAttachSchema.parse({
        frameVersion: 1,
        type: "interactive.attach",
        channel: "managed_terminal",
        operationFamily: "managed_terminal",
        resourceId,
        executionId: randomUUID(),
        lifecycleGeneration: 3,
        afterOutputSequence: 41
      })
    ).toMatchObject({ resourceId, lifecycleGeneration: 3 });
    expect(() =>
      webTransportInteractiveAttachSchema.parse({
        frameVersion: 1,
        type: "interactive.attach",
        channel: "managed_terminal",
        operationFamily: "managed_execution",
        resourceId,
        executionId: randomUUID(),
        lifecycleGeneration: 3,
        afterOutputSequence: 41
      })
    ).toThrow();
  });

  it("keeps input epochs explicit and rejects malformed terminal data", () => {
    const terminalId = randomUUID();
    expect(
      managedTerminalClientFrameSchema.parse({
        protocolVersion: 1,
        terminalId,
        lifecycleGeneration: 1,
        type: "terminal.input",
        inputEpoch: randomUUID(),
        sequence: 1,
        dataBase64: Buffer.from("printf test\\n").toString("base64")
      })
    ).toMatchObject({ terminalId, sequence: 1 });
    expect(() =>
      managedTerminalClientFrameSchema.parse({
        protocolVersion: 1,
        terminalId,
        lifecycleGeneration: 1,
        type: "terminal.input",
        inputEpoch: randomUUID(),
        sequence: 1,
        dataBase64: "not-base64!"
      })
    ).toThrow();
  });

  it("models replay gaps and terminal exit without terminal content", () => {
    const terminalId = randomUUID();
    expect(
      managedTerminalServerFrameSchema.parse({
        protocolVersion: 1,
        terminalId,
        lifecycleGeneration: 1,
        type: "terminal.replay_gap",
        requestedAfterOutputSequence: 1,
        earliestOutputSequence: 20
      })
    ).toMatchObject({ earliestOutputSequence: 20 });
    expect(
      managedTerminalServerFrameSchema.parse({
        protocolVersion: 1,
        terminalId,
        lifecycleGeneration: 1,
        type: "terminal.exit",
        exitCode: 0,
        exitSignal: null,
        failureCode: null
      })
    ).toMatchObject({ exitCode: 0 });
  });

  it("keeps the largest terminal payload inside its transport frame budget", () => {
    const terminalFrame = managedTerminalServerFrameSchema.parse({
      protocolVersion: 1,
      terminalId: randomUUID(),
      lifecycleGeneration: 1,
      type: "terminal.output",
      sequence: 1,
      dataBase64: Buffer.alloc(MANAGED_TERMINAL_MAX_DATA_BYTES, 1).toString(
        "base64"
      )
    });
    const encoded = encodeDurableRealtimeStreamFrame(
      {
        event: "terminal_frame",
        id: null,
        data: JSON.stringify(terminalFrame)
      },
      MANAGED_TERMINAL_MAX_FRAME_BYTES
    );
    expect(encoded.byteLength).toBeLessThanOrEqual(
      MANAGED_TERMINAL_MAX_FRAME_BYTES
    );
  });
});
