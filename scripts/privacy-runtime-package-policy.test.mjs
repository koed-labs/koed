import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { prunePrivacyRuntimeForTarget } from "./privacy-runtime-package-policy.mjs";

const roots = [];
test.afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const write = (path, content = "fixture") => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const fixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-privacy-package-"));
  roots.push(root);
  const packages = {
    "@huggingface/transformers": ["4.2.0", "Apache-2.0"],
    "onnxruntime-node": ["1.24.3", "MIT"],
    "onnxruntime-web": ["1.26.0-dev.20260416-b7804b056c", "MIT"],
    sharp: ["0.34.5", "Apache-2.0"],
    argon2: ["0.44.0", "MIT"]
  };
  for (const [name, [version, license]] of Object.entries(packages)) {
    write(
      resolve(root, "node_modules", name, "package.json"),
      JSON.stringify({ name, version, license })
    );
  }
  for (const [target, files] of [
    [
      "darwin/arm64",
      ["libonnxruntime.1.24.3.dylib", "onnxruntime_binding.node"]
    ],
    [
      "linux/x64",
      [
        "libonnxruntime.so.1",
        "libonnxruntime_providers_cuda.so",
        "libonnxruntime_providers_shared.so",
        "libonnxruntime_providers_tensorrt.so",
        "onnxruntime_binding.node"
      ]
    ],
    ["linux/arm64", ["runtime.node"]],
    ["win32/x64", ["runtime.node"]]
  ]) {
    for (const file of files) {
      write(
        resolve(root, "node_modules/onnxruntime-node/bin/napi-v6", target, file)
      );
    }
  }
  for (const name of [
    "sharp-darwin-arm64",
    "sharp-libvips-darwin-arm64",
    "sharp-linux-x64",
    "colour"
  ]) {
    write(resolve(root, "node_modules/@img", name, "package.json"), "{}");
  }
  for (const target of [
    "darwin-arm64",
    "darwin-x64",
    "linux-x64",
    "win32-x64"
  ]) {
    write(
      resolve(root, "node_modules/argon2/prebuilds", target, "argon2.node")
    );
  }
  write(resolve(root, "node_modules/@huggingface/transformers/src/index.js"));
  write(
    resolve(root, "node_modules/@huggingface/transformers/types/index.d.ts")
  );
  return root;
};

test("keeps only macOS arm64 ONNX and Sharp payloads", () => {
  const runtimeRoot = fixture();
  prunePrivacyRuntimeForTarget({
    repoRoot: resolve("."),
    runtimeRoot,
    platform: "macos",
    architecture: "arm64"
  });
  assert.equal(
    existsSync(
      resolve(
        runtimeRoot,
        "node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node"
      )
    ),
    true
  );
  assert.equal(
    existsSync(
      resolve(runtimeRoot, "node_modules/onnxruntime-node/bin/napi-v6/linux")
    ),
    false
  );
  assert.equal(
    existsSync(resolve(runtimeRoot, "node_modules/@img/sharp-linux-x64")),
    false
  );
  assert.equal(
    existsSync(resolve(runtimeRoot, "node_modules/onnxruntime-web")),
    false
  );
  assert.equal(
    existsSync(resolve(runtimeRoot, "node_modules/argon2/prebuilds/linux-x64")),
    false
  );
  assert.equal(
    existsSync(
      resolve(runtimeRoot, "node_modules/@huggingface/transformers/types")
    ),
    false
  );
});

test("keeps only Linux x64 ONNX, Sharp, and Argon2 payloads", () => {
  const runtimeRoot = fixture();
  const result = prunePrivacyRuntimeForTarget({
    repoRoot: resolve("."),
    runtimeRoot,
    platform: "linux",
    architecture: "x64"
  });
  assert.equal(
    existsSync(
      resolve(
        runtimeRoot,
        "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node"
      )
    ),
    true
  );
  assert.equal(
    existsSync(
      resolve(runtimeRoot, "node_modules/onnxruntime-node/bin/napi-v6/darwin")
    ),
    false
  );
  assert.deepEqual(result.executionProviderFiles, {
    cuda: [
      "libonnxruntime_providers_cuda.so",
      "libonnxruntime_providers_shared.so"
    ],
    retainedUntilHardwareValidation: ["libonnxruntime_providers_tensorrt.so"]
  });
  assert.equal(
    existsSync(resolve(runtimeRoot, "node_modules/@img/sharp-darwin-arm64")),
    false
  );
  assert.equal(
    existsSync(resolve(runtimeRoot, "node_modules/argon2/prebuilds/linux-x64")),
    true
  );
  assert.equal(
    existsSync(resolve(runtimeRoot, "node_modules/onnxruntime-web")),
    false
  );
});

test("fails closed when a pinned dependency shape changes", () => {
  const runtimeRoot = fixture();
  write(
    resolve(runtimeRoot, "node_modules/onnxruntime-node/package.json"),
    JSON.stringify({ name: "onnxruntime-node", version: "future" })
  );
  assert.throws(
    () =>
      prunePrivacyRuntimeForTarget({
        repoRoot: resolve("."),
        runtimeRoot,
        platform: "linux",
        architecture: "x64"
      }),
    /dependency shape changed/
  );
});

test("fails closed when a Linux CUDA provider file is missing", () => {
  const runtimeRoot = fixture();
  rmSync(
    resolve(
      runtimeRoot,
      "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_shared.so"
    )
  );
  assert.throws(
    () =>
      prunePrivacyRuntimeForTarget({
        repoRoot: resolve("."),
        runtimeRoot,
        platform: "linux",
        architecture: "x64"
      }),
    /ONNX file shape changed/
  );
});

test("fails closed when a pinned dependency licence changes", () => {
  const runtimeRoot = fixture();
  write(
    resolve(runtimeRoot, "node_modules/onnxruntime-node/package.json"),
    JSON.stringify({
      name: "onnxruntime-node",
      version: "1.24.3",
      license: "future-license"
    })
  );
  assert.throws(
    () =>
      prunePrivacyRuntimeForTarget({
        repoRoot: resolve("."),
        runtimeRoot,
        platform: "linux",
        architecture: "x64"
      }),
    /licence changed/
  );
});
