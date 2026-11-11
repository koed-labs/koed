import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  type KeyObject
} from "node:crypto";
import {
  PDS_PROTOCOL,
  createPdsAuthorizedKeyBundle,
  decryptPdsKeyBundleSecretSet,
  pdsPublicKeyCommitment,
  pdsFinalizedStatementHash,
  pdsFinalizedTwoStageRecordHash,
  signPdsGroupDraft,
  signPdsGroupFinal,
  signPdsTwoStageDraft,
  signPdsTwoStageFinal,
  validatePdsGroupStatement,
  validatePdsKeyBundle,
  validatePdsTombstone
} from "@koed-labs/shared";

const token = () => randomBytes(32).toString("base64url");
const id = () => randomBytes(16).toString("base64url");
const publicKey = (key: KeyObject) => key.export({ format: "jwk" }).x!;

export const createPeerLifecycleFixture = () => {
  const authority = generateKeyPairSync("ed25519");
  const author = generateKeyPairSync("ed25519");
  const recovery = generateKeyPairSync("ed25519");
  const recoveryKem = generateKeyPairSync("x25519");
  const deviceKem = generateKeyPairSync("x25519");
  const receiver = generateKeyPairSync("ed25519");
  const receiverKem = generateKeyPairSync("x25519");
  const receiverId = id(),
    receiverSigningKeyId = id(),
    receiverKemKeyId = id();
  const deviceKemKeyId = id(),
    recoveryKemKeyId = id();
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
      recoveryKemKeyId,
      recoveryKemPublicKey: publicKey(recoveryKem.publicKey),
      recoveryKitHash: token(),
      recoveryKitVerified: true,
      initialDeviceId: deviceId,
      initialDeviceSigningKeyId: authorKeyId,
      initialDeviceSigningPublicKey: publicKey(author.publicKey),
      initialDeviceKemKeyId: deviceKemKeyId,
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
  const secrets = {
    epochSecret: token(),
    sourceFingerprintKey: token(),
    tombstoneFloorKey: token(),
    projectAliasKey: token()
  };
  const bundle = createPdsAuthorizedKeyBundle({
    groupId,
    epoch: "2",
    transitionKind: "add-device",
    recipients: [
      {
        recipientId: deviceId,
        recipientKind: "device",
        recipientKemKeyId: deviceKemKeyId,
        recipientKemPublicKey: publicKey(deviceKem.publicKey)
      },
      {
        recipientId: receiverId,
        recipientKind: "device",
        recipientKemKeyId: receiverKemKeyId,
        recipientKemPublicKey: publicKey(receiverKem.publicKey)
      },
      {
        recipientId: recoveryKemKeyId,
        recipientKind: "recovery",
        recipientKemKeyId: recoveryKemKeyId,
        recipientKemPublicKey: publicKey(recoveryKem.publicKey)
      }
    ],
    secrets,
    authorizationKeyId: authorKeyId,
    authorizationPrivateKey: author.privateKey
  });
  const admissionDraft = {
    protocol: PDS_PROTOCOL,
    kind: "add-device",
    groupId,
    sequence: "2",
    previousHash: pdsFinalizedStatementHash(genesis),
    body: {
      deviceId: receiverId,
      deviceSigningKeyId: receiverSigningKeyId,
      deviceSigningPublicKey: publicKey(receiver.publicKey),
      deviceKemKeyId: receiverKemKeyId,
      deviceKemPublicKey: publicKey(receiverKem.publicKey),
      operationFamilies: ["pds_relay"],
      previousEpoch: "1",
      nextEpoch: "2",
      keyBundleHash: bundle.authorizationHash
    }
  };
  const admissionAuthorized = {
    draft: admissionDraft,
    authorization: {
      signerKeyId: authorKeyId,
      signature: signPdsGroupDraft(admissionDraft, author.privateKey)
    }
  };
  const admission = {
    ...admissionAuthorized,
    authority: {
      keyId: authorityKeyId,
      signature: signPdsGroupFinal(admissionAuthorized, authority.privateKey)
    }
  };
  const previousHash = pdsFinalizedStatementHash(admission);
  const draft = {
    protocol: PDS_PROTOCOL,
    groupId,
    logicalMemoryId: token(),
    sourceFingerprint: token(),
    deletionFloorToken: token(),
    closureHashes: [token()],
    tombstoneSequence: "1",
    statementHash: previousHash,
    activeDeviceSnapshot: [deviceId, receiverId].sort(),
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
    sequence: "3",
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
    admission,
    bundle,
    secrets,
    identities: {
      authority,
      author,
      recovery,
      recoveryKem,
      deviceKem,
      receiver,
      receiverKem
    },
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

export const createPeerDeletionControl = (
  fixture: ReturnType<typeof createPeerLifecycleFixture>,
  memory: {
    logicalMemoryId: string;
    deletionFloorToken: string;
    sourceFingerprint: string;
    sourceClosureHash: string;
  }
) => {
  const draft = {
    ...fixture.tombstone.draft,
    logicalMemoryId: memory.logicalMemoryId,
    deletionFloorToken: memory.deletionFloorToken,
    sourceFingerprint: memory.sourceFingerprint,
    closureHashes: [memory.sourceClosureHash],
    tombstoneSequence: "2",
    statementHash: fixture.expectedHead
  };
  const authorized = {
    draft,
    authorization: {
      signerKeyId: fixture.expectedAuthorizationKeyId,
      signature: signPdsTwoStageDraft(
        "tombstone",
        draft,
        fixture.identities.author.privateKey
      )
    }
  };
  const tombstone = {
    ...authorized,
    authority: {
      keyId: fixture.expectedAuthorityKeyId,
      signature: signPdsTwoStageFinal(
        "tombstone",
        authorized,
        fixture.identities.authority.privateKey
      )
    }
  };
  const statementDraft = {
    protocol: PDS_PROTOCOL,
    kind: "tombstone",
    groupId: fixture.expectedGroupId,
    sequence: "4",
    previousHash: fixture.expectedHead,
    body: {
      tombstoneHash: pdsFinalizedTwoStageRecordHash(tombstone),
      deletionFloorToken: draft.deletionFloorToken
    }
  };
  const signed = {
    draft: statementDraft,
    authorization: {
      signerKeyId: fixture.expectedAuthorizationKeyId,
      signature: signPdsGroupDraft(
        statementDraft,
        fixture.identities.author.privateKey
      )
    }
  };
  return {
    tombstone,
    statement: {
      ...signed,
      authority: {
        keyId: fixture.expectedAuthorityKeyId,
        signature: signPdsGroupFinal(
          signed,
          fixture.identities.authority.privateKey
        )
      }
    }
  };
};

export const validatePeerDeletionControl = (
  fixture: ReturnType<typeof createPeerLifecycleFixture>,
  control: ReturnType<typeof createPeerDeletionControl>
) => {
  validatePeerLifecycleFixture(fixture);
  const keys = {
    authorizationPublicKey: fixture.authorizationPublicKey,
    authorityPublicKey: fixture.authorityPublicKey,
    expectedAuthorizationKeyId: fixture.expectedAuthorizationKeyId,
    expectedAuthorityKeyId: fixture.expectedAuthorityKeyId,
    expectedGroupId: fixture.expectedGroupId
  };
  const tombstone = validatePdsTombstone(control.tombstone, keys);
  const statement = validatePdsGroupStatement(control.statement, {
    ...keys,
    expectedPreviousHash: fixture.expectedHead,
    expectedSequence: "4"
  });
  const body = control.statement.draft.body;
  if (
    !tombstone.authority ||
    !statement.authority ||
    statement.draft.kind !== "tombstone" ||
    tombstone.draft.statementHash !== fixture.expectedHead ||
    body.tombstoneHash !== pdsFinalizedTwoStageRecordHash(tombstone) ||
    body.deletionFloorToken !== tombstone.draft.deletionFloorToken ||
    tombstone.draft.tombstoneSequence !== "2" ||
    JSON.stringify(tombstone.draft.activeDeviceSnapshot) !==
      JSON.stringify(fixture.tombstone.draft.activeDeviceSnapshot)
  )
    throw new Error("Invalid deletion control");
  return {
    logicalMemoryId: tombstone.draft.logicalMemoryId,
    deletionFloorToken: tombstone.draft.deletionFloorToken
  };
};

export const validatePeerLifecycleFixture = (
  fixture: ReturnType<typeof createPeerLifecycleFixture>
) => {
  const identities = fixture.identities;
  const genesisBody = fixture.genesis.draft.body;
  const admissionBody = fixture.admission.draft.body;
  const bindings = [
    [identities.authority, genesisBody.authorityPublicKey],
    [identities.author, genesisBody.initialDeviceSigningPublicKey],
    [identities.recovery, genesisBody.recoverySigningPublicKey],
    [identities.recoveryKem, genesisBody.recoveryKemPublicKey],
    [identities.deviceKem, genesisBody.initialDeviceKemPublicKey],
    [identities.receiver, admissionBody.deviceSigningPublicKey],
    [identities.receiverKem, admissionBody.deviceKemPublicKey]
  ] as const;
  for (const [identity, expected] of bindings) {
    if (
      publicKey(identity.publicKey) !== expected ||
      publicKey(createPublicKey(identity.privateKey)) !== expected
    )
      throw new Error("Identity key does not match lifecycle");
  }
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
  if (!genesis.authority) throw new Error("Invalid genesis");
  const admission = validatePdsGroupStatement(fixture.admission, {
    ...keys,
    expectedPreviousHash: pdsFinalizedStatementHash(genesis),
    expectedSequence: "2"
  });
  const recipients = [
    {
      recipientId: genesisBody.initialDeviceId,
      recipientKind: "device" as const,
      recipientKemKeyId: genesisBody.initialDeviceKemKeyId,
      publicKey: genesisBody.initialDeviceKemPublicKey,
      identity: identities.deviceKem
    },
    {
      recipientId: admissionBody.deviceId,
      recipientKind: "device" as const,
      recipientKemKeyId: admissionBody.deviceKemKeyId,
      publicKey: admissionBody.deviceKemPublicKey,
      identity: identities.receiverKem
    },
    {
      recipientId: genesisBody.recoveryKemKeyId,
      recipientKind: "recovery" as const,
      recipientKemKeyId: genesisBody.recoveryKemKeyId,
      publicKey: genesisBody.recoveryKemPublicKey,
      identity: identities.recoveryKem
    }
  ];
  const bundle = validatePdsKeyBundle(fixture.bundle.bundle, {
    ...keys,
    expectedRecipients: recipients.map((recipient) => ({
      recipientId: recipient.recipientId,
      recipientKind: recipient.recipientKind,
      recipientKemKeyId: recipient.recipientKemKeyId,
      recipientKemPublicKeyCommitment: pdsPublicKeyCommitment(
        recipient.publicKey
      )
    }))
  });
  if (
    bundle.draft.groupId !== fixture.expectedGroupId ||
    bundle.draft.epoch !== "2" ||
    bundle.draft.transitionKind !== "add-device"
  )
    throw new Error("Invalid bundle transition");
  for (const recipient of recipients) {
    const recovered = decryptPdsKeyBundleSecretSet({
      bundle: fixture.bundle.bundle,
      authorizationPublicKey: fixture.authorizationPublicKey,
      authorityPublicKey: fixture.authorityPublicKey,
      recipientId: recipient.recipientId,
      recipientKemKeyId: recipient.recipientKemKeyId,
      recipientKemPublicKey: recipient.publicKey,
      recipientKemPrivateSeed: recipient.identity.privateKey.export({
        format: "jwk"
      }).d!
    });
    for (const key of [
      "epochSecret",
      "sourceFingerprintKey",
      "tombstoneFloorKey",
      "projectAliasKey"
    ] as const)
      if (recovered[key] !== fixture.secrets[key])
        throw new Error("Bundle secrets do not match");
  }
  if (
    !admission.authority ||
    pdsFinalizedStatementHash(admission) !== fixture.expectedPreviousHash ||
    fixture.admission.draft.body.keyBundleHash !== bundle.authorizationHash ||
    fixture.bundle.authorizationHash !== bundle.authorizationHash ||
    fixture.genesis.draft.body.initialDeviceSigningPublicKey !==
      fixture.authorizationPublicKey ||
    fixture.genesis.draft.body.authorityPublicKey !== fixture.authorityPublicKey
  )
    throw new Error("Invalid admission head");
  const tombstone = validatePdsTombstone(fixture.tombstone, keys);
  const statement = validatePdsGroupStatement(fixture.statement, {
    ...keys,
    expectedPreviousHash: fixture.expectedPreviousHash,
    expectedSequence: "3"
  });
  if (
    !tombstone.authority ||
    !statement.authority ||
    pdsFinalizedStatementHash(statement) !== fixture.expectedHead ||
    statement.draft.kind !== "tombstone" ||
    tombstone.draft.statementHash !== statement.draft.previousHash
  )
    throw new Error("Invalid lifecycle chain");
  const expectedSnapshot = [
    fixture.genesis.draft.body.initialDeviceId,
    fixture.admission.draft.body.deviceId
  ].sort();
  if (
    JSON.stringify(tombstone.draft.activeDeviceSnapshot) !==
    JSON.stringify(expectedSnapshot)
  )
    throw new Error("Invalid tombstone membership snapshot");
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
