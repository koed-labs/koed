import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";

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
