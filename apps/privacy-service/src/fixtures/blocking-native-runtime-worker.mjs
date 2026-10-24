import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { setTimeout } from "node:timers";
import { parentPort } from "node:worker_threads";
import { serveNativeRuntimeWorker } from "./native-runtime-worker-server.mjs";
import { ZERO_VITERBI_BIASES, TOKEN_LABELS } from "./fixture-constants.mjs";

const blockingCell = new Int32Array(new SharedArrayBuffer(4));

serveNativeRuntimeWorker(({ modelId, modelRevision, cacheDir, provider }) => {
  let ready = false;
  let disposed = false;
  return {
    modelId,
    modelRevision,
    classifierHash: "fixture",
    provider,
    isReady: () => ready,
    async load() {
      if (disposed) throw new Error("disposed");
      if (ready) return;
      if (provider === "coreml") {
        // Simulate a native load that occupies its entire JavaScript thread.
        writeFileSync(`${cacheDir}.coreml-load-started`, "entered");
        Atomics.wait(blockingCell, 0, 0, 6_000);
      }
      ready = true;
    },
    async classify(text) {
      await this.load();
      if (text === "__crash_worker__") process.exit(7);
      if (text.startsWith("__block_worker__:")) {
        writeFileSync(text.slice("__block_worker__:".length), "entered");
        Atomics.wait(blockingCell, 0, 0, 2_000);
      }
      if (text === "__invalid_response__") {
        parentPort.postMessage({
          id: 1,
          ok: true,
          ready: true,
          identity: null
        });
      }
      if (text === "__identity_mismatch__") this.modelId = "tampered";
      if (provider === "cpu") {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return {
        decodedText: text,
        tokenOffsets: [{ startByte: 0, endByte: Buffer.byteLength(text) }],
        logits: [TOKEN_LABELS.map((label) => (label === "O" ? 20 : -20))],
        viterbiBiases: ZERO_VITERBI_BIASES
      };
    },
    async unload() {
      ready = false;
    },
    async dispose() {
      ready = false;
      disposed = true;
    }
  };
});
