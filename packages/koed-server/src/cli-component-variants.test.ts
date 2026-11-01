import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeIdentity } from "./component-contract.js";
import { resolveKoedServerPaths } from "./paths.js";

const state = vi.hoisted(() => ({
  install: vi.fn(),
  runtime: {
    kind: "node",
    version: "24.14.0",
    nodeVersion: "24.14.0",
    modulesAbi: "137",
    napiVersion: 10,
    platform: "linux",
    architecture: "x64"
  } as RuntimeIdentity
}));
vi.mock("./component-commands.js", () => ({
  runComponentInstall: state.install
}));
vi.mock("./component-runtime-identity.js", () => ({
  discoverActualRuntimeIdentity: () => state.runtime
}));
vi.mock("./component-manifest-catalog-data.js", () => ({
  productionComponentManifestCatalog: null
}));
import { runKoedServerCli } from "./cli.js";

afterEach(() => {
  vi.resetAllMocks();
  state.runtime.platform = "linux";
  state.runtime.architecture = "x64";
});

const install = async (component: string, flag: string) => {
  let output = "";
  const code = await runKoedServerCli(
    [
      "components",
      "install",
      "--component",
      component,
      flag,
      "--archive",
      "/synthetic/privacy.tar.gz",
      "--manifest",
      "/synthetic/privacy.manifest.json",
      "--json"
    ],
    {
      resolvePaths: () =>
        resolveKoedServerPaths({ KOED_HOME: "/synthetic/koed-cli-variants" }),
      stdout: {
        write: (chunk: unknown) => {
          output += String(chunk);
          return true;
        }
      }
    }
  );
  return { code, result: JSON.parse(output) as unknown };
};

describe("Commander Privacy component variants", () => {
  it.each(["cpu", "cuda"])(
    "forwards the parsed %s variant to the authenticated installer",
    async (variant) => {
      state.install.mockResolvedValue({ ok: true, state: "staged" });
      expect(await install("privacy", `--variant=${variant}`)).toMatchObject({
        code: 0,
        result: { ok: true, state: "staged" }
      });
      expect(state.install).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { platform: "linux", architecture: "x64" }
        }),
        expect.objectContaining({ component: "privacy", variant })
      );
    }
  );

  it.each([
    ["base", "cpu", "linux", "x64"],
    ["privacy", "other", "linux", "x64"],
    ["privacy", "cpu", "macos", "arm64"],
    ["privacy", "cuda", "linux", "arm64"]
  ] as const)(
    "rejects %s variant %s on %s/%s before installation",
    async (component, variant, platform, architecture) => {
      state.runtime.platform = platform;
      state.runtime.architecture = architecture;
      expect(await install(component, `--variant=${variant}`)).toEqual({
        code: 1,
        result: {
          ok: false,
          error: "--variant must be cpu or cuda for Linux x64 Privacy."
        }
      });
      expect(state.install).not.toHaveBeenCalled();
    }
  );
});
