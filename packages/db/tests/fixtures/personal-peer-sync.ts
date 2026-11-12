import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  canonicalizePdsJson,
  createLocalTestKeyEnvelopeEncryptionProvider,
  createPdsSessionCheckpointManifest,
  createPdsSessionCheckpointPackage,
  createPdsRepositoryAssignment,
  createRepositoryAssignment,
  verifyAndDecryptPdsSessionSourcePackage,
  verifyPdsRepositoryAssignmentWithKeyHistory,
  isPdsSessionCheckpointManifest,
  type PdsSessionPackage
} from "@koed-labs/shared";
import { createMemorySourceRepository } from "../../src/index.js";
import { pdsConversationItemsForClosure } from "../../../../apps/api/src/personal-device-sync/local-source.js";
import { pdsCheckpointMaterializationSource } from "../../../../apps/worker/src/personal-device-sync-runtime.js";
import {
  createPeerLifecycleFixture,
  createPeerDeletionControl,
  validatePeerDeletionControl,
  validatePeerLifecycleFixture
} from "./personal-peer-lifecycle.js";
import { personalSourceDeviceFixture } from "./personal-source-device.js";

type PeerContext = {
  lifecycle: ReturnType<typeof createPeerLifecycleFixture>;
  fixture: ReturnType<typeof personalSourceDeviceFixture>;
  sender: ReturnType<typeof personalSourceDeviceFixture>["origin"];
  recipient: ReturnType<typeof personalSourceDeviceFixture>["receiver"];
  origin: { userId: string };
  receiver: { userId: string };
};

export const createPeerSyncHarness = async (
  originPool: pg.Pool,
  receiverPool: pg.Pool,
  context?: PeerContext
) => {
  const lifecycle = context?.lifecycle ?? createPeerLifecycleFixture();
  const fixture = context?.fixture ?? personalSourceDeviceFixture(lifecycle);
  const sender = context?.sender ?? fixture.origin;
  const recipient = context?.recipient ?? fixture.receiver;
  const origin =
    context?.origin ?? (await fixture.initialize(originPool, sender));
  const receiver =
    context?.receiver ?? (await fixture.initialize(receiverPool, recipient));
  const encryption = createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 113).toString("base64")
  );
  const originRepo = createMemorySourceRepository(originPool, {
    envelopeEncryptionProvider: encryption
  });
  const receiverRepo = createMemorySourceRepository(receiverPool, {
    envelopeEncryptionProvider: encryption
  });
  const offsets = new Map<string, number>();
  const append = async (
    source: Awaited<ReturnType<typeof originRepo.createCapturedSession>>,
    message: string
  ) => {
    const offset = offsets.get(source.id) ?? 0;
    await originRepo.createConversationItems(origin, {
      items: ["agent_message", "task_complete"].map((type, index) => ({
        sessionId: source.id,
        externalSessionId: source.externalSessionId!,
        externalThreadId: source.externalSessionId!,
        externalItemId: `item-${offset + index}`,
        sourceKind: "codex",
        sourceAdapterVersion: "codex-transcript-v1",
        sourceTransport: "transcript",
        sourceRecordType: "event_msg",
        sourceEventType: type,
        sourceSequence: offset + index,
        sourceHash: randomUUID(),
        idempotencyKey: randomUUID(),
        eventTime: new Date().toISOString(),
        observedAt: new Date().toISOString(),
        rawJson: {
          type: "event_msg",
          payload: { type, message, last_agent_message: message }
        },
        rawText: message,
        metadata: {
          sourceRole: "agent",
          canonicalConversationItemActor: "agent",
          transcriptType: type
        }
      }))
    });
    offsets.set(source.id, offset + 2);
  };
  const capture = async (message: string) => {
    const source = await originRepo.createCapturedSession(origin, {
      externalSessionId: randomUUID(),
      sourceRuntime: "codex",
      captureMethod: "transcript",
      sourceKind: "codex",
      sourceAdapterVersion: "codex-transcript-v1"
    });
    await append(source, message);
    return source;
  };
  const publish = async (
    source: Awaited<ReturnType<typeof capture>>,
    conflictingHistory = false
  ) => {
    let built: PdsSessionPackage | undefined;
    await originRepo.checkpointPdsSourceSession({
      userId: origin.userId,
      groupId: fixture.groupId,
      sessionId: source.id,
      originDeploymentId: sender.deploymentId,
      originDeviceId: sender.deviceId,
      includeSourceContext: false,
      expectedEpoch: fixture.epoch,
      expectedAuthorityHead: fixture.authorityHead,
      async build(input) {
        const manifest = createPdsSessionCheckpointManifest({
          runtime: fixture.runtime(sender),
          originDeploymentId: sender.deploymentId,
          sourceSequence: input.sourceSequence,
          sourceNativeSessionId: input.source.externalSessionId,
          contentEpoch: fixture.epoch,
          repositoryAssignment: createPdsRepositoryAssignment(
            createRepositoryAssignment({
              state: "historical_unresolved",
              version: 1,
              automatic: null,
              override: null
            }),
            fixture.epoch,
            fixture.projectAliasKey
          ),
          sourceSession: {
            logicalSessionId: input.source.logicalSessionId,
            externalSessionId: input.source.externalSessionId,
            sourceAdapter: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceRuntime: "codex",
            captureMethod: "transcript",
            sourceCreatedAt: input.source.sourceCreatedAt
          },
          checkpoint: conflictingHistory
            ? {
                ...input.checkpoint!,
                previousClosureHash: randomBytes(32).toString("base64url")
              }
            : input.checkpoint!,
          terminalCursor: String(input.source.items.length),
          items: pdsConversationItemsForClosure(input.source),
          sourceFingerprintKey: fixture.sourceFingerprintKey,
          tombstoneFloorKey: fixture.tombstoneFloorKey,
          originSigningPrivateKey: sender.signing.privateKey
        });
        const pkg = createPdsSessionCheckpointPackage({
          runtime: fixture.runtime(sender),
          manifest,
          servingSigningPrivateKey: sender.signing.privateKey,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString()
        });
        built = pkg;
        return {
          packageId: manifest.packageId,
          sourceManifestHash: pkg.header.sourceManifestHash,
          sourceClosureHash: manifest.sourceClosureHash,
          sourceFingerprint: manifest.sourceFingerprint,
          logicalMemoryId: manifest.logicalMemoryId,
          deletionFloorToken: manifest.deletionFloorToken,
          encryptedEnvelope: await encryption.encrypt({
            plaintext: canonicalizePdsJson({
              kind: "pds_checkpoint_source_v1",
              manifest,
              package: pkg
            }),
            scope: { tenantId: origin.userId },
            provenance: { rowFamily: "pds_retained_packages" },
            ciphertextLocation: "fixture"
          })
        };
      }
    });
    if (!built) throw new Error("Checkpoint was not published");
    return built;
  };
  const decode = (
    pkg: PdsSessionPackage,
    recipientKey = recipient.kem.privateSeed
  ) => {
    const manifest = verifyAndDecryptPdsSessionSourcePackage(
      canonicalizePdsJson(pkg),
      {
        runtime: fixture.runtime(sender, recipient),
        recipientKemPrivateKey: recipientKey
      }
    );
    if (!isPdsSessionCheckpointManifest(manifest))
      throw new Error("Expected checkpoint");
    return manifest;
  };
  const receiveWithWrongRecipient = (pkg: PdsSessionPackage) =>
    receive(pkg, undefined, randomBytes(32).toString("base64url"));
  const createMatchingDeletion = (pkg: PdsSessionPackage) =>
    createPeerDeletionControl(lifecycle, decode(pkg));
  const hasInbox = async (pkg: PdsSessionPackage) => {
    const result = await receiverPool.query(
      "select 1 from pds_inbox_entries where owner_user_id=$1 and package_id=$2",
      [receiver.userId, pkg.header.packageId]
    );
    return result.rowCount !== 0;
  };
  const observedFloors: ReturnType<typeof validatePeerDeletionControl>[] = [];
  const receive = async (
    pkg: PdsSessionPackage,
    control?: ReturnType<typeof createPeerDeletionControl>,
    recipientKey?: string
  ) => {
    const floors = validatePeerLifecycleFixture(lifecycle);
    if (control)
      observedFloors.push(validatePeerDeletionControl(lifecycle, control));
    floors.push(...observedFloors);
    const manifest = decode(pkg, recipientKey);
    if (
      floors.some(
        (floor) =>
          floor.logicalMemoryId === manifest.logicalMemoryId &&
          floor.deletionFloorToken === manifest.deletionFloorToken
      )
    )
      throw new Error("Checkpoint blocked by deletion floor");
    const workerId = randomUUID();
    const received = await receiverRepo.receivePdsInbox({
      userId: receiver.userId,
      groupId: fixture.groupId,
      packageId: manifest.packageId,
      sourceManifestHash: pkg.header.sourceManifestHash
    });
    if (received === "quarantined")
      throw new Error("Package identity conflict");
    if (received === "idempotent") {
      const prior = await receiverPool.query<{ local_session_id: string }>(
        `select r.local_session_id from pds_inbox_entries i join personal_device_groups g on g.id=i.group_id join pds_replica_observations o on o.retained_package_id=i.retained_package_id join pds_logical_replicas r on r.id=o.replica_id where g.group_id=$1 and i.owner_user_id=$2 and i.package_id=$3 and i.state='ready' and r.materialization_state='ready'`,
        [fixture.groupId, receiver.userId, manifest.packageId]
      );
      if (prior.rows[0]?.local_session_id)
        return {
          localSessionId: prior.rows[0].local_session_id,
          deferred: false,
          conflict: false
        };
    }
    // The test transport leases only its own package; it is not a worker scheduler.
    const inbox = (
      await receiverPool.query<{ id: string }>(
        `update pds_inbox_entries i set state='downloading', lease_owner=$3,
       lease_until=now()+interval '60 seconds', attempt_count=attempt_count+1, updated_at=now()
       from personal_device_groups g where i.group_id=g.id and i.owner_user_id=$1 and g.group_id=$2
       and i.package_id=$4 and i.state in ('pending','downloading','verifying','processing','failed')
       and i.retry_at<=now() and (i.lease_until is null or i.lease_until<now()) and i.attempt_count<8
       returning i.id`,
        [receiver.userId, fixture.groupId, workerId, manifest.packageId]
      )
    ).rows[0];
    if (!inbox) throw new Error("Missing fixture inbox lease");
    const retained = await receiverRepo.retainPdsInboundPackage({
      userId: receiver.userId,
      groupId: fixture.groupId,
      inboxId: inbox.id,
      packageId: manifest.packageId,
      sourceManifestHash: pkg.header.sourceManifestHash,
      sourceLogicalSessionId: manifest.sourceSession.logicalSessionId,
      originDeploymentId: manifest.originDeploymentId,
      originDeviceId: manifest.originDeviceId,
      sourceSequence: manifest.sourceSequence,
      logicalMemoryId: manifest.logicalMemoryId,
      deletionFloorToken: manifest.deletionFloorToken,
      sourceFingerprint: manifest.sourceFingerprint,
      sourceClosureHash: manifest.sourceClosureHash,
      sourceProfile: "cumulative_checkpoint",
      checkpoint: manifest.checkpoint,
      encryptedEnvelope: await encryption.encrypt({
        plaintext: canonicalizePdsJson(pkg),
        scope: { tenantId: receiver.userId },
        provenance: { rowFamily: "pds_retained_packages" },
        ciphertextLocation: "fixture"
      })
    });
    const assignment = verifyPdsRepositoryAssignmentWithKeyHistory(
      manifest.repositoryAssignment,
      manifest.contentEpoch,
      { currentEpoch: fixture.epoch, projectKey: fixture.projectAliasKey }
    );
    const result = await receiverRepo.materializePdsSessionCheckpoint({
      userId: receiver.userId,
      groupId: fixture.groupId,
      workerId,
      inboxId: inbox.id,
      retainedPackageId: retained.retainedPackageId,
      packageId: manifest.packageId,
      sourceManifestHash: pkg.header.sourceManifestHash,
      sourceFingerprint: manifest.sourceFingerprint,
      closureHash: manifest.sourceClosureHash,
      logicalMemoryId: manifest.logicalMemoryId,
      deletionFloorToken: manifest.deletionFloorToken,
      originDeploymentId: manifest.originDeploymentId,
      originDeviceId: manifest.originDeviceId,
      sourceSequence: manifest.sourceSequence,
      sourceCheckpointAt: new Date(manifest.originSignedAt),
      observedAt: new Date(),
      checkpoint: manifest.checkpoint,
      profileTransition: manifest.profileTransition,
      ...pdsCheckpointMaterializationSource(
        fixture.groupId,
        manifest,
        assignment
      )
    });
    if (result.deferred) return result;
    if (result.conflict || !result.localSessionId)
      throw new Error("Checkpoint was not materialized");
    const completed = await receiverRepo.completePdsInbox({
      workerId,
      inboxId: inbox.id,
      retainedPackageId: retained.retainedPackageId,
      state: "ready"
    });
    if (!completed) throw new Error("Inbox completion failed");
    return result;
  };
  const writeReplicaItem = (sessionId: string, externalSessionId: string) =>
    receiverRepo.createConversationItems(receiver, {
      items: [
        {
          sessionId,
          externalSessionId,
          externalThreadId: externalSessionId,
          externalItemId: randomUUID(),
          sourceKind: "codex",
          sourceAdapterVersion: "codex-transcript-v1",
          sourceTransport: "transcript",
          sourceRecordType: "event_msg",
          sourceEventType: "agent_message",
          sourceSequence: 999999,
          sourceHash: randomUUID(),
          idempotencyKey: randomUUID(),
          eventTime: new Date().toISOString(),
          observedAt: new Date().toISOString(),
          rawJson: {},
          rawText: "tampered",
          metadata: {}
        }
      ]
    });
  const captureOnReceiver = () =>
    receiverRepo.createCapturedSession(receiver, {
      externalSessionId: randomUUID(),
      sourceRuntime: "codex",
      captureMethod: "transcript",
      sourceKind: "codex",
      sourceAdapterVersion: "codex-transcript-v1"
    });
  const writeSourceJournal = (
    sessionId: string,
    externalSessionId: string,
    role: "origin_local" | "peer_personal" = "origin_local"
  ) =>
    receiverRepo.ensureConversationSourceArtifact(receiver, {
      sessionId,
      externalSessionId,
      logicalSourceId: randomUUID(),
      sourceGenerationId: randomUUID(),
      replicaRole: role,
      sourceKind: "codex",
      sourceRuntime: "codex",
      sourceFingerprint: randomBytes(32).toString("hex"),
      artifactFormat: "codex_rollout_jsonl",
      artifactFormatVersion: 1,
      sourceAdapterVersion: "codex-transcript-v1",
      journalStartOffset: 0,
      journalStartLine: 0,
      liveStartOffset: 0,
      liveStartLine: 0,
      currentSourceLength: 0,
      sourceCreatedAt: new Date().toISOString(),
      storageProvider: "filesystem",
      storagePrefix: randomUUID(),
      originDeploymentId: randomUUID(),
      originDeviceId: randomUUID(),
      originKeyId: randomUUID(),
      originPublicKey: randomBytes(32).toString("base64url"),
      redactedSourceLabel: "Fixture"
    });
  const replicaText = async (sessionId: string) => {
    const rows = await receiverPool.query<{ raw_text: string }>(
      "select raw_text from conversation_items where session_id=$1 order by source_sequence",
      [sessionId]
    );
    return rows.rows.map((row) => row.raw_text).join("\n");
  };
  const reverseContext = {
    lifecycle,
    fixture,
    sender: recipient,
    recipient: sender,
    origin: receiver,
    receiver: origin
  };
  return {
    capture,
    append,
    publish,
    receive,
    replicaText,
    reverseContext,
    createMatchingDeletion,
    hasInbox,
    receiveWithWrongRecipient,
    writeSourceJournal,
    writeReplicaItem,
    captureOnReceiver
  };
};
