import { readSync } from "node:fs";

// Read at most one byte beyond the limit even if the file grows after fstat.
export const readBoundedUtf8 = (descriptor: number, limit: number): string => {
  const buffer = Buffer.allocUnsafe(limit + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
      null
    );
    if (count === 0) break;
    offset += count;
  }
  if (offset > limit) throw new Error("File is too large to inspect safely.");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    buffer.subarray(0, offset)
  );
};
