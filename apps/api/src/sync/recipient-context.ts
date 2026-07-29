import {
  generateRecipientKeyMaterial,
  toRecipientPublicKeyMaterial
} from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";

export const resolveSyncRecipientContext = async (
  context: ApiRouteContext,
  allowedProfiles: ReadonlySet<string>
) => {
  if (!allowedProfiles.has(context.config.deploymentProfile)) {
    throw Object.assign(new Error("Sync intake is unavailable"), {
      statusCode: 404
    });
  }
  const identity = context.deploymentIdentity.inspect();
  if (
    identity.health !== "healthy" ||
    !identity.remoteOperationsAllowed ||
    !identity.deploymentId
  ) {
    throw Object.assign(
      new Error("Local deployment identity is not verified"),
      {
        statusCode: 424
      }
    );
  }
  const rootProvider = context.encryption.envelopeEncryptionProvider;
  if (
    !rootProvider?.status ||
    (await rootProvider.status()).status !== "available"
  ) {
    throw Object.assign(
      new Error("Envelope encryption provider is required for sync"),
      { statusCode: 503 }
    );
  }
  const repository = context.requireRepository();
  const localDeployment = await repository.ensureLocalSyncDeployment({
    profile: context.config.deploymentProfile,
    protocolDeploymentId: identity.deploymentId
  });
  let recipient = await repository.getActiveSyncRecipientKey(
    localDeployment.id
  );
  if (!recipient) {
    recipient = await repository.ensureSyncRecipientKey({
      deploymentIdentityId: localDeployment.id,
      material: await generateRecipientKeyMaterial(rootProvider, {
        keyId: `sync-recipient:${localDeployment.protocolDeploymentId}`,
        keyVersion: 1,
        scope: {
          deploymentId: localDeployment.protocolDeploymentId,
          objectClass: "sync_recipient_key"
        },
        provenance: {
          rowFamily: "sync_recipient_key",
          sourceId: localDeployment.id
        }
      })
    });
  }
  return {
    identity,
    rootProvider,
    localDeployment,
    recipient,
    publicRecipient: toRecipientPublicKeyMaterial(recipient)
  };
};
