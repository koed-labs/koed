import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeRuntimeAssetManifest } from "./manifest-lib.mjs";

const executable = (path) => {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, "fixture\n", { mode: 0o755 });
};

test("runtime manifest records CPU and CUDA backend variants", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-runtime-manifest-"));
  try {
    executable(resolve(root, "llama.cpp", "llama-server"));
    executable(resolve(root, "llama.cpp", "cpu", "llama-server"));
    executable(resolve(root, "llama.cpp", "cuda", "llama-server"));

    writeRuntimeAssetManifest({
      runtimeRoot: root,
      platform: "linux",
      architecture: "x64",
      versions: { llamaCpp: "b10514" }
    });

    const manifest = JSON.parse(
      readFileSync(resolve(root, "runtime-asset-manifest.json"), "utf8")
    );
    const llama = manifest.assets.find((asset) => asset.id === "llama.cpp");
    assert.deepEqual(llama.variants, [
      {
        backend: "cpu",
        executablePath: "cpu/llama-server",
        requirements: { platform: "linux", architecture: "x64" }
      },
      {
        backend: "cuda",
        executablePath: "cuda/llama-server",
        requirements: {
          platform: "linux",
          architecture: "x64",
          minimumCudaToolkit: "12.4",
          minimumDriverLinux: "550.54.14",
          discovery: "llama-server --list-devices"
        }
      }
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
