import type pg from "pg";
import {
  decryptEnvelopeToUtf8,
  teamRepositorySnapshotSchema,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider,
  type TeamRepositorySnapshot
} from "@koed/shared";

type Binding = {
  sessionId: string;
  ownerUserId: string;
  ownerPrincipalId: string;
};
const aadFor = (binding: Binding) => ({
  ...binding,
  encryptionScope: "owner_private_replica",
  sourceColumn: "repository_snapshot"
});

export const writeOwnerPrivateRepositorySnapshot = async (
  client: pg.PoolClient,
  provider: EnvelopeEncryptionProvider,
  binding: Binding,
  input: TeamRepositorySnapshot
): Promise<void> => {
  const snapshot = teamRepositorySnapshotSchema.parse(input);
  const envelope =
    snapshot.label !== null || snapshot.branchObservation !== null
      ? await provider.encrypt({
          plaintext: JSON.stringify(snapshot),
          scope: { objectClass: "owner_private_replica" },
          provenance: {
            rowFamily: "sessions",
            sourceTable: "sessions",
            sourceId: binding.sessionId,
            sourceColumn: "repository_snapshot"
          },
          ciphertextLocation:
            "sessions.metadata.repositorySnapshotMetadataEnvelope",
          aad: aadFor(binding)
        })
      : null;
  await client.query(
    `update sessions set metadata=(metadata-'repositorySnapshotMetadataEnvelope') || $3::jsonb,
      updated_at=now() where id=$1 and owner_user_id=$2`,
    [
      binding.sessionId,
      binding.ownerUserId,
      JSON.stringify({
        repositorySnapshot: {
          ...snapshot,
          label: null,
          branchObservation: null
        },
        ...(envelope ? { repositorySnapshotMetadataEnvelope: envelope } : {})
      })
    ]
  );
};

export const readOwnerPrivateRepositorySnapshotMetadata = async (
  provider: EnvelopeEncryptionProvider,
  binding: Binding,
  value: unknown,
  routing: TeamRepositorySnapshot
): Promise<TeamRepositorySnapshot> => {
  if (!value || typeof value !== "object")
    throw new Error("Owner-private repository metadata is unavailable");
  const envelope = value as EncryptedPayloadEnvelope;
  if (
    envelope.provenance?.sourceId !== binding.sessionId ||
    envelope.provenance?.sourceTable !== "sessions" ||
    envelope.provenance?.sourceColumn !== "repository_snapshot" ||
    Object.entries(aadFor(binding)).some(
      ([key, expected]) => envelope.aad?.[key] !== expected
    )
  )
    throw new Error("Owner-private repository metadata binding changed");
  const snapshot = teamRepositorySnapshotSchema.parse(
    JSON.parse(await decryptEnvelopeToUtf8(provider, envelope))
  );
  if (
    snapshot.classification !== routing.classification ||
    snapshot.fingerprint !== routing.fingerprint
  )
    throw new Error("Owner-private repository routing and metadata disagree");
  return snapshot;
};
