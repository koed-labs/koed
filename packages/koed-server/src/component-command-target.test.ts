import { describe, expect, it } from "vitest";
import type { RuntimeIdentity } from "./component-contract.js";
import type { ManifestPinCatalog } from "./component-manifest-catalog.js";
import { resolveComponentCommandTarget } from "./component-command-target.js";

const runtime: RuntimeIdentity = {
  kind: "node",
  version: "24.13.1",
  nodeVersion: "24.13.1",
  modulesAbi: "137",
  napiVersion: 10,
  platform: "linux",
  architecture: "x64",
  libcVersion: "2.39"
};
const target = {
  platform: "linux",
  architecture: "x64",
  libc: { family: "glibc", minimumVersion: "2.35" }
} as const;
const catalog: ManifestPinCatalog = {
  schemaVersion: 1,
  productVersion: "1.2.3",
  entries: ["base", "privacy"].map((component) => ({
    component: component as "base" | "privacy",
    target,
    manifestSha256: "a".repeat(64)
  }))
};

describe("component command target", () => {
  it("selects trusted catalog baseline, not actual host glibc version", () => {
    expect(resolveComponentCommandTarget(runtime, catalog)).toEqual(target);
    expect(
      resolveComponentCommandTarget(
        { ...runtime, libcVersion: "2.34" },
        catalog
      )
    ).toEqual(target);
    // Runtime compatibility independently rejects a host older than this baseline.
  });
  it("rejects unsupported or ambiguous catalog targets instead of guessing", () => {
    expect(() =>
      resolveComponentCommandTarget(
        { ...runtime, architecture: "arm64" },
        catalog
      )
    ).toThrow(/no target/i);
    expect(() =>
      resolveComponentCommandTarget(runtime, {
        ...catalog,
        entries: [
          ...catalog.entries,
          {
            component: "base",
            manifestSha256: "b".repeat(64),
            target: {
              ...target,
              libc: { family: "glibc", minimumVersion: "2.39" }
            }
          }
        ]
      })
    ).toThrow(/ambiguous/i);
  });
  it("keeps catalog-less diagnostic context available without granting admission", () => {
    expect(resolveComponentCommandTarget(runtime, null)).toEqual({
      platform: "linux",
      architecture: "x64"
    });
  });
});
