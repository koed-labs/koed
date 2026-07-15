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

/** Main-process-only installer. Resolver closure owns bytes; renderer receives no reference or secret. */
export const installPdsDesktopSecretResolver = (
  resolver: PdsSecretResolver
): void => {
  desktopSecretResolver = resolver;
};

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

const strictString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1_048_576;

const parseSecret = (value: string): PdsRuntimeSecret | null => {
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
          sourceAdapter: input.source.sourceAdapter,
          sourceAdapterVersion: input.source.sourceAdapterVersion,
          captureMethod: "supported_capture_hook",
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

export const createPdsSecureRuntimeFromEnvironment = async (
  environment: NodeJS.ProcessEnv = process.env
): Promise<{
  authoritySigner: PdsAuthoritySigner | null;
  secureKeyProvider: PdsSecureKeyProvider | null;
}> => {
  // Authority signer belongs only to configured backend service, injected through BuildServerOptions.
  if (environment.PDS_SECRET_PROVIDER?.trim() !== "desktop")
    return { authoritySigner: null, secureKeyProvider: null };
  const reference = environment.PDS_RUNTIME_SECRET_REF?.trim();
  if (!reference || !desktopSecretResolver || /[\r\n\0]/.test(reference))
    return { authoritySigner: null, secureKeyProvider: null };
  const secret = parseSecret((await desktopSecretResolver(reference)) ?? "");
  if (!secret) return { authoritySigner: null, secureKeyProvider: null };
  try {
    runtimeFor(secret);
  } catch {
    return { authoritySigner: null, secureKeyProvider: null };
  }
  return {
    authoritySigner: null,
    secureKeyProvider: {
      getSourceContext(input) {
        return Promise.resolve(
          input.userId === secret.userId && input.groupId === secret.groupId
            ? sourceContext(secret)
            : null
        );
      }
    }
  };
};
