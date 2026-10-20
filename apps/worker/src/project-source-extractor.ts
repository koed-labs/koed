import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import mammoth from "mammoth";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";
import {
  PROJECT_SOURCE_MAX_ORIGINAL_BYTES,
  PROJECT_SOURCE_MAX_TEXT_BYTES,
  ProjectSourceExtractionError
} from "./project-source-extraction-contract.js";
export {
  PROJECT_SOURCE_MAX_ORIGINAL_BYTES,
  PROJECT_SOURCE_MAX_TEXT_BYTES,
  ProjectSourceExtractionError
} from "./project-source-extraction-contract.js";
export type { ProjectSourceExtractionFailure } from "./project-source-extraction-contract.js";
const MAX_PDF_PAGES = 1_000;
const MAX_ZIP_ENTRIES = 10_000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

const boundedText = (value: string): string => {
  if (Buffer.byteLength(value, "utf8") > PROJECT_SOURCE_MAX_TEXT_BYTES)
    throw new ProjectSourceExtractionError("too_large");
  // Arbitrary C0 bytes expand sixfold in JSON. Accepted text fits the
  // bounded owner-read response without truncation.
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13)
      throw new ProjectSourceExtractionError("parse_error");
  }
  return value;
};
const nonemptyText = (value: string): string => {
  if (!value.trim()) throw new ProjectSourceExtractionError("parse_error");
  return boundedText(value);
};

// Mammoth handles DOCX XML. This central-directory preflight keeps a small
// compressed upload from expanding into an unbounded archive in that library.
const preflightDocxZip = async (bytes: Buffer): Promise<void> => {
  let position = bytes.length - 22;
  const floor = Math.max(0, bytes.length - 65_557);
  while (position >= floor && bytes.readUInt32LE(position) !== 0x06054b50)
    position--;
  if (position < floor || position + 22 > bytes.length)
    throw new ProjectSourceExtractionError("parse_error");
  const entries = bytes.readUInt16LE(position + 10);
  const directorySize = bytes.readUInt32LE(position + 12);
  const directoryOffset = bytes.readUInt32LE(position + 16);
  if (entries > MAX_ZIP_ENTRIES || directoryOffset + directorySize > position)
    throw new ProjectSourceExtractionError("parse_error");
  let cursor = directoryOffset;
  let expanded = 0;
  let actualExpanded = 0;
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new ProjectSourceExtractionError("parse_error");
    const uncompressed = bytes.readUInt32LE(cursor + 24);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const method = bytes.readUInt16LE(cursor + 10);
    const flags = bytes.readUInt16LE(cursor + 8);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    if (uncompressed === 0xffffffff)
      throw new ProjectSourceExtractionError("too_large");
    expanded += uncompressed;
    if (expanded > MAX_ZIP_UNCOMPRESSED_BYTES)
      throw new ProjectSourceExtractionError("too_large");
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      localOffset + 30 > bytes.length ||
      bytes.readUInt32LE(localOffset) !== 0x04034b50
    )
      throw new ProjectSourceExtractionError("parse_error");
    const payloadStart =
      localOffset +
      30 +
      bytes.readUInt16LE(localOffset + 26) +
      bytes.readUInt16LE(localOffset + 28);
    const payloadEnd = payloadStart + compressed;
    if (payloadEnd > directoryOffset)
      throw new ProjectSourceExtractionError("parse_error");
    let actual = 0;
    if (method === 0) {
      actual = compressed;
    } else {
      try {
        for await (const chunk of Readable.from([
          bytes.subarray(payloadStart, payloadEnd)
        ]).pipe(createInflateRaw())) {
          actual += (chunk as Buffer).length;
          if (actual > MAX_ZIP_UNCOMPRESSED_BYTES)
            throw new ProjectSourceExtractionError("too_large");
        }
      } catch (error) {
        if (error instanceof ProjectSourceExtractionError) throw error;
        throw new ProjectSourceExtractionError("parse_error");
      }
    }
    if (actual !== uncompressed)
      throw new ProjectSourceExtractionError("parse_error");
    actualExpanded += actual;
    if (actualExpanded > MAX_ZIP_UNCOMPRESSED_BYTES)
      throw new ProjectSourceExtractionError("too_large");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (cursor > directoryOffset + directorySize)
      throw new ProjectSourceExtractionError("parse_error");
  }
  if (cursor !== directoryOffset + directorySize)
    throw new ProjectSourceExtractionError("parse_error");
};

export const extractProjectSourceText = async (input: {
  name: string;
  bytes: Buffer;
}): Promise<string> => {
  if (input.bytes.length > PROJECT_SOURCE_MAX_ORIGINAL_BYTES)
    throw new ProjectSourceExtractionError("too_large");
  const lower = input.name.toLowerCase();
  try {
    if (
      lower.endsWith(".md") ||
      lower.endsWith(".markdown") ||
      lower.endsWith(".txt")
    ) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        input.bytes
      );
      if (text.includes("\0"))
        throw new ProjectSourceExtractionError("parse_error");
      return nonemptyText(text);
    }
    if (lower.endsWith(".pdf")) {
      const pdfOptions = {
        data: new Uint8Array(input.bytes),
        isEvalSupported: false,
        useSystemFonts: false,
        disableFontFace: true
      };
      const task = getDocument(pdfOptions);
      try {
        const document = await task.promise;
        if (document.numPages > MAX_PDF_PAGES)
          throw new ProjectSourceExtractionError("too_large");
        const pages: string[] = [];
        let textBytes = 0;
        for (let number = 1; number <= document.numPages; number++) {
          const page = await document.getPage(number);
          const content = await page.getTextContent();
          const parts: string[] = [];
          let pageBytes = 0;
          for (const item of content.items) {
            const part = "str" in item ? item.str : "";
            pageBytes += Buffer.byteLength(part, "utf8") + 1;
            if (textBytes + pageBytes > PROJECT_SOURCE_MAX_TEXT_BYTES)
              throw new ProjectSourceExtractionError("too_large");
            parts.push(part);
          }
          const text = parts.join(" ");
          pages.push(text);
          textBytes += Buffer.byteLength(text, "utf8") + 2;
          if (textBytes > PROJECT_SOURCE_MAX_TEXT_BYTES)
            throw new ProjectSourceExtractionError("too_large");
        }
        const text = pages.join("\n\n").trim();
        if (!text) throw new ProjectSourceExtractionError("no_text_layer");
        return boundedText(text);
      } finally {
        await task.destroy();
      }
    }
    if (lower.endsWith(".docx")) {
      await preflightDocxZip(input.bytes);
      // extractRawText has no options argument. In Mammoth 1.13.0 it calls
      // docxReader.read without options, whose Files default denies external
      // file access; the input is a buffer and carries no filesystem path.
      const result = await mammoth.extractRawText({ buffer: input.bytes });
      return nonemptyText(result.value);
    }
    throw new ProjectSourceExtractionError("unsupported_type");
  } catch (error) {
    if (error instanceof ProjectSourceExtractionError) throw error;
    throw new ProjectSourceExtractionError("parse_error");
  }
};
