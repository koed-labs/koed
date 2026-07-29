import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
const collaborationTransportSummaryVersion = 1;
const collaborationRestoreSentinelVersion = 1;
const collaborationThreadNameMarker = "[koed encrypted collaboration name]";
const collaborationThreadTopicMarker = "[koed encrypted collaboration topic]";
const collaborationMessageBodyMarker = "[koed encrypted collaboration message]";
const collaborationMessageMetadataMarker =
  "[koed encrypted collaboration metadata]";
const collaborationMessageProvenanceMarker =
  "[koed encrypted collaboration provenance]";

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

const collaborationTransportSummarySql = `-- koed collaboration transport summary v1
set time zone 'UTC';
with
thread_rows as (
  select
    thread.id::text as sort_key,
    encode(digest(to_jsonb(thread)::text, 'sha256'), 'hex') as row_value
  from collaboration_threads thread
),
thread_summary as (
  select
    count(*)::bigint as row_count,
    encode(digest(coalesce(string_agg(row_value, E'\\n' order by sort_key), ''), 'sha256'), 'hex') as row_sha256
  from thread_rows
),
message_rows as (
  select
    message.id::text as sort_key,
    encode(digest(to_jsonb(message)::text, 'sha256'), 'hex') as row_value
  from collaboration_messages message
),
message_summary as (
  select
    count(*)::bigint as row_count,
    encode(digest(coalesce(string_agg(row_value, E'\\n' order by sort_key), ''), 'sha256'), 'hex') as row_sha256
  from message_rows
),
companion_rows as (
  select
    concat_ws(':', payload.source_table, payload.source_id::text, payload.source_column, payload.id::text) as sort_key,
    encode(digest(to_jsonb(payload)::text, 'sha256'), 'hex') as row_value
  from encrypted_field_payloads payload
  where payload.source_table in ('collaboration_threads', 'collaboration_messages')
),
companion_summary as (
  select
    count(*)::bigint as row_count,
    encode(digest(coalesce(string_agg(row_value, E'\\n' order by sort_key), ''), 'sha256'), 'hex') as row_sha256
  from companion_rows
),
outbox_rows as (
  select
    event.id::text as sort_key,
    encode(digest(to_jsonb(event)::text, 'sha256'), 'hex') as row_value
  from collaboration_outbox event
),
outbox_summary as (
  select
    count(*)::bigint as row_count,
    encode(digest(coalesce(string_agg(row_value, E'\\n' order by sort_key), ''), 'sha256'), 'hex') as row_sha256
  from outbox_rows
),
key_reference_rows as (
  select
    concat_ws(':', payload.provider_mode, payload.key_id, payload.key_version::text) as sort_key,
    jsonb_build_array(
      payload.provider_mode,
      payload.key_id,
      payload.key_version,
      count(*)
    )::text as row_value
  from encrypted_field_payloads payload
  where payload.source_table in ('collaboration_threads', 'collaboration_messages')
  group by payload.provider_mode, payload.key_id, payload.key_version
),
key_reference_summary as (
  select
    count(*)::bigint as reference_count,
    encode(digest(coalesce(string_agg(row_value, E'\\n' order by sort_key), ''), 'sha256'), 'hex') as reference_sha256
  from key_reference_rows
),
relationship_summary as (
  select
    (select count(*) from collaboration_messages message
      left join collaboration_threads thread on thread.id = message.thread_id
      where thread.id is null)::bigint as broken_message_thread_links,
    (select count(*) from encrypted_field_payloads payload
      left join collaboration_threads thread
        on payload.source_table = 'collaboration_threads'
       and thread.id = payload.source_id
      left join collaboration_messages message
        on payload.source_table = 'collaboration_messages'
       and message.id = payload.source_id
      where payload.source_table in ('collaboration_threads', 'collaboration_messages')
        and thread.id is null
        and message.id is null)::bigint as broken_companion_source_links,
    (select count(*) from collaboration_outbox event
      left join collaboration_threads thread on thread.id = event.thread_id
      where event.thread_id is not null and thread.id is null)::bigint as broken_outbox_thread_links,
    (select count(*) from collaboration_outbox event
      left join collaboration_messages message
        on message.id = event.message_id
       and (event.thread_id is null or message.thread_id = event.thread_id)
      where event.message_id is not null and message.id is null)::bigint as broken_outbox_message_links,
    (select count(*) from collaboration_outbox event
      left join collaboration_threads thread
        on event.resource_type = 'collaboration_thread'
       and thread.id = event.resource_id
      left join collaboration_messages message
        on event.resource_type = 'collaboration_message'
       and message.id = event.resource_id
      where (event.resource_type = 'collaboration_thread' and thread.id is null)
         or (event.resource_type = 'collaboration_message' and message.id is null)
    )::bigint as broken_outbox_resource_links,
    (select count(*) from encrypted_field_payloads payload
      left join collaboration_threads thread
        on payload.source_table = 'collaboration_threads'
       and thread.id = payload.source_id
      left join collaboration_messages message
        on payload.source_table = 'collaboration_messages'
       and message.id = payload.source_id
      where payload.source_table in ('collaboration_threads', 'collaboration_messages')
        and not (
          (
            payload.source_table = 'collaboration_threads'
            and (
              (thread.scope = 'personal'
                and payload.encryption_scope = 'personal'
                and payload.owner_user_id = thread.personal_owner_user_id
                and payload.team_id is null
                and payload.team_workspace_id is null)
              or
              (thread.scope = 'team'
                and payload.encryption_scope = 'team'
                and payload.team_id = thread.team_id
                and payload.team_workspace_id is not distinct from thread.team_workspace_id)
            )
          )
          or
          (
            payload.source_table = 'collaboration_messages'
            and (
              (message.scope = 'personal'
                and payload.encryption_scope = 'personal'
                and payload.owner_user_id = message.personal_owner_user_id
                and payload.team_id is null
                and payload.team_workspace_id is null)
              or
              (message.scope = 'team'
                and payload.encryption_scope = 'team'
                and payload.team_id = message.team_id
                and payload.team_workspace_id is not distinct from message.team_workspace_id)
            )
          )
        )
    )::bigint as broken_companion_authorization_bindings
)
select json_build_object(
  'version', ${collaborationTransportSummaryVersion},
  'state', case
    when thread_summary.row_count = 0
      and message_summary.row_count = 0
      and companion_summary.row_count = 0
      and outbox_summary.row_count = 0
    then 'empty'
    else 'non_empty'
  end,
  'families', json_build_object(
    'threads', json_build_object(
      'count', thread_summary.row_count,
      'sha256', thread_summary.row_sha256
    ),
    'messages', json_build_object(
      'count', message_summary.row_count,
      'sha256', message_summary.row_sha256
    ),
    'encryptedCompanions', json_build_object(
      'count', companion_summary.row_count,
      'sha256', companion_summary.row_sha256
    ),
    'outbox', json_build_object(
      'count', outbox_summary.row_count,
      'sha256', outbox_summary.row_sha256
    )
  ),
  'keyReferences', json_build_object(
    'count', key_reference_summary.reference_count,
    'sha256', key_reference_summary.reference_sha256
  ),
  'relationships', json_build_object(
    'brokenMessageThreadLinks', relationship_summary.broken_message_thread_links,
    'brokenCompanionSourceLinks', relationship_summary.broken_companion_source_links,
    'brokenOutboxThreadLinks', relationship_summary.broken_outbox_thread_links,
    'brokenOutboxMessageLinks', relationship_summary.broken_outbox_message_links,
    'brokenOutboxResourceLinks', relationship_summary.broken_outbox_resource_links,
    'brokenCompanionAuthorizationBindings', relationship_summary.broken_companion_authorization_bindings
  )
)::text
from thread_summary, message_summary, companion_summary, outbox_summary,
  key_reference_summary, relationship_summary;
`;

const collaborationTransportFamilyNames = [
  "threads",
  "messages",
  "encryptedCompanions",
  "outbox"
];

const collaborationTransportRelationshipNames = [
  "brokenMessageThreadLinks",
  "brokenCompanionSourceLinks",
  "brokenOutboxThreadLinks",
  "brokenOutboxMessageLinks",
  "brokenOutboxResourceLinks",
  "brokenCompanionAuthorizationBindings"
];

const normalizeCollaborationTransportSummary = (summary) => {
  if (
    !summary ||
    summary.version !== collaborationTransportSummaryVersion ||
    !["empty", "non_empty"].includes(summary.state)
  ) {
    throw new Error("Collaboration transport summary is invalid.");
  }
  const families = {};
  for (const name of collaborationTransportFamilyNames) {
    const family = summary.families?.[name];
    const count = Number(family?.count);
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      !/^[a-f0-9]{64}$/.test(family?.sha256 ?? "")
    ) {
      throw new Error("Collaboration transport summary is invalid.");
    }
    families[name] = { count, sha256: family.sha256 };
  }
  const keyReferenceCount = Number(summary.keyReferences?.count);
  if (
    !Number.isSafeInteger(keyReferenceCount) ||
    keyReferenceCount < 0 ||
    !/^[a-f0-9]{64}$/.test(summary.keyReferences?.sha256 ?? "")
  ) {
    throw new Error("Collaboration transport summary is invalid.");
  }
  const relationships = {};
  for (const name of collaborationTransportRelationshipNames) {
    const count = Number(summary.relationships?.[name]);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("Collaboration transport summary is invalid.");
    }
    relationships[name] = count;
  }
  const isEmpty = collaborationTransportFamilyNames.every(
    (name) => families[name].count === 0
  );
  if ((summary.state === "empty") !== isEmpty) {
    throw new Error("Collaboration transport summary state is inconsistent.");
  }
  if (Object.values(relationships).some((count) => count !== 0)) {
    throw new Error(
      "Collaboration transport summary contains broken encrypted or outbox links."
    );
  }
  return {
    version: collaborationTransportSummaryVersion,
    state: summary.state,
    families,
    keyReferences: {
      count: keyReferenceCount,
      sha256: summary.keyReferences.sha256
    },
    relationships
  };
};

const sha256Text = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const createCollaborationRestoreSentinel = async ({ provider, now }) => {
  const ownerUserId = crypto.randomUUID();
  const threadId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const threadName = `restore-${crypto.randomBytes(24).toString("base64url")}`;
  const plaintextFields = [
    {
      id: crypto.randomUUID(),
      sourceTable: "collaboration_threads",
      sourceId: threadId,
      sourceColumn: "name",
      plaintextContentType: "text/plain",
      plaintext: threadName
    },
    {
      id: crypto.randomUUID(),
      sourceTable: "collaboration_threads",
      sourceId: threadId,
      sourceColumn: "topic",
      plaintextContentType: "text/plain",
      plaintext: `topic-${crypto.randomBytes(24).toString("base64url")}`
    },
    {
      id: crypto.randomUUID(),
      sourceTable: "collaboration_messages",
      sourceId: messageId,
      sourceColumn: "body",
      plaintextContentType: "text/plain",
      plaintext: `message-${crypto.randomBytes(24).toString("base64url")}`
    },
    {
      id: crypto.randomUUID(),
      sourceTable: "collaboration_messages",
      sourceId: messageId,
      sourceColumn: "metadata",
      plaintextContentType: "application/json",
      plaintext: JSON.stringify({
        restoreProof: crypto.randomBytes(24).toString("base64url")
      })
    },
    {
      id: crypto.randomUUID(),
      sourceTable: "collaboration_messages",
      sourceId: messageId,
      sourceColumn: "provenance",
      plaintextContentType: "application/json",
      plaintext: JSON.stringify({
        kind: "hosted_restore_smoke",
        id: crypto.randomBytes(24).toString("base64url")
      })
    }
  ];
  const companions = [];
  for (const field of plaintextFields) {
    const isMessage = field.sourceTable === "collaboration_messages";
    const envelope = await provider.encrypt({
      plaintext: Buffer.from(field.plaintext, "utf8"),
      scope: {
        objectClass: isMessage
          ? "collaboration_message"
          : "collaboration_thread"
      },
      provenance: {
        rowFamily: isMessage ? "collaboration_message" : "collaboration_thread",
        sourceTable: field.sourceTable,
        sourceColumn: field.sourceColumn,
        sourceId: field.sourceId
      },
      ciphertextLocation: "encrypted_field_payloads",
      aad: {
        ownerUserId,
        visibility: "personal",
        encryptionScope: "personal",
        sourceTable: field.sourceTable,
        sourceId: field.sourceId,
        sourceColumn: field.sourceColumn,
        ...(isMessage
          ? {
              threadId,
              threadSequence: 1,
              collaborationScope: "personal",
              threadKind: "personal_channel"
            }
          : {
              collaborationScope: "personal",
              threadKind: "personal_channel"
            })
      },
      now
    });
    companions.push({
      id: field.id,
      sourceTable: field.sourceTable,
      sourceId: field.sourceId,
      sourceColumn: field.sourceColumn,
      plaintextContentType: field.plaintextContentType,
      plaintextSha256: sha256Text(field.plaintext),
      envelope
    });
  }
  return {
    version: collaborationRestoreSentinelVersion,
    createdAt: now.toISOString(),
    ownerUserId,
    thread: {
      id: threadId,
      logicalId: crypto.randomUUID(),
      normalizedNameHash: sha256Text(threadName.trim().toLowerCase())
    },
    message: {
      id: messageId,
      idempotencyKeyHash: sha256Text(crypto.randomBytes(32)),
      requestHash: sha256Text(crypto.randomBytes(32)),
      provenanceId: sha256Text(crypto.randomBytes(32))
    },
    outbox: [
      {
        id: crypto.randomUUID(),
        family: "thread_lifecycle",
        mutationId: crypto.randomUUID()
      },
      {
        id: crypto.randomUUID(),
        family: "message_created",
        mutationId: crypto.randomUUID()
      }
    ],
    companions
  };
};

const sqlLiteral = (value) =>
  value === null || value === undefined
    ? "null"
    : `'${String(value).replaceAll("'", "''")}'`;

const jsonSqlLiteral = (value) => `${sqlLiteral(JSON.stringify(value))}::jsonb`;

const buildCollaborationRestoreSentinelSeedSql = (sentinel) => {
  const companionRows = sentinel.companions
    .map((companion) => {
      const envelope = companion.envelope;
      return `(
        ${sqlLiteral(companion.id)}::uuid,
        ${sqlLiteral(sentinel.ownerUserId)}::uuid,
        'personal', 'personal',
        ${sqlLiteral(companion.sourceTable)},
        ${sqlLiteral(companion.sourceId)}::uuid,
        ${sqlLiteral(companion.sourceColumn)},
        ${sqlLiteral(companion.plaintextContentType)}, 'utf8',
        ${Number(envelope.version)},
        ${sqlLiteral(envelope.providerMode)},
        ${sqlLiteral(envelope.keyId)},
        ${Number(envelope.keyVersion)},
        ${jsonSqlLiteral(envelope.scope)},
        ${jsonSqlLiteral(envelope.provenance)},
        ${sqlLiteral(envelope.algorithm)},
        ${sqlLiteral(envelope.ciphertext)},
        ${sqlLiteral(envelope.nonce)},
        ${sqlLiteral(envelope.tag)},
        ${jsonSqlLiteral(envelope.wrappedDek)},
        ${sqlLiteral(envelope.ciphertextLocation)},
        ${jsonSqlLiteral(envelope.aad)},
        ${sqlLiteral(envelope.createdAt)}::timestamptz,
        ${sqlLiteral(envelope.reencryptedAt)}::timestamptz
      )`;
    })
    .join(",\n");
  const threadOutbox = sentinel.outbox.find(
    (event) => event.family === "thread_lifecycle"
  );
  const messageOutbox = sentinel.outbox.find(
    (event) => event.family === "message_created"
  );
  return `-- koed collaboration restore sentinel seed v1
begin;
insert into users (id, email)
values (
  ${sqlLiteral(sentinel.ownerUserId)}::uuid,
  ${sqlLiteral(`restore-smoke-${sentinel.ownerUserId}@invalid.koed`)}
);

insert into collaboration_threads (
  id, logical_id, scope, kind, personal_owner_user_id, name_marker,
  topic_marker, normalized_name_hash, created_by_user_id, next_sequence
)
values (
  ${sqlLiteral(sentinel.thread.id)}::uuid,
  ${sqlLiteral(sentinel.thread.logicalId)}::uuid,
  'personal', 'personal_channel',
  ${sqlLiteral(sentinel.ownerUserId)}::uuid,
  ${sqlLiteral(collaborationThreadNameMarker)},
  ${sqlLiteral(collaborationThreadTopicMarker)},
  ${sqlLiteral(sentinel.thread.normalizedNameHash)},
  ${sqlLiteral(sentinel.ownerUserId)}::uuid,
  2
);

insert into collaboration_messages (
  id, thread_id, thread_sequence, scope, personal_owner_user_id,
  sender_kind, sender_principal_id, sender_user_id, idempotency_key_hash,
  request_hash, body_marker, metadata_marker, provenance_kind,
  provenance_id, provenance_marker
)
values (
  ${sqlLiteral(sentinel.message.id)}::uuid,
  ${sqlLiteral(sentinel.thread.id)}::uuid,
  1, 'personal', ${sqlLiteral(sentinel.ownerUserId)}::uuid,
  'user', ${sqlLiteral(sentinel.ownerUserId)}::uuid,
  ${sqlLiteral(sentinel.ownerUserId)}::uuid,
  ${sqlLiteral(sentinel.message.idempotencyKeyHash)},
  ${sqlLiteral(sentinel.message.requestHash)},
  ${sqlLiteral(collaborationMessageBodyMarker)},
  ${sqlLiteral(collaborationMessageMetadataMarker)},
  'encrypted', ${sqlLiteral(sentinel.message.provenanceId)},
  ${sqlLiteral(collaborationMessageProvenanceMarker)}
);

insert into encrypted_field_payloads (
  id, owner_user_id, visibility, encryption_scope, source_table, source_id,
  source_column, plaintext_content_type, plaintext_encoding, envelope_version,
  provider_mode, key_id, key_version, scope, provenance, algorithm, ciphertext,
  nonce, tag, wrapped_dek, ciphertext_location, aad, envelope_created_at,
  envelope_reencrypted_at
)
values
${companionRows};

insert into collaboration_outbox (
  id, protocol_version, family, scope, personal_owner_user_id, thread_id,
  message_id, resource_type, resource_id, actor_principal_id, mutation_id,
  replay_until
)
values
  (
    ${sqlLiteral(threadOutbox.id)}::uuid, 1, 'thread_lifecycle', 'personal',
    ${sqlLiteral(sentinel.ownerUserId)}::uuid,
    ${sqlLiteral(sentinel.thread.id)}::uuid, null,
    'collaboration_thread', ${sqlLiteral(sentinel.thread.id)}::uuid,
    ${sqlLiteral(sentinel.ownerUserId)}::uuid,
    ${sqlLiteral(threadOutbox.mutationId)}::uuid,
    now() + interval '30 days'
  ),
  (
    ${sqlLiteral(messageOutbox.id)}::uuid, 1, 'message_created', 'personal',
    ${sqlLiteral(sentinel.ownerUserId)}::uuid,
    ${sqlLiteral(sentinel.thread.id)}::uuid,
    ${sqlLiteral(sentinel.message.id)}::uuid,
    'collaboration_message', ${sqlLiteral(sentinel.message.id)}::uuid,
    ${sqlLiteral(sentinel.ownerUserId)}::uuid,
    ${sqlLiteral(messageOutbox.mutationId)}::uuid,
    now() + interval '30 days'
  );
commit;
`;
};

const buildCollaborationRestoreSentinelProbeSql = (
  sentinel
) => `-- koed collaboration restore sentinel probe v1
with authorized_sources as (
  select 'collaboration_threads'::text as source_table, thread.id as source_id
  from collaboration_threads thread
  where thread.id = ${sqlLiteral(sentinel.thread.id)}::uuid
    and thread.personal_owner_user_id = ${sqlLiteral(sentinel.ownerUserId)}::uuid
  union all
  select 'collaboration_messages'::text, message.id
  from collaboration_messages message
  join collaboration_threads thread on thread.id = message.thread_id
  where message.id = ${sqlLiteral(sentinel.message.id)}::uuid
    and thread.personal_owner_user_id = ${sqlLiteral(sentinel.ownerUserId)}::uuid
), authorized_companions as (
  select payload.*
  from encrypted_field_payloads payload
  join authorized_sources source
    on source.source_table = payload.source_table
   and source.source_id = payload.source_id
  where payload.owner_user_id = ${sqlLiteral(sentinel.ownerUserId)}::uuid
    and payload.visibility = 'personal'
    and payload.encryption_scope = 'personal'
    and payload.invalidated_at is null
)
select json_build_object(
  'threadCount', (
    select count(*) from collaboration_threads thread
    where thread.id = ${sqlLiteral(sentinel.thread.id)}::uuid
      and thread.logical_id = ${sqlLiteral(sentinel.thread.logicalId)}::uuid
      and thread.personal_owner_user_id = ${sqlLiteral(sentinel.ownerUserId)}::uuid
      and thread.scope = 'personal'
      and thread.kind = 'personal_channel'
      and thread.name_marker = ${sqlLiteral(collaborationThreadNameMarker)}
      and thread.topic_marker = ${sqlLiteral(collaborationThreadTopicMarker)}
      and thread.normalized_name_hash = ${sqlLiteral(sentinel.thread.normalizedNameHash)}
      and thread.next_sequence = 2
  ),
  'messageCount', (
    select count(*) from collaboration_messages message
    where message.id = ${sqlLiteral(sentinel.message.id)}::uuid
      and message.thread_id = ${sqlLiteral(sentinel.thread.id)}::uuid
      and message.thread_sequence = 1
      and message.personal_owner_user_id = ${sqlLiteral(sentinel.ownerUserId)}::uuid
      and message.body_marker = ${sqlLiteral(collaborationMessageBodyMarker)}
      and message.metadata_marker = ${sqlLiteral(collaborationMessageMetadataMarker)}
      and message.provenance_marker = ${sqlLiteral(collaborationMessageProvenanceMarker)}
  ),
  'outboxCount', (
    select count(*) from collaboration_outbox event
    where event.id in (
      ${sqlLiteral(sentinel.outbox[0].id)}::uuid,
      ${sqlLiteral(sentinel.outbox[1].id)}::uuid
    )
      and event.personal_owner_user_id = ${sqlLiteral(sentinel.ownerUserId)}::uuid
      and event.thread_id = ${sqlLiteral(sentinel.thread.id)}::uuid
      and (
        (event.family = 'thread_lifecycle' and event.message_id is null
          and event.resource_type = 'collaboration_thread'
          and event.resource_id = ${sqlLiteral(sentinel.thread.id)}::uuid)
        or
        (event.family = 'message_created'
          and event.message_id = ${sqlLiteral(sentinel.message.id)}::uuid
          and event.resource_type = 'collaboration_message'
          and event.resource_id = ${sqlLiteral(sentinel.message.id)}::uuid)
      )
  ),
  'companions', coalesce((
    select json_agg(json_build_object(
      'id', payload.id,
      'ownerUserId', payload.owner_user_id,
      'sourceTable', payload.source_table,
      'sourceId', payload.source_id,
      'sourceColumn', payload.source_column,
      'plaintextContentType', payload.plaintext_content_type,
      'envelope', json_build_object(
        'version', payload.envelope_version,
        'providerMode', payload.provider_mode,
        'keyId', payload.key_id,
        'keyVersion', payload.key_version,
        'scope', payload.scope,
        'provenance', payload.provenance,
        'algorithm', payload.algorithm,
        'ciphertext', payload.ciphertext,
        'nonce', payload.nonce,
        'tag', payload.tag,
        'wrappedDek', payload.wrapped_dek,
        'ciphertextLocation', payload.ciphertext_location,
        'aad', payload.aad,
        'createdAt', to_char(
          payload.envelope_created_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'reencryptedAt', case
          when payload.envelope_reencrypted_at is null then null
          else to_char(
            payload.envelope_reencrypted_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
        end
      )
    ) order by payload.source_table, payload.source_id, payload.source_column)
    from authorized_companions payload
  ), '[]'::json)
)::text;
`;

const runPostgresScript = async ({
  env,
  run,
  postgresClient,
  databaseUrl,
  script,
  captureOutput = false
}) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "koed-postgres-script-")
  );
  const scriptPath = path.join(tempDir, "operation.sql");
  try {
    fs.writeFileSync(scriptPath, script, { mode: 0o600 });
    const outputArgs = captureOutput
      ? ["--tuples-only", "--no-align", "--quiet"]
      : ["--quiet"];
    if (postgresClient.kind === "docker-compose") {
      return await run(
        "docker",
        dockerComposeExecArgs(env, "postgres", "psql", [
          "--no-psqlrc",
          "--set=ON_ERROR_STOP=1",
          ...outputArgs,
          "--dbname",
          dockerContainerDatabaseUrl(databaseUrl, env)
        ]),
        { stdinFile: scriptPath }
      );
    }
    return await run(postgresClient.psqlBin ?? env.PSQL_BIN ?? "psql", [
      databaseUrl,
      "--no-psqlrc",
      "--set=ON_ERROR_STOP=1",
      ...outputArgs,
      "--file",
      scriptPath
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

const readCollaborationTransportSummary = async ({
  env,
  run,
  postgresClient,
  databaseUrl
}) => {
  const result = await runPostgresScript({
    env,
    run,
    postgresClient,
    databaseUrl,
    script: collaborationTransportSummarySql,
    captureOutput: true
  });
  let summary;
  try {
    summary = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Collaboration transport summary returned invalid output.");
  }
  return normalizeCollaborationTransportSummary(summary);
};

const assertMatchingCollaborationTransportSummaries = (
  expected,
  actual,
  message
) => {
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    throw new Error(message);
  }
};

const validateCollaborationRestoreSentinel = async ({
  sentinel,
  archiveEnvelope,
  provider,
  probe
}) => {
  if (
    sentinel?.version !== collaborationRestoreSentinelVersion ||
    !Array.isArray(sentinel.companions) ||
    sentinel.companions.length !== 5 ||
    !Array.isArray(sentinel.outbox) ||
    sentinel.outbox.length !== 2
  ) {
    throw new Error(
      "Encrypted backup archive is missing valid collaboration restore sentinel metadata."
    );
  }
  if (
    Number(probe.threadCount) !== 1 ||
    Number(probe.messageCount) !== 1 ||
    Number(probe.outboxCount) !== 2 ||
    !Array.isArray(probe.companions) ||
    probe.companions.length !== sentinel.companions.length
  ) {
    throw new Error("Restored collaboration sentinel integrity check failed.");
  }
  const restoredBySource = new Map(
    probe.companions.map((companion) => [
      `${companion.sourceTable}:${companion.sourceId}:${companion.sourceColumn}`,
      companion
    ])
  );
  for (const expected of sentinel.companions) {
    const restored = restoredBySource.get(
      `${expected.sourceTable}:${expected.sourceId}:${expected.sourceColumn}`
    );
    if (
      !restored ||
      restored.id !== expected.id ||
      restored.ownerUserId !== sentinel.ownerUserId ||
      restored.plaintextContentType !== expected.plaintextContentType ||
      canonicalJson(restored.envelope) !== canonicalJson(expected.envelope)
    ) {
      throw new Error(
        "Restored collaboration encrypted companion integrity check failed."
      );
    }
    if (
      restored.envelope.providerMode !== archiveEnvelope.providerMode ||
      restored.envelope.keyId !== archiveEnvelope.keyId ||
      restored.envelope.keyVersion !== archiveEnvelope.keyVersion
    ) {
      throw new Error(
        "Restored collaboration key reference does not match the backup provider key."
      );
    }
    const plaintext = await provider.decrypt(restored.envelope);
    if (sha256Text(plaintext) !== expected.plaintextSha256) {
      throw new Error(
        "Authorized restored collaboration decrypt integrity check failed."
      );
    }
  }
};

const proveCollaborationRestoreSentinel = async ({
  env,
  run,
  postgresClient,
  targetDatabaseUrl,
  manifest
}) => {
  const sentinel = manifest?.collaborationRestoreSentinel;
  if (!sentinel) {
    throw new Error(
      "Encrypted backup archive does not contain collaboration restore sentinel metadata."
    );
  }
  const provider = archiveEncryptionProvider(env, {});
  await runPostgresScript({
    env,
    run,
    postgresClient,
    databaseUrl: targetDatabaseUrl,
    script: buildCollaborationRestoreSentinelSeedSql(sentinel)
  });
  const probeResult = await runPostgresScript({
    env,
    run,
    postgresClient,
    databaseUrl: targetDatabaseUrl,
    script: buildCollaborationRestoreSentinelProbeSql(sentinel),
    captureOutput: true
  });
  let probe;
  try {
    probe = JSON.parse(probeResult.stdout.trim());
  } catch {
    throw new Error(
      "Restored collaboration sentinel probe returned invalid output."
    );
  }
  await validateCollaborationRestoreSentinel({
    sentinel,
    archiveEnvelope: manifest.encryption.envelope,
    provider,
    probe
  });
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
  let completed = false;
  try {
    const collaborationTransportSummary =
      await readCollaborationTransportSummary({
        env,
        run,
        postgresClient,
        databaseUrl
      });
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
    const collaborationTransportSummaryAfterDump =
      await readCollaborationTransportSummary({
        env,
        run,
        postgresClient,
        databaseUrl
      });
    assertMatchingCollaborationTransportSummaries(
      collaborationTransportSummary,
      collaborationTransportSummaryAfterDump,
      "Collaboration data changed while pg_dump was running; retry the backup."
    );

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
    const collaborationRestoreSentinel = encryptionProvider
      ? await createCollaborationRestoreSentinel({
          provider: encryptionProvider,
          now
        })
      : null;

    const stats = fs.statSync(backupFile);
    const manifest = {
      schemaVersion: 4,
      provider: "pg_dump",
      createdAt: now.toISOString(),
      encrypted: Boolean(encryptionProvider),
      databaseUrl: redactDatabaseUrl(databaseUrl),
      backupFile: path.basename(backupFile),
      bytes: stats.size,
      sha256: sha256File(backupFile),
      rpoSeconds: DEFAULT_BACKUP_RPO_SECONDS,
      rtoSeconds: DEFAULT_RESTORE_RTO_SECONDS,
      collaborationTransportSummary,
      ...(encryption ? { encryption } : {}),
      ...(collaborationRestoreSentinel ? { collaborationRestoreSentinel } : {})
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
    completed = true;
    return { ok: true, backupFile, manifestPath, manifest, status };
  } finally {
    if (encryptionProvider || !completed) {
      fs.rmSync(plaintextBackupFile, { force: true });
    }
    if (!completed && backupFile !== plaintextBackupFile) {
      fs.rmSync(backupFile, { force: true });
      fs.rmSync(inferManifestPath(backupFile), { force: true });
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
  if (!manifest?.collaborationTransportSummary) {
    throw new Error(
      "Backup archive does not contain a collaboration transport summary."
    );
  }
  const expectedCollaborationTransportSummary =
    normalizeCollaborationTransportSummary(
      manifest.collaborationTransportSummary
    );
  if (manifest?.encrypted === true && !manifest.collaborationRestoreSentinel) {
    throw new Error(
      "Encrypted backup archive does not contain collaboration restore sentinel metadata."
    );
  }
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
  const restoredCollaborationTransportSummary =
    await readCollaborationTransportSummary({
      env,
      run,
      postgresClient,
      databaseUrl: options.targetDatabaseUrl
    });
  assertMatchingCollaborationTransportSummaries(
    expectedCollaborationTransportSummary,
    restoredCollaborationTransportSummary,
    "Restored collaboration data does not match the source backup summary."
  );
  if (manifest?.encrypted === true) {
    await proveCollaborationRestoreSentinel({
      env,
      run,
      postgresClient,
      targetDatabaseUrl: options.targetDatabaseUrl,
      manifest
    });
  }
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
      collaborationTransportIntegrity: "passed",
      collaborationTransportSourceState:
        expectedCollaborationTransportSummary.state,
      collaborationSyntheticIntegrity:
        manifest?.encrypted === true ? "passed" : "not_available",
      collaborationSentinelVersion:
        manifest?.collaborationRestoreSentinel?.version ?? null,
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
