import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir, platform as nodePlatform } from "node:os";
import { dirname, relative, resolve } from "node:path";

export const deviceIdentitySchemaVersion = 1;

export type DeviceIdentityHealth =
  | "healthy"
  | "missing_state"
  | "malformed_state"
  | "unsafe_state_permissions"
  | "missing_proof"
  | "malformed_proof"
  | "proof_mismatch"
  | "unsafe_proof_permissions"
  | "unsafe_proof_storage"
  | "repair_required";

export interface DeviceIdentityState {
  schemaVersion: 1;
  deploymentId: string;
  deviceInstanceId: string;
  proof: {
    reference: string;
    fingerprint: string;
  };
  remoteOperations: "enabled" | "repair_required";
  createdAt: string;
  updatedAt: string;
}

export interface DeviceIdentityInspection {
  health: DeviceIdentityHealth;
  deploymentId: string | null;
  deviceInstanceId: string | null;
  remoteOperationsAllowed: boolean;
  message: string;
  action?: string;
  platformProtection: "verified" | "limited";
}

export interface HostProofReadResult {
  state: "present" | "missing" | "malformed" | "unsafe_permissions";
  value?: string;
}

/**
 * Separate host-bound proof storage. This is intentionally not an upstream
 * credential store, API Token store, or OS-keychain claim.
 */
export interface HostProofStore {
  read(reference: string): HostProofReadResult;
  write(reference: string, value: string): void;
  remove(reference: string): void;
  hasStoredProofs(): boolean;
}

export const hostProofReferenceFor = (deviceInstanceId: string): string =>
  `host-proof://koed/device-identity/${deviceInstanceId}`;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fingerprintPattern = /^[a-f0-9]{64}$/;
const proofPattern = /^[A-Za-z0-9_-]{43}$/;

const isPosix = (platform: NodeJS.Platform): boolean => platform !== "win32";

const isUnsafe = (
  path: string,
  platform: NodeJS.Platform,
  lstat: typeof lstatSync = lstatSync,
  stat: typeof statSync = statSync
): boolean => {
  if (!isPosix(platform)) return false;
  try {
    const link = lstat(path);
    if (link.isSymbolicLink()) return true;
    const metadata = stat(path);
    const getuid = process.getuid;
    return (
      (!metadata.isFile() && !metadata.isDirectory()) ||
      (metadata.mode & 0o077) !== 0 ||
      (typeof getuid === "function" && metadata.uid !== getuid())
    );
  } catch {
    return true;
  }
};

const isPathInside = (path: string, parent: string): boolean => {
  const relativePath = relative(resolve(parent), resolve(path));
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !relativePath.includes("../"))
  );
};

const proofFileName = (reference: string): string =>
  `${createHash("sha256").update(reference).digest("hex")}.json`;

const validReference = (reference: string): boolean => {
  const match = /^host-proof:\/\/koed\/device-identity\/(.+)$/.exec(reference);
  return Boolean(match && uuidPattern.test(match[1] ?? ""));
};

const defaultProofDirectory = (
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string => {
  const configured = environment.KOED_DEVICE_PROOF_DIR?.trim();
  if (configured) return resolve(configured);
  const home = environment.HOME?.trim() || homedir();
  if (platform === "darwin") {
    return resolve(
      home,
      "Library",
      "Application Support",
      "Koed",
      "device-proof"
    );
  }
  if (platform === "win32") {
    return resolve(
      environment.LOCALAPPDATA?.trim() || resolve(home, "AppData", "Local"),
      "Koed",
      "device-proof"
    );
  }
  return resolve(
    environment.XDG_STATE_HOME?.trim() || resolve(home, ".local", "state"),
    "koed",
    "device-proof"
  );
};

export const createPlatformHostProofStore = (input: {
  koedHome: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): HostProofStore => {
  const environment = input.environment ?? process.env;
  const platform = input.platform ?? nodePlatform();
  const proofDirectory = defaultProofDirectory(environment, platform);
  const unsafeStorage = () => isPathInside(proofDirectory, input.koedHome);
  const pathFor = (reference: string): string => {
    if (!validReference(reference)) {
      throw new Error("Device proof reference is malformed.");
    }
    return resolve(proofDirectory, proofFileName(reference));
  };
  const assertDirectory = (create: boolean) => {
    if (unsafeStorage()) {
      throw new Error("Host proof storage must be outside KOED_HOME.");
    }
    if (create) mkdirSync(proofDirectory, { recursive: true, mode: 0o700 });
    if (!existsSync(proofDirectory) || isUnsafe(proofDirectory, platform)) {
      throw new Error("Host proof storage permissions are unsafe.");
    }
  };

  return {
    read(reference) {
      if (unsafeStorage()) return { state: "unsafe_permissions" };
      if (!existsSync(proofDirectory)) return { state: "missing" };
      if (isUnsafe(proofDirectory, platform)) {
        return { state: "unsafe_permissions" };
      }
      const path = pathFor(reference);
      if (!existsSync(path)) return { state: "missing" };
      if (isUnsafe(path, platform)) return { state: "unsafe_permissions" };
      try {
        return { state: "present", value: readFileSync(path, "utf8") };
      } catch {
        return { state: "malformed" };
      }
    },
    write(reference, value) {
      assertDirectory(true);
      const path = pathFor(reference);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, value, { mode: 0o600, flag: "wx" });
        if (isUnsafe(temporary, platform)) {
          throw new Error("Host proof storage permissions are unsafe.");
        }
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    remove(reference) {
      if (unsafeStorage()) return;
      const path = pathFor(reference);
      if (existsSync(path) && !isUnsafe(path, platform)) {
        rmSync(path, { force: true });
      }
    },
    hasStoredProofs() {
      if (unsafeStorage() || !existsSync(proofDirectory)) return false;
      try {
        return readdirSync(proofDirectory).some((name) =>
          name.endsWith(".json")
        );
      } catch {
        return true;
      }
    }
  };
};

export const deviceProofFingerprint = (proof: string): string =>
  createHash("sha256").update(proof).digest("hex");

export const parseDeviceIdentityState = (
  value: unknown
): DeviceIdentityState | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Partial<DeviceIdentityState>;
  const keys = Object.keys(state).sort();
  const expected = [
    "createdAt",
    "deploymentId",
    "deviceInstanceId",
    "proof",
    "remoteOperations",
    "schemaVersion",
    "updatedAt"
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    state.schemaVersion !== deviceIdentitySchemaVersion ||
    !uuidPattern.test(state.deploymentId ?? "") ||
    !uuidPattern.test(state.deviceInstanceId ?? "") ||
    !state.proof ||
    typeof state.proof !== "object" ||
    Array.isArray(state.proof) ||
    Object.keys(state.proof).sort().join(",") !== "fingerprint,reference" ||
    state.proof.reference !==
      hostProofReferenceFor(state.deviceInstanceId ?? "") ||
    !fingerprintPattern.test(state.proof.fingerprint ?? "") ||
    (state.remoteOperations !== "enabled" &&
      state.remoteOperations !== "repair_required") ||
    !isFiniteIsoDate(state.createdAt) ||
    !isFiniteIsoDate(state.updatedAt)
  ) {
    return null;
  }
  return state as DeviceIdentityState;
};

const isFiniteIsoDate = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const parseProof = (
  value: string
): { deploymentId: string; deviceInstanceId: string; proof: string } | null => {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      Object.keys(parsed).sort().join(",") !==
        "deploymentId,deviceInstanceId,proof,schemaVersion" ||
      parsed.schemaVersion !== deviceIdentitySchemaVersion ||
      typeof parsed.deploymentId !== "string" ||
      !uuidPattern.test(parsed.deploymentId) ||
      typeof parsed.deviceInstanceId !== "string" ||
      !uuidPattern.test(parsed.deviceInstanceId) ||
      typeof parsed.proof !== "string" ||
      !proofPattern.test(parsed.proof)
    ) {
      return null;
    }
    return {
      deploymentId: parsed.deploymentId,
      deviceInstanceId: parsed.deviceInstanceId,
      proof: parsed.proof
    };
  } catch {
    return null;
  }
};

const inspection = (
  health: DeviceIdentityHealth,
  state?: DeviceIdentityState
): DeviceIdentityInspection => {
  const healthy = health === "healthy";
  const messages: Record<DeviceIdentityHealth, string> = {
    healthy: "Device identity proof is verified.",
    missing_state: "Device identity state is missing.",
    malformed_state: "Device identity state is malformed.",
    unsafe_state_permissions: "Device identity state permissions are unsafe.",
    missing_proof:
      "Device identity proof is missing; this KOED_HOME may have been copied.",
    malformed_proof: "Device identity proof is malformed.",
    proof_mismatch:
      "Device identity proof does not match local identity state.",
    unsafe_proof_permissions:
      "Device identity proof storage permissions are unsafe.",
    unsafe_proof_storage: "Device identity proof storage is unsafe.",
    repair_required:
      "Device identity rotation is incomplete; remote operations remain blocked."
  };
  return {
    health,
    deploymentId: state?.deploymentId ?? null,
    deviceInstanceId: state?.deviceInstanceId ?? null,
    remoteOperationsAllowed: healthy,
    message: messages[health],
    ...(healthy
      ? {}
      : {
          action:
            "Run koed-server identity rotate --json to create a new local device identity."
        }),
    platformProtection: isPosix(nodePlatform()) ? "verified" : "limited"
  };
};

export const inspectDeviceIdentity = (input: {
  statePath: string;
  proofStore: HostProofStore;
  platform?: NodeJS.Platform;
}): DeviceIdentityInspection => {
  const platform = input.platform ?? nodePlatform();
  if (!existsSync(input.statePath)) return inspection("missing_state");
  if (
    isUnsafe(dirname(input.statePath), platform) ||
    isUnsafe(input.statePath, platform)
  ) {
    return inspection("unsafe_state_permissions");
  }
  let state: DeviceIdentityState | null;
  try {
    state = parseDeviceIdentityState(
      JSON.parse(readFileSync(input.statePath, "utf8"))
    );
  } catch {
    state = null;
  }
  if (!state) return inspection("malformed_state");

  let stored: HostProofReadResult;
  try {
    stored = input.proofStore.read(state.proof.reference);
  } catch (error) {
    return inspection(
      error instanceof Error && error.message.includes("outside KOED_HOME")
        ? "unsafe_proof_storage"
        : "unsafe_proof_permissions",
      state
    );
  }
  if (stored.state === "missing") return inspection("missing_proof", state);
  if (stored.state === "malformed") return inspection("malformed_proof", state);
  if (stored.state === "unsafe_permissions" || !stored.value) {
    return inspection("unsafe_proof_permissions", state);
  }
  const proof = parseProof(stored.value);
  if (!proof) return inspection("malformed_proof", state);
  if (
    proof.deploymentId !== state.deploymentId ||
    proof.deviceInstanceId !== state.deviceInstanceId ||
    deviceProofFingerprint(proof.proof) !== state.proof.fingerprint
  ) {
    return inspection("proof_mismatch", state);
  }
  return inspection(
    state.remoteOperations === "enabled" ? "healthy" : "repair_required",
    state
  );
};

export const inspectDeviceIdentityAtKoedHome = (input: {
  koedHome: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): DeviceIdentityInspection => {
  const proofStore = createPlatformHostProofStore(input);
  return inspectDeviceIdentity({
    statePath: resolve(input.koedHome, "config", "device-identity.json"),
    proofStore,
    platform: input.platform
  });
};

export const serializeHostProof = (input: {
  deploymentId: string;
  deviceInstanceId: string;
  proof: string;
}): string =>
  `${JSON.stringify({ schemaVersion: deviceIdentitySchemaVersion, ...input })}\n`;

export const deviceIdentityStatePathFor = (koedHome: string): string =>
  resolve(koedHome, "config", "device-identity.json");

export const deviceIdentityStateDirectoryFor = (statePath: string): string =>
  dirname(statePath);
