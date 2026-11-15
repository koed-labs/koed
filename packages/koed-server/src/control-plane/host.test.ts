import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveKoedServerPaths } from "../paths.js";
import {
  acquireControlPlaneAdmission,
  releaseControlPlaneAdmission
} from "./admission.js";
import { readControlDiscovery } from "./discovery.js";
import { startControlPlaneHost } from "./host.js";
import type { HostCore } from "./host-core.js";
import type { ControlTransport } from "./transport.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }))
);

describe("control-plane host", () => {
  it("reports uncertain listener cleanup if discovery publication and close both fail", async () => {
    const scratch = resolve(import.meta.dirname, "../../../../scratch");
    mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(resolve(scratch, "host-"));
    roots.push(root);
    const paths = resolveKoedServerPaths({ KOED_HOME: root });
    const admission = acquireControlPlaneAdmission(paths)!;
    const close = vi.fn(async () => {
      throw new Error("close failed");
    });
    const transport: ControlTransport = {
      connect: vi.fn(),
      listen: vi.fn(async () => ({ close, onError: () => () => {} }))
    };
    try {
      await expect(
        startControlPlaneHost({
          paths,
          admission,
          core: {} as HostCore,
          transport,
          socketPath: "relative",
          installationId: "install",
          productVersion: "1",
          onFatal: vi.fn()
        })
      ).rejects.toThrow("Control listener cleanup is uncertain");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      releaseControlPlaneAdmission(admission);
    }
  });
  it("publishes after listen and closes connections even if discovery removal fails", async () => {
    const scratch = resolve(import.meta.dirname, "../../../../scratch");
    mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(resolve(scratch, "host-"));
    roots.push(root);
    const paths = resolveKoedServerPaths({ KOED_HOME: root });
    const admission = acquireControlPlaneAdmission(paths)!;
    const close = vi.fn(async () => {});
    const transport: ControlTransport = {
      connect: vi.fn(),
      listen: vi.fn(async () => ({ close, onError: () => () => {} }))
    };
    const core = {
      status: () => ({
        instanceId: admission.instanceId,
        revision: 0,
        state: "stopped",
        stopIntent: false
      }),
      stop: vi.fn()
    } as unknown as HostCore;
    try {
      const host = await startControlPlaneHost({
        paths,
        admission,
        core,
        transport,
        socketPath: resolve(paths.runDir, "control.sock"),
        installationId: "install",
        productVersion: "1",
        onFatal: vi.fn()
      });
      expect(readControlDiscovery(paths)?.instanceId).toBe(
        admission.instanceId
      );
      unlinkSync(resolve(paths.runDir, "control-plane.json"));
      await expect(host.close()).rejects.toThrow("instance mismatch");
      expect(readControlDiscovery(paths)).toBeUndefined();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      releaseControlPlaneAdmission(admission);
    }
  });
});
