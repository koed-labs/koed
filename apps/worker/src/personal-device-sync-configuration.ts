import { randomBytes, randomUUID, type KeyObject } from "node:crypto";
import type { PersonalConfigurationRepository } from "@koed/db";
import {
  PERSONAL_CONFIGURATION_PROTOCOL,
  canonicalizePdsJson,
  parseCanonicalPdsJson,
  signPersonalConfigurationRecord,
  verifyPersonalConfigurationRecord,
  personalConfigurationRecordSchema,
  personalConfigurationRecordHash,
  personalConfigurationPackageId,
  encodePdsPersonalSourceContextSnapshot,
  encodePdsPersonalMembershipEntitySnapshot,
  type PersonalConfigurationFeature,
  type PersonalConfigurationPayload,
  createPdsEncryptedPayloadPackage,
  requirePdsConfigurationCapability,
  decryptEnvelopeToUtf8,
  PdsConfigurationCompatibilityError,
  type EnvelopeEncryptionProvider,
  type EncryptedPayloadEnvelope,
  type PersonalConfigurationRecord,
  type PdsSessionPackageRuntimeContext,
  type PdsRelayClient,
  type PdsSessionPackage
} from "@koed/shared";

type Scope = {
  userId: string;
  groupId: string;
  originDeploymentId: string;
  activeCertificates: readonly string[];
};
export const createPdsConfigurationRuntime = (
  input: Scope & {
    repository: PersonalConfigurationRepository;
    runtime: PdsSessionPackageRuntimeContext;
    signingKey: KeyObject;
    relay: () => PdsRelayClient;
    encryption: EnvelopeEncryptionProvider;
  }
) => {
  const workerId = `configuration-${randomUUID()}`,
    runtime = input.runtime;
  const authority = {
    groupId: input.groupId,
    authorityHead: runtime.authorityHead,
    currentEpoch: runtime.epoch,
    authorityPublicKey:
      typeof runtime.authorityPublicKey === "string"
        ? runtime.authorityPublicKey
        : runtime.authorityPublicKey.toString("base64url"),
    authorityKeyId: runtime.authorityKeyId,
    activeCertificates: input.activeCertificates
  };
  const scope = {
    userId: input.userId,
    groupId: input.groupId,
    authorDeviceId: runtime.recipient.deviceId,
    authorSigningKeyId: runtime.recipient.signingKeyId,
    expectedEpoch: runtime.epoch,
    expectedAuthorityHead: runtime.authorityHead,
    localDevice: {
      deviceId: runtime.recipient.deviceId,
      signingKeyId: runtime.recipient.signingKeyId,
      originatingDeploymentId: input.originDeploymentId
    }
  };
  let advertisedAt = 0,
    afterSessionId: string | undefined,
    afterProjectId: string | undefined,
    afterViewProjectIdentity: string | undefined,
    afterInclusionId: string | undefined,
    afterRuleId: string | undefined,
    afterExclusionId: string | undefined,
    afterRuleEntity:
      | { projectIdentity: string; entityIdentity: string }
      | undefined,
    afterExclusionEntity:
      | { projectIdentity: string; entityIdentity: string }
      | undefined,
    afterMembershipEntity:
      | { projectIdentity: string; entityIdentity: string }
      | undefined,
    afterPendingId: string | undefined;
  const encryptRecord = async (record: PersonalConfigurationRecord) => {
    const hash = personalConfigurationRecordHash(record);
    return input.encryption.encrypt({
      plaintext: canonicalizePdsJson(record),
      scope: {
        tenantId: input.userId,
        objectClass: "personal_configuration_record"
      },
      provenance: {
        rowFamily: "personal_configuration_records",
        sourceTable: "personal_configuration_records",
        sourceId: hash
      },
      ciphertextLocation: "personal_configuration_records",
      aad: {
        ownerUserId: input.userId,
        groupId: input.groupId,
        recordHash: hash
      }
    });
  };
  const readRecord = async (encryptedEnvelope: unknown, hash: string) => {
    const envelope = encryptedEnvelope as EncryptedPayloadEnvelope;
    if (
      envelope?.scope?.tenantId !== input.userId ||
      envelope.aad?.ownerUserId !== input.userId ||
      envelope.aad?.groupId !== input.groupId ||
      envelope.aad?.recordHash !== hash
    )
      throw new TypeError("PdsCryptoConfigurationArchiveIdentityError");
    const record = personalConfigurationRecordSchema.parse(
      parseCanonicalPdsJson(
        await decryptEnvelopeToUtf8(input.encryption, envelope)
      )
    );
    if (personalConfigurationRecordHash(record) !== hash)
      throw new TypeError("PdsCryptoConfigurationArchiveIdentityError");
    const author = runtime.recipients.find(
      (member) => member.deviceId === record.revision.authorDeviceId
    );
    if (!author)
      throw new TypeError("PdsCryptoConfigurationAuthorAuthorityError");
    return verifyPersonalConfigurationRecord(record, {
      groupId: input.groupId,
      deviceId: author.deviceId,
      signingKeyId: author.signingKeyId,
      publicKey: author.signingPublicKey
    });
  };
  const refreshCapabilities = async () => {
    if (Date.now() - advertisedAt < 60_000) return;
    await input
      .relay()
      .advertiseConfigurationCapabilities([
        "source_context_v1",
        "project_membership_v1"
      ]);
    advertisedAt = Date.now();
  };
  return {
    refreshCapabilities,
    async requireSourceContextRecipients() {
      requirePdsConfigurationCapability({
        ...authority,
        records: await input.relay().configurationCapabilities(),
        feature: "source_context_v1",
        intendedRecipientDeviceIds: runtime.recipients
          .filter((member) => member.deviceId !== runtime.recipient.deviceId)
          .map((member) => member.deviceId)
      });
    },
    async retainVerified(record: PersonalConfigurationRecord) {
      const encryptedEnvelope = await encryptRecord(record);
      return input.repository.retainPersonalConfiguration({
        ...scope,
        record,
        encryptedEnvelope,
        direction: "inbound"
      });
    },
    async reconcile() {
      try {
        const relay = input.relay();
        // Capability refresh does not depend on direct peer routes or a local relay endpoint.
        await refreshCapabilities();
        const pending = await input.repository.listPendingPersonalConfiguration(
          {
            ...scope,
            afterId: afterPendingId,
            limit: 50
          }
        );
        for (const entry of pending) {
          afterPendingId = entry.id;
          try {
            const record = await readRecord(
              entry.encryptedEnvelope,
              entry.recordHash
            );
            const result = await input.repository.retainPersonalConfiguration({
              ...scope,
              record,
              encryptedEnvelope: entry.encryptedEnvelope,
              direction: "inbound"
            });
            if (!result.applied)
              await input.repository.deferPendingPersonalConfiguration({
                ...scope,
                id: entry.id,
                recordHash: entry.recordHash
              });
          } catch {
            // Retain pending encrypted evidence. Another entry must not depend on its arrival or validity.
            await input.repository.deferPendingPersonalConfiguration({
              ...scope,
              id: entry.id,
              recordHash: entry.recordHash
            });
          }
        }
        if (pending.length < 50) afterPendingId = undefined;
        const views =
          await input.repository.reconcilePersonalConfigurationMembershipViews({
            ...scope,
            originatingDeploymentId: input.originDeploymentId,
            afterProjectIdentity: afterViewProjectIdentity,
            limit: 50
          });
        afterViewProjectIdentity = views.nextProjectIdentity ?? undefined;
        const capabilities = await relay.configurationCapabilities();
        const requireRecipients = (feature: PersonalConfigurationFeature) =>
          requirePdsConfigurationCapability({
            ...authority,
            records: capabilities,
            feature,
            intendedRecipientDeviceIds: runtime.recipients
              .filter(
                (member) => member.deviceId !== runtime.recipient.deviceId
              )
              .map((member) => member.deviceId)
          });
        const supported = (feature: PersonalConfigurationFeature) => {
          try {
            requireRecipients(feature);
            return true;
          } catch (error) {
            if (error instanceof PdsConfigurationCompatibilityError)
              return false;
            throw error;
          }
        };
        let staged = 0,
          more = Boolean(views.nextProjectIdentity);
        const stage = async (payload: PersonalConfigurationPayload) => {
          const record = signPersonalConfigurationRecord(
            {
              protocol: PERSONAL_CONFIGURATION_PROTOCOL,
              groupId: input.groupId,
              authorDeviceId: runtime.recipient.deviceId,
              authorSigningKeyId: runtime.recipient.signingKeyId,
              payload
            },
            input.signingKey
          );
          if (
            await input.repository.hasLocalPersonalConfiguration({
              ...scope,
              recordHash: personalConfigurationRecordHash(record)
            })
          )
            return;
          const retained = await input.repository.retainPersonalConfiguration({
            ...scope,
            record,
            encryptedEnvelope: await encryptRecord(record),
            direction: "local"
          });
          if (retained.applied) staged++;
        };
        if (supported("source_context_v1")) {
          const page =
            await input.repository.listPersonalConfigurationSourceSnapshots({
              ...scope,
              originatingDeploymentId: input.originDeploymentId,
              afterSessionId,
              limit: 50
            });
          afterSessionId = page.nextSessionId ?? undefined;
          more ||= Boolean(page.nextSessionId);
          for (const snapshot of page.snapshots)
            await stage({
              kind: "source_context",
              snapshot: encodePdsPersonalSourceContextSnapshot(snapshot)
            });
        }
        if (supported("project_membership_v1")) {
          const catalog =
            await input.repository.listPersonalConfigurationCatalogSnapshots({
              ...scope,
              originatingDeploymentId: input.originDeploymentId,
              afterProjectId,
              limit: 50
            });
          afterProjectId = catalog.nextProjectId ?? undefined;
          const direct =
            await input.repository.listPersonalConfigurationDirectSnapshots({
              ...scope,
              originatingDeploymentId: input.originDeploymentId,
              afterInclusionId,
              afterEntity: afterMembershipEntity,
              limit: 50
            });
          afterInclusionId = direct.nextInclusionId ?? undefined;
          afterMembershipEntity = direct.nextEntity ?? undefined;
          more ||= Boolean(
            catalog.nextProjectId || direct.nextInclusionId || direct.nextEntity
          );
          const rules =
            await input.repository.listPersonalConfigurationRuleSnapshots({
              ...scope,
              originatingDeploymentId: input.originDeploymentId,
              afterNativeId: afterRuleId,
              afterEntity: afterRuleEntity,
              limit: 50
            });
          const exclusions =
            await input.repository.listPersonalConfigurationExclusionSnapshots({
              ...scope,
              originatingDeploymentId: input.originDeploymentId,
              afterNativeId: afterExclusionId,
              afterEntity: afterExclusionEntity,
              limit: 50
            });
          afterRuleId = rules.nextNativeId ?? undefined;
          afterRuleEntity = rules.nextEntity ?? undefined;
          afterExclusionId = exclusions.nextNativeId ?? undefined;
          afterExclusionEntity = exclusions.nextEntity ?? undefined;
          more ||= Boolean(
            rules.nextNativeId ||
            rules.nextEntity ||
            exclusions.nextNativeId ||
            exclusions.nextEntity
          );
          for (const snapshot of [
            ...catalog.snapshots,
            ...direct.snapshots,
            ...rules.snapshots,
            ...exclusions.snapshots
          ])
            await stage({
              kind: "project_membership",
              snapshot: encodePdsPersonalMembershipEntitySnapshot(snapshot)
            });
        }
        const claimed =
          await input.repository.claimPersonalConfigurationDelivery({
            ...scope,
            workerId,
            limit: 20
          });
        for (const entry of claimed) {
          const lease = { workerId, outboxId: entry.id };
          try {
            if (
              !(await input.repository.beginPersonalConfigurationDelivery({
                ...scope,
                ...lease
              }))
            ) {
              await input.repository.settlePersonalConfigurationDelivery({
                ...lease,
                state: entry.state,
                transportId: entry.transportId ?? undefined,
                retryAt: new Date(Date.now() + 30_000)
              });
              continue;
            }
            if (entry.state === "committed" && entry.transportId) {
              try {
                const response = (await relay.transport(entry.transportId)) as {
                  transport?: {
                    transportId?: unknown;
                    deliveryState?: unknown;
                  };
                };
                if (
                  response.transport?.transportId !== entry.transportId ||
                  !["pending", "acked"].includes(
                    String(response.transport.deliveryState)
                  )
                )
                  throw new TypeError(
                    "PdsCryptoConfigurationTransportIdentityError"
                  );
                await input.repository.settlePersonalConfigurationDelivery({
                  ...lease,
                  state:
                    response.transport.deliveryState === "acked"
                      ? "acked"
                      : "committed",
                  transportId: entry.transportId,
                  retryAt: new Date(Date.now() + 30_000)
                });
                continue;
              } catch (error) {
                if (
                  !(error instanceof Error) ||
                  error.name !== "PdsRelayNotFoundError"
                )
                  throw error;
              }
            }
            const record = await readRecord(
              entry.encryptedEnvelope,
              entry.recordHash
            );
            if (
              record.revision.authorDeviceId !== runtime.recipient.deviceId ||
              record.revision.authorSigningKeyId !==
                runtime.recipient.signingKeyId
            )
              throw new TypeError("PdsCryptoConfigurationAuthorAuthorityError");
            const transportId = randomBytes(32).toString("base64url");
            const pkg: PdsSessionPackage = createPdsEncryptedPayloadPackage({
              runtime,
              expiresAt: new Date(
                Date.now() + 24 * 60 * 60 * 1000
              ).toISOString(),
              servingSigningPrivateKey: input.signingKey,
              transportId,
              packageId: personalConfigurationPackageId(
                entry.recordHash,
                transportId
              ),
              manifestHash: entry.recordHash,
              originDeviceId: runtime.recipient.deviceId,
              contentEpoch: runtime.epoch,
              plaintext: canonicalizePdsJson(record)
            });
            // Recheck current authority immediately before publication after archive decryption.
            if (
              !(await input.repository.beginPersonalConfigurationDelivery({
                ...scope,
                ...lease
              }))
            )
              throw new Error("PdsConfigurationLifecycleChangedError");
            requireRecipients(
              record.revision.payload.kind === "source_context"
                ? "source_context_v1"
                : "project_membership_v1"
            );
            const committed = await relay.upload(pkg);
            await input.repository.settlePersonalConfigurationDelivery({
              ...lease,
              state: committed.deliveryState,
              transportId: committed.transportId,
              retryAt: new Date(Date.now() + 30_000)
            });
          } catch {
            await input.repository.settlePersonalConfigurationDelivery({
              ...lease,
              state: "pending",
              retryAt: new Date(
                Date.now() +
                  Math.min(300_000, 1000 * 2 ** Math.min(entry.attemptCount, 8))
              )
            });
          }
        }
        return claimed.length >= 20 || more ? 50 : Math.min(staged, 19);
      } catch (error) {
        await input.repository.deferPersonalConfigurationDelivery(scope);
        throw error;
      }
    }
  };
};
