import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

/** Keep a strong reference to this object throughout protected work, including async work.
 * GC finalization is best effort, is not timely, and cannot report close failures;
 * it cannot guarantee release. Explicitly release while the caller can handle errors.
 * A close error has operation, code, errno and indeterminate=true: ownership may
 * remain held; do not retry or assume release.
 * Later release calls repeat that error. Process termination may be required.
 */
export interface NativeLock {
  release(): void;
}

/** Linux/macOS only. Advisory flock coordinates cooperating processes on the same
 * inode on a filesystem with reliable local flock semantics; network filesystems
 * are not supported. Caller must provide a trusted, stable namespace, including
 * all ancestors, and never unlink or replace a live lock file. This addon does
 * not enforce those assumptions, prevent path replacement, inspect ACLs, or
 * defend against hostile same-UID actors. Final-component checks are snapshots.
 * Syscall errors expose operation, code (errno name or UNKNOWN), and positive errno.
 * If cleanup close fails, the original error is preserved with cleanupCode,
 * cleanupErrno and indeterminate=true. A descriptor or lock may remain held;
 * process termination may be required. No handle is returned for that descriptor.
 */
export interface NativeFlock {
  tryAcquire(path: string): NativeLock | null;
}

/** Load an explicitly selected native binary; runtime layout is decided by the caller. */
export function loadNativeFlock(binaryPath: string): NativeFlock {
  if (!isAbsolute(binaryPath) || binaryPath.includes("\0")) {
    throw new Error("Native flock binary path must be absolute");
  }
  const addon: unknown = createRequire(import.meta.url)(binaryPath);
  if (
    !addon ||
    typeof addon !== "object" ||
    !("tryAcquire" in addon) ||
    typeof addon.tryAcquire !== "function"
  ) {
    throw new Error("Invalid native flock addon");
  }
  return addon as NativeFlock;
}
