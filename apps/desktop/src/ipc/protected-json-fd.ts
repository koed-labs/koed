import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";

const legacyProtectedFdFilePattern =
  /^pds-(?:ipc|recovery-code)-([0-9]+)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

/** Remove only files created by pre-unlink protected-FD implementations. */
export const cleanupLegacyProtectedFdFiles = (directory: string): number => {
  let entries;
  try {
    entries = readdirSync(resolve(directory), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    const match = legacyProtectedFdFilePattern.exec(entry.name);
    if (
      !entry.isFile() ||
      !match ||
      isProcessAlive(Number.parseInt(match[1]!, 10))
    ) {
      continue;
    }
    try {
      unlinkSync(resolve(directory, entry.name));
      removed += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
};

export const withProtectedTextFd = async <T>(
  directory: string,
  prefix: string,
  value: string,
  operation: (fd: number) => Promise<T>
): Promise<T> => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, `${prefix}-${process.pid}-${randomUUID()}`);
  let fd: number | null = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, value, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = openSync(path, "r");
    // Keep payload available through descriptor, never through filesystem path.
    unlinkSync(path);
    return await operation(fd);
  } finally {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      // A closed descriptor and removed private file leave no readable payload.
    }
  }
};

export const withProtectedJsonFd = async <T>(
  directory: string,
  prefix: string,
  payload: Record<string, unknown>,
  operation: (fd: number) => Promise<T>
): Promise<T> =>
  await withProtectedTextFd(
    directory,
    prefix,
    JSON.stringify(payload),
    operation
  );
