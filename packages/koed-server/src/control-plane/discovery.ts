import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { KoedServerPaths } from "../paths.js";
import {
  assertControlPlaneAdmission,
  type ControlPlaneAdmission
} from "./admission.js";

const id = z.string().min(1).max(256);
const discoverySchema = z.strictObject({
  schemaVersion: z.literal(1),
  home: z.string().min(1).max(4096),
  instanceId: id,
  installationId: id,
  productVersion: id,
  socketPath: z.string().min(1).max(4096),
  pid: z.number().int().positive().safe(),
  processIdentity: id
});
export type ControlDiscovery = z.infer<typeof discoverySchema>;

function assertPrivateRunDirectory(paths: KoedServerPaths): void {
  const stats = lstatSync(paths.runDir);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stats.uid !== process.getuid())
  )
    throw new Error("Control discovery directory is not private");
}
function parseDiscovery(
  paths: KoedServerPaths,
  value: unknown
): ControlDiscovery {
  const record = discoverySchema.parse(value);
  if (record.home !== realpathSync(paths.koedHome))
    throw new Error("Control discovery home mismatch");
  if (
    !isAbsolute(record.socketPath) ||
    record.socketPath.includes("\0") ||
    Buffer.byteLength(record.socketPath) > 103
  )
    throw new Error("Invalid control socket path");
  return record;
}
function discoveryPath(paths: KoedServerPaths): string {
  return resolve(paths.runDir, "control-plane.json");
}

export function readControlDiscovery(
  paths: KoedServerPaths
): ControlDiscovery | undefined {
  try {
    assertPrivateRunDirectory(paths);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let fd: number;
  try {
    fd = openSync(
      discoveryPath(paths),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o077) !== 0 ||
      stats.size > 16384 ||
      (typeof process.getuid === "function" && stats.uid !== process.getuid())
    )
      throw new Error("Control discovery file is not private");
    return parseDiscovery(paths, JSON.parse(readFileSync(fd, "utf8")));
  } finally {
    closeSync(fd);
  }
}

export function reconcileStaleControlDiscovery(
  paths: KoedServerPaths,
  admission: ControlPlaneAdmission,
  socketPath: string
): void {
  assertControlPlaneAdmission(admission, paths);
  assertPrivateRunDirectory(paths);
  const record = readControlDiscovery(paths);
  if (!record) return;
  if (
    socketPath !== resolve(paths.runDir, "control.sock") ||
    record.socketPath !== socketPath
  )
    throw new Error("Stale control socket path mismatch");
  try {
    process.kill(record.pid, 0);
    throw new Error("Control discovery owner may still be running");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  // The prior endpoint may still be held open; only its routing metadata is removed.
  assertControlPlaneAdmission(admission, paths);
  if (JSON.stringify(readControlDiscovery(paths)) !== JSON.stringify(record))
    throw new Error("Control discovery changed during reconciliation");
  unlinkSync(discoveryPath(paths));
}

export function publishControlDiscovery(
  paths: KoedServerPaths,
  admission: ControlPlaneAdmission,
  value: ControlDiscovery
): void {
  const owner = assertControlPlaneAdmission(admission, paths);
  assertPrivateRunDirectory(paths);
  const record = parseDiscovery(paths, value);
  if (
    record.instanceId !== admission.instanceId ||
    record.pid !== owner.pid ||
    !owner.processIdentity ||
    record.processIdentity !== owner.processIdentity
  )
    throw new Error("Control discovery does not match admission");
  const existing = readControlDiscovery(paths);
  if (existing) {
    try {
      process.kill(existing.pid, 0);
      throw new Error(
        "Existing control-plane discovery owner may still be running"
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    // This removes routing metadata only; it does not establish runtime cleanup.
    unlinkSync(discoveryPath(paths));
  }
  const temporary = resolve(
    paths.runDir,
    `.control-discovery-${randomUUID()}.tmp`
  );
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, discoveryPath(paths));
  } finally {
    unlinkSync(temporary);
  }
}

export function removeControlDiscovery(
  paths: KoedServerPaths,
  admission: ControlPlaneAdmission,
  instanceId: string
): void {
  const owner = assertControlPlaneAdmission(admission, paths);
  const record = readControlDiscovery(paths);
  if (
    !record ||
    instanceId !== admission.instanceId ||
    record.instanceId !== admission.instanceId ||
    record.pid !== owner.pid ||
    !owner.processIdentity ||
    record.processIdentity !== owner.processIdentity
  )
    throw new Error("Control discovery instance mismatch");
  unlinkSync(discoveryPath(paths));
}
