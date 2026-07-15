import type { KeyObject } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createPdsSessionManifest,
  createPdsSessionPackage,
  createPdsSessionPackageRuntimeContext,
  pdsEd25519PrivateKey
} from "@koed/shared";
import type { PdsAuthoritySigner } from "./routes.js";
import type {
  PdsSecureKeyProvider,
  PdsSecureSourceKeyContext
} from "./local-source.js";

export type PdsSecretResolver = (reference: string) => Promise<string | null>;

let desktopSecretResolver: PdsSecretResolver | null = null;

/** Desktop main process installs Keychain adapter. Renderer/config never receives secret bytes. */
export const installPdsDesktopSecretResolver = (
  resolver: PdsSecretResolver
): void => {
  desktopSecretResolver = resolver;
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

const operatorSecretResolver =
  (environment: NodeJS.ProcessEnv): PdsSecretResolver =>
  (reference) => {
    const command = environment.PDS_SECRET_PROVIDER_COMMAND?.trim();
    if (!command || /[\r\n\0]/.test(`${command}${reference}`))
      return Promise.resolve(null);
    const result = spawnSync(command, ["get", reference], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: providerEnvironment(environment)
    });
    return Promise.resolve(
      result.status === 0 && typeof result.stdout === "string"
        ? result.stdout.trim() || null
        : null
    );
  };

const runtimeSecretResolver = (
  environment: NodeJS.ProcessEnv
): PdsSecretResolver | null => {
  const mode = environment.PDS_SECRET_PROVIDER?.trim();
  if (mode === "desktop") return desktopSecretResolver;
  if (mode === "headless") return operatorSecretResolver(environment);
  return null;
};

type PdsRuntimeSecret = {
  groupId: string;
  originDeploymentId: string;
  authority: { keyId: string; publicKey: string; secretSeed: string };
  authorityHead: string;
  epoch: string;
  servingCertificate: string;
  recipientCertificate: string;
  recipientCertificates: string[];
  historicalOriginCertificates?: string[];
  deviceSigningPrivateSeed: string;
  deviceKemPrivateSeed: string;
  sourceFingerprintKey: string;
  tombstoneFloorKey: string;
};

const parseSecret = (value: string): PdsRuntimeSecret | null => {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const strings = [
      "groupId",
      "originDeploymentId",
      "authorityHead",
      "epoch",
      "servingCertificate",
      "recipientCertificate",
      "deviceSigningPrivateSeed",
      "deviceKemPrivateSeed",
      "sourceFingerprintKey",
      "tombstoneFloorKey"
    ];
    if (strings.some((key) => typeof parsed[key] !== "string")) return null;
    const authority = parsed.authority as Record<string, unknown> | undefined;
    if (
      !authority ||
      typeof authority.keyId !== "string" ||
      typeof authority.publicKey !== "string" ||
      typeof authority.secretSeed !== "string" ||
      !Array.isArray(parsed.recipientCertificates) ||
      !(parsed.recipientCertificates as unknown[]).every(
        (certificate) => typeof certificate === "string"
      )
    ) {
      return null;
    }
    return parsed as unknown as PdsRuntimeSecret;
  } catch {
    return null;
  }
};

const runtimeFor = (secret: PdsRuntimeSecret) =>
  createPdsSessionPackageRuntimeContext({
    authorityPublicKey: secret.authority.publicKey,
    groupId: secret.groupId,
    authorityHead: secret.authorityHead,
    currentEpoch: secret.epoch,
    servingCertificate: secret.servingCertificate,
    recipientCertificate: secret.recipientCertificate,
    recipientCertificates: secret.recipientCertificates,
    historicalOriginCertificates: secret.historicalOriginCertificates
  });

const sourceContext = (secret: PdsRuntimeSecret): PdsSecureSourceKeyContext => {
  const runtime = runtimeFor(secret);
  const signingKey = pdsEd25519PrivateKey(
    secret.deviceSigningPrivateSeed,
    runtime.serving.signingPublicKey
  );
  return {
    // References are intentionally opaque to route code; values remain closure-local.
    deviceSigningPrivateKeyRef: "runtime-secret",
    deviceKemPrivateKeyRef: "runtime-secret",
    groupSecretSetRef: "runtime-secret",
    originDeploymentId: secret.originDeploymentId,
    originDeviceId: runtime.serving.deviceId,
    buildClosedSessionPackage(input) {
      const manifest = createPdsSessionManifest({
        runtime,
        originDeploymentId: secret.originDeploymentId,
        sourceSequence: input.sourceSequence,
        sourceNativeSessionId: input.source.externalSessionId,
        contentEpoch: secret.epoch,
        closedSession: {
          closed: true,
          sourceAdapter: input.source.sourceAdapter,
          sourceAdapterVersion: input.source.sourceAdapterVersion,
          captureMethod: "supported_capture_hook",
          sourceCreatedAt: input.source.sourceCreatedAt,
          sourceClosedAt: input.closedAt.toISOString(),
          observedClosedAt: input.closedAt.toISOString()
        },
        terminalCursor: String(input.items.length),
        items: input.items,
        sourceFingerprintKey: secret.sourceFingerprintKey,
        tombstoneFloorKey: secret.tombstoneFloorKey,
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

export const createPdsSecureRuntimeFromEnvironment = async (
  environment: NodeJS.ProcessEnv = process.env
): Promise<{
  authoritySigner: PdsAuthoritySigner | null;
  secureKeyProvider: PdsSecureKeyProvider | null;
}> => {
  const reference = environment.PDS_RUNTIME_SECRET_REF?.trim();
  const resolver = runtimeSecretResolver(environment);
  if (!reference || !resolver) {
    return { authoritySigner: null, secureKeyProvider: null };
  }
  const secret = parseSecret((await resolver(reference)) ?? "");
  if (!secret) return { authoritySigner: null, secureKeyProvider: null };
  let authorityPrivateKey: KeyObject;
  try {
    authorityPrivateKey = pdsEd25519PrivateKey(
      secret.authority.secretSeed,
      secret.authority.publicKey
    );
    runtimeFor(secret);
  } catch {
    return { authoritySigner: null, secureKeyProvider: null };
  }
  return {
    authoritySigner: {
      keyId: secret.authority.keyId,
      publicKey: secret.authority.publicKey,
      privateKey: authorityPrivateKey
    },
    secureKeyProvider: {
      getSourceContext(input) {
        void input.userId;
        return Promise.resolve(
          input.groupId === secret.groupId ? sourceContext(secret) : null
        );
      }
    }
  };
};
