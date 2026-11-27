import { describe, expect, it, vi } from "vitest";
import {
  controlHelloSchema,
  controlRequestSchema
} from "@koed-labs/shared/local-control-protocol";
import { connectControlClient } from "./client.js";
import type { ControlConnection, ControlTransport } from "./transport.js";

function fakeConnection() {
  let onMessage = (_value: string) => {};
  let onClose = (_error?: string) => {};
  let onEnd = () => {};
  const connection: ControlConnection = {
    peer: { pid: 123, uid: 501 },
    send: vi.fn(async () => {}),
    onMessage(fn) {
      onMessage = fn;
      return () => {};
    },
    onClose(fn) {
      onClose = fn;
      return () => {};
    },
    onEnd(fn) {
      onEnd = fn;
      return () => {};
    },
    close() {
      onClose();
    }
  };
  return {
    connection,
    receive: (value: unknown) => onMessage(JSON.stringify(value)),
    end: () => onEnd()
  };
}
const discovery = {
  schemaVersion: 1 as const,
  home: "/home",
  instanceId: "instance",
  installationId: "install",
  productVersion: "1",
  socketPath: "/run/sock",
  pid: 123,
  processIdentity: "server-id"
};

describe("control client", () => {
  it("checks the echoed nonce and correlates status requests", async () => {
    const f = fakeConnection();
    const transport = {
      connect: async () => f.connection
    } as unknown as ControlTransport;
    const connecting = connectControlClient({
      transport,
      discovery,
      localPid: 456,
      localProcessIdentity: "client-id",
      resolvePeerIdentity: () => "server-id"
    });
    await Promise.resolve();
    const hello = controlHelloSchema.parse(
      JSON.parse(vi.mocked(f.connection.send).mock.calls[0]![0])
    );
    f.receive({ ...hello, pid: 123, processIdentity: "server-id" });
    const client = await connecting;
    const status = client.request({ action: "status" }, 0);
    const sent = controlRequestSchema.parse(
      JSON.parse(vi.mocked(f.connection.send).mock.calls[1]![0])
    );
    f.receive({
      requestId: sent.requestId,
      ok: true,
      snapshot: {
        instanceId: "instance",
        revision: 2,
        state: "ready",
        stopIntent: false
      }
    });
    await expect(status).resolves.toMatchObject({
      ok: true,
      snapshot: { revision: 2 }
    });
    client.close();
  });
  it("rejects when hello send fails", async () => {
    const f = fakeConnection();
    vi.mocked(f.connection.send).mockRejectedValueOnce(
      new Error("write failed")
    );
    const transport = {
      connect: async () => f.connection
    } as unknown as ControlTransport;
    await expect(
      connectControlClient({
        transport,
        discovery,
        localPid: 456,
        localProcessIdentity: "client-id",
        resolvePeerIdentity: () => "server-id"
      })
    ).rejects.toThrow("write failed");
  });
  it("rejects a hello immediately followed by EOF", async () => {
    const f = fakeConnection();
    const transport = {
      connect: async () => f.connection
    } as unknown as ControlTransport;
    const connecting = connectControlClient({
      transport,
      discovery,
      localPid: 456,
      localProcessIdentity: "client-id",
      resolvePeerIdentity: () => "server-id"
    });
    await Promise.resolve();
    const hello = controlHelloSchema.parse(
      JSON.parse(vi.mocked(f.connection.send).mock.calls[0]![0])
    );
    f.receive({ ...hello, pid: 123, processIdentity: "server-id" });
    f.end();
    await expect(connecting).rejects.toThrow("closed during handshake");
  });
  it("rejects a server with a wrong nonce", async () => {
    const f = fakeConnection();
    const transport = {
      connect: async () => f.connection
    } as unknown as ControlTransport;
    const connecting = connectControlClient({
      transport,
      discovery,
      localPid: 456,
      localProcessIdentity: "client-id",
      resolvePeerIdentity: () => "server-id"
    });
    await Promise.resolve();
    const hello = controlHelloSchema.parse(
      JSON.parse(vi.mocked(f.connection.send).mock.calls[0]![0])
    );
    f.receive({
      ...hello,
      nonce: "wrong",
      pid: 123,
      processIdentity: "server-id"
    });
    await expect(connecting).rejects.toThrow();
  });
});
