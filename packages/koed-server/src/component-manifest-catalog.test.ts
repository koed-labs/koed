import { describe, expect, it } from "vitest";
import {
  validateManifestCatalog,
  lookupManifestPin
} from "./component-manifest-catalog.js";

const digest = "a".repeat(64);
const target = {
  platform: "linux" as const,
  architecture: "x64" as const,
  libc: { family: "glibc" as const, minimumVersion: "2.35" }
};
const identity = {
  component: "base" as const,
  productVersion: "0.9.0",
  target
};
const catalog = () => ({
  schemaVersion: 1 as const,
  productVersion: "0.9.0",
  entries: [{ component: "base" as const, target, manifestSha256: digest }]
});

describe("component manifest catalog", () => {
  it("looks up exact version, component and complete target identity", () => {
    expect(
      lookupManifestPin(validateManifestCatalog(catalog()), identity)
    ).toBe(digest);
    for (const changed of [
      { ...identity, productVersion: "0.9.1" },
      { ...identity, component: "privacy" as const },
      { ...identity, target: { ...target, architecture: "arm64" as const } },
      {
        ...identity,
        target: { platform: "macos" as const, architecture: "x64" as const }
      },
      {
        ...identity,
        target: { platform: "linux" as const, architecture: "x64" as const }
      },
      {
        ...identity,
        target: { ...target, libc: { ...target.libc, minimumVersion: "2.34" } }
      }
    ])
      expect(() =>
        lookupManifestPin(validateManifestCatalog(catalog()), changed)
      ).toThrow(/pin|catalog|version/i);
  });

  it("rejects missing catalog, malformed hashes, duplicate identities and unknown fields", () => {
    expect(() => lookupManifestPin(null, identity)).toThrow(/catalog|pin/i);
    for (const value of [
      { ...catalog(), unexpected: true },
      { ...catalog(), schemaVersion: 2 },
      { ...catalog(), productVersion: "not-a-version" },
      { ...catalog(), entries: [...catalog().entries, ...catalog().entries] },
      {
        ...catalog(),
        entries: [{ ...catalog().entries[0], manifestSha256: "short" }]
      },
      {
        ...catalog(),
        entries: [
          { ...catalog().entries[0], target: { ...target, extra: true } }
        ]
      },
      {
        ...catalog(),
        entries: [
          {
            ...catalog().entries[0],
            target: {
              platform: "macos",
              architecture: "arm64",
              libc: target.libc
            }
          }
        ]
      }
    ])
      expect(() => validateManifestCatalog(value)).toThrow();
  });

  it("makes catalog immutable without retaining caller-owned mutable objects", () => {
    const input = catalog();
    const verified = validateManifestCatalog(input);
    input.entries[0]!.manifestSha256 = "b".repeat(64);
    expect(lookupManifestPin(verified, identity)).toBe(digest);
    expect(() => {
      verified.entries[0]!.target.libc!.minimumVersion = "2.34";
    }).toThrow();
  });
});
