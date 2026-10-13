import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { HEADLESS_REMOTE_CREDENTIAL_REF } from "./headless-remote-integration.js";
import { resolveKoedServerPaths } from "./paths.js";

export const normalizeRemoteMcpBackend = (value: string): string => {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "/mcp")
  ) {
    throw new Error(
      "Remote backend must be an HTTPS origin or its canonical /mcp URL."
    );
  }
  return url.origin;
};

const tokenSchema = z
  .object({
    accessToken: z
      .string()
      .min(1)
      .max(8192)
      .regex(/^[\x21-\x7e]+$/),
    refreshToken: z
      .string()
      .min(1)
      .max(8192)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
    expiresAt: z.number().finite().positive(),
    scope: z.string().max(2048)
  })
  .strict();
const credentialSchema = z
  .object({
    version: z.literal(1),
    backendUrl: z.string(),
    resourceUrl: z.string(),
    issuerUrl: z.string(),
    userId: z.string().min(1).max(256),
    clientId: z.string().min(1).max(2048),
    tokens: tokenSchema.optional(),
    pendingRevocation: z
      .object({
        token: tokenSchema.shape.accessToken,
        tokenTypeHint: z.enum(["refresh_token", "access_token"])
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((record, context) => {
    try {
      const backend = normalizeRemoteMcpBackend(record.backendUrl);
      if (
        record.backendUrl !== backend ||
        record.issuerUrl !== backend ||
        record.resourceUrl !== `${backend}/mcp`
      )
        throw new Error("binding mismatch");
    } catch {
      context.addIssue({
        code: "custom",
        message: "Remote credential binding is invalid."
      });
    }
  });

type StoredRemoteMcpCredential = z.infer<typeof credentialSchema>;
export type RemoteMcpCredential = Omit<
  StoredRemoteMcpCredential,
  "pendingRevocation"
>;
export type RemoteMcpTokens = z.infer<typeof tokenSchema>;

export const remoteMcpCredentialPath = (
  environment: NodeJS.ProcessEnv = process.env
): string =>
  resolve(
    resolveKoedServerPaths(environment).koedHome,
    HEADLESS_REMOTE_CREDENTIAL_REF
  );

const assertSafe = (path: string, file: boolean): void => {
  try {
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      (file ? !stat.isFile() : !stat.isDirectory()) ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (process.platform !== "win32" &&
        (stat.mode & (file ? 0o077 : 0o022)) !== 0)
    )
      throw new Error(
        "Remote credential custody has unsafe ownership or permissions."
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};
const assertCustody = (environment: NodeJS.ProcessEnv): void => {
  const paths = resolveKoedServerPaths(environment);
  assertSafe(paths.koedHome, false);
  assertSafe(paths.configDir, false);
  assertSafe(remoteMcpCredentialPath(environment), true);
};

const readStoredRemoteMcpCredential = (
  environment: NodeJS.ProcessEnv = process.env
): StoredRemoteMcpCredential | null => {
  assertCustody(environment);
  const path = remoteMcpCredentialPath(environment);
  if (!existsSync(path)) return null;
  try {
    return credentialSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new Error(
      "Remote credential custody is invalid; no credentials were loaded."
    );
  }
};

export const readRemoteMcpCredential = (
  environment: NodeJS.ProcessEnv = process.env
): RemoteMcpCredential | null => {
  const stored = readStoredRemoteMcpCredential(environment);
  if (!stored) return null;
  const { pendingRevocation, ...credential } = stored;
  return pendingRevocation ? { ...credential, tokens: undefined } : credential;
};

export const readRemoteMcpPendingRevocation = (
  environment: NodeJS.ProcessEnv
): StoredRemoteMcpCredential["pendingRevocation"] =>
  readStoredRemoteMcpCredential(environment)?.pendingRevocation;

export const assertCleanRemoteMcpEnrollment = (
  environment: NodeJS.ProcessEnv
): void => {
  assertCustody(environment);
  if (readRemoteMcpCredential(environment)) return;
  const paths = resolveKoedServerPaths(environment);
  if (!existsSync(paths.koedHome)) return;
  const entries = readdirSync(paths.koedHome);
  if (
    entries.some((entry) => entry !== "config") ||
    (existsSync(paths.configDir) &&
      readdirSync(paths.configDir).some(
        (entry) => entry !== "remote-mcp-credentials.json.lock"
      ))
  )
    throw new Error(
      "Initial remote enrollment requires a clean dedicated KOED_HOME."
    );
};

export const writeRemoteMcpCredential = (
  environment: NodeJS.ProcessEnv,
  credential: StoredRemoteMcpCredential
): void => {
  const parsed = credentialSchema.parse(credential);
  assertCustody(environment);
  const previous = readRemoteMcpCredential(environment);
  if (
    previous &&
    (previous.backendUrl !== parsed.backendUrl ||
      previous.userId !== parsed.userId)
  ) {
    throw new Error(
      "Remote enrollment is bound to a different backend or User."
    );
  }
  const paths = resolveKoedServerPaths(environment);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  const target = remoteMcpCredentialPath(environment);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      /* Preserve the custody failure. */
    }
    throw new Error("Remote credentials could not be safely stored.");
  }
};

export const withRemoteMcpCredentialLock = async <T>(
  environment: NodeJS.ProcessEnv,
  action: () => Promise<T>
): Promise<T> => {
  assertCustody(environment);
  mkdirSync(resolveKoedServerPaths(environment).configDir, {
    recursive: true,
    mode: 0o700
  });
  const release = await lockfile.lock(remoteMcpCredentialPath(environment), {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: { retries: 20, minTimeout: 100, maxTimeout: 1000 }
  });
  try {
    return await action();
  } finally {
    await release();
  }
};

export const hasRemoteMcpLocalRuntimeScopes = (
  credential: RemoteMcpCredential
): boolean => {
  const scopes = new Set(credential.tokens?.scope.split(/\s+/) ?? []);
  return ["koed:memory:read", "koed:capture", "koed:local-execution"].every(
    (scope) => scopes.has(scope)
  );
};

export const hasRemoteMcpTeamRuntimeScopes = (
  credential: RemoteMcpCredential
): boolean =>
  hasRemoteMcpLocalRuntimeScopes(credential) &&
  (credential.tokens?.scope.split(/\s+/).includes("koed:team:read") ?? false);
