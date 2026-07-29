import { createHash } from "node:crypto";

export const FIXTURE_VERSION = "team-saas-fixture-v1";
export const FIXTURE_SOURCE_HASH_PREFIX = `${FIXTURE_VERSION}:`;

const fixtureHash = (value) =>
  createHash("sha256").update(`${FIXTURE_VERSION}:${value}`).digest("hex");

const fixtureUuid = (value) => {
  const hex = fixtureHash(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(
    13,
    16
  )}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
};

const canonicalJson = (value) => JSON.stringify(canonicalize(value));
const collaborationHash = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const collaborationHashDomain = (domain, value) =>
  collaborationHash(`koed:collaboration:${domain}:v1\n${value}`);
const collaborationUuid = (value) => {
  const hex = collaborationHash(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(
    13,
    16
  )}-${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(
    17,
    20
  )}-${hex.slice(20, 32)}`;
};

const ALL_REPRESENTATIONS = ["memory_events", "lcm_leaves", "lcm_rollups"];

const FIXTURE_OWNER_ENCRYPTION_KEY = Buffer.alloc(32, 71).toString("base64");
const FIXTURE_TEAM_ENCRYPTION_KEY = Buffer.alloc(32, 72).toString("base64");
const FIXTURE_STATE_AT = "2026-01-01T08:00:00.000Z";
export const FIXTURE_SESSION_EXPIRES_AT = "2099-01-01T00:00:00.000Z";

export const assertFixtureEnvironment = (environment = process.env) => {
  const nodeEnvironment = environment.NODE_ENV?.trim().toLowerCase() ?? "";
  const deploymentProfile =
    environment.KOED_DEPLOYMENT_PROFILE?.trim().toLowerCase() ?? "";
  const isTest = nodeEnvironment === "test";
  const isLocalFixture =
    (nodeEnvironment === "" || nodeEnvironment === "development") &&
    (deploymentProfile === "" || deploymentProfile === "developer");
  if (!isTest && !isLocalFixture) {
    throw new Error(
      "Team SaaS fixture credentials are local-only test bearers; use NODE_ENV=test or a non-production developer profile"
    );
  }
};

export const fixtureUsers = {
  alice: {
    id: "10000000-0000-4000-8000-000000000001",
    email: "alice.fixture@koed.ai",
    displayName: "Alice Morgan",
    role: "owner"
  },
  bob: {
    id: "10000000-0000-4000-8000-000000000002",
    email: "bob.fixture@koed.ai",
    displayName: "Bob Rivera",
    role: "member"
  },
  carol: {
    id: "10000000-0000-4000-8000-000000000003",
    email: "carol.fixture@koed.ai",
    displayName: "Carol Chen",
    role: "admin"
  },
  david: {
    id: "10000000-0000-4000-8000-000000000004",
    email: "david.fixture@koed.ai",
    displayName: "David Patel",
    role: "member"
  },
  dana: {
    id: "10000000-0000-4000-8000-000000000005",
    email: "dana.fixture@koed.ai",
    displayName: "Dana Foster",
    role: "member",
    disabled: true
  },
  erin: {
    id: "10000000-0000-4000-8000-000000000006",
    email: "erin.fixture@koed.ai",
    displayName: "Erin Singh",
    role: "member"
  },
  frank: {
    id: "10000000-0000-4000-8000-000000000007",
    email: "frank.fixture@koed.ai",
    displayName: "Frank Wilson",
    role: null,
    removed: true
  }
};

export const fixtureTeamMemberships = [
  ["alice", "owner", "enabled"],
  ["bob", "member", "enabled"],
  ["carol", "admin", "enabled"],
  ["david", "member", "enabled"],
  ["dana", "member", "disabled"],
  ["erin", "member", "enabled"]
];

export const fixtureTeam = {
  id: "20000000-0000-4000-8000-000000000001",
  name: "Koed Fixture Team"
};

export const fixtureSessionCookieName = "cm_session";
export const fixtureSessionSecrets = Object.fromEntries(
  Object.keys(fixtureUsers).map((userKey) => [
    userKey,
    `cms_${FIXTURE_VERSION}_${userKey}_session_secret_000000000000000000000000`
  ])
);
export const fixtureDeviceSecrets = Object.fromEntries(
  Object.keys(fixtureUsers).map((userKey) => [
    userKey,
    `cmd_${FIXTURE_VERSION}_${userKey}_device_secret_000000000000000000000000`
  ])
);
export const fixtureSessionRows = Object.fromEntries(
  Object.keys(fixtureUsers).map((userKey) => [
    userKey,
    {
      id: fixtureUuid(`session:${userKey}`),
      expiresAt: FIXTURE_SESSION_EXPIRES_AT
    }
  ])
);

export const fixtureWorkspaces = {
  electron: {
    id: "30000000-0000-4000-8000-000000000001",
    name: "Electron Team App",
    projectId: "/fixture/koed/electron-team-app"
  },
  cloud: {
    id: "30000000-0000-4000-8000-000000000002",
    name: "Cloud Memory Platform",
    projectId: "/fixture/koed/cloud-memory-platform"
  },
  ingestion: {
    id: "30000000-0000-4000-8000-000000000003",
    name: "Managed Knowledge Ingestion",
    projectId: "/fixture/koed/managed-knowledge-ingestion"
  }
};

export const fixtureWorkspaceAccess = [
  ["electron", "alice", "write"],
  ["electron", "bob", "write"],
  ["electron", "carol", "read"],
  ["electron", "david", "write"],
  ["electron", "erin", "read"],
  ["cloud", "alice", "write"],
  ["cloud", "bob", "disabled"],
  ["cloud", "carol", "write"],
  ["cloud", "david", "write"],
  ["ingestion", "alice", "write"],
  ["ingestion", "bob", "read"],
  ["ingestion", "carol", "write"],
  ["ingestion", "david", "write"],
  ["ingestion", "erin", "read"]
];

export const fixtureWorkspaceShareOwnedMemoryAccess = [["electron", "bob"]];

const canShareOwnedMemoryFor = (workspaceKey, userKey) =>
  fixtureWorkspaceShareOwnedMemoryAccess.some(
    ([candidateWorkspace, candidateUser]) =>
      candidateWorkspace === workspaceKey && candidateUser === userKey
  );

export const fixtureMemories = [
  {
    key: "bob-electron-timeline",
    owner: "bob",
    workspace: "electron",
    title: "Workspace Memory Timeline UX",
    content:
      "Bob decided the Electron app should show a Workspace Memory Timeline with captured decisions, contributors, and retained team knowledge as the demo aha moment.",
    representation: "memory_events",
    shareState: "active",
    expectedTeamVisible: true
  },
  {
    key: "david-electron-agent-rooms",
    owner: "david",
    workspace: "electron",
    title: "Agent Collaboration Rooms",
    content:
      "David proposed Collaboration Rooms where agents can inspect shared memory before implementation, reducing late review churn and wasted tokens.",
    representation: "lcm_leaves",
    shareState: "active",
    expectedTeamVisible: true
  },
  {
    key: "david-electron-revoked-experiment",
    owner: "david",
    workspace: "electron",
    title: "Revoked Electron Experiment",
    content:
      "David drafted an experimental Electron architecture note that was shared briefly and then revoked; it must remain personal-only for Team recall.",
    representation: "memory_events",
    shareState: "revoked",
    expectedTeamVisible: false
  },
  {
    key: "bob-private-devops",
    owner: "bob",
    workspace: "electron",
    title: "Private DevOps Scratchpad",
    content:
      "Bob has private deployment scratch notes about local ports and developer machine assumptions that must not leak into Team Workspace recall.",
    representation: "memory_events",
    shareState: "private",
    expectedTeamVisible: false
  },
  {
    key: "alice-cloud-flat-data",
    owner: "alice",
    workspace: "cloud",
    title: "Flat User-Owned Memory Model",
    content:
      "Alice locked the Team SaaS memory model: data remains user-owned and flat, while Workspace visibility is controlled through explicit grants.",
    representation: "lcm_rollups",
    shareState: "active",
    expectedTeamVisible: true
  },
  {
    key: "carol-cloud-api-contract",
    owner: "carol",
    workspace: "cloud",
    title: "Cloud API Superset Contract",
    content:
      "Carol defined the cloud API as a superset of the self-hosted API, with clients discovering enabled modules through capabilities.",
    representation: "memory_events",
    shareState: "active",
    expectedTeamVisible: true
  },
  {
    key: "carol-cloud-retained-deletion",
    owner: "carol",
    workspace: "cloud",
    title: "Retained Billing Grace Decision",
    content:
      "Carol captured that billing grace expiry may restrict writes while retaining Team access to existing Workspace knowledge for authorized members.",
    representation: "lcm_leaves",
    shareState: "personal_deleted_retained",
    expectedTeamVisible: true
  },
  {
    key: "bob-cloud-removed-member",
    owner: "bob",
    workspace: "cloud",
    title: "Removed Member Deployment Note",
    content:
      "Bob contributed the Cloud deployment health-check note before being removed from the Cloud Memory Platform Workspace.",
    representation: "lcm_rollups",
    shareState: "active",
    expectedTeamVisible: true
  },
  {
    key: "alice-private-pricing",
    owner: "alice",
    workspace: "cloud",
    title: "Private Pricing Scratchpad",
    content:
      "Alice has private pricing and positioning notes that should stay outside Team recall until explicitly shared.",
    representation: "memory_events",
    shareState: "private",
    expectedTeamVisible: false
  },
  {
    key: "david-ingestion-fallbacks",
    owner: "david",
    workspace: "ingestion",
    title: "Provider Fallback Ingestion",
    content:
      "David specified that Memory Inbox ingestion must route by source type and avoid a single model dependency for every uploaded document.",
    representation: "memory_events",
    shareState: "active",
    expectedTeamVisible: true
  },
  {
    key: "carol-ingestion-dedupe",
    owner: "carol",
    workspace: "ingestion",
    title: "Checksum Dedupe Inventory",
    content:
      "Carol designed checksum-based content inventory so identical PDFs uploaded by multiple users are stored once but retain per-user provenance.",
    representation: "lcm_leaves",
    shareState: "active",
    expectedTeamVisible: true
  },
  {
    key: "alice-ingestion-product",
    owner: "alice",
    workspace: "ingestion",
    title: "Memory Inbox Product Boundary",
    content:
      "Alice framed Memory Inbox as a paid Dropbox-like managed ingestion feature accessible from Electron for cloud teams.",
    representation: "lcm_rollups",
    shareState: "active",
    expectedTeamVisible: true
  },
  {
    key: "david-private-agent-prompt",
    owner: "david",
    workspace: "ingestion",
    title: "Private Agent Prompt Scratchpad",
    content:
      "David keeps private prompt experiments for agent workflow evaluation; these should not appear in Managed Knowledge Ingestion recall.",
    representation: "memory_events",
    shareState: "private",
    expectedTeamVisible: false
  }
];

const idFor = (group, index) =>
  `${group}0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;

export const fixtureMemoryRows = fixtureMemories.map((memory, index) => ({
  ...memory,
  sessionId: idFor("4", index),
  eventId: idFor("5", index),
  nodeId: idFor("6", index),
  conversationItemId: idFor("7", index),
  shareGrantId: idFor("8", index),
  messageId: idFor("9", index),
  logicalMemoryId: fixtureUuid(`memory:${memory.key}:logical`),
  ownerPrincipalId: fixtureUuid(`memory:${memory.key}:owner-principal`),
  remoteReplicaId: fixtureUuid(`memory:${memory.key}:target-replica`),
  remoteSyncReplicaId: fixtureUuid(`memory:${memory.key}:source-replica`),
  syncRelationshipId: fixtureUuid(`memory:${memory.key}:sync-relationship`),
  sourceOwnerPolicyId: fixtureUuid(`memory:${memory.key}:owner-policy`),
  consentId: fixtureUuid(`memory:${memory.key}:consent`),
  representationId: fixtureUuid(`memory:${memory.key}:representation`),
  representationChunkId: fixtureUuid(`memory:${memory.key}:chunk:0`),
  capturedAt: new Date(Date.UTC(2026, 0, 1, 9, index, 0)).toISOString(),
  sourceHash: `${FIXTURE_SOURCE_HASH_PREFIX}${memory.key}`,
  idempotencyKey: `${FIXTURE_VERSION}:${memory.key}`
}));

export const fixtureThreads = [
  {
    key: "alice-notes",
    kind: "notes_to_self",
    scope: "personal",
    actor: "alice",
    messages: [
      ["alice", "Remember to compare the Team fixture against the truth sheet."]
    ]
  },
  {
    key: "alice-personal-release-notes",
    kind: "personal_channel",
    scope: "personal",
    actor: "alice",
    name: "release-notes",
    topic: "Private launch notes before they are shared.",
    messages: [
      [
        "alice",
        "The private release checklist stays in Personal collaboration."
      ]
    ]
  },
  {
    key: "electron-product-channel",
    kind: "workspace_channel",
    scope: "team",
    actor: "alice",
    workspace: "electron",
    name: "product",
    topic: "Electron Team App product decisions.",
    messages: [
      [
        "alice",
        "The Workspace timeline should be the first shared-memory view."
      ],
      ["bob", "The timeline must update live without polling."]
    ]
  },
  {
    key: "alice-bob-dm",
    kind: "dm",
    scope: "team",
    actor: "alice",
    participants: ["alice", "bob"],
    messages: [
      ["alice", "Can you verify the Electron split view?"],
      ["bob", "Yes, I will check wide and narrow layouts."]
    ]
  },
  {
    key: "launch-group-dm",
    kind: "group_dm",
    scope: "team",
    actor: "alice",
    participants: ["alice", "bob", "carol"],
    messages: [
      [
        "carol",
        "The launch review needs authorization and encryption evidence."
      ]
    ]
  },
  {
    key: "timeline-companion",
    kind: "shared_session_discussion",
    scope: "team",
    actor: "alice",
    workspace: "electron",
    memory: "bob-electron-timeline",
    messages: [
      ["alice", "The retained decisions are visible beside the live session."],
      ["bob", "I will keep the companion discussion scoped to this share."]
    ],
    readThrough: 1
  }
];

export const fixtureThreadRows = fixtureThreads.map((thread) => {
  const personalOwnerUserId =
    thread.scope === "personal" ? fixtureUsers[thread.actor].id : null;
  const teamId = thread.scope === "team" ? fixtureTeam.id : null;
  const authorityBoundary = canonicalJson({
    actorUserId: fixtureUsers[thread.actor].id,
    personalOwnerUserId,
    scope: thread.scope,
    teamId
  });
  const idempotencyKeyHash = collaborationHashDomain(
    "thread-idempotency",
    `${FIXTURE_VERSION}:thread:${thread.key}`
  );
  return {
    ...thread,
    id: collaborationUuid(
      `koed:collaboration:thread-id:v1\n${authorityBoundary}\n${idempotencyKeyHash}`
    )
  };
});

export const fixtureUserIds = Object.values(fixtureUsers).map(
  (user) => user.id
);
export const fixtureUserEmails = Object.values(fixtureUsers).map(
  (user) => user.email
);
export const fixtureWorkspaceIds = Object.values(fixtureWorkspaces).map(
  (workspace) => workspace.id
);
export const fixtureSessionIds = fixtureMemoryRows.map(
  (memory) => memory.sessionId
);
export const fixtureEventIds = fixtureMemoryRows.map(
  (memory) => memory.eventId
);
export const fixtureNodeIds = fixtureMemoryRows.map((memory) => memory.nodeId);
export const fixtureConversationItemIds = fixtureMemoryRows.map(
  (memory) => memory.conversationItemId
);
export const fixtureShareGrantIds = fixtureMemoryRows.map(
  (memory) => memory.shareGrantId
);
export const fixtureMessageIds = fixtureMemoryRows.map(
  (memory) => memory.messageId
);
export const fixtureThreadIds = fixtureThreadRows.map((thread) => thread.id);

const fixtureInfrastructure = {
  sourceDeploymentId: fixtureUuid("deployment:source"),
  sourceProtocolDeploymentId: fixtureUuid("deployment:source:protocol"),
  targetDeploymentId: fixtureUuid("deployment:target"),
  targetProtocolDeploymentId: fixtureUuid("deployment:target:protocol"),
  teamPolicyId: fixtureUuid("policy:team"),
  teamPolicyRowId: fixtureUuid("policy:team:row"),
  teamRetentionPolicyId: fixtureUuid("retention-policy:team"),
  teamRetentionPolicyRowId: fixtureUuid("retention-policy:team:row")
};

const fixtureWorkspacePolicy = (workspaceKey) => ({
  id: fixtureUuid(`policy:workspace:${workspaceKey}:row`),
  policyId: fixtureUuid(`policy:workspace:${workspaceKey}`)
});

const fixtureOwnerInfrastructure = (userKey) => ({
  remoteUserIdentityId: fixtureUuid(`identity:remote:${userKey}`),
  deviceCredentialId: fixtureUuid(`device:${userKey}`),
  deviceCredentialLineageId: fixtureUuid(`device:${userKey}:lineage`),
  deviceCredentialKeyId: `${FIXTURE_VERSION}-${userKey}-device`,
  remoteExternalSubjectId: `${FIXTURE_VERSION}:${userKey}`
});

export const createFixtureRuntime = async (
  pool,
  { environment = process.env } = {}
) => {
  const [shared, db, encryptedPayloads] = await Promise.all([
    import("../packages/shared/dist/index.js"),
    import("../packages/db/dist/index.js"),
    import("../packages/db/dist/encrypted-payload-repository.js")
  ]);
  const configuredTeamProvider =
    shared.createEnvelopeEncryptionProviderFromEnvironment({ environment });
  const configuredOwnerProvider =
    shared.createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment({
      environment
    });
  if (Boolean(configuredTeamProvider) !== Boolean(configuredOwnerProvider)) {
    throw new Error(
      "Fixture seeding requires both Team/general and owner-private deployment encryption providers"
    );
  }
  const ownerProvider =
    configuredOwnerProvider ??
    shared.createLocalTestKeyEnvelopeEncryptionProvider(
      FIXTURE_OWNER_ENCRYPTION_KEY
    );
  const teamProvider =
    configuredTeamProvider ??
    shared.createLocalTestKeyEnvelopeEncryptionProvider(
      FIXTURE_TEAM_ENCRYPTION_KEY
    );
  if (ownerProvider.keyId === teamProvider.keyId) {
    throw new Error(
      "Fixture Team/general and owner-private encryption providers must use distinct keys"
    );
  }
  return {
    shared,
    upsertEncryptedFieldPayloadWithClient:
      encryptedPayloads.upsertEncryptedFieldPayloadWithClient,
    ownerProvider,
    teamProvider,
    collaborationRepository: db.createCollaborationRepository(pool, {
      envelopeEncryptionProvider: teamProvider
    }),
    sharedMemoryRepository: db.createSharedMemoryRepository(pool, {
      resolveTeamEncryptionProvider: () => teamProvider,
      resolveOwnerPrivateReplicaEncryptionProvider: () => ownerProvider
    })
  };
};

const json = (value) => JSON.stringify(value);
const fixtureSessionHash = (secret, pepper) =>
  createHash("sha256").update(`${pepper}${secret}`).digest("hex");

const seedSharedMemoryTopology = async (client, runtime, memory) => {
  if (memory.shareState === "private") return;
  const owner = fixtureUsers[memory.owner];
  const workspace = fixtureWorkspaces[memory.workspace];
  const ownerInfrastructure = fixtureOwnerInfrastructure(memory.owner);
  const workspacePolicy = fixtureWorkspacePolicy(memory.workspace);
  const ownerPolicyHash = fixtureHash(`policy:owner:${memory.key}:hash`);
  const teamPolicyHash = fixtureHash("policy:team:hash");
  const workspacePolicyHash = fixtureHash(
    `policy:workspace:${memory.workspace}:hash`
  );
  const representationPolicyHash = runtime.shared.crossIdentitySyncDigest({
    kind: "shared_memory_representation_policy",
    representation: memory.representation,
    revision: 1,
    owner: {
      policyId: memory.sourceOwnerPolicyId,
      version: 1,
      hash: ownerPolicyHash
    },
    team: {
      policyId: fixtureInfrastructure.teamPolicyId,
      version: 1,
      hash: teamPolicyHash
    },
    workspace: {
      policyId: workspacePolicy.policyId,
      version: 1,
      hash: workspacePolicyHash
    }
  });
  const contentPolicyHash = runtime.shared.crossIdentitySyncDigest({
    kind: "shared_memory_content_policy",
    representation: memory.representation,
    version: 1
  });
  const classifierHash = runtime.shared.crossIdentitySyncDigest({
    kind: "shared_memory_classifier",
    representation: memory.representation,
    version: 1
  });
  const sourceId =
    memory.representation === "memory_events" ? memory.eventId : memory.nodeId;
  const itemType =
    memory.representation === "memory_events"
      ? "user_message"
      : memory.representation === "lcm_leaves"
        ? "lcm_leaf"
        : "lcm_rollup";
  const item = {
    itemType,
    schemaVersion: 1,
    sourceId,
    sourceLogicalMemoryId: memory.logicalMemoryId,
    sourceRevision: 1,
    occurredAt: memory.capturedAt,
    content:
      itemType === "user_message"
        ? { text: memory.content }
        : {
            title: memory.title,
            summaryText: memory.content,
            sourceIds: [memory.eventId]
          }
  };
  const manifest = [
    {
      sourceId,
      sourceTable:
        memory.representation === "memory_events"
          ? "memory_events"
          : "memory_nodes",
      itemType,
      sourceCursor: 1,
      revisionHash: fixtureHash(`memory:${memory.key}:revision`),
      occurredAt: memory.capturedAt,
      sourceEventId: memory.eventId,
      sourceNodeId:
        memory.representation === "memory_events" ? null : memory.nodeId
    }
  ];
  const manifestHash = runtime.shared.crossIdentitySyncDigest(manifest);
  const redactedContentHash = runtime.shared.crossIdentitySyncDigest([item]);
  const sourceHash = runtime.shared.crossIdentitySyncDigest({
    kind: "shared_memory_authoritative_source",
    representation: memory.representation,
    logicalMemoryId: memory.logicalMemoryId,
    sourceRevision: 1,
    sourceCursor: 1,
    manifestHash,
    redactedContentHash
  });
  const binding = {
    sourceRevision: 1,
    sourceHash,
    representationPolicyRevision: 1,
    representationPolicyHash,
    contentPolicyVersion: 1,
    contentPolicyHash,
    classifierVersion: 1,
    classifierHash
  };
  const deviceProvenanceHash = runtime.shared.crossIdentitySyncDigest({
    fixture: FIXTURE_VERSION,
    user: memory.owner,
    deviceCredentialId: ownerInfrastructure.deviceCredentialId,
    syncRelationshipId: memory.syncRelationshipId
  });

  await client.query(
    `insert into logical_memories (
       id, protocol_logical_id, owner_user_id, owner_principal_id,
       origin_deployment_identity_id, source_boundary, origin_source_id,
       local_session_id, logical_key, latest_source_revision, metadata
     ) values (
       $1, $2, $3, $4, $5, 'captured_session', $6, $7, $8, 1, $9::jsonb
     )`,
    [
      memory.logicalMemoryId,
      fixtureUuid(`memory:${memory.key}:protocol-logical`),
      owner.id,
      memory.ownerPrincipalId,
      fixtureInfrastructure.sourceDeploymentId,
      `${FIXTURE_VERSION}:${memory.key}`,
      memory.sessionId,
      `${FIXTURE_VERSION}:${memory.key}`,
      json({ fixture: FIXTURE_VERSION, memoryKey: memory.key })
    ]
  );
  await client.query(
    `insert into memory_replicas (
       id, logical_memory_id, deployment_identity_id, owner_user_id,
       owner_principal_id, replica_role, source_boundary, local_session_id,
       latest_revision, lifecycle, encryption_scope, freshness_status,
       representation_policy_revision, content_policy_version, last_synced_at
     ) values (
       $1, $2, $3, $4, $5, 'target', 'captured_session', $6,
       1, 'active', 'owner_private_replica', 'fresh', 1, 1, $7
     )`,
    [
      memory.remoteReplicaId,
      memory.logicalMemoryId,
      fixtureInfrastructure.targetDeploymentId,
      owner.id,
      memory.ownerPrincipalId,
      memory.sessionId,
      memory.capturedAt
    ]
  );
  const ownerPrivateRetentionPolicyId = fixtureUuid(
    `memory:${memory.key}:owner-private-retention-policy`
  );
  const ownerPrivateRetentionPolicyTarget = {
    scope: "owner_private_replica",
    ownerPrivateReplicaId: memory.remoteReplicaId,
    logicalMemoryId: memory.logicalMemoryId
  };
  await client.query(
    `insert into retention_policies (
       policy_id, version, scope, owner_private_replica_id, logical_memory_id,
       retention_seconds, deletion_grace_seconds, backup_retention_seconds,
       policy_hash, created_by_user_id, effective_at
     ) values ($1,1,'owner_private_replica',$2,$3,0,0,0,$4,$5,$6)`,
    [
      ownerPrivateRetentionPolicyId,
      memory.remoteReplicaId,
      memory.logicalMemoryId,
      runtime.shared.crossIdentitySyncDigest({
        policyId: ownerPrivateRetentionPolicyId,
        version: 1,
        target: ownerPrivateRetentionPolicyTarget,
        retentionSeconds: 0,
        deletionGraceSeconds: 0,
        backupRetentionSeconds: 0,
        effectiveAt: new Date(memory.capturedAt).toISOString()
      }),
      owner.id,
      memory.capturedAt
    ]
  );
  await client.query(
    `insert into cross_identity_sync_relationships (
       id, logical_memory_id, side, local_replica_id, local_user_id,
       device_credential_id, remote_deployment_identity_id,
       remote_user_identity_id, remote_replica_id, source_boundary,
       sync_mode, state, idempotency_key, creation_request_hash,
       source_cursor, target_processing_cursor, package_sequence,
       last_synced_at
     ) values (
       $1, $2, 'target', $3, $4, $5, $6, $7, $8, 'captured_session',
       'live', 'ready', $9, $10, 1, 1, 1, $11
     )`,
    [
      memory.syncRelationshipId,
      memory.logicalMemoryId,
      memory.remoteReplicaId,
      owner.id,
      ownerInfrastructure.deviceCredentialId,
      fixtureInfrastructure.sourceDeploymentId,
      ownerInfrastructure.remoteUserIdentityId,
      memory.remoteSyncReplicaId,
      `${FIXTURE_VERSION}:${memory.key}:sync`,
      fixtureHash(`memory:${memory.key}:sync-request`),
      memory.capturedAt
    ]
  );
  await client.query(
    `insert into source_owner_representation_policies (
       id, policy_id, logical_memory_id, source_owner_principal_id,
       version, allowed_representations, policy_hash,
       created_by_user_id, effective_at
     ) values (
       $1, $2, $3, $4, 1, $5::shared_memory_representation[], $6, $7, $8
     )`,
    [
      fixtureUuid(`memory:${memory.key}:owner-policy-row`),
      memory.sourceOwnerPolicyId,
      memory.logicalMemoryId,
      memory.ownerPrincipalId,
      ALL_REPRESENTATIONS,
      ownerPolicyHash,
      owner.id,
      memory.capturedAt
    ]
  );

  const artifactBase = {
    schemaVersion: 1,
    artifactId: "",
    logicalMemoryId: memory.logicalMemoryId,
    representation: memory.representation,
    binding,
    sync: {
      relationshipId: memory.syncRelationshipId,
      localReplicaId: memory.remoteReplicaId,
      remoteReplicaId: memory.remoteSyncReplicaId,
      localSessionId: memory.sessionId,
      sourceCursor: 1,
      packageSequence: 1,
      sourceDeploymentIdentityId: fixtureInfrastructure.sourceDeploymentId,
      remoteUserIdentityId: ownerInfrastructure.remoteUserIdentityId,
      deviceCredentialId: ownerInfrastructure.deviceCredentialId,
      deviceProvenanceHash
    },
    policies: {
      sourceOwnerPolicyId: memory.sourceOwnerPolicyId,
      sourceOwnerPolicyVersion: 1,
      teamPolicyId: fixtureInfrastructure.teamPolicyId,
      teamPolicyVersion: 1,
      workspacePolicyId: workspacePolicy.policyId,
      workspacePolicyVersion: 1
    },
    manifest,
    manifestHash,
    items: [item],
    redactedContentHash
  };
  const artifactHash = runtime.shared.sharedSourceArtifactHash(artifactBase);
  const artifactId = runtime.shared.sharedSourceArtifactId(artifactHash);
  const artifact = { ...artifactBase, artifactId, artifactHash };
  const previewBase = {
    schemaVersion: 1,
    previewId: "",
    artifactId,
    logicalMemoryId: memory.logicalMemoryId,
    representation: memory.representation,
    binding,
    items: [item],
    redactedContentHash
  };
  const previewHash = runtime.shared.sharedSourcePreviewHash(previewBase);
  const previewId = runtime.shared.sharedSourcePreviewId(previewHash);
  const preview = { ...previewBase, previewId, previewHash };

  await client.query(
    `insert into shared_source_artifacts (
       id, logical_memory_id, remote_replica_id, sync_relationship_id,
       owner_user_id, owner_principal_id, team_id, team_workspace_id,
       representation, artifact_schema_version, source_revision,
       source_cursor, package_sequence, source_hash, manifest_hash,
       artifact_hash, redacted_content_hash, source_owner_policy_id,
       source_owner_policy_version, team_policy_id, team_policy_version,
       workspace_policy_id, workspace_policy_version,
       representation_policy_revision, representation_policy_hash,
       content_policy_version, content_policy_hash, classifier_version,
       classifier_hash, source_deployment_identity_id,
       remote_user_identity_id, device_credential_id,
       device_provenance_hash
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,1,1,1,1,$10,$11,$12,$13,
       $14,1,$15,1,$16,1,1,$17,1,$18,1,$19,$20,$21,$22,$23
     )`,
    [
      artifactId,
      memory.logicalMemoryId,
      memory.remoteReplicaId,
      memory.syncRelationshipId,
      owner.id,
      memory.ownerPrincipalId,
      fixtureTeam.id,
      workspace.id,
      memory.representation,
      sourceHash,
      manifestHash,
      artifactHash,
      redactedContentHash,
      memory.sourceOwnerPolicyId,
      fixtureInfrastructure.teamPolicyId,
      workspacePolicy.policyId,
      representationPolicyHash,
      contentPolicyHash,
      classifierHash,
      fixtureInfrastructure.sourceDeploymentId,
      ownerInfrastructure.remoteUserIdentityId,
      ownerInfrastructure.deviceCredentialId,
      deviceProvenanceHash
    ]
  );
  await runtime.upsertEncryptedFieldPayloadWithClient(
    client,
    { userId: owner.id },
    runtime.ownerProvider,
    {
      sourceTable: "shared_source_artifacts",
      sourceId: artifactId,
      sourceColumn: "artifact",
      plaintext: artifact,
      visibility: "owner_private_replica",
      ownerPrincipalId: memory.ownerPrincipalId,
      rowFamily: "shared_source_artifact",
      scope: { tenantId: owner.id, objectClass: "shared_source_artifact" },
      aad: {
        logicalMemoryId: memory.logicalMemoryId,
        remoteReplicaId: memory.remoteReplicaId,
        teamId: fixtureTeam.id,
        teamWorkspaceId: workspace.id,
        representation: memory.representation,
        artifactHash,
        sourceRevision: 1,
        syncRelationshipId: memory.syncRelationshipId,
        sourceDeploymentIdentityId: fixtureInfrastructure.sourceDeploymentId,
        remoteUserIdentityId: ownerInfrastructure.remoteUserIdentityId,
        deviceCredentialId: ownerInfrastructure.deviceCredentialId,
        deviceProvenanceHash
      }
    }
  );
  await client.query(
    `insert into shared_source_previews (
       id, source_artifact_id, logical_memory_id, remote_replica_id,
       owner_user_id, owner_principal_id, team_id, team_workspace_id,
       representation, preview_schema_version, preview_revision,
       preview_hash, source_revision, source_hash, redacted_content_hash
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,1,$10,1,$11,$12)`,
    [
      previewId,
      artifactId,
      memory.logicalMemoryId,
      memory.remoteReplicaId,
      owner.id,
      memory.ownerPrincipalId,
      fixtureTeam.id,
      workspace.id,
      memory.representation,
      previewHash,
      sourceHash,
      redactedContentHash
    ]
  );
  await runtime.upsertEncryptedFieldPayloadWithClient(
    client,
    { userId: owner.id },
    runtime.ownerProvider,
    {
      sourceTable: "shared_source_previews",
      sourceId: previewId,
      sourceColumn: "preview",
      plaintext: preview,
      visibility: "owner_private_replica",
      ownerPrincipalId: memory.ownerPrincipalId,
      rowFamily: "shared_source_preview",
      scope: { tenantId: owner.id, objectClass: "shared_source_preview" },
      aad: {
        logicalMemoryId: memory.logicalMemoryId,
        remoteReplicaId: memory.remoteReplicaId,
        teamId: fixtureTeam.id,
        teamWorkspaceId: workspace.id,
        representation: memory.representation,
        artifactId,
        previewHash,
        sourceRevision: 1
      }
    }
  );

  await client.query(
    `insert into source_owner_representation_consents (
       id, logical_memory_id, remote_replica_id, source_owner_principal_id,
       team_id, team_workspace_id, source_owner_policy_id,
       source_owner_policy_version, team_policy_id, team_policy_version,
       workspace_policy_id, workspace_policy_version, mode, state,
       consent_version, allowed_representations, selected_representation,
       preview_id, preview_revision, preview_hash, source_revision,
       maximum_authorized_source_revision, source_hash,
       representation_policy_revision, representation_policy_hash,
       content_policy_version, content_policy_hash, classifier_version,
       classifier_hash, redacted_content_hash, activated_at
     ) values (
       $1,$2,$3,$4,$5,$6,$7,1,$8,1,$9,1,'continuous','active',1,
       $10::shared_memory_representation[],$11,$12,1,$13,1,null,$14,
       1,$15,1,$16,1,$17,$18,$19
     )`,
    [
      memory.consentId,
      memory.logicalMemoryId,
      memory.remoteReplicaId,
      memory.ownerPrincipalId,
      fixtureTeam.id,
      workspace.id,
      memory.sourceOwnerPolicyId,
      fixtureInfrastructure.teamPolicyId,
      workspacePolicy.policyId,
      ALL_REPRESENTATIONS,
      memory.representation,
      previewId,
      previewHash,
      sourceHash,
      representationPolicyHash,
      contentPolicyHash,
      classifierHash,
      redactedContentHash,
      memory.capturedAt
    ]
  );

  const revoked = memory.shareState === "revoked";
  const personalDeleted = memory.shareState === "personal_deleted_retained";
  await client.query(
    `insert into team_session_share_grants (
       id, logical_grant_id, logical_memory_id, remote_replica_id,
       owner_user_id, owner_principal_id, session_id, team_id,
       team_workspace_id, consent_id, source_owner_policy_id,
       source_owner_policy_version, team_policy_id, team_policy_version,
       workspace_policy_id, workspace_policy_version,
       owner_allowed_representations, active_representation,
       representation_policy_revision, content_policy_version,
       classifier_version, source_revision, grant_version, lifecycle,
       creator_authority, granted_by_user_id, revoked_at,
       revoked_by_user_id, revocation_reason, personal_deleted_at,
       personal_deleted_by_user_id, personal_deletion_reason,
       retained_by_team_at, retention_reason
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,1,$13,1,
       $14::shared_memory_representation[],$15,1,1,1,1,1,$16,
       'fixture_browser_session',$5,$17,$18,$19,$20,$21,$22,$23,$24
     )`,
    [
      memory.shareGrantId,
      fixtureUuid(`memory:${memory.key}:logical-grant`),
      memory.logicalMemoryId,
      memory.remoteReplicaId,
      owner.id,
      memory.ownerPrincipalId,
      memory.sessionId,
      fixtureTeam.id,
      workspace.id,
      memory.consentId,
      memory.sourceOwnerPolicyId,
      fixtureInfrastructure.teamPolicyId,
      workspacePolicy.policyId,
      ALL_REPRESENTATIONS,
      memory.representation,
      revoked ? "revoked" : "active",
      revoked ? memory.capturedAt : null,
      revoked ? owner.id : null,
      revoked ? "fixture_revoked_share" : null,
      personalDeleted ? memory.capturedAt : null,
      personalDeleted ? owner.id : null,
      personalDeleted ? "fixture_personal_deleted" : null,
      revoked ? null : memory.capturedAt,
      personalDeleted
        ? "fixture_team_retention_after_personal_deletion"
        : revoked
          ? "fixture_revoked_share_not_retained"
          : "fixture_active_team_share"
    ]
  );

  const provenanceHash = runtime.shared.crossIdentitySyncDigest({
    shareGrantId: memory.shareGrantId,
    consentId: memory.consentId,
    logicalMemoryId: memory.logicalMemoryId,
    representation: memory.representation,
    binding,
    redactedContentHash,
    sourceOwnerPolicyId: memory.sourceOwnerPolicyId,
    sourceOwnerPolicyVersion: 1,
    teamPolicyId: fixtureInfrastructure.teamPolicyId,
    teamPolicyVersion: 1,
    workspacePolicyId: workspacePolicy.policyId,
    workspacePolicyVersion: 1
  });
  await client.query(
    `insert into team_memory_representations (
       id, share_grant_id, consent_id, source_preview_id,
       source_artifact_id, team_id, team_workspace_id, logical_memory_id,
       representation, source_revision, source_revision_hash,
       provenance_hash, source_owner_policy_id,
       source_owner_policy_version, team_policy_id, team_policy_version,
       workspace_policy_id, workspace_policy_version,
       representation_policy_revision, content_policy_version,
       classifier_version, record_version, state, chunk_count,
       freshness_evaluated_at, available_at, invalidated_at,
       invalidation_reason_code
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,1,$13,1,$14,1,
       1,1,1,1,$15,1,$16,$16,$17,$18
     )`,
    [
      memory.representationId,
      memory.shareGrantId,
      memory.consentId,
      previewId,
      artifactId,
      fixtureTeam.id,
      workspace.id,
      memory.logicalMemoryId,
      memory.representation,
      sourceHash,
      provenanceHash,
      memory.sourceOwnerPolicyId,
      fixtureInfrastructure.teamPolicyId,
      workspacePolicy.policyId,
      revoked ? "invalidated" : "available",
      memory.capturedAt,
      revoked ? memory.capturedAt : null,
      revoked ? "share_revoked" : null
    ]
  );
  const chunkAad = {
    representationId: memory.representationId,
    shareGrantId: memory.shareGrantId,
    teamId: fixtureTeam.id,
    teamWorkspaceId: workspace.id,
    logicalMemoryId: memory.logicalMemoryId,
    consentId: memory.consentId,
    representation: memory.representation,
    chunkIndex: 0,
    chunkCount: 1,
    ...binding,
    redactedContentHash,
    provenanceHash
  };
  const envelope = await runtime.teamProvider.encrypt({
    plaintext: Buffer.from(json([item]), "utf8"),
    scope: {
      teamId: fixtureTeam.id,
      workspaceId: workspace.id,
      objectClass: "shared_memory_representation_chunk"
    },
    provenance: {
      rowFamily: "team_memory_representation_chunk",
      sourceTable: "team_memory_representations",
      sourceId: memory.representationId
    },
    ciphertextLocation: "team_memory_representation_chunks",
    aad: chunkAad
  });
  await client.query(
    `insert into team_memory_representation_chunks (
       id, representation_id, share_grant_id, team_id, team_workspace_id,
       logical_memory_id, chunk_index, envelope_version, provider_mode,
       algorithm, key_id, key_version, ciphertext, ciphertext_hash,
       nonce, tag, wrapped_dek, aad, envelope_created_at,
       envelope_reencrypted_at, verified_at
     ) values (
       $1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10,$11,$12,$13,$14,$15,
       $16::jsonb,$17::jsonb,$18,$19,$18
     )`,
    [
      memory.representationChunkId,
      memory.representationId,
      memory.shareGrantId,
      fixtureTeam.id,
      workspace.id,
      memory.logicalMemoryId,
      envelope.version,
      envelope.providerMode,
      envelope.algorithm,
      envelope.keyId,
      envelope.keyVersion,
      envelope.ciphertext,
      createHash("sha256")
        .update(Buffer.from(envelope.ciphertext, "base64"))
        .digest("hex"),
      envelope.nonce,
      envelope.tag,
      json(envelope.wrappedDek),
      json(envelope.aad),
      envelope.createdAt,
      envelope.reencryptedAt
    ]
  );
};

const seedCollaborationFixture = async (repository) => {
  for (const thread of fixtureThreadRows) {
    const actor = { userId: fixtureUsers[thread.actor].id };
    const base = {
      kind: thread.kind,
      idempotencyKey: `${FIXTURE_VERSION}:thread:${thread.key}`
    };
    const input =
      thread.kind === "notes_to_self"
        ? base
        : thread.kind === "personal_channel"
          ? { ...base, name: thread.name, topic: thread.topic }
          : thread.kind === "workspace_channel"
            ? {
                ...base,
                teamId: fixtureTeam.id,
                teamWorkspaceId: fixtureWorkspaces[thread.workspace].id,
                name: thread.name,
                topic: thread.topic
              }
            : thread.kind === "dm" || thread.kind === "group_dm"
              ? {
                  ...base,
                  teamId: fixtureTeam.id,
                  participantUserIds: thread.participants.map(
                    (userKey) => fixtureUsers[userKey].id
                  )
                }
              : (() => {
                  const memory = fixtureMemoryRows.find(
                    (candidate) => candidate.key === thread.memory
                  );
                  if (!memory) {
                    throw new Error(
                      `Fixture companion thread is missing memory ${thread.memory}`
                    );
                  }
                  return {
                    ...base,
                    teamId: fixtureTeam.id,
                    teamWorkspaceId: fixtureWorkspaces[thread.workspace].id,
                    sharedLogicalMemoryId: memory.logicalMemoryId,
                    shareGrantId: memory.shareGrantId
                  };
                })();
    const created = await repository.createThread(actor, input);
    if (!created) {
      throw new Error(`Fixture collaboration thread ${thread.key} was denied`);
    }
    if (created.id !== thread.id) {
      throw new Error(
        `Fixture collaboration thread ${thread.key} has a nondeterministic ID`
      );
    }
    const messages = [];
    for (let index = 0; index < thread.messages.length; index += 1) {
      const [senderKey, bodyText] = thread.messages[index];
      const message = await repository.sendMessage(
        { userId: fixtureUsers[senderKey].id },
        {
          threadId: created.id,
          idempotencyKey: `${FIXTURE_VERSION}:message:${thread.key}:${index}`,
          bodyText,
          metadata: {
            fixture: FIXTURE_VERSION,
            threadKey: thread.key,
            messageIndex: index
          },
          provenance: {
            kind: "synthetic_fixture",
            id: fixtureHash(`collaboration:${thread.key}:${index}:provenance`)
          }
        }
      );
      if (!message) {
        throw new Error(
          `Fixture collaboration message ${thread.key}:${index} was denied`
        );
      }
      messages.push(message);
    }
    if (thread.readThrough) {
      const message = messages[thread.readThrough - 1];
      if (!message) {
        throw new Error(`Fixture read cursor for ${thread.key} is invalid`);
      }
      const read = await repository.advanceReadState(
        { userId: fixtureUsers.alice.id },
        { threadId: created.id, messageId: message.id }
      );
      if (!read) {
        throw new Error(`Fixture read cursor for ${thread.key} was denied`);
      }
    }
  }
};

export const resetFixture = async (client) => {
  assertFixtureEnvironment();
  const fixtureLogicalMemoryIds = fixtureMemoryRows.map(
    (memory) => memory.logicalMemoryId
  );
  const fixtureReplicaIds = fixtureMemoryRows.map(
    (memory) => memory.remoteReplicaId
  );
  const fixtureUserSessionIds = Object.values(fixtureSessionRows).map(
    (session) => session.id
  );
  const fixtureDeviceCredentialIds = [
    ...new Set(fixtureMemoryRows.map((memory) => memory.owner))
  ].map((userKey) => fixtureOwnerInfrastructure(userKey).deviceCredentialId);
  await client.query("begin");
  try {
    await client.query(
      `create temporary table fixture_reset_threads
         on commit drop as
       select id
         from collaboration_threads
        where team_id = $1 or id = any($2::uuid[])`,
      [fixtureTeam.id, fixtureThreadIds]
    );
    await client.query(
      `create temporary table fixture_reset_share_grants
         on commit drop as
       select id
         from team_session_share_grants
        where team_id = $1 or id = any($2::uuid[])`,
      [fixtureTeam.id, fixtureShareGrantIds]
    );
    await client.query(
      `create temporary table fixture_reset_shared_artifacts
         on commit drop as
       select id
         from shared_source_artifacts
        where team_id = $1 or logical_memory_id = any($2::uuid[])`,
      [fixtureTeam.id, fixtureLogicalMemoryIds]
    );
    await client.query(
      `create temporary table fixture_reset_shared_previews
         on commit drop as
       select id
         from shared_source_previews
        where source_artifact_id in (
                select id from fixture_reset_shared_artifacts
              )
           or logical_memory_id = any($1::uuid[])`,
      [fixtureLogicalMemoryIds]
    );
    await client.query(
      `delete from high_risk_action_grant_execution_receipts
       where action_grant_id in (
         select action_grant.id
         from high_risk_device_action_grants action_grant
         join high_risk_browser_confirmations confirmation
           on confirmation.id = action_grant.confirmation_id
         where confirmation.decision_user_session_id = any($1::uuid[])
            or confirmation.device_credential_id = any($2::uuid[])
       )`,
      [fixtureUserSessionIds, fixtureDeviceCredentialIds]
    );
    await client.query(
      `delete from high_risk_device_action_grants action_grant
       using high_risk_browser_confirmations confirmation
       where confirmation.id = action_grant.confirmation_id
         and (
           confirmation.decision_user_session_id = any($1::uuid[])
           or confirmation.device_credential_id = any($2::uuid[])
         )`,
      [fixtureUserSessionIds, fixtureDeviceCredentialIds]
    );
    await client.query(
      `delete from high_risk_browser_confirmations
       where decision_user_session_id = any($1::uuid[])
          or device_credential_id = any($2::uuid[])`,
      [fixtureUserSessionIds, fixtureDeviceCredentialIds]
    );
    await client.query(
      `delete from collaboration_stream_subscriptions
       where scope = 'team' and team_id = $1`,
      [fixtureTeam.id]
    );
    await client.query(
      `delete from collaboration_outbox
       where team_id = $1 or thread_id = any($2::uuid[])`,
      [fixtureTeam.id, fixtureThreadIds]
    );
    await client.query(
      `delete from collaboration_read_states
       where thread_id in (select id from fixture_reset_threads)`
    );
    await client.query(
      `delete from encrypted_field_payloads
       where (source_table = 'collaboration_threads'
              and source_id in (select id from fixture_reset_threads))
          or (source_table = 'collaboration_messages' and source_id in (
            select id from collaboration_messages
            where thread_id in (select id from fixture_reset_threads)
          ))
          or (source_table = 'shared_source_artifacts' and source_id in (
            select id from fixture_reset_shared_artifacts
          ))
          or (source_table = 'shared_source_previews' and source_id in (
            select id from fixture_reset_shared_previews
          ))`,
      []
    );
    await client.query(
      `delete from collaboration_messages
       where thread_id in (select id from fixture_reset_threads)`
    );
    await client.query(
      `delete from collaboration_participants
       where thread_id in (select id from fixture_reset_threads)`
    );
    await client.query(
      `delete from collaboration_threads
       where id in (select id from fixture_reset_threads)`
    );
    await client.query(
      `create temporary table fixture_reset_retention_policies
         on commit drop as
       select id, policy_id, version
         from retention_policies
        where team_id = $1
           or logical_memory_id = any($2::uuid[])
           or owner_private_replica_id = any($3::uuid[])`,
      [fixtureTeam.id, fixtureLogicalMemoryIds, fixtureReplicaIds]
    );
    await client.query(
      `create temporary table fixture_reset_retention_decisions
         on commit drop as
       select decision.id
         from retention_decisions decision
        where decision.team_id = $1
           or decision.share_grant_id in (
             select id from fixture_reset_share_grants
           )
           or decision.logical_memory_id = any($2::uuid[])
           or decision.owner_private_replica_id = any($3::uuid[])
           or exists (
             select 1
               from fixture_reset_retention_policies policy
              where policy.policy_id = decision.policy_id
                and policy.version = decision.policy_version
           )`,
      [fixtureTeam.id, fixtureLogicalMemoryIds, fixtureReplicaIds]
    );
    await client.query(
      `create temporary table fixture_reset_purge_jobs
         on commit drop as
       select job.id
         from purge_jobs job
        where job.team_id = $1
           or job.share_grant_id in (
             select id from fixture_reset_share_grants
           )
           or job.logical_memory_id = any($2::uuid[])
           or job.retention_decision_id in (
             select id from fixture_reset_retention_decisions
           )`,
      [fixtureTeam.id, fixtureLogicalMemoryIds]
    );
    await client.query(
      `create temporary table fixture_reset_shortening_previews
         on commit drop as
       select preview.id
         from retention_policy_shortening_previews preview
        where preview.team_id = $1
           or preview.retention_policy_row_id in (
             select id from fixture_reset_retention_policies
           )`,
      [fixtureTeam.id]
    );
    await client.query(
      `update team_session_share_grants
          set active_retention_decision_id = null,
              active_purge_job_id = null
        where id in (select id from fixture_reset_share_grants)
           or active_retention_decision_id in (
             select id from fixture_reset_retention_decisions
           )
           or active_purge_job_id in (select id from fixture_reset_purge_jobs)`
    );
    await client.query(
      `delete from purge_job_evidence
        where purge_job_id in (select id from fixture_reset_purge_jobs)`,
      []
    );
    await client.query(
      `delete from purge_job_attempts
        where purge_job_id in (select id from fixture_reset_purge_jobs)`,
      []
    );
    await client.query(
      `delete from retention_policy_shortening_migrations
        where preview_id in (select id from fixture_reset_shortening_previews)
           or previous_retention_decision_id in (
             select id from fixture_reset_retention_decisions
           )
           or migrated_retention_decision_id in (
             select id from fixture_reset_retention_decisions
           )`,
      []
    );
    await client.query(
      `delete from retention_policy_shortening_affected_scopes
        where preview_id in (select id from fixture_reset_shortening_previews)
           or retention_decision_id in (
             select id from fixture_reset_retention_decisions
           )`,
      []
    );
    await client.query(
      `delete from retention_policy_shortening_previews
        where id in (select id from fixture_reset_shortening_previews)`,
      []
    );
    await client.query(
      `delete from purge_jobs
        where id in (select id from fixture_reset_purge_jobs)`,
      []
    );
    await client.query(
      `delete from retention_decisions
        where id in (select id from fixture_reset_retention_decisions)`,
      []
    );
    await client.query(
      `delete from legal_holds
        where team_id = $1
           or share_grant_id in (select id from fixture_reset_share_grants)
           or logical_memory_id = any($2::uuid[])
           or owner_private_replica_id = any($3::uuid[])`,
      [fixtureTeam.id, fixtureLogicalMemoryIds, fixtureReplicaIds]
    );
    await client.query(
      `delete from retention_policies
        where id in (select id from fixture_reset_retention_policies)`,
      []
    );
    await client.query(
      `delete from team_memory_representation_chunks
       where id = any($1::uuid[])
          or share_grant_id in (select id from fixture_reset_share_grants)`,
      [fixtureMemoryRows.map((memory) => memory.representationChunkId)]
    );
    await client.query(
      `delete from team_memory_representations
       where id = any($1::uuid[])
          or share_grant_id in (select id from fixture_reset_share_grants)`,
      [fixtureMemoryRows.map((memory) => memory.representationId)]
    );
    await client.query(
      `
        delete from semantic_memory_rebuild_jobs
        where memory_event_id = any($1::uuid[])
      `,
      [fixtureEventIds]
    );
    await client.query(
      `
        delete from memory_embeddings
        where source_hash like $1
           or memory_node_id = any($2::uuid[])
           or memory_event_id = any($3::uuid[])
      `,
      [`${FIXTURE_SOURCE_HASH_PREFIX}%`, fixtureNodeIds, fixtureEventIds]
    );
    await client.query(
      `
        delete from memory_node_sources
        where memory_node_id = any($1::uuid[])
           or memory_event_id = any($2::uuid[])
           or message_id = any($3::uuid[])
      `,
      [fixtureNodeIds, fixtureEventIds, fixtureMessageIds]
    );
    await client.query(
      `
        delete from memory_event_sources
        where memory_event_id = any($1::uuid[])
           or conversation_item_id = any($2::uuid[])
      `,
      [fixtureEventIds, fixtureConversationItemIds]
    );
    await client.query(
      `delete from team_session_share_grants
        where id in (select id from fixture_reset_share_grants)`
    );
    await client.query(
      `delete from source_owner_representation_consents
       where id = any($1::uuid[])
          or preview_id in (select id from fixture_reset_shared_previews)`,
      [fixtureMemoryRows.map((memory) => memory.consentId)]
    );
    await client.query(
      `delete from shared_source_previews
       where id in (select id from fixture_reset_shared_previews)`
    );
    await client.query(
      `delete from shared_source_artifacts
       where id in (select id from fixture_reset_shared_artifacts)`
    );
    await client.query(
      `delete from source_owner_representation_policies
       where logical_memory_id = any($1::uuid[])`,
      [fixtureMemoryRows.map((memory) => memory.logicalMemoryId)]
    );
    await client.query(
      `delete from workspace_representation_policies
       where id = any($1::uuid[])`,
      [
        Object.keys(fixtureWorkspaces).map(
          (key) => fixtureWorkspacePolicy(key).id
        )
      ]
    );
    await client.query(
      "delete from team_representation_policies where id = $1",
      [fixtureInfrastructure.teamPolicyRowId]
    );
    await client.query(
      `delete from cross_identity_sync_relationships
       where id = any($1::uuid[])`,
      [fixtureMemoryRows.map((memory) => memory.syncRelationshipId)]
    );
    await client.query(
      `delete from memory_replicas
       where id = any($1::uuid[])`,
      [fixtureReplicaIds]
    );
    await client.query(
      "delete from logical_memories where id = any($1::uuid[])",
      [fixtureMemoryRows.map((memory) => memory.logicalMemoryId)]
    );
    await client.query(
      "delete from device_credentials where id = any($1::uuid[])",
      [fixtureDeviceCredentialIds]
    );
    await client.query(
      "delete from sync_external_user_identities where id = any($1::uuid[])",
      [
        [...new Set(fixtureMemoryRows.map((memory) => memory.owner))].map(
          (userKey) => fixtureOwnerInfrastructure(userKey).remoteUserIdentityId
        )
      ]
    );
    await client.query(
      "delete from deployment_identities where id = any($1::uuid[])",
      [
        [
          fixtureInfrastructure.sourceDeploymentId,
          fixtureInfrastructure.targetDeploymentId
        ]
      ]
    );
    await client.query(
      `
        delete from memory_nodes
        where id = any($1::uuid[])
           or source_hash like $2
      `,
      [fixtureNodeIds, `${FIXTURE_SOURCE_HASH_PREFIX}%`]
    );
    await client.query(
      `
        delete from memory_events
        where id = any($1::uuid[])
           or source_hash like $2
      `,
      [fixtureEventIds, `${FIXTURE_SOURCE_HASH_PREFIX}%`]
    );
    await client.query(
      `
        delete from conversation_items
        where id = any($1::uuid[])
           or source_hash like $2
      `,
      [fixtureConversationItemIds, `${FIXTURE_SOURCE_HASH_PREFIX}%`]
    );
    await client.query(
      `
        delete from messages
        where id = any($1::uuid[])
           or source_hash like $2
      `,
      [fixtureMessageIds, `${FIXTURE_SOURCE_HASH_PREFIX}%`]
    );
    await client.query(
      `
        delete from sessions
        where id = any($1::uuid[])
           or source_hash like $2
      `,
      [fixtureSessionIds, `${FIXTURE_SOURCE_HASH_PREFIX}%`]
    );
    await client.query("delete from user_sessions where id = any($1::uuid[])", [
      fixtureUserSessionIds
    ]);
    if (process.env.API_TOKEN_PEPPER?.trim()) {
      await client.query(
        "delete from user_sessions where session_hash = any($1::text[])",
        [
          Object.values(fixtureSessionSecrets).map((secret) =>
            fixtureSessionHash(secret, process.env.API_TOKEN_PEPPER)
          )
        ]
      );
    }
    await client.query(
      `delete from team_workspace_access_grants
       where team_workspace_id = any($1::uuid[])
         and user_id = any($2::uuid[])`,
      [fixtureWorkspaceIds, fixtureUserIds]
    );
    await client.query(
      "delete from team_workspaces where id = any($1::uuid[])",
      [fixtureWorkspaceIds]
    );
    await client.query(
      "delete from team_memberships where team_id = $1 and user_id = any($2::uuid[])",
      [fixtureTeam.id, fixtureUserIds]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
};

export const seedFixture = async (client, runtime) => {
  assertFixtureEnvironment();
  if (!runtime) {
    throw new Error(
      "Fixture runtime is required for encrypted fixture seeding"
    );
  }
  await resetFixture(client);
  await client.query("begin");
  try {
    for (const user of Object.values(fixtureUsers)) {
      await client.query(
        `
          insert into users (
            id, email, display_name, password_hash, disabled_at, disabled_reason
          )
          values ($1, $2, $3, $4, $5, $6)
          on conflict (id) do update set
            email = excluded.email,
            display_name = excluded.display_name,
            password_hash = excluded.password_hash,
            disabled_at = excluded.disabled_at,
            disabled_reason = excluded.disabled_reason,
            deleted_at = null,
            deletion_reason = null
        `,
        [
          user.id,
          user.email,
          user.displayName,
          `${FIXTURE_VERSION}:password-not-for-login`,
          user.disabled ? new Date(FIXTURE_STATE_AT) : null,
          user.disabled ? "fixture_disabled_user" : null
        ]
      );
    }

    if (process.env.API_TOKEN_PEPPER?.trim()) {
      for (const [userKey, user] of Object.entries(fixtureUsers)) {
        await client.query(
          `
            insert into user_sessions (id, user_id, session_hash, expires_at)
            values ($1, $2, $3, $4)
          `,
          [
            fixtureSessionRows[userKey].id,
            user.id,
            fixtureSessionHash(
              fixtureSessionSecrets[userKey],
              process.env.API_TOKEN_PEPPER
            ),
            fixtureSessionRows[userKey].expiresAt
          ]
        );
      }
    }

    await client.query(
      `insert into teams (id, name) values ($1, $2)
       on conflict (id) do update set
         name = excluded.name,
         lifecycle = 'active',
         entitlement_status = 'active',
         entitlement_reason = null,
         suspended_at = null,
         deletion_requested_at = null,
         tombstoned_at = null,
         purge_completed_at = null`,
      [fixtureTeam.id, fixtureTeam.name]
    );
    const teamRetentionEffectiveAt = new Date(FIXTURE_STATE_AT);
    const teamRetentionTarget = {
      scope: "team",
      teamId: fixtureTeam.id
    };
    await client.query(
      `insert into retention_policies (
         id, policy_id, version, scope, team_id, retention_seconds,
         deletion_grace_seconds, backup_retention_seconds, policy_hash,
         created_by_user_id, effective_at
       ) values ($1,$2,1,'team',$3,$4,0,$5,$6,$7,$8)
       on conflict (policy_id, version) do update set
         retention_seconds=excluded.retention_seconds,
         deletion_grace_seconds=excluded.deletion_grace_seconds,
         backup_retention_seconds=excluded.backup_retention_seconds,
         policy_hash=excluded.policy_hash,
         effective_at=excluded.effective_at,
         superseded_at=null`,
      [
        fixtureInfrastructure.teamRetentionPolicyRowId,
        fixtureInfrastructure.teamRetentionPolicyId,
        fixtureTeam.id,
        30 * 24 * 60 * 60,
        30 * 24 * 60 * 60,
        runtime.shared.crossIdentitySyncDigest({
          policyId: fixtureInfrastructure.teamRetentionPolicyId,
          version: 1,
          target: teamRetentionTarget,
          retentionSeconds: 30 * 24 * 60 * 60,
          deletionGraceSeconds: 0,
          backupRetentionSeconds: 30 * 24 * 60 * 60,
          effectiveAt: teamRetentionEffectiveAt.toISOString()
        }),
        fixtureUsers.alice.id,
        teamRetentionEffectiveAt
      ]
    );

    for (const [userKey, role, status] of fixtureTeamMemberships) {
      const user = fixtureUsers[userKey];
      await client.query(
        `
          insert into team_memberships (
            team_id,
            user_id,
            role,
            status,
            accepted_at
          )
          values ($1, $2, $3, $4, $5)
        `,
        [fixtureTeam.id, user.id, role, status, FIXTURE_STATE_AT]
      );
      if (status === "disabled") {
        await client.query(
          `update team_memberships
           set disabled_at = $3, disabled_reason = 'fixture_disabled_member'
           where team_id = $1 and user_id = $2`,
          [fixtureTeam.id, user.id, new Date(FIXTURE_STATE_AT)]
        );
      }
    }

    for (const workspace of Object.values(fixtureWorkspaces)) {
      await client.query(
        "insert into team_workspaces (id, team_id, name) values ($1, $2, $3)",
        [workspace.id, fixtureTeam.id, workspace.name]
      );
    }

    for (const [workspaceKey, userKey, access] of fixtureWorkspaceAccess) {
      const workspace = fixtureWorkspaces[workspaceKey];
      const user = fixtureUsers[userKey];
      await client.query(
        `
          insert into team_workspace_access_grants (
            team_workspace_id,
            team_id,
            user_id,
            access,
            can_share_owned_memory,
            granted_by_user_id,
            disabled_at,
            disabled_reason
          )
          values (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            case when $4::team_workspace_access = 'disabled' then $7::timestamptz else null end,
            case when $4::team_workspace_access = 'disabled' then 'fixture_workspace_removal' else null end
          )
        `,
        [
          workspace.id,
          fixtureTeam.id,
          user.id,
          access,
          canShareOwnedMemoryFor(workspaceKey, userKey),
          fixtureUsers.alice.id,
          FIXTURE_STATE_AT
        ]
      );
    }

    await client.query(
      `insert into deployment_identities (
         id, protocol_deployment_id, locality, profile, display_name
       ) values
         ($1, $2, 'remote', 'team_self_hosted', 'Fixture source deployment'),
         ($3, $4, 'remote', 'team_self_hosted', 'Fixture target deployment')`,
      [
        fixtureInfrastructure.sourceDeploymentId,
        fixtureInfrastructure.sourceProtocolDeploymentId,
        fixtureInfrastructure.targetDeploymentId,
        fixtureInfrastructure.targetProtocolDeploymentId
      ]
    );

    const memoryOwnerKeys = [
      ...new Set(fixtureMemoryRows.map((memory) => memory.owner))
    ];
    for (const userKey of memoryOwnerKeys) {
      const owner = fixtureUsers[userKey];
      const infrastructure = fixtureOwnerInfrastructure(userKey);
      await client.query(
        `insert into sync_external_user_identities (
           id, deployment_identity_id, external_subject_id
         ) values ($1, $2, $3)`,
        [
          infrastructure.remoteUserIdentityId,
          fixtureInfrastructure.sourceDeploymentId,
          infrastructure.remoteExternalSubjectId
        ]
      );
      await client.query(
        `insert into device_credentials (
           id, owner_user_id, credential_key_id, upstream_backend_id,
           device_instance_id, lineage_id, verifier_kind, verifier_hash,
           operation_families
         ) values (
           $1, $2, $3, 'fixture-backend', $4, $5, 'secret_hash', $6, $7::text[]
         )`,
        [
          infrastructure.deviceCredentialId,
          owner.id,
          infrastructure.deviceCredentialKeyId,
          `${FIXTURE_VERSION}-${userKey}-device-instance`,
          infrastructure.deviceCredentialLineageId,
          process.env.API_TOKEN_PEPPER?.trim()
            ? fixtureSessionHash(
                fixtureDeviceSecrets[userKey],
                process.env.API_TOKEN_PEPPER
              )
            : fixtureHash(`device-verifier:${userKey}`),
          ["share_grant_management", "team_workspace_read", "sync"]
        ]
      );
    }

    await client.query(
      `insert into team_representation_policies (
         id, policy_id, team_id, version, allowed_representations,
         policy_hash, created_by_user_id, effective_at
       ) values ($1, $2, $3, 1, $4::shared_memory_representation[], $5, $6, $7)`,
      [
        fixtureInfrastructure.teamPolicyRowId,
        fixtureInfrastructure.teamPolicyId,
        fixtureTeam.id,
        ALL_REPRESENTATIONS,
        fixtureHash("policy:team:hash"),
        fixtureUsers.alice.id,
        new Date(FIXTURE_STATE_AT)
      ]
    );
    for (const [workspaceKey, workspace] of Object.entries(fixtureWorkspaces)) {
      const policy = fixtureWorkspacePolicy(workspaceKey);
      await client.query(
        `insert into workspace_representation_policies (
           id, policy_id, team_id, team_workspace_id, version,
           allowed_representations, policy_hash, created_by_user_id,
           effective_at
         ) values (
           $1, $2, $3, $4, 1, $5::shared_memory_representation[], $6, $7, $8
         )`,
        [
          policy.id,
          policy.policyId,
          fixtureTeam.id,
          workspace.id,
          ALL_REPRESENTATIONS,
          fixtureHash(`policy:workspace:${workspaceKey}:hash`),
          fixtureUsers.alice.id,
          new Date(FIXTURE_STATE_AT)
        ]
      );
    }

    for (const memory of fixtureMemoryRows) {
      const owner = fixtureUsers[memory.owner];
      const workspace = fixtureWorkspaces[memory.workspace];
      const metadata = {
        fixture: FIXTURE_VERSION,
        memoryKey: memory.key,
        owner: memory.owner,
        workspace: memory.workspace,
        shareState: memory.shareState,
        workspaceId: workspace.projectId,
        projectName: workspace.name,
        projectPath: workspace.projectId,
        externalSessionId: `${FIXTURE_VERSION}:${memory.key}`,
        threadName: memory.title
      };
      const eventPayload = {
        actor: "user",
        content: memory.content,
        workspaceId: workspace.projectId,
        metadata
      };
      const deletedColumns =
        memory.shareState === "personal_deleted_retained"
          ? {
              personalDeletedAt: "now()",
              personalDeletedByUserId: owner.id,
              personalDeletionReason: "fixture_personal_deleted"
            }
          : null;

      await client.query(
        `
          insert into sessions (
            id,
            owner_user_id,
            visibility,
            external_session_id,
            source_runtime,
            capture_method,
            source_hash,
            idempotency_key,
            cwd,
            metadata,
            personal_deleted_at,
            personal_deleted_by_user_id,
            personal_deletion_reason
          )
          values (
            $1, $2, 'personal', $3, 'codex', 'transcript', $4, $5, $6, $7,
            ${deletedColumns ? "now()" : "null"},
            $8,
            $9
          )
        `,
        [
          memory.sessionId,
          owner.id,
          `${FIXTURE_VERSION}:${memory.key}`,
          memory.sourceHash,
          memory.idempotencyKey,
          workspace.projectId,
          json(metadata),
          deletedColumns?.personalDeletedByUserId ?? null,
          deletedColumns?.personalDeletionReason ?? null
        ]
      );

      await client.query(
        `
          insert into conversation_items (
            id,
            owner_user_id,
            visibility,
            session_id,
            source_kind,
            source_adapter_version,
            source_transport,
            external_session_id,
            external_item_id,
            source_record_type,
            source_event_type,
            raw_json,
            raw_text,
            source_hash,
            idempotency_key,
            canonical_item_key,
            projection_status,
            projection_version,
            projected_at,
            metadata,
            personal_deleted_at,
            personal_deleted_by_user_id,
            personal_deletion_reason
          )
          values (
            $1, $2, 'personal', $3, 'codex', 'fixture-v1', 'synthetic',
            $4, $5, 'message', 'user_prompt', $6, $7, $8, $9,
            $9, 'projected', 'fixture-v1', now(), $10,
            ${deletedColumns ? "now()" : "null"},
            $11,
            $12
          )
        `,
        [
          memory.conversationItemId,
          owner.id,
          memory.sessionId,
          `${FIXTURE_VERSION}:${memory.key}`,
          `${FIXTURE_VERSION}:${memory.key}:item`,
          json({ type: "message", role: "user", content: memory.content }),
          memory.content,
          memory.sourceHash,
          `${memory.idempotencyKey}:conversation-item`,
          json(metadata),
          deletedColumns?.personalDeletedByUserId ?? null,
          deletedColumns?.personalDeletionReason ?? null
        ]
      );

      await client.query(
        `
          insert into messages (
            id,
            session_id,
            owner_user_id,
            visibility,
            role,
            content,
            content_json,
            source_runtime,
            capture_method,
            transcript_item_id,
            idempotency_key,
            source_hash,
            token_count,
            source_event_time,
            captured_at
          )
          values (
            $1, $2, $3, 'personal', 'user', $4, $5, 'codex', 'transcript',
            $6, $7, $8, $9, $10::timestamptz, $10::timestamptz
          )
        `,
        [
          memory.messageId,
          memory.sessionId,
          owner.id,
          memory.content,
          json({ type: "message", role: "user", content: memory.content }),
          String(fixtureMemoryRows.indexOf(memory) + 1),
          `${memory.idempotencyKey}:message`,
          `${memory.sourceHash}:message`,
          Math.ceil(memory.content.length / 4),
          memory.capturedAt
        ]
      );

      await client.query(
        `
          insert into memory_events (
            id,
            actor_user_id,
            owner_user_id,
            visibility,
            event_type,
            source_runtime,
            capture_method,
            session_id,
            idempotency_key,
            source_hash,
            payload,
            token_count,
            source_event_time,
            source_sequence,
            captured_at,
            personal_deleted_at,
            personal_deleted_by_user_id,
            personal_deletion_reason
          )
          values (
            $1, $2, $2, 'personal', 'captured', 'codex', 'transcript', $3,
            $4, $5, $6, $7, $8::timestamptz, $9, $8::timestamptz,
            ${deletedColumns ? "now()" : "null"},
            $10,
            $11
          )
        `,
        [
          memory.eventId,
          owner.id,
          memory.sessionId,
          `${memory.idempotencyKey}:memory-event`,
          memory.sourceHash,
          json(eventPayload),
          Math.ceil(memory.content.length / 4),
          memory.capturedAt,
          fixtureMemoryRows.indexOf(memory) + 1,
          deletedColumns?.personalDeletedByUserId ?? null,
          deletedColumns?.personalDeletionReason ?? null
        ]
      );

      await client.query(
        `
          insert into memory_event_sources (
            memory_event_id,
            conversation_item_id,
            source_order,
            source_role
          )
          values ($1, $2, 0, 'primary')
        `,
        [memory.eventId, memory.conversationItemId]
      );

      await client.query(
        `
          insert into memory_nodes (
            id,
            owner_user_id,
            created_by_user_id,
            visibility,
            kind,
            depth,
            title,
            summary_text,
            body_text,
            source_runtime,
            capture_method,
            idempotency_key,
            source_hash,
            source_items_json,
            source_event_count,
            personal_deleted_at,
            personal_deleted_by_user_id,
            personal_deletion_reason
          )
          values (
            $1, $2, $2, 'personal', $3, $4, $5, $6, $7, 'codex', 'transcript',
            $8, $9, $10, 1,
            ${deletedColumns ? "now()" : "null"},
            $11,
            $12
          )
        `,
        [
          memory.nodeId,
          owner.id,
          memory.representation === "lcm_rollups" ? "rollup" : "leaf",
          memory.representation === "lcm_rollups" ? 1 : 0,
          memory.title,
          memory.content,
          memory.content,
          `${memory.idempotencyKey}:memory-node`,
          memory.sourceHash,
          json([
            {
              kind: "memory_event",
              sourceTable: "memory_events",
              sourceId: memory.eventId,
              visibility: "personal",
              actor: "user",
              createdAt: memory.capturedAt,
              text: memory.content,
              payload: eventPayload,
              position: 0
            },
            {
              kind: "message",
              sourceTable: "messages",
              sourceId: memory.messageId,
              visibility: "personal",
              actor: "user",
              createdAt: memory.capturedAt,
              text: memory.content,
              payload: {
                role: "user",
                content: memory.content,
                metadata
              },
              position: 1
            }
          ]),
          deletedColumns?.personalDeletedByUserId ?? null,
          deletedColumns?.personalDeletionReason ?? null
        ]
      );

      await client.query(
        `
          insert into memory_node_sources (
            memory_node_id,
            memory_event_id,
            message_id,
            source_order,
            source_hash
          )
          values ($1, $2, $3, 0, $4)
        `,
        [memory.nodeId, memory.eventId, memory.messageId, memory.sourceHash]
      );

      await seedSharedMemoryTopology(client, runtime, memory);
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }

  try {
    await seedCollaborationFixture(runtime.collaborationRepository);
  } catch (error) {
    await resetFixture(client).catch(() => {});
    throw error;
  }
};

export const listTeamVisibleShareGrants = async (
  runtime,
  { userKey, workspaceKey }
) => {
  try {
    const page = await runtime.sharedMemoryRepository.listWorkspaceGrants(
      { userId: fixtureUsers[userKey].id },
      {
        teamId: fixtureTeam.id,
        teamWorkspaceId: fixtureWorkspaces[workspaceKey].id,
        limit: 100,
        offset: 0
      }
    );
    if (page.hasMore) {
      throw new Error(
        "Fixture Workspace Share Grant list unexpectedly paginated"
      );
    }
    return page.entries;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "SharedMemoryAuthorizationError"
    ) {
      return [];
    }
    throw error;
  }
};

const grantIdsFor = (rows) => rows.map((row) => row.shareGrantId).sort();
const workspaceAccessFor = (workspaceKey, userKey) =>
  fixtureWorkspaceAccess.find(
    ([candidateWorkspace, candidateUser]) =>
      candidateWorkspace === workspaceKey && candidateUser === userKey
  )?.[2] ?? null;
const expectedTeamVisibleGrantIds = ({ userKey, workspaceKey }) => {
  const access = workspaceAccessFor(workspaceKey, userKey);
  if (access !== "read" && access !== "write") {
    return [];
  }

  return fixtureMemoryRows
    .filter(
      (memory) =>
        memory.workspace === workspaceKey &&
        memory.shareState !== "private" &&
        memory.shareState !== "revoked"
    )
    .map((memory) => memory.shareGrantId)
    .sort();
};
const assertIncludes = (values, value, label) => {
  if (!values.includes(value)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(value)} to be visible`
    );
  }
};
const assertExcludes = (values, value, label) => {
  if (values.includes(value)) {
    throw new Error(`${label}: expected ${JSON.stringify(value)} to be hidden`);
  }
};
const assertDeepEqual = (actual, expected, label) => {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
};
const fixtureMemory = (key) => {
  const memory = fixtureMemoryRows.find((row) => row.key === key);
  if (!memory) {
    throw new Error(`Fixture definition is missing memory ${key}`);
  }
  return memory;
};

const assertCount = async (client, query, params, expected, label) => {
  const result = await client.query(query, params);
  const count = Number(result.rows[0]?.count ?? 0);
  if (count !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${count}`);
  }
};

const assertMemoryState = async (client, key, expected) => {
  const memory = fixtureMemory(key);
  const result = await client.query(
    `
      select
        mn.id as node_id,
        me.id as event_id,
        msg.id as message_id,
        s.id as session_id,
        tssg.id as grant_id,
        tssg.revoked_at is not null as grant_revoked,
        tssg.retained_by_team_at is not null as team_retained,
        mn.personal_deleted_at is not null as node_deleted,
        me.personal_deleted_at is not null as event_deleted,
        s.personal_deleted_at is not null as session_deleted,
        jsonb_path_exists(
          mn.source_items_json,
          '$[*] ? (@.kind == "memory_event" && @.sourceTable == "memory_events")'
        ) as has_event_source_item,
        jsonb_path_exists(
          mn.source_items_json,
          '$[*] ? (@.kind == "message" && @.sourceTable == "messages")'
        ) as has_message_source_item
      from memory_nodes mn
      join memory_node_sources mns on mns.memory_node_id = mn.id
      join memory_events me on me.id = mns.memory_event_id
      join messages msg on msg.id = mns.message_id
      join sessions s on s.id = me.session_id
      left join team_session_share_grants tssg on tssg.session_id = s.id
      where mn.id = $1
    `,
    [memory.nodeId]
  );
  const row = result.rows[0];
  if (!row?.node_id || !row.event_id || !row.message_id || !row.session_id) {
    throw new Error(`${memory.title}: fixture source rows are missing`);
  }
  if (Boolean(row.grant_id) !== expected.hasGrant) {
    throw new Error(`${memory.title}: unexpected Team share grant state`);
  }
  if (Boolean(row.grant_revoked) !== expected.revoked) {
    throw new Error(`${memory.title}: unexpected revoked grant state`);
  }
  if (Boolean(row.team_retained) !== expected.retained) {
    throw new Error(`${memory.title}: unexpected Team retention state`);
  }
  if (Boolean(row.node_deleted) !== expected.personalDeleted) {
    throw new Error(`${memory.title}: unexpected node deletion state`);
  }
  if (Boolean(row.event_deleted) !== expected.personalDeleted) {
    throw new Error(`${memory.title}: unexpected event deletion state`);
  }
  if (Boolean(row.session_deleted) !== expected.personalDeleted) {
    throw new Error(`${memory.title}: unexpected session deletion state`);
  }
  if (!row.has_event_source_item || !row.has_message_source_item) {
    throw new Error(`${memory.title}: source_items_json is not LCM-shaped`);
  }
};

const normalizeSnapshotValue = (value) => {
  if (value instanceof Date) return "<timestamp>";
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
  ) {
    return "<timestamp>";
  }
  if (Array.isArray(value)) return value.map(normalizeSnapshotValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeSnapshotValue(entry)])
    );
  }
  return value;
};

const normalizedRows = (table, rows) => {
  const omitted = {
    collaboration_outbox: new Set(["id", "cursor"]),
    encrypted_field_payloads: new Set(["id"]),
    team_memberships: new Set(["id"])
  }[table];
  const randomized = new Set([
    "ciphertext",
    "ciphertext_hash",
    "nonce",
    "tag",
    "wrapped_dek"
  ]);
  return rows
    .map((row) =>
      normalizeSnapshotValue(
        Object.fromEntries(
          Object.entries(row)
            .filter(([key]) => !omitted?.has(key))
            .map(([key, value]) => [
              key,
              table === "sessions" && key === "logical_session_id"
                ? `<logical-session:${row.external_session_id}>`
                : randomized.has(key)
                  ? "<encrypted>"
                  : value
            ])
        )
      )
    )
    .sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right))
    );
};

export const normalizedFixtureSnapshot = async (client, runtime) => {
  if (!runtime) {
    throw new Error("Fixture runtime is required for normalized snapshots");
  }
  const logicalMemoryIds = fixtureMemoryRows.map(
    (memory) => memory.logicalMemoryId
  );
  const representationIds = fixtureMemoryRows.map(
    (memory) => memory.representationId
  );
  const querySpecs = [
    [
      "users",
      "select * from users where id = any($1::uuid[])",
      [fixtureUserIds]
    ],
    [
      "user_sessions",
      "select * from user_sessions where id = any($1::uuid[])",
      [Object.values(fixtureSessionRows).map((session) => session.id)]
    ],
    ["teams", "select * from teams where id = $1", [fixtureTeam.id]],
    [
      "team_memberships",
      "select * from team_memberships where team_id = $1 and user_id = any($2::uuid[])",
      [fixtureTeam.id, fixtureUserIds]
    ],
    [
      "team_workspaces",
      "select * from team_workspaces where id = any($1::uuid[])",
      [fixtureWorkspaceIds]
    ],
    [
      "team_workspace_access_grants",
      "select * from team_workspace_access_grants where team_workspace_id = any($1::uuid[]) and user_id = any($2::uuid[])",
      [fixtureWorkspaceIds, fixtureUserIds]
    ],
    [
      "deployment_identities",
      "select * from deployment_identities where id = any($1::uuid[])",
      [
        [
          fixtureInfrastructure.sourceDeploymentId,
          fixtureInfrastructure.targetDeploymentId
        ]
      ]
    ],
    [
      "sync_external_user_identities",
      "select * from sync_external_user_identities where id = any($1::uuid[])",
      [
        [...new Set(fixtureMemoryRows.map((memory) => memory.owner))].map(
          (key) => fixtureOwnerInfrastructure(key).remoteUserIdentityId
        )
      ]
    ],
    [
      "device_credentials",
      "select * from device_credentials where id = any($1::uuid[])",
      [
        [...new Set(fixtureMemoryRows.map((memory) => memory.owner))].map(
          (key) => fixtureOwnerInfrastructure(key).deviceCredentialId
        )
      ]
    ],
    [
      "team_representation_policies",
      "select * from team_representation_policies where id = $1",
      [fixtureInfrastructure.teamPolicyRowId]
    ],
    [
      "workspace_representation_policies",
      "select * from workspace_representation_policies where id = any($1::uuid[])",
      [
        Object.keys(fixtureWorkspaces).map(
          (key) => fixtureWorkspacePolicy(key).id
        )
      ]
    ],
    [
      "sessions",
      "select * from sessions where source_hash like $1",
      [`${FIXTURE_SOURCE_HASH_PREFIX}%`]
    ],
    [
      "conversation_items",
      "select * from conversation_items where source_hash like $1",
      [`${FIXTURE_SOURCE_HASH_PREFIX}%`]
    ],
    [
      "messages",
      "select * from messages where source_hash like $1",
      [`${FIXTURE_SOURCE_HASH_PREFIX}%`]
    ],
    [
      "memory_events",
      "select * from memory_events where source_hash like $1",
      [`${FIXTURE_SOURCE_HASH_PREFIX}%`]
    ],
    [
      "memory_event_sources",
      "select * from memory_event_sources where memory_event_id = any($1::uuid[])",
      [fixtureEventIds]
    ],
    [
      "memory_nodes",
      "select * from memory_nodes where source_hash like $1",
      [`${FIXTURE_SOURCE_HASH_PREFIX}%`]
    ],
    [
      "memory_node_sources",
      "select * from memory_node_sources where memory_node_id = any($1::uuid[])",
      [fixtureNodeIds]
    ],
    [
      "logical_memories",
      "select * from logical_memories where id = any($1::uuid[])",
      [logicalMemoryIds]
    ],
    [
      "memory_replicas",
      "select * from memory_replicas where logical_memory_id = any($1::uuid[])",
      [logicalMemoryIds]
    ],
    [
      "cross_identity_sync_relationships",
      "select * from cross_identity_sync_relationships where logical_memory_id = any($1::uuid[])",
      [logicalMemoryIds]
    ],
    [
      "source_owner_representation_policies",
      "select * from source_owner_representation_policies where logical_memory_id = any($1::uuid[])",
      [logicalMemoryIds]
    ],
    [
      "shared_source_artifacts",
      "select * from shared_source_artifacts where logical_memory_id = any($1::uuid[])",
      [logicalMemoryIds]
    ],
    [
      "shared_source_previews",
      "select * from shared_source_previews where logical_memory_id = any($1::uuid[])",
      [logicalMemoryIds]
    ],
    [
      "source_owner_representation_consents",
      "select * from source_owner_representation_consents where logical_memory_id = any($1::uuid[])",
      [logicalMemoryIds]
    ],
    [
      "team_session_share_grants",
      "select * from team_session_share_grants where id = any($1::uuid[])",
      [fixtureShareGrantIds]
    ],
    [
      "team_memory_representations",
      "select * from team_memory_representations where id = any($1::uuid[])",
      [representationIds]
    ],
    [
      "team_memory_representation_chunks",
      "select * from team_memory_representation_chunks where representation_id = any($1::uuid[])",
      [representationIds]
    ],
    [
      "collaboration_threads",
      "select * from collaboration_threads where id = any($1::uuid[])",
      [fixtureThreadIds]
    ],
    [
      "collaboration_participants",
      "select * from collaboration_participants where thread_id = any($1::uuid[])",
      [fixtureThreadIds]
    ],
    [
      "collaboration_messages",
      "select * from collaboration_messages where thread_id = any($1::uuid[])",
      [fixtureThreadIds]
    ],
    [
      "collaboration_read_states",
      "select * from collaboration_read_states where thread_id = any($1::uuid[])",
      [fixtureThreadIds]
    ],
    [
      "collaboration_outbox",
      "select * from collaboration_outbox where thread_id = any($1::uuid[])",
      [fixtureThreadIds]
    ],
    [
      "encrypted_field_payloads",
      `select * from encrypted_field_payloads
       where (source_table = 'collaboration_threads' and source_id = any($1::uuid[]))
          or (source_table = 'collaboration_messages' and source_id in (
            select id from collaboration_messages where thread_id = any($1::uuid[])
          ))
          or (source_table in ('shared_source_artifacts', 'shared_source_previews') and source_id in (
            select id from shared_source_artifacts where logical_memory_id = any($2::uuid[])
            union all
            select id from shared_source_previews where logical_memory_id = any($2::uuid[])
          ))`,
      [fixtureThreadIds, logicalMemoryIds]
    ]
  ];
  const snapshot = {};
  for (const [table, query, params] of querySpecs) {
    const result = await client.query(query, params);
    snapshot[table] = normalizedRows(table, result.rows);
  }
  snapshot.decryptedSharedMemory = [];
  for (const memory of fixtureMemoryRows.filter(
    (candidate) => candidate.shareState !== "private"
  )) {
    const read = await runtime.sharedMemoryRepository.readGrantRepresentation(
      { userId: fixtureUsers.alice.id },
      {
        shareGrantId: memory.shareGrantId,
        representation: memory.representation
      }
    );
    snapshot.decryptedSharedMemory.push(
      normalizeSnapshotValue({
        key: memory.key,
        read
      })
    );
  }
  snapshot.decryptedSharedMemory.sort((left, right) =>
    left.key.localeCompare(right.key)
  );
  return canonicalize(snapshot);
};

export const validateFixture = async (client, runtime) => {
  assertFixtureEnvironment();
  if (!runtime) {
    throw new Error(
      "Fixture runtime is required for encrypted fixture validation"
    );
  }
  const users = await client.query(
    "select count(*)::int as count from users where id = any($1::uuid[])",
    [fixtureUserIds]
  );
  if (users.rows[0]?.count !== fixtureUserIds.length) {
    throw new Error("Fixture users are missing. Run seed first.");
  }

  await assertCount(
    client,
    "select count(*)::int as count from sessions where id = any($1::uuid[])",
    [fixtureSessionIds],
    fixtureMemoryRows.length,
    "Fixture sessions"
  );
  await assertCount(
    client,
    "select count(*)::int as count from messages where id = any($1::uuid[])",
    [fixtureMessageIds],
    fixtureMemoryRows.length,
    "Fixture hook messages"
  );
  await assertCount(
    client,
    "select count(*)::int as count from memory_nodes where id = any($1::uuid[])",
    [fixtureNodeIds],
    fixtureMemoryRows.length,
    "Fixture memory nodes"
  );
  await assertCount(
    client,
    `select count(*)::int as count
     from team_session_share_grants
     where id = any($1::uuid[])`,
    [
      fixtureMemoryRows
        .filter((memory) => memory.shareState !== "private")
        .map((memory) => memory.shareGrantId)
    ],
    fixtureMemoryRows.filter((memory) => memory.shareState !== "private")
      .length,
    "Fixture production-shaped Share Grants"
  );
  await assertCount(
    client,
    `select count(*)::int as count
     from team_memory_representations
     where id = any($1::uuid[])`,
    [
      fixtureMemoryRows
        .filter((memory) => memory.shareState !== "private")
        .map((memory) => memory.representationId)
    ],
    fixtureMemoryRows.filter((memory) => memory.shareState !== "private")
      .length,
    "Fixture encrypted Team representations"
  );
  if (process.env.API_TOKEN_PEPPER?.trim()) {
    await assertCount(
      client,
      `
        select count(*)::int as count
        from user_sessions
        where id = any($1::uuid[])
          and revoked_at is null
          and expires_at > now()
          and expires_at = $2::timestamptz
      `,
      [
        Object.values(fixtureSessionRows).map((session) => session.id),
        FIXTURE_SESSION_EXPIRES_AT
      ],
      fixtureUserIds.length,
      "Fixture API sessions"
    );
  }

  await assertMemoryState(client, "david-electron-revoked-experiment", {
    hasGrant: true,
    revoked: true,
    retained: false,
    personalDeleted: false
  });
  await assertMemoryState(client, "bob-private-devops", {
    hasGrant: false,
    revoked: false,
    retained: false,
    personalDeleted: false
  });
  await assertMemoryState(client, "carol-cloud-retained-deletion", {
    hasGrant: true,
    revoked: false,
    retained: true,
    personalDeleted: true
  });
  await assertMemoryState(client, "bob-cloud-removed-member", {
    hasGrant: true,
    revoked: false,
    retained: true,
    personalDeleted: false
  });

  await assertCount(
    client,
    `select count(*)::int as count
       from team_workspace_access_grants
      where team_workspace_id = $1
        and user_id = $2
        and access = 'write'
        and can_share_owned_memory = true
        and disabled_at is null`,
    [fixtureWorkspaces.electron.id, fixtureUsers.bob.id],
    1,
    "Bob may share owned Memory into the Electron Workspace"
  );
  await assertCount(
    client,
    `
      select count(*)::int as count
      from team_workspace_access_grants
      where team_workspace_id = $1
        and user_id = $2
        and access = 'disabled'
        and disabled_at is not null
    `,
    [fixtureWorkspaces.cloud.id, fixtureUsers.bob.id],
    1,
    "Bob disabled Cloud Workspace access"
  );
  await assertCount(
    client,
    `select count(*)::int as count
     from users u
     join team_memberships tm on tm.user_id = u.id and tm.team_id = $1
     where u.id = $2 and u.disabled_at is not null
       and tm.status = 'disabled' and tm.disabled_at is not null`,
    [fixtureTeam.id, fixtureUsers.dana.id],
    1,
    "Dana disabled User and Team membership"
  );
  await assertCount(
    client,
    `select count(*)::int as count
     from users u
     where u.id = $1
       and not exists (
         select 1 from team_memberships tm
         where tm.team_id = $2 and tm.user_id = u.id
       )`,
    [fixtureUsers.frank.id, fixtureTeam.id],
    1,
    "Frank removed/non-member User"
  );

  const electronForCarol = grantIdsFor(
    await listTeamVisibleShareGrants(runtime, {
      userKey: "carol",
      workspaceKey: "electron"
    })
  );
  assertIncludes(
    electronForCarol,
    fixtureMemory("bob-electron-timeline").shareGrantId,
    "Electron Team App for Carol"
  );
  assertIncludes(
    electronForCarol,
    fixtureMemory("david-electron-agent-rooms").shareGrantId,
    "Electron Team App for Carol"
  );
  assertExcludes(
    electronForCarol,
    fixtureMemory("david-electron-revoked-experiment").shareGrantId,
    "Electron Team App for Carol"
  );
  assertExcludes(
    electronForCarol,
    fixtureMemory("bob-private-devops").shareGrantId,
    "Electron Team App for Carol"
  );

  const cloudForAlice = grantIdsFor(
    await listTeamVisibleShareGrants(runtime, {
      userKey: "alice",
      workspaceKey: "cloud"
    })
  );
  assertIncludes(
    cloudForAlice,
    fixtureMemory("alice-cloud-flat-data").shareGrantId,
    "Cloud Memory Platform for Alice"
  );
  assertIncludes(
    cloudForAlice,
    fixtureMemory("carol-cloud-api-contract").shareGrantId,
    "Cloud Memory Platform for Alice"
  );
  assertIncludes(
    cloudForAlice,
    fixtureMemory("carol-cloud-retained-deletion").shareGrantId,
    "Cloud Memory Platform for Alice"
  );
  assertIncludes(
    cloudForAlice,
    fixtureMemory("bob-cloud-removed-member").shareGrantId,
    "Cloud Memory Platform for Alice"
  );
  assertExcludes(
    cloudForAlice,
    fixtureMemory("alice-private-pricing").shareGrantId,
    "Cloud Memory Platform for Alice"
  );

  const cloudForBob = grantIdsFor(
    await listTeamVisibleShareGrants(runtime, {
      userKey: "bob",
      workspaceKey: "cloud"
    })
  );
  if (cloudForBob.length !== 0) {
    throw new Error(
      `Cloud Memory Platform for Bob: expected no visible memories after Workspace removal, got ${cloudForBob.join(", ")}`
    );
  }

  const ingestionForBob = grantIdsFor(
    await listTeamVisibleShareGrants(runtime, {
      userKey: "bob",
      workspaceKey: "ingestion"
    })
  );
  assertIncludes(
    ingestionForBob,
    fixtureMemory("david-ingestion-fallbacks").shareGrantId,
    "Managed Knowledge Ingestion for Bob"
  );
  assertIncludes(
    ingestionForBob,
    fixtureMemory("carol-ingestion-dedupe").shareGrantId,
    "Managed Knowledge Ingestion for Bob"
  );
  assertIncludes(
    ingestionForBob,
    fixtureMemory("alice-ingestion-product").shareGrantId,
    "Managed Knowledge Ingestion for Bob"
  );
  assertExcludes(
    ingestionForBob,
    fixtureMemory("david-private-agent-prompt").shareGrantId,
    "Managed Knowledge Ingestion for Bob"
  );

  for (const userKey of Object.keys(fixtureUsers)) {
    for (const workspaceKey of Object.keys(fixtureWorkspaces)) {
      const label = `${fixtureWorkspaces[workspaceKey].name} for ${fixtureUsers[userKey].displayName}`;
      const actual = grantIdsFor(
        await listTeamVisibleShareGrants(runtime, { userKey, workspaceKey })
      );
      const expected = expectedTeamVisibleGrantIds({ userKey, workspaceKey });
      assertDeepEqual(actual, expected, `${label} Shared Memory grant list`);
    }
  }

  const expectedItemType = {
    memory_events: "user_message",
    lcm_leaves: "lcm_leaf",
    lcm_rollups: "lcm_rollup"
  };
  for (const memory of fixtureMemoryRows.filter(
    (candidate) => candidate.shareState !== "private"
  )) {
    const read = await runtime.sharedMemoryRepository.readGrantRepresentation(
      { userId: fixtureUsers.alice.id },
      {
        shareGrantId: memory.shareGrantId,
        representation: memory.representation
      }
    );
    if (memory.shareState === "revoked") {
      if (read !== null) {
        throw new Error(`${memory.title}: revoked representation was readable`);
      }
      continue;
    }
    if (!read || read.items.length !== 1) {
      throw new Error(
        `${memory.title}: encrypted representation is unavailable`
      );
    }
    if (read.items[0]?.itemType !== expectedItemType[memory.representation]) {
      throw new Error(`${memory.title}: representation item type is incorrect`);
    }
    const sourceId =
      memory.representation === "memory_events"
        ? memory.eventId
        : memory.nodeId;
    const expectedSourceId = runtime.shared.sharedMemoryGrantScopedSourceId(
      memory.shareGrantId,
      sourceId
    );
    const expectedContent =
      memory.representation === "memory_events"
        ? { text: memory.content }
        : {
            sourceIds: [
              runtime.shared.sharedMemoryGrantScopedSourceId(
                memory.shareGrantId,
                memory.eventId
              )
            ],
            summaryText: memory.content,
            title: memory.title
          };
    assertDeepEqual(
      {
        content: read.items[0].content,
        itemType: read.items[0].itemType,
        occurredAt: read.items[0].occurredAt,
        sourceId: read.items[0].sourceId,
        sourceLogicalMemoryId: read.items[0].sourceLogicalMemoryId,
        sourceRevision: read.items[0].sourceRevision
      },
      {
        content: expectedContent,
        itemType: expectedItemType[memory.representation],
        occurredAt: memory.capturedAt,
        sourceId: expectedSourceId,
        sourceLogicalMemoryId: memory.logicalMemoryId,
        sourceRevision: 1
      },
      `${memory.title} decrypted Shared Memory truth`
    );
    assertDeepEqual(
      {
        activeRepresentation: read.grant.activeRepresentation,
        consentId: read.grant.consentId,
        id: read.grant.id,
        logicalMemoryId: read.grant.logicalMemoryId,
        ownerPrincipalId: read.grant.ownerPrincipalId,
        teamId: read.grant.teamId,
        teamWorkspaceId: read.grant.teamWorkspaceId
      },
      {
        activeRepresentation: memory.representation,
        consentId: memory.consentId,
        id: memory.shareGrantId,
        logicalMemoryId: memory.logicalMemoryId,
        ownerPrincipalId: memory.ownerPrincipalId,
        teamId: fixtureTeam.id,
        teamWorkspaceId: fixtureWorkspaces[memory.workspace].id
      },
      `${memory.title} decrypted Shared Memory grant binding`
    );
    if (read.grant.activeRepresentation !== memory.representation) {
      throw new Error(`${memory.title}: Share Grant representation drifted`);
    }
  }

  const denialActors = [
    ["dana", (memory) => memory.shareState !== "private"],
    ["frank", (memory) => memory.shareState !== "private"],
    ["bob", (memory) => memory.workspace === "cloud"],
    ["erin", (memory) => memory.workspace === "cloud"]
  ];
  for (const [userKey, includesMemory] of denialActors) {
    for (const memory of fixtureMemoryRows.filter(includesMemory)) {
      const denied =
        await runtime.sharedMemoryRepository.readGrantRepresentation(
          { userId: fixtureUsers[userKey].id },
          {
            shareGrantId: memory.shareGrantId,
            representation: memory.representation
          }
        );
      if (denied !== null) {
        throw new Error(
          `${fixtureUsers[userKey].displayName} unexpectedly read ${memory.title}`
        );
      }
    }
  }

  const personalThreads = await runtime.collaborationRepository.listThreads(
    { userId: fixtureUsers.alice.id },
    { scope: "personal", limit: 20 }
  );
  const teamThreads = await runtime.collaborationRepository.listThreads(
    { userId: fixtureUsers.alice.id },
    { scope: "team", teamId: fixtureTeam.id, limit: 50 }
  );
  if (!personalThreads || !teamThreads) {
    throw new Error("Fixture collaboration snapshots are unavailable");
  }
  assertDeepEqual(
    [...new Set(personalThreads.map((thread) => thread.kind))].sort(),
    ["notes_to_self", "personal_channel"],
    "Personal collaboration thread kinds"
  );
  assertDeepEqual(
    [...new Set(teamThreads.map((thread) => thread.kind))].sort(),
    ["dm", "group_dm", "shared_session_discussion", "workspace_channel"],
    "Team collaboration thread kinds"
  );
  assertDeepEqual(
    [...personalThreads, ...teamThreads].map((thread) => thread.id).sort(),
    fixtureThreadIds.slice().sort(),
    "Deterministic collaboration thread IDs"
  );
  const threadByKey = Object.fromEntries(
    fixtureThreadRows.map((thread) => [thread.key, thread])
  );
  const teamThreadIdsFor = async (userKey) => {
    const rows = await runtime.collaborationRepository.listThreads(
      { userId: fixtureUsers[userKey].id },
      { scope: "team", teamId: fixtureTeam.id, limit: 50 }
    );
    return rows?.map((thread) => thread.id).sort() ?? null;
  };
  assertDeepEqual(
    await teamThreadIdsFor("bob"),
    [
      threadByKey["alice-bob-dm"].id,
      threadByKey["electron-product-channel"].id,
      threadByKey["launch-group-dm"].id,
      threadByKey["timeline-companion"].id
    ].sort(),
    "Bob Team collaboration participant isolation"
  );
  assertDeepEqual(
    await teamThreadIdsFor("carol"),
    [
      threadByKey["electron-product-channel"].id,
      threadByKey["launch-group-dm"].id,
      threadByKey["timeline-companion"].id
    ].sort(),
    "Carol DM participant isolation"
  );
  assertDeepEqual(
    await teamThreadIdsFor("david"),
    [
      threadByKey["electron-product-channel"].id,
      threadByKey["timeline-companion"].id
    ].sort(),
    "David group-DM participant isolation"
  );
  assertDeepEqual(
    await teamThreadIdsFor("erin"),
    [
      threadByKey["electron-product-channel"].id,
      threadByKey["timeline-companion"].id
    ].sort(),
    "Erin direct-message participant isolation"
  );
  for (const [userKey, threadKey] of [
    ["carol", "alice-bob-dm"],
    ["david", "launch-group-dm"],
    ["bob", "alice-notes"],
    ["bob", "alice-personal-release-notes"]
  ]) {
    const actor = { userId: fixtureUsers[userKey].id };
    const threadId = threadByKey[threadKey].id;
    const directThread = await runtime.collaborationRepository.getThread(
      actor,
      {
        threadId
      }
    );
    const directMessages = await runtime.collaborationRepository.listMessages(
      actor,
      { threadId, limit: 20 }
    );
    if (directThread !== null || directMessages !== null) {
      throw new Error(
        `${fixtureUsers[userKey].displayName} bypassed ${threadKey} isolation`
      );
    }
  }
  const bobPersonalThreads = await runtime.collaborationRepository.listThreads(
    { userId: fixtureUsers.bob.id },
    { scope: "personal", limit: 20 }
  );
  if (!bobPersonalThreads || bobPersonalThreads.length !== 0) {
    throw new Error("Bob unexpectedly received Alice's personal threads");
  }
  if (
    (await runtime.collaborationRepository.listThreads(
      { userId: fixtureUsers.dana.id },
      { scope: "team", teamId: fixtureTeam.id, limit: 20 }
    )) !== null
  ) {
    throw new Error("Disabled Dana unexpectedly received Team threads");
  }
  if (
    (await runtime.collaborationRepository.listThreads(
      { userId: fixtureUsers.frank.id },
      { scope: "team", teamId: fixtureTeam.id, limit: 20 }
    )) !== null
  ) {
    throw new Error("Non-member Frank unexpectedly received Team threads");
  }
  const erinThreads = await runtime.collaborationRepository.listThreads(
    { userId: fixtureUsers.erin.id },
    { scope: "team", teamId: fixtureTeam.id, limit: 20 }
  );
  const electronChannel = teamThreads.find(
    (thread) =>
      thread.kind === "workspace_channel" &&
      thread.teamWorkspaceId === fixtureWorkspaces.electron.id
  );
  if (
    !erinThreads ||
    !electronChannel ||
    !erinThreads.some((thread) => thread.id === electronChannel.id)
  ) {
    throw new Error(
      "Read-only Erin cannot read the Electron Workspace channel"
    );
  }
  const deniedReadOnlySend = await runtime.collaborationRepository.sendMessage(
    { userId: fixtureUsers.erin.id },
    {
      threadId: electronChannel.id,
      idempotencyKey: `${FIXTURE_VERSION}:denied-read-only-send`,
      bodyText: "This fixture message must never be stored."
    }
  );
  if (deniedReadOnlySend !== null) {
    throw new Error("Read-only Erin unexpectedly wrote to a Workspace channel");
  }
  const companion = teamThreads.find(
    (thread) => thread.kind === "shared_session_discussion"
  );
  if (!companion || companion.unreadCount !== 1) {
    throw new Error("Fixture companion discussion unread state is incorrect");
  }
  const companionHistory = await runtime.collaborationRepository.listMessages(
    { userId: fixtureUsers.alice.id },
    { threadId: companion.id, limit: 20 }
  );
  if (!companionHistory || companionHistory.messages.length !== 2) {
    throw new Error("Fixture companion discussion history is missing");
  }

  const fixtureMessages = await client.query(
    `select id, thread_id, thread_sequence
     from collaboration_messages
     where thread_id = any($1::uuid[])
     order by thread_id, thread_sequence`,
    [fixtureThreadIds]
  );
  const expectedMessageCount = fixtureThreads.reduce(
    (count, thread) => count + thread.messages.length,
    0
  );
  if (fixtureMessages.rows.length !== expectedMessageCount) {
    throw new Error(
      `Fixture collaboration messages: expected ${expectedMessageCount}, got ${fixtureMessages.rows.length}`
    );
  }
  const encryptedCoverage = await client.query(
    `select source_table, source_id, source_column, encryption_scope,
            owner_user_id, team_id, team_workspace_id
     from encrypted_field_payloads
     where invalidated_at is null
       and (
         (source_table = 'collaboration_threads'
          and source_id = any($1::uuid[]))
         or
         (source_table = 'collaboration_messages'
          and source_id = any($2::uuid[]))
         or
         (source_table in ('shared_source_artifacts', 'shared_source_previews')
          and source_id in (
            select id from shared_source_artifacts
            where logical_memory_id = any($3::uuid[])
            union all
            select id from shared_source_previews
            where logical_memory_id = any($3::uuid[])
          ))
       )
     order by source_table, source_id, source_column`,
    [
      fixtureThreadIds,
      fixtureMessages.rows.map((row) => row.id),
      fixtureMemoryRows.map((memory) => memory.logicalMemoryId)
    ]
  );
  const payloadsBySource = new Map();
  for (const row of encryptedCoverage.rows) {
    const key = `${row.source_table}:${row.source_id}`;
    const columns = payloadsBySource.get(key) ?? [];
    columns.push(row.source_column);
    payloadsBySource.set(key, columns);
  }
  for (const thread of fixtureThreadRows) {
    const expectedColumns = [
      ...(thread.name ? ["name"] : []),
      ...(thread.topic ? ["topic"] : [])
    ].sort();
    assertDeepEqual(
      (payloadsBySource.get(`collaboration_threads:${thread.id}`) ?? []).sort(),
      expectedColumns,
      `${thread.key} encrypted thread field coverage`
    );
  }
  for (const message of fixtureMessages.rows) {
    assertDeepEqual(
      (
        payloadsBySource.get(`collaboration_messages:${message.id}`) ?? []
      ).sort(),
      ["body", "metadata", "provenance"],
      `${message.id} encrypted message field coverage`
    );
  }
  const sharedMemories = fixtureMemoryRows.filter(
    (memory) => memory.shareState !== "private"
  );
  for (const memory of sharedMemories) {
    const sharedRows = await client.query(
      `select 'shared_source_artifacts' as source_table, id
       from shared_source_artifacts where logical_memory_id = $1
       union all
       select 'shared_source_previews' as source_table, id
       from shared_source_previews where logical_memory_id = $1`,
      [memory.logicalMemoryId]
    );
    assertDeepEqual(
      sharedRows.rows
        .map((row) => ({
          column:
            row.source_table === "shared_source_artifacts"
              ? "artifact"
              : "preview",
          table: row.source_table
        }))
        .sort((left, right) => left.table.localeCompare(right.table)),
      [
        { column: "artifact", table: "shared_source_artifacts" },
        { column: "preview", table: "shared_source_previews" }
      ],
      `${memory.title} Shared Memory encrypted source rows`
    );
    for (const row of sharedRows.rows) {
      assertDeepEqual(
        payloadsBySource.get(`${row.source_table}:${row.id}`) ?? [],
        [
          row.source_table === "shared_source_artifacts"
            ? "artifact"
            : "preview"
        ],
        `${memory.title} ${row.source_table} encrypted payload coverage`
      );
    }
  }
  const expectedEncryptedPayloadCount =
    fixtureThreadRows.reduce(
      (count, thread) =>
        count + Number(Boolean(thread.name)) + Number(Boolean(thread.topic)),
      0
    ) +
    expectedMessageCount * 3 +
    sharedMemories.length * 2;
  if (encryptedCoverage.rows.length !== expectedEncryptedPayloadCount) {
    throw new Error(
      `Fixture encrypted payload coverage: expected ${expectedEncryptedPayloadCount}, got ${encryptedCoverage.rows.length}`
    );
  }
  const representationChunks = await client.query(
    `select representation_id, share_grant_id, team_id, team_workspace_id,
            logical_memory_id, chunk_index, aad
     from team_memory_representation_chunks
     where id = any($1::uuid[])
     order by representation_id, chunk_index`,
    [sharedMemories.map((memory) => memory.representationChunkId)]
  );
  if (representationChunks.rows.length !== sharedMemories.length) {
    throw new Error("Fixture encrypted Team representation chunks are missing");
  }
  for (const memory of sharedMemories) {
    const chunk = representationChunks.rows.find(
      (row) => row.representation_id === memory.representationId
    );
    assertDeepEqual(
      {
        chunkIndex: chunk?.chunk_index,
        consentId: chunk?.aad?.consentId,
        logicalMemoryId: chunk?.logical_memory_id,
        representation: chunk?.aad?.representation,
        representationId: chunk?.representation_id,
        shareGrantId: chunk?.share_grant_id,
        teamId: chunk?.team_id,
        teamWorkspaceId: chunk?.team_workspace_id
      },
      {
        chunkIndex: 0,
        consentId: memory.consentId,
        logicalMemoryId: memory.logicalMemoryId,
        representation: memory.representation,
        representationId: memory.representationId,
        shareGrantId: memory.shareGrantId,
        teamId: fixtureTeam.id,
        teamWorkspaceId: fixtureWorkspaces[memory.workspace].id
      },
      `${memory.title} encrypted chunk binding`
    );
  }
  const rawStorage = await client.query(
    `select concat_ws(E'\n',
       coalesce((select string_agg(row_to_json(row_data)::text, E'\n')
         from (select * from collaboration_threads where id = any($1::uuid[])) row_data), ''),
       coalesce((select string_agg(row_to_json(row_data)::text, E'\n')
         from (select * from collaboration_messages where thread_id = any($1::uuid[])) row_data), ''),
       coalesce((select string_agg(row_to_json(row_data)::text, E'\n')
         from (select * from collaboration_outbox where thread_id = any($1::uuid[])) row_data), ''),
       coalesce((select string_agg(row_to_json(row_data)::text, E'\n')
         from (select * from encrypted_field_payloads
               where source_id = any($2::uuid[])
                  or source_id = any($3::uuid[])
                  or source_id in (
                    select id from shared_source_artifacts
                    where logical_memory_id = any($4::uuid[])
                    union all
                    select id from shared_source_previews
                    where logical_memory_id = any($4::uuid[])
                  )) row_data), ''),
       coalesce((select string_agg(row_to_json(row_data)::text, E'\n')
         from (select * from shared_source_artifacts where logical_memory_id = any($4::uuid[])) row_data), ''),
       coalesce((select string_agg(row_to_json(row_data)::text, E'\n')
         from (select * from shared_source_previews where logical_memory_id = any($4::uuid[])) row_data), ''),
       coalesce((select string_agg(row_to_json(row_data)::text, E'\n')
         from (select * from team_memory_representations where share_grant_id = any($5::uuid[])) row_data), ''),
       coalesce((select string_agg(row_to_json(row_data)::text, E'\n')
         from (select * from team_memory_representation_chunks where share_grant_id = any($5::uuid[])) row_data), '')
     ) as raw`,
    [
      fixtureThreadIds,
      fixtureThreadIds,
      fixtureMessages.rows.map((row) => row.id),
      sharedMemories.map((memory) => memory.logicalMemoryId),
      sharedMemories.map((memory) => memory.shareGrantId)
    ]
  );
  const rawText = String(rawStorage.rows[0]?.raw ?? "");
  const sensitiveValues = [
    ...fixtureThreads.flatMap((thread) => [
      thread.name,
      thread.topic,
      thread.key,
      ...thread.messages.map(([, body]) => body)
    ]),
    ...fixtureMemoryRows.flatMap((memory) => [memory.title, memory.content])
  ].filter(Boolean);
  for (const value of sensitiveValues) {
    if (rawText.includes(value)) {
      throw new Error(
        `Fixture sensitive plaintext leaked to collaboration/shared storage: ${JSON.stringify(value)}`
      );
    }
  }
  const outbox = await client.query(
    `select family, resource_type, thread_id, message_id
     from collaboration_outbox
     where thread_id = any($1::uuid[])
     order by family, resource_type, thread_id, message_id nulls first`,
    [fixtureThreadIds]
  );
  const expectedOutboxCount =
    fixtureThreadRows.length +
    expectedMessageCount +
    fixtureThreadRows.filter((thread) => thread.readThrough).length;
  if (outbox.rows.length !== expectedOutboxCount) {
    throw new Error(
      `Fixture collaboration outbox: expected ${expectedOutboxCount}, got ${outbox.rows.length}`
    );
  }

  return {
    users: fixtureUserIds.length,
    workspaces: fixtureWorkspaceIds.length,
    memories: fixtureMemoryRows.length,
    threads: personalThreads.length + teamThreads.length,
    threadIds: [...personalThreads, ...teamThreads]
      .map((thread) => thread.id)
      .sort(),
    checks: [
      "Fixture rows exist before visibility exclusions are checked",
      "Reusable local-only test bearer sessions are deterministic and active when API_TOKEN_PEPPER is configured",
      "Workspace Share Grant lists hide revoked and private memories",
      "Shared Memory representation timelines and detail preserve redacted source items",
      "Workspace Share Grant listing matches the full user and Workspace truth matrix",
      "Cloud includes retained Team knowledge after personal deletion",
      "Cloud blocks Bob after Workspace removal",
      "Disabled, non-member, and Workspace-denied principals cannot decrypt Shared Memory",
      "Workspace access removal does not delete Team-retained source rows",
      "Managed Knowledge Ingestion hides private agent prompt scratchpad",
      "API-session-backed fixture users support remote browser validation",
      "Disabled and removed/non-member Users cannot read Team collaboration",
      "Read-only Workspace access permits collaboration reads but denies writes",
      "Personal self-chat/channel and every Team thread kind are present",
      "DM, group-DM, and personal-thread direct reads enforce participant isolation",
      "Shared Memory representations decrypt through the authorized production path",
      "Companion discussion history and unread state are deterministic",
      "Collaboration names, topics, bodies, metadata, and provenance have exact encrypted payload coverage",
      "Shared source artifacts, previews, chunks, bindings, and outbox surfaces contain no sensitive plaintext"
    ]
  };
};
