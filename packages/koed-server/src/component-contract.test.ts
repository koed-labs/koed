import { describe, expect, it } from "vitest";
import type {
  ArtifactTarget,
  ComponentManifest,
  RuntimeIdentity,
  RuntimeRequirements
} from "./component-contract.js";

describe("component contracts", () => {
  it("accepts versioned runtime and component manifests", () => {
    const target: ArtifactTarget = { platform: "macos", architecture: "arm64" };
    const runtime: RuntimeIdentity = {
      kind: "node",
      version: "24.0.0",
      nodeVersion: "24.0.0",
      modulesAbi: "137",
      napiVersion: 10,
      platform: "macos",
      architecture: "arm64"
    };
    const manifest: ComponentManifest = {
      schemaVersion: 1,
      productVersion: "1.0.0",
      component: "base",
      target,
      runtimes: [
        { kind: runtime.kind, runtimeRange: ">=24 <25", nodeRange: ">=24 <25" }
      ],
      archive: { name: "base.tar", bytes: 1, sha256: "a".repeat(64) },
      requiredFiles: ["dist/cli.js"],
      files: [{ path: "dist/cli.js", sha256: "b".repeat(64) }]
    };
    const requirements: RuntimeRequirements = {
      components: ["base"],
      processes: ["api", "worker"],
      queue: "local",
      native: [],
      models: []
    };
    expect([manifest.component, requirements.components]).toEqual([
      "base",
      ["base"]
    ]);
  });
});
