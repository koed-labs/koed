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
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveDesktopInstallationResources,
  validateDesktopRuntimeCapability,
  verifyDesktopRuntimeBundle
} from "./desktop-runtime-capability.js";

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-desktop-bundle-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const bundle = (root: string, content = "trusted") => {
  const runtime = resolve(root, "koed-runtime");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(resolve(runtime, "asset.bin"), content);
  writeFileSync(
    resolve(runtime, "desktop-bundle-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      productVersion: "1.2.3",
      component: "base",
      target: { platform: "linux", architecture: "x64" },
      files: [{ path: "asset.bin", kind: "file", sha256: hash(content) }]
    }) + "\n"
  );
};

describe("private Desktop runtime bundle capability", () => {
  it("mints process-local authority only after verifying files from actual resources path", () => {
    const resourcesPath = temp();
    bundle(resourcesPath);
    const capability = verifyDesktopRuntimeBundle(resourcesPath);
    expect(capability.bundleDigest).toBe(
      "56b688782aa7bc4524456e87469e3ec194ad63d203393d7b1bb7d5b1224752ae"
    );
    expect(Object.isFrozen(capability.manifest)).toBe(true);
    expect(Object.isFrozen(capability.manifest.target)).toBe(true);
    expect(Object.isFrozen(capability.manifest.files)).toBe(true);
    expect(Object.isFrozen(capability.manifest.files[0])).toBe(true);
    expect(validateDesktopRuntimeCapability(capability)).toBe(true);
    expect(
      validateDesktopRuntimeCapability({
        resourcesPath,
        productVersion: "1.2.3",
        bundleDigest: hash(
          readFileSync(
            resolve(resourcesPath, "koed-runtime/desktop-bundle-manifest.json"),
            "utf8"
          )
        )
      })
    ).toBe(false);
  });

  it.each(["platform", "architecture", "kind"])(
    "rejects coercible non-string %s manifest values",
    (field) => {
      const resourcesPath = temp();
      bundle(resourcesPath);
      const path = resolve(
        resourcesPath,
        "koed-runtime/desktop-bundle-manifest.json"
      );
      const manifest = JSON.parse(readFileSync(path, "utf8")) as {
        target: Record<string, unknown>;
        files: { kind: unknown }[];
      };
      if (field === "kind") manifest.files[0]!.kind = ["file"];
      else manifest.target[field] = [manifest.target[field]];
      writeFileSync(path, JSON.stringify(manifest));
      expect(() => verifyDesktopRuntimeBundle(resourcesPath)).toThrow(
        "Desktop runtime bundle manifest is invalid"
      );
    }
  );

  it("retains extra manifest fields in verified data and bundle identity", () => {
    const resourcesPath = temp();
    bundle(resourcesPath);
    const path = resolve(
      resourcesPath,
      "koed-runtime/desktop-bundle-manifest.json"
    );
    const manifest = JSON.parse(readFileSync(path, "utf8")) as {
      extra?: string;
    };
    manifest.extra = "retained";
    writeFileSync(path, JSON.stringify(manifest));
    const capability = verifyDesktopRuntimeBundle(resourcesPath);
    expect(capability.manifest).toHaveProperty("extra", "retained");
    expect(capability.bundleDigest).not.toBe(
      "56b688782aa7bc4524456e87469e3ec194ad63d203393d7b1bb7d5b1224752ae"
    );
  });

  it("rejects a bundle whose actual asset bytes differ from its manifest", () => {
    const resourcesPath = temp();
    bundle(resourcesPath, "trusted");
    writeFileSync(resolve(resourcesPath, "koed-runtime/asset.bin"), "tampered");
    expect(() => verifyDesktopRuntimeBundle(resourcesPath)).toThrow(
      "Desktop runtime bundle file digest mismatch"
    );
  });
});

describe("Desktop installation identity", () => {
  const appImage = () => {
    const root = realpathSync(temp());
    const image = resolve(root, "Koed.AppImage");
    writeFileSync(image, "image");
    const appDir = resolve(root, ".mount_KoedXXXX");
    const resources = resolve(appDir, "resources");
    bundle(resources);
    return { root, image, appDir, resources };
  };

  it("uses the resources path outside an AppImage", () => {
    const resourcesPath = realpathSync(temp());
    bundle(resourcesPath);
    expect(verifyDesktopRuntimeBundle(resourcesPath, {}).installationPath).toBe(
      resourcesPath
    );
    expect(resolveDesktopInstallationResources(resourcesPath, {})).toBe(
      resourcesPath
    );
  });

  it("uses the AppImage file only for resources inside its own mount", () => {
    const { root, image, appDir, resources } = appImage();
    const env = { APPIMAGE: image, APPDIR: appDir };
    expect(verifyDesktopRuntimeBundle(resources, env).installationPath).toBe(
      image
    );
    expect(resolveDesktopInstallationResources(image, env)).toBe(resources);
    const outside = resolve(root, "elsewhere");
    bundle(outside);
    expect(verifyDesktopRuntimeBundle(outside, env).installationPath).toBe(
      outside
    );
    for (const partial of [
      { APPIMAGE: image },
      { APPDIR: appDir },
      { APPIMAGE: "relative.AppImage", APPDIR: appDir },
      { APPIMAGE: appDir, APPDIR: appDir },
      { APPIMAGE: resolve(root, "missing.AppImage"), APPDIR: appDir }
    ])
      expect(
        verifyDesktopRuntimeBundle(resources, partial).installationPath
      ).toBe(resources);
  });

  it("resolves an AppImage identity only for the running AppImage", () => {
    const { root, image, appDir } = appImage();
    const other = resolve(root, "Other.AppImage");
    writeFileSync(other, "other");
    expect(() =>
      resolveDesktopInstallationResources(image, {
        APPIMAGE: other,
        APPDIR: appDir
      })
    ).toThrow("not the running AppImage");
    expect(() => resolveDesktopInstallationResources(image, {})).toThrow(
      "not the running AppImage"
    );
    expect(() => resolveDesktopInstallationResources("relative", {})).toThrow(
      "installation path is invalid"
    );
  });
});
