import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

// Only synchronous read/modify/write work belongs here. Git and API calls run
// outside the lock so Desktop and capture processes can make progress together.
export const withProjectMetadataLock = <T>(
  file: string,
  operation: () => T
): T => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 5_000;
  let release: () => void;
  while (true) {
    try {
      release = lockfile.lockSync(file, { realpath: false, stale: 30_000 });
      break;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ELOCKED" ||
        Date.now() >= deadline
      )
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    release();
  }
};
