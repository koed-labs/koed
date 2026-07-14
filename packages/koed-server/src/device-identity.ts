import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
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
}

const defaultProof = (): string => randomBytes(32).toString("base64url");

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
                KOED_DEVICE_PROOF_DIR: resolve(`${paths.koedHome}-proof`)
              }
            : environment
      }),
    now: deps.now ?? (() => new Date()),
    randomId: deps.randomId ?? randomUUID,
    randomProof: deps.randomProof ?? defaultProof
  };
};

const lockTarget = (paths: KoedServerPaths): string =>
  resolve(paths.runDir, "device-identity");

const initializedMarkerPath = (paths: KoedServerPaths): string =>
  resolve(paths.runDir, "device-identity-initialized.json");

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

const writeInitializedMarker = (
  paths: KoedServerPaths,
  state: DeviceIdentityState
): void => {
  const markerPath = initializedMarkerPath(paths);
  const temporary = `${markerPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify({ schemaVersion: 1, initializedAt: state.updatedAt })}\n`,
      { mode: 0o600, flag: "wx" }
    );
    renameSync(temporary, markerPath);
  } finally {
    rmSync(temporary, { force: true });
  }
};

const newIdentityState = (
  now: Date,
  randomId: () => string,
  randomProof: () => string,
  remoteOperations: DeviceIdentityState["remoteOperations"]
): { state: DeviceIdentityState; proof: string } => {
  const deploymentId = randomId();
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
 * First boot initializes only before this KOED_HOME has recorded identity
 * state. Later missing state is a repair condition, never regeneration.
 */
export const ensureDeviceIdentity = async (
  paths: KoedServerPaths,
  deps: DeviceIdentityDependencies = {}
): Promise<DeviceIdentityResult> => {
  const resolved = dependencies(paths, deps);
  return withDeviceIdentityLock(paths, () => {
    const current = inspect(paths, resolved.proofStore);
    if (current.health !== "missing_state") return result(current);
    if (existsSync(initializedMarkerPath(paths))) return result(current);

    const next = newIdentityState(
      resolved.now(),
      resolved.randomId,
      resolved.randomProof,
      "enabled"
    );
    try {
      resolved.proofStore.write(
        next.state.proof.reference,
        serializeHostProof({
          deploymentId: next.state.deploymentId,
          deviceInstanceId: next.state.deviceInstanceId,
          proof: next.proof
        })
      );
      writeState(deviceIdentityStatePathFor(paths.koedHome), next.state);
      writeInitializedMarker(paths, next.state);
      return result(inspect(paths, resolved.proofStore), { initialized: true });
    } catch {
      return result(inspect(paths, resolved.proofStore));
    }
  });
};

export const rotateDeviceIdentity = async (
  paths: KoedServerPaths,
  options: {
    invalidateRemoteReferences: () => Promise<void> | void;
    dependencies?: DeviceIdentityDependencies;
  }
): Promise<DeviceIdentityResult> => {
  const resolved = dependencies(paths, options.dependencies ?? {});
  return withDeviceIdentityLock(paths, async () => {
    const previous = inspect(paths, resolved.proofStore);
    const previousReference = previous.deviceInstanceId
      ? hostProofReferenceFor(previous.deviceInstanceId)
      : null;
    const next = newIdentityState(
      resolved.now(),
      resolved.randomId,
      resolved.randomProof,
      "repair_required"
    );
    try {
      resolved.proofStore.write(
        next.state.proof.reference,
        serializeHostProof({
          deploymentId: next.state.deploymentId,
          deviceInstanceId: next.state.deviceInstanceId,
          proof: next.proof
        })
      );
      writeState(deviceIdentityStatePathFor(paths.koedHome), next.state);
      writeInitializedMarker(paths, next.state);
    } catch {
      return result(inspect(paths, resolved.proofStore), { rotated: false });
    }

    try {
      await options.invalidateRemoteReferences();
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
