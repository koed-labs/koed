import { ClassificationError } from "./errors.js";
import { TOKEN_LABELS, parseTokenLabel, type TokenLabel } from "./labels.js";

const NEGATIVE_INFINITY = -1e30;

export interface ViterbiBiases {
  backgroundStay: number;
  backgroundToStart: number;
  insideToContinue: number;
  insideToEnd: number;
  endToBackground: number;
  endToStart: number;
}

export const ZERO_VITERBI_BIASES: Readonly<ViterbiBiases> = {
  backgroundStay: 0,
  backgroundToStart: 0,
  insideToContinue: 0,
  insideToEnd: 0,
  endToBackground: 0,
  endToStart: 0
};

const calibrationKeys = {
  transition_bias_background_stay: "backgroundStay",
  transition_bias_background_to_start: "backgroundToStart",
  transition_bias_inside_to_continue: "insideToContinue",
  transition_bias_inside_to_end: "insideToEnd",
  transition_bias_end_to_background: "endToBackground",
  transition_bias_end_to_start: "endToStart"
} as const satisfies Record<string, keyof ViterbiBiases>;

const requireExactKeys = (
  value: unknown,
  expected: readonly string[],
  path: string
): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClassificationError(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new ClassificationError(`${path} has an invalid schema`);
  }
  return record;
};

export const parseViterbiCalibration = (value: unknown): ViterbiBiases => {
  const artifact = requireExactKeys(value, ["operating_points"], "calibration");
  const operatingPoints = requireExactKeys(
    artifact.operating_points,
    ["default"],
    "calibration.operating_points"
  );
  const defaultEntry = requireExactKeys(
    operatingPoints.default,
    ["biases"],
    "calibration.operating_points.default"
  );
  const biases = requireExactKeys(
    defaultEntry.biases,
    Object.keys(calibrationKeys),
    "calibration.operating_points.default.biases"
  );
  const output = { ...ZERO_VITERBI_BIASES } as ViterbiBiases;
  for (const [source, target] of Object.entries(calibrationKeys)) {
    const bias = biases[source];
    if (typeof bias !== "number" || !Number.isFinite(bias)) {
      throw new ClassificationError(
        `calibration bias ${source} must be finite`
      );
    }
    output[target] = bias;
  }
  return output;
};

const validStart = (label: TokenLabel): boolean => {
  const parsed = parseTokenLabel(label);
  return parsed === null || parsed.tag === "B" || parsed.tag === "S";
};

const validEnd = (label: TokenLabel): boolean => {
  const parsed = parseTokenLabel(label);
  return parsed === null || parsed.tag === "E" || parsed.tag === "S";
};

export const isValidTransition = (
  previous: TokenLabel,
  next: TokenLabel
): boolean => {
  const before = parseTokenLabel(previous);
  const after = parseTokenLabel(next);
  if (before === null || before.tag === "E" || before.tag === "S") {
    return after === null || after.tag === "B" || after.tag === "S";
  }
  return (
    after !== null &&
    before.label === after.label &&
    (after.tag === "I" || after.tag === "E")
  );
};

const transitionBias = (
  previous: TokenLabel,
  next: TokenLabel,
  biases: ViterbiBiases
): number => {
  const before = parseTokenLabel(previous);
  const after = parseTokenLabel(next);
  if (before === null) {
    return after === null ? biases.backgroundStay : biases.backgroundToStart;
  }
  if (before.tag === "B" || before.tag === "I") {
    return after?.tag === "I" ? biases.insideToContinue : biases.insideToEnd;
  }
  return after === null ? biases.endToBackground : biases.endToStart;
};

const validateLogits = (logits: readonly (readonly number[])[]): void => {
  for (const row of logits) {
    if (row.length !== TOKEN_LABELS.length) {
      throw new ClassificationError(
        `privacy runtime emitted ${row.length} logits; expected ${TOKEN_LABELS.length}`
      );
    }
    if (row.some((score) => !Number.isFinite(score))) {
      throw new ClassificationError(
        "privacy runtime emitted non-finite logits"
      );
    }
  }
};

export const decodeBioesViterbi = (
  logits: readonly (readonly number[])[],
  biases: ViterbiBiases = ZERO_VITERBI_BIASES
): TokenLabel[] => {
  validateLogits(logits);
  if (logits.length === 0) return [];

  let scores = TOKEN_LABELS.map((label, index) =>
    validStart(label)
      ? (logits[0]?.[index] ?? NEGATIVE_INFINITY)
      : NEGATIVE_INFINITY
  );
  const backpointers: number[][] = [];

  for (let token = 1; token < logits.length; token += 1) {
    const previousScores = scores;
    const row = logits[token];
    const pointers = new Array<number>(TOKEN_LABELS.length).fill(-1);
    scores = TOKEN_LABELS.map((next, nextIndex) => {
      let best = NEGATIVE_INFINITY;
      let bestIndex = -1;
      for (
        let previousIndex = 0;
        previousIndex < TOKEN_LABELS.length;
        previousIndex += 1
      ) {
        const previous = TOKEN_LABELS[previousIndex];
        if (previous === undefined || !isValidTransition(previous, next))
          continue;
        const candidate =
          (previousScores[previousIndex] ?? NEGATIVE_INFINITY) +
          transitionBias(previous, next, biases);
        if (candidate > best) {
          best = candidate;
          bestIndex = previousIndex;
        }
      }
      pointers[nextIndex] = bestIndex;
      return best + (row?.[nextIndex] ?? NEGATIVE_INFINITY);
    });
    backpointers.push(pointers);
  }

  let last = -1;
  let best = NEGATIVE_INFINITY;
  for (let index = 0; index < TOKEN_LABELS.length; index += 1) {
    const label = TOKEN_LABELS[index];
    const score = scores[index] ?? NEGATIVE_INFINITY;
    if (label !== undefined && validEnd(label) && score > best) {
      best = score;
      last = index;
    }
  }
  if (last < 0 || best <= NEGATIVE_INFINITY / 2) {
    throw new ClassificationError("privacy logits have no valid BIOES path");
  }

  const path = new Array<TokenLabel>(logits.length);
  path[path.length - 1] = TOKEN_LABELS[last] as TokenLabel;
  for (let token = path.length - 2; token >= 0; token -= 1) {
    last = backpointers[token]?.[last] ?? -1;
    if (last < 0)
      throw new ClassificationError("privacy Viterbi backtrace failed");
    path[token] = TOKEN_LABELS[last] as TokenLabel;
  }
  return path;
};
