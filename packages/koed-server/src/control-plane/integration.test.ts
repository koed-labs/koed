import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveKoedServerPaths } from "../paths.js";
import {
  acquireControlPlaneAdmission,
  releaseControlPlaneAdmission
} from "./admission.js";
import { connectControlClient } from "./client.js";
import { readControlDiscovery } from "./discovery.js";
import { startControlPlaneHost } from "./host.js";
import { createControlPlaneHostCore } from "./host-core.js";
import type { ControlIntent, ControlStateStore } from "./state.js";
import type { ControlConnection, ControlTransport } from "./transport.js";

/** In-memory transport only: this test does not exercise native peer authentication. */
function memoryTransport(): ControlTransport {
  let accept: (connection: ControlConnection) => void = () => {};
  return {
    async listen(_path, onAccept) {
      accept = onAccept;
      return { onError: () => () => {}, close: async () => {} };
    },
    async connect() {
      let leftMessage = (_message: string) => {};
      let rightMessage = (_message: string) => {};
      let leftClose = (_error?: string) => {};
      let rightClose = (_error?: string) => {};
      let closed = false;
      const peer = { pid: process.pid, uid: process.getuid?.() ?? 0 };
      const left: ControlConnection = {
        peer,
        send: async (message) => {
          queueMicrotask(() => rightMessage(message));
        },
        onMessage: (fn) => {
          leftMessage = fn;
          return () => {};
        },
        onEnd: () => () => {},
        onClose: (fn) => {
          leftClose = fn;
          return () => {};
        },
        close: () => {
          if (!closed) {
            closed = true;
            rightClose();
          }
        }
      };
      const right: ControlConnection = {
        peer,
        send: async (message) => {
          queueMicrotask(() => leftMessage(message));
        },
        onMessage: (fn) => {
          rightMessage = fn;
          return () => {};
        },
        onEnd: () => () => {},
        onClose: (fn) => {
          rightClose = fn;
          return () => {};
        },
        close: () => {
          if (!closed) {
            closed = true;
            leftClose();
          }
        }
      };
      accept(right);
      return left;
    }
  };
}

describe("control-plane client integration with simulated transport", () => {
  it("shares one runtime, preserves CLI demand across Desktop detach and remembers Stop", async () => {
    const scratch = resolve(import.meta.dirname, "../../../../scratch");
    mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(resolve(scratch, "control-integration-"));
    const paths = resolveKoedServerPaths({ KOED_HOME: root });
    const admission = acquireControlPlaneAdmission(paths)!;
    let state: ControlIntent = {
      schemaVersion: 1,
      revision: 0,
      stopIntent: false,
      backgroundEnabled: false,
      persistentCli: false,
      runtimeClean: true,
      protectedGenerationId: null
    };
    const store: ControlStateStore = {
      read: () => ({ ...state }),
      initialize: vi.fn(),
      write(next, expected) {
        if (state.revision !== expected) throw new Error("stale");
        state = { ...next };
      }
    };
    let finish!: (value: { clean: boolean }) => void;
    const stop = vi.fn(() => finish({ clean: true }));
    const start = vi.fn(() => ({
      stop,
      done: new Promise<{ clean: boolean }>((resolveDone) => {
        finish = resolveDone;
      })
    }));
    const core = createControlPlaneHostCore({
      instanceId: admission.instanceId,
      store,
      startRuntime: start
    });
    const transport = memoryTransport();
    try {
      const host = await startControlPlaneHost({
        paths,
        admission,
        core,
        transport,
        socketPath: "/tmp/koed-simulated-control.sock",
        installationId: "test-install",
        productVersion: "1",
        onFatal: vi.fn()
      });
      const discovery = readControlDiscovery(paths)!;
      let desktop = await connectControlClient({ transport, discovery });
      const desktopSessionId = "cb64b350-203a-4aa2-944e-e84d1d9aef39";
      const cli = await connectControlClient({ transport, discovery });
      const attached = await desktop.request(
        { action: "attach", reason: "desktop-session", desktopSessionId },
        0
      );
      expect(attached.ok).toBe(true);
      const started = await desktop.request(
        { action: "start", explicit: true },
        attached.snapshot.revision
      );
      expect(started.ok).toBe(true);
      desktop.close();
      desktop = await connectControlClient({ transport, discovery });
      const reattached = await desktop.request(
        { action: "attach", reason: "desktop-session", desktopSessionId },
        started.snapshot.revision
      );
      expect(reattached.ok).toBe(true);
      const duplicate = await connectControlClient({ transport, discovery });
      expect(
        (
          await duplicate.request(
            { action: "attach", reason: "desktop-session", desktopSessionId },
            reattached.snapshot.revision
          )
        ).ok
      ).toBe(false);
      duplicate.close();
      const persistent = await cli.request(
        { action: "start", explicit: true, persistentCli: true },
        reattached.snapshot.revision
      );
      expect(persistent.ok).toBe(true);
      expect(start).toHaveBeenCalledOnce();
      const detached = await desktop.request(
        { action: "detach", reason: "desktop-session", intentional: true },
        persistent.snapshot.revision
      );
      expect(detached.ok).toBe(true);
      expect(stop).not.toHaveBeenCalled();
      const stopped = await cli.request(
        { action: "stop", explicit: true },
        detached.snapshot.revision
      );
      expect(stopped.ok).toBe(true);
      await vi.waitFor(() => expect(core.status().state).toBe("stopped"));
      expect(store.read()).toMatchObject({
        stopIntent: true,
        persistentCli: false,
        runtimeClean: true
      });
      const agent = await connectControlClient({ transport, discovery });
      const enabled = await agent.request(
        { action: "attach", reason: "background-agent" },
        core.status().revision
      );
      expect(enabled.ok).toBe(true);
      const automatic = await agent.request(
        { action: "start", explicit: false },
        enabled.snapshot.revision
      );
      expect(automatic.ok).toBe(false);
      expect(store.read()).toMatchObject({
        stopIntent: true,
        backgroundEnabled: true
      });
      agent.close();
      desktop.close();
      cli.close();
      await host.close();
    } finally {
      releaseControlPlaneAdmission(admission);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
