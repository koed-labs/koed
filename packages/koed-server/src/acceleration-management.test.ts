import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAccelerationManagement,
  createDesktopAccelerationRpcHandler
} from "./acceleration-management.js";
import { resolveKoedServerPaths } from "./paths.js";
import { resolveKoedServerConfig, writeKoedServerConfig } from "./config.js";
import * as hardware from "./acceleration-hardware.js";
import * as health from "./acceleration-health.js";
import * as lifecycle from "./runtime-lifecycle.js";
import { resolveKoedRuntimeOwner } from "./app-runtime.js";
import * as appRuntime from "./app-runtime.js";
import { verifyDesktopRuntimeBundle } from "./desktop-runtime-capability.js";
import { acquireKoedServerSupervisorLock } from "./supervisor-lock.js";

vi.mock("./acceleration-hardware.js", () => ({
  inspectAccelerationHardware: async () => ({
    state: "available",
    backend: "metal",
    name: "Apple Silicon",
    memoryBytes: null,
    reason: "Available",
    verification: "host"
  })
}));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch", "acceleration-management-"));
  roots.push(root);
  const paths = resolveKoedServerPaths({
    KOED_HOME: root,
    KOED_REPO_ROOT: root
  });
  const environment: NodeJS.ProcessEnv = {
    KOED_HOME: root,
    KOED_REPO_ROOT: root,
    DATABASE_URL: "postgres://secret/database"
  };
  const manager = createAccelerationManagement({
    paths,
    environment: () => environment
  });
  return { paths, environment, manager };
};
describe("trusted acceleration mutations", () => {
  it("shares concurrent detection and reuses it until an explicit refresh", async () => {
    const detect = vi.spyOn(hardware, "inspectAccelerationHardware");
    const f = fixture();
    await Promise.all([f.manager.inspect(), f.manager.inspect()]);
    expect(detect).toHaveBeenCalledOnce();
    await f.manager.inspect();
    expect(detect).toHaveBeenCalledOnce();
    await f.manager.inspect(true);
    expect(detect).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])(
    "reads existing bundled service tokens privately with a not-yet-started supervisor callback: %s",
    async (supervisor) => {
      const f = fixture();
      f.environment.KOED_RUNTIME_MODE = "local-personal";
      f.environment.KOED_DEPENDENCY_MODE = "bundled-local";
      mkdirSync(f.paths.configDir, { recursive: true });
      const path = resolve(f.paths.configDir, "local-service-secrets.json");
      const tokens = JSON.stringify({
        EMBEDDING_SERVICE_TOKEN: "existing-private-token",
        PRIVACY_RUNTIME_CONTROL_TOKEN: "existing-private-control"
      });
      writeFileSync(path, tokens);
      writeFileSync(
        resolve(f.paths.configDir, "local-ports.json"),
        JSON.stringify({ embedding: "43821", privacy: "48093" })
      );
      const manager = supervisor
        ? createAccelerationManagement({
            paths: f.paths,
            environment: () => f.environment,
            serviceEnvironment: () => undefined
          })
        : f.manager;
      const inspect = vi.spyOn(health, "inspectAccelerationServices");
      const snapshot = await manager.inspect();
      expect(
        inspect.mock.calls[0]?.[0].environment.EMBEDDING_SERVICE_TOKEN
      ).toBe("existing-private-token");
      expect(
        inspect.mock.calls[0]?.[0].environment.EMBEDDING_SERVICE_HOST_PORT
      ).toBe("43821");
      expect(JSON.stringify(snapshot)).not.toContain("existing-private");
      expect(readFileSync(path, "utf8")).toBe(tokens);
    }
  );
  it.each([
    { name: "source .env", execution: "source", expected: "checkout" },
    {
      name: "source process override",
      execution: "source",
      process: true,
      expected: "process"
    },
    { name: "installed runtime", execution: "packaged", expected: "saved" },
    {
      name: "packaged Desktop",
      execution: "source",
      packaged: true,
      expected: "saved"
    },
    {
      name: "verified Desktop bundle",
      execution: "source",
      capability: true,
      expected: "saved"
    },
    {
      name: "explicit packaged env file",
      execution: "packaged",
      explicit: true,
      expected: "explicit"
    },
    {
      name: "running supervisor",
      execution: "packaged",
      supervisor: true,
      process: true,
      expected: "running"
    }
  ] as const)("uses startup token precedence for $name", async (test) => {
    const f = fixture();
    vi.spyOn(appRuntime, "resolveKoedAppRuntimeExecution").mockReturnValue(
      test.execution
    );
    const settings = {
      process: false,
      packaged: false,
      explicit: false,
      supervisor: false,
      capability: false,
      ...test
    };
    if (settings.packaged) f.environment.KOED_PACKAGED_DESKTOP = "1";
    if (settings.process) {
      f.environment.EMBEDDING_SERVICE_TOKEN = "process-embedding";
      f.environment.PRIVACY_RUNTIME_CONTROL_TOKEN = "process-privacy";
    }
    const envFile = (prefix: string) =>
      `EMBEDDING_SERVICE_TOKEN=${prefix}-embedding\nPRIVACY_RUNTIME_CONTROL_TOKEN=${prefix}-privacy\nKOED_HARDWARE_ACCELERATION=cpu\n`;
    writeFileSync(resolve(f.paths.repoRoot, ".env"), envFile("checkout"));
    if (settings.explicit) {
      f.environment.KOED_ENV_PATH = resolve(f.paths.repoRoot, "operator.env");
      writeFileSync(f.environment.KOED_ENV_PATH, envFile("explicit"));
    }
    mkdirSync(f.paths.configDir, { recursive: true });
    mkdirSync(resolve(f.paths.modelsDir, "privacy"), { recursive: true });
    const secretPath = resolve(f.paths.configDir, "local-service-secrets.json");
    const saved = JSON.stringify({
      EMBEDDING_SERVICE_TOKEN: "saved-embedding",
      PRIVACY_RUNTIME_CONTROL_TOKEN: "saved-privacy"
    });
    writeFileSync(secretPath, saved);
    writeFileSync(
      f.paths.localPortsPath,
      JSON.stringify({ embedding: "43821", privacy: "48093" })
    );
    vi.spyOn(lifecycle, "observeRuntimeLifecycle").mockReturnValue({
      state: "running",
      epoch: "test-runtime",
      message: "Running"
    });
    const fetcher = vi.fn(
      async (url: URL | RequestInfo, init?: RequestInit) => {
        const embedding = String(url).endsWith("/health");
        const token = new Headers(init?.headers).get(
          embedding ? "x-koed-embedding-token" : "x-koed-privacy-token"
        );
        const valid =
          token === `${test.expected}-${embedding ? "embedding" : "privacy"}`;
        return Response.json(
          embedding
            ? {
                status: "ok",
                authRequired: true,
                authValid: valid,
                acceleration: "metal;runtime=llama.cpp;n-gpu-layers=all"
              }
            : {
                component: "privacy_filter",
                switchState: valid ? "ready" : "failed",
                activeProvider: "cpu",
                verifiedProviders: ["cpu"]
              }
        );
      }
    );
    let capability;
    if (settings.capability) {
      const runtime = resolve(f.paths.repoRoot, "koed-runtime");
      mkdirSync(runtime, { recursive: true });
      writeFileSync(
        resolve(runtime, "desktop-bundle-manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          productVersion: "1.0.0",
          component: "base",
          target: { platform: "macos", architecture: "arm64" },
          files: []
        })
      );
      capability = verifyDesktopRuntimeBundle(f.paths.repoRoot);
    }
    const manager = createAccelerationManagement({
      capability,
      paths: f.paths,
      environment: () => f.environment,
      serviceEnvironment: () =>
        settings.supervisor
          ? {
              ...f.environment,
              EMBEDDING_SERVICE_HOST_PORT: "43821",
              PRIVACY_SERVICE_PORT: "48093",
              EMBEDDING_SERVICE_TOKEN: "running-embedding",
              PRIVACY_RUNTIME_CONTROL_TOKEN: "running-privacy"
            }
          : undefined,
      fetch: fetcher
    });
    const snapshot = await manager.inspect();
    expect(snapshot.embedding).toMatchObject({
      state: "ready",
      backend: "metal"
    });
    expect(snapshot.privacy).toMatchObject({ state: "ready", provider: "cpu" });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:43821/health",
      "http://127.0.0.1:48093/v1/runtime/status"
    ]);
    if (test.expected === "saved" || test.expected === "running")
      expect(snapshot.source).toBe("default");
    expect(JSON.stringify(snapshot)).not.toMatch(
      /(?:checkout|saved|running|explicit|process)-(?:embedding|privacy)/
    );
    expect(readFileSync(secretPath, "utf8")).toBe(saved);
  });
  it.each([
    { automatic: undefined, port: "43821" },
    { automatic: "1", port: "43821" },
    { automatic: "0", port: "3800" }
  ])(
    "checks the allocated endpoint while a source supervisor is starting: %j",
    async ({ automatic, port }) => {
      const f = fixture();
      f.environment.KOED_AUTO_PORTS = automatic;
      writeFileSync(
        resolve(f.paths.repoRoot, ".env"),
        "EMBEDDING_SERVICE_HOST_PORT=3800\n"
      );
      mkdirSync(f.paths.configDir, { recursive: true });
      writeFileSync(
        f.paths.localPortsPath,
        JSON.stringify({ embedding: "43821" })
      );
      writeFileSync(
        resolve(f.paths.configDir, "local-service-secrets.json"),
        JSON.stringify({ EMBEDDING_SERVICE_TOKEN: "private-token" })
      );
      vi.spyOn(lifecycle, "observeRuntimeLifecycle").mockReturnValue({
        state: "starting",
        epoch: "source-runtime",
        message: "Starting",
        owner: null
      });
      const fetcher = vi.fn(async () =>
        Response.json({
          status: "ok",
          authRequired: true,
          authValid: true,
          acceleration: "metal;runtime=llama.cpp;n-gpu-layers=all"
        })
      );
      const manager = createAccelerationManagement({
        paths: f.paths,
        environment: () => f.environment,
        fetch: fetcher
      });
      const snapshot = await manager.inspect();
      expect(fetcher).toHaveBeenCalledWith(
        new URL(`http://127.0.0.1:${port}/health`),
        expect.objectContaining({
          headers: { "x-koed-embedding-token": "private-token" }
        })
      );
      expect(snapshot.embedding).toEqual({
        state: "ready",
        backend: "metal",
        fallbackReason: null
      });
      expect(snapshot.readOnlyReason).toContain(
        "Runtime ownership could not be verified"
      );
      expect(JSON.stringify(snapshot)).not.toContain("private-token");
    }
  );
  it.each([true, false])(
    "only permits Settings for the same live source installation: %s",
    async (sameInstallation) => {
      const f = fixture();
      const owner = resolveKoedRuntimeOwner();
      acquireKoedServerSupervisorLock(f.paths, {
        sourceOwner: sameInstallation
          ? owner
          : { ...owner, installationId: "f".repeat(32) }
      });
      writeFileSync(
        f.paths.runtimeStatePath,
        JSON.stringify({ pid: process.pid })
      );
      const snapshot = await f.manager.inspect();
      expect(lifecycle.observeRuntimeLifecycle(f.paths).state).toBe("running");
      if (sameInstallation) expect(snapshot.readOnlyReason).toBeNull();
      else
        expect(snapshot.readOnlyReason).toContain(
          "Another Koed installation owns this runtime"
        );
    }
  );
  it("deduplicates pending install IDs and waits for cancellation cleanup on disconnect", async () => {
    const f = fixture();
    let finish!: () => void;
    let signal: AbortSignal | undefined;
    const install = vi
      .spyOn(f.manager, "install")
      .mockImplementation(async (_input, currentSignal) => {
        signal = currentSignal;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        throw new Error("Cancelled after cleanup");
      });
    const send = vi.fn();
    const handle = createDesktopAccelerationRpcHandler({
      manager: f.manager,
      nonce: "n",
      send
    });
    const request = {
      type: "koed.desktop.acceleration.request",
      nonce: "n",
      requestId: "d6abf730-0f02-4adc-a7e6-4ddf98f30905",
      action: "install",
      mode: "cuda",
      expectedRevision: "a".repeat(64)
    };
    expect(handle(request)).toBe(true);
    expect(handle(request)).toBe(true);
    expect(install).toHaveBeenCalledOnce();
    let closed = false;
    const closing = handle.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(closed).toBe(false);
    expect(handle(request)).toBe(false);
    finish();
    await closing;
    expect(send).not.toHaveBeenCalled();
  });
  it("persists CPU under stopped-runtime authority without persisting environment secrets", async () => {
    const f = fixture();
    const before = await f.manager.inspect();
    const after = await f.manager.save({
      preference: "cpu",
      expectedRevision: before.revision
    });
    expect(after.preference).toBe("cpu");
    expect(after.embedding.state).toBe("stopped");
    expect(readFileSync(f.paths.serverConfigPath, "utf8")).not.toContain(
      "secret"
    );
  });
  it("rejects a stale renderer choice after configuration changes", async () => {
    const f = fixture();
    const before = await f.manager.inspect();
    writeKoedServerConfig(f.paths, {
      ...resolveKoedServerConfig(f.paths, {}),
      hardwareAcceleration: "cpu"
    });
    await expect(
      f.manager.save({ preference: "auto", expectedRevision: before.revision })
    ).rejects.toThrow("configuration changed");
    expect(resolveKoedServerConfig(f.paths, {}).hardwareAcceleration).toBe(
      "cpu"
    );
  });
  it("honors newly applied Operator policy and external-service ownership", async () => {
    const f = fixture();
    const before = await f.manager.inspect();
    f.environment.KOED_EMBEDDING_ACCELERATION = "cuda";
    await expect(
      f.manager.save({ preference: "cpu", expectedRevision: before.revision })
    ).rejects.toThrow("Operator environment");
    delete f.environment.KOED_EMBEDDING_ACCELERATION;
    f.environment.KOED_DEPENDENCY_MODE = "external";
    await expect(
      f.manager.save({ preference: "cpu", expectedRevision: before.revision })
    ).rejects.toThrow("external Embedding Service");
  });
  it("keeps the onboarding Metal default editable with the generated Docker placeholder", async () => {
    const f = fixture();
    writeFileSync(
      resolve(f.paths.repoRoot, ".env"),
      "EMBEDDING_LLAMA_SERVER_BINARY=/opt/llama.cpp/llama-server\n"
    );
    const manager = createAccelerationManagement({
      paths: f.paths,
      environment: () => f.environment,
      serviceEnvironment: () => ({
        ...f.environment,
        KOED_HARDWARE_ACCELERATION: "auto",
        KOED_EMBEDDING_ACCELERATION: "auto",
        PRIVACY_RUNTIME_PROVIDER: "auto",
        LLAMA_SERVER_BINARY: "/managed/native/llama-server"
      })
    });
    const initial = await manager.inspect();
    expect(initial.source).toBe("default");
    expect(initial.readOnlyReason).toBeNull();
    const onboarded = await manager.save({
      preference: "auto",
      expectedRevision: initial.revision
    });
    expect(onboarded.source).toBe("saved");
    expect(onboarded.readOnlyReason).toBeNull();
    const cpu = await manager.save({
      preference: "cpu",
      expectedRevision: onboarded.revision
    });
    expect(cpu.preference).toBe("cpu");
    expect(cpu.effectivePolicy).toBe("cpu");
    const metal = await manager.save({
      preference: "auto",
      expectedRevision: cpu.revision
    });
    expect(metal.preference).toBe("auto");
    expect(metal.effectivePolicy).toBe("auto");
    expect(metal.readOnlyReason).toBeNull();
  });
  it.each([
    "KOED_HARDWARE_ACCELERATION",
    "KOED_EMBEDDING_ACCELERATION",
    "PRIVACY_RUNTIME_PROVIDER"
  ])("keeps an explicitly configured %s=auto authoritative", async (key) => {
    const f = fixture();
    writeFileSync(resolve(f.paths.repoRoot, ".env"), `${key}=auto\n`);
    const current = await f.manager.inspect();
    expect(current.source).toBe("environment");
    expect(current.readOnlyReason).toContain("Operator environment");
    // The Operator's choice must not block the core runtime that setup needs.
    expect(current.runtimeReadOnlyReason).toBeNull();
    await expect(
      f.manager.save({ preference: "cpu", expectedRevision: current.revision })
    ).rejects.toThrow("Operator environment");
  });
  it("still treats a custom native binary as an Operator override", async () => {
    const f = fixture();
    f.environment.EMBEDDING_LLAMA_SERVER_BINARY = "/custom/llama-server";
    const current = await f.manager.inspect();
    expect(current.source).toBe("environment");
    expect(current.readOnlyReason).toContain("Operator environment");
  });
  it("never accepts forced backend policies or extra mutation fields", async () => {
    const f = fixture();
    const before = await f.manager.inspect();
    for (const input of [
      { preference: "cuda", expectedRevision: before.revision },
      {
        preference: "cpu",
        expectedRevision: before.revision,
        resourcesPath: "/forged"
      }
    ])
      await expect(f.manager.save(input)).rejects.toThrow();
    expect(resolveKoedServerConfig(f.paths, {}).hardwareAcceleration).toBe(
      "auto"
    );
  });
  it("correlates private IPC and rejects foreign nonces and forged authority", async () => {
    const f = fixture();
    const send = vi.fn();
    const inspect = vi.spyOn(f.manager, "inspect");
    const handle = createDesktopAccelerationRpcHandler({
      manager: f.manager,
      nonce: "a".repeat(64),
      send
    });
    const request = {
      type: "koed.desktop.acceleration.request",
      nonce: "a".repeat(64),
      requestId: "d6abf730-0f02-4adc-a7e6-4ddf98f30905",
      action: "inspect",
      refresh: false
    };
    expect(handle({ ...request, nonce: "foreign" })).toBe(false);
    expect(handle({ ...request, capability: {} })).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
    expect(handle(request)).toBe(true);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "koed.desktop.acceleration.response",
          requestId: request.requestId,
          nonce: request.nonce,
          action: "inspect",
          result: expect.objectContaining({ preference: "auto" }) as unknown
        })
      )
    );
  });
});
