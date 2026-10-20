import { createHash, randomUUID } from "node:crypto";
import {
  canonicalizePdsJson,
  createPdsSessionManifest,
  createPdsSessionPackage,
  createPdsRepositoryAssignmentFromSourceContext,
  verifyAndDecryptPdsSessionSourcePackage,
  isPdsSessionCheckpointManifest,
  verifyPdsRepositoryAssignmentWithKeyHistory,
  type EnvelopeEncryptionProvider,
  type PersonalSourceContextSnapshot,
  type PdsSessionPackage
} from "@koed/shared";
import type { MemorySourceRepository } from "../../src/index.js";
import { materializePdsSession } from "../../../../apps/worker/src/personal-device-sync-runtime.js";
import type { PersonalSourceDeviceFixture } from "./personal-source-device.js";

/** Signed immutable source input, independent from membership configuration. */
export const personalFixtureClosedSource = (input: {
  fixture: PersonalSourceDeviceFixture;
  snapshot: PersonalSourceContextSnapshot;
  externalSessionId: string;
  content: string;
  sequence?: string;
}) => {
  const { fixture, snapshot } = input,
    now = new Date().toISOString();
  const manifest = createPdsSessionManifest({
    runtime: fixture.runtime(fixture.origin),
    originDeploymentId: fixture.origin.deploymentId,
    sourceSequence: input.sequence ?? "1",
    sourceNativeSessionId: input.externalSessionId,
    contentEpoch: fixture.epoch,
    sourceContext: snapshot,
    repositoryAssignment: createPdsRepositoryAssignmentFromSourceContext(
      snapshot.context,
      fixture.epoch,
      fixture.projectAliasKey
    ),
    closedSession: {
      closed: true,
      logicalSessionId: snapshot.context.source.logicalSessionId,
      externalSessionId: input.externalSessionId,
      sourceAdapter: "codex",
      sourceAdapterVersion: "codex-transcript-v1",
      captureMethod: "transcript",
      sourceCreatedAt: now,
      sourceClosedAt: now,
      observedClosedAt: now
    },
    terminalCursor: "2",
    items: ["agent_message", "task_complete"].map((type, index) => ({
      sourceNativeItemId: `item-${randomUUID()}`,
      sequence: String(index),
      sourceTimestamp: now,
      observedAt: now,
      actor: "agent",
      type,
      content: input.content,
      metadata: {}
    })),
    sourceFingerprintKey: fixture.sourceFingerprintKey,
    tombstoneFloorKey: fixture.tombstoneFloorKey,
    originSigningPrivateKey: fixture.origin.signing.privateKey
  });
  return createPdsSessionPackage({
    runtime: fixture.runtime(fixture.origin),
    manifest,
    servingSigningPrivateKey: fixture.origin.signing.privateKey,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString()
  });
};

/** Run real crypto verification, retained-package receipt, and both materialization phases. */
export const receivePersonalFixtureClosedSource = async (input: {
  fixture: PersonalSourceDeviceFixture;
  repository: MemorySourceRepository;
  receiverUserId: string;
  encryption: EnvelopeEncryptionProvider;
  pkg: PdsSessionPackage;
  beforeAvailable?: (sessionId: string) => Promise<void>;
}) => {
  const { fixture, repository: repo, pkg } = input;
  const manifest = verifyAndDecryptPdsSessionSourcePackage(
    canonicalizePdsJson(pkg),
    {
      runtime: fixture.runtime(fixture.origin, fixture.receiver),
      recipientKemPrivateKey: fixture.receiver.kem.privateSeed
    }
  );
  if (isPdsSessionCheckpointManifest(manifest) || !manifest.sourceContext)
    throw new Error("Expected closed verified source context");
  const logicalSessionId = manifest.closedSession.logicalSessionId,
    workerId = randomUUID();
  await repo.receivePdsInbox({
    userId: input.receiverUserId,
    groupId: fixture.groupId,
    packageId: manifest.packageId,
    sourceManifestHash: pkg.header.sourceManifestHash
  });
  const inbox = (await repo.claimPdsInbox({ workerId, limit: 100 })).find(
    (entry) => entry.packageId === manifest.packageId
  );
  if (!inbox) throw new Error("Missing fixture inbox");
  const retained = await repo.retainPdsInboundPackage({
    userId: input.receiverUserId,
    groupId: fixture.groupId,
    inboxId: inbox.id,
    packageId: manifest.packageId,
    sourceManifestHash: pkg.header.sourceManifestHash,
    sourceLogicalSessionId: logicalSessionId,
    sourceContextHash: createHash("sha256")
      .update(canonicalizePdsJson(manifest.sourceContext))
      .digest("base64url"),
    originDeploymentId: manifest.originDeploymentId,
    originDeviceId: manifest.originDeviceId,
    sourceSequence: manifest.sourceSequence,
    logicalMemoryId: manifest.logicalMemoryId,
    deletionFloorToken: manifest.deletionFloorToken,
    sourceFingerprint: manifest.sourceFingerprint,
    sourceClosureHash: manifest.sourceClosureHash,
    encryptedEnvelope: await input.encryption.encrypt({
      plaintext: canonicalizePdsJson(pkg),
      scope: { tenantId: input.receiverUserId },
      provenance: { rowFamily: "pds_retained_packages" },
      ciphertextLocation: "fixture"
    })
  });
  const assignment = verifyPdsRepositoryAssignmentWithKeyHistory(
    manifest.repositoryAssignment,
    manifest.contentEpoch,
    { currentEpoch: fixture.epoch, projectKey: fixture.projectAliasKey }
  );
  const session = await materializePdsSession(
    repo,
    input.receiverUserId,
    fixture.groupId,
    manifest,
    assignment,
    retained.retainedPackageId
  );
  await input.beforeAvailable?.(session.id);
  const result = await repo.materializePdsReplica({
    workerId,
    inboxId: inbox.id,
    userId: input.receiverUserId,
    groupId: fixture.groupId,
    retainedPackageId: retained.retainedPackageId,
    localSessionId: session.id,
    sourceItemIds: session.itemIds,
    sourceFingerprint: manifest.sourceFingerprint,
    closureHash: manifest.sourceClosureHash,
    originDeploymentId: manifest.originDeploymentId,
    originDeviceId: manifest.originDeviceId,
    sourceSequence: manifest.sourceSequence,
    sourceClosedAt: new Date(manifest.closedSession.sourceClosedAt),
    observedAt: new Date(),
    closedProfileTransition: manifest.profileTransition,
    pdsRepositoryAssignment: manifest.repositoryAssignment,
    sourceLogicalSessionId: logicalSessionId,
    sourceContext: manifest.sourceContext
  });
  if (result.conflict)
    throw new Error("Fixture source unexpectedly conflicted");
  await repo.completePdsInbox({
    workerId,
    inboxId: inbox.id,
    retainedPackageId: retained.retainedPackageId,
    state: "ready"
  });
  return session;
};
