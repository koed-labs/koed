import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import properLockfile from "proper-lockfile";
import {
  createPlatformHostProofStore,
  deviceIdentityStatePathFor,
  deviceProofFingerprint,
  hostProofReferenceFor,
  inspectDeviceIdentity,
  serializeHostProof,
  type DeviceIdentityInspection,
  type DeviceIdentityState,
  type HostProofStore
} from "@koed/shared";
import type { KoedServerPaths } from "./paths.js";

const lockStaleMs = 30_000;

export interface DeviceIdentityResult extends DeviceIdentityInspection {
  initialized: boolean;
  rotated: boolean;
  referencesInvalidated?: boolean;
}

export interface DeviceIdentityDependencies {
  proofStore?: HostProofStore;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  randomId?: () => string;
  randomProof?: () => string;
  /** Test-only fault injection after durable mutation phases. */
  onPhase?: (phase: "tombstone" | "proof" | "state") => void;
}

const defaultProof = (): string => randomBytes(32).toString("base64url");

const testProofDirectory = (paths: KoedServerPaths): string => {
  const proofRoot = resolve(`${paths.koedHome}-proof-root`);
  mkdirSync(proofRoot, { recursive: true, mode: 0o700 });
  return resolve(proofRoot, "proof");
};

const dependencies = (
  paths: KoedServerPaths,
  deps: DeviceIdentityDependencies
): Required<DeviceIdentityDependencies> => {
  const environment = deps.environment ?? process.env;
  return {
    environment,
    proofStore:
      deps.proofStore ??
      createPlatformHostProofStore({
        koedHome: paths.koedHome,
        environment:
          environment.NODE_ENV === "test"
            ? {
                ...environment,
                KOED_DEVICE_PROOF_DIR: testProofDirectory(paths)
              }
            : environment
      }),
    now: deps.now ?? (() => new Date()),
    randomId: deps.randomId ?? randomUUID,
    randomProof: deps.randomProof ?? defaultProof,
    onPhase: deps.onPhase ?? (() => undefined)
  };
};

const lockTarget = (paths: KoedServerPaths): string =>
  resolve(paths.runDir, "device-identity");

const bootstrapTombstonePath = (paths: KoedServerPaths): string =>
  resolve(paths.configDir, "device-identity-bootstrap.json");

const withDeviceIdentityLock = async <T>(
  paths: KoedServerPaths,
  mutation: () => T | Promise<T>
): Promise<T> => {
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  const release = await properLockfile.lock(lockTarget(paths), {
    realpath: false,
    stale: lockStaleMs,
    update: lockStaleMs / 3,
    retries: {
      retries: 100,
      factor: 1,
      minTimeout: 25,
      maxTimeout: 100,
      randomize: true
    }
  });
  try {
    return await mutation();
  } finally {
    await release();
  }
};

const writeState = (statePath: string, state: DeviceIdentityState): void => {
  mkdirSync(resolve(statePath, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx"
    });
    renameSync(temporary, statePath);
  } finally {
    rmSync(temporary, { force: true });
  }
};

const prepareIdentityStorage = (paths: KoedServerPaths): string => {
  mkdirSync(paths.koedHome, { recursive: true, mode: 0o700 });
  if (lstatSync(paths.koedHome).isSymbolicLink()) {
    throw new Error("KOED_HOME must not be a symbolic link.");
  }
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  if (lstatSync(paths.configDir).isSymbolicLink()) {
    throw new Error(
      "Device identity config directory must not be a symbolic link."
    );
  }
  return realpathSync(paths.koedHome);
};

const writeBootstrapTombstone = (paths: KoedServerPaths, now: Date): void => {
  const tombstonePath = bootstrapTombstonePath(paths);
  if (existsSync(tombstonePath)) return;
  const temporary = `${tombstonePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify({ schemaVersion: 1, initializedAt: now.toISOString() })}\n`,
      { mode: 0o600, flag: "wx" }
    );
    renameSync(temporary, tombstonePath);
  } finally {
    rmSync(temporary, { force: true });
  }
};

const newIdentityState = (
  now: Date,
  randomId: () => string,
  randomProof: () => string,
  remoteOperations: DeviceIdentityState["remoteOperations"],
  deploymentId = randomId(),
  pendingRemoteRevocation = false
): { state: DeviceIdentityState; proof: string } => {
  const deviceInstanceId = randomId();
  const proof = randomProof();
  const timestamp = now.toISOString();
  return {
    state: {
      schemaVersion: 1,
      deploymentId,
      deviceInstanceId,
      proof: {
        reference: hostProofReferenceFor(deviceInstanceId),
        fingerprint: deviceProofFingerprint(proof)
      },
      remoteOperations,
      deploymentIdentityAdoptionPending: true,
      ...(pendingRemoteRevocation ? { pendingRemoteRevocation: true } : {}),
      createdAt: timestamp,
      updatedAt: timestamp
    },
    proof
  };
};

const result = (
  identity: DeviceIdentityInspection,
  options: {
    initialized?: boolean;
    rotated?: boolean;
    referencesInvalidated?: boolean;
  } = {}
): DeviceIdentityResult => ({
  ...identity,
  initialized: options.initialized ?? false,
  rotated: options.rotated ?? false,
  ...(options.referencesInvalidated === undefined
    ? {}
    : { referencesInvalidated: options.referencesInvalidated })
});

const inspect = (
  paths: KoedServerPaths,
  proofStore: HostProofStore
): DeviceIdentityInspection =>
  inspectDeviceIdentity({
    statePath: deviceIdentityStatePathFor(paths.koedHome),
    proofStore
  });

/**
 * Reports the current identity without acquiring the initialization/rotation
 * lock. Status polling must remain read-only so a timed-out diagnostic process
 * cannot leave a stale lock that aborts the managed service supervisor.
 */
export const inspectDeviceIdentityStatus = (
  paths: KoedServerPaths,
  deps: DeviceIdentityDependencies = {}
): Promise<DeviceIdentityResult> => {
  const resolved = dependencies(paths, deps);
  return Promise.resolve(result(inspect(paths, resolved.proofStore)));
};

/**
 * First boot initializes only before this KOED_HOME has recorded identity
 * state. Later missing state is a repair condition, never regeneration.
 */
export const ensureDeviceIdentity = async (
  paths: KoedServerPaths,
  deps: DeviceIdentityDependencies = {}
): Promise<DeviceIdentityResult> => {
  const resolved = dependencies(paths, deps);
  return withDeviceIdentityLock(paths, () => {
    try {
      const canonicalKoedHome = prepareIdentityStorage(paths);
      const current = inspect(paths, resolved.proofStore);
      if (current.health !== "missing_state") return result(current);
      if (existsSync(bootstrapTombstonePath(paths))) return result(current);

      writeBootstrapTombstone(paths, resolved.now());
      resolved.onPhase("tombstone");
      const next = newIdentityState(
        resolved.now(),
        resolved.randomId,
        resolved.randomProof,
        "repair_required"
      );
      resolved.proofStore.write(
        next.state.proof.reference,
        serializeHostProof({
          deploymentId: next.state.deploymentId,
          deviceInstanceId: next.state.deviceInstanceId,
          proof: next.proof,
          canonicalKoedHome
        })
      );
      resolved.onPhase("proof");
      writeState(deviceIdentityStatePathFor(paths.koedHome), next.state);
      resolved.onPhase("state");
      writeState(deviceIdentityStatePathFor(paths.koedHome), {
        ...next.state,
        remoteOperations: "enabled",
        updatedAt: resolved.now().toISOString()
      });
      return result(inspect(paths, resolved.proofStore), { initialized: true });
    } catch {
      return result(inspect(paths, resolved.proofStore));
    }
  });
};

export const rotateDeviceIdentity = async (
  paths: KoedServerPaths,
  options: {
    invalidateRemoteReferences: () =>
      | Promise<{ pendingRemoteRevocation?: boolean } | void>
      | { pendingRemoteRevocation?: boolean }
      | void;
    dependencies?: DeviceIdentityDependencies;
  }
): Promise<DeviceIdentityResult> => {
  const resolved = dependencies(paths, options.dependencies ?? {});
  return withDeviceIdentityLock(paths, async () => {
    let canonicalKoedHome: string;
    try {
      canonicalKoedHome = prepareIdentityStorage(paths);
    } catch {
      return result(inspect(paths, resolved.proofStore), { rotated: false });
    }
    const previous = inspect(paths, resolved.proofStore);
    const previousReference = previous.deviceInstanceId
      ? hostProofReferenceFor(previous.deviceInstanceId)
      : null;
    const next = newIdentityState(
      resolved.now(),
      resolved.randomId,
      resolved.randomProof,
      "repair_required",
      previous.deploymentId ?? undefined,
      true
    );
    delete next.state.deploymentIdentityAdoptionPending;
    try {
      writeBootstrapTombstone(paths, resolved.now());
      resolved.proofStore.write(
        next.state.proof.reference,
        serializeHostProof({
          deploymentId: next.state.deploymentId,
          deviceInstanceId: next.state.deviceInstanceId,
          proof: next.proof,
          canonicalKoedHome
        })
      );
      writeState(deviceIdentityStatePathFor(paths.koedHome), next.state);
    } catch {
      return result(inspect(paths, resolved.proofStore), { rotated: false });
    }

    try {
      const invalidation = await options.invalidateRemoteReferences();
      if (invalidation?.pendingRemoteRevocation) {
        return result(inspect(paths, resolved.proofStore), {
          rotated: true,
          referencesInvalidated: false
        });
      }
    } catch {
      return result(inspect(paths, resolved.proofStore), {
        rotated: true,
        referencesInvalidated: false
      });
    }

    const completed: DeviceIdentityState = {
      ...next.state,
      remoteOperations: "enabled",
      updatedAt: resolved.now().toISOString()
    };
    delete completed.pendingRemoteRevocation;
    try {
      writeState(deviceIdentityStatePathFor(paths.koedHome), completed);
      if (
        previousReference &&
        previousReference !== completed.proof.reference
      ) {
        resolved.proofStore.remove(previousReference);
      }
      return result(inspect(paths, resolved.proofStore), {
        rotated: true,
        referencesInvalidated: true
      });
    } catch {
      return result(inspect(paths, resolved.proofStore), {
        rotated: true,
        referencesInvalidated: false
      });
    }
  });
};

export const deviceIdentityLockTarget = lockTarget;
