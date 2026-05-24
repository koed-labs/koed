import { EventEmitter } from "node:events";
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { startAnswerBridgeWithRetry } from "./answer-bridge-lifecycle.js";

class FakeServer extends EventEmitter {
  close = vi.fn();
  listen = vi.fn();
}

const asHttpServer = (server: FakeServer): http.Server =>
  server as unknown as http.Server;

describe("answer bridge lifecycle", () => {
  it("skips bridge startup when the configured port is invalid", () => {
    const createServer = vi.fn();
    const log = { error: vi.fn() };

    const handle = startAnswerBridgeWithRetry({
      createServer,
      log,
      portValue: "not-a-port"
    });

    expect(createServer).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      'Koed memory answer bridge disabled: MEMORY_ANSWER_BRIDGE_PORT must be an integer from 1 to 65535 (received "not-a-port").'
    );

    expect(() => handle.close()).not.toThrow();
  });

  it("retries binding after a port conflict and starts when the port is free", () => {
    const firstServer = new FakeServer();
    const secondServer = new FakeServer();
    const createServer = vi
      .fn()
      .mockReturnValueOnce(asHttpServer(firstServer))
      .mockReturnValueOnce(asHttpServer(secondServer));
    const log = { error: vi.fn() };
    const clearTimeoutFn = vi.fn();
    let scheduledRetry: (() => void) | null = null;
    const setTimeoutFn = vi.fn((callback: () => void) => {
      scheduledRetry = callback;
      return 1 as unknown as NodeJS.Timeout;
    });

    const handle = startAnswerBridgeWithRetry({
      clearTimeoutFn,
      createServer,
      host: "127.0.0.1",
      log,
      portValue: "4321",
      retryDelayMs: 25,
      setTimeoutFn
    });

    firstServer.emit("error", Object.assign(new Error("busy"), {
      code: "EADDRINUSE"
    }));

    expect(firstServer.close).toHaveBeenCalledTimes(1);
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      "Koed memory answer bridge port 4321 is already in use; retrying in 25ms."
    );

    expect(scheduledRetry).not.toBeNull();
    (scheduledRetry as unknown as () => void)();
    secondServer.emit("listening");

    expect(createServer).toHaveBeenCalledTimes(2);
    expect(secondServer.listen).toHaveBeenCalledWith(4321, "127.0.0.1");
    expect(log.error).toHaveBeenCalledWith(
      "Koed memory answer bridge listening on http://127.0.0.1:4321"
    );

    handle.close();

    expect(clearTimeoutFn).not.toHaveBeenCalled();
    expect(secondServer.close).toHaveBeenCalledTimes(1);
  });
});
