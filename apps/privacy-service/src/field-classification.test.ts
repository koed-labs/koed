import { describe, expect, it, vi } from "vitest";
import {
  classifyRequestFields,
  type PreparedPrivacyField
} from "./field-classification.js";
import { ZERO_VITERBI_BIASES } from "./decoder.js";
import type { PrivacyBatchInput } from "./inference-contract.js";

const prepare = async (text: string): Promise<PreparedPrivacyField> => ({
  decodedText: text,
  tokenIds: [...text].map((char) => char.charCodeAt(0)),
  tokenOffsets: [...text].map((_char, index) => ({
    startByte: index,
    endByte: index + 1
  })),
  viterbiBiases: ZERO_VITERBI_BIASES
});
const logits = (ids: readonly number[]) => ids.map((id) => Array(33).fill(id));
const classify = async ({ tokenIds, ...raw }: PreparedPrivacyField) => ({
  ...raw,
  logits: logits(tokenIds)
});
const batch = async (rows: readonly PrivacyBatchInput[]) =>
  rows.map((row) => ({ id: row.id, logits: logits(row.tokenIds) })).reverse();

describe("request-local short-field batches", () => {
  it("streams validated fields to the consumer without retaining whole-request raw output", async () => {
    const consume = vi.fn();
    const result = await classifyRequestFields(
      ["A", "BB", "CCC"],
      { prepare, classify, batch },
      2,
      undefined,
      undefined,
      consume
    );
    expect(result).toEqual([]);
    expect(consume.mock.calls.map(([index]) => index).sort()).toEqual([
      0, 1, 2
    ]);
  });
  it("groups bounded ready fields by length, keeps long fields complete and restores exact input order", async () => {
    const texts = [1, 30, 32, 33, 64, 65, 128, 255, 256, 257, 600, 3].map(
      (length, index) => String.fromCharCode(65 + index).repeat(length)
    );
    const dispatch = vi.fn(batch),
      long = vi.fn(classify),
      progress = vi.fn();
    const result = await classifyRequestFields(
      texts,
      { prepare, classify: long, batch: dispatch },
      2,
      undefined,
      progress
    );
    expect(result.map((field) => field.decodedText)).toEqual(texts);
    result.forEach((field, index) =>
      expect(field.logits).toEqual(
        logits([...texts[index]!].map((char) => char.charCodeAt(0)))
      )
    );
    expect(long).toHaveBeenCalledTimes(2);
    for (const [rows] of dispatch.mock.calls) {
      expect(rows.length).toBeLessThanOrEqual(8);
      expect(
        Math.max(...rows.map((row) => row.tokenIds.length)) * rows.length
      ).toBeLessThanOrEqual(2048);
      expect(rows.every((row) => row.tokenIds.length <= 256)).toBe(true);
    }
    expect(progress).toHaveBeenCalledTimes(10); // Two long fields use the existing window callback instead.
  });

  it("dispatches an underfilled ready batch immediately without a fill timer", async () => {
    let dispatched!: () => void;
    const started = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    let finish!: () => void;
    const work = classifyRequestFields(
      ["A"],
      {
        prepare,
        classify,
        batch: async (rows) => {
          expect(rows).toHaveLength(1);
          dispatched();
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return batch(rows);
        }
      },
      1
    );
    await started;
    finish();
    expect((await work)[0]!.decodedText).toBe("A");
  });

  it("rejects incomplete field mapping and cancels the whole request without returning successful rows", async () => {
    await expect(
      classifyRequestFields(
        ["A", "B"],
        {
          prepare,
          classify,
          batch: async (rows) => (await batch(rows)).slice(1)
        },
        1
      )
    ).rejects.toThrow("batch output");
    const cancellation = new AbortController();
    let dispatched!: () => void;
    const started = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const work = classifyRequestFields(
      ["A", "B"],
      {
        prepare,
        classify,
        batch: async (_rows, signal) => {
          dispatched();
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true
            })
          );
          return [];
        }
      },
      1,
      cancellation.signal
    );
    await started;
    cancellation.abort();
    await expect(work).rejects.toMatchObject({ name: "AbortError" });
  });
});
