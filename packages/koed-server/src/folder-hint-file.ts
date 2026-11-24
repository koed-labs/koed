import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const folderHintFileMissing = Symbol("Folder hint file missing");

/** Bound bytes at the read, not just at stat: the file can grow in between. */
export const inspectFolderHintFile = async (
  path: string,
  maxBytes: number,
  budget?: { remaining: number }
): Promise<string | null | typeof folderHintFileMissing> => {
  try {
    const file = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0)
    ).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    });
    if (!file) return folderHintFileMissing;
    try {
      const stat = await file.stat();
      const limit = Math.min(maxBytes, budget?.remaining ?? maxBytes);
      if (!stat.isFile() || stat.size > limit) return null;
      // Detect growth with one extra byte when the budget permits it.
      const capacity = Math.min(stat.size + 1, limit);
      const buffer = Buffer.allocUnsafe(capacity);
      let offset = 0;
      while (offset < capacity) {
        const { bytesRead } = await file.read(
          buffer,
          offset,
          capacity - offset,
          offset
        );
        if (bytesRead === 0) return buffer.toString("utf8", 0, offset);
        offset += bytesRead;
        if (budget) budget.remaining -= bytesRead;
      }
      return capacity === stat.size && (await file.stat()).size === stat.size
        ? buffer.toString("utf8")
        : null;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
};

export const readFolderHintFile = async (
  path: string,
  maxBytes: number,
  budget?: { remaining: number }
): Promise<string | null> => {
  const result = await inspectFolderHintFile(path, maxBytes, budget);
  return typeof result === "string" ? result : null;
};
