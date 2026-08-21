import { describe, expect, it } from "vitest";
import { maskClassification } from "./masking.js";
import {
  DeterministicPrivacyRuntime,
  type RawPrivacyClassification
} from "./runtime.js";
import { ZERO_VITERBI_BIASES } from "./decoder.js";

const zeroBiases = () => ({ ...ZERO_VITERBI_BIASES });

describe("schema field masking", () => {
  it("returns typed placeholders with JS and UTF-8 byte offsets", async () => {
    const text = "Hi 👋 Ada@example.test!";
    const start = text.indexOf("Ada@");
    const end = text.indexOf("!");
    const runtime = new DeterministicPrivacyRuntime().setDetections(text, [
      { label: "private_email", start, end }
    ]);

    const result = maskClassification(text, await runtime.classify(text));

    expect(result.maskedText).toBe("Hi 👋 [PRIVATE_EMAIL]!");
    expect(result.spans).toEqual([
      {
        label: "private_email",
        detectors: ["privacy_filter"],
        startByte: Buffer.byteLength(text.slice(0, start)),
        endByte: Buffer.byteLength(text.slice(0, end))
      }
    ]);
  });

  it("masks multiple spans without leaking source values", async () => {
    const text = "Call Alice at +1 555 0100";
    const runtime = new DeterministicPrivacyRuntime().setDetections(text, [
      { label: "private_person", start: 5, end: 10 },
      { label: "private_phone", start: 14, end: text.length }
    ]);
    const result = maskClassification(text, await runtime.classify(text));
    expect(result.maskedText).toBe("Call [PRIVATE_PERSON] at [PRIVATE_PHONE]");
    expect(JSON.stringify(result.spans)).not.toContain("Alice");
  });

  it("unions overlapping deterministic and model secret detections", async () => {
    const secret = "sk-abcdefghijklmnopqrstuv";
    const text = `token=${secret}`;
    const start = text.indexOf(secret);
    const runtime = new DeterministicPrivacyRuntime().setDetections(text, [
      { label: "secret", start, end: text.length }
    ]);
    const result = maskClassification(text, await runtime.classify(text));
    expect(result.maskedText).toBe("token=[SECRET]");
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]?.detectors).toEqual([
      "privacy_filter",
      "deterministic"
    ]);
  });

  it("fails closed when decoded text differs", () => {
    const raw: RawPrivacyClassification = {
      decodedText: "normalized",
      tokenOffsets: [],
      logits: [],
      viterbiBiases: zeroBiases()
    };
    expect(() => maskClassification("original", raw)).toThrow(
      /does not exactly match/
    );
  });

  it("fails closed when token byte offsets do not cover the request", () => {
    const raw: RawPrivacyClassification = {
      decodedText: "👋",
      tokenOffsets: [{ startByte: 0, endByte: 1 }],
      logits: [Array.from({ length: 33 }, (_, index) => (index === 0 ? 1 : 0))],
      viterbiBiases: zeroBiases()
    };
    expect(() => maskClassification("👋", raw)).toThrow(/exactly cover/);
  });

  it("expands model spans across split UTF-8 code points", () => {
    const row = (selected: number) =>
      Array.from({ length: 33 }, (_, index) => (index === selected ? 20 : -20));
    const result = maskClassification("👋", {
      decodedText: "👋",
      tokenOffsets: [
        { startByte: 0, endByte: 2 },
        { startByte: 2, endByte: 4 }
      ],
      logits: [row(32), row(0)],
      viterbiBiases: zeroBiases()
    });
    expect(result.maskedText).toBe("[SECRET]");
    expect(result.spans).toEqual([
      {
        label: "secret",
        detectors: ["privacy_filter"],
        startByte: 0,
        endByte: 4
      }
    ]);
  });

  it("fails closed when logits and offsets are misaligned", () => {
    expect(() =>
      maskClassification("x", {
        decodedText: "x",
        tokenOffsets: [{ startByte: 0, endByte: 1 }],
        logits: [],
        viterbiBiases: zeroBiases()
      })
    ).toThrow(/lengths do not match/);
  });
});
