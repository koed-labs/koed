import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveKoedServerPaths } from "./paths.js";
import {
  createDesktopComponentManagerBridge,
  createDesktopPrivacyRpcHandler,
  explicitCudaInstallRejection,
  validateDesktopBundle
} from "./desktop-component-manager.js";
import {
  validateDesktopRuntimeCapability,
  resolveDesktopRuntimeOwner,
  verifyDesktopRuntimeBundle
} from "./desktop-runtime-capability.js";

const testCatalog = vi.hoisted(() => ({
  current: {
    schemaVersion: 1,
    productVersion: "0.8.1",
    entries: [
      {
        component: "base",
        target: { platform: "macos", architecture: "arm64" },
        manifestSha256: "0".repeat(64)
      }
    ]
  } as unknown
}));
vi.mock("./component-manifest-catalog-data.js", () => ({
  get productionComponentManifestCatalog() {
    return testCatalog.current;
  }
}));

const roots: string[] = [];
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const fixture = () => {
  const resources = mkdtempSync(resolve(tmpdir(), "koed-desktop-bundle-"));
  roots.push(resources);
  const root = resolve(resources, "koed-runtime");
  mkdirSync(resolve(root, "api"), { recursive: true });
  writeFileSync(resolve(root, "api/index.js"), "verified bundle");
  const manifest = {
    schemaVersion: 1,
    productVersion: "0.8.1",
    component: "base",
    target: { platform: "macos", architecture: "arm64" },
    files: [
      { path: "api/index.js", kind: "file", sha256: hash("verified bundle") }
    ]
  };
  const manifestPath = resolve(root, "desktop-bundle-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, manifestPath };
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  testCatalog.current = {
    schemaVersion: 1,
    productVersion: "0.8.1",
    entries: [
      {
        component: "base",
        target: { platform: "macos", architecture: "arm64" },
        manifestSha256: "0".repeat(64)
      }
    ]
  };
});

describe("Desktop bundled component capability", () => {
  it("validates base file digests and returns a private capability", async () => {
    const { root, manifestPath } = fixture();
    const validated = validateDesktopBundle(
      root,
      manifestPath,
      { platform: "macos", architecture: "arm64" },
      "0.8.1"
    );
    expect(resolve(validated.resourcesPath, "koed-runtime")).toBe(
      realpathSync.native(root)
    );
    expect(validated.bundleDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(validateDesktopRuntimeCapability(validated)).toBe(true);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.manifest)).toBe(true);
    expect(Object.isFrozen(validated.manifest.files)).toBe(true);
  });

  it("derives same stable owner for component manager and runtime capability", () => {
    const resourcesPath = mkdtempSync(resolve(tmpdir(), "koed-desktop-owner-"));
    roots.push(resourcesPath);
    const runtimeRoot = resolve(resourcesPath, "koed-runtime");
    mkdirSync(resolve(runtimeRoot, "api"), { recursive: true });
    writeFileSync(resolve(runtimeRoot, "api/index.js"), "verified bundle");
    const manifestPath = resolve(runtimeRoot, "desktop-bundle-manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        productVersion: "0.8.1",
        component: "base",
        target: { platform: "macos", architecture: "arm64" },
        files: [
          {
            path: "api/index.js",
            kind: "file",
            sha256: hash("verified bundle")
          }
        ]
      })
    );
    const managerCapability = validateDesktopBundle(
      runtimeRoot,
      manifestPath,
      { platform: "macos", architecture: "arm64" },
      "0.8.1"
    );
    const runtimeCapability = verifyDesktopRuntimeBundle(resourcesPath);
    const manager = createDesktopComponentManagerBridge({
      capability: managerCapability,
      paths: { koedHome: resolve(resourcesPath, "home") } as never,
      runtime: {} as never,
      isRunning: false,
      target: { platform: "macos", architecture: "arm64" },
      controlPlaneVersion: "0.8.1",
      environment: {}
    });
    expect(manager.owner).toEqual(
      resolveDesktopRuntimeOwner(
        runtimeCapability,
        resolve(resourcesPath, "home")
      )
    );
    expect(runtimeCapability.resourcesPath).toBe(
      realpathSync.native(resourcesPath)
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(manifestPath, "utf8")),
        productVersion: "0.8.2"
      })
    );
    expect(
      resolveDesktopRuntimeOwner(
        verifyDesktopRuntimeBundle(resourcesPath),
        resolve(resourcesPath, "home")
      )
    ).toEqual(manager.owner);
  });

  it("requires Privacy in status when the supervisor environment enables Team", async () => {
    const { root, manifestPath } = fixture();
    const capability = validateDesktopBundle(
      root,
      manifestPath,
      { platform: "macos", architecture: "arm64" },
      "0.8.1"
    );
    const bridge = (environment: NodeJS.ProcessEnv) =>
      createDesktopComponentManagerBridge({
        capability,
        paths: resolveKoedServerPaths({
          ...environment,
          KOED_HOME: resolve(realpathSync.native(root), "home")
        }),
        runtime: {} as never,
        isRunning: false,
        target: { platform: "macos", architecture: "arm64" },
        controlPlaneVersion: "0.8.1",
        environment
      });
    const teamStatus = await bridge({
      KOED_TEAM_COLLABORATION_ENABLED: "true"
    }).status();
    expect(teamStatus.required).toEqual(
      expect.arrayContaining(["base", "privacy"])
    );
    const personalStatus = await bridge({}).status();
    expect(personalStatus.required).not.toContain("privacy");
  });

  it("routes private cancel RPC by validated request ID and rejects extra fields", () => {
    const { root, manifestPath } = fixture();
    const capability = validateDesktopBundle(
      root,
      manifestPath,
      { platform: "macos", architecture: "arm64" },
      "0.8.1"
    );
    const manager = createDesktopComponentManagerBridge({
      capability,
      paths: { koedHome: resolve(root, "home") } as never,
      runtime: {} as never,
      isRunning: true,
      target: { platform: "macos", architecture: "arm64" },
      controlPlaneVersion: "0.8.1",
      environment: {}
    });
    const messages: Record<string, unknown>[] = [];
    const nonce = "a".repeat(64);
    const handler = createDesktopPrivacyRpcHandler({
      manager,
      nonce,
      send: (message) => messages.push(message)
    });
    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    expect(
      handler({
        type: "koed.desktop.privacy.request",
        requestId,
        action: "cancel"
      })
    ).toBe(false);
    expect(messages).toHaveLength(0);
    expect(
      handler({
        type: "koed.desktop.privacy.request",
        requestId,
        action: "cancel",
        nonce
      })
    ).toBe(true);
    expect(messages[0]).toMatchObject({
      type: "koed.desktop.privacy.response",
      requestId,
      nonce,
      result: { cancelled: false }
    });
    expect(
      handler({
        type: "koed.desktop.privacy.request",
        requestId,
        action: "cancel",
        manifestCatalog: null,
        nonce
      })
    ).toBe(true);
    expect(messages[1]).toMatchObject({
      type: "koed.desktop.privacy.response",
      requestId,
      nonce,
      error: "Desktop privacy IPC request is invalid"
    });
  });

  it("fails closed with actionable error when production pin catalog is absent", async () => {
    testCatalog.current = null;
    const { root, manifestPath } = fixture();
    const capability = validateDesktopBundle(
      root,
      manifestPath,
      { platform: "macos", architecture: "arm64" },
      "0.8.1"
    );
    const manager = createDesktopComponentManagerBridge({
      capability,
      paths: { koedHome: resolve(root, "home") } as never,
      runtime: {} as never,
      isRunning: true,
      target: { platform: "macos", architecture: "arm64" },
      controlPlaneVersion: "0.8.1",
      environment: {}
    });
    await expect(
      manager.install({
        requestId: "123e4567-e89b-42d3-a456-426614174000",
        source: {
          kind: "remote",
          archiveUrl:
            "https://github.com/koed-labs/koed/releases/download/v0.8.1/archive.tar.gz",
          manifestUrl:
            "https://github.com/koed-labs/koed/releases/download/v0.8.1/archive.manifest.json"
        },
        version: "0.8.1"
      })
    ).rejects.toThrow(
      "Production component manifest pin catalog is unavailable in this Desktop release. Update to a catalog-bearing control plane; no component can be installed until then."
    );
  });

  it("rejects caller-forged bundled runtime capabilities", () => {
    const { root, manifestPath } = fixture();
    const valid = validateDesktopBundle(
      root,
      manifestPath,
      { platform: "macos", architecture: "arm64" },
      "0.8.1"
    );
    const forged = { ...valid, capability: Symbol("forged") };
    expect(() =>
      createDesktopComponentManagerBridge({
        capability: forged,
        paths: {} as never,
        runtime: {} as never,
        isRunning: false,
        target: { platform: "macos", architecture: "arm64" },
        controlPlaneVersion: "0.8.1",
        environment: {}
      })
    ).toThrow("Desktop bundled runtime capability is invalid");
  });

  it("rejects changed payload and privacy content in the base manifest", async () => {
    const { root, manifestPath } = fixture();
    writeFileSync(resolve(root, "api/index.js"), "tampered bundle");
    expect(() =>
      validateDesktopBundle(
        root,
        manifestPath,
        { platform: "macos", architecture: "arm64" },
        "0.8.1"
      )
    ).toThrow("Desktop runtime bundle file digest mismatch");
    writeFileSync(resolve(root, "api/index.js"), "verified bundle");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      files: Array<{ path: string; kind: string; sha256: string }>;
    };
    manifest.files.push({
      path: "privacy-service/index.js",
      kind: "file",
      sha256: hash("privacy")
    });
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() =>
      validateDesktopBundle(
        root,
        manifestPath,
        { platform: "macos", architecture: "arm64" },
        "0.8.1"
      )
    ).toThrow("Desktop runtime bundle manifest path is invalid");
  });
});

describe("explicit CUDA Privacy install", () => {
  const linux = {
    target: "linux-x64" as const,
    observedAt: "2026-10-31T00:00:00.000Z"
  };
  const cudaCompatible = {
    ...linux,
    variant: "cuda" as const,
    compatible: true,
    reason: "cuda_compatibility_established"
  };
  const cudaInference = {
    activeProvider: "cuda" as const,
    requestedProvider: "cuda" as const,
    executedProviders: ["CUDAExecutionProvider"],
    proof: "onnx-execution-profile" as const,
    maskingSha256: "a".repeat(64)
  };

  it("rejects a CPU bundle selected because CUDA libraries are missing", () => {
    const compatibility = {
      ...linux,
      variant: "cpu" as const,
      compatible: false,
      reason: "missing_library:libcudnn.so.9"
    };
    expect(
      explicitCudaInstallRejection({ preference: "cuda", compatibility })
    ).toMatch(
      /set to CUDA.*cannot run the CUDA Privacy Filter runtime \(missing_library:libcudnn\.so\.9\).*Auto or CPU/
    );
    expect(
      explicitCudaInstallRejection({ preference: "auto", compatibility })
    ).toBeUndefined();
  });

  it("rejects a CUDA bundle whose verification fell back to CPU inference", () => {
    const verification = {
      ...cudaInference,
      activeProvider: "cpu" as const,
      executedProviders: ["CPUExecutionProvider"],
      fallbackReason: "cuda_initialization_or_inference_failed"
    };
    expect(
      explicitCudaInstallRejection({
        preference: " CUDA ",
        compatibility: cudaCompatible,
        verification
      })
    ).toMatch(
      /set to CUDA.*only succeeded on CPU \(cuda_initialization_or_inference_failed\)/
    );
    expect(
      explicitCudaInstallRejection({
        preference: "auto",
        compatibility: cudaCompatible,
        verification
      })
    ).toBeUndefined();
  });

  it("accepts verified CUDA inference and ignores non-Linux targets", () => {
    expect(
      explicitCudaInstallRejection({
        preference: "cuda",
        compatibility: cudaCompatible,
        verification: cudaInference
      })
    ).toBeUndefined();
    expect(
      explicitCudaInstallRejection({
        preference: "cuda",
        compatibility: {
          target: "macos-arm64",
          compatible: true,
          reason: "macos_provider_selection_unchanged",
          observedAt: linux.observedAt
        }
      })
    ).toBeUndefined();
  });
});
