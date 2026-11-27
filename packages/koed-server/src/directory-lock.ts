import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

export const acquireDirectoryLock = (path: string): (() => void) => {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw Object.assign(new Error("lock is already held"), { code: "ELOCKED" });
  }

  const ownerPath = join(path, "owner");
  let identity: ReturnType<typeof lstatSync>;
  let token: string;
  try {
    identity = lstatSync(path);
    token = randomUUID();
    writeFileSync(ownerPath, token, { flag: "wx", mode: 0o600 });
  } catch (error) {
    try {
      if (!identity! || !token!)
        throw new Error("lock ownership cannot be verified");
      const current = lstatSync(path);
      if (
        !current.isDirectory() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        readFileSync(ownerPath, "utf8") !== token ||
        readdirSync(path).some((entry) => entry !== "owner")
      )
        throw new Error("lock ownership cannot be verified");
      // Like release, these path-based checks cannot prevent concurrent replacement.
      unlinkSync(ownerPath);
      rmdirSync(path);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${String(error)}; lock initialization failed; manual recovery required for ${path} after verifying ownership`
      );
    }
    throw error;
  }

  const verifyIdentity = () => {
    const current = lstatSync(path);
    if (
      !current.isDirectory() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    ) {
      throw new Error("lock directory ownership lost");
    }
  };
  let released = false;
  return () => {
    if (released) return;
    verifyIdentity();
    if (readFileSync(ownerPath, "utf8") !== token)
      throw new Error("lock directory ownership lost");
    if (readdirSync(path).some((entry) => entry !== "owner"))
      throw new Error("lock directory not empty");

    // Assumes nobody replaces locks while Koed is live. Path-based removal is not
    // atomic with validation; concurrent replacement can still race these checks.
    unlinkSync(ownerPath);
    try {
      rmdirSync(path);
    } catch (error) {
      // Restore ownership only if the original directory is still present.
      try {
        verifyIdentity();
        writeFileSync(ownerPath, token, { flag: "wx", mode: 0o600 });
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `lock removal and ownership restoration failed; manual recovery required for ${path} after verifying ownership`
        );
      }
      throw new Error(
        `${String(error)}; lock remains held; retry release if available, otherwise manual recovery required for ${path} after verifying ownership`,
        { cause: error }
      );
    }
    released = true;
  };
};
