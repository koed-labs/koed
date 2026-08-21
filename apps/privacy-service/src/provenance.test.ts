import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  OFFICIAL_PRIVACY_ARTIFACT_SHA256,
  OFFICIAL_PRIVACY_MODEL_REVISION,
  OFFICIAL_PRIVACY_Q4_DATA_SHA256,
  OFFICIAL_PRIVACY_Q4_DATA_SIZE,
  OFFICIAL_PRIVACY_Q4_ONNX_SHA256,
  OFFICIAL_PRIVACY_Q4_ONNX_SIZE,
  OFFICIAL_PRIVACY_TOKENIZER_SHA256,
  PRIVACY_DECODER_SHA256,
  PRIVACY_CLASSIFIER_HASH
} from "./provenance.js";

describe("privacy classifier provenance", () => {
  it("pins an immutable official revision and complete Q4 artifact identity", () => {
    expect(OFFICIAL_PRIVACY_MODEL_REVISION).toMatch(/^[a-f0-9]{40}$/);
    expect(OFFICIAL_PRIVACY_Q4_ONNX_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(OFFICIAL_PRIVACY_Q4_DATA_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(OFFICIAL_PRIVACY_Q4_ONNX_SIZE).toBe(160_219);
    expect(OFFICIAL_PRIVACY_Q4_DATA_SIZE).toBe(917_120_144);
    expect(OFFICIAL_PRIVACY_TOKENIZER_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(OFFICIAL_PRIVACY_ARTIFACT_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(PRIVACY_DECODER_SHA256).toBe(
      createHash("sha256")
        .update(readFileSync(new URL("./decoder.ts", import.meta.url)))
        .digest("hex")
    );
    expect(PRIVACY_CLASSIFIER_HASH).toMatch(/^[a-f0-9]{64}$/);
  });
});
