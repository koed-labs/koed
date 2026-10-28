import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverActualRuntimeIdentity,
  discoverRuntimeIdentityFromProcess
} from "./component-runtime-identity.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("actual component runtime identity", () => {
  it("reads identity from running process and ignores environment spoofing", () => {
    vi.stubEnv("NODE_VERSION", "999.0.0");
    vi.stubEnv("NODE_MODULES_ABI", "999");
    const identity = discoverActualRuntimeIdentity();

    expect(identity.version).toBe(
      process.versions.electron ?? process.versions.node
    );
    expect(identity.nodeVersion).toBe(process.versions.node);
    expect(identity.modulesAbi).toBe(process.versions.modules);
    expect(identity.napiVersion).toBe(Number(process.versions.napi ?? 0));
    expect(identity.platform).toBe(
      process.platform === "darwin" ? "macos" : "linux"
    );
    expect(identity.architecture).toBe(process.arch);
    expect(identity.modulesAbi).not.toBe("999");
  });

  it("derives Electron and glibc identity from process collector", () => {
    const identity = discoverRuntimeIdentityFromProcess({
      versions: {
        node: "22.12.0",
        electron: "33.1.0",
        modules: "130",
        napi: "10"
      },
      platform: "linux",
      arch: "x64",
      report: { getReport: () => ({ header: { glibcVersionRuntime: "2.36" } }) }
    });

    expect(identity).toEqual({
      kind: "electron",
      version: "33.1.0",
      nodeVersion: "22.12.0",
      modulesAbi: "130",
      napiVersion: 10,
      platform: "linux",
      architecture: "x64",
      libcVersion: "2.36"
    });
  });

  it.each([
    {
      platform: "freebsd",
      arch: "x64",
      versions: { node: "22.0.0", modules: "127", napi: "10" }
    },
    {
      platform: "linux",
      arch: "x64",
      versions: { node: "22.0.0", modules: "127", napi: "10" },
      report: { getReport: () => ({ header: {} }) }
    },
    {
      platform: "linux",
      arch: "x64",
      versions: { node: "22.0.0", modules: "127", napi: "10" },
      report: { getReport: () => ({ header: { glibcVersionRuntime: "2.x" } }) }
    }
  ])(
    "fails closed for unsupported or unknown process identity: %o",
    (source) => {
      expect(() => discoverRuntimeIdentityFromProcess(source)).toThrow(
        "actual runtime identity is unsupported or incomplete"
      );
    }
  );
});
