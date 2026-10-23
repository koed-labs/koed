import { describe, expect, it } from "vitest";
import { requiredModelStatusInstalled } from "./required-model-status.js";

const embeddingStatus = {
  state: "installed",
  message: "Embedding model is installed and checksum verified.",
  modelPath: "/isolated/models/embedding.gguf",
  sizeBytes: 123,
  sha256: "a".repeat(64),
  manifest: { key: "embedding" }
};

const privacyStatus = {
  ok: true,
  state: "installed",
  message: "Pinned Privacy Filter model assets are installed and verified.",
  modelPath: "/isolated/models/privacy",
  files: []
};

describe("required packaged model status", () => {
  it("accepts the actual checksum-verified embedding CLI shape without an ok field", () => {
    expect(requiredModelStatusInstalled("embedding", embeddingStatus)).toBe(
      true
    );
  });

  it("fails closed for an explicit embedding failure or malformed installed status", () => {
    expect(
      requiredModelStatusInstalled("embedding", {
        ...embeddingStatus,
        ok: false
      })
    ).toBe(false);
    for (const value of [
      null,
      [],
      {},
      { state: "installed" },
      { ...embeddingStatus, modelPath: "" },
      { ...embeddingStatus, message: null },
      { ...embeddingStatus, ok: "true" },
      { ...embeddingStatus, state: "missing" },
      { ...embeddingStatus, state: "unavailable" }
    ]) {
      expect(requiredModelStatusInstalled("embedding", value)).toBe(false);
    }
  });

  it("requires an explicit successful privacy status", () => {
    expect(requiredModelStatusInstalled("privacy", privacyStatus)).toBe(true);
    for (const value of [
      { ...privacyStatus, ok: false },
      { ...privacyStatus, ok: undefined },
      { ...privacyStatus, state: "missing" },
      { ...privacyStatus, modelPath: "" }
    ]) {
      expect(requiredModelStatusInstalled("privacy", value)).toBe(false);
    }
  });
});
