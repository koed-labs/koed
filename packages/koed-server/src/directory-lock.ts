import { mkdirSync, rmSync } from "node:fs";

export const acquireDirectoryLock = (path: string): (() => void) => {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw Object.assign(new Error("lock is already held"), { code: "ELOCKED" });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(path, { recursive: true, force: true });
  };
};
