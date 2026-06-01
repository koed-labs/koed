import { EventEmitter } from "node:events";
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { startAnswerBridgeWithRetry } from "../src/answer-bridge-lifecycle.js";

class FakeServer extends EventEmitter {
  close = vi.fn();
  listen = vi.fn();
}

const asHttpServer = (server: FakeServer): http.Server =>
  server as unknown as http.Server;

describe("answer bridge lifecycle", () => {
  it("skips bridge startup when the configured port is invalid", () => {
    const createServer = vi.fn();
    const log = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    };

    const handle = startAnswerBridgeWithRetry({
      createServer,
      log,
      portValue: "not-a-port"
    });

    expect(createServer).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      { configuredPort: "not-a-port" },
      "memory answer bridge disabled due to invalid port"
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
    const log = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    };
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

    firstServer.emit(
      "error",
      Object.assign(new Error("busy"), {
        code: "EADDRINUSE"
      })
    );

    expect(firstServer.close).toHaveBeenCalledTimes(1);
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 4321,
        retryDelayMs: 25
      }),
      "memory answer bridge port already in use; retrying"
    );

    expect(scheduledRetry).not.toBeNull();
    (scheduledRetry as unknown as () => void)();
    secondServer.emit("listening");

    expect(createServer).toHaveBeenCalledTimes(2);
    expect(secondServer.listen).toHaveBeenCalledWith(4321, "127.0.0.1");
    expect(log.info).toHaveBeenCalledWith(
      {
        host: "127.0.0.1",
        port: 4321,
        url: "http://127.0.0.1:4321"
      },
      "memory answer bridge listening"
    );

    handle.close();

    expect(clearTimeoutFn).not.toHaveBeenCalled();
    expect(secondServer.close).toHaveBeenCalledTimes(1);
  });
});
