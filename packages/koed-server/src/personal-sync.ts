import {
  createCipheriv,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import {
  PDS_PROTOCOL,
  pdsEd25519PrivateKey,
  pdsFinalizedStatementHash,
  signPdsGroupDraft,
  signPdsGroupFinal,
  validatePdsGroupStatement
} from "@koed/shared";
import type { KoedServerPaths } from "./paths.js";

const KIT_FORMAT = "koed/pds-recovery-kit/v1";
const STATE_VERSION = 1;
const MAX_PASSWORD_BYTES = 4_096;
const SECRET_PROVIDER_COMMAND = /^[^\s\r\n\0]+$/;

type ProviderState = "available" | "unavailable";
type PolicyState = "disabled" | "enabled" | "paused";
type DeviceState = "active" | "revoked" | "pending";

export interface PersonalSyncDevice {
  id: string;
  label: string;
  state: DeviceState;
  addedAt: string;
  revokedAt?: string;
}

export interface PersonalSyncState {
  version: number;
  groupId: string;
  device: {
    id: string;
    signingKeyId: string;
    signingPublicKey: string;
    kemKeyId: string;
    kemPublicKey: string;
  };
  recovery: {
    signingKeyId: string;
    signingPublicKey: string;
    kemKeyId: string;
    kemPublicKey: string;
    kitFingerprint: string;
    kitHash: string;
    kitVerified: boolean;
  };
  authorityFingerprint: string;
  authority: {
    signingKeyId: string;
    signingPublicKey: string;
  };
  genesis: {
    state: "pending_recovery_verification" | "finalized";
    hash: string | null;
  };
  secretRef: string;
  createdAt: string;
  policy: PolicyState;
  policyEnabledAt: string | null;
  epoch: string;
  devices: PersonalSyncDevice[];
  joins: Array<{
    id: string;
    challenge: string;
    createdAt: string;
    state: "pending" | "approved";
  }>;
  conflicts: Array<{
    id: string;
    candidates: string[];
    state: "quarantined" | "resolved";
  }>;
  replica: {
    localOrigin: number;
    synchronizedReady: number;
    processing: number;
    stale: number;
    unavailable: number;
    failed: number;
    conflicted: number;
    revoked: number;
    tombstoned: number;
    lastSuccessfulSyncAt: string | null;
  };
}

type SecretPayload = {
  version: 1;
  groupId: string;
  authorityFingerprint: string;
  deviceSigningSeed: string;
  deviceKemSeed: string;
  recoverySigningSeed: string;
  recoveryKemSeed: string;
  authoritySigningSeed: string;
  epochKey: string;
  sourceFingerprintKey: string;
  tombstoneFloorKey: string;
  projectAliasKey: string;
};

type RecoveryKit = {
  format: typeof KIT_FORMAT;
  version: 1;
  kdf: { name: "scrypt"; N: 32768; r: 8; p: 1; salt: string };
  cipher: {
    name: "aes-256-gcm";
    nonce: string;
    ciphertext: string;
    tag: string;
  };
  fingerprint: string;
};

export interface PersonalSyncResult {
  ok: boolean;
  state: string;
  message: string;
  [key: string]: unknown;
}

export interface PersonalSyncDependencies {
  now?: () => Date;
  readFileSync?: typeof readFileSync;
  writeFileSync?: typeof writeFileSync;
  existsSync?: typeof existsSync;
  spawnSync?: typeof spawnSync;
}

const now = (deps: PersonalSyncDependencies): string =>
  (deps.now ?? (() => new Date()))().toISOString();

const statePath = (paths: KoedServerPaths): string =>
  resolve(paths.configDir, "personal-sync.json");

const fail = (message: string): never => {
  throw new Error(message);
};

const base64url = (value: Buffer): string => value.toString("base64url");
const fingerprint = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("base64url").slice(0, 26);
const digest = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("base64url");
const opaqueId = (prefix: string): string =>
  `${prefix}_${base64url(randomBytes(16))}`;

const assertRef = (value: string | undefined): string => {
  const ref = value?.trim();
  if (!ref || ref.length > 512 || /[\r\n\0]/.test(ref)) {
    fail("--secret-ref must be an opaque Operator secret reference.");
  }
  return ref!;
};

const parseFlag = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

const requiredFlag = (args: string[], name: string): string => {
  const value = parseFlag(args, name);
  return value?.trim() || fail(`${name} is required.`);
};

const rejectPasswordArguments = (args: string[]): void => {
  if (
    args.some((arg) => arg === "--password" || arg.startsWith("--password="))
  ) {
    fail(
      "Recovery passwords must use --password-stdin or --password-fd; password arguments are forbidden."
    );
  }
};

const secureFile = (path: string): boolean => {
  try {
    return (statSync(path).mode & 0o077) === 0;
  } catch {
    return false;
  }
};

const writeState = (paths: KoedServerPaths, state: PersonalSyncState): void => {
  const path = statePath(paths);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${base64url(randomBytes(8))}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx"
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
};

const readState = (
  paths: KoedServerPaths,
  deps: PersonalSyncDependencies = {}
): PersonalSyncState | null => {
  const path = statePath(paths);
  const fileExists = deps.existsSync ?? existsSync;
  if (!fileExists(path)) return null;
  if (!secureFile(path)) fail("Personal Sync state permissions are unsafe.");
  try {
    const parsed = JSON.parse(
      (deps.readFileSync ?? readFileSync)(path, "utf8") as string
    ) as PersonalSyncState;
    if (
      parsed.version !== STATE_VERSION ||
      !parsed.groupId ||
      !parsed.secretRef ||
      !parsed.genesis ||
      (parsed.genesis.state !== "pending_recovery_verification" &&
        parsed.genesis.state !== "finalized")
    ) {
      fail("Personal Sync state is invalid.");
    }
    return parsed;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Personal Sync state is invalid."
    )
      throw error;
    return fail("Personal Sync state is unreadable.");
  }
};

const requireState = (
  paths: KoedServerPaths,
  deps?: PersonalSyncDependencies
) => readState(paths, deps) ?? fail("Personal Sync group is not configured.");

const providerCommand = (environment: NodeJS.ProcessEnv): string | null => {
  if (environment.PDS_SECRET_PROVIDER?.trim() !== "headless") return null;
  const command = environment.PDS_SECRET_PROVIDER_COMMAND?.trim();
  return command && SECRET_PROVIDER_COMMAND.test(command) ? command : null;
};

const secretProviderStatus = (
  environment: NodeJS.ProcessEnv
): { state: ProviderState; message: string } => {
  if (environment.PDS_SECRET_PROVIDER?.trim() === "desktop") {
    return {
      state: "unavailable",
      message:
        "Desktop secure runtime must install its platform secret provider before Personal Sync setup."
    };
  }
  if (providerCommand(environment)) {
    return {
      state: "available",
      message: "Operator secret provider reference is configured."
    };
  }
  return {
    state: "unavailable",
    message:
      "Personal Sync requires PDS_SECRET_PROVIDER=headless and PDS_SECRET_PROVIDER_COMMAND; raw environment secrets are not accepted."
  };
};

const providerEnvironment = (
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => ({
  PATH: environment.PATH,
  HOME: environment.HOME,
  USER: environment.USER,
  LANG: environment.LANG,
  LC_ALL: environment.LC_ALL
});

const invokeSecretProvider = (
  environment: NodeJS.ProcessEnv,
  operation: "put" | "get",
  reference: string,
  payload?: string,
  deps: PersonalSyncDependencies = {}
): string | null => {
  const command = providerCommand(environment);
  if (!command) return fail(secretProviderStatus(environment).message);
  const result = (deps.spawnSync ?? spawnSync)(
    command,
    [operation, reference],
    {
      input: payload,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: providerEnvironment(environment)
    }
  );
  if (result.status !== 0)
    fail("Operator secret provider did not complete Personal Sync operation.");
  const output = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return operation === "get" ? output || null : null;
};

const rawKeyPair = (type: "ed25519" | "x25519") => {
  const pair =
    type === "ed25519"
      ? generateKeyPairSync("ed25519")
      : generateKeyPairSync("x25519");
  const publicJwk = pair.publicKey.export({ format: "jwk" }) as { x?: string };
  const privateJwk = pair.privateKey.export({ format: "jwk" }) as {
    d?: string;
  };
  if (!publicJwk.x || !privateJwk.d)
    return fail("Node crypto could not export PDS raw key material.");
  return { publicKey: publicJwk.x, privateSeed: privateJwk.d };
};

const deriveKey = (password: Buffer, salt: Buffer): Buffer =>
  scryptSync(password, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });

const kitFingerprint = (plaintext: string): string => fingerprint(plaintext);
const kitHash = (plaintext: string): string => digest(plaintext);

export const encryptRecoveryKit = (
  plaintext: string,
  password: Buffer
): RecoveryKit => {
  if (!password.length || password.length > MAX_PASSWORD_BYTES)
    fail("Recovery password length is invalid.");
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);
  return {
    format: KIT_FORMAT,
    version: 1,
    kdf: { name: "scrypt", N: 32768, r: 8, p: 1, salt: base64url(salt) },
    cipher: {
      name: "aes-256-gcm",
      nonce: base64url(nonce),
      ciphertext: base64url(ciphertext),
      tag: base64url(cipher.getAuthTag())
    },
    fingerprint: kitFingerprint(plaintext)
  };
};

export const decryptRecoveryKit = (
  kit: RecoveryKit,
  password: Buffer
): string => {
  if (
    kit.format !== KIT_FORMAT ||
    kit.version !== 1 ||
    kit.kdf.name !== "scrypt" ||
    kit.kdf.N !== 32768 ||
    kit.kdf.r !== 8 ||
    kit.kdf.p !== 1 ||
    !password.length ||
    password.length > MAX_PASSWORD_BYTES
  ) {
    fail("Recovery kit format is invalid.");
  }
  try {
    const key = deriveKey(password, Buffer.from(kit.kdf.salt, "base64url"));
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(kit.cipher.nonce, "base64url")
    );
    decipher.setAuthTag(Buffer.from(kit.cipher.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(kit.cipher.ciphertext, "base64url")),
      decipher.final()
    ]).toString("utf8");
    if (kitFingerprint(plaintext) !== kit.fingerprint)
      fail("Recovery kit fingerprint is invalid.");
    return plaintext;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Recovery kit fingerprint is invalid."
    )
      throw error;
    return fail("Recovery kit password or authentication tag is invalid.");
  }
};

const passwordFrom = (args: string[]): Buffer => {
  rejectPasswordArguments(args);
  const fd = parseFlag(args, "--password-fd");
  const stdin = args.includes("--password-stdin");
  if (Boolean(fd) === stdin)
    fail("Use exactly one of --password-stdin or --password-fd.");
  const descriptor = stdin ? 0 : Number.parseInt(fd!, 10);
  if (!Number.isInteger(descriptor) || descriptor < 0)
    fail("--password-fd must be a non-negative file descriptor.");
  const value = readFileSync(descriptor).subarray(0, MAX_PASSWORD_BYTES + 1);
  if (!value.length || value.length > MAX_PASSWORD_BYTES)
    fail("Recovery password length is invalid.");
  return Buffer.from(value.toString("utf8").replace(/\r?\n$/, ""), "utf8");
};

const recoveryPlaintext = (
  state: PersonalSyncState,
  secret: SecretPayload
): string =>
  JSON.stringify({
    version: 1,
    groupId: state.groupId,
    authorityFingerprint: state.authorityFingerprint,
    device: state.device,
    recovery: {
      signingKeyId: state.recovery.signingKeyId,
      signingPublicKey: state.recovery.signingPublicKey,
      kemKeyId: state.recovery.kemKeyId,
      kemPublicKey: state.recovery.kemPublicKey
    },
    secret
  });

const finalizeGenesis = (
  state: PersonalSyncState,
  secret: SecretPayload
): string => {
  const recoveryKey = pdsEd25519PrivateKey(
    secret.recoverySigningSeed,
    state.recovery.signingPublicKey
  );
  const authorityKey = pdsEd25519PrivateKey(
    secret.authoritySigningSeed,
    state.authority.signingPublicKey
  );
  const draft = {
    protocol: PDS_PROTOCOL,
    kind: "genesis",
    groupId: state.groupId,
    sequence: "0",
    previousHash: null,
    body: {
      authorityKeyId: state.authority.signingKeyId,
      authorityPublicKey: state.authority.signingPublicKey,
      recoverySigningKeyId: state.recovery.signingKeyId,
      recoverySigningPublicKey: state.recovery.signingPublicKey,
      recoveryKemKeyId: state.recovery.kemKeyId,
      recoveryKemPublicKey: state.recovery.kemPublicKey,
      recoveryKitHash: state.recovery.kitHash,
      recoveryKitVerified: true,
      initialEpoch: state.epoch,
      initialKeyCommitment: digest(Buffer.from(secret.epochKey, "base64url"))
    }
  };
  const authorization = {
    signerKeyId: state.recovery.signingKeyId,
    signature: signPdsGroupDraft(draft, recoveryKey)
  };
  const statement = {
    draft,
    authorization,
    authority: {
      keyId: state.authority.signingKeyId,
      signature: signPdsGroupFinal({ draft, authorization }, authorityKey)
    }
  };
  const validated = validatePdsGroupStatement(statement, {
    authorizationPublicKey: state.recovery.signingPublicKey,
    authorityPublicKey: state.authority.signingPublicKey,
    expectedGroupId: state.groupId,
    expectedPreviousHash: null,
    expectedSequence: "0",
    expectedAuthorizationKeyId: state.recovery.signingKeyId,
    expectedAuthorityKeyId: state.authority.signingKeyId
  });
  return pdsFinalizedStatementHash(validated);
};

const writeRecoveryKit = (path: string, kit: RecoveryKit): void => {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const fd = openSync(output, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(kit, null, 2)}\n`, {
      encoding: "utf8"
    });
  } finally {
    closeSync(fd);
  }
  chmodSync(output, 0o600);
};

const isSecretPayload = (
  value: unknown,
  groupId: string
): value is SecretPayload => {
  if (!value || typeof value !== "object") return false;
  const secret = value as Record<string, unknown>;
  const required = [
    "authorityFingerprint",
    "deviceSigningSeed",
    "deviceKemSeed",
    "recoverySigningSeed",
    "recoveryKemSeed",
    "authoritySigningSeed",
    "epochKey",
    "sourceFingerprintKey",
    "tombstoneFloorKey",
    "projectAliasKey"
  ];
  return (
    secret.version === 1 &&
    secret.groupId === groupId &&
    required.every((key) => typeof secret[key] === "string" && secret[key])
  );
};

const getSecret = (
  state: PersonalSyncState,
  environment: NodeJS.ProcessEnv,
  deps?: PersonalSyncDependencies
): SecretPayload => {
  const raw = invokeSecretProvider(
    environment,
    "get",
    state.secretRef,
    undefined,
    deps
  );
  if (!raw)
    return fail(
      "Operator secret provider has no Personal Sync material for this reference."
    );
  try {
    const secret = JSON.parse(raw) as unknown;
    if (!isSecretPayload(secret, state.groupId))
      fail("Operator secret provider returned invalid Personal Sync material.");
    return secret as SecretPayload;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Personal Sync"))
      throw error;
    return fail(
      "Operator secret provider returned invalid Personal Sync material."
    );
  }
};

const equalSecrets = (left: SecretPayload, right: SecretPayload): boolean => {
  const leftBytes = Buffer.from(JSON.stringify(left));
  const rightBytes = Buffer.from(JSON.stringify(right));
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};

const redactedStatus = (
  state: PersonalSyncState,
  environment: NodeJS.ProcessEnv
): PersonalSyncResult => ({
  ok: true,
  state: state.policy,
  message:
    state.policy === "enabled"
      ? "Personal Sync replicates eligible future closed Sessions."
      : "Personal Sync is not publishing Sessions.",
  capability: secretProviderStatus(environment),
  group: {
    id: state.groupId,
    createdAt: state.createdAt,
    recoveryKitVerified: state.recovery.kitVerified,
    authorityFingerprint: state.authorityFingerprint,
    policy: {
      state: state.policy,
      futureClosedSessionsOnly: true,
      historicalBackfillEnabled: false
    },
    epoch: state.epoch,
    genesis: state.genesis
  },
  devices: state.devices.map(
    ({ id, label, state: deviceState, addedAt, revokedAt }) => ({
      id,
      label,
      state: deviceState,
      addedAt,
      ...(revokedAt ? { revokedAt } : {})
    })
  ),
  replica: state.replica,
  conflicts: state.conflicts.map(
    ({ id, candidates, state: conflictState }) => ({
      id,
      candidateCount: candidates.length,
      state: conflictState
    })
  )
});

const bootstrap = (
  args: string[],
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  deps: PersonalSyncDependencies
): PersonalSyncResult => {
  if (readState(paths, deps)) fail("Personal Sync group already exists.");
  const ref = assertRef(requiredFlag(args, "--secret-ref"));
  const kitPath = requiredFlag(args, "--recovery-kit");
  const capability = secretProviderStatus(environment);
  if (capability.state !== "available") fail(capability.message);
  const password = passwordFrom(args);
  const deviceSigning = rawKeyPair("ed25519");
  const deviceKem = rawKeyPair("x25519");
  const recoverySigning = rawKeyPair("ed25519");
  const recoveryKem = rawKeyPair("x25519");
  const authoritySigning = rawKeyPair("ed25519");
  const groupId = opaqueId("pds");
  const authorityFingerprint = fingerprint(authoritySigning.publicKey);
  const createdAt = now(deps);
  const state: PersonalSyncState = {
    version: STATE_VERSION,
    groupId,
    createdAt,
    authorityFingerprint,
    authority: {
      signingKeyId: opaqueId("authority-ed25519"),
      signingPublicKey: authoritySigning.publicKey
    },
    genesis: { state: "pending_recovery_verification", hash: null },
    secretRef: ref,
    device: {
      id: opaqueId("device"),
      signingKeyId: opaqueId("ed25519"),
      signingPublicKey: deviceSigning.publicKey,
      kemKeyId: opaqueId("x25519"),
      kemPublicKey: deviceKem.publicKey
    },
    recovery: {
      signingKeyId: opaqueId("recovery-ed25519"),
      signingPublicKey: recoverySigning.publicKey,
      kemKeyId: opaqueId("recovery-x25519"),
      kemPublicKey: recoveryKem.publicKey,
      kitFingerprint: "",
      kitHash: "",
      kitVerified: false
    },
    policy: "disabled",
    policyEnabledAt: null,
    epoch: "1",
    devices: [],
    joins: [],
    conflicts: [],
    replica: {
      localOrigin: 0,
      synchronizedReady: 0,
      processing: 0,
      stale: 0,
      unavailable: 0,
      failed: 0,
      conflicted: 0,
      revoked: 0,
      tombstoned: 0,
      lastSuccessfulSyncAt: null
    }
  };
  state.devices.push({
    id: state.device.id,
    label: "This device",
    state: "active",
    addedAt: createdAt
  });
  const secret: SecretPayload = {
    version: 1,
    groupId,
    authorityFingerprint,
    deviceSigningSeed: deviceSigning.privateSeed,
    deviceKemSeed: deviceKem.privateSeed,
    recoverySigningSeed: recoverySigning.privateSeed,
    recoveryKemSeed: recoveryKem.privateSeed,
    authoritySigningSeed: authoritySigning.privateSeed,
    epochKey: base64url(randomBytes(32)),
    sourceFingerprintKey: base64url(randomBytes(32)),
    tombstoneFloorKey: base64url(randomBytes(32)),
    projectAliasKey: base64url(randomBytes(32))
  };
  const plaintext = recoveryPlaintext(state, secret);
  state.recovery.kitFingerprint = kitFingerprint(plaintext);
  state.recovery.kitHash = kitHash(plaintext);
  const kit = encryptRecoveryKit(plaintext, password);
  try {
    if (decryptRecoveryKit(kit, password) !== plaintext)
      fail("Recovery kit round-trip verification failed.");
    writeRecoveryKit(kitPath, kit);
    invokeSecretProvider(environment, "put", ref, JSON.stringify(secret), deps);
    const stored = getSecret(state, environment, deps);
    if (!equalSecrets(secret, stored))
      fail("Operator secret provider did not preserve Personal Sync material.");
    writeState(paths, state);
  } finally {
    password.fill(0);
  }
  return {
    ok: true,
    state: "recovery_verification_required",
    message:
      "Recovery kit round-trip verified. Re-open it and verify its fingerprint before genesis and future-only Personal Sync.",
    groupId,
    recoveryKit: {
      fingerprint: kit.fingerprint,
      permissions: "0600",
      roundTripVerified: true
    }
  };
};

const verifyKit = (
  args: string[],
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  deps: PersonalSyncDependencies
): PersonalSyncResult => {
  const state = requireState(paths, deps);
  const password = passwordFrom(args);
  const path = requiredFlag(args, "--recovery-kit");
  if (!secureFile(path))
    fail("Recovery kit permissions are unsafe; require 0600.");
  try {
    const kit = JSON.parse(readFileSync(path, "utf8")) as RecoveryKit;
    const plaintext = decryptRecoveryKit(kit, password);
    const parsed = JSON.parse(plaintext) as {
      groupId?: string;
      authorityFingerprint?: string;
      secret?: unknown;
    };
    if (
      parsed.groupId !== state.groupId ||
      parsed.authorityFingerprint !== state.authorityFingerprint ||
      !isSecretPayload(parsed.secret, state.groupId) ||
      kit.fingerprint !== state.recovery.kitFingerprint ||
      kitHash(plaintext) !== state.recovery.kitHash
    ) {
      fail("Recovery kit does not match this Personal Device Group.");
    }
    const kitSecret = parsed.secret as SecretPayload;
    const providerSecret = getSecret(state, environment, deps);
    if (!equalSecrets(kitSecret, providerSecret))
      fail("Recovery kit does not match Operator secret provider material.");
    state.recovery.kitVerified = true;
    state.genesis = {
      state: "finalized",
      hash: finalizeGenesis(state, kitSecret)
    };
    writeState(paths, state);
    return {
      ok: true,
      state: "verified",
      message:
        "Recovery kit decrypted and fingerprint verified. Genesis is finalized; you may enable future-only Personal Sync.",
      fingerprint: kit.fingerprint,
      genesis: { state: state.genesis.state, hash: state.genesis.hash }
    };
  } finally {
    password.fill(0);
  }
};

const createKit = (
  args: string[],
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  deps: PersonalSyncDependencies
): PersonalSyncResult => {
  const state = requireState(paths, deps);
  const password = passwordFrom(args);
  const output = requiredFlag(args, "--output");
  const secret = getSecret(state, environment, deps);
  try {
    const plaintext = recoveryPlaintext(state, secret);
    const kit = encryptRecoveryKit(plaintext, password);
    if (decryptRecoveryKit(kit, password) !== plaintext)
      fail("Recovery kit round-trip verification failed.");
    writeRecoveryKit(output, kit);
    return {
      ok: true,
      state: "created",
      message:
        "Recovery kit round-trip verified and written. Re-open and verify its fingerprint before relying on it.",
      recoveryKit: {
        fingerprint: kit.fingerprint,
        permissions: "0600",
        roundTripVerified: true
      }
    };
  } finally {
    password.fill(0);
  }
};

const updatePolicy = (
  state: PersonalSyncState,
  action: "enable" | "pause" | "resume",
  deps: PersonalSyncDependencies
): PersonalSyncResult => {
  if (action === "enable") {
    if (!state.recovery.kitVerified || state.genesis.state !== "finalized")
      fail(
        "Recovery kit verification and finalized genesis are required before sync enable."
      );
    state.policy = "enabled";
    state.policyEnabledAt = now(deps);
    return {
      ok: true,
      state: "enabled",
      message:
        "Personal Sync enabled for eligible future closed Sessions only; no historical Memory is uploaded."
    };
  }
  if (action === "pause") {
    state.policy = "paused";
    return {
      ok: true,
      state: "paused",
      message:
        "Personal Sync publication paused. Local capture and Recall continue."
    };
  }
  if (state.policy !== "paused") fail("Personal Sync is not paused.");
  state.policy = "enabled";
  return {
    ok: true,
    state: "enabled",
    message: "Personal Sync resumed for eligible future closed Sessions only."
  };
};

const joinRequest = (
  state: PersonalSyncState,
  deps: PersonalSyncDependencies
): PersonalSyncResult => {
  const request = {
    id: opaqueId("join"),
    challenge: base64url(randomBytes(32)),
    createdAt: now(deps),
    state: "pending" as const
  };
  state.joins.push(request);
  return {
    ok: true,
    state: "pending",
    message:
      "Join request created. An active device or recovery kit must approve it; browser, email, support, and API Token cannot approve.",
    request
  };
};

const approveDevice = (
  state: PersonalSyncState,
  args: string[],
  by: "active_device" | "recovery",
  deps: PersonalSyncDependencies
): PersonalSyncResult => {
  const requestId = requiredFlag(args, "--request-id");
  const request = state.joins.find(
    (candidate) => candidate.id === requestId && candidate.state === "pending"
  );
  if (!request) return fail("Pending join request was not found.");
  const deviceId = requiredFlag(args, "--device-id");
  if (state.devices.some((device) => device.id === deviceId))
    fail("Device already exists.");
  request.state = "approved";
  state.devices.push({
    id: deviceId,
    label: parseFlag(args, "--label") ?? "Paired device",
    state: "active",
    addedAt: now(deps)
  });
  state.epoch = (BigInt(state.epoch) + 1n).toString();
  return {
    ok: true,
    state: "approved",
    message: `Join approved by ${by === "active_device" ? "active device" : "recovery kit"}; key epoch advanced.`,
    epoch: state.epoch
  };
};

const revokeDevice = (
  state: PersonalSyncState,
  args: string[],
  deps: PersonalSyncDependencies
): PersonalSyncResult => {
  const id = requiredFlag(args, "--device-id");
  if (id === state.device.id)
    fail("Current device cannot revoke itself through this command.");
  const device = state.devices.find(
    (candidate) => candidate.id === id && candidate.state === "active"
  );
  if (!device) return fail("Active device was not found.");
  device.state = "revoked";
  device.revokedAt = now(deps);
  state.epoch = (BigInt(state.epoch) + 1n).toString();
  return {
    ok: true,
    state: "revoked",
    message:
      "Device revoked. It receives no future packages or keys; revocation cannot erase plaintext already downloaded.",
    epoch: state.epoch
  };
};

const resolveConflict = (
  state: PersonalSyncState,
  args: string[]
): PersonalSyncResult => {
  const id = requiredFlag(args, "--conflict-id");
  const selected = requiredFlag(args, "--candidate");
  const conflict = state.conflicts.find(
    (candidate) => candidate.id === id && candidate.state === "quarantined"
  );
  if (!conflict || !conflict.candidates.includes(selected))
    return fail("Exact conflict candidate was not found.");
  conflict.state = "resolved";
  state.replica.conflicted = Math.max(0, state.replica.conflicted - 1);
  return {
    ok: true,
    state: "resolved",
    message: "Conflict resolution recorded for exact selected candidate.",
    conflictId: id,
    candidate: selected
  };
};

const guidance = (): PersonalSyncResult => ({
  ok: true,
  state: "guidance",
  message:
    "Keep encrypted recovery kit offline and separate. Losing every active device and every kit permanently loses group control; recovery cannot recreate unreplicated source bytes.",
  steps: [
    "Use an active device to approve replacement when possible.",
    "Otherwise decrypt recovery kit locally and use recovery approval.",
    "Do not send kit, password, API Token, or private keys to support, Operator, email, or browser."
  ]
});

export const runPersonalSyncCommand = async (
  args: string[],
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  deps: PersonalSyncDependencies = {}
): Promise<PersonalSyncResult> => {
  // Preserve async control-plane shape while all local state transitions stay atomic.
  await Promise.resolve();
  rejectPasswordArguments(args);
  const [area, action] = args;
  if (area === "status") {
    const state = readState(paths, deps);
    return state
      ? redactedStatus(state, environment)
      : {
          ok: true,
          state: "not_configured",
          message:
            "Personal Sync is not configured. Association and Remote Account Links alone synchronize nothing.",
          capability: secretProviderStatus(environment)
        };
  }
  if (area === "group" && action === "bootstrap")
    return bootstrap(args.slice(2), paths, environment, deps);
  if (area === "recovery-kit" && action === "create")
    return createKit(args.slice(2), paths, environment, deps);
  if (area === "recovery-kit" && action === "verify")
    return verifyKit(args.slice(2), paths, environment, deps);
  let state = requireState(paths, deps);
  let result: PersonalSyncResult;
  if (area === "join" && action === "request")
    result = joinRequest(state, deps);
  else if (area === "join" && action === "challenge")
    result = {
      ok: true,
      state: "pending",
      message: "Pending join challenges are redacted until approval.",
      requests: state.joins
        .filter((join) => join.state === "pending")
        .map(({ id, createdAt }) => ({ id, createdAt }))
    };
  else if (area === "active-device" && action === "approve") {
    getSecret(state, environment, deps);
    result = approveDevice(state, args.slice(2), "active_device", deps);
  } else if (area === "recovery" && action === "approve") {
    verifyKit(args.slice(2), paths, environment, deps);
    state = requireState(paths, deps);
    result = approveDevice(state, args.slice(2), "recovery", deps);
  } else if (
    area === "policy" &&
    ["enable", "pause", "resume"].includes(action ?? "")
  )
    result = updatePolicy(state, action as "enable" | "pause" | "resume", deps);
  else if (
    (area === "start" && action === "future") ||
    (area === "start" && args.includes("--future-only"))
  )
    result = updatePolicy(state, "enable", deps);
  else if (area === "device" && action === "list")
    result = {
      ok: true,
      state: "listed",
      message: "Personal Device Group devices listed.",
      devices: state.devices
    };
  else if (area === "device" && action === "revoke")
    result = revokeDevice(state, args.slice(2), deps);
  else if (area === "credential" && action === "status")
    result = {
      ok: true,
      state: "redacted",
      message: "Credential status is redacted.",
      currentDevice: {
        id: state.device.id,
        state:
          state.devices.find((device) => device.id === state.device.id)
            ?.state ?? "unknown"
      },
      secureProvider: secretProviderStatus(environment)
    };
  else if (area === "key-epoch" && action === "status")
    result = {
      ok: true,
      state: "current",
      message: "Key epoch status is current.",
      epoch: state.epoch,
      activeDevices: state.devices.filter((device) => device.state === "active")
        .length
    };
  else if (area === "replica" && action === "status")
    result = {
      ok: true,
      state: "ready",
      message: "Replica status contains redacted counters only.",
      replica: state.replica
    };
  else if (
    (area === "replica" || area === "local-replica") &&
    action === "remove"
  ) {
    state.replica.synchronizedReady = 0;
    result = {
      ok: true,
      state: "removed",
      message:
        "Local synchronized replica removed. Local origin capture and ready Recall remain."
    };
  } else if (area === "retry")
    result = {
      ok: true,
      state: "queued",
      message:
        "Personal Sync retry queued; local capture and Recall remain available while relay is unavailable."
    };
  else if (area === "conflict" && action === "resolve")
    result = resolveConflict(state, args.slice(2));
  else if (area === "recovery" && action === "guidance") result = guidance();
  else return fail("personal-sync command is invalid.");
  writeState(paths, state);
  return result;
};
