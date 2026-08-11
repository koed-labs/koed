import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";
import type { DesktopUpdateState } from "@koed/shared";
import {
  desktopUpdateCommandChannel,
  desktopUpdateGetStateChannel,
  desktopUpdateSubscribeChannel,
  desktopUpdateVersionChannel
} from "./protocol.js";
import { registerDesktopUpdateIpc } from "./update.js";

type FakeEvent = {
  sender: FakeSender;
  senderFrame: { url: string };
};

class FakeSender {
  readonly sent: unknown[][] = [];
  destroyed = false;
  isDestroyed = () => this.destroyed;
  send = vi.fn((...args: unknown[]) => {
    this.sent.push(args);
  });
  readonly mainFrame = { url: "koed://app/" };
}

class FakeIpc {
  readonly handlers = new Map<
    string,
    (event: FakeEvent, value?: unknown) => Promise<unknown> | unknown
  >();
  handle = (
    channel: string,
    handler: (event: FakeEvent, value?: unknown) => Promise<unknown> | unknown
  ) => {
    this.handlers.set(channel, handler);
  };
  removeHandler = (channel: string) => {
    this.handlers.delete(channel);
  };
  invoke = (channel: string, event: FakeEvent, value?: unknown) =>
    this.handlers.get(channel)?.(event, value);
}

const state: DesktopUpdateState = { status: "idle" };

const createFixture = (currentState: unknown = state) => {
  const ipc = new FakeIpc();
  const sender = new FakeSender();
  const listeners = new Set<(value: DesktopUpdateState) => void>();
  const coordinator = {
    getState: vi.fn(() => currentState as DesktopUpdateState),
    subscribe: vi.fn((listener: (value: DesktopUpdateState) => void) => {
      listeners.add(listener);
      listener(currentState as DesktopUpdateState);
      return () => listeners.delete(listener);
    }),
    check: vi.fn(async () => state),
    download: vi.fn(async () => state),
    install: vi.fn(async () => state)
  };
  const dispose = registerDesktopUpdateIpc(
    ipc as unknown as Pick<IpcMain, "handle" | "removeHandler">,
    coordinator,
    {
      allowedRendererOrigins: new Set(["koed://app"]),
      broadcastState: vi.fn(),
      getAppVersion: () => "0.5.0"
    }
  );
  const event = {
    sender,
    senderFrame: sender.mainFrame
  };
  return { coordinator, dispose, event, ipc, sender };
};

describe("Desktop update IPC", () => {
  it("exposes only validated state, commands, and Electron version", async () => {
    const fixture = createFixture();
    await expect(
      fixture.ipc.invoke(desktopUpdateGetStateChannel, fixture.event)
    ).resolves.toEqual(state);
    await expect(
      fixture.ipc.invoke(desktopUpdateCommandChannel, fixture.event, "check")
    ).resolves.toEqual(state);
    await expect(
      fixture.ipc.invoke(desktopUpdateVersionChannel, fixture.event)
    ).resolves.toBe("0.5.0");
    expect(fixture.coordinator.check).toHaveBeenCalledTimes(1);
    expect(fixture.coordinator.download).not.toHaveBeenCalled();
    expect(fixture.coordinator.install).not.toHaveBeenCalled();
  });

  it("rejects malformed payloads, unsafe state, and untrusted senders", async () => {
    const unsafe = createFixture();
    unsafe.coordinator.getState.mockReturnValue({
      status: "available",
      release: {
        version: "0.5.0",
        channel: "stable",
        releaseNotes: "Authorization: Bearer secret"
      }
    } as DesktopUpdateState);
    await expect(
      unsafe.ipc.invoke(desktopUpdateGetStateChannel, unsafe.event)
    ).rejects.toThrow();
    await expect(
      unsafe.ipc.invoke(desktopUpdateCommandChannel, unsafe.event, {
        command: "check",
        url: "https://private"
      })
    ).rejects.toThrow();
    await expect(
      unsafe.ipc.invoke(desktopUpdateVersionChannel, unsafe.event, {
        version: "0.5.0"
      })
    ).rejects.toThrow();

    const untrustedEvent = {
      ...unsafe.event,
      senderFrame: { url: "https://evil.example/" }
    };
    await expect(
      unsafe.ipc.invoke(desktopUpdateGetStateChannel, untrustedEvent)
    ).rejects.toThrow("Untrusted Desktop IPC sender.");
  });

  it("sends one initial state per subscription and disposes handlers idempotently", async () => {
    const fixture = createFixture();
    await expect(
      fixture.ipc.invoke(desktopUpdateSubscribeChannel, fixture.event)
    ).resolves.toEqual(state);
    expect(fixture.sender.sent).toEqual([]);
    fixture.dispose();
    fixture.dispose();
    expect(fixture.ipc.handlers.size).toBe(0);
    expect(fixture.coordinator.subscribe).toHaveBeenCalledTimes(1);
  });

  it("does not relay updater command exception details", async () => {
    const fixture = createFixture();
    fixture.coordinator.check.mockRejectedValueOnce(
      new Error("https://token:secret@example.test/private")
    );
    await expect(
      fixture.ipc.invoke(desktopUpdateCommandChannel, fixture.event, "check")
    ).rejects.toThrow("Koed update command failed.");
    await expect(
      fixture.ipc.invoke(desktopUpdateCommandChannel, fixture.event, "check")
    ).resolves.toEqual(state);
  });
});
