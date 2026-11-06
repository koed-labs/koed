// Deferred CUDA packaging qualification. No native binary runs in this suite.
import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import {
  assertCudaCoreCompatibility,
  cudaInventory,
  cudaRecipeId,
  freezeCuda,
  packageFrozenCuda,
  verifyFrozenCuda
} from "./cuda-artifact.mjs";
import { evaluateArtifactPolicy } from "../release-artifact-inspector-lib.mjs";

const roots = [];
test.afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }))
);
const fixture = () => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch", "cuda-artifact-"));
  roots.push(root);
  const runtimeRoot = resolve(root, "koed-runtime");
  for (const name of [
    "llama-server",
    "libggml-cuda.so",
    "libcudart.so.12.4",
    "libcublas.so.12.4",
    "libcublasLt.so.12.4",
    "LICENSE",
    "CUDA-EULA.txt"
  ]) {
    const path = resolve(runtimeRoot, "llama.cpp/cuda", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `fixture ${name}\n`, {
      mode: name === "llama-server" ? 0o755 : 0o644
    });
  }
  symlinkSync(
    "libcudart.so.12.4",
    resolve(runtimeRoot, "llama.cpp/cuda/libcudart.so.12")
  );
  const configuration = JSON.parse(
    readFileSync(new URL("./cuda.linux-x64.json", import.meta.url), "utf8")
  );
  const recipe = {
    schemaVersion: 1,
    kind: "cuda",
    configuration,
    toolchain: { nvcc: "fixture", toolkit: [{ sha256: "a".repeat(64) }] },
    build: { flags: ["fixture"] },
    logic: { builder: "b".repeat(64) },
    packaging: { epoch: 0 }
  };
  const manifest = freezeCuda({ runtimeRoot, configuration, recipe });
  return { root, runtimeRoot, recipe, manifest };
};

test("frozen CUDA packaging is independent of output path and product version", () => {
  const { root, runtimeRoot } = fixture();
  const moved = resolve(root, "moved");
  cpSync(runtimeRoot, moved, { recursive: true, verbatimSymlinks: true });
  const out1 = resolve(root, "one"),
    out2 = resolve(root, "two");
  mkdirSync(out1);
  mkdirSync(out2);
  const before = process.env.KOED_NATIVE_RUNTIME_VERSION;
  try {
    process.env.KOED_NATIVE_RUNTIME_VERSION = "0.10.3";
    const first = packageFrozenCuda({ runtimeRoot, outDir: out1 });
    process.env.KOED_NATIVE_RUNTIME_VERSION = "99.0.0";
    const second = packageFrozenCuda({ runtimeRoot: moved, outDir: out2 });
    assert.deepEqual(first, second);
    assert.deepEqual(
      readFileSync(resolve(out1, first.archive)),
      readFileSync(resolve(out2, second.archive))
    );
    assert.throws(
      () => packageFrozenCuda({ runtimeRoot, outDir: out1 }),
      /overwrite/
    );
  } finally {
    if (before === undefined) delete process.env.KOED_NATIVE_RUNTIME_VERSION;
    else process.env.KOED_NATIVE_RUNTIME_VERSION = before;
  }
});

test("composition ignores Postgres versions and rejects incompatible llama, target or contracts", () => {
  const { manifest } = fixture();
  const core = {
    kind: "core",
    target: manifest.target,
    contracts: { ...manifest.contracts, postgres: 1 },
    components: { postgres: { version: "17.6" }, llamaCpp: manifest.llamaCpp }
  };
  assert.doesNotThrow(() => assertCudaCoreCompatibility(core, manifest));
  const before = cudaRecipeId(manifest.recipe);
  core.components.postgres.version = "17.7";
  assert.doesNotThrow(() => assertCudaCoreCompatibility(core, manifest));
  assert.equal(cudaRecipeId(manifest.recipe), before);
  for (const mutate of [
    (value) => {
      value.components.llamaCpp.revision = "f".repeat(40);
    },
    (value) => {
      value.contracts.layout = 2;
    },
    (value) => {
      value.contracts.embedding = 2;
    },
    (value) => {
      value.target.libc.minimumVersion = "2.39";
    }
  ]) {
    const changed = structuredClone(core);
    mutate(changed);
    assert.throws(
      () => assertCudaCoreCompatibility(changed, manifest),
      /exact core/
    );
  }
});

test("CUDA identity binds source, toolkit, architectures, flags and build logic", () => {
  const { recipe } = fixture();
  for (const mutate of [
    (value) => {
      value.configuration.llamaCpp.sha256 = "f".repeat(64);
    },
    (value) => {
      value.toolchain.toolkit[0].sha256 = "f".repeat(64);
    },
    (value) => {
      value.configuration.cuda.architectures = [80];
    },
    (value) => {
      value.build.flags.push("changed");
    },
    (value) => {
      value.logic.builder = "f".repeat(64);
    },
    (value) => {
      value.packaging.epoch = 1;
    }
  ]) {
    const changed = structuredClone(recipe);
    mutate(changed);
    assert.notEqual(cudaRecipeId(changed), cudaRecipeId(recipe));
  }
});

for (const change of [
  "bytes",
  "mode",
  "link",
  "host-driver",
  "cpu",
  "postgres"
]) {
  test(`CUDA inventory refuses changed ${change}`, () => {
    const { runtimeRoot } = fixture();
    const target = resolve(runtimeRoot, "llama.cpp/cuda/llama-server");
    if (change === "bytes") writeFileSync(target, "changed");
    if (change === "mode") chmodSync(target, 0o644);
    if (change === "link") {
      rmSync(resolve(runtimeRoot, "llama.cpp/cuda/libcudart.so.12"));
      symlinkSync(
        "llama-server",
        resolve(runtimeRoot, "llama.cpp/cuda/libcudart.so.12")
      );
    }
    if (change === "host-driver")
      writeFileSync(
        resolve(runtimeRoot, "llama.cpp/cuda/libcuda.so.1"),
        "driver"
      );
    if (change === "cpu") mkdirSync(resolve(runtimeRoot, "llama.cpp/cpu"));
    if (change === "postgres") mkdirSync(resolve(runtimeRoot, "postgres"));
    assert.throws(() => verifyFrozenCuda(runtimeRoot), /changed|unexpected/);
  });
}

test("CUDA links cannot escape the payload or form chains or hard links", () => {
  const { runtimeRoot } = fixture();
  const target = resolve(runtimeRoot, "llama.cpp/cuda/alias");
  linkSync(resolve(runtimeRoot, "llama.cpp/cuda/llama-server"), target);
  assert.throws(() => cudaInventory(runtimeRoot), /hard links/);
  rmSync(target);
  for (const destination of [
    "libcudart.so.12",
    "../cuda/../missing",
    resolve(runtimeRoot, "llama.cpp/cuda/llama-server")
  ]) {
    symlinkSync(destination, target);
    assert.throws(() => cudaInventory(runtimeRoot), /directly|ENOENT/);
    rmSync(target);
  }
});

test("CUDA budgets are independent of the core and historical combined archive", () => {
  const report = {
    source: `koed-native-cuda-${"a".repeat(64)}-linux-x64.tar.gz`,
    bytes: {
      archive: 710_992_929,
      expandedRegularFiles: 1_467_391_264,
      duplicateRatio: 0,
      manifest: 1024
    },
    findings: {
      unsafeSymlinks: [],
      specialFiles: [],
      foreignPlatformNativeFiles: [],
      absolutePaths: [],
      sourceCheckoutLeaks: []
    }
  };
  const policy = JSON.parse(
    readFileSync(
      new URL(
        "../../config/release-artifact-size-policy.json",
        import.meta.url
      ),
      "utf8"
    )
  );
  assert.equal(evaluateArtifactPolicy(report, policy).ok, true);
  for (const key of ["archive", "expandedRegularFiles"])
    assert.equal(
      evaluateArtifactPolicy(
        { ...report, bytes: { ...report.bytes, [key]: 2_000_000_000 } },
        policy
      ).ok,
      false
    );
  assert.equal(
    evaluateArtifactPolicy(report, {
      ...policy,
      nativeCudaArchiveMaximum: undefined
    }).ok,
    false
  );
});
