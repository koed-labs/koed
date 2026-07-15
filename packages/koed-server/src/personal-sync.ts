import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync
} from "node:crypto";
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

export interface PersonalSyncResult {
  ok: boolean;
  state: string;
  message: string;
  [key: string]: unknown;
}

export interface PersonalSyncDependencies {
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
}

const fail = (message: string): never => {
  throw new Error(message);
};
const b64 = (value: Buffer): string => value.toString("base64url");
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

const writeRecoveryKit = (path: string, kit: RecoveryKit): void => {
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
  try {
    renameSync(temporary, output);
    fsyncDirectory(directory);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* cleanup only */
    }
    throw error;
  }
  if (!secureRegularFile(output))
    fail("Recovery kit permissions are unsafe; require 0600.");
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
    const message = (value as Record<string, unknown>).message;
    fail(
      typeof message === "string"
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
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetcher(
    `${controlOrigin(input.environment)}${input.path}`,
    {
      method: input.method,
      headers: {
        accept: "application/json",
        cookie: browserSession(input.environment),
        ...(input.body ? { "content-type": "application/json" } : {})
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      signal: timeout
    }
  );
  return strictResponse(response);
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
  const response = await control({
    environment,
    deps,
    method: "GET",
    path: "/v1/personal-device-sync/groups"
  });
  const groups = response.groups;
  if (!Array.isArray(groups)) fail("PDS control response groups is invalid.");
  return {
    ok: true,
    state: "backend",
    message: "Personal Sync status is Authority-owned.",
    groups
  };
};

const createJoinChallenge = async (
  args: string[],
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  deps: PersonalSyncDependencies
): Promise<PersonalSyncResult> => {
  const groupId = groupIdFrom(args);
  const response = await control({
    environment,
    deps,
    method: "POST",
    path: "/v1/personal-device-sync/challenges",
    body: { group_id: groupId }
  });
  const challenge = object(response.challenge, "challenge");
  const requestId = challenge.id;
  const shortCode = challenge.short_code;
  if (typeof requestId !== "string" || typeof shortCode !== "string")
    fail("PDS control response challenge is invalid.");
  const safeRequestId = requestId as string;
  const safeShortCode = shortCode as string;
  const pending = readPending(paths);
  const next = pending.pending.filter(
    (entry) => entry.requestId !== safeRequestId
  );
  next.push({ requestId: safeRequestId, groupId, createdAt: now(deps) });
  writePending(paths, {
    version: PENDING_VERSION,
    pending: next.slice(-MAX_PENDING_REQUESTS)
  });
  return {
    ok: true,
    state: "pending",
    message: "Pairing request is pending backend approval.",
    pairing: {
      challengeId: safeRequestId,
      shortCode: safeShortCode,
      url: typeof challenge.url === "string" ? challenge.url : undefined
    }
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
  if (area === "status") return status(environment, deps);
  if (area === "join" && action === "request")
    return createJoinChallenge(args.slice(2), paths, environment, deps);
  if (area === "join" && action === "challenge")
    return {
      ok: true,
      state: "pending",
      message: "Pending pairing artifacts are local redacted request IDs only.",
      requests: readPending(paths).pending
    };
  if ((area === "active-device" || area === "recovery") && action === "approve")
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
