import { spawnSync } from "node:child_process";
import { sign, verify } from "node:crypto";
import {
  canonicalizePdsJson,
  createPdsSessionManifest,
  createPdsSessionPackage,
  createPdsSessionPackageRuntimeContext,
  pdsEd25519PrivateKey,
  pdsEd25519PublicKey
} from "@koed/shared";
import type { PdsAuthoritySigner } from "./routes.js";
import type {
  PdsSecureKeyProvider,
  PdsSecureSourceKeyContext
} from "./local-source.js";

export type PdsSecretResolver = (reference: string) => Promise<string | null>;
const maximumSecretBytes = 2_000_000;

/** Shared API/Worker private runtime schema. Authority private material is forbidden. */
type PdsRuntimeSecret = {
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

type PdsAuthoritySecret = {
  version: 1;
  keyId: string;
  publicKey: string;
  privateSeed: string;
};

const strictString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1_048_576;

const parseRuntimeSecret = (value: string): PdsRuntimeSecret | null => {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const device = parsed.device as Record<string, unknown> | undefined;
    const authority = parsed.authority as Record<string, unknown> | undefined;
    const groupSecrets = parsed.groupSecrets as
      | Record<string, unknown>
      | undefined;
    if (
      (Object.keys(parsed).sort().join(",") !==
        "authority,certificate,device,groupId,groupSecrets,historicalOriginCertificates,recipientCertificates,relayUrl,userId,version" &&
        Object.keys(parsed).sort().join(",") !==
          "authority,certificate,device,groupId,groupSecrets,recipientCertificates,relayUrl,userId,version") ||
      parsed.version !== 1 ||
      ![
        parsed.userId,
        parsed.relayUrl,
        parsed.groupId,
        parsed.certificate
      ].every(strictString) ||
      !device ||
      !authority ||
      !groupSecrets ||
      ![
        "id",
        "originDeploymentId",
        "signingKeyId",
        "signingPrivateSeed",
        "kemKeyId",
        "kemPrivateSeed"
      ].every((key) => strictString(device[key])) ||
      !["keyId", "publicKey", "head"].every((key) =>
        strictString(authority[key])
      ) ||
      ![
        "currentEpoch",
        "contentKey",
        "sourceFingerprintKey",
        "tombstoneFloorKey",
        "projectAliasKey"
      ].every((key) => strictString(groupSecrets[key])) ||
      !Array.isArray(parsed.recipientCertificates) ||
      !parsed.recipientCertificates.every(strictString) ||
      (parsed.historicalOriginCertificates !== undefined &&
        (!Array.isArray(parsed.historicalOriginCertificates) ||
          !parsed.historicalOriginCertificates.every(strictString)))
    )
      return null;
    return parsed as unknown as PdsRuntimeSecret;
  } catch {
    return null;
  }
};

const parseAuthoritySecret = (value: string): PdsAuthoritySigner | null => {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      Object.keys(parsed).sort().join(",") !==
        "keyId,privateSeed,publicKey,version" ||
      parsed.version !== 1 ||
      !strictString(parsed.keyId) ||
      !strictString(parsed.publicKey) ||
      !strictString(parsed.privateSeed)
    ) {
      return null;
    }
    const secret = parsed as PdsAuthoritySecret;
    const privateKey = pdsEd25519PrivateKey(
      secret.privateSeed,
      secret.publicKey
    );
    const publicKey = pdsEd25519PublicKey(secret.publicKey);
    const probe = Buffer.from("koed/pds/authority-key-proof/v1", "utf8");
    if (!verify(null, probe, publicKey, sign(null, probe, privateKey))) {
      return null;
    }
    return {
      keyId: secret.keyId,
      publicKey: secret.publicKey,
      privateKey
    };
  } catch {
    return null;
  }
};

export const pdsSecureProviderEnvironment = (
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
      return [];
    }
    return parsed as string[];
  } catch {
    return [];
  }
};

const resolveHeadlessSecret = (
  reference: string,
  environment: NodeJS.ProcessEnv
): string | null => {
  const command = environment.PDS_SECRET_PROVIDER_COMMAND?.trim();
  if (
    !command ||
    !/^[^\s\r\n\0]+$/.test(command) ||
    !/^[^\r\n\0]{1,240}$/.test(reference)
  ) {
    return null;
  }
  try {
    const result = spawnSync(
      command,
      [...providerArgs(environment), "get", reference],
      {
        encoding: "utf8",
        env: pdsSecureProviderEnvironment(environment),
        maxBuffer: maximumSecretBytes + 1,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000
      }
    );
    if (
      result.status !== 0 ||
      result.error ||
      typeof result.stdout !== "string" ||
      Buffer.byteLength(result.stdout, "utf8") > maximumSecretBytes
    ) {
      return null;
    }
    return result.stdout;
  } catch {
    return null;
  }
};

const runtimeFor = (secret: PdsRuntimeSecret) =>
  createPdsSessionPackageRuntimeContext({
    authorityPublicKey: secret.authority.publicKey,
    groupId: secret.groupId,
    authorityHead: secret.authority.head,
    currentEpoch: secret.groupSecrets.currentEpoch,
    servingCertificate: secret.certificate,
    recipientCertificate: secret.certificate,
    recipientCertificates: secret.recipientCertificates,
    historicalOriginCertificates: secret.historicalOriginCertificates
  });

/** Retained package bytes must be identical to the strict relay wire form. */
export const serializePdsPackageForEncryptedStorage = (
  value: unknown
): string => canonicalizePdsJson(value);

const sourceContext = (secret: PdsRuntimeSecret): PdsSecureSourceKeyContext => {
  const runtime = runtimeFor(secret);
  const signingKey = pdsEd25519PrivateKey(
    secret.device.signingPrivateSeed,
    runtime.serving.signingPublicKey
  );
  return {
    deviceSigningPrivateKeyRef: "desktop-secure-runtime",
    deviceKemPrivateKeyRef: "desktop-secure-runtime",
    groupSecretSetRef: "desktop-secure-runtime",
    originDeploymentId: secret.device.originDeploymentId,
    originDeviceId: secret.device.id,
    buildClosedSessionPackage(input) {
      const manifest = createPdsSessionManifest({
        runtime,
        originDeploymentId: secret.device.originDeploymentId,
        sourceSequence: input.sourceSequence,
        sourceNativeSessionId: input.source.externalSessionId,
        contentEpoch: secret.groupSecrets.currentEpoch,
        closedSession: {
          closed: true,
          logicalSessionId: input.source.logicalSessionId,
          externalSessionId: input.source.externalSessionId,
          ...(input.source.forkedFromExternalThreadId
            ? {
                forkedFromExternalThreadId:
                  input.source.forkedFromExternalThreadId
              }
            : {}),
          sourceAdapter: input.source.sourceAdapter,
          sourceAdapterVersion: input.source.sourceAdapterVersion,
          captureMethod: "transcript",
          sourceCreatedAt: input.source.sourceCreatedAt,
          sourceClosedAt: input.closedAt.toISOString(),
          observedClosedAt: input.closedAt.toISOString()
        },
        terminalCursor: String(input.items.length),
        items: input.items,
        sourceFingerprintKey: secret.groupSecrets.sourceFingerprintKey,
        tombstoneFloorKey: secret.groupSecrets.tombstoneFloorKey,
        originSigningPrivateKey: signingKey
      });
      const pkg = createPdsSessionPackage({
        runtime,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
        servingSigningPrivateKey: signingKey,
        manifest
      });
      return Promise.resolve({
        package: pkg,
        sourceClosureHash: manifest.sourceClosureHash,
        sourceManifestHash: pkg.header.sourceManifestHash,
        sourceFingerprint: manifest.sourceFingerprint,
        logicalMemoryId: manifest.logicalMemoryId,
        deletionFloorToken: manifest.deletionFloorToken
      });
    }
  };
};

const configuredSecretResolver = (
  environment: NodeJS.ProcessEnv,
  dependencies: { resolveHeadlessSecret?: PdsSecretResolver }
): PdsSecretResolver | null => {
  const provider = environment.PDS_SECRET_PROVIDER?.trim();
  if (provider !== "headless" && provider !== "desktop_bridge") return null;
  return (
    dependencies.resolveHeadlessSecret ??
    ((reference: string) =>
      Promise.resolve(resolveHeadlessSecret(reference, environment)))
  );
};

export const createReloadablePdsSecureKeyProviderFromEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: {
    resolveHeadlessSecret?: PdsSecretResolver;
  } = {}
): PdsSecureKeyProvider | null => {
  const reference = environment.PDS_RUNTIME_SECRET_REF?.trim();
  const resolver = configuredSecretResolver(environment, dependencies);
  if (!reference || /[\r\n\0]/.test(reference) || !resolver) return null;

  const resolveSecret = async (): Promise<PdsRuntimeSecret | null> => {
    const value = await resolver(reference);
    const secret = value ? parseRuntimeSecret(value) : null;
    if (!secret) return null;
    try {
      runtimeFor(secret);
      return secret;
    } catch {
      return null;
    }
  };

  return {
    async isReady() {
      return (await resolveSecret()) !== null;
    },
    async getSourceContext(input) {
      const secret = await resolveSecret();
      return secret &&
        input.userId === secret.userId &&
        input.groupId === secret.groupId
        ? sourceContext(secret)
        : null;
    }
  };
};

export const createPdsSecureRuntimeFromEnvironment = async (
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: {
    resolveHeadlessSecret?: PdsSecretResolver;
  } = {}
): Promise<{
  authoritySigner: PdsAuthoritySigner | null;
  secureKeyProvider: PdsSecureKeyProvider | null;
}> => {
  const resolver = configuredSecretResolver(environment, dependencies);
  if (!resolver) return { authoritySigner: null, secureKeyProvider: null };

  const authorityReference = environment.PDS_AUTHORITY_SECRET_REF?.trim();
  const runtimeReference = environment.PDS_RUNTIME_SECRET_REF?.trim();
  const [authorityValue, runtimeValue] = await Promise.all([
    authorityReference && !/[\r\n\0]/.test(authorityReference)
      ? resolver(authorityReference)
      : null,
    runtimeReference && !/[\r\n\0]/.test(runtimeReference)
      ? resolver(runtimeReference)
      : null
  ]);
  const authoritySigner = authorityValue
    ? parseAuthoritySecret(authorityValue)
    : null;
  const secret = runtimeValue ? parseRuntimeSecret(runtimeValue) : null;
  if (secret) {
    try {
      runtimeFor(secret);
    } catch {
      return { authoritySigner, secureKeyProvider: null };
    }
  }
  return {
    authoritySigner,
    secureKeyProvider: secret
      ? {
          getSourceContext(input) {
            return Promise.resolve(
              input.userId === secret.userId && input.groupId === secret.groupId
                ? sourceContext(secret)
                : null
            );
          }
        }
      : null
  };
};

const pdsAuthorityStartupAttempts = 5;
const pdsAuthorityStartupRetryDelayMs = 100;

/**
 * A configured authority is a hard API startup dependency. The Desktop secret
 * bridge can become reachable just after the child process starts, so tolerate
 * that bounded handoff but never leave the API running with PDS half-enabled.
 */
export const createPdsSecureRuntimeForApiStartup = async (
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: {
    resolveHeadlessSecret?: PdsSecretResolver;
    attempts?: number;
    retryDelayMs?: number;
    sleep?: (delayMs: number) => Promise<void>;
  } = {}
): Promise<{
  authoritySigner: PdsAuthoritySigner | null;
  secureKeyProvider: PdsSecureKeyProvider | null;
}> => {
  const authorityReference = environment.PDS_AUTHORITY_SECRET_REF?.trim();
  if (!authorityReference) {
    return await createPdsSecureRuntimeFromEnvironment(
      environment,
      dependencies
    );
  }
  if (
    /[\r\n\0]/.test(authorityReference) ||
    !configuredSecretResolver(environment, dependencies)
  ) {
    throw new Error(
      "Configured Personal Device Sync authority provider is invalid."
    );
  }

  const attempts = Math.max(
    1,
    Math.min(
      dependencies.attempts ?? pdsAuthorityStartupAttempts,
      pdsAuthorityStartupAttempts
    )
  );
  const retryDelayMs = Math.max(
    0,
    Math.min(
      dependencies.retryDelayMs ?? pdsAuthorityStartupRetryDelayMs,
      1_000
    )
  );
  const sleep =
    dependencies.sleep ??
    ((delayMs: number) =>
      new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, delayMs)
      ));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const runtime = await createPdsSecureRuntimeFromEnvironment(
      environment,
      dependencies
    );
    if (runtime.authoritySigner) return runtime;
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  throw new Error(
    "Configured Personal Device Sync authority could not be loaded."
  );
};
