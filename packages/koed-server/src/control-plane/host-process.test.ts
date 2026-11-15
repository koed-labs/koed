import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveKoedServerPaths } from "../paths.js";
import {
  acquireControlPlaneAdmission,
  releaseControlPlaneAdmission
} from "./admission.js";
import { createControlStateStore } from "./state.js";
import { startControlPlaneProcess } from "./host-process.js";
import { verifyDesktopRuntimeBundle } from "../desktop-runtime-capability.js";
import type { ControlTransport } from "./transport.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }))
);

function capability(home: string) {
  const resources = resolve(home, "resources");
  const runtime = resolve(resources, "koed-runtime");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(
    resolve(runtime, "desktop-bundle-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      productVersion: "1",
      component: "base",
      target: { platform: "macos", architecture: "arm64" },
      files: []
    })
  );
  return verifyDesktopRuntimeBundle(resources);
}

describe("detached control-plane process", () => {
  it("acquires a single admission and serves a controlled clean test home", async () => {
    const scratch = resolve(import.meta.dirname, "../../../../scratch");
    mkdirSync(scratch, { recursive: true });
    const home = mkdtempSync(resolve(scratch, "host-process-"));
    roots.push(home);
    const paths = resolveKoedServerPaths({ KOED_HOME: home });
    mkdirSync(paths.configDir, { mode: 0o700 });
    const admission = acquireControlPlaneAdmission(paths)!;
    const store = createControlStateStore(paths, admission);
    store.initialize({ kind: "absent" });
    const original = store.read();
    store.write({ ...original, revision: 1, runtimeClean: true }, 0);
    releaseControlPlaneAdmission(admission);
    const transport: ControlTransport = {
      connect: vi.fn(),
      listen: vi.fn(async () => ({
        close: vi.fn(async () => {}),
        onError: () => () => {}
      }))
    };
    const processHost = await startControlPlaneProcess({
      environment: { KOED_HOME: home },
      capability: capability(home),
      transport,
      onFatal: vi.fn()
    });
    expect(processHost.core.status().state).toBe("stopped");
    expect(acquireControlPlaneAdmission(paths)).toBeNull();
    await processHost.close();
    const next = acquireControlPlaneAdmission(paths);
    expect(next).not.toBeNull();
    releaseControlPlaneAdmission(next!);
  });
  it("refuses an uninitialized home instead of inventing clean evidence", async () => {
    const scratch = resolve(import.meta.dirname, "../../../../scratch");
    mkdirSync(scratch, { recursive: true });
    const home = mkdtempSync(resolve(scratch, "host-process-"));
    roots.push(home);
    await expect(
      startControlPlaneProcess({
        environment: { KOED_HOME: home },
        capability: capability(home),
        transport: {} as ControlTransport,
        onFatal: vi.fn()
      })
    ).rejects.toThrow();
  });
});
