import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDesktopComponentManagerBridge,
  validateDesktopBundle
} from "./desktop-component-manager.js";

const roots: string[] = [];
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const fixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-desktop-bundle-"));
  roots.push(root);
  mkdirSync(resolve(root, "api"));
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
});

describe("Desktop bundled component capability", () => {
  it("validates base file digests and returns a private capability", async () => {
    const { root, manifestPath } = fixture();
    const validated = await validateDesktopBundle(
      root,
      manifestPath,
      { platform: "macos", architecture: "arm64" },
      "0.8.1"
    );
    expect(validated.root).toBe(root);
    expect(validated.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof validated.capability).toBe("symbol");
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.manifest)).toBe(true);
    expect(Object.isFrozen(validated.manifest.files)).toBe(true);
  });

  it("rejects caller-forged bundled runtime capabilities", async () => {
    const { root, manifestPath } = fixture();
    const valid = await validateDesktopBundle(
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
        controlPlaneVersion: "0.8.1"
      })
    ).toThrow("Desktop bundled runtime capability is invalid");
  });

  it("rejects changed payload and privacy content in the base manifest", async () => {
    const { root, manifestPath } = fixture();
    writeFileSync(resolve(root, "api/index.js"), "tampered bundle");
    await expect(
      validateDesktopBundle(
        root,
        manifestPath,
        { platform: "macos", architecture: "arm64" },
        "0.8.1"
      )
    ).rejects.toThrow("Desktop bundle file digest mismatch: api/index.js");
    writeFileSync(resolve(root, "api/index.js"), "verified bundle");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files.push({
      path: "privacy-service/index.js",
      kind: "file",
      sha256: hash("privacy")
    });
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(
      validateDesktopBundle(
        root,
        manifestPath,
        { platform: "macos", architecture: "arm64" },
        "0.8.1"
      )
    ).rejects.toThrow("Desktop bundle manifest file entry is invalid");
  });
});
