import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class UsageError extends Error {}

const databaseConnectionCodes = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPERM"
]);

const usage = `Usage: pnpm api-token:create --owner-email <email> [--name <name>]

Options:
  --owner-email <email>  Email for the passwordless local owner user.
  --name <name>         API token name. Defaults to "Client Integration".
  --help                Show this help.
`;

const listUsage = `Usage: pnpm api-token:list --owner-email <email>

Options:
  --owner-email <email>  Email for the local owner user.
  --help                Show this help.
`;

const revokeUsage = `Usage: pnpm api-token:revoke --owner-email <email> --token-id <uuid>

Options:
  --owner-email <email>  Email for the local owner user.
  --token-id <uuid>     API token id to revoke.
  --help                Show this help.
`;

const readFlagValue = (argv, index, flag, usageText = usage) => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a value.\n\n${usageText}`);
  }
  return value;
};

export const parseCreateApiTokenArgs = (argv) => {
  const parsed = {
    name: "Client Integration",
    ownerEmail: null,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--owner-email") {
      parsed.ownerEmail = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--owner-email=")) {
      parsed.ownerEmail = arg.slice("--owner-email=".length);
      continue;
    }
    if (arg === "--name") {
      parsed.name = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--name=")) {
      parsed.name = arg.slice("--name=".length);
      continue;
    }
    throw new UsageError(`Unknown argument: ${arg}\n\n${usage}`);
  }

  if (parsed.help) {
    return parsed;
  }

  parsed.ownerEmail = parsed.ownerEmail?.trim().toLowerCase() ?? null;
  parsed.name = parsed.name.trim();
  if (!parsed.ownerEmail) {
    throw new UsageError(`--owner-email is required.\n\n${usage}`);
  }
  if (!parsed.name) {
    throw new UsageError("--name must not be empty.");
  }

  return parsed;
};

export const helpText = usage;
export const listHelpText = listUsage;
export const revokeHelpText = revokeUsage;

const parseOwnerEmailArgs = (argv, usageText) => {
  const parsed = {
    ownerEmail: null,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--owner-email") {
      parsed.ownerEmail = readFlagValue(argv, index, arg, usageText);
      index += 1;
      continue;
    }
    if (arg.startsWith("--owner-email=")) {
      parsed.ownerEmail = arg.slice("--owner-email=".length);
      continue;
    }
    throw new UsageError(`Unknown argument: ${arg}\n\n${usageText}`);
  }

  if (parsed.help) {
    return parsed;
  }

  parsed.ownerEmail = parsed.ownerEmail?.trim().toLowerCase() ?? null;
  if (!parsed.ownerEmail) {
    throw new UsageError(`--owner-email is required.\n\n${usageText}`);
  }

  return parsed;
};

export const parseListApiTokenArgs = (argv) =>
  parseOwnerEmailArgs(argv, listUsage);

export const parseRevokeApiTokenArgs = (argv) => {
  const parsed = {
    ownerEmail: null,
    tokenId: null,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--owner-email") {
      parsed.ownerEmail = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--owner-email=")) {
      parsed.ownerEmail = arg.slice("--owner-email=".length);
      continue;
    }
    if (arg === "--token-id") {
      parsed.tokenId = readFlagValue(argv, index, arg, revokeUsage);
      index += 1;
      continue;
    }
    if (arg.startsWith("--token-id=")) {
      parsed.tokenId = arg.slice("--token-id=".length);
      continue;
    }
    throw new UsageError(`Unknown argument: ${arg}\n\n${revokeUsage}`);
  }

  if (parsed.help) {
    return parsed;
  }

  parsed.ownerEmail = parsed.ownerEmail?.trim().toLowerCase() ?? null;
  parsed.tokenId = parsed.tokenId?.trim() ?? null;
  if (!parsed.ownerEmail) {
    throw new UsageError(`--owner-email is required.\n\n${revokeUsage}`);
  }
  if (!parsed.tokenId) {
    throw new UsageError(`--token-id is required.\n\n${revokeUsage}`);
  }

  return parsed;
};

const unquoteEnvValue = (value) => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

export const loadRootEnv = (rootDir, environment = process.env) => {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    if (environment[key] === undefined) {
      environment[key] = unquoteEnvValue(value);
    }
  }
};

export const requireEnv = (environment, keys) => {
  const missing = keys.filter((key) => !environment[key]?.trim());
  if (missing.length > 0) {
    throw new UsageError(
      `Missing required environment value${missing.length > 1 ? "s" : ""}: ${missing.join(
        ", "
      )}`
    );
  }
};

const errorCode = (error) =>
  typeof error === "object" && error !== null && typeof error.code === "string"
    ? error.code
    : null;

const errorMessage = (error) =>
  error instanceof Error && error.message.trim()
    ? error.message.trim()
    : String(error).trim();

const aggregateErrorMessages = (error) =>
  error instanceof AggregateError
    ? error.errors
        .map((item) => errorMessage(item))
        .filter((message) => message && message !== "Error")
    : [];

export const formatCliError = (error) => {
  const code = errorCode(error);
  const nestedMessages = aggregateErrorMessages(error);
  const message = errorMessage(error);
  const usefulMessage = message && message !== "AggregateError" ? message : "";
  const details = [...new Set([usefulMessage, ...nestedMessages])].filter(
    Boolean
  );

  if (code && databaseConnectionCodes.has(code)) {
    return [
      "Could not connect to Postgres using DATABASE_URL.",
      "Start the Operator-managed Postgres dependency (for example `docker compose --env-file .env -f examples/docker-compose/docker-compose.yml up postgres`) or update DATABASE_URL in `.env`.",
      details.length > 0 ? `Details: ${details.join("; ")}` : `Code: ${code}`
    ].join("\n");
  }

  if (details.length > 0) {
    return details.join("\n");
  }

  if (code) {
    return `${error instanceof Error ? error.name : "Error"} (${code})`;
  }

  return error instanceof Error ? error.name : String(error);
};

export const createOpaqueSecret = (prefix, randomBytes = nodeRandomBytes) =>
  `${prefix}_${randomBytes(32).toString("base64url")}`;

export const hashApiToken = (apiTokenPepper, token) =>
  createHash("sha256").update(`${apiTokenPepper}${token}`).digest("hex");

export const createApiTokenBootstrap = async ({
  repo,
  environment,
  argv,
  randomBytes = nodeRandomBytes
}) => {
  const args = parseCreateApiTokenArgs(argv);
  if (args.help) {
    return { help: true };
  }

  requireEnv(environment, ["DATABASE_URL", "API_TOKEN_PEPPER"]);

  let owner = await repo.findUserByEmail(args.ownerEmail);
  const ownerCreated = !owner;
  if (!owner) {
    owner = await repo.createUser({
      email: args.ownerEmail,
      displayName: null,
      passwordHash: null
    });
  }

  const token = createOpaqueSecret("cmt", randomBytes);
  const apiToken = await repo.createApiToken({
    ownerUserId: owner.id,
    name: args.name,
    tokenHash: hashApiToken(environment.API_TOKEN_PEPPER, token),
    tokenPrefix: token.slice(0, 12),
    scopes: [],
    audit: {
      actorUserId: null,
      actorType: "local_operator_script"
    }
  });

  return {
    help: false,
    ownerCreated,
    owner: {
      id: owner.id,
      email: args.ownerEmail
    },
    apiToken,
    token
  };
};

export const listApiTokenBootstrap = async ({ repo, environment, argv }) => {
  const args = parseListApiTokenArgs(argv);
  if (args.help) {
    return { help: true };
  }

  requireEnv(environment, ["DATABASE_URL"]);

  const owner = await repo.findUserByEmail(args.ownerEmail);
  if (!owner) {
    throw new UsageError(`Owner user not found: ${args.ownerEmail}`);
  }

  return {
    help: false,
    owner: {
      id: owner.id,
      email: args.ownerEmail
    },
    apiTokens: await repo.listApiTokens(owner.id)
  };
};

export const revokeApiTokenBootstrap = async ({ repo, environment, argv }) => {
  const args = parseRevokeApiTokenArgs(argv);
  if (args.help) {
    return { help: true };
  }

  requireEnv(environment, ["DATABASE_URL"]);

  const owner = await repo.findUserByEmail(args.ownerEmail);
  if (!owner) {
    throw new UsageError(`Owner user not found: ${args.ownerEmail}`);
  }

  const revoked = await repo.revokeApiToken(owner.id, args.tokenId, {
    actorUserId: null,
    actorType: "local_operator_script"
  });
  if (!revoked) {
    throw new UsageError(
      `API token not found or already revoked: ${args.tokenId}`
    );
  }

  return {
    help: false,
    owner: {
      id: owner.id,
      email: args.ownerEmail
    },
    tokenId: args.tokenId
  };
};

export const formatCreateApiTokenResult = (result) => {
  if (result.help) {
    return helpText;
  }

  return [
    "Created Koed API token.",
    `Owner: ${result.owner.email} (${result.ownerCreated ? "created" : "existing"})`,
    `Token ID: ${result.apiToken.id}`,
    `Token Prefix: ${result.apiToken.tokenPrefix}`,
    `Token: ${result.token}`,
    "Store this token now. It is shown only once."
  ].join("\n");
};

export const formatListApiTokenResult = (result) => {
  if (result.help) {
    return listHelpText;
  }
  if (result.apiTokens.length === 0) {
    return `No active Koed API tokens for ${result.owner.email}.`;
  }

  return [
    `Active Koed API tokens for ${result.owner.email}:`,
    ...result.apiTokens.map((token) =>
      [
        `- ${token.id}`,
        `name="${token.name}"`,
        `prefix=${token.tokenPrefix}`,
        `created=${token.createdAt}`,
        `lastUsed=${token.lastUsedAt ?? "never"}`
      ].join(" ")
    )
  ].join("\n");
};

export const formatRevokeApiTokenResult = (result) => {
  if (result.help) {
    return revokeHelpText;
  }

  return `Revoked Koed API token ${result.tokenId} for ${result.owner.email}.`;
};
