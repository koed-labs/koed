import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeControlTransport,
  type NativeLocalControl
} from "./native-transport.js";

describe("native control transport", () => {
  afterEach(() => vi.useRealTimers());
  it("authenticates before returning a connection and delivers buffered frames", async () => {
    vi.useFakeTimers();
    const handle = {};
    const native: NativeLocalControl = {
      connect: vi.fn(() => handle),
      finishConnect: vi.fn(() => ({ pid: 42, uid: 501 })),
      read: vi
        .fn()
        .mockReturnValueOnce({ messages: ["hello"], more: false, eof: false })
        .mockReturnValue({ messages: [], more: false, eof: false }),
      write: vi.fn(),
      flush: vi.fn(() => true),
      close: vi.fn(),
      listen: vi.fn(),
      accept: vi.fn()
    };
    const transport = createNativeControlTransport(native);
    const connection = await transport.connect("/private/socket");
    await vi.advanceTimersByTimeAsync(20);
    const messages: string[] = [];
    connection.onMessage((message) => messages.push(message));
    expect(messages).toEqual(["hello"]);
    expect(connection.peer).toEqual({ pid: 42, uid: 501 });
    await connection.send("request");
    expect(native.write).toHaveBeenCalledWith(handle, "request");
    connection.close();
    expect(native.close).toHaveBeenCalledWith(handle);
  });
  it("delivers frames before signaling input EOF", async () => {
    vi.useFakeTimers();
    const handle = {};
    const native = {
      connect: () => handle,
      finishConnect: () => ({ pid: 42, uid: 501 }),
      read: () => ({ messages: ["last"], more: false, eof: true }),
      close: vi.fn()
    } as unknown as NativeLocalControl;
    const connection =
      await createNativeControlTransport(native).connect("/private/socket");
    const events: string[] = [];
    connection.onMessage((value) => events.push(value));
    connection.onEnd(() => events.push("eof"));
    await vi.advanceTimersByTimeAsync(20);
    expect(events).toEqual(["last", "eof"]);
    expect(native.close).not.toHaveBeenCalled();
    connection.close();
  });

  it("buffers input and EOF until listeners attach", async () => {
    vi.useFakeTimers();
    const handle = {};
    const native = {
      connect: () => handle,
      finishConnect: () => ({ pid: 42, uid: 501 }),
      read: () => ({ messages: ["last"], more: false, eof: true }),
      close: vi.fn()
    } as unknown as NativeLocalControl;
    const connection =
      await createNativeControlTransport(native).connect("/private/socket");
    await vi.advanceTimersByTimeAsync(20);
    const events: string[] = [];
    connection.onMessage((value) => events.push(value));
    connection.onEnd(() => events.push("eof"));
    await Promise.resolve();
    expect(events).toEqual(["last", "eof"]);
    connection.close();
  });

  it("closes a connection when its pending write times out", async () => {
    vi.useFakeTimers();
    const handle = {};
    const native = {
      connect: () => handle,
      finishConnect: () => ({ pid: 42, uid: 501 }),
      read: () => ({ messages: [], more: false, eof: false }),
      write: vi.fn(),
      flush: () => false,
      close: vi.fn()
    } as unknown as NativeLocalControl;
    const connection =
      await createNativeControlTransport(native).connect("/private/socket");
    const failed = expect(connection.send("request")).rejects.toThrow(
      "timed out"
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    expect(native.close).toHaveBeenCalledWith(handle);
  });

  it("closes accepted handles and signals terminal listener errors", async () => {
    vi.useFakeTimers();
    const accepted = {};
    const listener = {};
    const native = {
      listen: () => listener,
      accept: () => accepted,
      finishConnect: () => {
        throw new Error("bad peer");
      },
      close: vi.fn()
    } as unknown as NativeLocalControl;
    const server = await createNativeControlTransport(native).listen(
      "/private/socket",
      () => {}
    );
    const errors: Error[] = [];
    server.onError((error) => errors.push(error));
    await vi.advanceTimersByTimeAsync(20);
    expect(native.close).toHaveBeenCalledWith(accepted);
    expect(native.close).toHaveBeenCalledWith(listener);
    expect(errors[0]?.message).toBe("bad peer");
    await server.close();
  });

  it("closes a rejected peer without returning a connection", async () => {
    const handle = {};
    const native = {
      connect: () => handle,
      finishConnect: () => {
        throw new Error("denied");
      },
      close: vi.fn()
    } as unknown as NativeLocalControl;
    await expect(
      createNativeControlTransport(native).connect("/private/socket")
    ).rejects.toThrow("denied");
    expect(native.close).toHaveBeenCalledWith(handle);
  });
});
