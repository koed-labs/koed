import { ClassificationError } from "./errors.js";
import { TOKEN_LABELS } from "./labels.js";

export interface PrivacyBatchInput {
  id: string;
  tokenIds: readonly number[];
}
export interface PrivacyBatchOutput {
  id: string;
  logits: number[][];
}
export const PRIVACY_SHORT_BATCH_FIELDS = 8;
export const PRIVACY_SHORT_BATCH_TOKENS = 256;
export const PRIVACY_SHORT_BATCH_POSITIONS = 2048;

export function validateBatchInput(rows: readonly PrivacyBatchInput[]): number {
  const length = Math.max(0, ...rows.map((row) => row.tokenIds.length));
  if (
    rows.length < 1 ||
    rows.length > PRIVACY_SHORT_BATCH_FIELDS ||
    length * rows.length > PRIVACY_SHORT_BATCH_POSITIONS ||
    new Set(rows.map((row) => row.id)).size !== rows.length ||
    rows.some(
      (row) =>
        !/^[a-f0-9-]{36}$/.test(row.id) ||
        row.tokenIds.length < 1 ||
        row.tokenIds.length > PRIVACY_SHORT_BATCH_TOKENS ||
        row.tokenIds.some((id) => !Number.isSafeInteger(id) || id < 0)
    )
  ) {
    throw new ClassificationError("invalid privacy short-field batch");
  }
  return length;
}

export function validLogits(
  value: unknown,
  tokens: number
): value is number[][] {
  return (
    Array.isArray(value) &&
    value.length === tokens &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.length === TOKEN_LABELS.length &&
        row.every((item) => typeof item === "number" && Number.isFinite(item))
    )
  );
}

export function validateBatchOutput(
  inputs: readonly PrivacyBatchInput[],
  value: unknown
): PrivacyBatchOutput[] {
  if (!Array.isArray(value) || value.length !== inputs.length)
    throw new ClassificationError("invalid privacy batch output");
  const expected = new Map(inputs.map((row) => [row.id, row]));
  const output = new Map<string, PrivacyBatchOutput>();
  for (const row of value) {
    if (
      !row ||
      typeof row !== "object" ||
      !expected.has(row.id) ||
      output.has(row.id) ||
      !validLogits(row.logits, expected.get(row.id)!.tokenIds.length)
    )
      throw new ClassificationError("invalid privacy batch output");
    output.set(row.id, { id: row.id, logits: row.logits });
  }
  return inputs.map((row) => output.get(row.id)!);
}
