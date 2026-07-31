import assert from "node:assert/strict";
import test from "node:test";
import { isLlamaRuntimeFile } from "./native-runtime/procure-runtime.mjs";

test("llama staging keeps the server runtime closure and license while pruning auxiliary executables", () => {
  for (const file of [
    "llama-server",
    "LICENSE",
    "libllama.0.dylib",
    "libggml.so",
    "libggml.so.1",
    "ggml-metal.metal"
  ]) {
    assert.equal(isLlamaRuntimeFile(file), true, file);
  }
  for (const file of [
    "llama-cli",
    "llama-bench",
    "llama-batched-bench",
    "llama-quantize",
    "README.md"
  ]) {
    assert.equal(isLlamaRuntimeFile(file), false, file);
  }
});
