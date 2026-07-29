import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign
} from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
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
  /** Remote credential may remain active until Operator revokes it upstream. */
  pendingRemoteRevocation?: boolean;
  /** One startup-only reconciliation may adopt pre-clone-safe sync identity. */
  deploymentIdentityAdoptionPending?: true;
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
  /** Redacted repair state; no upstream IDs, proof data, or paths. */
  pendingRemoteRevocation?: true;
  platformProtection: "verified" | "limited";
}

export interface HostProofReadResult {
  state:
    | "present"
    | "missing"
    | "malformed"
    | "unsafe_permissions"
    | "unsafe_storage";
  value?: string;
}

export interface DeviceBoundSourceSigner {
  deploymentId: string;
  deviceInstanceId: string;
  keyId: string;
  publicKey: string;
  sign(payload: Uint8Array): string;
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
  lstat: typeof lstatSync = lstatSync
): boolean => {
  if (!isPosix(platform)) return false;
  try {
    const metadata = lstat(path);
    const getuid = process.getuid;
    return (
      metadata.isSymbolicLink() ||
      (!metadata.isFile() && !metadata.isDirectory()) ||
      (metadata.mode & 0o077) !== 0 ||
      (typeof getuid === "function" && metadata.uid !== getuid())
    );
  } catch {
    return true;
  }
};

const readNoFollow = (path: string): string => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error("Device identity file is not a regular file.");
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
};

const isPathInside = (path: string, parent: string): boolean => {
  const relativePath = relative(resolve(parent), resolve(path));
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !relativePath.includes("../"))
  );
};

const canonicalPath = (path: string): string => realpathSync(path);

const canonicalHomeForState = (statePath: string): string =>
  canonicalPath(resolve(statePath, "../.."));

/** HMAC only binds canonical KOED_HOME; raw path never enters identity state. */
export const hostProofHomeBinding = (
  proof: string,
  canonicalKoedHome: string
): string =>
  createHmac("sha256", proof).update(canonicalKoedHome).digest("base64url");

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
  const proofParent = dirname(proofDirectory);
  const unsafeStorage = () => {
    try {
      if (isPathInside(proofDirectory, input.koedHome)) return true;
      const canonicalHome = canonicalPath(input.koedHome);
      if (isPathInside(proofDirectory, canonicalHome)) return true;
      if (existsSync(proofParent) && lstatSync(proofParent).isSymbolicLink()) {
        return true;
      }
      if (!existsSync(proofDirectory)) return false;
      const canonicalProofDirectory = canonicalPath(proofDirectory);
      return (
        lstatSync(proofDirectory).isSymbolicLink() ||
        isPathInside(canonicalProofDirectory, canonicalHome)
      );
    } catch {
      return true;
    }
  };
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
      if (unsafeStorage()) return { state: "unsafe_storage" };
      if (existsSync(proofParent) && isUnsafe(proofParent, platform)) {
        return { state: "unsafe_permissions" };
      }
      if (!existsSync(proofDirectory)) return { state: "missing" };
      if (isUnsafe(proofDirectory, platform)) {
        return { state: "unsafe_permissions" };
      }
      const path = pathFor(reference);
      if (!existsSync(path)) return { state: "missing" };
      if (isUnsafe(path, platform)) return { state: "unsafe_permissions" };
      try {
        return { state: "present", value: readNoFollow(path) };
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
  const expectedWithPendingRevocation = [
    ...expected,
    "pendingRemoteRevocation"
  ].sort();
  const expectedWithPendingAdoption = [
    ...expected,
    "deploymentIdentityAdoptionPending"
  ].sort();
  const expectedWithPendingRevocationAndAdoption = [
    ...expected,
    "pendingRemoteRevocation",
    "deploymentIdentityAdoptionPending"
  ].sort();
  if (
    ![
      expected,
      expectedWithPendingRevocation,
      expectedWithPendingAdoption,
      expectedWithPendingRevocationAndAdoption
    ].some(
      (candidate) =>
        keys.length === candidate.length &&
        keys.every((key, index) => key === candidate[index])
    ) ||
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
    (state.pendingRemoteRevocation !== undefined &&
      state.pendingRemoteRevocation !== true) ||
    (state.deploymentIdentityAdoptionPending !== undefined &&
      state.deploymentIdentityAdoptionPending !== true) ||
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
): {
  deploymentId: string;
  deviceInstanceId: string;
  proof: string;
  homeBinding: string;
} | null => {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      Object.keys(parsed).sort().join(",") !==
        "deploymentId,deviceInstanceId,homeBinding,proof,schemaVersion" ||
      parsed.schemaVersion !== deviceIdentitySchemaVersion ||
      typeof parsed.deploymentId !== "string" ||
      !uuidPattern.test(parsed.deploymentId) ||
      typeof parsed.deviceInstanceId !== "string" ||
      !uuidPattern.test(parsed.deviceInstanceId) ||
      typeof parsed.proof !== "string" ||
      !proofPattern.test(parsed.proof) ||
      typeof parsed.homeBinding !== "string" ||
      !proofPattern.test(parsed.homeBinding)
    ) {
      return null;
    }
    return {
      deploymentId: parsed.deploymentId,
      deviceInstanceId: parsed.deviceInstanceId,
      proof: parsed.proof,
      homeBinding: parsed.homeBinding
    };
  } catch {
    return null;
  }
};

const inspection = (
  health: DeviceIdentityHealth,
  state?: DeviceIdentityState,
  platform: NodeJS.Platform = nodePlatform()
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
  const actions: Partial<Record<DeviceIdentityHealth, string>> = {
    unsafe_proof_storage:
      "Move host proof storage outside KOED_HOME, then run koed-server identity rotate --json.",
    unsafe_proof_permissions:
      "Restrict host proof storage permissions to current Operator, then run koed-server identity rotate --json."
  };
  return {
    health,
    deploymentId: state?.deploymentId ?? null,
    deviceInstanceId: state?.deviceInstanceId ?? null,
    remoteOperationsAllowed: healthy && platform !== "win32",
    message: messages[health],
    ...(state?.pendingRemoteRevocation
      ? { pendingRemoteRevocation: true as const }
      : {}),
    ...(healthy
      ? {}
      : {
          action:
            actions[health] ??
            "Run koed-server identity rotate --json to create a new local device identity."
        }),
    platformProtection: isPosix(platform) ? "verified" : "limited"
  };
};

export const inspectDeviceIdentity = (input: {
  statePath: string;
  proofStore: HostProofStore;
  platform?: NodeJS.Platform;
}): DeviceIdentityInspection => {
  const platform = input.platform ?? nodePlatform();
  if (!existsSync(input.statePath)) {
    return inspection("missing_state", undefined, platform);
  }
  const koedHome = resolve(input.statePath, "../..");
  if (
    isUnsafe(koedHome, platform) ||
    isUnsafe(dirname(input.statePath), platform) ||
    isUnsafe(input.statePath, platform)
  ) {
    return inspection("unsafe_state_permissions", undefined, platform);
  }
  let state: DeviceIdentityState | null;
  try {
    state = parseDeviceIdentityState(JSON.parse(readNoFollow(input.statePath)));
  } catch {
    state = null;
  }
  if (!state) return inspection("malformed_state", undefined, platform);

  let stored: HostProofReadResult;
  try {
    stored = input.proofStore.read(state.proof.reference);
  } catch (error) {
    return inspection(
      error instanceof Error && error.message.includes("outside KOED_HOME")
        ? "unsafe_proof_storage"
        : "unsafe_proof_permissions",
      state,
      platform
    );
  }
  if (stored.state === "missing")
    return inspection("missing_proof", state, platform);
  if (stored.state === "malformed")
    return inspection("malformed_proof", state, platform);
  if (stored.state === "unsafe_storage") {
    return inspection("unsafe_proof_storage", state, platform);
  }
  if (stored.state === "unsafe_permissions" || !stored.value) {
    return inspection("unsafe_proof_permissions", state, platform);
  }
  const proof = parseProof(stored.value);
  if (!proof) return inspection("malformed_proof", state, platform);
  let canonicalKoedHome: string;
  try {
    canonicalKoedHome = canonicalHomeForState(input.statePath);
  } catch {
    return inspection("unsafe_state_permissions", state, platform);
  }
  if (
    proof.deploymentId !== state.deploymentId ||
    proof.deviceInstanceId !== state.deviceInstanceId ||
    deviceProofFingerprint(proof.proof) !== state.proof.fingerprint ||
    proof.homeBinding !== hostProofHomeBinding(proof.proof, canonicalKoedHome)
  ) {
    return inspection("proof_mismatch", state, platform);
  }
  return inspection(
    state.remoteOperations === "enabled" && !state.pendingRemoteRevocation
      ? "healthy"
      : "repair_required",
    state,
    platform
  );
};

const writeDeviceIdentityState = (
  statePath: string,
  state: DeviceIdentityState
): void => {
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

/**
 * Reconciles only freshly bootstrapped state with a pre-clone-safe local
 * Cross-Identity Sync row. Once finalized, mismatches remain fail-closed.
 */
export const reconcileDeviceIdentityDeployment = (input: {
  koedHome: string;
  protocolDeploymentId: string | null;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): DeviceIdentityInspection => {
  const statePath = deviceIdentityStatePathFor(input.koedHome);
  const proofStore = createPlatformHostProofStore(input);
  const current = inspectDeviceIdentity({
    statePath,
    proofStore,
    platform: input.platform
  });
  if (current.health !== "healthy") return current;

  const state = parseDeviceIdentityState(JSON.parse(readNoFollow(statePath)));
  if (!state?.deploymentIdentityAdoptionPending) return current;
  const protocolDeploymentId = input.protocolDeploymentId;
  if (
    protocolDeploymentId !== null &&
    !uuidPattern.test(protocolDeploymentId)
  ) {
    throw new Error("Legacy local deployment protocol identity is malformed.");
  }

  const finalized: DeviceIdentityState = {
    ...state,
    ...(protocolDeploymentId ? { deploymentId: protocolDeploymentId } : {}),
    updatedAt: new Date().toISOString()
  };
  delete finalized.deploymentIdentityAdoptionPending;
  if (protocolDeploymentId && protocolDeploymentId !== state.deploymentId) {
    const proof = randomBytes(32).toString("base64url");
    proofStore.write(
      finalized.proof.reference,
      serializeHostProof({
        deploymentId: finalized.deploymentId,
        deviceInstanceId: finalized.deviceInstanceId,
        proof,
        canonicalKoedHome: canonicalPath(input.koedHome)
      })
    );
    finalized.proof = {
      ...finalized.proof,
      fingerprint: deviceProofFingerprint(proof)
    };
  }
  writeDeviceIdentityState(statePath, finalized);
  return inspectDeviceIdentity({
    statePath,
    proofStore,
    platform: input.platform
  });
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

const ed25519Pkcs8SeedPrefix = Buffer.from(
  "302e020100300506032b657004220420",
  "hex"
);

/**
 * Derives a generation-scoped source signing key from the verified host proof.
 * The proof and private key never enter KOED_HOME or the returned object.
 */
export const createDeviceBoundSourceSigner = (input: {
  koedHome: string;
  sourceGenerationId: string;
  originKeyId: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): DeviceBoundSourceSigner => {
  if (
    !uuidPattern.test(input.sourceGenerationId) ||
    !uuidPattern.test(input.originKeyId)
  ) {
    throw new Error("Source generation signing identity is malformed.");
  }
  const statePath = deviceIdentityStatePathFor(input.koedHome);
  const proofStore = createPlatformHostProofStore(input);
  const identity = inspectDeviceIdentity({
    statePath,
    proofStore,
    platform: input.platform
  });
  if (
    identity.health !== "healthy" ||
    !identity.deploymentId ||
    !identity.deviceInstanceId
  ) {
    throw new Error(
      "A verified device identity is required for source replication."
    );
  }
  const state = parseDeviceIdentityState(JSON.parse(readNoFollow(statePath)));
  if (!state) {
    throw new Error("Device identity state is malformed.");
  }
  const stored = proofStore.read(state.proof.reference);
  const parsed =
    stored.state === "present" && stored.value
      ? parseProof(stored.value)
      : null;
  if (
    !parsed ||
    parsed.deploymentId !== identity.deploymentId ||
    parsed.deviceInstanceId !== identity.deviceInstanceId
  ) {
    throw new Error("Verified device proof could not be opened.");
  }
  const seed = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(parsed.proof, "base64url"),
      Buffer.from(`${input.sourceGenerationId}:${input.originKeyId}`, "utf8"),
      Buffer.from(
        "koed/conversation-source-replication/v1/origin-signing",
        "utf8"
      ),
      32
    )
  );
  const privateKey = createPrivateKey({
    key: Buffer.concat([ed25519Pkcs8SeedPrefix, seed]),
    format: "der",
    type: "pkcs8"
  });
  seed.fill(0);
  const publicJwk = createPublicKey(privateKey).export({
    format: "jwk"
  }) as JsonWebKey;
  if (
    publicJwk.kty !== "OKP" ||
    publicJwk.crv !== "Ed25519" ||
    typeof publicJwk.x !== "string"
  ) {
    throw new Error("Source signing public key export failed.");
  }
  const publicKey = publicJwk.x;
  return {
    deploymentId: identity.deploymentId,
    deviceInstanceId: identity.deviceInstanceId,
    keyId: input.originKeyId,
    publicKey,
    sign: (payload) => sign(null, payload, privateKey).toString("base64url")
  };
};

export const serializeHostProof = (input: {
  deploymentId: string;
  deviceInstanceId: string;
  proof: string;
  canonicalKoedHome: string;
}): string =>
  `${JSON.stringify({
    schemaVersion: deviceIdentitySchemaVersion,
    deploymentId: input.deploymentId,
    deviceInstanceId: input.deviceInstanceId,
    proof: input.proof,
    homeBinding: hostProofHomeBinding(input.proof, input.canonicalKoedHome)
  })}\n`;

export const deviceIdentityStatePathFor = (koedHome: string): string =>
  resolve(koedHome, "config", "device-identity.json");

export const deviceIdentityStateDirectoryFor = (statePath: string): string =>
  dirname(statePath);
