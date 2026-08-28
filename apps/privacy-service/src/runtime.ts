import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  PRIVACY_MAX_FIELD_TOKENS,
  PRIVACY_WINDOW_CONTEXT_TOKENS,
  PRIVACY_WINDOW_CORE_TOKENS,
  PRIVACY_WINDOW_MAX_TOKENS
} from "@koed/shared";
import {
  parseViterbiCalibration,
  ZERO_VITERBI_BIASES,
  type ViterbiBiases
} from "./decoder.js";
import { ClassificationError } from "./errors.js";
import { TOKEN_LABELS, type PrivacyLabel } from "./labels.js";
import { utf8Offsets, type TokenOffset } from "./offsets.js";
import type { PrivacyRuntimeProvider } from "./provider.js";
import { PRIVACY_CLASSIFIER_HASH } from "./provenance.js";

export interface RawPrivacyClassification {
  decodedText: string;
  tokenOffsets: TokenOffset[];
  logits: number[][];
  viterbiBiases: ViterbiBiases;
}

export interface PrivacyRuntimeAdapter {
  readonly modelId: string;
  readonly modelRevision: string;
  readonly classifierHash: string;
  readonly provider: PrivacyRuntimeProvider;
  isReady(): boolean;
  classify(text: string): Promise<RawPrivacyClassification>;
  unload?(): Promise<void>;
  dispose?(): Promise<void>;
}

type TensorLike = {
  data?: ArrayLike<number | bigint>;
  dims?: number[];
  tolist?: () => unknown;
};

type TokenizerResult = {
  input_ids?: TensorLike;
  attention_mask?: TensorLike;
  offset_mapping?: TensorLike;
};

type Tokenizer = {
  (text: string, options: Record<string, unknown>): Promise<TokenizerResult>;
  decode(
    ids: number[],
    options: Record<string, unknown>
  ): Promise<string> | string;
  _tokenizer?: { id_to_token(id: number): string | undefined };
};

type Model = {
  (inputs: Record<string, unknown>): Promise<{ logits?: TensorLike }>;
  dispose?: () => Promise<unknown> | unknown;
};

type TensorConstructor = new (
  type: string,
  data: BigInt64Array,
  dims: number[]
) => TensorLike;

type TransformersModule = {
  env: {
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    cacheDir: string;
  };
  Tensor: TensorConstructor;
  AutoTokenizer: {
    from_pretrained(
      id: string,
      options: Record<string, unknown>
    ): Promise<Tokenizer>;
  };
  AutoModelForTokenClassification: {
    from_pretrained(
      id: string,
      options: Record<string, unknown>
    ): Promise<Model>;
  };
};

type TransformersLoader = () => Promise<TransformersModule>;
type CalibrationLoader = (path: string) => Promise<string>;

export {
  PRIVACY_MAX_FIELD_TOKENS,
  PRIVACY_WINDOW_CONTEXT_TOKENS,
  PRIVACY_WINDOW_CORE_TOKENS,
  PRIVACY_WINDOW_MAX_TOKENS
};

const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<unknown>;

const tensorList = (tensor: TensorLike | undefined, name: string): unknown => {
  if (!tensor) throw new ClassificationError(`privacy runtime omitted ${name}`);
  if (typeof tensor.tolist === "function") return tensor.tolist();
  if (!tensor.data || !tensor.dims) {
    throw new ClassificationError(`privacy runtime emitted invalid ${name}`);
  }
  if (tensor.dims.length === 2) {
    const [rows = 0, columns = 0] = tensor.dims;
    return Array.from({ length: rows }, (_, row) =>
      Array.from({ length: columns }, (_, column) =>
        Number(tensor.data?.[row * columns + column])
      )
    );
  }
  return Array.from(tensor.data, Number);
};

const unwrapBatch = (value: unknown): unknown =>
  Array.isArray(value) && value.length === 1 && Array.isArray(value[0])
    ? value[0]
    : value;

const numericTensorValue = (value: unknown, name: string): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") {
    const converted = Number(value);
    if (Number.isSafeInteger(converted)) return converted;
  }
  throw new ClassificationError(`privacy runtime emitted invalid ${name}`);
};

const numericRows = (value: unknown, name: string): number[][] => {
  const rows = unwrapBatch(value);
  if (!Array.isArray(rows)) {
    throw new ClassificationError(`privacy runtime emitted invalid ${name}`);
  }
  return rows.map((row) => {
    if (!Array.isArray(row)) {
      throw new ClassificationError(`privacy runtime emitted invalid ${name}`);
    }
    return row.map((item) => numericTensorValue(item, name));
  });
};

const numericVector = (value: unknown, name: string): number[] => {
  const vector = unwrapBatch(value);
  if (!Array.isArray(vector)) {
    throw new ClassificationError(`privacy runtime emitted invalid ${name}`);
  }
  return vector.map((item) => numericTensorValue(item, name));
};

const byteDecoder = (() => {
  const bytes = [
    ...Array.from({ length: 94 }, (_, index) => index + 33),
    ...Array.from({ length: 12 }, (_, index) => index + 161),
    ...Array.from({ length: 82 }, (_, index) => index + 174)
  ];
  const codePoints = [...bytes];
  let extra = 0;
  for (let byte = 0; byte < 256; byte += 1) {
    if (bytes.includes(byte)) continue;
    bytes.push(byte);
    codePoints.push(256 + extra);
    extra += 1;
  }
  return new Map(
    codePoints.map((codePoint, index) => [
      String.fromCodePoint(codePoint),
      bytes[index] as number
    ])
  );
})();

const vocabularyTokenOffsets = (
  tokenizer: Tokenizer,
  tokenIds: number[],
  text: string
): TokenOffset[] => {
  const idToToken = tokenizer._tokenizer?.id_to_token.bind(
    tokenizer._tokenizer
  );
  if (!idToToken) {
    throw new ClassificationError(
      "privacy tokenizer omitted both offsets and token vocabulary access"
    );
  }
  const source = Buffer.from(text, "utf8");
  const decodedTokens: Buffer[] = [];
  const offsets: TokenOffset[] = [];
  let cursor = 0;
  for (const tokenId of tokenIds) {
    const token = idToToken(tokenId);
    if (token === undefined) {
      throw new ClassificationError("privacy tokenizer omitted a token value");
    }
    const values = [...token].map((character) => byteDecoder.get(character));
    if (values.some((value) => value === undefined)) {
      throw new ClassificationError(
        "privacy tokenizer emitted an unsupported byte-level token"
      );
    }
    const bytes = Buffer.from(values as number[]);
    if (bytes.length === 0) {
      throw new ClassificationError("privacy tokenizer emitted an empty token");
    }
    decodedTokens.push(bytes);
    offsets.push({ startByte: cursor, endByte: cursor + bytes.length });
    cursor += bytes.length;
  }
  if (!Buffer.concat(decodedTokens).equals(source)) {
    throw new ClassificationError(
      "privacy tokenizer byte tokens do not exactly match the request"
    );
  }
  return offsets;
};

export class HuggingFacePrivacyRuntime implements PrivacyRuntimeAdapter {
  readonly classifierHash = PRIVACY_CLASSIFIER_HASH;
  private tokenizer: Tokenizer | null = null;
  private model: Model | null = null;
  private Tensor: TensorConstructor | null = null;
  private loadPromise: Promise<void> | null = null;
  private inferenceTail: Promise<void> = Promise.resolve();
  private viterbiBiases: ViterbiBiases | null = null;
  private disposed = false;

  constructor(
    readonly modelId: string,
    readonly modelRevision: string,
    private readonly cacheDir: string,
    private readonly loadTransformers: TransformersLoader = async () =>
      (await dynamicImport("@huggingface/transformers")) as TransformersModule,
    private readonly loadCalibration: CalibrationLoader = (path) =>
      readFile(path, "utf8"),
    readonly provider: PrivacyRuntimeProvider = "cpu"
  ) {}

  isReady(): boolean {
    return (
      this.tokenizer !== null &&
      this.model !== null &&
      this.Tensor !== null &&
      this.viterbiBiases !== null
    );
  }

  async load(): Promise<void> {
    if (this.disposed) {
      throw new ClassificationError("privacy runtime has been disposed");
    }
    if (this.isReady()) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadOnce().finally(() => {
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  private async loadOnce(): Promise<void> {
    const imported = await this.loadTransformers();
    imported.env.allowLocalModels = true;
    imported.env.allowRemoteModels = false;
    imported.env.cacheDir = this.cacheDir;
    const options = {
      dtype: "q4",
      local_files_only: true,
      device: this.provider
    };
    const verifiedModelPath = resolve(
      this.cacheDir,
      ...this.modelId.split("/"),
      this.modelRevision
    );
    const [tokenizer, model, calibrationText] = await Promise.all([
      imported.AutoTokenizer.from_pretrained(verifiedModelPath, options),
      imported.AutoModelForTokenClassification.from_pretrained(
        verifiedModelPath,
        options
      ),
      this.loadCalibration(
        resolve(verifiedModelPath, "viterbi_calibration.json")
      )
    ]);
    let calibration: unknown;
    try {
      calibration = JSON.parse(calibrationText) as unknown;
    } catch {
      throw new ClassificationError(
        "privacy Viterbi calibration is not valid JSON"
      );
    }
    this.tokenizer = tokenizer;
    this.model = model;
    this.Tensor = imported.Tensor;
    this.viterbiBiases = parseViterbiCalibration(calibration);
  }

  async classify(text: string): Promise<RawPrivacyClassification> {
    if (this.disposed) {
      throw new ClassificationError("privacy runtime has been disposed");
    }
    if (text.length === 0) {
      await this.load();
      if (!this.viterbiBiases) {
        throw new ClassificationError("privacy calibration is unavailable");
      }
      return {
        decodedText: "",
        tokenOffsets: [],
        logits: [],
        viterbiBiases: this.viterbiBiases
      };
    }
    const previous = this.inferenceTail;
    let release!: () => void;
    this.inferenceTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.classifyBounded(text);
    } finally {
      release();
    }
  }

  private async classifyBounded(
    text: string
  ): Promise<RawPrivacyClassification> {
    await this.load();
    const tokenizer = this.tokenizer;
    const model = this.model;
    const Tensor = this.Tensor;
    const viterbiBiases = this.viterbiBiases;
    if (!tokenizer || !model || !Tensor || !viterbiBiases) {
      throw new ClassificationError("privacy runtime is unavailable");
    }

    const encoded = await tokenizer(text, {
      add_special_tokens: false,
      return_offsets_mapping: true,
      truncation: false
    });
    const tokenIds = numericVector(
      tensorList(encoded.input_ids, "input_ids"),
      "input_ids"
    );
    if (tokenIds.length > PRIVACY_MAX_FIELD_TOKENS) {
      throw new ClassificationError(
        `privacy field exceeds ${PRIVACY_MAX_FIELD_TOKENS} tokens`
      );
    }
    const decodedText = await tokenizer.decode(tokenIds, {
      skip_special_tokens: true,
      clean_up_tokenization_spaces: false
    });
    const tokenOffsets = encoded.offset_mapping
      ? numericRows(
          tensorList(encoded.offset_mapping, "offset_mapping"),
          "offset_mapping"
        ).map((offset) => {
          if (offset.length !== 2) {
            throw new ClassificationError(
              "privacy runtime emitted invalid offset_mapping"
            );
          }
          return utf8Offsets(text, offset[0] as number, offset[1] as number);
        })
      : vocabularyTokenOffsets(tokenizer, tokenIds, text);

    const logits: number[][] = [];
    for (
      let coreStart = 0;
      coreStart < tokenIds.length;
      coreStart += PRIVACY_WINDOW_CORE_TOKENS
    ) {
      const coreEnd = Math.min(
        tokenIds.length,
        coreStart + PRIVACY_WINDOW_CORE_TOKENS
      );
      const windowStart = Math.max(
        0,
        coreStart - PRIVACY_WINDOW_CONTEXT_TOKENS
      );
      const windowEnd = Math.min(
        tokenIds.length,
        coreEnd + PRIVACY_WINDOW_CONTEXT_TOKENS
      );
      const windowIds = tokenIds.slice(windowStart, windowEnd);
      const inputIds = new Tensor(
        "int64",
        BigInt64Array.from(windowIds, BigInt),
        [1, windowIds.length]
      );
      const attentionMask = new Tensor(
        "int64",
        BigInt64Array.from({ length: windowIds.length }, () => 1n),
        [1, windowIds.length]
      );
      const output = await model({
        input_ids: inputIds,
        attention_mask: attentionMask
      });
      const windowLogits = numericRows(
        tensorList(output.logits, "logits"),
        "logits"
      );
      if (windowLogits.length !== windowIds.length) {
        throw new ClassificationError(
          "privacy runtime window logits do not match input tokens"
        );
      }
      const retainedStart = coreStart - windowStart;
      logits.push(
        ...windowLogits.slice(
          retainedStart,
          retainedStart + (coreEnd - coreStart)
        )
      );
    }

    return {
      decodedText,
      tokenOffsets,
      logits,
      viterbiBiases
    };
  }

  async unload(): Promise<void> {
    if (this.disposed) return;
    await this.inferenceTail;
    const model = this.model;
    this.model = null;
    this.tokenizer = null;
    this.Tensor = null;
    this.viterbiBiases = null;
    this.loadPromise = null;
    await model?.dispose?.();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.unload();
    this.disposed = true;
  }
}

export interface TestDetection {
  label: PrivacyLabel;
  start: number;
  end: number;
}

const oneHotRow = (labelIndex: number): number[] =>
  TOKEN_LABELS.map((_, index) => (index === labelIndex ? 20 : -20));

export class DeterministicPrivacyRuntime implements PrivacyRuntimeAdapter {
  readonly modelId = "deterministic-privacy-test-runtime";
  readonly modelRevision = "test-v1";
  readonly classifierHash = "0".repeat(64);
  readonly provider = "cpu" as const;
  private readonly detections = new Map<string, TestDetection[]>();

  setDetections(text: string, detections: TestDetection[]): this {
    this.detections.set(text, detections);
    return this;
  }

  isReady(): boolean {
    return true;
  }

  async classify(text: string): Promise<RawPrivacyClassification> {
    const tokenOffsets: TokenOffset[] = [];
    let byteCursor = 0;
    for (let start = 0; start < text.length; ) {
      const width = text.codePointAt(start)! > 0xffff ? 2 : 1;
      const byteWidth = Buffer.byteLength(text.slice(start, start + width));
      tokenOffsets.push({
        startByte: byteCursor,
        endByte: byteCursor + byteWidth
      });
      byteCursor += byteWidth;
      start += width;
    }
    const tokenLabels = new Array<string>(tokenOffsets.length).fill("O");
    for (const detection of this.detections.get(text) ?? []) {
      const detectionBytes = utf8Offsets(text, detection.start, detection.end);
      const covered = tokenOffsets
        .map((offset, index) => ({ offset, index }))
        .filter(
          ({ offset }) =>
            offset.startByte >= detectionBytes.startByte &&
            offset.endByte <= detectionBytes.endByte
        );
      if (covered.length === 0) continue;
      covered.forEach(({ index }, position) => {
        const tag =
          covered.length === 1
            ? "S"
            : position === 0
              ? "B"
              : position === covered.length - 1
                ? "E"
                : "I";
        tokenLabels[index] = `${tag}-${detection.label}`;
      });
    }
    return {
      decodedText: text,
      tokenOffsets,
      logits: tokenLabels.map((label) => {
        const index = TOKEN_LABELS.indexOf(
          label as (typeof TOKEN_LABELS)[number]
        );
        return oneHotRow(index);
      }),
      viterbiBiases: { ...ZERO_VITERBI_BIASES }
    };
  }
}
