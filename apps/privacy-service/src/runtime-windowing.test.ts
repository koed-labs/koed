import { describe, expect, it } from "vitest";
import { availableParallelism } from "node:os";
import { maskClassification } from "./masking.js";
import {
  HuggingFacePrivacyRuntime,
  PRIVACY_WINDOW_MAX_TOKENS
} from "./runtime.js";
import { PRIVACY_CLASSIFICATION_MAX_FIELD_BYTES } from "@koed/shared";

class FakeTensor {
  constructor(
    readonly type: string,
    readonly data: BigInt64Array,
    readonly dims: number[]
  ) {}
}

const logitsFor = (tokenId: number): number[] =>
  Array.from({ length: 33 }, (_, index) => {
    const expected = tokenId === 89 ? 29 : tokenId === 90 ? 31 : 0;
    return index === expected ? 20 : -20;
  });

const calibration = JSON.stringify({
  operating_points: {
    default: {
      biases: {
        transition_bias_background_stay: 0,
        transition_bias_background_to_start: 0,
        transition_bias_inside_to_continue: 0,
        transition_bias_inside_to_end: 0,
        transition_bias_end_to_background: 0,
        transition_bias_end_to_start: 0
      }
    }
  }
});

const fakeTransformers = (options?: {
  compactLogits?: boolean;
  delayMs?: number;
  onWindow?: () => void;
}) => {
  const windowSizes: number[] = [];
  const loadOptions: Record<string, unknown>[] = [];
  let active = 0;
  let maxActive = 0;
  const tokenizer = Object.assign(
    async (text: string) => {
      const ids = [...text].map((character) => character.codePointAt(0)!);
      return {
        input_ids: { tolist: () => [ids.map(BigInt)] },
        attention_mask: { tolist: () => [ids.map(() => 1)] },
        offset_mapping: {
          tolist: () => [ids.map((_, index) => [index, index + 1])]
        }
      };
    },
    {
      decode: async (ids: number[]) =>
        ids.map((tokenId) => String.fromCodePoint(tokenId)).join("")
    }
  );
  const model = async (inputs: Record<string, unknown>) => {
    const input = inputs.input_ids as FakeTensor;
    const ids = Array.from(input.data, Number);
    windowSizes.push(ids.length);
    options?.onWindow?.();
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (options?.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    active -= 1;
    return {
      logits: {
        tolist: () => [
          ids.map((tokenId) =>
            options?.compactLogits ? [0] : logitsFor(tokenId)
          )
        ]
      }
    };
  };
  return {
    module: {
      env: {
        allowLocalModels: false,
        allowRemoteModels: true,
        cacheDir: ""
      },
      Tensor: FakeTensor,
      AutoTokenizer: {
        from_pretrained: async (
          _modelId: string,
          modelOptions: Record<string, unknown>
        ) => {
          loadOptions.push(modelOptions);
          return tokenizer;
        }
      },
      AutoModelForTokenClassification: {
        from_pretrained: async (
          _modelId: string,
          modelOptions: Record<string, unknown>
        ) => {
          loadOptions.push(modelOptions);
          return model;
        }
      }
    },
    windowSizes,
    loadOptions,
    maxActive: () => maxActive
  };
};

describe("bounded Privacy Filter runtime", () => {
  it("cancels between windows without returning partial classification and releases inference capacity", async () => {
    const cancellation = new AbortController();
    const fixture = fakeTransformers({ onWindow: () => cancellation.abort() });
    const runtime = new HuggingFacePrivacyRuntime(
      "openai/privacy-filter",
      "pinned",
      "/verified/privacy-cache",
      async () => fixture.module,
      async () => calibration
    );
    await expect(
      runtime.classify("a".repeat(1_025), cancellation.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.windowSizes).toHaveLength(1);
    await expect(runtime.classify("next")).resolves.toMatchObject({
      decodedText: "next"
    });
    expect(fixture.windowSizes).toHaveLength(2);
  });
  it("mounts the pinned external ONNX data explicitly for Core ML", async () => {
    const fixture = fakeTransformers();
    const runtime = new HuggingFacePrivacyRuntime(
      "openai/privacy-filter",
      "pinned",
      "/verified/privacy-cache",
      async () => fixture.module,
      async () => calibration,
      "coreml"
    );

    await runtime.load();

    expect(fixture.loadOptions).toEqual([
      expect.objectContaining({
        device: "coreml",
        use_external_data_format: false,
        session_options: {
          externalData: [
            {
              path: "model_q4.onnx_data",
              data: "onnx/model_q4.onnx_data"
            }
          ]
        }
      }),
      expect.objectContaining({ device: "coreml" })
    ]);
  });

  it("reassembles overlapped windows exactly across a BIOES boundary", async () => {
    const fixture = fakeTransformers();
    const text = `${"a".repeat(255)}YZ${"b".repeat(443)}`;
    const runtime = new HuggingFacePrivacyRuntime(
      "openai/privacy-filter",
      "pinned",
      "/verified/privacy-cache",
      async () => fixture.module,
      async () => calibration
    );

    const raw = await runtime.classify(text);
    const masked = maskClassification(text, raw);

    expect(raw.decodedText).toBe(text);
    expect(raw.logits).toHaveLength(text.length);
    expect(raw.tokenOffsets).toHaveLength(text.length);
    expect(fixture.windowSizes).toEqual([384, 512, 316]);
    expect(Math.max(...fixture.windowSizes)).toBe(PRIVACY_WINDOW_MAX_TOKENS);
    expect(fixture.loadOptions).toEqual([
      {
        dtype: "q4",
        local_files_only: true,
        device: "cpu",
        session_options: {
          intraOpNumThreads: Math.min(4, availableParallelism()),
          interOpNumThreads: 1
        }
      },
      {
        dtype: "q4",
        local_files_only: true,
        device: "cpu",
        session_options: {
          intraOpNumThreads: Math.min(4, availableParallelism()),
          interOpNumThreads: 1
        }
      }
    ]);
    expect(fixture.module.env).toEqual({
      allowLocalModels: true,
      allowRemoteModels: false,
      cacheDir: "/verified/privacy-cache"
    });
    expect(masked.spans).toEqual([
      {
        label: "secret",
        detectors: ["privacy_filter"],
        startByte: 255,
        endByte: 257
      }
    ]);
    expect(masked.maskedText).toBe(
      `${"a".repeat(255)}[SECRET]${"b".repeat(443)}`
    );
  });

  it("serializes concurrent requests through one bounded inference gate", async () => {
    const fixture = fakeTransformers({ delayMs: 2 });
    const runtime = new HuggingFacePrivacyRuntime(
      "openai/privacy-filter",
      "pinned",
      "/verified/privacy-cache",
      async () => fixture.module,
      async () => calibration
    );

    await Promise.all([
      runtime.classify("a".repeat(600)),
      runtime.classify("b".repeat(600))
    ]);

    expect(fixture.maxActive()).toBe(1);
    expect(
      fixture.windowSizes.every((size) => size <= PRIVACY_WINDOW_MAX_TOKENS)
    ).toBe(true);
  });

  it("keeps every inference window bounded for a maximum-size valid field", async () => {
    const fixture = fakeTransformers({ compactLogits: true });
    const runtime = new HuggingFacePrivacyRuntime(
      "openai/privacy-filter",
      "pinned",
      "/verified/privacy-cache",
      async () => fixture.module,
      async () => calibration
    );

    const result = await runtime.classify(
      "x".repeat(PRIVACY_CLASSIFICATION_MAX_FIELD_BYTES)
    );

    expect(result.decodedText).toHaveLength(
      PRIVACY_CLASSIFICATION_MAX_FIELD_BYTES
    );
    expect(fixture.windowSizes.length).toBeGreaterThan(1);
    expect(
      fixture.windowSizes.every((size) => size <= PRIVACY_WINDOW_MAX_TOKENS)
    ).toBe(true);
  });

  it("preserves multibyte UTF-8 text across inference-window boundaries", async () => {
    const fixture = fakeTransformers({ compactLogits: true });
    const runtime = new HuggingFacePrivacyRuntime(
      "openai/privacy-filter",
      "pinned",
      "/verified/privacy-cache",
      async () => fixture.module,
      async () => calibration
    );
    const text = "é".repeat(1_025);
    let completedWindows = 0;
    const result = await runtime.classify(text, undefined, () => {
      completedWindows += 1;
    });
    expect(completedWindows).toBe(fixture.windowSizes.length);

    expect(result.decodedText).toBe(text);
    expect(result.tokenOffsets.at(-1)).toEqual({
      startByte: 2_048,
      endByte: 2_050
    });
    expect(
      fixture.windowSizes.every((size) => size <= PRIVACY_WINDOW_MAX_TOKENS)
    ).toBe(true);
  });

  it("reloads the same provider after an idle model unload", async () => {
    const fixture = fakeTransformers();
    const runtime = new HuggingFacePrivacyRuntime(
      "openai/privacy-filter",
      "pinned",
      "/verified/privacy-cache",
      async () => fixture.module,
      async () => calibration,
      "cuda"
    );

    await runtime.classify("first");
    expect(runtime.isReady()).toBe(true);
    await runtime.unload();
    expect(runtime.isReady()).toBe(false);
    await runtime.classify("second");
    expect(runtime.isReady()).toBe(true);
    expect(fixture.loadOptions).toHaveLength(4);
    expect(fixture.loadOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ device: "cuda" }),
        expect.objectContaining({ device: "cuda" })
      ])
    );
    await runtime.dispose();
  });
});
