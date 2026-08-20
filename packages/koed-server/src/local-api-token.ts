import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  LOCAL_PERSONAL_USER_EMAIL,
  readDesktopLocalCredentialAuthorization,
  storeDesktopLocalCredential
} from "@koed/shared";
import {
  loadLocalAppCredential,
  resolveLocalApiToken,
  writeLocalAppCredential
} from "./credentials.js";
import { resolve } from "node:path";
import type { KoedAppRuntime } from "./app-runtime.js";
import type { KoedServerPaths } from "./paths.js";

const desktopLocalOperationFamilies = [
  "personal_collaboration_read",
  "personal_collaboration_write"
] as const;

export interface LocalApiTokenRepository {
  findUserByEmail: (email: string) => Promise<{ id: string } | null>;
  createUser: (input: {
    email: string;
    displayName: string | null;
    passwordHash: string | null;
  }) => Promise<{ id: string }>;
  createApiToken: (input: {
    ownerUserId: string;
    name: string;
    tokenHash: string;
    tokenPrefix: string;
    scopes: string[];
    audit: { actorUserId: string | null; actorType: string };
  }) => Promise<unknown>;
  getApiTokenUser: (tokenHash: string) => Promise<{ id: string } | null>;
}

const importRuntimeDbModule = async <T>(
  runtime: KoedAppRuntime,
  modulePath: string
): Promise<T> =>
  import(
    pathToFileURL(resolve(runtime.dbPackageRoot, modulePath)).href
  ) as Promise<T>;

const withLocalApiTokenRepository = async <T>(
  runtime: KoedAppRuntime,
  environment: NodeJS.ProcessEnv,
  operation: (repo: LocalApiTokenRepository) => Promise<T>,
  injectedRepository?: LocalApiTokenRepository
): Promise<T> => {
  if (injectedRepository) return operation(injectedRepository);
  const [{ createDbPool, createDb }, { createUserApiTokenRepository }] =
    await Promise.all([
      importRuntimeDbModule<{
        createDbPool: (config?: { connectionString?: string }) => unknown;
        createDb: (pool: unknown) => unknown;
      }>(runtime, "dist/connection.js"),
      importRuntimeDbModule<{
        createUserApiTokenRepository: (db: unknown) => LocalApiTokenRepository;
      }>(runtime, "dist/user-api-token-repository.js")
    ]);
  const pool = createDbPool({
    connectionString: environment.DATABASE_URL
  }) as { end: () => Promise<void> };
  try {
    return await operation(createUserApiTokenRepository(createDb(pool)));
  } finally {
    await pool.end();
  }
};

const hashApiToken = (apiTokenPepper: string, token: string): string =>
  createHash("sha256").update(`${apiTokenPepper}${token}`).digest("hex");

const createOpaqueSecret = (prefix: string): string =>
  `${prefix}_${randomBytes(32).toString("base64url")}`;

export const provisionDesktopLocalCredential = (
  paths: KoedServerPaths,
  ownerUserId: string
): void => {
  const existing = readDesktopLocalCredentialAuthorization(paths.koedHome);
  if (!existing) {
    storeDesktopLocalCredential(paths.koedHome, {
      ownerUserId,
      operationFamilies: [...desktopLocalOperationFamilies]
    });
    return;
  }
  if (existing.ownerUserId !== ownerUserId.toLowerCase()) {
    throw new Error(
      "Stored Desktop Local Credential does not match the active Personal owner."
    );
  }
  if (
    existing.operationFamilies.length !==
      desktopLocalOperationFamilies.length ||
    !desktopLocalOperationFamilies.every((family) =>
      existing.operationFamilies.includes(family)
    )
  ) {
    throw new Error(
      "Stored Desktop Local Credential does not have the required Personal operation families."
    );
  }
};

const resolveActiveOwner = async (
  repo: LocalApiTokenRepository,
  provisionDesktopCredential: boolean,
  paths: KoedServerPaths
): Promise<{ id: string }> => {
  const owner =
    (await repo.findUserByEmail(LOCAL_PERSONAL_USER_EMAIL)) ??
    (await repo.createUser({
      email: LOCAL_PERSONAL_USER_EMAIL,
      displayName: null,
      passwordHash: null
    }));
  if (provisionDesktopCredential)
    provisionDesktopLocalCredential(paths, owner.id);
  return owner;
};

export const provisionLocalApiToken = async (
  paths: KoedServerPaths,
  runtime: KoedAppRuntime,
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string> = {},
  now = () => new Date(),
  injectedRepository?: LocalApiTokenRepository
): Promise<{ token: string; reused: boolean; ownerUserId: string }> => {
  const pepper = environment.API_TOKEN_PEPPER ?? repoEnv.API_TOKEN_PEPPER;
  if (!pepper?.trim()) {
    throw new Error(
      "API_TOKEN_PEPPER is required before provisioning local API Token."
    );
  }
  if (!environment.DATABASE_URL?.trim() && !injectedRepository) {
    throw new Error(
      "DATABASE_URL is required before provisioning local API Token."
    );
  }
  return withLocalApiTokenRepository(
    runtime,
    environment,
    async (repo) => {
      const owner = await resolveActiveOwner(repo, false, paths);
      const configured = resolveLocalApiToken(environment, repoEnv);
      const existing =
        configured?.token ?? loadLocalAppCredential(paths)?.apiToken;
      if (existing) {
        const existingOwner = await repo.getApiTokenUser(
          hashApiToken(pepper, existing)
        );
        if (existingOwner?.id === owner.id) {
          writeLocalAppCredential(paths, {
            apiToken: existing,
            provisionedAt: now().toISOString(),
            source: configured?.source ?? "environment"
          });
          return { token: existing, reused: true, ownerUserId: owner.id };
        }
        if (existingOwner) {
          throw new Error(
            "Configured Koed local API Token belongs to a different Personal owner."
          );
        }
      }

      const token = createOpaqueSecret("cmt");
      await repo.createApiToken({
        ownerUserId: owner.id,
        name: "Koed Local AI Runtime",
        tokenHash: hashApiToken(pepper, token),
        tokenPrefix: token.slice(0, 12),
        scopes: [],
        audit: { actorUserId: null, actorType: "local_operator_script" }
      });
      writeLocalAppCredential(paths, {
        apiToken: token,
        provisionedAt: now().toISOString(),
        source: "environment"
      });
      return { token, reused: false, ownerUserId: owner.id };
    },
    injectedRepository
  );
};

export const provisionDesktopApiToken = async (
  paths: KoedServerPaths,
  runtime: KoedAppRuntime,
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string> = {},
  injectedRepository?: LocalApiTokenRepository
): Promise<string | null> => {
  if (environment.KOED_AUTO_PORTS !== "1") return null;
  const pepper = environment.API_TOKEN_PEPPER ?? repoEnv.API_TOKEN_PEPPER;
  if (!pepper?.trim()) {
    throw new Error(
      "API_TOKEN_PEPPER is required before provisioning Desktop API Token."
    );
  }
  const result = await withLocalApiTokenRepository(
    runtime,
    environment,
    async (repo) => {
      const owner = await resolveActiveOwner(repo, true, paths);
      const existing = loadLocalAppCredential(paths)?.apiToken;
      if (existing) {
        const existingOwner = await repo.getApiTokenUser(
          hashApiToken(pepper, existing)
        );
        if (existingOwner?.id === owner.id) return existing;
        if (existingOwner) {
          throw new Error(
            "Stored Koed Desktop API Token belongs to a different Personal owner."
          );
        }
      }
      const token = createOpaqueSecret("cmt");
      await repo.createApiToken({
        ownerUserId: owner.id,
        name: "Koed Desktop",
        tokenHash: hashApiToken(pepper, token),
        tokenPrefix: token.slice(0, 12),
        scopes: [],
        audit: { actorUserId: null, actorType: "local_operator_script" }
      });
      writeLocalAppCredential(paths, {
        apiToken: token,
        provisionedAt: new Date().toISOString(),
        source: "environment"
      });
      return token;
    },
    injectedRepository
  );
  return result;
};
