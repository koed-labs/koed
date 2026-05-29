import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class UsageError extends Error {}

const usage = `Usage: pnpm api-token:create --owner-email <email> [--name <name>]

Options:
  --owner-email <email>  Email for the passwordless local owner user.
  --name <name>         API token name. Defaults to "Client Integration".
  --help                Show this help.
`;

const readFlagValue = (argv, index, flag) => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a value.\n\n${usage}`);
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
    scopes: []
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
