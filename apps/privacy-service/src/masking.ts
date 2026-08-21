import { decodeBioesViterbi } from "./decoder.js";
import { ClassificationError } from "./errors.js";
import {
  parseTokenLabel,
  placeholderFor,
  type PrivacyLabel,
  type TokenLabel
} from "./labels.js";
import {
  assertValidByteRange,
  expandToUtf8Boundaries,
  type TokenOffset
} from "./offsets.js";
import { detectDeterministicSecrets } from "./secrets.js";
import type { RawPrivacyClassification } from "./runtime.js";

interface CandidateSpan {
  label: PrivacyLabel;
  start: number;
  end: number;
  sources: Set<"model" | "deterministic">;
}

export interface MaskedClassification {
  maskedText: string;
  spans: PrivacyDetectedSpan[];
}

const modelSpans = (
  text: string,
  labels: readonly TokenLabel[],
  offsets: readonly TokenOffset[]
): CandidateSpan[] => {
  const spans: CandidateSpan[] = [];
  for (let index = 0; index < labels.length; index += 1) {
    const parsed = parseTokenLabel(labels[index] as TokenLabel);
    if (parsed === null) continue;
    if (parsed.tag === "S") {
      const offset = offsets[index];
      if (!offset)
        throw new ClassificationError("privacy token offset is missing");
      assertValidByteRange(text, offset.startByte, offset.endByte);
      spans.push({
        label: parsed.label,
        start: offset.startByte,
        end: offset.endByte,
        sources: new Set(["model"])
      });
      continue;
    }
    if (parsed.tag !== "B") continue;
    let endIndex = index + 1;
    while (endIndex < labels.length) {
      const next = parseTokenLabel(labels[endIndex] as TokenLabel);
      if (next === null || next.label !== parsed.label) break;
      if (next.tag === "E") {
        const startOffset = offsets[index];
        const endOffset = offsets[endIndex];
        if (!startOffset || !endOffset) {
          throw new ClassificationError("privacy token offset is missing");
        }
        assertValidByteRange(text, startOffset.startByte, endOffset.endByte);
        spans.push({
          label: parsed.label,
          start: startOffset.startByte,
          end: endOffset.endByte,
          sources: new Set(["model"])
        });
        index = endIndex;
        break;
      }
      endIndex += 1;
    }
  }
  return spans;
};

const unionSpans = (candidates: CandidateSpan[]): CandidateSpan[] => {
  const sorted = [...candidates].sort(
    (left, right) => left.start - right.start || left.end - right.end
  );
  const output: CandidateSpan[] = [];
  for (const candidate of sorted) {
    const previous = output[output.length - 1];
    if (!previous || candidate.start >= previous.end) {
      output.push({ ...candidate, sources: new Set(candidate.sources) });
      continue;
    }
    previous.end = Math.max(previous.end, candidate.end);
    if (candidate.label === "secret") previous.label = "secret";
    for (const source of candidate.sources) previous.sources.add(source);
  }
  return output;
};

const detectorNames = (
  sources: Set<"model" | "deterministic">
): Array<"privacy_filter" | "deterministic"> => [
  ...(sources.has("model") ? (["privacy_filter"] as const) : []),
  ...(sources.has("deterministic") ? (["deterministic"] as const) : [])
];

export const maskClassification = (
  text: string,
  raw: RawPrivacyClassification
): MaskedClassification => {
  if (raw.decodedText !== text) {
    throw new ClassificationError(
      "privacy tokenizer decoded text does not exactly match the request"
    );
  }
  if (raw.logits.length !== raw.tokenOffsets.length) {
    throw new ClassificationError(
      "privacy runtime token, offset, and logits lengths do not match"
    );
  }
  let previousEnd = 0;
  for (const offset of raw.tokenOffsets) {
    assertValidByteRange(text, offset.startByte, offset.endByte);
    if (offset.startByte !== previousEnd) {
      throw new ClassificationError(
        "privacy runtime token offsets do not exactly cover the request"
      );
    }
    previousEnd = offset.endByte;
  }
  if (previousEnd !== Buffer.byteLength(text, "utf8")) {
    throw new ClassificationError(
      "privacy runtime token offsets do not exactly cover the request"
    );
  }

  const labels = decodeBioesViterbi(raw.logits, raw.viterbiBiases);
  const candidates = modelSpans(text, labels, raw.tokenOffsets).map((span) => ({
    ...span,
    ...(() => {
      const expanded = expandToUtf8Boundaries(text, span.start, span.end);
      return { start: expanded.startByte, end: expanded.endByte };
    })()
  }));
  candidates.push(
    ...detectDeterministicSecrets(text).map(({ start, end }) => {
      const bytes = Buffer.from(text, "utf8");
      const startByte = Buffer.byteLength(text.slice(0, start), "utf8");
      const endByte = Buffer.byteLength(text.slice(0, end), "utf8");
      if (endByte > bytes.length) {
        throw new ClassificationError(
          "deterministic privacy detector emitted an invalid byte range"
        );
      }
      return {
        label: "secret" as const,
        start: startByte,
        end: endByte,
        sources: new Set<"deterministic">(["deterministic"])
      };
    })
  );
  const union = unionSpans(candidates);
  const spans = union.map(
    (span): PrivacyDetectedSpan => ({
      label: span.label,
      detectors: detectorNames(span.sources),
      startByte: span.start,
      endByte: span.end
    })
  );

  const source = Buffer.from(text, "utf8");
  const output: Buffer[] = [];
  let cursor = 0;
  for (const span of union) {
    output.push(
      source.subarray(cursor, span.start),
      Buffer.from(placeholderFor(span.label), "utf8")
    );
    cursor = span.end;
  }
  output.push(source.subarray(cursor));
  return { maskedText: Buffer.concat(output).toString("utf8"), spans };
};
import type { PrivacyDetectedSpan } from "@koed/shared";
