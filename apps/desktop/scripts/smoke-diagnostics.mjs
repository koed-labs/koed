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
export const DIAGNOSTIC_WINDOW_BYTES = 64 * 1024;

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

export const readDiagnosticWindow = (
  path,
  maxBytes = DIAGNOSTIC_WINDOW_BYTES
) => {
  const size = statSync(path).size;
  if (size <= maxBytes) {
    return readFileTail(path, maxBytes);
  }
  const headLength = Math.floor(maxBytes / 2);
  const tailLength = maxBytes - headLength;
  const head = Buffer.alloc(headLength);
  const tail = Buffer.alloc(tailLength);
  const descriptor = openSync(path, "r");
  try {
    readSync(descriptor, head, 0, headLength, 0);
    readSync(descriptor, tail, 0, tailLength, size - tailLength);
  } finally {
    closeSync(descriptor);
  }
  return Buffer.concat([
    head,
    Buffer.from(`\n[${size - maxBytes} bytes omitted]\n`),
    tail
  ]);
};

export const writeDiagnosticTail = (
  source,
  target,
  maxBytes = DIAGNOSTIC_TAIL_BYTES
) => {
  mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(target, readFileTail(source, maxBytes), { mode: 0o600 });
};

export const writeDiagnosticWindow = (
  source,
  target,
  maxBytes = DIAGNOSTIC_WINDOW_BYTES
) => {
  mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(target, readDiagnosticWindow(source, maxBytes), {
    mode: 0o600
  });
};
