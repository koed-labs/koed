import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PINNED_PRIVACY_MODEL_ID,
  PINNED_PRIVACY_MODEL_REVISION,
  PINNED_PRIVACY_CLASSIFIER_HASH
} from "@koed/shared";
const state = vi.hoisted(() => ({ components: vi.fn(), model: vi.fn() }));
vi.mock("./component-commands.js", () => ({
  runComponentStatus: state.components
}));
vi.mock("./privacy-model-runtime.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  collectPrivacyModelStatus: state.model
}));
vi.mock("./service-runtime-selection.js", () => ({
  resolveVerifiedPackagedRuntime: async () => ({
    kind: "packaged",
    privacyVariant: undefined
  })
}));
import { collectDesktopPrivacyInstallStatus } from "./desktop-privacy-status.js";
import { resolveKoedServerPaths } from "./paths.js";
import type { ComponentCommandContext } from "./component-commands.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
const fixture = () => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch/privacy-status-"));
  roots.push(root);
  const paths = resolveKoedServerPaths({ KOED_HOME: root });
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(paths.localPortsPath, JSON.stringify({ privacy: "50092" }));
  state.components.mockResolvedValue({
    required: ["base", "privacy"],
    components: { privacy: "active" },
    activeGeneration: "a".repeat(64)
  });
  state.model.mockResolvedValue({
    ok: true,
    state: "installed",
    message: "verified"
  });
  const health = {
    status: "ok",
    classifier: {
      modelId: PINNED_PRIVACY_MODEL_ID,
      modelRevision: PINNED_PRIVACY_MODEL_REVISION,
      classifierHash: PINNED_PRIVACY_CLASSIFIER_HASH
    }
  };
  const current = { activeProvider: "cpu", verifiedProviders: ["cpu"] };
  const fetcher = vi.fn(
    async (url: string) =>
      new Response(JSON.stringify(url.endsWith("/health") ? health : current))
  );
  vi.stubGlobal("fetch", fetcher);
  const context: ComponentCommandContext = {
    paths,
    controlPlaneVersion: "0.9.2",
    target: { platform: "macos", architecture: "arm64" },
    runtime: {
      kind: "node",
      version: "24.14.0",
      nodeVersion: "24.14.0",
      modulesAbi: "137",
      napiVersion: 10,
      platform: "macos",
      architecture: "arm64"
    },
    owner: { kind: "standalone", installationId: "fixture-standalone" },
    environment: {
      KOED_AUTO_PORTS: "1",
      KOED_TEAM_COLLABORATION_ENABLED: "true",
      PRIVACY_RUNTIME_CONTROL_TOKEN: "fixture-control-token"
    },
    isRunning: true,
    execution: "packaged"
  };
  return { context, health, current, fetcher };
};
describe("Desktop authenticated Privacy readiness", () => {
  it("uses this profile's allocated port and authenticates execution status", async () => {
    const { context, fetcher } = fixture();
    expect(await collectDesktopPrivacyInstallStatus(context)).toMatchObject({
      service: { state: "healthy" }
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:50092/health",
      "http://127.0.0.1:50092/v1/runtime/status"
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/v1/runtime/status"),
      expect.objectContaining({
        headers: { "x-koed-privacy-token": "fixture-control-token" }
      })
    );
  });
  it.each(["model", "stopped"])(
    "does not probe a service before %s readiness",
    async (kind) => {
      const { context, fetcher } = fixture();
      if (kind === "model")
        state.model.mockResolvedValue({ ok: false, state: "missing" });
      else context.isRunning = false;
      expect(await collectDesktopPrivacyInstallStatus(context)).toMatchObject({
        service: { state: "stopped" }
      });
      expect(fetcher).not.toHaveBeenCalled();
    }
  );
  it("rejects classifier identity mismatch or unverified providers", async () => {
    const { context, health, current } = fixture();
    health.classifier.modelRevision = "wrong";
    expect(await collectDesktopPrivacyInstallStatus(context)).toMatchObject({
      service: { state: "starting" }
    });
    health.classifier.modelRevision = PINNED_PRIVACY_MODEL_REVISION;
    current.verifiedProviders = [];
    expect(await collectDesktopPrivacyInstallStatus(context)).toMatchObject({
      service: { state: "starting" }
    });
  });
  it("does not provision local models for external or Personal-only requirements", async () => {
    const { context, fetcher } = fixture();
    state.components.mockResolvedValue({
      required: ["base"],
      components: { privacy: "not-required" }
    });
    expect(await collectDesktopPrivacyInstallStatus(context)).toMatchObject({
      localRequired: false
    });
    expect(state.model).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
