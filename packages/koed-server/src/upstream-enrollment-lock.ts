import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import properLockfile from "proper-lockfile";
import type { KoedServerPaths } from "./paths.js";

const LOCK_STALE_MS = 30_000;

export const upstreamEnrollmentLockTarget = (
  paths: KoedServerPaths,
  backendId: string
): string => {
  const key = createHash("sha256").update(backendId).digest("hex").slice(0, 24);
  return resolve(paths.runDir, `upstream-enrollment-${key}`);
};

export const withUpstreamEnrollmentLock = async <T>(
  paths: KoedServerPaths,
  backendId: string,
  mutation: () => T | Promise<T>
): Promise<T> => {
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  const release = await properLockfile.lock(
    upstreamEnrollmentLockTarget(paths, backendId),
    {
      realpath: false,
      stale: LOCK_STALE_MS,
      update: LOCK_STALE_MS / 3,
      retries: {
        retries: 100,
        factor: 1,
        minTimeout: 25,
        maxTimeout: 100,
        randomize: true
      }
    }
  );
  try {
    return await mutation();
  } finally {
    await release();
  }
};
