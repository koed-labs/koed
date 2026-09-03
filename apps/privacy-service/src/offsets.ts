import { ClassificationError } from "./errors.js";

export interface TokenOffset {
  startByte: number;
  endByte: number;
}

export const assertValidByteRange = (
  text: string,
  startByte: number,
  endByte: number
): void => {
  const length = Buffer.byteLength(text, "utf8");
  if (
    !Number.isSafeInteger(startByte) ||
    !Number.isSafeInteger(endByte) ||
    startByte < 0 ||
    endByte <= startByte ||
    endByte > length
  ) {
    throw new ClassificationError(
      "privacy runtime emitted an invalid token byte offset"
    );
  }
};

export const expandToUtf8Boundaries = (
  text: string,
  startByte: number,
  endByte: number
): { startByte: number; endByte: number } => {
  assertValidByteRange(text, startByte, endByte);
  const boundaries = [0];
  let byteCursor = 0;
  for (const character of text) {
    byteCursor += Buffer.byteLength(character, "utf8");
    boundaries.push(byteCursor);
  }
  let expandedStart: number | undefined;
  for (const boundary of boundaries) {
    if (boundary > startByte) break;
    expandedStart = boundary;
  }
  const expandedEnd = boundaries.find((boundary) => boundary >= endByte);
  if (expandedStart === undefined || expandedEnd === undefined) {
    throw new ClassificationError(
      "privacy runtime emitted an invalid UTF-8 byte range"
    );
  }
  return { startByte: expandedStart, endByte: expandedEnd };
};

export const assertValidJsRange = (
  text: string,
  start: number,
  end: number
): void => {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > text.length
  ) {
    throw new ClassificationError(
      "privacy runtime emitted an invalid token offset"
    );
  }
  const startsInsideSurrogate =
    start > 0 &&
    /[\uD800-\uDBFF]/.test(text[start - 1] ?? "") &&
    /[\uDC00-\uDFFF]/.test(text[start] ?? "");
  const endsInsideSurrogate =
    end < text.length &&
    /[\uD800-\uDBFF]/.test(text[end - 1] ?? "") &&
    /[\uDC00-\uDFFF]/.test(text[end] ?? "");
  if (startsInsideSurrogate || endsInsideSurrogate) {
    throw new ClassificationError(
      "privacy runtime split a Unicode surrogate pair"
    );
  }
};

export const utf8Offsets = (
  text: string,
  jsStart: number,
  jsEnd: number
): { startByte: number; endByte: number } => {
  assertValidJsRange(text, jsStart, jsEnd);
  return {
    startByte: Buffer.byteLength(text.slice(0, jsStart), "utf8"),
    endByte: Buffer.byteLength(text.slice(0, jsEnd), "utf8")
  };
};

export const createUtf8OffsetLookup = (
  text: string
): ((jsStart: number, jsEnd: number) => TokenOffset) => {
  const byteOffsets: Array<number | undefined> = new Array(text.length + 1);
  byteOffsets[0] = 0;
  let jsCursor = 0;
  let byteCursor = 0;
  for (const character of text) {
    jsCursor += character.length;
    byteCursor += Buffer.byteLength(character, "utf8");
    byteOffsets[jsCursor] = byteCursor;
  }
  return (jsStart, jsEnd) => {
    assertValidJsRange(text, jsStart, jsEnd);
    const startByte = byteOffsets[jsStart];
    const endByte = byteOffsets[jsEnd];
    if (startByte === undefined || endByte === undefined) {
      throw new ClassificationError(
        "privacy runtime emitted an invalid token offset"
      );
    }
    return { startByte, endByte };
  };
};
