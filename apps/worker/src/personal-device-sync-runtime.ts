import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { MemorySourceRepository } from "@koed/db";
import {
  PDS_PROTOCOL,
  PdsRelayClient,
  canonicalizePdsJson,
  createPdsSessionPackageRuntimeContext,
  decryptEnvelopeToUtf8,
  parseCanonicalPdsJson,
  parsePdsSessionPackageJson,
  pdsEd25519PrivateKey,
  pdsFinalizedStatementHash,
  pdsSessionPackageDigest,
  signPdsRecord,
  validatePdsConflictResolution,
  validatePdsGroupStatement,
  validatePdsTombstone,
  verifyAndDecryptPdsSessionPackage,
  type EnvelopeEncryptionProvider,
  type PdsSessionPackage,
  type PdsSessionManifest
} from "@koed/shared";
import type { PdsWorkerSecureRuntime } from "./personal-device-sync-service.js";

/** Must remain byte-for-byte schema-compatible with API secure runtime. */
type RuntimeSecret = {
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

const maximumSecretBytes = 2_000_000;

const providerEnvironment = (
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => ({
  PATH: environment.PATH,
  HOME: environment.HOME,
  USER: environment.USER,
  LANG: environment.LANG,
  LC_ALL: environment.LC_ALL,
  ELECTRON_RUN_AS_NODE: environment.ELECTRON_RUN_AS_NODE,
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

export const resolvePdsProviderRuntimeSecret = (
  environment: NodeJS.ProcessEnv
): RuntimeSecret | null => {
  const provider = environment.PDS_SECRET_PROVIDER?.trim();
  if (provider !== "headless" && provider !== "desktop_bridge") return null;
  const reference = environment.PDS_RUNTIME_SECRET_REF?.trim();
  const command = environment.PDS_SECRET_PROVIDER_COMMAND?.trim();
  if (
    !reference ||
    !command ||
    !/^[^\s\r\n\0]+$/.test(command) ||
    /[\r\n\0]/.test(reference) ||
    reference.length > 240
  )
    return null;
  try {
    const result = spawnSync(
      command,
      [...providerArgs(environment), "get", reference],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: providerEnvironment(environment),
        maxBuffer: maximumSecretBytes + 1,
        timeout: 10_000
      }
    );
    if (
      result.status !== 0 ||
      result.error ||
      typeof result.stdout !== "string" ||
      Buffer.byteLength(result.stdout, "utf8") > maximumSecretBytes
    )
      return null;
    const value = JSON.parse(result.stdout) as Record<string, unknown>;
    if (
      typeof value.userId !== "string" ||
      typeof value.groupId !== "string" ||
      typeof value.relayUrl !== "string" ||
      value.version !== 1 ||
      !value.device ||
      !value.authority ||
      !value.groupSecrets ||
      !Array.isArray(value.recipientCertificates) ||
      !(value.recipientCertificates as unknown[]).every(
        (entry) => typeof entry === "string"
      ) ||
      ![
        "id",
        "originDeploymentId",
        "signingKeyId",
        "signingPrivateSeed",
        "kemKeyId",
        "kemPrivateSeed"
      ].every(
        (key) =>
          typeof (value.device as Record<string, unknown>)[key] === "string"
      ) ||
      !["keyId", "publicKey", "head"].every(
        (key) =>
          typeof (value.authority as Record<string, unknown>)[key] === "string"
      ) ||
      ![
        "currentEpoch",
        "contentKey",
        "sourceFingerprintKey",
        "tombstoneFloorKey",
        "projectAliasKey"
      ].every(
        (key) =>
          typeof (value.groupSecrets as Record<string, unknown>)[key] ===
          "string"
      ) ||
      typeof value.certificate !== "string"
    )
      return null;
    return value as unknown as RuntimeSecret;
  } catch {
    return null;
  }
};

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`PDS ${label} is invalid`);
  }
  return value as Record<string, unknown>;
};

type PdsRuntimeFactoryInput = {
  repository: MemorySourceRepository;
  envelopeEncryptionProvider: EnvelopeEncryptionProvider;
  environment?: NodeJS.ProcessEnv;
};

const createPdsWorkerRuntimeFromSecret = (
  input: PdsRuntimeFactoryInput,
  secret: RuntimeSecret
): PdsWorkerSecureRuntime | null => {
  try {
    const runtime = createPdsSessionPackageRuntimeContext({
      authorityPublicKey: secret.authority.publicKey,
      groupId: secret.groupId,
      authorityHead: secret.authority.head,
      currentEpoch: secret.groupSecrets.currentEpoch,
      servingCertificate: secret.certificate,
      recipientCertificate: secret.certificate,
      recipientCertificates: secret.recipientCertificates,
      historicalOriginCertificates: secret.historicalOriginCertificates
    });
    const signingKey = pdsEd25519PrivateKey(
      secret.device.signingPrivateSeed,
      runtime.recipient.signingPublicKey
    );
    const runtimeForServing = (servingDeviceId: string) => {
      const servingCertificate = secret.recipientCertificates.find(
        (certificate) => {
          try {
            return (
              record(parseCanonicalPdsJson(certificate), "certificate")
                .deviceId === servingDeviceId
            );
          } catch {
            return false;
          }
        }
      );
      if (!servingCertificate) throw new Error("PdsCryptoAuthorityError");
      return createPdsSessionPackageRuntimeContext({
        authorityPublicKey: secret.authority.publicKey,
        groupId: secret.groupId,
        authorityHead: secret.authority.head,
        currentEpoch: secret.groupSecrets.currentEpoch,
        servingCertificate,
        recipientCertificate: secret.certificate,
        recipientCertificates: secret.recipientCertificates,
        historicalOriginCertificates: secret.historicalOriginCertificates
      });
    };
    const relayIdentity = (certificate: string) => ({
      certificate,
      deviceId: runtime.recipient.deviceId,
      signingKeyId: runtime.recipient.signingKeyId,
      signingPublicKey: runtime.recipient.signingPublicKey,
      signingPrivateSeed: secret.device.signingPrivateSeed
    });
    let relay = new PdsRelayClient({
      baseUrl: secret.relayUrl,
      identity: relayIdentity(secret.certificate)
    });
    const downloaded = new Map<
      string,
      { pkg: PdsSessionPackage; transport: Record<string, unknown> }
    >();
    const pendingOutboundTransports = new Set<string>();
    return {
      heartbeatGroups() {
        return Promise.resolve([secret.groupId]);
      },
      waitForWake(signal) {
        return relay.waitForWake(signal, Array.from(pendingOutboundTransports));
      },
      async publish(work) {
        const stored = await input.repository.getPdsOutboxEncryptedEnvelope({
          workerId: work.workerId,
          outboxId: work.outboxId
        });
        // Service owns lease identity; normal runtime gets package only through secure repo path.
        if (!stored) throw new Error("PdsRelayRetryableError");
        const pkg = parsePdsSessionPackageJson(
          await decryptEnvelopeToUtf8(
            input.envelopeEncryptionProvider,
            stored.encryptedEnvelope as never
          )
        );
        if (
          pkg.header.packageId !== work.packageId ||
          pkg.header.sourceManifestHash !== work.sourceManifestHash
        ) {
          throw new Error("PdsCryptoIdentityError");
        }
        const committed = await relay.upload(pkg);
        if (committed.deliveryState === "acked") {
          pendingOutboundTransports.delete(committed.transportId);
        } else {
          pendingOutboundTransports.add(committed.transportId);
        }
        return {
          state: committed.deliveryState,
          transportId: committed.transportId
        };
      },
      async outboundState(work) {
        if (work.groupId !== secret.groupId)
          throw new Error("PdsCryptoIdentityError");
        const response = record(
          await relay.transport(work.transportId),
          "transport response"
        );
        const transport = record(response.transport, "transport");
        if (
          transport.transportId !== work.transportId ||
          (transport.deliveryState !== "pending" &&
            transport.deliveryState !== "acked")
        ) {
          throw new TypeError("PdsRelayTransportError");
        }
        if (transport.deliveryState === "acked") {
          pendingOutboundTransports.delete(work.transportId);
          return "acked";
        }
        pendingOutboundTransports.add(work.transportId);
        return "committed";
      },
      async pollLifecycle() {
        // Control endpoint permits prior-head active certificate only to recover
        // current Authority binding; content endpoints remain fail-closed.
        const refreshed = record(await relay.certificate(), "certificate");
        const certificate = record(refreshed.certificate, "certificate");
        relay = new PdsRelayClient({
          baseUrl: secret.relayUrl,
          identity: relayIdentity(canonicalizePdsJson(certificate))
        });
        const lifecycle = record(await relay.lifecycle(), "lifecycle");
        const head = record(lifecycle.authority_head, "authority head");
        if (
          typeof head.sequence !== "string" ||
          typeof head.hash !== "string" ||
          !head.statement
        )
          throw new TypeError("PdsCryptoAuthorityError");
        const headStatement = record(
          typeof head.statement === "string"
            ? parseCanonicalPdsJson(head.statement)
            : head.statement,
          "authority head statement"
        );
        const headAuthorization = record(
          headStatement.authorization,
          "authority head authorization"
        );
        const headCertificate = secret.recipientCertificates
          .map((value) => record(parseCanonicalPdsJson(value), "certificate"))
          .find(
            (value) =>
              value.deviceSigningKeyId === headAuthorization.signerKeyId &&
              typeof value.deviceSigningPublicKey === "string"
          );
        if (
          !headCertificate ||
          pdsFinalizedStatementHash(headStatement as never) !== head.hash
        )
          throw new TypeError("PdsCryptoAuthorityError");
        validatePdsGroupStatement(headStatement as never, {
          authorizationPublicKey:
            headCertificate.deviceSigningPublicKey as string,
          authorityPublicKey: secret.authority.publicKey,
          expectedGroupId: secret.groupId,
          expectedSequence: head.sequence
        });
        const controls = Array.isArray(lifecycle.controls)
          ? lifecycle.controls
          : (() => {
              throw new TypeError("PdsCryptoAuthorityError");
            })();
        const floors = Array.isArray(lifecycle.deletion_floors)
          ? lifecycle.deletion_floors.map((floor) => {
              const item = record(floor, "deletion floor");
              if (
                typeof item.logicalMemoryId !== "string" ||
                typeof item.deletionFloorToken !== "string"
              )
                throw new TypeError("PdsCryptoAuthorityError");
              return {
                logicalMemoryId: item.logicalMemoryId,
                deletionFloorToken: item.deletionFloorToken
              };
            })
          : (() => {
              throw new TypeError("PdsCryptoAuthorityError");
            })();
        for (const item of controls) {
          const control = record(item, "lifecycle control");
          if (
            (control.kind !== "tombstone" &&
              control.kind !== "resolve-conflict") ||
            typeof control.record !== "object"
          )
            throw new TypeError("PdsCryptoAuthorityError");
          const tombstone = record(control.record, "tombstone control");
          const authorization = record(
            tombstone.authorization,
            "authorization"
          );
          const certificate = secret.recipientCertificates
            .map((value) => record(parseCanonicalPdsJson(value), "certificate"))
            .find(
              (value) =>
                value.deviceSigningKeyId === authorization.signerKeyId &&
                typeof value.deviceSigningPublicKey === "string"
            );
          if (!certificate) throw new TypeError("PdsCryptoAuthorityError");
          const validation = {
            authorizationPublicKey:
              certificate.deviceSigningPublicKey as string,
            authorityPublicKey: secret.authority.publicKey,
            expectedAuthorizationKeyId: authorization.signerKeyId as string,
            expectedGroupId: secret.groupId
          };
          if (control.kind === "tombstone")
            validatePdsTombstone(tombstone, validation);
          else validatePdsConflictResolution(tombstone, validation);
          const statement = record(control.statement, "lifecycle statement");
          validatePdsGroupStatement(statement as never, {
            authorizationPublicKey:
              certificate.deviceSigningPublicKey as string,
            authorityPublicKey: secret.authority.publicKey,
            expectedGroupId: secret.groupId
          });
        }
        await input.repository.applyPdsDeletionFloors({
          userId: secret.userId,
          groupId: secret.groupId,
          floors
        });
        const reconciled = await input.repository.reconcilePdsRestore({
          groupId: secret.groupId,
          deviceId: runtime.recipient.deviceId,
          authorityHead: head.hash,
          authoritySequence: head.sequence,
          lifecycleHighWater:
            controls.length &&
            typeof record(controls.at(-1), "control").sequence === "string"
              ? (record(controls.at(-1), "control").sequence as string)
              : "0"
        });
        if (!reconciled.accepted)
          throw new TypeError("PdsCryptoAuthorityError");
        for (const item of controls) {
          const control = record(item, "lifecycle control");
          if (control.kind !== "tombstone") continue;
          const tombstone = record(control.record, "tombstone control");
          const draft = record(tombstone.draft, "tombstone draft");
          if (
            typeof draft.groupId !== "string" ||
            typeof control.record !== "object" ||
            typeof control.statement !== "object"
          )
            throw new TypeError("PdsCryptoAuthorityError");
          const tombstoneHash = createHash("sha256")
            .update(canonicalizePdsJson(tombstone))
            .digest("base64url");
          const unsigned = {
            protocol: PDS_PROTOCOL,
            groupId: secret.groupId,
            tombstoneHash,
            deviceId: runtime.recipient.deviceId,
            statementHash: pdsFinalizedStatementHash(
              record(control.statement, "tombstone statement") as never
            ),
            ackedAt: new Date().toISOString()
          };
          await relay.acknowledgeTombstone({
            ...unsigned,
            signature: {
              signerKeyId: runtime.recipient.signingKeyId,
              signature: signPdsRecord("tombstone-ack", unsigned, signingKey)
            }
          });
        }
      },
      async poll() {
        const mailbox = record(await relay.mailbox(), "mailbox");
        const transports = Array.isArray(mailbox.transports)
          ? mailbox.transports
          : [];
        return transports.map((value) => {
          const transport = record(value, "mailbox transport");
          if (
            typeof transport.transportId !== "string" ||
            typeof transport.packageId !== "string" ||
            typeof transport.sourceManifestHash !== "string"
          )
            throw new TypeError("PDS mailbox transport is invalid");
          return {
            userId: secret.userId,
            groupId: secret.groupId,
            packageId: transport.packageId,
            sourceManifestHash: transport.sourceManifestHash,
            transportId: transport.transportId
          };
        });
      },
      async acknowledge(work) {
        const downloadedPackage = downloaded.get(work.inboxId);
        if (!downloadedPackage) throw new Error("PdsRelayRetryableError");
        const { pkg, transport } = downloadedPackage;
        const relayAcceptedAt = transport.relayAcceptedAt;
        if (typeof relayAcceptedAt !== "string") {
          throw new TypeError("PDS relay receipt is invalid");
        }
        const unsigned = {
          protocol: PDS_PROTOCOL,
          groupId: work.groupId,
          transportId: pkg.header.transportId,
          packageId: work.packageId,
          sourceManifestHash: work.sourceManifestHash,
          recipientDeviceId: runtime.recipient.deviceId,
          intendedRecipientSnapshotHash:
            pkg.header.intendedRecipientSnapshotHash,
          relayAcceptedAt,
          ackedAt: new Date().toISOString(),
          result: "materialized"
        };
        const ack = {
          ...unsigned,
          signature: {
            signerKeyId: runtime.recipient.signingKeyId,
            signature: signPdsRecord("package-ack", unsigned, signingKey)
          }
        };
        await relay.acknowledge(ack);
        await relay.advanceCursor(work.originDeviceId, work.sourceSequence);
        downloaded.delete(work.inboxId);
      },
      async materialize(work) {
        // Fetch current Authority-authenticated lifecycle before any package bytes.
        const lifecycle = record(await relay.lifecycle(), "lifecycle");
        const deletionFloors = Array.isArray(lifecycle.deletion_floors)
          ? lifecycle.deletion_floors.map((floor) => {
              const item = record(floor, "deletion floor");
              if (
                typeof item.logicalMemoryId !== "string" ||
                typeof item.deletionFloorToken !== "string"
              )
                throw new TypeError("PdsCryptoAuthorityError");
              return {
                logicalMemoryId: item.logicalMemoryId,
                deletionFloorToken: item.deletionFloorToken
              };
            })
          : (() => {
              throw new TypeError("PdsCryptoAuthorityError");
            })();
        await input.repository.applyPdsDeletionFloors({
          userId: secret.userId,
          groupId: secret.groupId,
          floors: deletionFloors
        });
        const transportId = await input.repository.getPdsInboundTransport({
          groupId: work.groupId,
          packageId: work.packageId
        });
        if (!transportId) throw new Error("PdsRelayRetryableError");
        const metadata = record(
          await relay.transport(transportId),
          "transport metadata"
        );
        const header = metadata.header;
        const envelopes = metadata.envelopes;
        const transport = record(metadata.transport, "transport receipt");
        const count = Number(record(header, "header").chunkCount);
        if (!Number.isSafeInteger(count) || count < 1)
          throw new TypeError("PdsCryptoPackageError");
        const chunks = await Promise.all(
          Array.from(
            { length: count },
            async (_, index) =>
              record(
                await relay.chunk(transportId, String(index)),
                "chunk response"
              ).chunk
          )
        );
        const pkg = parsePdsSessionPackageJson(
          canonicalizePdsJson({
            header,
            envelopes,
            chunks,
            packageDigest: pdsSessionPackageDigest({
              header: header as PdsSessionPackage["header"],
              envelopes: envelopes as PdsSessionPackage["envelopes"],
              chunks: chunks as PdsSessionPackage["chunks"]
            })
          })
        );
        const manifest = verifyAndDecryptPdsSessionPackage(
          canonicalizePdsJson(pkg),
          {
            runtime: runtimeForServing(pkg.header.servingDeviceId),
            recipientKemPrivateKey: secret.device.kemPrivateSeed,
            deletionFloors
          }
        );
        if (
          manifest.packageId !== work.packageId ||
          pkg.header.sourceManifestHash !== work.sourceManifestHash
        ) {
          throw new Error("PdsCryptoIdentityError");
        }
        const encryptedEnvelope =
          await input.envelopeEncryptionProvider.encrypt({
            plaintext: canonicalizePdsJson(pkg),
            scope: {
              tenantId: secret.userId,
              objectClass: "pds_inbound_package"
            },
            provenance: {
              rowFamily: "pds_retained_packages",
              sourceTable: "pds_retained_packages",
              sourceId: manifest.packageId
            },
            ciphertextLocation: "pds_retained_packages",
            aad: {
              ownerUserId: secret.userId,
              groupId: secret.groupId,
              packageId: manifest.packageId
            }
          });
        const retained = await input.repository.retainPdsInboundPackage({
          userId: secret.userId,
          groupId: secret.groupId,
          inboxId: work.inboxId,
          packageId: manifest.packageId,
          sourceManifestHash: pkg.header.sourceManifestHash,
          originDeploymentId: manifest.originDeploymentId,
          originDeviceId: manifest.originDeviceId,
          sourceSequence: manifest.sourceSequence,
          logicalMemoryId: manifest.logicalMemoryId,
          deletionFloorToken: manifest.deletionFloorToken,
          sourceFingerprint: manifest.sourceFingerprint,
          sourceClosureHash: manifest.sourceClosureHash,
          encryptedEnvelope
        });
        if (retained.state === "revoked")
          throw new Error("PdsCryptoFloorError");
        const session = await materializePdsSession(
          input.repository,
          secret.userId,
          secret.groupId,
          manifest
        );
        downloaded.set(work.inboxId, { pkg, transport });
        return {
          userId: secret.userId,
          retainedPackageId: retained.retainedPackageId,
          localSessionId: session.id,
          sourceFingerprint: manifest.sourceFingerprint,
          closureHash: manifest.sourceClosureHash,
          originDeploymentId: manifest.originDeploymentId,
          originDeviceId: manifest.originDeviceId,
          sourceSequence: manifest.sourceSequence,
          sourceClosedAt: new Date(manifest.closedSession.sourceClosedAt),
          observedAt: new Date(),
          sourceItemIds: session.itemIds
        };
      }
    };
  } catch {
    return null;
  }
};

/** Operator-managed or Desktop-bridge runtime. Secret bytes never enter worker configuration. */
export const createPdsWorkerRuntimeFromEnvironment = (
  input: PdsRuntimeFactoryInput
): PdsWorkerSecureRuntime | null => {
  const secret = resolvePdsProviderRuntimeSecret(
    input.environment ?? process.env
  );
  return secret ? createPdsWorkerRuntimeFromSecret(input, secret) : null;
};

/**
 * Keeps the worker running while Desktop enrollment atomically replaces the
 * keychain-backed runtime. One provider read is pinned for each reconciliation
 * cycle so an epoch cannot change halfway through a package operation.
 */
export const createReloadablePdsWorkerRuntimeFromEnvironment = (
  input: PdsRuntimeFactoryInput & {
    resolveSecret?: (environment: NodeJS.ProcessEnv) => RuntimeSecret | null;
    createRuntime?: (
      input: PdsRuntimeFactoryInput,
      secret: RuntimeSecret
    ) => PdsWorkerSecureRuntime | null;
  }
): PdsWorkerSecureRuntime => {
  const environment = input.environment ?? process.env;
  const resolveSecret = input.resolveSecret ?? resolvePdsProviderRuntimeSecret;
  const createRuntime = input.createRuntime ?? createPdsWorkerRuntimeFromSecret;
  let runtimeFingerprint: string | null = null;
  let cycleRuntime: PdsWorkerSecureRuntime | null = null;

  const resolveCycleRuntime = (): PdsWorkerSecureRuntime | null => {
    const secret = resolveSecret(environment);
    if (!secret) {
      runtimeFingerprint = null;
      cycleRuntime = null;
      return null;
    }
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(secret))
      .digest("base64url");
    if (fingerprint !== runtimeFingerprint) {
      cycleRuntime = createRuntime(input, secret);
      runtimeFingerprint = cycleRuntime ? fingerprint : null;
    }
    return cycleRuntime;
  };

  const requiredRuntime = (): PdsWorkerSecureRuntime => {
    if (!cycleRuntime) {
      throw new Error("PdsSecureRuntimeUnavailableError");
    }
    return cycleRuntime;
  };

  return {
    async heartbeatGroups() {
      const runtime = resolveCycleRuntime();
      return runtime ? ((await runtime.heartbeatGroups?.()) ?? []) : [];
    },
    async publish(input) {
      return await requiredRuntime().publish(input);
    },
    async outboundState(input) {
      return await requiredRuntime().outboundState(input);
    },
    async waitForWake(signal) {
      const runtime = resolveCycleRuntime();
      if (!runtime) return;
      await runtime.waitForWake?.(signal);
    },
    async pollLifecycle() {
      await requiredRuntime().pollLifecycle?.();
    },
    async poll() {
      return await requiredRuntime().poll();
    },
    async acknowledge(input) {
      await requiredRuntime().acknowledge?.(input);
    },
    async materialize(input) {
      return await requiredRuntime().materialize(input);
    }
  };
};

export const materializePdsSession = async (
  repository: MemorySourceRepository,
  userId: string,
  groupId: string,
  manifest: PdsSessionManifest
): Promise<{ id: string; itemIds: string[] }> => {
  const identity = manifest.sourceFingerprint ?? manifest.sourceClosureHash;
  const session = await repository.createCapturedSession(
    { userId },
    {
      // Signed logical and provider identities converge across Personal devices.
      idempotencyKey: `pds-session:${groupId}:${identity}`,
      logicalSessionId: manifest.closedSession.logicalSessionId,
      externalSessionId: manifest.closedSession.externalSessionId,
      forkedFromExternalThreadId:
        manifest.closedSession.forkedFromExternalThreadId ?? undefined,
      sourceHash: `pds:${identity}`,
      sourceRuntime: "codex",
      captureMethod: "transcript",
      metadata: {
        pds: {
          groupId,
          originDeploymentId: manifest.originDeploymentId,
          sourceSequence: manifest.sourceSequence
        }
      }
    }
  );
  const sourceItems = manifest.rawClosure.records.map((raw, index) => {
    const payload = parseCanonicalPdsJson(
      Buffer.from(raw.payload, "base64url").toString("utf8")
    ) as {
      actor?: unknown;
      content?: unknown;
      metadata?: unknown;
      type?: unknown;
    };
    const actor = typeof payload.actor === "string" ? payload.actor : "system";
    const type = typeof payload.type === "string" ? payload.type : "message";
    const content = typeof payload.content === "string" ? payload.content : "";
    const metadata =
      payload.metadata &&
      typeof payload.metadata === "object" &&
      !Array.isArray(payload.metadata)
        ? payload.metadata
        : {};
    return {
      sessionId: session.id,
      sourceKind: manifest.closedSession.sourceAdapter,
      sourceAdapterVersion: manifest.closedSession.sourceAdapterVersion,
      sourceTransport: "pds_relay",
      externalSessionId: manifest.closedSession.externalSessionId,
      externalThreadId: manifest.closedSession.externalSessionId,
      sourceRecordType: type,
      sourceEventType: type,
      sourceSequence: index,
      externalItemId: raw.sourceNativeItemId,
      eventTime: raw.sourceTimestamp,
      observedAt: raw.observedAt,
      rawJson: { type, role: actor, content },
      ...(content ? { rawText: content } : {}),
      sourceHash: raw.payloadHash,
      idempotencyKey: `pds-item:${groupId}:${identity}:${raw.ordinal}`,
      metadata: {
        ...metadata,
        transcriptType: type,
        sourceRole: actor,
        pds: {
          originDeviceId: manifest.originDeviceId,
          sourceSequence: manifest.sourceSequence
        }
      }
    };
  });
  const terminalOrdinal = manifest.rawClosure.records.length;
  const terminalTimestamp = manifest.closedSession.sourceClosedAt;
  sourceItems.push({
    sessionId: session.id,
    sourceKind: manifest.closedSession.sourceAdapter,
    sourceAdapterVersion: manifest.closedSession.sourceAdapterVersion,
    sourceTransport: "pds_relay",
    externalSessionId: manifest.closedSession.externalSessionId,
    externalThreadId: manifest.closedSession.externalSessionId,
    sourceRecordType: "pds_session_closed",
    sourceEventType: "pds_session_closed",
    sourceSequence: terminalOrdinal,
    externalItemId: `pds-terminal:${identity}`,
    eventTime: terminalTimestamp,
    observedAt: terminalTimestamp,
    rawJson: {
      type: "pds_session_closed",
      role: "system",
      content: ""
    },
    sourceHash: manifest.sourceClosureHash,
    idempotencyKey: `pds-terminal:${groupId}:${identity}`,
    metadata: {
      transcriptType: "pds_session_closed",
      sourceRole: "system",
      pds: {
        originDeviceId: manifest.originDeviceId,
        sourceSequence: manifest.sourceSequence
      }
    }
  });
  const items = await repository.createConversationItems(
    { userId },
    {
      items: sourceItems
    }
  );
  return { id: session.id, itemIds: items.map((item) => item.id) };
};
