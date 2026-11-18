import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveKoedServerPaths } from "../paths.js";
import {
  acquireControlPlaneAdmission,
  releaseControlPlaneAdmission
} from "./admission.js";
import { createControlStateStore } from "./state.js";
import { startControlPlaneProcess } from "./host-process.js";
import { readControlDiscovery } from "./discovery.js";
import { waitForRetiredControlPlaneOwner } from "./installed-client.js";
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

const childHost = `
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
// Resolve the repository's TypeScript sources before build/manifest emission.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
    const source = new URL(specifier.replace(/\\.js$/, '.ts'), context.parentURL);
    if (existsSync(source)) return next(source.href, context);
  }
  return next(specifier, context);
} });
const { runControlPlaneHost } = await import('./src/control-plane/host-entrypoint.ts');
const { verifyDesktopRuntimeBundle } = await import('./src/desktop-runtime-capability.ts');
let accepted = false;
process.exitCode = await runControlPlaneHost({
  capability: verifyDesktopRuntimeBundle(process.argv[1]),
  environment: process.env,
  native: {
    listen: () => 'listener',
    accept: () => { if (accepted) return null; accepted = true; return 'connection'; },
    finishConnect: () => ({ pid: process.pid, uid: process.getuid() }),
    read: () => { process.stdout.write('ready\\n'); return { messages: [], more: false, eof: false }; },
    close: (handle) => process.stdout.write('closed ' + handle + '\\n'),
    tryReclaimLock: () => false
  }
});
`;

describe("detached control-plane process", () => {
  it.skipIf(process.platform === "win32")(
    "SIGTERM exits nonzero with live transport handles without deleting uncertainty evidence",
    async () => {
      const scratch = resolve(import.meta.dirname, "../../../../scratch");
      mkdirSync(scratch, { recursive: true });
      const home = mkdtempSync(resolve(scratch, "hp-"));
      roots.push(home);
      const paths = resolveKoedServerPaths({ KOED_HOME: home });
      mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
      writeFileSync(paths.runtimeStatePath, "{}", { mode: 0o600 });
      capability(home);
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", childHost, resolve(home, "resources")],
        {
          cwd: resolve(import.meta.dirname, "../.."),
          env: { ...process.env, KOED_HOME: home },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      const exited = once(child, "exit");
      const closed = once(child, "close");
      const deadline = AbortSignal.timeout(3500);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => {
        stdout += String(data);
      });
      child.stderr.on("data", (data) => {
        stderr += String(data);
      });
      try {
        await Promise.race([
          once(child.stdout, "data", { signal: deadline }),
          exited.then(() => {
            throw new Error(
              `Control-plane child exited before readiness: ${stderr}`
            );
          })
        ]);
        expect(stdout).toContain("ready");
        const owner = readControlDiscovery(paths)!;
        expect(owner.pid).toBe(child.pid);
        await expect(
          waitForRetiredControlPlaneOwner(paths, owner, 0)
        ).rejects.toThrow("owner exit could not be confirmed");
        expect(child.kill("SIGTERM")).toBe(true);
        await expect(
          once(child, "exit", { signal: deadline })
        ).resolves.toEqual([1, null]);
        await closed;
        expect(stdout).toContain("closed connection");
        expect(stdout).toContain("closed listener");
        expect(stderr).toContain("cleanup is uncertain");
        expect(readControlDiscovery(paths)).toEqual(owner);
        expect(existsSync(resolve(paths.runDir, "koed-server.lock"))).toBe(
          true
        );
        expect(readFileSync(paths.runtimeStatePath, "utf8")).toBe("{}");
        expect(
          JSON.parse(
            readFileSync(
              resolve(paths.configDir, "control-plane-state.json"),
              "utf8"
            )
          )
        ).toMatchObject({ runtimeClean: false });
        await expect(
          waitForRetiredControlPlaneOwner(paths, owner)
        ).rejects.toThrow("ownership records remain");
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await exited;
      }
    }
  );
  it("acquires a single admission and serves a controlled clean test home", async () => {
    const scratch = resolve(import.meta.dirname, "../../../../scratch");
    mkdirSync(scratch, { recursive: true });
    const home = mkdtempSync(resolve(scratch, "hp-"));
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
    const home = mkdtempSync(resolve(scratch, "hp-"));
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
