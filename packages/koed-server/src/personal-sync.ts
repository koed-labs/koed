import {
  createCipheriv,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign,
  type KeyObject
} from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  PDS_PROTOCOL,
  canonicalizePdsJson,
  createPdsAuthorizedKeyBundle,
  createPdsSessionPackageRuntimeContext,
  decryptPdsKeyBundleSecretSet,
  parseCanonicalPdsJson,
  pdsSha256,
  pdsEd25519PrivateKey,
  pdsPublicKeyCommitment,
  signPdsGroupDraft,
  signPdsRecord,
  validatePdsGroupStatement
} from "@koed/shared";
import { ensureDeviceIdentity } from "./device-identity.js";
import type { KoedServerPaths } from "./paths.js";

const KIT_FORMAT = "koed/pds-recovery-kit/v1";
const PENDING_VERSION = 1;
const MAX_PASSWORD_BYTES = 4_096;
const MAX_CONTROL_RESPONSE_BYTES = 1_048_576;
const MAX_PENDING_REQUESTS = 32;

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

type PendingRequest = { requestId: string; groupId: string; createdAt: string };
type PendingState = { version: 1; pending: PendingRequest[] };
type GeneratedKey = {
  publicKey: string;
  privateSeed: string;
  privateKey: KeyObject;
};
type RuntimeSecret = {
  version: 1;
  userId: string;
  relayUrl: string;
  groupId: string;
  device: {
    id: string;
    originDeploymentId: string;
    signingKeyId: string;
    signingPrivateSeed: string;
    kemKeyId: string;
    kemPrivateSeed: string;
  };
  authority: { keyId: string; publicKey: string; head: string };
  recovery: { signingKeyId: string; signingPublicKey: string };
  certificate: string;
  recipientCertificates: string[];
  historicalOriginCertificates?: string[];
  groupSecrets: {
    currentEpoch: string;
    contentKey: string;
    sourceFingerprintKey: string;
    tombstoneFloorKey: string;
    projectAliasKey: string;
  };
};
type PendingEnrollmentSecret = {
  version: 1;
  groupId: string;
  userId: string;
  browserDeploymentId: string;
  localDeploymentId: string;
  relayUrl: string;
  originDeploymentId: string;
  deviceId: string;
  signingKeyId: string;
  signingPublicKey: string;
  signingPrivateSeed: string;
  kemKeyId: string;
  kemPublicKey: string;
  kemPrivateSeed: string;
  authorityKeyId: string;
  authorityPublicKey: string;
  challengeId: string;
  challenge: string;
  expiresAt: string;
};

export interface PersonalSyncResult {
  ok: boolean;
  state: string;
  message: string;
  [key: string]: unknown;
}

export interface PersonalSyncDependencies {
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
  sessionCookie?: string;
  desktopAuthorization?: string;
  pairingToken?: string;
  identity?: {
    remoteOperationsAllowed: boolean;
    deploymentId: string | null;
    deviceInstanceId: string | null;
  };
  putSecret?: (
    reference: string,
    value: string,
    environment: NodeJS.ProcessEnv
  ) => void | Promise<void>;
  getSecret?: (
    reference: string,
    environment: NodeJS.ProcessEnv
  ) => string | null | Promise<string | null>;
  deleteSecret?: (
    reference: string,
    environment: NodeJS.ProcessEnv
  ) => void | Promise<void>;
}

const fail = (message: string): never => {
  throw new Error(message);
};
const strictString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1_048_576;
const b64 = (value: Buffer): string => value.toString("base64url");
const relayId = (): string => b64(randomBytes(16));
const isRelayId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9_-]{22}$/.test(value) &&
  Buffer.from(value, "base64url").length === 16 &&
  Buffer.from(value, "base64url").toString("base64url") === value;
const hash = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("base64url");
const fingerprint = (value: string): string => hash(value).slice(0, 26);
const now = (deps: PersonalSyncDependencies): string =>
  (deps.now ?? (() => new Date()))().toISOString();
const pendingPath = (paths: KoedServerPaths): string =>
  resolve(paths.configDir, "personal-sync-pending.json");

const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, i) => key === expected[i])
  );
};

const strictBase64url = (value: unknown, bytes: number): Buffer => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
    fail("Recovery kit encoding is invalid.");
  const encoded = value as string;
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length !== bytes || decoded.toString("base64url") !== encoded)
    fail("Recovery kit encoding is invalid.");
  return decoded;
};

// Fixed member order is canonical for closed recovery-kit descriptor schema.
const recoveryKitMetadata = (kit: RecoveryKit): string =>
  JSON.stringify({
    cipher: { name: kit.cipher.name, nonce: kit.cipher.nonce },
    format: kit.format,
    kdf: {
      N: kit.kdf.N,
      name: kit.kdf.name,
      p: kit.kdf.p,
      r: kit.kdf.r,
      salt: kit.kdf.salt
    },
    version: kit.version
  });

const validateRecoveryKit = (kit: unknown): RecoveryKit => {
  if (!kit || typeof kit !== "object" || Array.isArray(kit))
    fail("Recovery kit format is invalid.");
  const value = kit as Record<string, unknown>;
  if (!exactKeys(value, ["format", "version", "kdf", "cipher", "fingerprint"]))
    fail("Recovery kit format is invalid.");
  const kdf = value.kdf;
  const cipher = value.cipher;
  if (
    value.format !== KIT_FORMAT ||
    value.version !== 1 ||
    typeof value.fingerprint !== "string" ||
    value.fingerprint.length !== 26 ||
    !kdf ||
    typeof kdf !== "object" ||
    Array.isArray(kdf) ||
    !cipher ||
    typeof cipher !== "object" ||
    Array.isArray(cipher) ||
    !exactKeys(kdf as Record<string, unknown>, [
      "name",
      "N",
      "r",
      "p",
      "salt"
    ]) ||
    !exactKeys(cipher as Record<string, unknown>, [
      "name",
      "nonce",
      "ciphertext",
      "tag"
    ]) ||
    (kdf as Record<string, unknown>).name !== "scrypt" ||
    (kdf as Record<string, unknown>).N !== 32768 ||
    (kdf as Record<string, unknown>).r !== 8 ||
    (kdf as Record<string, unknown>).p !== 1 ||
    (cipher as Record<string, unknown>).name !== "aes-256-gcm"
  )
    fail("Recovery kit format is invalid.");
  const parsed = value as unknown as RecoveryKit;
  strictBase64url(parsed.kdf.salt, 16);
  strictBase64url(parsed.cipher.nonce, 12);
  strictBase64url(parsed.cipher.tag, 16);
  const ciphertext = Buffer.from(parsed.cipher.ciphertext, "base64url");
  if (
    !/^[A-Za-z0-9_-]+$/.test(parsed.cipher.ciphertext) ||
    ciphertext.length < 1 ||
    ciphertext.length > MAX_CONTROL_RESPONSE_BYTES ||
    ciphertext.toString("base64url") !== parsed.cipher.ciphertext
  )
    fail("Recovery kit encoding is invalid.");
  return parsed;
};

const deriveKey = (password: Buffer, salt: Buffer): Buffer =>
  scryptSync(password, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });

export const encryptRecoveryKit = (
  plaintext: string,
  password: Buffer
): RecoveryKit => {
  if (!password.length || password.length > MAX_PASSWORD_BYTES)
    fail("Recovery password length is invalid.");
  const kit: RecoveryKit = {
    format: KIT_FORMAT,
    version: 1,
    kdf: { name: "scrypt", N: 32768, r: 8, p: 1, salt: b64(randomBytes(16)) },
    cipher: {
      name: "aes-256-gcm",
      nonce: b64(randomBytes(12)),
      ciphertext: "",
      tag: ""
    },
    fingerprint: fingerprint(plaintext)
  };
  const cipher = createCipheriv(
    "aes-256-gcm",
    deriveKey(password, strictBase64url(kit.kdf.salt, 16)),
    strictBase64url(kit.cipher.nonce, 12)
  );
  cipher.setAAD(Buffer.from(recoveryKitMetadata(kit), "utf8"));
  kit.cipher.ciphertext = b64(
    Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  );
  kit.cipher.tag = b64(cipher.getAuthTag());
  return kit;
};

export const decryptRecoveryKit = (
  input: RecoveryKit,
  password: Buffer
): string => {
  const kit = validateRecoveryKit(input);
  if (!password.length || password.length > MAX_PASSWORD_BYTES)
    fail("Recovery password length is invalid.");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(password, strictBase64url(kit.kdf.salt, 16)),
      strictBase64url(kit.cipher.nonce, 12)
    );
    decipher.setAAD(Buffer.from(recoveryKitMetadata(kit), "utf8"));
    decipher.setAuthTag(strictBase64url(kit.cipher.tag, 16));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(kit.cipher.ciphertext, "base64url")),
      decipher.final()
    ]).toString("utf8");
    if (fingerprint(plaintext) !== kit.fingerprint)
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

const rejectPasswordArguments = (args: string[]): void => {
  if (args.some((arg) => arg === "--password" || arg.startsWith("--password=")))
    fail(
      "Recovery passwords must use --password-stdin or --password-fd; password arguments are forbidden."
    );
};

const flag = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const requiredFlag = (args: string[], name: string): string =>
  flag(args, name)?.trim() || fail(`${name} is required.`);

const readBoundedFd = (
  raw: string | undefined,
  label: string,
  maximum = MAX_CONTROL_RESPONSE_BYTES
): Buffer => {
  const fd = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(fd) || fd < 0)
    fail(`${label} must be a non-negative file descriptor.`);
  const buffer = Buffer.allocUnsafe(maximum + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(fd, buffer, offset, buffer.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  if (offset > maximum) fail(`${label} exceeds maximum size.`);
  return Buffer.from(buffer.subarray(0, offset));
};

const passwordFrom = (args: string[]): Buffer => {
  rejectPasswordArguments(args);
  const fd = flag(args, "--password-fd");
  const stdin = args.includes("--password-stdin");
  if (Boolean(fd) === stdin)
    fail("Use exactly one of --password-stdin or --password-fd.");
  const raw = readBoundedFd(
    stdin ? "0" : fd,
    "--password-fd",
    MAX_PASSWORD_BYTES
  );
  const password = Buffer.from(raw.toString("utf8").replace(/\r?\n$/, ""));
  raw.fill(0);
  if (!password.length || password.length > MAX_PASSWORD_BYTES) {
    password.fill(0);
    fail("Recovery password length is invalid.");
  }
  return password;
};

const secureRegularFile = (path: string): boolean => {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
};

const fsyncDirectory = (path: string): void => {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const stageRecoveryKit = (
  path: string,
  kit: RecoveryKit
): {
  output: string;
  finalize: () => void;
  abort: () => void;
} => {
  const output = resolve(path);
  const directory = dirname(output);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(output)) fail("Recovery kit destination already exists.");
  const temporary = `${output}.${process.pid}.${b64(randomBytes(8))}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(kit, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return {
    output,
    finalize: () => {
      if (existsSync(output)) fail("Recovery kit destination already exists.");
      renameSync(temporary, output);
      fsyncDirectory(directory);
      if (!secureRegularFile(output))
        fail("Recovery kit permissions are unsafe; require 0600.");
    },
    abort: () => {
      if (!existsSync(temporary)) return;
      unlinkSync(temporary);
    }
  };
};

const writeRecoveryKit = (path: string, kit: RecoveryKit): void => {
  const staged = stageRecoveryKit(path, kit);
  try {
    staged.finalize();
  } catch (error) {
    try {
      staged.abort();
    } catch {
      /* cleanup only */
    }
    throw error;
  }
};

const readPending = (paths: KoedServerPaths): PendingState => {
  const path = pendingPath(paths);
  if (!existsSync(path)) return { version: PENDING_VERSION, pending: [] };
  if (!secureRegularFile(path))
    fail("Personal Sync pending state permissions are unsafe.");
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    if (value.version !== PENDING_VERSION || !Array.isArray(value.pending))
      throw new Error();
    const pending = value.pending.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const request = entry as Record<string, unknown>;
      return typeof request.requestId === "string" &&
        typeof request.groupId === "string" &&
        typeof request.createdAt === "string"
        ? [
            {
              requestId: request.requestId,
              groupId: request.groupId,
              createdAt: request.createdAt
            }
          ]
        : [];
    });
    if (
      pending.length !== value.pending.length ||
      pending.length > MAX_PENDING_REQUESTS
    )
      throw new Error();
    return { version: PENDING_VERSION, pending };
  } catch {
    return fail("Personal Sync pending state is unreadable.");
  }
};

const writePending = (paths: KoedServerPaths, state: PendingState): void => {
  const path = pendingPath(paths);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${b64(randomBytes(8))}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(state)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  fsyncDirectory(directory);
};

const controlOrigin = (environment: NodeJS.ProcessEnv): string => {
  const configured = environment.PDS_CONTROL_URL?.trim();
  const origin =
    configured ??
    fail("Personal Sync control API is not configured (PDS_CONTROL_URL). ");
  try {
    const url = new URL(origin);
    if (
      !/^https?:$/.test(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.toString().replace(/\/$/, "");
  } catch {
    return fail(
      "PDS_CONTROL_URL must be an HTTP(S) origin without credentials."
    );
  }
};

const browserOrigin = (environment: NodeJS.ProcessEnv): string => {
  const configured = environment.PDS_BROWSER_ORIGIN?.trim();
  if (!configured)
    fail(
      "Personal Sync browser origin is not configured (PDS_BROWSER_ORIGIN)."
    );
  try {
    const url = new URL(configured as string);
    if (
      !/^https?:$/.test(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    return fail("PDS_BROWSER_ORIGIN must be an HTTP(S) origin.");
  }
};

const browserSession = (environment: NodeJS.ProcessEnv): string => {
  const raw = environment.PDS_BROWSER_SESSION_FD;
  if (raw === undefined)
    fail(
      "PDS browser session FD is required; API Tokens and legacy credentials are rejected."
    );
  const bytes = readBoundedFd(raw, "PDS_BROWSER_SESSION_FD", 16_384);
  const value = bytes.toString("utf8").trim();
  bytes.fill(0);
  if (!value || /[\r\n\0]/.test(value))
    fail("PDS browser session FD is invalid.");
  return value;
};

const strictResponse = async (
  response: Response
): Promise<Record<string, unknown>> => {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_CONTROL_RESPONSE_BYTES)
    fail("PDS control response exceeds maximum size.");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_CONTROL_RESPONSE_BYTES)
    fail("PDS control response exceeds maximum size.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("PDS control response is invalid.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("PDS control response is invalid.");
  if (!response.ok) {
    const body = value as Record<string, unknown>;
    const message =
      typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error
          : null;
    fail(
      message
        ? `PDS control API rejected request: ${message}`
        : `PDS control API rejected request (${response.status}).`
    );
  }
  return value as Record<string, unknown>;
};

const control = async (input: {
  environment: NodeJS.ProcessEnv;
  deps: PersonalSyncDependencies;
  method: "GET" | "POST" | "PUT";
  path: string;
  body?: Record<string, unknown>;
}): Promise<Record<string, unknown>> => {
  const fetcher = input.deps.fetch ?? globalThis.fetch;
  if (!fetcher) fail("PDS control API is unavailable.");
  const desktopAuthorization = input.deps.desktopAuthorization?.trim();
  const pairingToken = input.deps.pairingToken?.trim();
  const sessionCookie =
    desktopAuthorization || pairingToken
      ? null
      : (input.deps.sessionCookie ?? browserSession(input.environment));
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetcher(
    `${controlOrigin(input.environment)}${input.path}`,
    {
      method: input.method,
      headers: {
        accept: "application/json",
        ...(desktopAuthorization
          ? { authorization: desktopAuthorization }
          : pairingToken
            ? {}
            : {
                cookie: sessionCookie as string,
                origin: browserOrigin(input.environment)
              }),
        ...(input.body ? { "content-type": "application/json" } : {})
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      signal: timeout
    }
  );
  return strictResponse(response);
};

const generatedKey = (kind: "ed25519" | "x25519"): GeneratedKey => {
  const pair =
    kind === "ed25519"
      ? generateKeyPairSync("ed25519")
      : generateKeyPairSync("x25519");
  const publicJwk = pair.publicKey.export({ format: "jwk" }) as JsonWebKey;
  const privateJwk = pair.privateKey.export({ format: "jwk" }) as JsonWebKey;
  const publicKey = publicJwk.x;
  const privateSeed = privateJwk.d;
  if (
    typeof publicKey !== "string" ||
    typeof privateSeed !== "string" ||
    publicKey.length !== 43 ||
    privateSeed.length !== 43
  )
    fail(`Generated ${kind} key material is invalid.`);
  return {
    publicKey: publicKey as string,
    privateSeed: privateSeed as string,
    privateKey: pair.privateKey
  };
};

export const personalSyncProviderEnvironment = (
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => ({
  PATH: environment.PATH,
  HOME: environment.HOME,
  USER: environment.USER,
  LANG: environment.LANG,
  LC_ALL: environment.LC_ALL,
  ELECTRON_RUN_AS_NODE:
    environment.PDS_SECRET_PROVIDER?.trim() === "desktop_bridge"
      ? "1"
      : environment.ELECTRON_RUN_AS_NODE,
  PDS_DESKTOP_SECRET_BRIDGE_SOCKET:
    environment.PDS_DESKTOP_SECRET_BRIDGE_SOCKET,
  PDS_DESKTOP_SECRET_BRIDGE_TOKEN: environment.PDS_DESKTOP_SECRET_BRIDGE_TOKEN
});

const providerArgs = (environment: NodeJS.ProcessEnv): string[] => {
  const raw = environment.PDS_SECRET_PROVIDER_COMMAND_ARGS_JSON;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.length > 8 ||
      parsed.some((value) => typeof value !== "string" || value.length > 4096)
    ) {
      throw new Error();
    }
    return parsed as string[];
  } catch {
    fail("PDS secret provider arguments are invalid.");
    return [];
  }
};

const validSecretProvider = (environment: NodeJS.ProcessEnv): boolean =>
  environment.PDS_SECRET_PROVIDER?.trim() === "headless" ||
  environment.PDS_SECRET_PROVIDER?.trim() === "desktop_bridge";

const runSecretProvider = async (
  operation: "get" | "put" | "delete",
  reference: string,
  environment: NodeJS.ProcessEnv,
  value?: string
): Promise<{ ok: boolean; stdout: string }> => {
  const command = environment.PDS_SECRET_PROVIDER_COMMAND?.trim();
  if (
    !validSecretProvider(environment) ||
    !command ||
    !/^[^\s\r\n\0]+$/.test(command) ||
    !/^[^\r\n\0]{1,240}$/.test(reference)
  )
    fail("A valid PDS secret provider is required.");
  return await new Promise((resolvePromise) => {
    const child = spawn(
      command as string,
      [...providerArgs(environment), operation, reference],
      {
        env: personalSyncProviderEnvironment(environment),
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true
      }
    );
    let stdout = "";
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise({ ok, stdout });
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_CONTROL_RESPONSE_BYTES) {
        child.kill();
        finish(false);
      }
    });
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    child.stdin.end(value ?? "");
  });
};

const putProviderSecret = async (
  reference: string,
  value: string,
  environment: NodeJS.ProcessEnv
): Promise<void> => {
  const result = await runSecretProvider("put", reference, environment, value);
  if (!result.ok) fail("PDS secret provider rejected runtime material.");
};

const getProviderSecret = async (
  reference: string,
  environment: NodeJS.ProcessEnv
): Promise<string | null> => {
  const result = await runSecretProvider("get", reference, environment);
  return result.ok && result.stdout.length > 0 ? result.stdout : null;
};

const deleteProviderSecret = async (
  reference: string,
  environment: NodeJS.ProcessEnv
): Promise<void> => {
  const result = await runSecretProvider("delete", reference, environment);
  if (!result.ok)
    fail("PDS secret provider could not delete pending material.");
};

const pendingSecretReference = (
  runtimeReference: string,
  challengeId: string
): string =>
  `pds-pending-${hash(runtimeReference).slice(0, 20)}-${challengeId}`;

const parsedSecret = <T>(
  raw: string | null,
  expectedKeys: string[] | string[][],
  label: string
): T => {
  if (!raw || Buffer.byteLength(raw, "utf8") > MAX_CONTROL_RESPONSE_BYTES)
    fail(`${label} is unavailable.`);
  try {
    const value = JSON.parse(raw as string) as Record<string, unknown>;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !(Array.isArray(expectedKeys[0])
        ? (expectedKeys as string[][]).some((keys) => exactKeys(value, keys))
        : exactKeys(value, expectedKeys as string[]))
    )
      fail(`${label} is invalid.`);
    return value as T;
  } catch (error) {
    if (error instanceof Error && error.message === `${label} is invalid.`)
      throw error;
    return fail(`${label} is invalid.`);
  }
};

const runtimeSecret = async (
  reference: string,
  environment: NodeJS.ProcessEnv,
  deps: PersonalSyncDependencies
): Promise<RuntimeSecret> => {
  const value = parsedSecret<RuntimeSecret>(
    await (deps.getSecret ?? getProviderSecret)(reference, environment),
    [
      [
        "version",
        "userId",
        "relayUrl",
        "groupId",
        "device",
        "authority",
        "recovery",
        "certificate",
        "recipientCertificates",
        "groupSecrets"
      ],
      [
        "version",
        "userId",
        "relayUrl",
        "groupId",
        "device",
        "authority",
        "recovery",
        "certificate",
        "recipientCertificates",
        "historicalOriginCertificates",
        "groupSecrets"
      ]
    ],
    "PDS runtime secret"
  );
  if (
    value.version !== 1 ||
    !Object.values(value.device).every(strictString) ||
    !Object.values(value.authority).every(strictString) ||
    !Object.values(value.recovery).every(strictString) ||
    !Object.values(value.groupSecrets).every(strictString) ||
    !Array.isArray(value.recipientCertificates) ||
    !value.recipientCertificates.every(strictString) ||
    (value.historicalOriginCertificates !== undefined &&
      (!Array.isArray(value.historicalOriginCertificates) ||
        !value.historicalOriginCertificates.every(strictString)))
  )
    fail("PDS runtime secret is invalid.");
  return value;
};

const optionalRuntimeSecret = async (
  reference: string,
  environment: NodeJS.ProcessEnv,
  deps: PersonalSyncDependencies
): Promise<RuntimeSecret | null> => {
  const raw = await (deps.getSecret ?? getProviderSecret)(
    reference,
    environment
  );
  if (raw === null) return null;
  return await runtimeSecret(reference, environment, {
    ...deps,
    getSecret: () => raw
  });
};

const certificateDeviceId = (certificate: string): string => {
  const parsed = parseCanonicalPdsJson(certificate);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("PDS membership certificate is invalid.");
  }
  const deviceId = (parsed as Record<string, unknown>).deviceId;
  if (typeof deviceId !== "string") {
    fail("PDS membership certificate is invalid.");
  }
  return deviceId as string;
};

const validatedRuntimeSecret = (
  runtime: Omit<RuntimeSecret, "certificate" | "recipientCertificates">,
  certificates: string[]
): RuntimeSecret => {
  if (!isRelayId(runtime.device.originDeploymentId)) {
    fail("PDS origin deployment identity is invalid.");
  }
  const ordered = certificates
    .map((certificate) => ({
      certificate,
      deviceId: certificateDeviceId(certificate)
    }))
    .sort((left, right) =>
      Buffer.from(left.deviceId, "ascii").compare(
        Buffer.from(right.deviceId, "ascii")
      )
    );
  if (
    ordered.length === 0 ||
    new Set(ordered.map(({ deviceId }) => deviceId)).size !== ordered.length
  ) {
    fail("PDS membership certificate set is invalid.");
  }
  const own =
    ordered.find(({ deviceId }) => deviceId === runtime.device.id) ??
    fail("PDS local membership certificate is unavailable.");
  const candidate: RuntimeSecret = {
    ...runtime,
    certificate: own.certificate,
    recipientCertificates: ordered.map(({ certificate }) => certificate)
  };
  createPdsSessionPackageRuntimeContext({
    authorityPublicKey: candidate.authority.publicKey,
    authorityKeyId: candidate.authority.keyId,
    groupId: candidate.groupId,
    authorityHead: candidate.authority.head,
    currentEpoch: candidate.groupSecrets.currentEpoch,
    servingCertificate: candidate.certificate,
    recipientCertificate: candidate.certificate,
    recipientCertificates: candidate.recipientCertificates,
    historicalOriginCertificates: candidate.historicalOriginCertificates
  });
  return candidate;
};

const pendingEnrollmentSecret = async (
  reference: string,
  environment: NodeJS.ProcessEnv,
  deps: PersonalSyncDependencies
): Promise<PendingEnrollmentSecret> => {
  const value = parsedSecret<PendingEnrollmentSecret>(
    await (deps.getSecret ?? getProviderSecret)(reference, environment),
    [
      "version",
      "groupId",
      "userId",
      "browserDeploymentId",
      "localDeploymentId",
      "relayUrl",
      "originDeploymentId",
      "deviceId",
      "signingKeyId",
      "signingPublicKey",
      "signingPrivateSeed",
      "kemKeyId",
      "kemPublicKey",
      "kemPrivateSeed",
      "authorityKeyId",
      "authorityPublicKey",
      "challengeId",
      "challenge",
      "expiresAt"
    ],
    "PDS pending enrollment secret"
  );
  if (
    value.version !== 1 ||
    !Object.entries(value)
      .filter(([key]) => key !== "version")
      .every(([, field]) => strictString(field)) ||
    !isRelayId(value.originDeploymentId)
  )
    fail("PDS pending enrollment secret is invalid.");
  return value;
};

const challengeBinding = async (input: {
  groupId?: string;
  challenge: string;
  environment: NodeJS.ProcessEnv;
  deps: PersonalSyncDependencies;
}): Promise<{
  id: string;
  expiresAt: string;
  browserSubjectId: string;
  browserDeploymentId: string;
  authorityKeyId: string;
  authorityPublicKey: string;
}> => {
  const response = await control({
    environment: input.environment,
    deps: input.deps,
    method: "POST",
    path: "/v1/personal-device-sync/challenges",
    body: {
      ...(input.groupId ? { group_id: input.groupId } : {}),
      challenge_hash: pdsSha256(Buffer.from(input.challenge, "base64url"))
    }
  });
  const challenge = object(response.challenge, "challenge");
  const authority = object(challenge.authority, "challenge.authority");
  const values = {
    id: challenge.id,
    expiresAt: challenge.expires_at,
    browserSubjectId: challenge.browser_subject_id,
    browserDeploymentId: challenge.browser_deployment_id,
    authorityKeyId: authority.key_id,
    authorityPublicKey: authority.public_key
  };
  if (!Object.values(values).every((value) => typeof value === "string"))
    fail("PDS control response challenge binding is invalid.");
  strictBase64url(values.authorityPublicKey as string, 32);
  return values as {
    id: string;
    expiresAt: string;
    browserSubjectId: string;
    browserDeploymentId: string;
    authorityKeyId: string;
    authorityPublicKey: string;
  };
};

const pairingInvitationBinding = (
  invitation: Record<string, unknown>,
  groupId: string
): {
  challenge: string;
  id: string;
  expiresAt: string;
  browserSubjectId: string;
  browserDeploymentId: string;
  authorityKeyId: string;
  authorityPublicKey: string;
} => {
  if (
    !exactKeys(invitation, [
      "protocol",
      "group_id",
      "challenge_id",
      "challenge",
      "expires_at",
      "browser_subject_id",
      "browser_deployment_id",
      "authority",
      "control_url",
      "relay_url"
    ]) ||
    invitation.protocol !== "koed/pds-lan-pair/v1" ||
    invitation.group_id !== groupId
  ) {
    fail("PDS pairing invitation is invalid.");
  }
  const authority = object(
    invitation.authority,
    "pairing invitation authority"
  );
  if (!exactKeys(authority, ["key_id", "public_key"])) {
    fail("PDS pairing invitation authority is invalid.");
  }
  const values = {
    challenge: invitation.challenge,
    id: invitation.challenge_id,
    expiresAt: invitation.expires_at,
    browserSubjectId: invitation.browser_subject_id,
    browserDeploymentId: invitation.browser_deployment_id,
    authorityKeyId: authority.key_id,
    authorityPublicKey: authority.public_key
  };
  if (!Object.values(values).every(strictString)) {
    fail("PDS pairing invitation is invalid.");
  }
  strictBase64url(values.challenge as string, 32);
  strictBase64url(values.authorityPublicKey as string, 32);
  const expiresAt = new Date(values.expiresAt as string);
  const remaining = expiresAt.getTime() - Date.now();
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    remaining <= 0 ||
    remaining > 10 * 60 * 1_000
  ) {
    fail("PDS pairing invitation is expired or has an invalid lifetime.");
  }
  for (const [field, value] of [
    ["control", invitation.control_url],
    ["relay", invitation.relay_url]
  ] as const) {
    try {
      const url = new URL(value as string);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error();
      }
    } catch {
      fail(`PDS pairing invitation ${field} URL is invalid.`);
    }
  }
  return values as {
    challenge: string;
    id: string;
    expiresAt: string;
    browserSubjectId: string;
    browserDeploymentId: string;
    authorityKeyId: string;
    authorityPublicKey: string;
  };
};

const createPairingInvitation = async (
  args: string[],
  environment: NodeJS.ProcessEnv,
  deps: PersonalSyncDependencies
): Promise<PersonalSyncResult> => {
  const groupId = groupIdFrom(args);
  const runtimeReference =
    environment.PDS_RUNTIME_SECRET_REF?.trim() ||
    fail("PDS_RUNTIME_SECRET_REF is required for pairing.");
  const runtime = await runtimeSecret(runtimeReference, environment, deps);
  if (runtime.groupId !== groupId) {
    fail("PDS pairing invitation targets another group.");
  }
  const challenge = b64(randomBytes(32));
  const binding = await challengeBinding({
    groupId,
    challenge,
    environment,
    deps
  });
  return {
    ok: true,
    state: "inviting",
    message: "Pairing invitation created.",
    invitation: {
      protocol: "koed/pds-lan-pair/v1",
      group_id: groupId,
      challenge_id: binding.id,
      challenge,
      expires_at: binding.expiresAt,
      browser_subject_id: binding.browserSubjectId,
      browser_deployment_id: binding.browserDeploymentId,
      authority: {
        key_id: binding.authorityKeyId,
        public_key: binding.authorityPublicKey
      },
      relay_url: controlOrigin(environment)
    }
  };
};

const enrollmentProof = (input: {
  challengeId: string;
  challenge: string;
  groupId?: string;
  deviceId: string;
  signingKeyId: string;
  signingPublicKey: string;
  kemKeyId: string;
  kemPublicKey: string;
  browserSubjectId: string;
  browserDeploymentId: string;
  expiresAt: string;
  signingPrivateKey: KeyObject;
}) => {
  const unsigned = {
    challengeId: input.challengeId,
    challenge: input.challenge,
    groupId: input.groupId ?? null,
    deviceId: input.deviceId,
    deviceSigningKeyId: input.signingKeyId,
    deviceSigningPublicKey: input.signingPublicKey,
    deviceKemKeyId: input.kemKeyId,
    deviceKemPublicKey: input.kemPublicKey,
    browserSubjectId: input.browserSubjectId,
    browserDeploymentId: input.browserDeploymentId,
    expiresAt: input.expiresAt
  };
  return {
    challenge_id: input.challengeId,
    challenge: input.challenge,
    device_id: input.deviceId,
    signature: sign(
      null,
      Buffer.from(
        `${PDS_PROTOCOL}/enrollment-proof\n${canonicalizePdsJson(unsigned)}`,
        "utf8"
      ),
      input.signingPrivateKey
    ).toString("base64url"),
    expires_at: input.expiresAt
  };
};

const bootstrapGroup = async (
  args: string[],
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  deps: PersonalSyncDependencies
): Promise<PersonalSyncResult> => {
  const controlDeps =
    deps.desktopAuthorization || deps.pairingToken
      ? deps
      : {
          ...deps,
          sessionCookie: deps.sessionCookie ?? browserSession(environment)
        };
  const recoveryKitPath = requiredFlag(args, "--recovery-kit");
  const runtimeSecretRef =
    flag(args, "--runtime-secret-ref")?.trim() ||
    environment.PDS_RUNTIME_SECRET_REF?.trim() ||
    fail(
      "PDS_RUNTIME_SECRET_REF or --runtime-secret-ref is required for bootstrap."
    );
  const password = passwordFrom(args);
  const identity =
    deps.identity ?? (await ensureDeviceIdentity(paths, { environment }));
  if (
    !identity.remoteOperationsAllowed ||
    !identity.deploymentId ||
    !identity.deviceInstanceId
  ) {
    password.fill(0);
    fail("A healthy Koed device identity is required for bootstrap.");
  }
  const deviceInstanceId = relayId();
  const groupId = relayId();
  const signingKey = generatedKey("ed25519");
  const kemKey = generatedKey("x25519");
  const recoverySigningKey = generatedKey("ed25519");
  const recoveryKemKey = generatedKey("x25519");
  const challengeValue = b64(randomBytes(32));
  const binding = await challengeBinding({
    challenge: challengeValue,
    environment,
    deps: controlDeps
  });
  const signingKeyId = relayId();
  const kemKeyId = relayId();
  const recoverySigningKeyId = relayId();
  const recoveryKemKeyId = relayId();
  const groupSecrets = {
    currentEpoch: "1",
    contentKey: b64(randomBytes(32)),
    sourceFingerprintKey: b64(randomBytes(32)),
    tombstoneFloorKey: b64(randomBytes(32)),
    projectAliasKey: b64(randomBytes(32))
  };
  const recoveryPayload = {
    version: 1,
    groupId,
    recoverySigningKeyId,
    recoverySigningPublicKey: recoverySigningKey.publicKey,
    recoverySigningPrivateSeed: recoverySigningKey.privateSeed,
    recoveryKemKeyId,
    recoveryKemPublicKey: recoveryKemKey.publicKey,
    recoveryKemPrivateSeed: recoveryKemKey.privateSeed,
    groupSecrets
  };
  const recoveryPlaintext = JSON.stringify(recoveryPayload);
  const kit = encryptRecoveryKit(recoveryPlaintext, password);
  let stagedRecoveryKit: ReturnType<typeof stageRecoveryKit> | undefined;
  try {
    if (decryptRecoveryKit(kit, password) !== recoveryPlaintext)
      fail("Recovery kit round-trip verification failed.");
    stagedRecoveryKit = stageRecoveryKit(recoveryKitPath, kit);
  } finally {
    password.fill(0);
  }
  const draft = {
    protocol: PDS_PROTOCOL,
    kind: "genesis",
    groupId,
    sequence: "1",
    previousHash: null,
    body: {
      authorityKeyId: binding.authorityKeyId,
      authorityPublicKey: binding.authorityPublicKey,
      recoverySigningKeyId,
      recoverySigningPublicKey: recoverySigningKey.publicKey,
      recoveryKemKeyId,
      recoveryKemPublicKey: recoveryKemKey.publicKey,
      recoveryKitHash: pdsSha256(recoveryPlaintext),
      recoveryKitVerified: true,
      initialDeviceId: deviceInstanceId,
      initialDeviceSigningKeyId: signingKeyId,
      initialDeviceSigningPublicKey: signingKey.publicKey,
      initialDeviceKemKeyId: kemKeyId,
      initialDeviceKemPublicKey: kemKey.publicKey,
      operationFamilies: ["pds_relay"],
      initialEpoch: "1",
      initialKeyCommitment: pdsSha256(
        Buffer.from(groupSecrets.contentKey, "base64url")
      )
    }
  };
  const statement = {
    draft,
    authorization: {
      signerKeyId: signingKeyId,
      signature: signPdsGroupDraft(draft, signingKey.privateKey)
    }
  };
  validatePdsGroupStatement(statement, {
    authorizationPublicKey: signingKey.publicKey,
    expectedAuthorizationKeyId: signingKeyId,
    expectedGroupId: groupId,
    expectedPreviousHash: null,
    expectedSequence: "1"
  });
  const proof = enrollmentProof({
    challengeId: binding.id,
    challenge: challengeValue,
    groupId,
    deviceId: deviceInstanceId,
    signingKeyId,
    signingPublicKey: signingKey.publicKey,
    kemKeyId,
    kemPublicKey: kemKey.publicKey,
    browserSubjectId: binding.browserSubjectId,
    browserDeploymentId: binding.browserDeploymentId,
    expiresAt: binding.expiresAt,
    signingPrivateKey: signingKey.privateKey
  });
  let created: Record<string, unknown>;
  try {
    created = await control({
      environment,
      deps: controlDeps,
      method: "POST",
      path: "/v1/personal-device-sync/groups/genesis",
      body: {
        statement: canonicalizePdsJson(statement),
        proof,
        first_device: {
          device_id: deviceInstanceId,
          signing_key_id: signingKeyId,
          signing_public_key: signingKey.publicKey,
          kem_key_id: kemKeyId,
          kem_public_key: kemKey.publicKey,
          operation_families: ["pds_relay"]
        }
      }
    });
    stagedRecoveryKit.finalize();
  } catch (error) {
    try {
      stagedRecoveryKit?.abort();
    } catch {
      /* cleanup only */
    }
    throw error;
  }
  const group = object(created.group, "group");
  const head = object(group.head, "group.head");
  if (
    group.group_id !== groupId ||
    typeof head.hash !== "string" ||
    group.current_epoch !== "1"
  )
    fail("PDS genesis response is invalid.");
  const headHash = head.hash as string;
  const certificateResponse = await control({
    environment,
    deps: controlDeps,
    method: "GET",
    path: `/v1/personal-device-sync/groups/${encodeURIComponent(groupId)}/certificates/${encodeURIComponent(deviceInstanceId)}`
  });
  const certificate = object(certificateResponse.certificate, "certificate");
  const runtime = validatedRuntimeSecret(
    {
      version: 1,
      userId: binding.browserSubjectId,
      relayUrl: controlOrigin(environment),
      groupId,
      device: {
        id: deviceInstanceId,
        originDeploymentId: relayId(),
        signingKeyId,
        signingPrivateSeed: signingKey.privateSeed,
        kemKeyId,
        kemPrivateSeed: kemKey.privateSeed
      },
      authority: {
        keyId: binding.authorityKeyId,
        publicKey: binding.authorityPublicKey,
        head: headHash
      },
      recovery: {
        signingKeyId: recoverySigningKeyId,
        signingPublicKey: recoverySigningKey.publicKey
      },
      groupSecrets
    },
    [canonicalizePdsJson(certificate)]
  );
  await (deps.putSecret ?? putProviderSecret)(
    runtimeSecretRef,
    JSON.stringify(runtime),
    environment
  );
  await control({
    environment,
    deps: controlDeps,
    method: "PUT",
    path: `/v1/personal-device-sync/groups/${encodeURIComponent(groupId)}/policy`,
    body: {
      enabled: true,
      future_closed_sessions_only: true,
      historical_backfill_enabled: false
    }
  });
  return {
    ok: true,
    state: "active",
    message: "Personal Device Group created. The secure runtime is active.",
    groupId,
    deviceId: deviceInstanceId,
    recoveryKit: resolve(recoveryKitPath)
  };
};

const groupIdFrom = (args: string[]): string => {
  const groupId = requiredFlag(args, "--group-id");
  if (!/^[\x21-\x7e]{1,240}$/.test(groupId)) fail("--group-id is invalid.");
  return groupId;
};

const object = (value: unknown, field: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`PDS control response ${field} is invalid.`);
  return value as Record<string, unknown>;
};

const status = async (
  environment: NodeJS.ProcessEnv,
  deps: PersonalSyncDependencies
): Promise<PersonalSyncResult> => {
  const runtimeReference = environment.PDS_RUNTIME_SECRET_REF?.trim();
  const runtime = runtimeReference
    ? await optionalRuntimeSecret(runtimeReference, environment, deps)
    : null;
  try {
    const response = await control({
      environment,
      deps,
      method: "GET",
      path: "/v1/personal-device-sync/groups"
    });
    if (!Array.isArray(response.groups))
      fail("PDS control response groups is invalid.");
    if (
      !Array.isArray(response.pairing_invitation_group_ids) ||
      response.pairing_invitation_group_ids.some(
        (groupId) => typeof groupId !== "string"
      )
    ) {
      fail("PDS control response pairing capability is invalid.");
    }
    const groups = response.groups as unknown[];
    if (groups.length || !runtime) {
      return {
        ok: true,
        state: "backend",
        message: "Personal Sync status is Authority-owned.",
        groups,
        pairing_invitation_group_ids:
          response.pairing_invitation_group_ids as string[]
      };
    }
    return {
      ok: true,
      state: "local_binding_missing",
      message:
        "A protected Personal Sync runtime exists, but this local Personal database is not enrolled in its group.",
      groups: [],
      pairing_invitation_group_ids: [],
      recoveryRequired: true
    };
  } catch (error) {
    if (!runtime) throw error;
  }
  const verified = createPdsSessionPackageRuntimeContext({
    authorityPublicKey: runtime.authority.publicKey,
    authorityKeyId: runtime.authority.keyId,
    groupId: runtime.groupId,
    authorityHead: runtime.authority.head,
    currentEpoch: runtime.groupSecrets.currentEpoch,
    servingCertificate: runtime.certificate,
    recipientCertificate: runtime.certificate,
    recipientCertificates: runtime.recipientCertificates,
    historicalOriginCertificates: runtime.historicalOriginCertificates
  });
  return {
    ok: true,
    state: "runtime_cached",
    message:
      "Personal Sync status is using the last cryptographically verified Authority state.",
    pairing_invitation_group_ids: [],
    groups: [
      {
        group_id: runtime.groupId,
        authority_key_id: runtime.authority.keyId,
        authority_public_key: runtime.authority.publicKey,
        current_epoch: runtime.groupSecrets.currentEpoch,
        pending_epoch: null,
        head: { hash: runtime.authority.head },
        state: "active",
        members: verified.recipients.map((member) => ({
          device_id: member.deviceId,
          signing_key_id: member.signingKeyId,
          signing_public_key: member.signingPublicKey,
          kem_key_id: member.kemKeyId,
          kem_public_key: member.kemPublicKey,
          operation_families: ["pds_relay"],
          status: "active"
        })),
        policy: {
          enabled: true,
          future_closed_sessions_only: true,
          historical_backfill_enabled: false
        }
      }
    ]
  };
};

const createJoinChallenge = async (
  args: string[],
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  deps: PersonalSyncDependencies
): Promise<PersonalSyncResult> => {
  const groupId = groupIdFrom(args);
  const runtimeSecretRef =
    environment.PDS_RUNTIME_SECRET_REF?.trim() ||
    fail("PDS_RUNTIME_SECRET_REF is required for enrollment.");
  const identity =
    deps.identity ?? (await ensureDeviceIdentity(paths, { environment }));
  if (
    !identity.remoteOperationsAllowed ||
    !identity.deviceInstanceId ||
    !identity.deploymentId
  )
    fail("A healthy Koed device identity is required for enrollment.");
  const deploymentId = identity.deploymentId as string;
  const invitationFd = flag(args, "--invitation-fd");
  const suppliedInvitation = invitationFd
    ? readJsonFd(args, "--invitation-fd")
    : null;
  const generatedChallenge = suppliedInvitation ? null : b64(randomBytes(32));
  const binding = suppliedInvitation
    ? pairingInvitationBinding(suppliedInvitation, groupId)
    : await challengeBinding({
        groupId,
        challenge: generatedChallenge as string,
        environment,
        deps
      });
  const challengeValue =
    "challenge" in binding
      ? (binding.challenge as string)
      : (generatedChallenge as string);
  const pendingSecretRef = pendingSecretReference(runtimeSecretRef, binding.id);
  const existingPendingRaw = suppliedInvitation
    ? await (deps.getSecret ?? getProviderSecret)(pendingSecretRef, environment)
    : null;
  const existingPending = existingPendingRaw
    ? await pendingEnrollmentSecret(pendingSecretRef, environment, deps)
    : null;
  if (
    existingPending &&
    (existingPending.groupId !== groupId ||
      existingPending.userId !== binding.browserSubjectId ||
      existingPending.browserDeploymentId !== binding.browserDeploymentId ||
      existingPending.localDeploymentId !== deploymentId ||
      existingPending.authorityKeyId !== binding.authorityKeyId ||
      existingPending.authorityPublicKey !== binding.authorityPublicKey ||
      existingPending.challengeId !== binding.id ||
      existingPending.challenge !== challengeValue ||
      existingPending.expiresAt !== binding.expiresAt)
  ) {
    fail("PDS pending enrollment does not match the pairing invitation.");
  }
  const deviceInstanceId = existingPending?.deviceId ?? relayId();
  const originDeploymentId = existingPending?.originDeploymentId ?? relayId();
  const signingKey = existingPending
    ? {
        publicKey: existingPending.signingPublicKey,
        privateSeed: existingPending.signingPrivateSeed,
        privateKey: pdsEd25519PrivateKey(
          existingPending.signingPrivateSeed,
          existingPending.signingPublicKey
        )
      }
    : generatedKey("ed25519");
  const kemKey = existingPending
    ? {
        publicKey: existingPending.kemPublicKey,
        privateSeed: existingPending.kemPrivateSeed
      }
    : generatedKey("x25519");
  const signingKeyId = existingPending?.signingKeyId ?? relayId();
  const kemKeyId = existingPending?.kemKeyId ?? relayId();
  const proof = enrollmentProof({
    challengeId: binding.id,
    challenge: challengeValue,
    groupId,
    deviceId: deviceInstanceId,
    signingKeyId,
    signingPublicKey: signingKey.publicKey,
    kemKeyId,
    kemPublicKey: kemKey.publicKey,
    browserSubjectId: binding.browserSubjectId,
    browserDeploymentId: binding.browserDeploymentId,
    expiresAt: binding.expiresAt,
    signingPrivateKey: signingKey.privateKey
  });
  await (deps.putSecret ?? putProviderSecret)(
    pendingSecretRef,
    JSON.stringify({
      version: 1,
      groupId,
      userId: binding.browserSubjectId,
      browserDeploymentId: binding.browserDeploymentId,
      localDeploymentId: deploymentId,
      relayUrl:
        suppliedInvitation && typeof suppliedInvitation.relay_url === "string"
          ? suppliedInvitation.relay_url
          : controlOrigin(environment),
      originDeploymentId,
      deviceId: deviceInstanceId,
      signingKeyId,
      signingPublicKey: signingKey.publicKey,
      signingPrivateSeed: signingKey.privateSeed,
      kemKeyId,
      kemPublicKey: kemKey.publicKey,
      kemPrivateSeed: kemKey.privateSeed,
      authorityKeyId: binding.authorityKeyId,
      authorityPublicKey: binding.authorityPublicKey,
      challengeId: binding.id,
      challenge: challengeValue,
      expiresAt: binding.expiresAt
    }),
    environment
  );
  const pending = readPending(paths);
  const next = pending.pending.filter(
    (entry) => entry.requestId !== binding.id
  );
  next.push({ requestId: binding.id, groupId, createdAt: now(deps) });
  writePending(paths, {
    version: PENDING_VERSION,
    pending: next.slice(-MAX_PENDING_REQUESTS)
  });
  return {
    ok: true,
    state: "pending",
    message: "Pairing request is pending backend approval.",
    pairing: {
      challengeId: binding.id,
      shortCode: binding.id.replace(/-/g, "").slice(0, 8).toUpperCase()
    },
    request: {
      group_id: groupId,
      device_id: deviceInstanceId,
      signing_key_id: signingKeyId,
      signing_public_key: signingKey.publicKey,
      kem_key_id: kemKeyId,
      kem_public_key: kemKey.publicKey,
      operation_families: ["pds_relay"],
      proof
    }
  };
};

const groupMembers = (
  group: Record<string, unknown>
): Array<Record<string, unknown>> => {
  if (!Array.isArray(group.members))
    fail("PDS control response group members are invalid.");
  return (group.members as unknown[]).map((member) =>
    object(member, "group member")
  );
};

const responseString = (
  value: Record<string, unknown>,
  field: string
): string =>
  strictString(value[field])
    ? (value[field] as string)
    : fail(`PDS control response ${field} is invalid.`);

const groupMember = (
  group: Record<string, unknown>,
  deviceId: string
): Record<string, unknown> =>
  groupMembers(group).find(
    (member) => member.device_id === deviceId && member.status === "active"
  ) ?? fail("PDS active device is not a current group member.");

const epochAck = (input: {
  groupId: string;
  bundleHash: string;
  epoch: string;
  deviceId: string;
  kemKeyId: string;
  kemPublicKey: string;
  signingKeyId: string;
  signingPrivateKey: KeyObject;
  acknowledgedAt: string;
}): string => {
  const unsigned = {
    protocol: PDS_PROTOCOL,
    groupId: input.groupId,
    bundleHash: input.bundleHash,
    deviceId: input.deviceId,
    recipientKemKeyId: input.kemKeyId,
    recipientKemPublicKeyCommitment: pdsPublicKeyCommitment(input.kemPublicKey),
    epoch: input.epoch,
    acknowledgedAt: input.acknowledgedAt
  };
  return canonicalizePdsJson({
    ...unsigned,
    signature: {
      signerKeyId: input.signingKeyId,
      signature: signPdsRecord(
        "key-bundle-ack",
        unsigned,
        input.signingPrivateKey
      )
    }
  });
};

const approveActiveDevice = async (
  args: string[],
  environment: NodeJS.ProcessEnv,
  deps: PersonalSyncDependencies
): Promise<PersonalSyncResult> => {
  const runtimeReference =
    environment.PDS_RUNTIME_SECRET_REF?.trim() ||
    fail("PDS_RUNTIME_SECRET_REF is required for approval.");
  const activeRuntime = await runtimeSecret(
    runtimeReference,
    environment,
    deps
  );
  const requestContainer = readJsonFd(args, "--request-fd");
  const request = object(
    requestContainer.request ?? requestContainer,
    "pairing request"
  );
  const groupId =
    typeof request.group_id === "string" ? request.group_id.trim() : "";
  if (groupId !== activeRuntime.groupId)
    fail("PDS pairing request targets another group.");
  const controlDeps =
    deps.desktopAuthorization || deps.pairingToken
      ? deps
      : {
          ...deps,
          sessionCookie: deps.sessionCookie ?? browserSession(environment)
        };
  const currentResponse = await control({
    environment,
    deps: controlDeps,
    method: "GET",
    path: `/v1/personal-device-sync/groups/${encodeURIComponent(groupId)}`
  });
  const current = object(currentResponse.group, "group");
  if (
    current.state !== "active" ||
    current.pending_epoch !== null ||
    typeof current.current_epoch !== "string"
  )
    fail("PDS group is not ready for membership transition.");
  const sourceMember = groupMember(current, activeRuntime.device.id);
  const recovery = object(current.recovery, "group.recovery");
  const newDevice = {
    deviceId: responseString(request, "device_id"),
    signingKeyId: responseString(request, "signing_key_id"),
    signingPublicKey: responseString(request, "signing_public_key"),
    kemKeyId: responseString(request, "kem_key_id"),
    kemPublicKey: responseString(request, "kem_public_key")
  };
  if (
    !Object.values(newDevice).every(strictString) ||
    !request.proof ||
    typeof request.proof !== "object" ||
    Array.isArray(request.proof)
  )
    fail("PDS pairing request is invalid.");
  const nextEpoch = (BigInt(current.current_epoch as string) + 1n).toString();
  const nextSecrets = {
    epochSecret: b64(randomBytes(32)),
    sourceFingerprintKey: b64(randomBytes(32)),
    tombstoneFloorKey: b64(randomBytes(32)),
    projectAliasKey: b64(randomBytes(32))
  };
  const recipients = [
    ...groupMembers(current).map((member) => ({
      recipientId: responseString(member, "device_id"),
      recipientKind: "device" as const,
      recipientKemKeyId: responseString(member, "kem_key_id"),
      recipientKemPublicKey: responseString(member, "kem_public_key")
    })),
    {
      recipientId: newDevice.deviceId,
      recipientKind: "device" as const,
      recipientKemKeyId: newDevice.kemKeyId,
      recipientKemPublicKey: newDevice.kemPublicKey
    },
    {
      recipientId: responseString(recovery, "kem_key_id"),
      recipientKind: "recovery" as const,
      recipientKemKeyId: responseString(recovery, "kem_key_id"),
      recipientKemPublicKey: responseString(recovery, "kem_public_key")
    }
  ];
  const sourceSigningKey = pdsEd25519PrivateKey(
    activeRuntime.device.signingPrivateSeed,
    responseString(sourceMember, "signing_public_key")
  );
  const authorizedBundle = createPdsAuthorizedKeyBundle({
    groupId,
    epoch: nextEpoch,
    transitionKind: "add-device",
    recipients,
    secrets: nextSecrets,
    authorizationKeyId: activeRuntime.device.signingKeyId,
    authorizationPrivateKey: sourceSigningKey
  });
  const head = object(current.head, "group.head");
  if (typeof head.hash !== "string" || typeof head.sequence !== "string")
    fail("PDS group head is invalid.");
  const headHash = head.hash as string;
  const headSequence = head.sequence as string;
  const draft = {
    protocol: PDS_PROTOCOL,
    kind: "add-device",
    groupId,
    sequence: (BigInt(headSequence) + 1n).toString(),
    previousHash: headHash,
    body: {
      deviceId: newDevice.deviceId,
      deviceSigningKeyId: newDevice.signingKeyId,
      deviceSigningPublicKey: newDevice.signingPublicKey,
      deviceKemKeyId: newDevice.kemKeyId,
      deviceKemPublicKey: newDevice.kemPublicKey,
      operationFamilies: ["pds_relay"],
      previousEpoch: current.current_epoch,
      nextEpoch,
      keyBundleHash: authorizedBundle.authorizationHash
    }
  };
  const statement = {
    draft,
    authorization: {
      signerKeyId: activeRuntime.device.signingKeyId,
      signature: signPdsGroupDraft(draft, sourceSigningKey)
    }
  };
  const transitioned = await control({
    environment,
    deps: controlDeps,
    method: "POST",
    path: `/v1/personal-device-sync/groups/${encodeURIComponent(groupId)}/transitions`,
    body: {
      statement: canonicalizePdsJson(statement),
      key_bundle: canonicalizePdsJson(authorizedBundle.bundle),
      proof: request.proof as Record<string, unknown>
    }
  });
  const pendingGroup = object(transitioned.group, "group");
  const finalizedBundle = object(transitioned.key_bundle, "key_bundle");
  if (
    pendingGroup.pending_epoch !== nextEpoch ||
    pendingGroup.pending_bundle_hash !== authorizedBundle.authorizationHash
  )
    fail("PDS transition did not enter the expected pending epoch.");
  const decrypted = decryptPdsKeyBundleSecretSet({
    bundle: finalizedBundle,
    authorizationPublicKey: responseString(sourceMember, "signing_public_key"),
    authorityPublicKey: activeRuntime.authority.publicKey,
    recipientId: activeRuntime.device.id,
    recipientKemKeyId: activeRuntime.device.kemKeyId,
    recipientKemPublicKey: responseString(sourceMember, "kem_public_key"),
    recipientKemPrivateSeed: activeRuntime.device.kemPrivateSeed
  });
  if (canonicalizePdsJson(decrypted) !== canonicalizePdsJson(nextSecrets))
    fail("PDS source device decrypted an unexpected group secret set.");
  const acknowledged = await control({
    environment,
    deps: controlDeps,
    method: "POST",
    path: `/v1/personal-device-sync/groups/${encodeURIComponent(groupId)}/epoch-acks`,
    body: {
      ack: epochAck({
        groupId,
        bundleHash: authorizedBundle.authorizationHash,
        epoch: nextEpoch,
        deviceId: activeRuntime.device.id,
        kemKeyId: activeRuntime.device.kemKeyId,
        kemPublicKey: responseString(sourceMember, "kem_public_key"),
        signingKeyId: activeRuntime.device.signingKeyId,
        signingPrivateKey: sourceSigningKey,
        acknowledgedAt: now(deps)
      })
    }
  });
  if (acknowledged.activated !== false)
    fail("PDS epoch activated before the joining device acknowledged it.");
  return {
    ok: true,
    state: "pending_joining_device",
    message:
      "Device approved and source epoch acknowledged. Complete enrollment on the joining device.",
    groupId,
    deviceId: newDevice.deviceId,
    epoch: nextEpoch
  };
};

const completeDeviceJoin = async (
  args: string[],
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  deps: PersonalSyncDependencies
): Promise<PersonalSyncResult> => {
  const groupId = groupIdFrom(args);
  const challengeId = requiredFlag(args, "--challenge-id");
  const runtimeReference =
    environment.PDS_RUNTIME_SECRET_REF?.trim() ||
    fail("PDS_RUNTIME_SECRET_REF is required for enrollment.");
  const pendingReference = pendingSecretReference(
    runtimeReference,
    challengeId
  );
  const pending = await pendingEnrollmentSecret(
    pendingReference,
    environment,
    deps
  );
  if (pending.groupId !== groupId || pending.challengeId !== challengeId)
    fail("PDS pending enrollment does not match completion request.");
  const controlDeps =
    deps.desktopAuthorization || deps.pairingToken
      ? deps
      : {
          ...deps,
          sessionCookie: deps.sessionCookie ?? browserSession(environment)
        };
  const groupResponse = await control({
    environment,
    deps: controlDeps,
    method: "GET",
    path: `/v1/personal-device-sync/groups/${encodeURIComponent(groupId)}`
  });
  const group = object(groupResponse.group, "group");
  const member = groupMember(group, pending.deviceId);
  const alreadyActivated =
    group.state === "active" &&
    group.pending_epoch === null &&
    typeof group.current_epoch === "string" &&
    member.status === "active";
  let pendingEpoch: string;
  let activeGroup: Record<string, unknown>;
  let nextRuntime: RuntimeSecret | undefined;
  if (alreadyActivated) {
    pendingEpoch = group.current_epoch as string;
    const currentRuntime = await runtimeSecret(
      runtimeReference,
      environment,
      deps
    );
    if (
      currentRuntime.groupId !== groupId ||
      currentRuntime.device.id !== pending.deviceId ||
      currentRuntime.groupSecrets.currentEpoch !== pendingEpoch
    ) {
      fail("PDS activated enrollment cannot be resumed safely.");
    }
    activeGroup = group;
    nextRuntime = currentRuntime;
  } else {
    if (
      typeof group.pending_epoch !== "string" ||
      typeof group.pending_bundle_hash !== "string"
    ) {
      fail("PDS group has no pending enrollment epoch.");
    }
    pendingEpoch = group.pending_epoch as string;
    const pendingBundleHash = group.pending_bundle_hash as string;
    const bundleResponse = await control({
      environment,
      deps: controlDeps,
      method: "GET",
      path: `/v1/personal-device-sync/groups/${encodeURIComponent(groupId)}/key-bundles/${encodeURIComponent(pendingEpoch)}`
    });
    const bundle = object(bundleResponse.key_bundle, "key_bundle");
    const authorization = object(
      bundle.authorization,
      "key_bundle.authorization"
    );
    const author = groupMembers(group).find(
      (candidate) =>
        candidate.signing_key_id === authorization.signerKeyId &&
        candidate.status === "active"
    );
    if (!author) fail("PDS Key Bundle author is not an active member.");
    const secrets = decryptPdsKeyBundleSecretSet({
      bundle,
      authorizationPublicKey: responseString(
        author as Record<string, unknown>,
        "signing_public_key"
      ),
      authorityPublicKey: pending.authorityPublicKey,
      recipientId: pending.deviceId,
      recipientKemKeyId: pending.kemKeyId,
      recipientKemPublicKey: pending.kemPublicKey,
      recipientKemPrivateSeed: pending.kemPrivateSeed
    });
    const joiningSigningKey = pdsEd25519PrivateKey(
      pending.signingPrivateSeed,
      pending.signingPublicKey
    );
    const ackResponse = await control({
      environment,
      deps: controlDeps,
      method: "POST",
      path: `/v1/personal-device-sync/groups/${encodeURIComponent(groupId)}/epoch-acks`,
      body: {
        ack: epochAck({
          groupId,
          bundleHash: pendingBundleHash,
          epoch: pendingEpoch,
          deviceId: pending.deviceId,
          kemKeyId: pending.kemKeyId,
          kemPublicKey: pending.kemPublicKey,
          signingKeyId: pending.signingKeyId,
          signingPrivateKey: joiningSigningKey,
          acknowledgedAt: now(deps)
        })
      }
    });
    if (ackResponse.activated !== true)
      fail("PDS epoch did not activate after all device acknowledgements.");
    activeGroup = object(ackResponse.group, "group");
    nextRuntime = {
      version: 1,
      userId: pending.userId,
      relayUrl: pending.relayUrl,
      groupId,
      device: {
        id: pending.deviceId,
        originDeploymentId: pending.originDeploymentId,
        signingKeyId: pending.signingKeyId,
        signingPrivateSeed: pending.signingPrivateSeed,
        kemKeyId: pending.kemKeyId,
        kemPrivateSeed: pending.kemPrivateSeed
      },
      authority: {
        keyId: pending.authorityKeyId,
        publicKey: pending.authorityPublicKey,
        head: ""
      },
      recovery: {
        signingKeyId: responseString(
          object(activeGroup.recovery, "group.recovery"),
          "signing_key_id"
        ),
        signingPublicKey: responseString(
          object(activeGroup.recovery, "group.recovery"),
          "signing_public_key"
        )
      },
      groupSecrets: {
        currentEpoch: pendingEpoch,
        contentKey: secrets.epochSecret,
        sourceFingerprintKey: secrets.sourceFingerprintKey,
        tombstoneFloorKey: secrets.tombstoneFloorKey,
        projectAliasKey: secrets.projectAliasKey
      },
      certificate: "",
      recipientCertificates: []
    };
  }
  const activeHead = object(activeGroup.head, "group.head");
  if (
    activeGroup.current_epoch !== pendingEpoch ||
    activeGroup.pending_epoch !== null ||
    typeof activeHead.hash !== "string"
  )
    fail("PDS activated group response is invalid.");
  const activeHeadHash = activeHead.hash as string;
  const certificates = await Promise.all(
    groupMembers(activeGroup).map(async (activeMember) => {
      const response = await control({
        environment,
        deps: controlDeps,
        method: "GET",
        path: `/v1/personal-device-sync/groups/${encodeURIComponent(groupId)}/certificates/${encodeURIComponent(responseString(activeMember, "device_id"))}`
      });
      return canonicalizePdsJson(object(response.certificate, "certificate"));
    })
  );
  const logResponse = await control({
    environment,
    deps: controlDeps,
    method: "GET",
    path: `/v1/personal-device-sync/groups/${encodeURIComponent(groupId)}/log`
  });
  const statementEntries = logResponse.statements;
  if (!Array.isArray(statementEntries)) {
    return fail("PDS activated group statement log is invalid.");
  }
  const statements = statementEntries.map((value: unknown) => {
    const statement = object(value, "group statement log entry");
    if (
      !exactKeys(statement, [
        "sequence",
        "statementHash",
        "canonicalStatement"
      ]) ||
      !["sequence", "statementHash", "canonicalStatement"].every((field) =>
        strictString(statement[field])
      )
    ) {
      fail("PDS activated group statement log is invalid.");
    }
    return {
      sequence: statement.sequence as string,
      statementHash: statement.statementHash as string,
      canonicalStatement: statement.canonicalStatement as string
    };
  });
  nextRuntime = validatedRuntimeSecret(
    {
      ...nextRuntime,
      authority: {
        keyId: pending.authorityKeyId,
        publicKey: pending.authorityPublicKey,
        head: activeHeadHash
      }
    },
    certificates
  );
  await (deps.putSecret ?? putProviderSecret)(
    runtimeReference,
    JSON.stringify(nextRuntime),
    environment
  );
  return {
    ok: true,
    state: "active",
    message: "Joining device activated. The secure runtime is active.",
    groupId,
    deviceId: pending.deviceId,
    epoch: pendingEpoch,
    localGroupReconciliation: {
      local_device_id: pending.deviceId,
      group: activeGroup,
      statements,
      certificates
    }
  };
};

const bindLocalRuntimeUser = async (
  args: string[],
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  deps: PersonalSyncDependencies
): Promise<PersonalSyncResult> => {
  const groupId = groupIdFrom(args);
  const userId = requiredFlag(args, "--user-id");
  const challengeId = flag(args, "--challenge-id")?.trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      userId
    )
  ) {
    fail("--user-id is invalid.");
  }
  const runtimeReference =
    environment.PDS_RUNTIME_SECRET_REF?.trim() ||
    fail("PDS_RUNTIME_SECRET_REF is required for local identity binding.");
  const runtime = await runtimeSecret(runtimeReference, environment, deps);
  if (runtime.groupId !== groupId) {
    fail("PDS local identity binding targets another group.");
  }
  const rebound = validatedRuntimeSecret(
    {
      version: runtime.version,
      userId,
      relayUrl: runtime.relayUrl,
      groupId: runtime.groupId,
      device: runtime.device,
      authority: runtime.authority,
      recovery: runtime.recovery,
      ...(runtime.historicalOriginCertificates
        ? {
            historicalOriginCertificates: runtime.historicalOriginCertificates
          }
        : {}),
      groupSecrets: runtime.groupSecrets
    },
    runtime.recipientCertificates
  );
  await (deps.putSecret ?? putProviderSecret)(
    runtimeReference,
    JSON.stringify(rebound),
    environment
  );
  if (challengeId) {
    await (deps.deleteSecret ?? deleteProviderSecret)(
      pendingSecretReference(runtimeReference, challengeId),
      environment
    );
    const pendingState = readPending(paths);
    writePending(paths, {
      version: PENDING_VERSION,
      pending: pendingState.pending.filter(
        (entry) => entry.requestId !== challengeId
      )
    });
  }
  return {
    ok: true,
    state: "active",
    message: "Personal Device Sync is bound to the local User.",
    groupId,
    deviceId: runtime.device.id
  };
};

const refreshActiveDevice = async (
  environment: NodeJS.ProcessEnv,
  deps: PersonalSyncDependencies
): Promise<PersonalSyncResult> => {
  const runtimeReference =
    environment.PDS_RUNTIME_SECRET_REF?.trim() ||
    fail("PDS_RUNTIME_SECRET_REF is required for refresh.");
  const runtime = await runtimeSecret(runtimeReference, environment, deps);
  const controlDeps =
    deps.desktopAuthorization || deps.pairingToken
      ? deps
      : {
          ...deps,
          sessionCookie: deps.sessionCookie ?? browserSession(environment)
        };
  const groupResponse = await control({
    environment,
    deps: controlDeps,
    method: "GET",
    path: `/v1/personal-device-sync/groups/${encodeURIComponent(runtime.groupId)}`
  });
  const group = object(groupResponse.group, "group");
  if (
    group.state !== "active" ||
    group.pending_epoch !== null ||
    typeof group.current_epoch !== "string"
  )
    fail("PDS group is not ready for runtime refresh.");
  const currentEpoch = group.current_epoch as string;
  if (BigInt(currentEpoch) < BigInt(runtime.groupSecrets.currentEpoch))
    fail("PDS Authority epoch is behind the local runtime.");
  if (currentEpoch === runtime.groupSecrets.currentEpoch)
    return {
      ok: true,
      state: "current",
      message: "PDS runtime already uses the current epoch.",
      groupId: runtime.groupId,
      deviceId: runtime.device.id,
      epoch: currentEpoch
    };
  if (
    responseString(group, "authority_key_id") !== runtime.authority.keyId ||
    responseString(group, "authority_public_key") !==
      runtime.authority.publicKey
  )
    fail("PDS Authority identity changed unexpectedly.");
  const member = groupMember(group, runtime.device.id);
  const bundleResponse = await control({
    environment,
    deps: controlDeps,
    method: "GET",
    path: `/v1/personal-device-sync/groups/${encodeURIComponent(runtime.groupId)}/key-bundles/${encodeURIComponent(currentEpoch)}`
  });
  const bundle = object(bundleResponse.key_bundle, "key_bundle");
  const authorization = object(
    bundle.authorization,
    "key_bundle.authorization"
  );
  const author = groupMembers(group).find(
    (candidate) =>
      candidate.signing_key_id === authorization.signerKeyId &&
      candidate.status === "active"
  );
  const activeAuthor =
    author ?? fail("PDS Key Bundle author is not an active member.");
  const secrets = decryptPdsKeyBundleSecretSet({
    bundle,
    authorizationPublicKey: responseString(activeAuthor, "signing_public_key"),
    authorityPublicKey: runtime.authority.publicKey,
    recipientId: runtime.device.id,
    recipientKemKeyId: runtime.device.kemKeyId,
    recipientKemPublicKey: responseString(member, "kem_public_key"),
    recipientKemPrivateSeed: runtime.device.kemPrivateSeed
  });
  const members = groupMembers(group);
  const certificates = await Promise.all(
    members.map(async (activeMember) => {
      const response = await control({
        environment,
        deps: controlDeps,
        method: "GET",
        path: `/v1/personal-device-sync/groups/${encodeURIComponent(runtime.groupId)}/certificates/${encodeURIComponent(responseString(activeMember, "device_id"))}`
      });
      return canonicalizePdsJson(object(response.certificate, "certificate"));
    })
  );
  const head = object(group.head, "group.head");
  if (typeof head.hash !== "string")
    fail("PDS refreshed group response is invalid.");
  const runtimeWithoutCertificates = Object.fromEntries(
    Object.entries(runtime).filter(
      ([key]) => key !== "certificate" && key !== "recipientCertificates"
    )
  ) as Omit<RuntimeSecret, "certificate" | "recipientCertificates">;
  const nextRuntime = validatedRuntimeSecret(
    {
      ...runtimeWithoutCertificates,
      authority: { ...runtime.authority, head: head.hash as string },
      groupSecrets: {
        currentEpoch,
        contentKey: secrets.epochSecret,
        sourceFingerprintKey: secrets.sourceFingerprintKey,
        tombstoneFloorKey: secrets.tombstoneFloorKey,
        projectAliasKey: secrets.projectAliasKey
      }
    },
    certificates
  );
  await (deps.putSecret ?? putProviderSecret)(
    runtimeReference,
    JSON.stringify(nextRuntime),
    environment
  );
  return {
    ok: true,
    state: "refreshed",
    message: "PDS runtime refreshed to the current Authority epoch.",
    groupId: runtime.groupId,
    deviceId: runtime.device.id,
    epoch: currentEpoch
  };
};

const readJsonFd = (args: string[], name: string): Record<string, unknown> => {
  const raw = readBoundedFd(requiredFlag(args, name), name);
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    return object(parsed, name);
  } finally {
    raw.fill(0);
  }
};

const submitTransition = async (
  args: string[],
  environment: NodeJS.ProcessEnv,
  deps: PersonalSyncDependencies
): Promise<PersonalSyncResult> => {
  const groupId = groupIdFrom(args);
  const body: Record<string, unknown> = {
    statement:
      requiredFlag(args, "--statement-fd") &&
      readJsonFd(args, "--statement-fd").statement,
    key_bundle: flag(args, "--key-bundle-fd")
      ? readJsonFd(args, "--key-bundle-fd").key_bundle
      : undefined,
    proof: flag(args, "--proof-fd")
      ? readJsonFd(args, "--proof-fd").proof
      : undefined
  };
  if (typeof body.statement !== "string")
    fail("--statement-fd must contain a statement field.");
  if (body.key_bundle !== undefined && typeof body.key_bundle !== "string")
    fail("--key-bundle-fd must contain a key_bundle field.");
  if (
    body.proof !== undefined &&
    (!body.proof || typeof body.proof !== "object" || Array.isArray(body.proof))
  )
    fail("--proof-fd must contain a proof object.");
  const response = await control({
    environment,
    deps,
    method: "POST",
    path: `/v1/personal-device-sync/groups/${encodeURIComponent(groupId)}/transitions`,
    body
  });
  return {
    ok: true,
    state: response.group ? "pending_activation" : "backend",
    message: "Authority accepted transition; poll backend durable status.",
    ...response
  };
};

export const runPersonalSyncCommand = async (
  args: string[],
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  deps: PersonalSyncDependencies = {}
): Promise<PersonalSyncResult> => {
  rejectPasswordArguments(args);
  const [area, action] = args;
  if (area === "group" && action === "bootstrap")
    return bootstrapGroup(args.slice(2), paths, environment, deps);
  if (area === "status") return status(environment, deps);
  if (area === "invite" && action === "create")
    return createPairingInvitation(args.slice(2), environment, deps);
  if (area === "join" && action === "request")
    return createJoinChallenge(args.slice(2), paths, environment, deps);
  if (area === "join" && action === "complete")
    return completeDeviceJoin(args.slice(2), paths, environment, deps);
  if (area === "join" && action === "bind-local-user")
    return bindLocalRuntimeUser(args.slice(2), paths, environment, deps);
  if (area === "join" && action === "challenge")
    return {
      ok: true,
      state: "pending",
      message: "Pending pairing artifacts are local redacted request IDs only.",
      requests: readPending(paths).pending
    };
  if (area === "active-device" && action === "approve")
    return approveActiveDevice(args.slice(2), environment, deps);
  if (area === "active-device" && action === "refresh")
    return refreshActiveDevice(environment, deps);
  if (area === "recovery" && action === "approve")
    return submitTransition(args.slice(2), environment, deps);
  if (area === "device" && action === "list") {
    const groupId = groupIdFrom(args.slice(2));
    const response = await control({
      environment,
      deps,
      method: "GET",
      path: `/v1/personal-device-sync/groups/${encodeURIComponent(groupId)}`
    });
    const group = object(response.group, "group");
    return {
      ok: true,
      state: "backend",
      message: "Devices are Authority-owned.",
      devices: group.members ?? []
    };
  }
  if (area === "device" && action === "revoke")
    return submitTransition(args.slice(2), environment, deps);
  if (
    area === "policy" &&
    ["enable", "pause", "resume"].includes(action ?? "")
  ) {
    const groupId = groupIdFrom(args.slice(2));
    const enabled = action === "enable" || action === "resume";
    const response =
      action === "pause" || action === "resume"
        ? await control({
            environment,
            deps,
            method: "PUT",
            path: `/v1/personal-device-sync/groups/${encodeURIComponent(groupId)}/pause`,
            body: { paused: !enabled }
          })
        : await control({
            environment,
            deps,
            method: "PUT",
            path: `/v1/personal-device-sync/groups/${encodeURIComponent(groupId)}/policy`,
            body: {
              enabled,
              future_closed_sessions_only: true,
              historical_backfill_enabled: false
            }
          });
    return {
      ok: true,
      state: "backend",
      message:
        "Policy result is backend-owned; poll status for durable outcome.",
      ...response
    };
  }
  if (area === "retry") {
    const groupId = groupIdFrom(args.slice(1));
    const response = await control({
      environment,
      deps,
      method: "POST",
      path: `/v1/personal-device-sync/groups/${encodeURIComponent(groupId)}/retry`
    });
    return {
      ok: true,
      state: "backend",
      message: "Retry submitted to backend.",
      ...response
    };
  }
  if (area === "replica" && action === "status") {
    const groupId = groupIdFrom(args.slice(2));
    const response = await control({
      environment,
      deps,
      method: "GET",
      path: `/v1/personal-device-sync/groups/${encodeURIComponent(groupId)}/local-status`
    });
    return {
      ok: true,
      state: "backend",
      message: "Replica status is backend-owned.",
      ...response
    };
  }
  if (area === "recovery" && action === "guidance")
    return {
      ok: true,
      state: "guidance",
      message:
        "Use active-device signed transition when possible. Otherwise use recovery signer through protected FD. Browser sessions only bind requests; API Tokens and legacy credentials are rejected."
    };
  if (area === "recovery-kit" && action === "verify") {
    const kitPath = requiredFlag(args.slice(2), "--recovery-kit");
    if (!secureRegularFile(kitPath))
      fail("Recovery kit permissions are unsafe; require 0600.");
    const password = passwordFrom(args.slice(2));
    try {
      const plaintext = decryptRecoveryKit(
        JSON.parse(readFileSync(kitPath, "utf8")) as RecoveryKit,
        password
      );
      return {
        ok: true,
        state: "verified",
        message:
          "Recovery kit cryptographically verified. Backend transition remains required.",
        fingerprint: fingerprint(plaintext)
      };
    } finally {
      password.fill(0);
    }
  }
  if (area === "recovery-kit" && action === "create") {
    const output = requiredFlag(args.slice(2), "--output");
    const payload = readJsonFd(args.slice(2), "--payload-fd");
    const password = passwordFrom(args.slice(2));
    try {
      const plaintext = JSON.stringify(payload);
      const kit = encryptRecoveryKit(plaintext, password);
      if (decryptRecoveryKit(kit, password) !== plaintext)
        fail("Recovery kit round-trip verification failed.");
      writeRecoveryKit(output, kit);
      return {
        ok: true,
        state: "created",
        message: "Recovery kit encrypted and verified.",
        fingerprint: kit.fingerprint
      };
    } finally {
      password.fill(0);
    }
  }
  return fail(
    "personal-sync command is invalid or requires backend signed transition input."
  );
};
