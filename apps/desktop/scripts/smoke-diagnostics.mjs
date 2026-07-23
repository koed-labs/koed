/* global Buffer */
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  statSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";

export const DIAGNOSTIC_TAIL_BYTES = 64 * 1024;

export const createOwnedDiagnosticsDir = (parentDir) => {
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  return mkdtempSync(resolve(parentDir, "koed-desktop-smoke-"));
};

export const readFileTail = (path, maxBytes = DIAGNOSTIC_TAIL_BYTES) => {
  const size = statSync(path).size;
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(path, "r");
  try {
    readSync(descriptor, buffer, 0, length, size - length);
  } finally {
    closeSync(descriptor);
  }
  return buffer;
};

export const writeDiagnosticTail = (
  source,
  target,
  maxBytes = DIAGNOSTIC_TAIL_BYTES
) => {
  mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(target, readFileTail(source, maxBytes), { mode: 0o600 });
};
