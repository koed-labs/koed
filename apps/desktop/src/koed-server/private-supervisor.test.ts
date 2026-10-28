import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { connectSupervisor, requestSupervisor } from "./private-supervisor.js";

const childFixture = () => {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    pid: 123,
    kill: vi.fn(),
    send: vi.fn()
  });
  return {
    child,
    session: { child: child as unknown as ChildProcess, nonce: "a".repeat(64) }
  };
};
describe("private supervisor transport", () => {
  it("ignores foreign nonces and request IDs and removes all RPC listeners after response", async () => {
    const { child, session } = childFixture();
    const result = requestSupervisor(session, "privacy", "install", {}, 1000);
    const request = child.send.mock.calls[0]![0];
    const response = {
      ...request,
      type: "koed.desktop.privacy.response",
      result: { state: "staged" }
    };
    child.emit("message", { ...response, nonce: "b".repeat(64) });
    child.emit("message", { ...response, requestId: "unrelated" });
    expect(child.listenerCount("message")).toBe(1);
    child.emit("message", response);
    await expect(result).resolves.toEqual({ state: "staged" });
    for (const event of ["message", "exit", "error", "disconnect"])
      expect(child.listenerCount(event)).toBe(0);
  });
  it("rejects on disconnect without waiting for a deadline", async () => {
    const { child, session } = childFixture();
    const result = requestSupervisor(session, "status", "doctor");
    child.emit("disconnect");
    await expect(result).rejects.toThrow("disconnected");
    expect(child.listenerCount("message")).toBe(0);
  });
  it("returns authenticated runtime startup failures from the handshake", async () => {
    const { child, session } = childFixture();
    const connected = connectSupervisor(session.child, "/resources");
    const init = child.send.mock.calls[0]![0];
    child.emit("message", {
      type: "koed.desktop.supervisor.start-failed",
      nonce: init.nonce,
      childPid: child.pid,
      bundleDigest: "a".repeat(64),
      mode: "runtime",
      error:
        "Bundled-local Privacy Filter Service could not start: Privacy assets are missing."
    });

    await expect(connected).rejects.toThrow(
      "Bundled-local Privacy Filter Service could not start: Privacy assets are missing."
    );
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects startup failures from a different supervisor identity", async () => {
    const { child, session } = childFixture();
    const connected = connectSupervisor(session.child, "/resources");
    child.emit("message", {
      type: "koed.desktop.supervisor.start-failed",
      nonce: "b".repeat(64),
      childPid: child.pid,
      bundleDigest: "a".repeat(64),
      mode: "runtime",
      error: "Do not accept this message."
    });

    await expect(connected).rejects.toThrow(
      "Desktop supervisor handshake response is invalid."
    );
  });

  it("requires stopped mode, nonce, child identity and digest in the handshake", async () => {
    const { child, session } = childFixture();
    const connected = connectSupervisor(
      session.child,
      "/resources",
      "privacy-management"
    );
    const init = child.send.mock.calls[0]![0];
    child.emit("message", {
      type: "koed.desktop.supervisor.ready",
      nonce: init.nonce,
      childPid: child.pid,
      bundleDigest: "a".repeat(64),
      mode: "runtime"
    });
    await expect(connected).rejects.toThrow("handshake");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
