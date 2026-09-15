import {
  pdsSessionPackageDigest,
  type EnvelopeEncryptionProvider
} from "@koed/shared";
import type {
  MemorySourceRepository,
  PdsClosureSource,
  PdsLocalClosureRecord
} from "@koed/db";
import type { PdsSecureKeyProvider } from "./local-source.js";
import { pdsConversationItemsForClosure } from "./local-source.js";
import { serializePdsCheckpointSourceForEncryptedStorage } from "./secure-runtime.js";

const CANDIDATE_BATCH_SIZE = 50;
const MAX_CANDIDATES_PER_DRAIN = 200;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

type Candidate = {
  userId: string;
  groupId: string;
  sessionId: string;
};

type CheckpointBuildInput = {
  source: PdsClosureSource;
  sourceSequence: string;
  closedAt: Date;
  checkpoint?: {
    version: "1";
    ordinal: string;
    previousClosureHash: string | null;
  };
};

type CheckpointRepository = Pick<
  MemorySourceRepository,
  "listPdsCheckpointCandidates" | "checkpointPdsSourceSession"
>;

export interface PdsCheckpointPublicationService {
  start(): void;
  scanNow(): Promise<void>;
  stop(): Promise<void>;
}

export const publishPdsCheckpointCandidate = async (input: {
  repository: CheckpointRepository;
  secureKeyProvider: PdsSecureKeyProvider;
  envelopeEncryptionProvider: EnvelopeEncryptionProvider;
  candidate: Candidate;
}): Promise<PdsLocalClosureRecord | null> => {
  const keyContext = await input.secureKeyProvider.getSourceContext({
    userId: input.candidate.userId,
    groupId: input.candidate.groupId
  });
  if (!keyContext) throw new Error("PdsSecureRuntimeUnavailableError");

  const publication = {
    ...input.candidate,
    originDeploymentId: keyContext.originDeploymentId,
    originDeviceId: keyContext.originDeviceId,
    async build({ source, sourceSequence, checkpoint }: CheckpointBuildInput) {
      if (!checkpoint) throw new Error("PdsCheckpointMetadataUnavailableError");
      const items = pdsConversationItemsForClosure(source);
      const built = await keyContext.buildCompletedTurnCheckpointPackage({
        source,
        sourceSequence,
        items,
        checkpoint
      });
      const pkg = built.package;
      const sourceManifestHash = pkg.header.sourceManifestHash;
      if (
        sourceManifestHash !== built.sourceManifestHash ||
        pkg.packageDigest !==
          pdsSessionPackageDigest({
            header: pkg.header,
            envelopes: pkg.envelopes,
            chunks: pkg.chunks
          })
      ) {
        throw new Error("PdsSecurePackageIdentityBindingError");
      }
      const packageId = pkg.header.packageId;
      return {
        sourceClosureHash: built.sourceClosureHash,
        packageId,
        sourceManifestHash,
        sourceFingerprint: built.sourceFingerprint,
        logicalMemoryId: built.logicalMemoryId,
        deletionFloorToken: built.deletionFloorToken,
        encryptedEnvelope: await input.envelopeEncryptionProvider.encrypt({
          plaintext: serializePdsCheckpointSourceForEncryptedStorage({
            manifest: built.manifest,
            package: pkg
          }),
          scope: {
            tenantId: input.candidate.userId,
            objectClass: "pds_source_package"
          },
          provenance: {
            rowFamily: "pds_retained_packages",
            sourceTable: "pds_retained_packages",
            sourceId: packageId
          },
          ciphertextLocation: "pds_retained_packages",
          aad: {
            ownerUserId: input.candidate.userId,
            groupId: input.candidate.groupId,
            packageId
          }
        })
      };
    }
  };

  return input.repository.checkpointPdsSourceSession(publication);
};

/**
 * Polls durable completion evidence so correctness does not depend on any
 * runtime-specific hook or watcher notification reaching the API process.
 */
export const createPdsCheckpointPublicationService = (input: {
  repository: CheckpointRepository;
  secureKeyProvider: PdsSecureKeyProvider;
  envelopeEncryptionProvider: EnvelopeEncryptionProvider;
  pollIntervalMs?: number;
  onError?(error: unknown): void;
}): PdsCheckpointPublicationService => {
  const pollIntervalMs = Math.max(
    1_000,
    Math.min(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 60_000)
  );
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;
  let afterSessionId: string | undefined;

  const scanNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      let processed = 0;
      try {
        while (processed < MAX_CANDIDATES_PER_DRAIN && !stopped) {
          const candidates = await input.repository.listPdsCheckpointCandidates(
            afterSessionId ? { afterSessionId } : undefined
          );
          if (candidates.length === 0) {
            afterSessionId = undefined;
            break;
          }
          const page = candidates.slice(0, CANDIDATE_BATCH_SIZE);
          processed += page.length;
          for (const candidate of page) {
            if (stopped) break;
            try {
              await publishPdsCheckpointCandidate({
                repository: input.repository,
                secureKeyProvider: input.secureKeyProvider,
                envelopeEncryptionProvider: input.envelopeEncryptionProvider,
                candidate
              });
            } catch (error) {
              input.onError?.(error);
            }
          }
          afterSessionId = page.at(-1)?.sessionId;
          if (candidates.length < CANDIDATE_BATCH_SIZE || page.length === 0) {
            afterSessionId = undefined;
            break;
          }
        }
      } catch (error) {
        input.onError?.(error);
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    start() {
      if (stopped || timer) return;
      timer = setInterval(() => {
        void scanNow();
      }, pollIntervalMs);
      timer.unref();
      void scanNow();
    },
    scanNow,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    }
  };
};
