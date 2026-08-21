import { describe, expect, it } from "vitest";
import { maskClassification } from "./masking.js";
import {
  HuggingFacePrivacyRuntime,
  PRIVACY_WINDOW_MAX_TOKENS
} from "./runtime.js";

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

const fakeTransformers = (options?: { delayMs?: number }) => {
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
      decode: async (ids: number[]) => String.fromCodePoint(...ids)
    }
  );
  const model = async (inputs: Record<string, unknown>) => {
    const input = inputs.input_ids as FakeTensor;
    const ids = Array.from(input.data, Number);
    windowSizes.push(ids.length);
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (options?.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    active -= 1;
    return { logits: { tolist: () => [ids.map(logitsFor)] } };
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
        device: "cpu"
      },
      {
        dtype: "q4",
        local_files_only: true,
        device: "cpu"
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
