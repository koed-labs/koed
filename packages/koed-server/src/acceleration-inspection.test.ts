import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectAccelerationPackage } from "./acceleration-inspection.js";
import { nativePathExists } from "./native-selection.js";
import { resolveKoedServerPaths } from "./paths.js";

const core = { recipeId: "core-1", archiveBytes: 10, expandedBytes: 20 };
const cuda = { recipeId: "cuda-1", archiveBytes: 30, expandedBytes: 40 };

vi.mock("./runtime-release.js", () => ({ assertReleaseHost: vi.fn() }));
vi.mock("./native-runtime-catalog.js", () => ({
  getNativeRuntimeCatalog: () => ({ core, cuda })
}));
vi.mock("./native-selection.js", () => ({
  coreStartBlocker: () => null,
  currentNativeId: () => null,
  nativePathExists: vi.fn(() => true),
  nativeStore: () => "/",
  payloadRoot: (_paths: unknown, pin: { recipeId: string }) =>
    `/native/${pin.recipeId}`,
  readNativeSelection: () => ({ id: "selected", pin: core, cuda })
}));

describe("CUDA package inspection", () => {
  const platform = process.platform;
  const arch = process.arch;
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux" });
    Object.defineProperty(process, "arch", { value: "x64" });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    Object.defineProperty(process, "arch", { value: arch });
    vi.mocked(nativePathExists).mockReturnValue(true);
  });
  const paths = () => resolveKoedServerPaths({ KOED_HOME: "/koed-test" });

  it("requires no free space for an installed package, so low disk never hides its state", () => {
    expect(inspectAccelerationPackage(paths())).toMatchObject({
      state: "installed",
      downloadBytes: 0,
      requiredFreeBytes: 0,
      canInstall: true,
      reason:
        "The selected CUDA package is installed. Active execution is verified separately."
    });
  });

  it("adds the working reserve only when payloads must be downloaded", () => {
    vi.mocked(nativePathExists).mockReturnValue(false);
    expect(inspectAccelerationPackage(paths())).toMatchObject({
      downloadBytes: 40,
      requiredFreeBytes: 128 * 1024 * 1024 + 40 + 60
    });
  });
});
