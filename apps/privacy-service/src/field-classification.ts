import { randomUUID } from "node:crypto";
import { PRIVACY_MAX_FIELD_TOKENS } from "@koed/shared";
import { ClassificationError } from "./errors.js";
import type { RawPrivacyClassification } from "./runtime.js";
import {
  PRIVACY_SHORT_BATCH_FIELDS,
  PRIVACY_SHORT_BATCH_TOKENS,
  validateBatchOutput,
  type PrivacyBatchInput,
  type PrivacyBatchOutput
} from "./inference-contract.js";

export interface PreparedPrivacyField extends Omit<
  RawPrivacyClassification,
  "logits"
> {
  tokenIds: number[];
}
interface FieldWork {
  index: number;
  prepared: PreparedPrivacyField;
}
interface ClassificationCallbacks {
  prepare(text: string, signal: AbortSignal): Promise<PreparedPrivacyField>;
  classify(
    field: PreparedPrivacyField,
    signal: AbortSignal,
    progress?: () => void
  ): Promise<RawPrivacyClassification>;
  batch(
    rows: readonly PrivacyBatchInput[],
    signal: AbortSignal
  ): Promise<PrivacyBatchOutput[]>;
}

/** Bounded preparation of fields already present in one authenticated request. */
export async function classifyRequestFields(
  texts: readonly string[],
  callbacks: ClassificationCallbacks,
  concurrency: 1 | 2,
  signal?: AbortSignal,
  progress?: () => void,
  consume?: (index: number, field: RawPrivacyClassification) => void
): Promise<RawPrivacyClassification[]> {
  const failure = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, failure.signal])
    : failure.signal;
  const output: RawPrivacyClassification[] = consume
    ? []
    : new Array(texts.length);
  const completed = new Uint8Array(texts.length);
  const publish = (index: number, field: RawPrivacyClassification) => {
    combined.throwIfAborted();
    if (completed[index] || index < 0 || index >= texts.length)
      throw new ClassificationError("duplicate privacy field result");
    if (consume) consume(index, field);
    else output[index] = field;
    completed[index] = 1;
  };
  let cursor = 0;
  while (cursor < texts.length) {
    const ready: FieldWork[] = [];
    let longFields = 0,
      tokens = 0;
    while (
      cursor < texts.length &&
      ready.length < PRIVACY_SHORT_BATCH_FIELDS &&
      longFields < 2
    ) {
      combined.throwIfAborted();
      const index = cursor++;
      const prepared = await callbacks.prepare(texts[index]!, combined);
      tokens += prepared.tokenIds.length;
      if (prepared.tokenIds.length > PRIVACY_SHORT_BATCH_TOKENS)
        longFields += 1;
      if (
        tokens >
        2 * PRIVACY_MAX_FIELD_TOKENS +
          PRIVACY_SHORT_BATCH_FIELDS * PRIVACY_SHORT_BATCH_TOKENS
      )
        throw new ClassificationError("privacy prepared token budget exceeded");
      ready.push({ index, prepared });
    }
    const buckets = new Map<number, FieldWork[]>();
    const tasks: Array<() => Promise<void>> = [];
    for (const field of ready) {
      const { tokenIds, ...raw } = field.prepared;
      if (tokenIds.length === 0) {
        publish(field.index, { ...raw, logits: [] });
        continue;
      }
      if (tokenIds.length > PRIVACY_SHORT_BATCH_TOKENS) {
        tasks.push(async () => {
          publish(
            field.index,
            await callbacks.classify(field.prepared, combined, progress)
          );
        });
      } else {
        const bucket = 2 ** Math.ceil(Math.log2(Math.max(32, tokenIds.length)));
        const fields = buckets.get(bucket) ?? [];
        fields.push(field);
        buckets.set(bucket, fields);
      }
    }
    for (const fields of buckets.values()) {
      fields.sort(
        (a, b) => a.prepared.tokenIds.length - b.prepared.tokenIds.length
      );
      tasks.push(async () => {
        const inputs = fields.map((field) => ({
          id: randomUUID(),
          tokenIds: field.prepared.tokenIds
        }));
        const rows = validateBatchOutput(
          inputs,
          await callbacks.batch(inputs, combined)
        );
        combined.throwIfAborted();
        for (let row = 0; row < fields.length; row += 1) {
          const field = fields[row]!;
          const { decodedText, tokenOffsets, viterbiBiases } = field.prepared;
          progress?.(); // One validated complete short-field window, never preparation or padding.
          publish(field.index, {
            decodedText,
            tokenOffsets,
            viterbiBiases,
            logits: rows[row]!.logits
          });
        }
      });
    }
    let next = 0;
    const run = async () => {
      while (next < tasks.length) {
        combined.throwIfAborted();
        await tasks[next++]!();
      }
    };
    const running = Array.from(
      { length: Math.min(concurrency, tasks.length) },
      run
    );
    try {
      await Promise.all(running);
    } catch (error) {
      failure.abort();
      await Promise.allSettled(running);
      throw error;
    }
  }
  combined.throwIfAborted();
  if (completed.some((value) => value !== 1))
    throw new ClassificationError("incomplete privacy field results");
  return output;
}
