import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  PDS_PROTOCOL,
  pdsFinalizedStatementHash,
  pdsFinalizedTwoStageRecordHash,
  signPdsGroupDraft,
  signPdsGroupFinal,
  signPdsTwoStageDraft,
  signPdsTwoStageFinal,
  validatePdsGroupStatement,
  validatePdsTombstone
} from "@koed/shared";

const token = () => randomBytes(32).toString("base64url");
const id = () => randomBytes(16).toString("base64url");
const publicKey = (key: ReturnType<typeof generateKeyPairSync>["publicKey"]) =>
  key.export({ format: "jwk" }).x!;

export const createPeerLifecycleFixture = () => {
  const authority = generateKeyPairSync("ed25519");
  const author = generateKeyPairSync("ed25519");
  const recovery = generateKeyPairSync("ed25519");
  const recoveryKem = generateKeyPairSync("x25519");
  const deviceKem = generateKeyPairSync("x25519");
  const groupId = id(),
    authorityKeyId = id(),
    authorKeyId = id(),
    deviceId = id();
  const genesisDraft = {
    protocol: PDS_PROTOCOL,
    kind: "genesis",
    groupId,
    sequence: "1",
    previousHash: null,
    body: {
      authorityKeyId,
      authorityPublicKey: publicKey(authority.publicKey),
      recoverySigningKeyId: id(),
      recoverySigningPublicKey: publicKey(recovery.publicKey),
      recoveryKemKeyId: id(),
      recoveryKemPublicKey: publicKey(recoveryKem.publicKey),
      recoveryKitHash: token(),
      recoveryKitVerified: true,
      initialDeviceId: deviceId,
      initialDeviceSigningKeyId: authorKeyId,
      initialDeviceSigningPublicKey: publicKey(author.publicKey),
      initialDeviceKemKeyId: id(),
      initialDeviceKemPublicKey: publicKey(deviceKem.publicKey),
      operationFamilies: ["pds_relay"],
      initialEpoch: "1",
      initialKeyCommitment: token()
    }
  };
  const genesisAuthorized = {
    draft: genesisDraft,
    authorization: {
      signerKeyId: authorKeyId,
      signature: signPdsGroupDraft(genesisDraft, author.privateKey)
    }
  };
  const genesis = {
    ...genesisAuthorized,
    authority: {
      keyId: authorityKeyId,
      signature: signPdsGroupFinal(genesisAuthorized, authority.privateKey)
    }
  };
  const previousHash = pdsFinalizedStatementHash(genesis);
  const draft = {
    protocol: PDS_PROTOCOL,
    groupId,
    logicalMemoryId: token(),
    sourceFingerprint: token(),
    deletionFloorToken: token(),
    closureHashes: [token()],
    tombstoneSequence: "1",
    statementHash: previousHash,
    activeDeviceSnapshot: [deviceId],
    issuedAt: new Date().toISOString()
  };
  const authorized = {
    draft,
    authorization: {
      signerKeyId: authorKeyId,
      signature: signPdsTwoStageDraft("tombstone", draft, author.privateKey)
    }
  };
  const tombstone = {
    ...authorized,
    authority: {
      keyId: authorityKeyId,
      signature: signPdsTwoStageFinal(
        "tombstone",
        authorized,
        authority.privateKey
      )
    }
  };
  const statementDraft = {
    protocol: PDS_PROTOCOL,
    kind: "tombstone",
    groupId,
    sequence: "2",
    previousHash,
    body: {
      tombstoneHash: pdsFinalizedTwoStageRecordHash(tombstone),
      deletionFloorToken: draft.deletionFloorToken
    }
  };
  const statementAuthorized = {
    draft: statementDraft,
    authorization: {
      signerKeyId: authorKeyId,
      signature: signPdsGroupDraft(statementDraft, author.privateKey)
    }
  };
  const statement = {
    ...statementAuthorized,
    authority: {
      keyId: authorityKeyId,
      signature: signPdsGroupFinal(statementAuthorized, authority.privateKey)
    }
  };
  return {
    genesis,
    tombstone,
    statement,
    expectedGroupId: groupId,
    expectedPreviousHash: previousHash,
    expectedHead: pdsFinalizedStatementHash(statement),
    authorizationPublicKey: publicKey(author.publicKey),
    authorityPublicKey: publicKey(authority.publicKey),
    expectedAuthorizationKeyId: authorKeyId,
    expectedAuthorityKeyId: authorityKeyId,
    floors: [
      {
        logicalMemoryId: draft.logicalMemoryId,
        deletionFloorToken: draft.deletionFloorToken
      }
    ]
  };
};

export const validatePeerLifecycleFixture = (
  fixture: ReturnType<typeof createPeerLifecycleFixture>
) => {
  const keys = {
    authorizationPublicKey: fixture.authorizationPublicKey,
    authorityPublicKey: fixture.authorityPublicKey,
    expectedAuthorizationKeyId: fixture.expectedAuthorizationKeyId,
    expectedAuthorityKeyId: fixture.expectedAuthorityKeyId,
    expectedGroupId: fixture.expectedGroupId
  };
  const genesis = validatePdsGroupStatement(fixture.genesis, {
    ...keys,
    expectedPreviousHash: null,
    expectedSequence: "1"
  });
  if (
    !genesis.authority ||
    pdsFinalizedStatementHash(genesis) !== fixture.expectedPreviousHash
  )
    throw new Error("Invalid genesis head");
  const tombstone = validatePdsTombstone(fixture.tombstone, keys);
  const statement = validatePdsGroupStatement(fixture.statement, {
    ...keys,
    expectedPreviousHash: fixture.expectedPreviousHash,
    expectedSequence: "2"
  });
  if (
    !tombstone.authority ||
    !statement.authority ||
    pdsFinalizedStatementHash(statement) !== fixture.expectedHead ||
    statement.draft.kind !== "tombstone" ||
    tombstone.draft.statementHash !== statement.draft.previousHash
  )
    throw new Error("Invalid lifecycle chain");
  const body = statement.draft.body as {
    tombstoneHash: string;
    deletionFloorToken: string;
  };
  if (
    body.tombstoneHash !== pdsFinalizedTwoStageRecordHash(tombstone) ||
    body.deletionFloorToken !== tombstone.draft.deletionFloorToken
  )
    throw new Error("Invalid tombstone binding");
  const floor = {
    logicalMemoryId: tombstone.draft.logicalMemoryId,
    deletionFloorToken: tombstone.draft.deletionFloorToken
  };
  if (
    fixture.floors.length !== 1 ||
    fixture.floors[0]?.logicalMemoryId !== floor.logicalMemoryId ||
    fixture.floors[0]?.deletionFloorToken !== floor.deletionFloorToken
  )
    throw new Error("Invalid deletion floor");
  return [floor];
};
