import { createHash } from "node:crypto";
import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";

import type { MemorySourceRepository } from "@koed/db";
import {
  generateRecipientKeyMaterial,
  readLocalEdgeUpstreamRegistry,
  readUpstreamCredentialAuthorization,
  toRecipientPublicKeyMaterial,
  upstreamAdvertisesCapability,
  upstreamBackendById,
  type EnvelopeEncryptionProvider
} from "@koed/shared";
import type { Logger } from "pino";

import {
  combineManagedConversationRepositories,
  createManagedConversationAuthorityClient
} from "./managed-conversation-authority-client.js";
import {
  createManagedConversationService,
  type ManagedConversationService
} from "./managed-conversation-service.js";

type ServiceOptions = Parameters<typeof createManagedConversationService>[0];

export interface ManagedConversationRuntimeCoordinator {
  start(): void;
  stop(): Promise<void>;
}

type ManagedConversationAuthorityConfiguration = {
  backendId: string;
  baseUrl: string;
  authorization: string;
  sourceReplicationMode?: "hosted_personal" | "peer_personal";
} | null;

const authoritySignature = (
  backendId: string | null,
  authorization: string | null
): string =>
  createHash("sha256")
    .update(`${backendId ?? "local"}\n${authorization ?? ""}`)
    .digest("hex");

const restoreCorrelationId = (
  operationId: string,
  sourceGenerationId: string
): string => {
  const bytes = createHash("sha256")
    .update("koed-managed-source-restore-v1\0")
    .update(operationId)
    .update("\0")
    .update(sourceGenerationId)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const createManagedConversationRuntimeCoordinator = (options: {
  localRepository: MemorySourceRepository;
  localOwnerUserId: string;
  apiUrl: string;
  apiToken: string;
  appServerBinary: string;
  model: string;
  reasoningEffort: string;
  deviceId: string;
  deploymentId: string;
  koedHome: string;
  envelopeEncryptionProvider: EnvelopeEncryptionProvider;
  commandWakePool: NonNullable<ServiceOptions["commandWakePool"]>;
  fetch?: typeof fetch;
  logger: Logger;
  createService?: typeof createManagedConversationService;
  resolveAuthority?: () => ManagedConversationAuthorityConfiguration;
}): ManagedConversationRuntimeCoordinator => {
  const configDirectory = resolve(options.koedHome, "config");
  const secretsDirectory = resolve(options.koedHome, "secrets");
  const registryPath = resolve(configDirectory, "upstream-backends.json");
  let service: ManagedConversationService | null = null;
  let currentSignature: string | null = null;
  let desiredRevision = 0;
  let appliedRevision = -1;
  let reconcilePromise: Promise<void> | null = null;
  let stopped = false;
  const watchers: FSWatcher[] = [];

  const defaultResolveAuthority =
    (): ManagedConversationAuthorityConfiguration => {
      const registry = readLocalEdgeUpstreamRegistry(registryPath);
      const backend = registry.activeBackendId
        ? upstreamBackendById(registry, registry.activeBackendId)
        : null;
      const remoteEnabled = Boolean(
        backend &&
        backend.routePolicy.managedExecution === "enabled" &&
        upstreamAdvertisesCapability(backend, "memory.managedConversations") &&
        upstreamAdvertisesCapability(
          backend,
          "memory.conversationSourceReplication"
        )
      );
      const authorization = remoteEnabled
        ? readUpstreamCredentialAuthorization(
            options.koedHome,
            backend?.credential?.reference
          )
        : null;
      return backend && remoteEnabled && authorization
        ? {
            backendId: backend.id,
            baseUrl: backend.baseUrl,
            authorization,
            sourceReplicationMode:
              backend.profile === "local_personal"
                ? "peer_personal"
                : "hosted_personal"
          }
        : null;
    };

  const resolvedAuthority = (): ManagedConversationAuthorityConfiguration =>
    options.resolveAuthority
      ? options.resolveAuthority()
      : defaultResolveAuthority();

  const buildService = (
    authority: ManagedConversationAuthorityConfiguration
  ): ManagedConversationService => {
    const authorityClient = authority
      ? createManagedConversationAuthorityClient({
          baseUrl: authority.baseUrl,
          authorization: authority.authorization,
          envelopeEncryptionProvider: options.envelopeEncryptionProvider,
          fetch: options.fetch
        })
      : null;
    const repository = authorityClient
      ? combineManagedConversationRepositories(
          options.localRepository,
          authorityClient,
          options.localOwnerUserId
        )
      : options.localRepository;
    const sourceRestoreControl =
      authority && authorityClient
        ? {
            ensure: async (input: {
              transferKind: "handoff" | "fork";
              transferId: string;
              operationId: string;
              sourceGenerationId: string;
            }) => {
              const actor = { userId: options.localOwnerUserId };
              const deployment =
                await options.localRepository.getLocalSyncDeployment();
              if (
                !deployment ||
                deployment.protocolDeploymentId !== options.deploymentId
              ) {
                throw new Error("ManagedConversationSourceDeploymentError");
              }
              let recipient =
                await options.localRepository.getActiveSyncRecipientKey(
                  deployment.id
                );
              if (!recipient) {
                recipient =
                  await options.localRepository.ensureSyncRecipientKey({
                    deploymentIdentityId: deployment.id,
                    material: await generateRecipientKeyMaterial(
                      options.envelopeEncryptionProvider,
                      {
                        keyId: `sync-recipient:${deployment.protocolDeploymentId}`,
                        keyVersion: 1,
                        scope: {
                          deploymentId: deployment.protocolDeploymentId,
                          objectClass: "sync_recipient_key"
                        },
                        provenance: {
                          rowFamily: "sync_recipient_key",
                          sourceId: deployment.id
                        }
                      }
                    )
                  });
              }
              const job =
                await options.localRepository.createConversationSourceRestoreJob(
                  actor,
                  {
                    upstreamBackendId: authority.backendId,
                    sourceGenerationId: input.sourceGenerationId,
                    targetDeploymentId: deployment.protocolDeploymentId,
                    recipientKeyId: recipient.keyId,
                    recipientKeyVersion: recipient.keyVersion,
                    actionGrantId: restoreCorrelationId(
                      input.operationId,
                      input.sourceGenerationId
                    ),
                    firstSegmentIndex: 0
                  }
                );
              if (job.state !== "awaiting_approval") return;
              const authorization =
                await authorityClient.createManagedConversationSourceDownloadAuthorization(
                  {
                    transferKind: input.transferKind,
                    transferId: input.transferId,
                    targetDeploymentId: deployment.protocolDeploymentId,
                    sourceGenerationId: input.sourceGenerationId,
                    firstSegmentIndex: job.nextSegmentIndex,
                    recipientKey: toRecipientPublicKeyMaterial(recipient)
                  }
                );
              if (
                authorization.sourceGenerationId !== input.sourceGenerationId
              ) {
                throw new Error("ManagedConversationSourceAuthorizationError");
              }
              await options.localRepository.activateConversationSourceRestoreJob(
                actor,
                {
                  restoreJobId: job.id,
                  actionGrantId: job.actionGrantId,
                  remoteAuthorizationId: authorization.authorizationId,
                  capability: authorization.capability,
                  registration: authorization.registration,
                  sourceDescriptor: authorization.source,
                  ...(authorization.sourceClosure
                    ? { sourceClosure: authorization.sourceClosure }
                    : {}),
                  firstSegmentIndex: authorization.firstSegmentIndex,
                  lastSegmentIndex: authorization.lastSegmentIndex
                }
              );
            }
          }
        : undefined;
    const sourcePublishControl = authority
      ? {
          ensure: async (input: { sourceGenerationId: string }) => {
            const actor = { userId: options.localOwnerUserId };
            const chain = [];
            const seen = new Set<string>();
            let sourceGenerationId: string | null = input.sourceGenerationId;
            while (sourceGenerationId) {
              if (seen.has(sourceGenerationId) || seen.size >= 1_024) {
                throw new Error("ManagedConversationSourcePublishChainError");
              }
              seen.add(sourceGenerationId);
              const artifact =
                await options.localRepository.getConversationSourceArtifactByGeneration(
                  actor,
                  sourceGenerationId
                );
              if (!artifact) {
                throw new Error("ManagedConversationSourcePublishMissingError");
              }
              chain.unshift(artifact);
              const prior = artifact.priorGenerationClosure;
              sourceGenerationId =
                prior && typeof prior.sourceGenerationId === "string"
                  ? prior.sourceGenerationId
                  : null;
            }
            for (const artifact of chain) {
              await options.localRepository.enqueueConversationSourceArtifactReplication(
                actor,
                {
                  artifactId: artifact.id,
                  targetUpstreamId: authority.backendId,
                  mode: authority.sourceReplicationMode ?? "hosted_personal"
                }
              );
            }
          },
          ensureRegistration: async (input: { sourceGenerationId: string }) => {
            const actor = { userId: options.localOwnerUserId };
            const artifact =
              await options.localRepository.getConversationSourceArtifactByGeneration(
                actor,
                input.sourceGenerationId
              );
            if (!artifact) {
              throw new Error(
                "ManagedConversationSourceRegistrationMissingError"
              );
            }
            await options.localRepository.enqueueConversationSourceGenerationRegistration(
              actor,
              {
                artifactId: artifact.id,
                targetUpstreamId: authority.backendId,
                mode: authority.sourceReplicationMode ?? "hosted_personal"
              }
            );
          }
        }
      : undefined;
    return (options.createService ?? createManagedConversationService)({
      repository,
      apiUrl: options.apiUrl,
      apiToken: options.apiToken,
      localOwnerUserId: options.localOwnerUserId,
      appServerBinary: options.appServerBinary,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      deviceId: options.deviceId,
      deploymentId: options.deploymentId,
      koedHome: options.koedHome,
      envelopeEncryptionProvider: options.envelopeEncryptionProvider,
      ...(sourceRestoreControl ? { sourceRestoreControl } : {}),
      ...(sourcePublishControl ? { sourcePublishControl } : {}),
      commandWakePool: options.commandWakePool,
      ...(authority
        ? {
            remoteWake: {
              baseUrl: authority.baseUrl,
              authorization: authority.authorization,
              fetch: options.fetch
            }
          }
        : {}),
      logger: options.logger
    });
  };

  const reconcile = async (): Promise<void> => {
    while (!stopped && appliedRevision !== desiredRevision) {
      const revision = desiredRevision;
      const authority = resolvedAuthority();
      const nextSignature = authoritySignature(
        authority?.backendId ?? null,
        authority?.authorization ?? null
      );
      if (nextSignature !== currentSignature) {
        const next = buildService(authority);
        const previous = service;
        service = null;
        currentSignature = null;
        if (previous) await previous.stop();
        if (stopped) return;
        next.start();
        service = next;
        currentSignature = nextSignature;
        options.logger.info(
          {
            event: {
              name: "worker.managed_conversation.authority_reconfigured",
              category: "managed_conversation"
            },
            authority:
              nextSignature === authoritySignature(null, null)
                ? "local"
                : "remote"
          },
          "managed Conversation execution authority reconfigured"
        );
      }
      appliedRevision = revision;
    }
  };

  const scheduleReconcile = (): void => {
    if (stopped) return;
    desiredRevision += 1;
    if (reconcilePromise) return;
    reconcilePromise = reconcile()
      .catch((error: unknown) => {
        options.logger.error(
          {
            event: {
              name: "worker.managed_conversation.authority_reconfigure_failed",
              category: "managed_conversation"
            },
            error: error instanceof Error ? error.name : "UnknownError"
          },
          "managed Conversation execution authority reconfiguration failed"
        );
      })
      .finally(() => {
        reconcilePromise = null;
        if (!stopped && appliedRevision !== desiredRevision) {
          scheduleReconcile();
        }
      });
  };

  const watchDirectory = (
    directory: string,
    relevant: (filename: string) => boolean
  ): void => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const watcher = watch(directory, (_event, filename) => {
      if (filename && relevant(filename.toString())) scheduleReconcile();
    });
    watcher.on("error", (error) => {
      options.logger.warn(
        {
          event: {
            name: "worker.managed_conversation.authority_watch_failed",
            category: "managed_conversation"
          },
          error: error.name
        },
        "managed Conversation authority file watcher failed"
      );
    });
    watchers.push(watcher);
  };

  return {
    start() {
      if (stopped || watchers.length) return;
      watchDirectory(
        configDirectory,
        (filename) =>
          filename === "upstream-backends.json" ||
          filename === "local-secret-store.key"
      );
      watchDirectory(
        secretsDirectory,
        (filename) =>
          filename === "upstream-credentials.json" ||
          filename === "upstream-credentials.json.lock"
      );
      scheduleReconcile();
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      for (const watcher of watchers.splice(0)) watcher.close();
      await reconcilePromise;
      const active = service;
      service = null;
      currentSignature = null;
      if (active) await active.stop();
    }
  };
};
