// Advisory lock: all same-user participants must use this primitive and must not
// rename, replace, or unlink the directory, its ancestors, or the lock file.
// It cannot fence hostile same-user filesystem changes or surviving children.
// Keep the returned handle reachable and release it only after runtime shutdown;
// a lost handle intentionally stays locked until its Node environment exits.
export interface OwnershipLockAddon {
  tryAcquireOwnershipLock(directory: string): number | null;
  releaseOwnershipLock(handle: number): void;
}

export const tryAcquireOwnershipLock = (
  addon: OwnershipLockAddon,
  directory: string
): { release(): void } | null => {
  const handle = addon.tryAcquireOwnershipLock(directory);
  if (handle === null) return null;
  let state: "held" | "released" | "indeterminate" = "held";
  return {
    release() {
      if (state === "released") return;
      if (state === "indeterminate")
        throw new Error("Ownership lock release result is indeterminate.");
      state = "indeterminate";
      addon.releaseOwnershipLock(handle);
      state = "released";
    }
  };
};
