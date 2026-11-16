import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  realpathSync
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveKoedServerPaths } from "../paths.js";
import {
  acquireControlPlaneAdmission,
  releaseControlPlaneAdmission
} from "./admission.js";
import { createControlStateStore } from "./state.js";
import { startControlPlaneService } from "./service.js";
import type { DesktopRuntimeCapability } from "../desktop-runtime-capability.js";
import type { ControlTransport } from "./transport.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }))
);

describe("control-plane service assembly", () => {
  it("initializes a new home for practical startup under admission", async () => {
    const scratch = resolve(import.meta.dirname, "../../../../scratch");
    mkdirSync(scratch, { recursive: true });
    const home = mkdtempSync(resolve(scratch, "service-"));
    roots.push(home);
    const paths = resolveKoedServerPaths({ KOED_HOME: home });
    mkdirSync(paths.configDir, { mode: 0o700 });
    const admission = acquireControlPlaneAdmission(paths)!;
    const transport: ControlTransport = {
      connect: vi.fn(),
      listen: vi.fn(async () => ({
        close: async () => {},
        onError: () => () => {}
      }))
    };
    try {
      const service = await startControlPlaneService({
        paths,
        admission,
        transport,
        environment: { KOED_HOME: home },
        capability: {
          installationPath: "/install",
          productVersion: "1"
        } as DesktopRuntimeCapability,
        onFatal: vi.fn()
      });
      expect(service.core.status()).toMatchObject({
        state: "stopped",
        stopIntent: false,
        revision: 0
      });
      await service.close();
    } finally {
      releaseControlPlaneAdmission(admission);
    }
  });
  it("preserves prior runtime evidence even if persisted control state was clean", async () => {
    const scratch = resolve(import.meta.dirname, "../../../../scratch");
    mkdirSync(scratch, { recursive: true });
    const home = mkdtempSync(resolve(scratch, "s-"));
    roots.push(home);
    const paths = resolveKoedServerPaths({ KOED_HOME: home });
    mkdirSync(paths.configDir, { mode: 0o700 });
    const admission = acquireControlPlaneAdmission(paths)!;
    const store = createControlStateStore(paths, admission);
    store.initialize({ kind: "absent" }, { assumeStopped: true });
    writeFileSync(paths.runtimeStatePath, "{}", { mode: 0o600 });
    const transport: ControlTransport = {
      connect: vi.fn(),
      listen: vi.fn(async () => ({
        close: async () => {},
        onError: () => () => {}
      }))
    };
    try {
      const service = await startControlPlaneService({
        paths,
        admission,
        transport,
        environment: { KOED_HOME: home },
        capability: {
          installationPath: "/install",
          productVersion: "1"
        } as DesktopRuntimeCapability,
        onFatal: vi.fn()
      });
      expect(service.core.status().state).toBe("needs_attention");
      expect(store.read().runtimeClean).toBe(false);
      await expect(service.close()).rejects.toThrow();
    } finally {
      releaseControlPlaneAdmission(admission);
    }
  });
  it("refuses automatic legacy migration without Operator confirmation", async () => {
    const scratch = resolve(import.meta.dirname, "../../../../scratch");
    mkdirSync(scratch, { recursive: true });
    const home = realpathSync(mkdtempSync(resolve(scratch, "service-")));
    roots.push(home);
    const paths = resolveKoedServerPaths({ KOED_HOME: home });
    mkdirSync(paths.configDir, { mode: 0o700 });
    const admission = acquireControlPlaneAdmission(paths)!;
    writeFileSync(
      resolve(paths.runDir, "background-agent-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        installationId: "12345678-1234-4234-8234-123456789abc",
        bundlePath: "/Applications/Koed.app",
        koedHome: home,
        generation: 1,
        state: "stopped",
        stopIntent: true,
        updatedAt: "2026-01-01T00:00:00.000Z"
      }),
      { mode: 0o600 }
    );
    const transport: ControlTransport = {
      connect: vi.fn(),
      listen: vi.fn(async () => ({
        close: async () => {},
        onError: () => () => {}
      }))
    };
    try {
      await expect(
        startControlPlaneService({
          paths,
          admission,
          transport,
          environment: { KOED_HOME: home },
          capability: {
            installationPath: "/install",
            productVersion: "1"
          } as DesktopRuntimeCapability,
          onFatal: vi.fn()
        })
      ).rejects.toThrow("Stop the old Desktop and Agent");
    } finally {
      releaseControlPlaneAdmission(admission);
    }
  });
  it("exposes the existing durable state through the host and releases no borrowed admission", async () => {
    const scratch = resolve(import.meta.dirname, "../../../../scratch");
    mkdirSync(scratch, { recursive: true });
    const home = mkdtempSync(resolve(scratch, "service-"));
    roots.push(home);
    const paths = resolveKoedServerPaths({ KOED_HOME: home });
    mkdirSync(paths.configDir, { mode: 0o700 });
    const admission = acquireControlPlaneAdmission(paths)!;
    const store = createControlStateStore(paths, admission);
    store.initialize({ kind: "absent" });
    const original = store.read();
    store.write({ ...original, revision: 1, runtimeClean: true }, 0);
    const close = vi.fn(async () => {});
    const transport: ControlTransport = {
      connect: vi.fn(),
      listen: vi.fn(async () => ({ close, onError: () => () => {} }))
    };
    try {
      const service = await startControlPlaneService({
        paths,
        admission,
        transport,
        environment: { KOED_HOME: home },
        capability: {
          installationPath: "/install",
          productVersion: "1"
        } as DesktopRuntimeCapability,
        onFatal: vi.fn()
      });
      const socket = vi.mocked(transport.listen).mock.calls[0]![0];
      expect(socket).toBe(
        resolve(
          paths.runDir,
          `c-${admission.instanceId.replaceAll("-", "").slice(0, 12)}`
        )
      );
      expect(service.core.status()).toMatchObject({
        state: "stopped",
        revision: 1
      });
      await service.close();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      releaseControlPlaneAdmission(admission);
    }
  });
});
