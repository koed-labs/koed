import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEFAULT_BACKUP_RPO_SECONDS = 24 * 60 * 60;
export const DEFAULT_RESTORE_RTO_SECONDS = 4 * 60 * 60;

const usage = `Usage:
  node scripts/hosted-backup.mjs create --output-dir <dir> [--database-url <url>] [--status-path <path>] [--allow-plaintext]
  node scripts/hosted-backup.mjs verify --backup-file <file> [--status-path <path>] [--allow-plaintext]
  node scripts/hosted-backup.mjs restore-smoke --backup-file <file> --target-database-url <url> --confirm-restore-smoke-target <database> [--status-path <path>] [--allow-plaintext]

Environment:
  DATABASE_URL              Source Postgres URL for create
  KOED_BACKUP_POSTGRES_CLIENT_MODE
                            auto, docker-compose, native, or external. Defaults to auto.
  KOED_DOCKER_COMPOSE_FILE  Compose file for Docker-backed local Postgres
  PSQL_BIN                  Optional psql binary path for version preflight
  PG_DUMP_BIN               Optional pg_dump binary path
  PG_RESTORE_BIN            Optional pg_restore binary path
  KOED_BACKUP_STATUS_PATH   Optional redacted status JSON output path
  API_DATA_ENCRYPTION_KEY   Base64 32-byte archive encryption root key
`;

const takeValue = (argv, index, name) => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.\n\n${usage}`);
  }
  return value;
};

export const parseHostedBackupArgs = (argv) => {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, ...rest] = normalizedArgv;
  if (!command || command === "--help" || command === "-h") {
    return { command: "help" };
  }
  if (!["create", "verify", "restore-smoke"].includes(command)) {
    throw new Error(`Unknown hosted backup command: ${command}\n\n${usage}`);
  }

  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--output-dir") {
      options.outputDir = takeValue(rest, index, arg);
      index += 1;
    } else if (arg === "--database-url") {
      options.databaseUrl = takeValue(rest, index, arg);
      index += 1;
    } else if (arg === "--target-database-url") {
      options.targetDatabaseUrl = takeValue(rest, index, arg);
      index += 1;
    } else if (arg === "--confirm-restore-smoke-target") {
      options.confirmRestoreSmokeTarget = takeValue(rest, index, arg);
      index += 1;
    } else if (arg === "--backup-file") {
      options.backupFile = takeValue(rest, index, arg);
      index += 1;
    } else if (arg === "--status-path") {
      options.statusPath = takeValue(rest, index, arg);
      index += 1;
    } else if (arg === "--allow-plaintext") {
      options.allowPlaintext = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage}`);
    }
  }
  return options;
};

export const hostedBackupUsage = () => usage;

export const redactDatabaseUrl = (databaseUrl) => {
  try {
    const parsed = new URL(databaseUrl);
    parsed.username = parsed.username ? "redacted" : "";
    parsed.password = parsed.password ? "redacted" : "";
    return parsed.toString();
  } catch {
    return "redacted";
  }
};

const redactSensitiveText = (value) =>
  String(value).replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, (match) =>
    redactDatabaseUrl(match)
  );

const timestamp = (date) =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

const sha256File = (filePath) => {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
};

const readJsonIfPresent = (filePath) => {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
};

const inferManifestPath = (backupFile) => `${backupFile}.manifest.json`;
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const defaultComposeFile = path.resolve(
  repoRoot,
  "examples",
  "docker-compose",
  "docker-compose.yml"
);

const externalCiphertextMarker = "[external-backup-archive]";
const envelopeVersion = 1;
const payloadAlgorithm = "aes-256-gcm";
const localWrapAlgorithm = "aes-256-gcm";
const kmsWrapAlgorithm = "kms-wrapped-dek-v1";
const localTestKeyVersion = 1;
const aes256KeyBytes = 32;
const gcmNonceBytes = 12;

const optionalEnvValue = (value) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const base64Encode = (value) => Buffer.from(value).toString("base64");

const base64Decode = (value, fieldName) => {
  const decoded = Buffer.from(value ?? "", "base64");
  if (decoded.length === 0 && String(value ?? "").trim() !== "") {
    throw new Error(`${fieldName} must be base64 encoded.`);
  }
  return decoded;
};

const canonicalJson = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${canonicalJson(entryValue)}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const normalizeAad = (aad = {}) =>
  Object.fromEntries(
    Object.entries(aad)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
      .sort(([left], [right]) => left.localeCompare(right))
  );

const payloadAad = (envelope) =>
  Buffer.from(
    canonicalJson({
      version: envelope.version,
      scope: envelope.scope,
      provenance: envelope.provenance,
      algorithm: envelope.algorithm,
      ciphertextLocation: envelope.ciphertextLocation,
      aad: envelope.aad,
      createdAt: envelope.createdAt
    }),
    "utf8"
  );

const wrappedDekAad = ({
  providerMode,
  keyId,
  keyVersion,
  wrappedDekId,
  wrappedDekVersion
}) =>
  Buffer.from(
    canonicalJson({
      providerMode,
      keyId,
      keyVersion,
      wrappedDekId,
      wrappedDekVersion
    }),
    "utf8"
  );

const encryptAesGcm = (key, plaintext, aad) => {
  const nonce = crypto.randomBytes(gcmNonceBytes);
  const cipher = crypto.createCipheriv(payloadAlgorithm, key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext,
    nonce,
    tag: cipher.getAuthTag()
  };
};

const decryptAesGcm = (key, ciphertext, nonce, tag, aad) => {
  try {
    const decipher = crypto.createDecipheriv(payloadAlgorithm, key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Encrypted backup archive authentication failed.");
  }
};

const requireLocalRootKey = (env) => {
  const value =
    optionalEnvValue(env.API_DATA_ENCRYPTION_KEY) ??
    optionalEnvValue(env.DATA_ENCRYPTION_KEY);
  if (!value || value.startsWith("replace_with_generated")) {
    throw new Error("API_DATA_ENCRYPTION_KEY must be a generated base64 key.");
  }
  const key = base64Decode(value, "API_DATA_ENCRYPTION_KEY");
  if (key.length !== aes256KeyBytes) {
    throw new Error("API_DATA_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  return key;
};

const localKeyId = (rootKey) =>
  `local_test_key:${crypto.createHash("sha256").update(rootKey).digest("base64url").slice(0, 22)}`;

const positiveInt = (value, name) => {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
};

const optionalEnvPath = (value) => {
  const trimmed = optionalEnvValue(value);
  return trimmed ? path.resolve(trimmed) : undefined;
};

const isLocalhost = (host) =>
  ["localhost", "127.0.0.1", "::1"].includes(String(host ?? "").toLowerCase());

const databaseUrlParts = (databaseUrl) => {
  const parsed = new URL(databaseUrl);
  return {
    parsed,
    host: parsed.hostname,
    port: parsed.port || "5432",
    database: parsed.pathname.replace(/^\//, ""),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password)
  };
};

const restoreSmokeDatabaseNameLooksSafe = (database) =>
  /(^|[_-])(restore|smoke|scratch|tmp|test)([_-]|$)/i.test(database);

const assertRestoreSmokeTargetIsSafe = (targetDatabaseUrl, confirmation) => {
  const { database } = databaseUrlParts(targetDatabaseUrl);
  if (!database || !restoreSmokeDatabaseNameLooksSafe(database)) {
    throw new Error(
      "restore-smoke target database must be a dedicated scratch/restore/smoke/test database."
    );
  }
  if (confirmation !== database) {
    throw new Error(
      `restore-smoke requires --confirm-restore-smoke-target ${database} before running pg_restore --clean.`
    );
  }
};

const postgresSetting = (env, name, fallback) =>
  optionalEnvValue(env[name]) ?? fallback;

const matchesConfiguredLocalPostgres = (
  databaseUrl,
  env,
  { allowAnyDatabase = false } = {}
) => {
  try {
    const parts = databaseUrlParts(databaseUrl);
    const expectedPort = postgresSetting(env, "POSTGRES_HOST_PORT", "15432");
    const expectedDb = postgresSetting(env, "POSTGRES_DB", "koed");
    const expectedUser = postgresSetting(env, "POSTGRES_USER", "koed");
    return (
      isLocalhost(parts.host) &&
      parts.port === expectedPort &&
      (allowAnyDatabase || parts.database === expectedDb) &&
      parts.user === expectedUser
    );
  } catch {
    return false;
  }
};

const dockerComposeArgs = (env) => {
  const composeFile =
    optionalEnvPath(env.KOED_DOCKER_COMPOSE_FILE) ?? defaultComposeFile;
  const envFile =
    optionalEnvPath(env.KOED_DOCKER_COMPOSE_ENV_FILE) ??
    path.resolve(repoRoot, ".env");
  return [
    "compose",
    ...(fs.existsSync(envFile) ? ["--env-file", envFile] : []),
    "-f",
    composeFile
  ];
};

const dockerComposeExecArgs = (env, service, command, args) => [
  ...dockerComposeArgs(env),
  "exec",
  "-T",
  service,
  command,
  ...args
];

const dockerComposePostgresIsRunning = async (env, run) => {
  try {
    const result = await run("docker", [
      ...dockerComposeArgs(env),
      "ps",
      "-q",
      "postgres"
    ]);
    return Boolean(result.stdout.trim());
  } catch {
    return false;
  }
};

const dockerContainerDatabaseUrl = (databaseUrl, env) => {
  const parts = databaseUrlParts(databaseUrl);
  parts.parsed.hostname = "127.0.0.1";
  parts.parsed.port = "5432";
  if (!parts.parsed.username) {
    parts.parsed.username = encodeURIComponent(
      postgresSetting(env, "POSTGRES_USER", "koed")
    );
  }
  if (!parts.parsed.password) {
    const password = optionalEnvValue(env.POSTGRES_PASSWORD);
    if (password) {
      parts.parsed.password = encodeURIComponent(password);
    }
  }
  return parts.parsed.toString();
};

const nativePostgresBinDir = (env) =>
  optionalEnvPath(env.KOED_POSTGRES_BIN_DIR) ??
  path.resolve(
    optionalEnvPath(env.KOED_HOME) ??
      path.resolve(process.env.HOME ?? ".", ".koed"),
    "runtime",
    "postgres",
    "bin"
  );

const nativePostgresBinary = (env, name) =>
  path.resolve(nativePostgresBinDir(env), name);

const nativePostgresToolsExist = (env) =>
  ["psql", "pg_dump", "pg_restore"].every((name) =>
    fs.existsSync(nativePostgresBinary(env, name))
  );

const explicitHostToolConfigured = (env, command) => {
  if (optionalEnvValue(env.PSQL_BIN)) {
    return true;
  }
  if (command === "create") {
    return Boolean(optionalEnvValue(env.PG_DUMP_BIN));
  }
  return Boolean(optionalEnvValue(env.PG_RESTORE_BIN));
};

const resolvePostgresClientRuntime = async ({
  env,
  run,
  command,
  databaseUrl
}) => {
  const mode = optionalEnvValue(env.KOED_BACKUP_POSTGRES_CLIENT_MODE) ?? "auto";
  if (!["auto", "docker-compose", "native", "external"].includes(mode)) {
    throw new Error(
      "KOED_BACKUP_POSTGRES_CLIENT_MODE must be auto, docker-compose, native, or external."
    );
  }
  if (mode === "external" || explicitHostToolConfigured(env, command)) {
    return { kind: "host" };
  }
  if (mode === "native" || env.KOED_DEPENDENCY_MODE === "bundled-local") {
    if (!nativePostgresToolsExist(env)) {
      if (mode === "native") {
        throw new Error(
          `Native Postgres backup tools are missing under ${nativePostgresBinDir(env)}. Run koed-server runtime install or set PSQL_BIN, PG_DUMP_BIN, and PG_RESTORE_BIN explicitly.`
        );
      }
    } else {
      return {
        kind: "host",
        psqlBin: nativePostgresBinary(env, "psql"),
        pgDumpBin: nativePostgresBinary(env, "pg_dump"),
        pgRestoreBin: nativePostgresBinary(env, "pg_restore")
      };
    }
  }
  if (mode === "docker-compose" || mode === "auto") {
    const allowAnyDatabase = command === "restore-smoke";
    const canUseDocker =
      (command === "verify" ||
        !databaseUrl ||
        matchesConfiguredLocalPostgres(databaseUrl, env, {
          allowAnyDatabase
        })) &&
      (mode === "docker-compose" ||
        (await dockerComposePostgresIsRunning(env, run)));
    if (canUseDocker) {
      return { kind: "docker-compose" };
    }
    if (mode === "docker-compose") {
      throw new Error(
        "Docker Compose Postgres is not running or the database URL does not match the configured local Compose Postgres."
      );
    }
  }
  return { kind: "host" };
};

const assertSafeKmsEndpoint = (endpoint) => {
  if (endpoint.protocol === "https:") {
    return;
  }
  if (
    endpoint.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname)
  ) {
    return;
  }
  throw new Error(
    "MANAGED_KMS_ENDPOINT_URL must use HTTPS unless it targets localhost."
  );
};

const kmsJson = async (env, operation, payload) => {
  const endpointUrl = optionalEnvValue(env.MANAGED_KMS_ENDPOINT_URL);
  const authToken = optionalEnvValue(env.MANAGED_KMS_AUTH_TOKEN);
  if (!endpointUrl || !authToken) {
    throw new Error(
      "MANAGED_KMS_ENDPOINT_URL and MANAGED_KMS_AUTH_TOKEN are required for backup KMS encryption."
    );
  }
  const endpoint = new URL(endpointUrl);
  assertSafeKmsEndpoint(endpoint);
  if (!globalThis.fetch) {
    throw new Error("fetch is unavailable for backup KMS encryption.");
  }
  const response = await globalThis.fetch(new URL(operation, endpoint), {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(
      `backup KMS ${operation} failed with status ${response.status}.`
    );
  }
  const body = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`backup KMS ${operation} returned an invalid response.`);
  }
  return body;
};

const requireString = (body, fieldName) => {
  const value = body[fieldName];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`backup KMS response is missing ${fieldName}.`);
  }
  return value;
};

const createArchiveEnvelopeProvider = (mode, env) => {
  if (mode === "operator_kms") {
    throw new Error(
      "Envelope encryption provider is not implemented: operator_kms"
    );
  }
  const localRootKey =
    mode === "local_test_key" ? requireLocalRootKey(env) : null;
  const keyId =
    mode === "local_test_key"
      ? localKeyId(localRootKey)
      : optionalEnvValue(env.MANAGED_KMS_KEY_ID);
  const keyVersion =
    mode === "local_test_key"
      ? localTestKeyVersion
      : positiveInt(env.MANAGED_KMS_KEY_VERSION, "MANAGED_KMS_KEY_VERSION");
  if (!keyId) {
    throw new Error(
      "MANAGED_KMS_KEY_ID is required for backup KMS encryption."
    );
  }

  const wrapDek = async (dek, wrappedDekMetadata) => {
    const aad = wrappedDekAad({
      providerMode: mode,
      keyId,
      keyVersion,
      wrappedDekId: wrappedDekMetadata.id,
      wrappedDekVersion: wrappedDekMetadata.version
    });
    if (localRootKey) {
      const wrapped = encryptAesGcm(localRootKey, dek, aad);
      return {
        ...wrappedDekMetadata,
        algorithm: localWrapAlgorithm,
        ciphertext: base64Encode(wrapped.ciphertext),
        nonce: base64Encode(wrapped.nonce),
        tag: base64Encode(wrapped.tag)
      };
    }
    const body = await kmsJson(env, "wrap", {
      keyId,
      keyVersion,
      wrappedDekId: wrappedDekMetadata.id,
      wrappedDekVersion: wrappedDekMetadata.version,
      dek: base64Encode(dek),
      aad: base64Encode(aad)
    });
    return {
      ...wrappedDekMetadata,
      algorithm: kmsWrapAlgorithm,
      ciphertext: requireString(body, "ciphertext"),
      nonce: typeof body.nonce === "string" ? body.nonce : "",
      tag: typeof body.tag === "string" ? body.tag : ""
    };
  };

  const unwrapDek = async (envelope) => {
    const aad = wrappedDekAad({
      providerMode: mode,
      keyId,
      keyVersion: envelope.keyVersion,
      wrappedDekId: envelope.wrappedDek.id,
      wrappedDekVersion: envelope.wrappedDek.version
    });
    if (localRootKey) {
      return decryptAesGcm(
        localRootKey,
        base64Decode(envelope.wrappedDek.ciphertext, "wrappedDek.ciphertext"),
        base64Decode(envelope.wrappedDek.nonce, "wrappedDek.nonce"),
        base64Decode(envelope.wrappedDek.tag, "wrappedDek.tag"),
        aad
      );
    }
    const body = await kmsJson(env, "unwrap", {
      keyId,
      keyVersion: envelope.keyVersion,
      wrappedDek: envelope.wrappedDek,
      aad: base64Encode(aad)
    });
    return base64Decode(requireString(body, "dek"), "backup KMS dek");
  };

  return {
    mode,
    keyId,
    keyVersion,
    async encrypt(input) {
      const createdAt = (input.now ?? new Date()).toISOString();
      const dek = crypto.randomBytes(aes256KeyBytes);
      const wrappedDekMetadata = {
        id: crypto.randomUUID(),
        version: 1,
        algorithm: localRootKey ? localWrapAlgorithm : kmsWrapAlgorithm
      };
      const envelopeMetadata = {
        version: envelopeVersion,
        providerMode: mode,
        keyId,
        keyVersion,
        scope: input.scope,
        provenance: input.provenance,
        algorithm: payloadAlgorithm,
        wrappedDek: wrappedDekMetadata,
        ciphertextLocation: input.ciphertextLocation,
        aad: normalizeAad(input.aad),
        createdAt,
        reencryptedAt: null
      };
      const payload = encryptAesGcm(
        dek,
        Buffer.from(input.plaintext),
        payloadAad(envelopeMetadata)
      );
      return {
        ...envelopeMetadata,
        ciphertext: base64Encode(payload.ciphertext),
        nonce: base64Encode(payload.nonce),
        tag: base64Encode(payload.tag),
        wrappedDek: await wrapDek(dek, wrappedDekMetadata)
      };
    },
    async decrypt(envelope) {
      if (envelope.providerMode !== mode || envelope.keyId !== keyId) {
        throw new Error("Backup archive envelope provider mismatch.");
      }
      const dek = await unwrapDek(envelope);
      return decryptAesGcm(
        dek,
        base64Decode(envelope.ciphertext, "ciphertext"),
        base64Decode(envelope.nonce, "nonce"),
        base64Decode(envelope.tag, "tag"),
        payloadAad(envelope)
      );
    }
  };
};

const archiveEncryptionProvider = (env, options) => {
  const explicitMode = optionalEnvValue(env.API_ENVELOPE_ENCRYPTION_PROVIDER);
  const localKey =
    optionalEnvValue(env.API_DATA_ENCRYPTION_KEY) ??
    optionalEnvValue(env.DATA_ENCRYPTION_KEY);
  const mode =
    explicitMode?.toLowerCase() ?? (localKey ? "local_test_key" : undefined);
  if (!mode) {
    if (options.allowPlaintext) {
      return null;
    }
    throw new Error(
      "An envelope encryption provider is required for hosted backup archive encryption. Set API_DATA_ENCRYPTION_KEY for local/private alpha or configure a KMS-backed API_ENVELOPE_ENCRYPTION_PROVIDER. Use --allow-plaintext only for local/dev checks."
    );
  }
  if (
    !["local_test_key", "managed_kms", "byok", "cmek", "operator_kms"].includes(
      mode
    )
  ) {
    throw new Error(`Unsupported API_ENVELOPE_ENCRYPTION_PROVIDER: ${mode}`);
  }
  return createArchiveEnvelopeProvider(mode, env);
};

const externalizeBackupEnvelope = (envelope) => ({
  ...envelope,
  ciphertext: externalCiphertextMarker
});

const envelopeWithArchiveCiphertext = (encryptedFile, envelope) => ({
  ...envelope,
  ciphertext: fs.readFileSync(encryptedFile).toString("base64")
});

const encryptBackupArchive = async ({
  plaintextFile,
  encryptedFile,
  provider,
  now
}) => {
  const envelope = await provider.encrypt({
    plaintext: fs.readFileSync(plaintextFile),
    scope: {
      objectClass: "hosted_backup_archive"
    },
    provenance: {
      rowFamily: "hosted_backups",
      sourceTable: null,
      sourceColumn: null,
      sourceId: path.basename(encryptedFile)
    },
    ciphertextLocation: path.basename(encryptedFile),
    aad: {
      objectClass: "hosted_backup_archive",
      backupFile: path.basename(encryptedFile)
    },
    now
  });
  fs.writeFileSync(encryptedFile, Buffer.from(envelope.ciphertext, "base64"));
  return externalizeBackupEnvelope(envelope);
};

const decryptBackupArchive = async ({
  encryptedFile,
  plaintextFile,
  provider,
  envelope
}) => {
  const plaintext = await provider.decrypt(
    envelopeWithArchiveCiphertext(encryptedFile, envelope)
  );
  fs.writeFileSync(plaintextFile, plaintext);
};

const withReadableBackupArchive = async ({ env, options, now, callback }) => {
  const manifest = readJsonIfPresent(inferManifestPath(options.backupFile));
  if (manifest?.encrypted === true) {
    const provider = archiveEncryptionProvider(env, {});
    const tempFile = path.join(
      path.dirname(options.backupFile),
      `.${path.basename(options.backupFile)}.${process.pid}.${now.getTime()}.plain`
    );
    try {
      await decryptBackupArchive({
        encryptedFile: options.backupFile,
        plaintextFile: tempFile,
        provider,
        envelope: manifest.encryption.envelope
      });
      return await callback(tempFile, manifest);
    } finally {
      fs.rmSync(tempFile, { force: true });
    }
  }
  if (!options.allowPlaintext) {
    throw new Error(
      "Backup archive is not encrypted or has no manifest. Use --allow-plaintext only for local/dev checks."
    );
  }
  return callback(options.backupFile, manifest);
};

const runCommand = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const stdin = options.stdinFile
      ? fs.openSync(options.stdinFile, "r")
      : "ignore";
    const stdout = options.stdoutFile
      ? fs.openSync(options.stdoutFile, "w")
      : "pipe";
    const child = spawn(command, args, {
      stdio: [stdin, stdout, "pipe"],
      env: options.env ?? process.env
    });
    let stdoutText = "";
    let stderr = "";
    if (!options.stdoutFile) {
      child.stdout.on("data", (chunk) => {
        stdoutText += chunk.toString();
      });
    }
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    let fileDescriptorsClosed = false;
    const closeFileDescriptors = () => {
      if (fileDescriptorsClosed) {
        return;
      }
      fileDescriptorsClosed = true;
      if (typeof stdin === "number") fs.closeSync(stdin);
      if (typeof stdout === "number") fs.closeSync(stdout);
    };
    child.on("error", (error) => {
      closeFileDescriptors();
      reject(error);
    });
    child.on("close", (code) => {
      closeFileDescriptors();
      if (code === 0) {
        resolve({ stdout: stdoutText, stderr });
      } else {
        reject(
          new Error(
            `${path.basename(command)} exited with ${code}${stderr ? `: ${stderr}` : ""}`
          )
        );
      }
    });
  });

const parsePostgresMajor = (value, label) => {
  const text = String(value ?? "").trim();
  const versionNum = text.match(/\b(\d{5,6})\b/)?.[1];
  if (versionNum) {
    return Math.floor(Number.parseInt(versionNum, 10) / 10000);
  }
  const version = text.match(/(?:PostgreSQL\)?\s+)?(\d+)(?:\.\d+)?/)?.[1];
  if (version) {
    return Number.parseInt(version, 10);
  }
  throw new Error(`Could not determine ${label} Postgres major version.`);
};

const assertPostgresToolMajorMatchesServer = async ({
  env,
  run,
  databaseUrl,
  toolBin,
  toolName
}) => {
  const psql = env.PSQL_BIN || "psql";
  const [server, tool] = await Promise.all([
    run(psql, [databaseUrl, "-tAc", "show server_version_num"]),
    run(toolBin, ["--version"])
  ]);
  const serverMajor = parsePostgresMajor(
    server.stdout || server.stderr,
    "server"
  );
  const toolMajor = parsePostgresMajor(
    tool.stdout || tool.stderr,
    path.basename(toolBin)
  );
  if (serverMajor !== toolMajor) {
    throw new Error(
      `${toolName} major version ${toolMajor} does not match target Postgres major version ${serverMajor}. Set ${toolName === "pg_dump" ? "PG_DUMP_BIN" : "PG_RESTORE_BIN"} and PSQL_BIN to matching Postgres ${serverMajor} binaries before running hosted backup operations.`
    );
  }
};

const writeJson = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
};

const statusPayload = ({ now, status, provider, details }) => ({
  status,
  provider,
  checkedAt: now.toISOString(),
  lastSuccessfulAt: status === "ok" ? now.toISOString() : null,
  rpoSeconds: DEFAULT_BACKUP_RPO_SECONDS,
  rtoSeconds: DEFAULT_RESTORE_RTO_SECONDS,
  ...details
});

const writeStatus = (statusPath, payload) => {
  if (statusPath) {
    writeJson(statusPath, payload);
  }
};

const providerForBackupCommand = (command) =>
  command === "create" ? "pg_dump" : "pg_restore";

const writeFailureStatus = ({ env, now, options, error }) => {
  const statusPath = options.statusPath ?? env.KOED_BACKUP_STATUS_PATH;
  if (!statusPath) {
    return;
  }
  const previous = readJsonIfPresent(statusPath);
  const previousSuccessfulAt =
    typeof previous?.lastSuccessfulAt === "string"
      ? previous.lastSuccessfulAt
      : null;
  const message = error instanceof Error ? error.message : String(error);
  writeStatus(
    statusPath,
    statusPayload({
      now,
      status: "error",
      provider: providerForBackupCommand(options.command),
      details: {
        operation: options.command,
        lastSuccessfulAt: previousSuccessfulAt,
        failureAt: now.toISOString(),
        errorType: error instanceof Error ? error.name : "Error",
        errorMessage: redactSensitiveText(message)
      }
    })
  );
};

export const createHostedBackup = async ({
  env = process.env,
  now = new Date(),
  options,
  run = runCommand
}) => {
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  const outputDir = options.outputDir;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or --database-url is required.");
  }
  if (!outputDir) {
    throw new Error("--output-dir is required.");
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const encryptionProvider = archiveEncryptionProvider(env, options);
  const plaintextBackupFile = path.join(
    outputDir,
    `koed-${timestamp(now)}.dump`
  );
  const backupFile = encryptionProvider
    ? `${plaintextBackupFile}.enc`
    : plaintextBackupFile;
  const postgresClient = await resolvePostgresClientRuntime({
    env,
    run,
    command: "create",
    databaseUrl
  });
  try {
    if (postgresClient.kind === "docker-compose") {
      await run(
        "docker",
        dockerComposeExecArgs(env, "postgres", "pg_dump", [
          "--format=custom",
          "--no-owner",
          "--no-acl",
          "--dbname",
          dockerContainerDatabaseUrl(databaseUrl, env)
        ]),
        { stdoutFile: plaintextBackupFile }
      );
    } else {
      await run(postgresClient.pgDumpBin ?? env.PG_DUMP_BIN ?? "pg_dump", [
        "--format=custom",
        "--no-owner",
        "--no-acl",
        "--file",
        plaintextBackupFile,
        databaseUrl
      ]);
    }

    let encryption = null;
    if (encryptionProvider) {
      const envelope = await encryptBackupArchive({
        plaintextFile: plaintextBackupFile,
        encryptedFile: backupFile,
        provider: encryptionProvider,
        now
      });
      encryption = {
        encrypted: true,
        envelope
      };
    }

    const stats = fs.statSync(backupFile);
    const manifest = {
      schemaVersion: 2,
      provider: "pg_dump",
      createdAt: now.toISOString(),
      encrypted: Boolean(encryptionProvider),
      databaseUrl: redactDatabaseUrl(databaseUrl),
      backupFile: path.basename(backupFile),
      bytes: stats.size,
      sha256: sha256File(backupFile),
      rpoSeconds: DEFAULT_BACKUP_RPO_SECONDS,
      rtoSeconds: DEFAULT_RESTORE_RTO_SECONDS,
      ...(encryption ? { encryption } : {})
    };
    const manifestPath = `${backupFile}.manifest.json`;
    writeJson(manifestPath, manifest);
    const status = statusPayload({
      now,
      status: "ok",
      provider: "pg_dump",
      details: {
        backupFile: path.basename(backupFile),
        manifestFile: path.basename(manifestPath),
        bytes: manifest.bytes,
        sha256: manifest.sha256,
        encrypted: manifest.encrypted,
        encryptionProviderMode:
          manifest.encryption?.envelope?.providerMode ?? null,
        encryptionKeyId: manifest.encryption?.envelope?.keyId ?? null
      }
    });
    writeStatus(options.statusPath ?? env.KOED_BACKUP_STATUS_PATH, status);
    return { ok: true, backupFile, manifestPath, manifest, status };
  } finally {
    if (encryptionProvider) {
      fs.rmSync(plaintextBackupFile, { force: true });
    }
  }
};

export const verifyHostedBackup = async ({
  env = process.env,
  now = new Date(),
  options,
  run = runCommand
}) => {
  if (!options.backupFile) {
    throw new Error("--backup-file is required.");
  }
  const postgresClient = await resolvePostgresClientRuntime({
    env,
    run,
    command: "verify"
  });
  const result = await withReadableBackupArchive({
    env,
    options,
    now,
    callback: (readableBackupFile) =>
      postgresClient.kind === "docker-compose"
        ? run(
            "docker",
            dockerComposeExecArgs(env, "postgres", "pg_restore", ["--list"]),
            { stdinFile: readableBackupFile }
          )
        : run(
            postgresClient.pgRestoreBin ?? env.PG_RESTORE_BIN ?? "pg_restore",
            ["--list", readableBackupFile]
          )
  });
  const manifest = readJsonIfPresent(inferManifestPath(options.backupFile));
  const status = statusPayload({
    now,
    status: "ok",
    provider: "pg_restore",
    details: {
      backupFile: path.basename(options.backupFile),
      encrypted: manifest?.encrypted === true,
      encryptionProviderMode:
        manifest?.encryption?.envelope?.providerMode ?? null,
      encryptionKeyId: manifest?.encryption?.envelope?.keyId ?? null,
      entries: result.stdout
        .split(/\r?\n/)
        .filter((line) => line.trim() && !line.trim().startsWith(";")).length
    }
  });
  writeStatus(options.statusPath ?? env.KOED_BACKUP_STATUS_PATH, status);
  return { ok: true, backupFile: options.backupFile, status };
};

export const restoreSmokeHostedBackup = async ({
  env = process.env,
  now = new Date(),
  options,
  run = runCommand
}) => {
  if (!options.backupFile) {
    throw new Error("--backup-file is required.");
  }
  if (!options.targetDatabaseUrl) {
    throw new Error("--target-database-url is required.");
  }
  assertRestoreSmokeTargetIsSafe(
    options.targetDatabaseUrl,
    options.confirmRestoreSmokeTarget
  );
  const postgresClient = await resolvePostgresClientRuntime({
    env,
    run,
    command: "restore-smoke",
    databaseUrl: options.targetDatabaseUrl
  });
  const manifest = readJsonIfPresent(inferManifestPath(options.backupFile));
  await withReadableBackupArchive({
    env,
    options,
    now,
    callback: (readableBackupFile) =>
      postgresClient.kind === "docker-compose"
        ? run(
            "docker",
            dockerComposeExecArgs(env, "postgres", "pg_restore", [
              "--clean",
              "--if-exists",
              "--no-owner",
              "--no-acl",
              "--dbname",
              dockerContainerDatabaseUrl(options.targetDatabaseUrl, env)
            ]),
            { stdinFile: readableBackupFile }
          )
        : run(
            postgresClient.pgRestoreBin ?? env.PG_RESTORE_BIN ?? "pg_restore",
            [
              "--clean",
              "--if-exists",
              "--no-owner",
              "--no-acl",
              "--dbname",
              options.targetDatabaseUrl,
              readableBackupFile
            ]
          )
  });
  const status = statusPayload({
    now,
    status: "ok",
    provider: "pg_restore",
    details: {
      backupFile: path.basename(options.backupFile),
      encrypted: manifest?.encrypted === true,
      encryptionProviderMode:
        manifest?.encryption?.envelope?.providerMode ?? null,
      encryptionKeyId: manifest?.encryption?.envelope?.keyId ?? null,
      restoreSmoke: "passed",
      targetDatabaseUrl: redactDatabaseUrl(options.targetDatabaseUrl)
    }
  });
  writeStatus(options.statusPath ?? env.KOED_BACKUP_STATUS_PATH, status);
  return { ok: true, backupFile: options.backupFile, status };
};

export const runHostedBackupCommand = async ({
  argv = process.argv.slice(2),
  env = process.env,
  now = new Date(),
  run = runCommand,
  stdout = process.stdout
} = {}) => {
  const options = parseHostedBackupArgs(argv);
  if (options.command === "help") {
    stdout.write(usage);
    return { ok: true, help: true };
  }
  const config = { env, now, options, run };
  let result;
  try {
    if (options.command === "create") {
      const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
      if (databaseUrl) {
        const postgresClient = await resolvePostgresClientRuntime({
          env,
          run,
          command: "create",
          databaseUrl
        });
        if (postgresClient.kind === "host") {
          await assertPostgresToolMajorMatchesServer({
            env: {
              ...env,
              ...(postgresClient.psqlBin
                ? { PSQL_BIN: postgresClient.psqlBin }
                : {})
            },
            run,
            databaseUrl,
            toolBin: postgresClient.pgDumpBin ?? env.PG_DUMP_BIN ?? "pg_dump",
            toolName: "pg_dump"
          });
        }
      }
    } else if (
      options.command === "restore-smoke" &&
      options.targetDatabaseUrl
    ) {
      assertRestoreSmokeTargetIsSafe(
        options.targetDatabaseUrl,
        options.confirmRestoreSmokeTarget
      );
      const postgresClient = await resolvePostgresClientRuntime({
        env,
        run,
        command: "restore-smoke",
        databaseUrl: options.targetDatabaseUrl
      });
      if (postgresClient.kind === "host") {
        await assertPostgresToolMajorMatchesServer({
          env: {
            ...env,
            ...(postgresClient.psqlBin
              ? { PSQL_BIN: postgresClient.psqlBin }
              : {})
          },
          run,
          databaseUrl: options.targetDatabaseUrl,
          toolBin:
            postgresClient.pgRestoreBin ?? env.PG_RESTORE_BIN ?? "pg_restore",
          toolName: "pg_restore"
        });
      }
    }
    result =
      options.command === "create"
        ? await createHostedBackup(config)
        : options.command === "verify"
          ? await verifyHostedBackup(config)
          : await restoreSmokeHostedBackup(config);
  } catch (error) {
    writeFailureStatus({ env, now, options, error });
    throw error;
  }
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
};
