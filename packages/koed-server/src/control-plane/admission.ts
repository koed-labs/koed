import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { KoedServerPaths } from "../paths.js";
import { withLifecycleLock } from "../generation-lifecycle.js";
import {
  acquireKoedServerSupervisorLock,
  readSupervisorLock,
  releaseKoedServerSupervisorLock,
  type KoedServerSupervisorLock,
  type SupervisorLockRecord
} from "../supervisor-lock.js";

export interface ControlPlaneAdmission {
  readonly home: string;
  readonly instanceId: string;
}

type Entry = {
  lock: KoedServerSupervisorLock;
  record: SupervisorLockRecord;
  paths: KoedServerPaths;
};
const admitted = new WeakMap<ControlPlaneAdmission, Entry>();
const activeSessions = new WeakMap<ControlPlaneAdmission, object>();
const uncertainSessions = new WeakSet<ControlPlaneAdmission>();

export function beginControlPlaneSession(
  admission: ControlPlaneAdmission
): object {
  const entry = admitted.get(admission);
  if (!entry) throw new Error("Invalid control-plane admission");
  assertControlPlaneAdmission(admission, entry.paths);
  if (activeSessions.has(admission))
    throw new Error("Control-plane session already active");
  if (uncertainSessions.has(admission))
    throw new Error("Previous control-plane session cleanup is uncertain");
  const session = Object.freeze({});
  activeSessions.set(admission, session);
  return session;
}

export function endControlPlaneSession(
  admission: ControlPlaneAdmission,
  session: object,
  clean: boolean
): void {
  if (activeSessions.get(admission) !== session)
    throw new Error("Invalid or stale control-plane session");
  activeSessions.delete(admission);
  if (!clean) uncertainSessions.add(admission);
}

export function acquireControlPlaneAdmission(
  paths: KoedServerPaths,
  options: {
    requireAbsentLock?: boolean;
    tryReclaimLock?: (fd: number) => boolean;
  } = {}
): ControlPlaneAdmission | null {
  const home = realpathSync(paths.koedHome);
  if (resolve(paths.runDir) !== resolve(paths.koedHome, "run"))
    throw new Error("Control-plane run directory must belong to KOED_HOME");
  const canonicalPaths = {
    ...paths,
    koedHome: home,
    runDir: resolve(home, "run")
  };
  const lock = withLifecycleLock(
    canonicalPaths,
    () =>
      acquireKoedServerSupervisorLock(canonicalPaths, {
        reclaimStale: !options.requireAbsentLock,
        preserveLivePid: true
      }),
    {
      recoverDeadOwner: options.requireAbsentLock
        ? undefined
        : options.tryReclaimLock
    }
  );
  if (!lock.acquired) return null;
  const record = readSupervisorLock(lock.lockPath);
  if (
    !record ||
    record.pid !== process.pid ||
    record.processIdentity !== lock.processIdentity
  ) {
    throw new Error("Cannot verify acquired control-plane admission");
  }
  const admission = Object.freeze({ home, instanceId: randomUUID() });
  admitted.set(admission, { lock, record, paths: canonicalPaths });
  return admission;
}

export function assertControlPlaneAdmission(
  admission: ControlPlaneAdmission,
  paths: KoedServerPaths
): SupervisorLockRecord {
  const entry = admitted.get(admission);
  if (
    !entry ||
    admission.home !== realpathSync(paths.koedHome) ||
    resolve(paths.runDir) !== resolve(paths.koedHome, "run")
  )
    throw new Error("Invalid control-plane admission");
  const actual = readSupervisorLock(entry.lock.lockPath);
  if (
    !actual ||
    actual.pid !== entry.record.pid ||
    actual.processIdentity !== entry.record.processIdentity ||
    actual.acquiredAt !== entry.record.acquiredAt
  )
    throw new Error("Control-plane admission no longer held");
  return actual;
}

export function releaseControlPlaneAdmission(
  admission: ControlPlaneAdmission
): void {
  const entry = admitted.get(admission);
  if (!entry) throw new Error("Invalid control-plane admission");
  if (activeSessions.has(admission))
    throw new Error("Control-plane session already active");
  if (uncertainSessions.has(admission))
    throw new Error("Previous control-plane session cleanup is uncertain");
  withLifecycleLock(entry.paths, () => {
    assertControlPlaneAdmission(admission, entry.paths);
    if (!releaseKoedServerSupervisorLock(entry.lock))
      throw new Error("Could not release control-plane admission");
    admitted.delete(admission);
  });
}
