import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
