import { createHash, randomUUID } from "node:crypto";
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
import type { ArtifactTarget, RuntimeIdentity } from "./component-contract.js";
import type { ComponentManifest } from "./component-contract.js";
import type { PrivacyModelInstallOptions } from "./privacy-model-runtime.js";
const operations = vi.hoisted(() => ({
  model: vi.fn(),
  inference: vi.fn(),
  probe: vi.fn(),
  runtime: undefined as RuntimeIdentity | undefined
}));
vi.mock("./component-runtime-identity.js", () => ({
  discoverActualRuntimeIdentity: () => operations.runtime
}));
vi.mock("./component-manifest-catalog-data.js", async () => {
  const fixtures = await import("./component-test-fixtures.js");
  return {
    get productionComponentManifestCatalog() {
      return fixtures.getFixtureManifestPinCatalog();
    }
  };
});
vi.mock("./privacy-model-runtime.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  installPrivacyModel: operations.model
}));
vi.mock("./privacy-inference.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  verifyPrivacyComponentInference: operations.inference
}));
vi.mock("./privacy-download-compatibility.js", async (original) => {
  const actual =
    await original<typeof import("./privacy-download-compatibility.js")>();
  return {
    ...actual,
    probePrivacyDownloadCompatibility: (
      input: Parameters<typeof actual.probePrivacyDownloadCompatibility>[0]
    ) =>
      actual.probePrivacyDownloadCompatibility({
        ...input,
        run: operations.probe
      })
  };
});
import {
  componentFixture,
  resetFixtureManifestPinCatalog
} from "./component-test-fixtures.js";
import { createDesktopComponentManagerBridge } from "./desktop-component-manager.js";
import { verifyDesktopRuntimeBundle } from "./desktop-runtime-capability.js";
import { resolveKoedServerPaths } from "./paths.js";
import { resolveKoedServerConfig, writeKoedServerConfig } from "./config.js";
const roots: string[] = [];
const fixtures: Awaited<ReturnType<typeof componentFixture>>[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  for (const fixture of fixtures.splice(0)) fixture.dispose();
  resetFixtureManifestPinCatalog();
  vi.resetAllMocks();
});
const fixture = async (
  target: ArtifactTarget = { platform: "macos", architecture: "arm64" }
) => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch/privacy-provisioning-"));
  roots.push(root);
  const resources = resolve(root, "resources");
  mkdirSync(resolve(resources, "koed-runtime/api"), { recursive: true });
  const body = "export {};";
  writeFileSync(resolve(resources, "koed-runtime/api/index.js"), body);
  writeFileSync(
    resolve(resources, "koed-runtime/desktop-bundle-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      component: "base",
      productVersion: "0.8.1",
      target,
      files: [
        {
          path: "api/index.js",
          kind: "file",
          sha256: createHash("sha256").update(body).digest("hex")
        }
      ]
    })
  );
  const component = await componentFixture({ component: "privacy", target });
  fixtures.push(component);
  operations.runtime = component.input.runtime;
  const manifestPath = resolve(root, "privacy.manifest.json");
  writeFileSync(manifestPath, component.input.manifestBytes);
  const paths = resolveKoedServerPaths({ KOED_HOME: resolve(root, "home") });
  const environment: NodeJS.ProcessEnv = {
    KOED_TEAM_COLLABORATION_ENABLED: "true"
  };
  const manager = createDesktopComponentManagerBridge({
    capability: verifyDesktopRuntimeBundle(resources),
    paths,
    runtime: component.input.runtime,
    isRunning: false,
    target,
    controlPlaneVersion: "0.8.1",
    environment
  });
  const request = {
    requestId: randomUUID(),
    version: "0.8.1",
    source: {
      kind: "offline" as const,
      archivePath: component.input.archivePath,
      manifestPath
    }
  };
  operations.model.mockResolvedValue({
    ok: true,
    modelPath: resolve(root, "model")
  });
  operations.inference.mockResolvedValue({
    requestedProvider: "cpu",
    activeProvider: "cpu",
    executedProviders: ["CPUExecutionProvider"],
    proof: "onnx-execution-profile",
    maskingSha256: "a".repeat(64)
  });
  operations.probe.mockImplementation(async (command: string) =>
    command === "nvidia-smi"
      ? "0, 570.26, 8.6\n"
      : JSON.stringify({ cudaRuntimeVersion: 12080, cudnnMajor: 9 })
  );
  return { manager, request, paths, manifestPath, environment };
};
describe("Desktop Privacy provisioning boundary", () => {
  it("honors and rereads the saved CPU preference on a CUDA-compatible host", async () => {
    const { manager, paths } = await fixture({
      platform: "linux",
      architecture: "x64"
    });
    const config = resolveKoedServerConfig(paths, {});
    writeKoedServerConfig(paths, { ...config, hardwareAcceleration: "cpu" });
    expect(await manager.prepare()).toMatchObject({
      variant: "cpu",
      reason: "explicit_cpu_preference"
    });
    expect(operations.probe).not.toHaveBeenCalled();

    writeKoedServerConfig(paths, { ...config, hardwareAcceleration: "auto" });
    expect(await manager.prepare()).toMatchObject({
      variant: "cuda",
      compatible: true
    });
    expect(operations.probe).toHaveBeenCalledTimes(2);
  });

  it.each(["provider", "global", "file", "worker"])(
    "preserves the %s environment override over the saved preference",
    async (kind) => {
      const { manager, paths, environment } = await fixture({
        platform: "linux",
        architecture: "x64"
      });
      writeKoedServerConfig(paths, {
        ...resolveKoedServerConfig(paths, {}),
        hardwareAcceleration: "cpu"
      });
      if (kind === "global") environment.KOED_HARDWARE_ACCELERATION = "auto";
      else if (kind === "file") {
        const envPath = resolve(paths.configDir, "runtime.env");
        writeFileSync(envPath, "PRIVACY_RUNTIME_PROVIDER=auto\n");
        environment.KOED_ENV_PATH = envPath;
      } else {
        environment.PRIVACY_RUNTIME_PROVIDER = "auto";
        if (kind === "worker")
          environment.PRIVACY_RUNTIME_ENGINE = "onnx-worker";
      }
      expect(await manager.prepare()).toMatchObject({
        variant: kind === "worker" ? "cpu" : "cuda"
      });
      expect(operations.probe).toHaveBeenCalledTimes(kind === "worker" ? 0 : 2);
    }
  );

  it("admits runtime and model before inference, then stages without activating", async () => {
    const { manager, request, paths } = await fixture();
    const prepared = await manager.prepare();
    expect(prepared.recoveryGenerationId).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(resolve(paths.componentsDir, "current.json"))).toBe(
      false
    );
    const result = await manager.install(request);
    expect(result.state).toBe("staged");
    expect(operations.model).toHaveBeenCalledOnce();
    expect(operations.inference).toHaveBeenCalledOnce();
    expect(operations.model.mock.invocationCallOrder[0]).toBeLessThan(
      operations.inference.mock.invocationCallOrder[0]!
    );
    expect(existsSync(resolve(paths.componentsDir, "current.json"))).toBe(
      false
    );
    expect(
      JSON.parse(
        readFileSync(
          resolve(
            paths.configDir,
            "privacy-installations",
            `${result.generationId}.json`
          ),
          "utf8"
        )
      )
    ).toMatchObject({
      generationId: result.generationId,
      verification: { activeProvider: "cpu" }
    });
  });
  it.each(["network", "ENOSPC"])(
    "preserves selection when model provisioning fails: %s",
    async (kind) => {
      const { manager, request, paths } = await fixture();
      operations.model.mockRejectedValue(
        Object.assign(new Error("synthetic transfer failure"), { code: kind })
      );
      await expect(manager.install(request)).rejects.toThrow(
        kind === "ENOSPC" ? "not enough disk space" : "transfer failure"
      );
      expect(operations.inference).not.toHaveBeenCalled();
      expect(existsSync(resolve(paths.componentsDir, "current.json"))).toBe(
        false
      );
    }
  );
  it("keeps cancellation reachable and refuses overlapping provisioning", async () => {
    const { manager, request, paths } = await fixture();
    operations.model.mockImplementation(
      async (
        _paths: unknown,
        _env: unknown,
        _fetch: unknown,
        options: PrivacyModelInstallOptions
      ) =>
        new Promise<never>((_resolve, reject) =>
          options.signal!.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true }
          )
        )
    );
    const pending = manager.install(request);
    await vi.waitFor(() => expect(operations.model).toHaveBeenCalledOnce());
    await expect(
      manager.install({ ...request, requestId: randomUUID() })
    ).rejects.toThrow("already active");
    expect(manager.cancel(request.requestId)).toBe(true);
    await expect(pending).rejects.toThrow("cancelled");
    expect(existsSync(resolve(paths.componentsDir, "current.json"))).toBe(
      false
    );
    expect(operations.inference).not.toHaveBeenCalled();
  });
  it("rejects substituted manifest authority before model download or inference", async () => {
    const { manager, request, manifestPath } = await fixture();
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8")
    ) as ComponentManifest;
    manifest.archive.sha256 = "f".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(manager.install(request)).rejects.toThrow(/pin|canonical/);
    expect(operations.model).not.toHaveBeenCalled();
    expect(operations.inference).not.toHaveBeenCalled();
  });
  it("does not stage a generation when actual inference fails", async () => {
    const { manager, request, paths } = await fixture();
    operations.inference.mockRejectedValue(
      new Error("synthetic inference failure")
    );
    await expect(manager.install(request)).rejects.toThrow("inference failure");
    expect(existsSync(paths.generationsDir)).toBe(false);
  });
});
