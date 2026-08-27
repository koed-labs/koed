import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

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

const FIXTURE_MAXIMUM_FIDELITY = "memory_events";
const FIXTURE_INCLUDE_CURATED_MEMORY = true;

const FIXTURE_PERSONAL_ENCRYPTION_KEY = Buffer.alloc(32, 70).toString("base64");
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

export const fixtureWorkspaceShareOwnedMemoryAccess = [
  ["electron", "bob"],
  ["electron", "david"],
  ["cloud", "alice"],
  ["cloud", "carol"],
  ["ingestion", "alice"],
  ["ingestion", "carol"],
  ["ingestion", "david"]
];

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
    key: "carol-cloud-curated-retrieval",
    owner: "carol",
    workspace: "cloud",
    title: "Team Recall Provenance Contract",
    content:
      "Carol confirmed that practical Team semantic recall must preserve encrypted grant-scoped provenance from the source Memory Event through LCM leaf and rollup expansion.",
    assertionText:
      "Team semantic recall preserves grant-scoped source fidelity across Memory Events, LCM leaves, LCM rollups, and Curated Memory assertions.",
    tags: ["team-recall", "provenance", "curated-memory"],
    representation: "curated_assertions",
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
  leafNodeId:
    memory.representation === "curated_assertions"
      ? fixtureUuid(`memory:${memory.key}:leaf-node`)
      : null,
  curatedAssertionId:
    memory.representation === "curated_assertions"
      ? fixtureUuid(`memory:${memory.key}:curated-assertion`)
      : null,
  curatedTopicId:
    memory.representation === "curated_assertions"
      ? fixtureUuid(`memory:${memory.key}:curated-topic`)
      : null,
  summaryEmbeddingRevision: fixtureUuid(
    `memory:${memory.key}:summary-embedding-revision`
  ),
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

export const FIXTURE_SOURCE_PRIVACY_CANARY = Object.freeze({
  email: "alice.smith@example.com",
  apiKey: "sk-abcdefghijklmnopqrstuv"
});

export const fixtureConversationSources = [
  {
    key: "timeline-continuous-source",
    memoryKey: "bob-electron-timeline",
    mode: "continuous",
    lifecycle: "active",
    maximumSegmentIndex: null,
    segments: [
      [
        {
          type: "response_item",
          payload: {
            role: "user",
            content: `Show the Workspace timeline. Contact ${FIXTURE_SOURCE_PRIVACY_CANARY.email} using api_key=${FIXTURE_SOURCE_PRIVACY_CANARY.apiKey}.`
          }
        }
      ],
      [{ type: "event_msg", payload: { type: "task_complete" } }]
    ]
  },
  {
    key: "agent-rooms-snapshot-source",
    memoryKey: "david-electron-agent-rooms",
    mode: "snapshot",
    lifecycle: "active",
    maximumSegmentIndex: 0,
    segments: [
      [{ type: "event_msg", payload: { type: "task_complete" } }],
      [
        {
          type: "response_item",
          payload: {
            role: "user",
            content: "This later source record is outside the snapshot grant."
          }
        }
      ]
    ]
  },
  {
    key: "revoked-experiment-source",
    memoryKey: "david-electron-revoked-experiment",
    mode: "continuous",
    lifecycle: "revoked",
    maximumSegmentIndex: null,
    segments: [[{ type: "event_msg", payload: { type: "task_complete" } }]]
  }
].map((source) => ({
  ...source,
  id: fixtureUuid(`conversation-source:${source.key}:grant`),
  artifactId: fixtureUuid(`conversation-source:${source.key}:artifact`),
  logicalSourceId: fixtureUuid(`conversation-source:${source.key}:logical`),
  sourceGenerationId: fixtureUuid(
    `conversation-source:${source.key}:generation`
  ),
  originKeyId: fixtureUuid(`conversation-source:${source.key}:origin-key`),
  mutationId: fixtureUuid(`conversation-source:${source.key}:mutation`),
  segmentIds: source.segments.map((_, index) =>
    fixtureUuid(`conversation-source:${source.key}:segment:${index}`)
  )
}));

const fixtureConversationSourcePrivateKey = () => {
  const seed = Buffer.from(
    fixtureHash("conversation-source:origin-key"),
    "hex"
  );
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return createPrivateKey({
    key: Buffer.concat([prefix, seed]),
    format: "der",
    type: "pkcs8"
  });
};

export const fixtureThreads = [
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
    shared.createTeamMemoryEnvelopeEncryptionProviderFromEnvironment({
      environment
    });
  const configuredOwnerProvider =
    shared.createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment({
      environment
    });
  const configuredPersonalProvider =
    shared.createEnvelopeEncryptionProviderFromEnvironment({ environment });
  if (
    new Set([
      Boolean(configuredTeamProvider),
      Boolean(configuredOwnerProvider),
      Boolean(configuredPersonalProvider)
    ]).size !== 1
  ) {
    throw new Error(
      "Fixture seeding requires Personal, Team Memory, and owner-private deployment encryption providers together"
    );
  }
  const personalProvider =
    configuredPersonalProvider ??
    shared.createLocalTestKeyEnvelopeEncryptionProvider(
      FIXTURE_PERSONAL_ENCRYPTION_KEY
    );
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
  if (
    new Set([personalProvider.keyId, ownerProvider.keyId, teamProvider.keyId])
      .size !== 3
  ) {
    throw new Error(
      "Fixture Personal, Team Memory, and owner-private encryption providers must use distinct keys"
    );
  }
  return {
    shared,
    privacyRepository: db.createPrivacyClassificationRepository(pool, {
      fingerprintKey: Buffer.alloc(32, 73)
    }),
    sharedMemorySanitizedSemanticProvenanceHash:
      db.sharedMemorySanitizedSemanticProvenanceHash,
    sharedMemoryDeviceProvenanceHash: db.sharedMemoryDeviceProvenanceHash,
    sharedMemorySanitizedSemanticSourceBinding:
      db.sharedMemorySanitizedSemanticSourceBinding,
    sharedMemorySanitizedDisplayTitle: db.sharedMemorySanitizedDisplayTitle,
    sharedMemorySanitizedSemanticSourceRevisionHash:
      db.sharedMemorySanitizedSemanticSourceRevisionHash,
    sharedMemorySemanticEmbeddingSourceBinding:
      db.sharedMemorySemanticEmbeddingSourceBinding,
    sharedMemorySemanticPreviewPayloadBindingHash:
      db.sharedMemorySemanticPreviewPayloadBindingHash,
    sharedMemorySourceItemIdentityHash: db.sharedMemorySourceItemIdentityHash,
    composeSharedMemorySemanticText: db.composeSharedMemorySemanticText,
    upsertEncryptedFieldPayloadWithClient:
      encryptedPayloads.upsertEncryptedFieldPayloadWithClient,
    personalProvider,
    ownerProvider,
    teamProvider,
    collaborationRepository: db.createCollaborationRepository(pool, {
      envelopeEncryptionProvider: teamProvider
    }),
    teamConversationSourceRepository:
      db.createTeamConversationSourceRepository(pool),
    sharedMemoryRepository: db.createSharedMemoryRepository(pool, {
      resolvePersonalEncryptionProvider: () => personalProvider,
      resolveTeamEncryptionProvider: () => teamProvider,
      resolveOwnerPrivateReplicaEncryptionProvider: () => ownerProvider
    })
  };
};

const ensureFixturePrivacyRuntime = async (client, runtime) => {
  let deploymentIdentityId =
    await runtime.privacyRepository.getLocalDeploymentIdentityId();
  if (!deploymentIdentityId) {
    deploymentIdentityId = fixtureUuid("deployment:privacy-local");
    await client.query(
      `insert into deployment_identities (
         id, protocol_deployment_id, locality, profile, display_name
       ) values ($1,$2,'local','developer','Fixture local deployment')
       on conflict (id) do nothing`,
      [deploymentIdentityId, fixtureUuid("deployment:privacy-local:protocol")]
    );
  }
  const generation =
    await runtime.privacyRepository.registerClassifierGeneration({
      ...runtime.shared.PINNED_PRIVACY_CLASSIFIER_GENERATION,
      classifierHash: runtime.shared.PINNED_PRIVACY_CLASSIFIER_HASH
    });
  const classifier =
    await runtime.privacyRepository.activateClassifierGeneration(generation.id);
  let policy;
  try {
    policy = await runtime.privacyRepository.resolveEffectiveContentPolicy({
      deploymentIdentityId
    });
  } catch {
    await runtime.privacyRepository.createContentPolicyVersion({
      scope: "deployment",
      subject: { deploymentIdentityId },
      labels: runtime.shared.allPrivacyLabelsPolicy(),
      expectedPreviousVersion: 0
    });
    policy = await runtime.privacyRepository.resolveEffectiveContentPolicy({
      deploymentIdentityId
    });
  }
  return { classifier, policy };
};

const json = (value) => JSON.stringify(value);
const fixtureSessionHash = (secret, pepper) =>
  createHash("sha256").update(`${pepper}${secret}`).digest("hex");

const seedCuratedPersonalMemory = async (client, runtime, memory) => {
  if (memory.representation !== "curated_assertions") return;
  const owner = fixtureUsers[memory.owner];
  const actor = { userId: owner.id };
  const encryptedText = "[koed encrypted curated memory]";
  const encryptedJson = json({ contentEncrypted: true });
  const normalizedAssertion = memory.assertionText.toLowerCase();
  const normalizedTopic = memory.title.toLowerCase();

  const personalSourceFields = [
    {
      sourceTable: "conversation_items",
      sourceId: memory.conversationItemId,
      sourceColumn: "raw_text",
      plaintext: memory.content,
      rowFamily: "conversation_item",
      aad: { conversationItemId: memory.conversationItemId }
    },
    {
      sourceTable: "memory_events",
      sourceId: memory.eventId,
      sourceColumn: "payload",
      plaintext: {
        actor: "user",
        content: memory.content,
        workspaceId: fixtureWorkspaces[memory.workspace].projectId,
        metadata: { fixture: FIXTURE_VERSION, memoryKey: memory.key }
      },
      rowFamily: "memory_event",
      aad: { memoryEventId: memory.eventId }
    },
    ...[memory.leafNodeId, memory.nodeId].map((nodeId) => ({
      sourceTable: "memory_nodes",
      sourceId: nodeId,
      sourceColumn: "summary_text",
      plaintext: memory.content,
      rowFamily: "memory_node",
      aad: { nodeId }
    }))
  ];
  for (const sourceField of personalSourceFields) {
    await runtime.upsertEncryptedFieldPayloadWithClient(
      client,
      actor,
      runtime.personalProvider,
      {
        ...sourceField,
        visibility: "personal",
        scope: {
          tenantId: owner.id,
          objectClass: sourceField.rowFamily
        }
      }
    );
  }
  await client.query(
    `insert into curated_memory_topics (
       id,owner_user_id,visibility,title,normalized_title
     ) values ($1,$2,'personal',$3,$4)`,
    [
      memory.curatedTopicId,
      owner.id,
      encryptedText,
      `encrypted:${fixtureHash(`memory:${memory.key}:curated-topic`)}`
    ]
  );
  await client.query(
    `insert into curated_memory_assertions (
       id,owner_user_id,visibility,topic_id,assertion_text,
       normalized_assertion,status,sensitivity,confidence,tags,metadata,
       observed_at,reconciliation_status,last_reconciled_at
     ) values (
       $1,$2,'personal',$3,$4,$5,'current','normal',95,'{}',$6::jsonb,
       $7,'reconciled',$7
     )`,
    [
      memory.curatedAssertionId,
      owner.id,
      memory.curatedTopicId,
      encryptedText,
      `encrypted:${fixtureHash(`memory:${memory.key}:curated-assertion`)}`,
      encryptedJson,
      memory.capturedAt
    ]
  );

  const sources = [
    ["conversation_item", "primary_evidence", memory.conversationItemId],
    ["memory_event", "supporting_evidence", memory.eventId],
    ["lcm_summary", "supporting_evidence", memory.leafNodeId],
    ["lcm_summary", "supporting_evidence", memory.nodeId]
  ];
  for (const [sourceType, sourceRole, sourceId] of sources) {
    const curatedSourceId = fixtureUuid(
      `memory:${memory.key}:curated-source:${sourceType}:${sourceId}`
    );
    await client.query(
      `insert into curated_memory_sources (
         id,assertion_id,source_type,source_role,conversation_item_id,
         memory_event_id,lcm_node_id,metadata
       ) values (
         $1,$2,$3::curated_memory_source_type,$4::curated_memory_source_role,
         case when $3::text='conversation_item' then $5::uuid else null end,
         case when $3::text='memory_event' then $5::uuid else null end,
         case when $3::text='lcm_summary' then $5::uuid else null end,
         $6::jsonb
       )`,
      [
        curatedSourceId,
        memory.curatedAssertionId,
        sourceType,
        sourceRole,
        sourceId,
        encryptedJson
      ]
    );
    await runtime.upsertEncryptedFieldPayloadWithClient(
      client,
      actor,
      runtime.personalProvider,
      {
        sourceTable: "curated_memory_sources",
        sourceId: curatedSourceId,
        sourceColumn: "payload",
        plaintext: {
          metadata: {
            fixture: FIXTURE_VERSION,
            evidenceKind: sourceType,
            exactSessionId: memory.sessionId
          }
        },
        visibility: "personal",
        rowFamily: "curated_memory",
        scope: { tenantId: owner.id, objectClass: "curated_memory_sources" },
        aad: { curatedMemoryId: curatedSourceId }
      }
    );
  }

  for (const payload of [
    {
      sourceTable: "curated_memory_topics",
      sourceId: memory.curatedTopicId,
      plaintext: { title: memory.title, normalizedTitle: normalizedTopic }
    },
    {
      sourceTable: "curated_memory_assertions",
      sourceId: memory.curatedAssertionId,
      plaintext: {
        assertionText: memory.assertionText,
        normalizedAssertion,
        tags: memory.tags,
        metadata: {
          fixture: FIXTURE_VERSION,
          provenance: "exact_session_direct_sources"
        },
        suppressionReason: null
      }
    }
  ]) {
    await runtime.upsertEncryptedFieldPayloadWithClient(
      client,
      actor,
      runtime.personalProvider,
      {
        ...payload,
        sourceColumn: "payload",
        visibility: "personal",
        rowFamily: "curated_memory",
        scope: { tenantId: owner.id, objectClass: payload.sourceTable },
        aad: { curatedMemoryId: payload.sourceId }
      }
    );
  }
};

const seedSharedMemoryTopology = async (client, runtime, memory) => {
  if (memory.shareState === "private") return;
  const owner = fixtureUsers[memory.owner];
  const workspace = fixtureWorkspaces[memory.workspace];
  const ownerInfrastructure = fixtureOwnerInfrastructure(memory.owner);
  const workspacePolicy = fixtureWorkspacePolicy(memory.workspace);
  const maximumFidelity =
    memory.representation === "curated_assertions"
      ? "memory_events"
      : memory.representation;
  const includeCuratedMemory = memory.representation === "curated_assertions";
  const ownerPolicyHash = fixtureHash(`policy:owner:${memory.key}:hash`);
  const teamPolicyHash = fixtureHash("policy:team:hash");
  const workspacePolicyHash = fixtureHash(
    `policy:workspace:${memory.workspace}:hash`
  );
  const fidelityPolicyHash = runtime.shared.crossIdentitySyncDigest({
    kind: "shared_memory_fidelity_policy",
    maximumFidelity,
    includeCuratedMemory,
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
  const contentPolicyHash = runtime.fixturePrivacy.policy.effectivePolicyHash;
  const classifierHash = runtime.fixturePrivacy.classifier.classifierHash;
  const classifierGenerationId = runtime.fixturePrivacy.classifier.id;
  const classifierVersion = runtime.fixturePrivacy.classifier.version;
  const sourceId =
    memory.representation === "memory_events"
      ? memory.eventId
      : memory.representation === "curated_assertions"
        ? memory.curatedAssertionId
        : memory.nodeId;
  const itemType =
    memory.representation === "memory_events"
      ? "user_message"
      : memory.representation === "lcm_leaves"
        ? "lcm_leaf"
        : memory.representation === "lcm_rollups"
          ? "lcm_rollup"
          : "curated_assertion";
  const sourceMessage = {
    itemType: "user_message",
    schemaVersion: 1,
    sourceId: memory.eventId,
    sourceLogicalMemoryId: memory.logicalMemoryId,
    sourceRevision: 1,
    occurredAt: memory.capturedAt,
    content: { text: memory.content }
  };
  const leafExpansion = {
    itemType: "lcm_leaf",
    schemaVersion: 1,
    sourceId:
      memory.representation === "lcm_leaves"
        ? memory.nodeId
        : fixtureUuid(`memory:${memory.key}:expansion-leaf`),
    sourceLogicalMemoryId: memory.logicalMemoryId,
    sourceRevision: 1,
    occurredAt: memory.capturedAt,
    content: {
      title: memory.title,
      summaryText: memory.content,
      lexicalAnchors: [],
      sourceIds: [memory.eventId],
      expansionItems: [sourceMessage]
    }
  };
  const curatedExpansionItems = [
    {
      ...sourceMessage,
      sourceId: memory.conversationItemId
    },
    sourceMessage,
    {
      ...leafExpansion,
      sourceId: memory.leafNodeId,
      content: {
        ...leafExpansion.content,
        expansionItems: undefined
      }
    },
    {
      itemType: "lcm_rollup",
      schemaVersion: 1,
      sourceId: memory.nodeId,
      sourceLogicalMemoryId: memory.logicalMemoryId,
      sourceRevision: 1,
      occurredAt: memory.capturedAt,
      content: {
        title: memory.title,
        summaryText: memory.content,
        lexicalAnchors: [],
        sourceIds: [memory.eventId]
      }
    }
  ];
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
        : itemType === "curated_assertion"
          ? {
              assertionText: memory.assertionText,
              topicTitle: memory.title,
              tags: memory.tags,
              sourceCount: curatedExpansionItems.length,
              expansionItems: curatedExpansionItems
            }
          : {
              title: memory.title,
              summaryText: memory.content,
              lexicalAnchors: [],
              sourceIds: [memory.eventId],
              expansionItems:
                itemType === "lcm_leaf" ? [sourceMessage] : [leafExpansion]
            }
  };
  const manifest = [
    {
      sourceId,
      sourceTable:
        memory.representation === "memory_events"
          ? "memory_events"
          : memory.representation === "curated_assertions"
            ? "curated_memory_assertions"
            : "memory_nodes",
      itemType,
      sourceCursor: 1,
      revisionHash: fixtureHash(`memory:${memory.key}:revision`),
      occurredAt: memory.capturedAt,
      sourceEventId:
        memory.representation === "curated_assertions" ? null : memory.eventId,
      sourceNodeId:
        memory.representation === "lcm_leaves" ||
        memory.representation === "lcm_rollups"
          ? memory.nodeId
          : null
    }
  ];
  const manifestHash = runtime.shared.crossIdentitySyncDigest(manifest);
  const sourceContentHash = runtime.shared.crossIdentitySyncDigest([item]);
  const source = {
    kind: "captured_session",
    sessionId: memory.sessionId,
    logicalMemoryId: memory.logicalMemoryId
  };
  const sourceHash = runtime.shared.capturedSessionSourceFrontierHash({
    source,
    representation: memory.representation,
    sourceCursor: 1,
    manifestHash,
    sourceContentHash
  });
  const genericSourceRevision = 2;
  const sourceRevisionId = fixtureUuid(`memory:${memory.key}:source-revision`);
  const sourceRevisionBindingHash = runtime.shared.crossIdentitySyncDigest({
    kind: "logical_memory_source_revision_binding",
    version: 1,
    source,
    ownerPrincipalId: memory.ownerPrincipalId,
    genericRevision: genericSourceRevision,
    sourceRevision: 1
  });
  const binding = {
    sourceRevision: 1,
    sourceHash,
    representationPolicyRevision: 1,
    representationPolicyHash: fidelityPolicyHash,
    contentPolicyVersion: 1,
    contentPolicyHash,
    classifierVersion: 1,
    classifierHash
  };
  const deviceInstanceId = fixtureUuid(`device-instance:${memory.owner}`);
  const verifierHash = process.env.API_TOKEN_PEPPER?.trim()
    ? fixtureSessionHash(
        fixtureDeviceSecrets[memory.owner],
        process.env.API_TOKEN_PEPPER
      )
    : fixtureHash(`device-verifier:${memory.owner}`);
  const deviceProvenanceHash = runtime.sharedMemoryDeviceProvenanceHash({
    syncRelationshipId: memory.syncRelationshipId,
    deviceCredentialId: ownerInfrastructure.deviceCredentialId,
    credentialKeyId: ownerInfrastructure.deviceCredentialKeyId,
    upstreamBackendId: "fixture-backend",
    deviceInstanceId,
    lineageId: ownerInfrastructure.deviceCredentialLineageId,
    credentialVersion: 1,
    verifierKind: "secret_hash",
    verifierHash,
    publicKeyJwk: null
  });

  await client.query(
    `insert into logical_memories (
       id, protocol_logical_id, owner_user_id, owner_principal_id,
       origin_deployment_identity_id, source_kind, logical_key,
       latest_source_revision, metadata
     ) values (
       $1, $2, $3, $4, $5, 'captured_session', $6, 1, $7::jsonb
     )`,
    [
      memory.logicalMemoryId,
      fixtureUuid(`memory:${memory.key}:protocol-logical`),
      owner.id,
      memory.ownerPrincipalId,
      fixtureInfrastructure.sourceDeploymentId,
      `${FIXTURE_VERSION}:${memory.key}`,
      json({ fixture: FIXTURE_VERSION, memoryKey: memory.key })
    ]
  );
  await client.query(
    `insert into captured_session_logical_memories (
       logical_memory_id, source_kind, source_session_id, owner_principal_id
     ) values ($1, 'captured_session', $2, $3)`,
    [memory.logicalMemoryId, memory.sessionId, memory.ownerPrincipalId]
  );
  await client.query(
    `insert into local_captured_session_logical_memories (
       logical_memory_id, local_session_id, owner_user_id
     ) values ($1, $2, $3)`,
    [memory.logicalMemoryId, memory.sessionId, owner.id]
  );
  await client.query(
    `insert into logical_memory_source_revisions (
       id, logical_memory_id, owner_principal_id, source_kind,
       revision, binding_hash
     ) values ($1, $2, $3, 'captured_session', $4, $5)`,
    [
      sourceRevisionId,
      memory.logicalMemoryId,
      memory.ownerPrincipalId,
      genericSourceRevision,
      sourceRevisionBindingHash
    ]
  );
  await client.query(
    `insert into captured_session_source_revisions (
       source_revision_id, logical_memory_id, owner_principal_id,
       source_kind, revision, source_session_id, source_cursor
     ) values ($1, $2, $3, 'captured_session', $4, $5, 1)`,
    [
      sourceRevisionId,
      memory.logicalMemoryId,
      memory.ownerPrincipalId,
      genericSourceRevision,
      memory.sessionId
    ]
  );
  await client.query(
    `insert into memory_replicas (
       id, logical_memory_id, deployment_identity_id, owner_user_id,
       owner_principal_id, replica_role, source_boundary,
       latest_revision, lifecycle, encryption_scope, freshness_status,
       representation_policy_revision, content_policy_version, last_synced_at
     ) values (
       $1, $2, $3, $4, $5, 'target', 'captured_session',
       1, 'active', 'owner_private_replica', 'fresh', 1, 1, $6
     )`,
    [
      memory.remoteReplicaId,
      memory.logicalMemoryId,
      fixtureInfrastructure.targetDeploymentId,
      owner.id,
      memory.ownerPrincipalId,
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
       version, maximum_fidelity, include_curated_memory, policy_hash,
       created_by_user_id, effective_at
     ) values (
       $1, $2, $3, $4, 1, $5, $6, $7, $8, $9
     )`,
    [
      fixtureUuid(`memory:${memory.key}:owner-policy-row`),
      memory.sourceOwnerPolicyId,
      memory.logicalMemoryId,
      memory.ownerPrincipalId,
      maximumFidelity,
      includeCuratedMemory,
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
    sourceContentHash
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
    sourceContentHash
  };
  const previewHash = runtime.shared.sharedSourcePreviewHash(previewBase);
  const previewId = runtime.shared.sharedSourcePreviewId(previewHash);
  const preview = { ...previewBase, previewId, previewHash };

  await client.query(
    `insert into shared_source_artifacts (
       id, logical_memory_id, source_revision_id, remote_replica_id, sync_relationship_id,
       owner_user_id, owner_principal_id, team_id, team_workspace_id,
       representation, artifact_schema_version, source_revision,
       source_cursor, package_sequence, source_hash, manifest_hash,
       artifact_hash, source_content_hash, maximum_fidelity,
       include_curated_memory, source_owner_policy_id,
       source_owner_policy_version, team_policy_id, team_policy_version,
       workspace_policy_id, workspace_policy_version,
       representation_policy_revision, representation_policy_hash,
       content_policy_version, content_policy_hash, classifier_version,
       classifier_hash, source_deployment_identity_id,
       remote_user_identity_id, device_credential_id,
       device_provenance_hash,
       source_capabilities, activation_representation
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,1,1,1,$11,$12,$13,$14,$15,
       $16,$17,1,$18,1,$19,1,1,$20,1,$21,$22,$23,$24,$25,$26,$27,
       array[$10]::shared_memory_representation[],$10
     )`,
    [
      artifactId,
      memory.logicalMemoryId,
      sourceRevisionId,
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
      sourceContentHash,
      maximumFidelity,
      includeCuratedMemory,
      memory.sourceOwnerPolicyId,
      fixtureInfrastructure.teamPolicyId,
      workspacePolicy.policyId,
      fidelityPolicyHash,
      contentPolicyHash,
      classifierVersion,
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
       id, source_artifact_id, logical_memory_id, source_revision_id, remote_replica_id,
       owner_user_id, owner_principal_id, team_id, team_workspace_id,
       representation, preview_schema_version, preview_revision,
       preview_hash, source_revision, source_hash, source_content_hash,
       source_capabilities,
       activation_representation, mode
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,1,$11,1,$12,$13,
       array[$10]::shared_memory_representation[],$10,
       'continuous'
     )`,
    [
      previewId,
      artifactId,
      memory.logicalMemoryId,
      sourceRevisionId,
      memory.remoteReplicaId,
      owner.id,
      memory.ownerPrincipalId,
      fixtureTeam.id,
      workspace.id,
      memory.representation,
      previewHash,
      sourceHash,
      sourceContentHash
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
       id, logical_memory_id, source_revision_id, remote_replica_id, source_owner_principal_id,
       team_id, team_workspace_id, source_owner_policy_id,
       source_owner_policy_version, team_policy_id, team_policy_version,
       workspace_policy_id, workspace_policy_version, mode, state,
       consent_version, maximum_fidelity, include_curated_memory,
       preview_id, preview_revision, preview_hash, source_revision,
       maximum_authorized_source_revision, source_hash,
       fidelity_policy_revision, fidelity_policy_hash,
       content_policy_version, content_policy_hash, classifier_version,
       classifier_hash, source_content_hash, activated_at,
       source_capabilities, activation_representation
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,1,$9,1,$10,1,'continuous','active',1,
       $11,$12,$13,1,$14,1,null,$15,1,$16,1,$17,$18,$19,$20,$21,
       array[$22]::shared_memory_representation[],$22
     )`,
    [
      memory.consentId,
      memory.logicalMemoryId,
      sourceRevisionId,
      memory.remoteReplicaId,
      memory.ownerPrincipalId,
      fixtureTeam.id,
      workspace.id,
      memory.sourceOwnerPolicyId,
      fixtureInfrastructure.teamPolicyId,
      workspacePolicy.policyId,
      maximumFidelity,
      includeCuratedMemory,
      previewId,
      previewHash,
      sourceHash,
      fidelityPolicyHash,
      contentPolicyHash,
      classifierVersion,
      classifierHash,
      sourceContentHash,
      memory.capturedAt,
      memory.representation
    ]
  );

  const revoked = memory.shareState === "revoked";
  const personalDeleted = memory.shareState === "personal_deleted_retained";
  await client.query(
    `insert into team_memory_share_grants (
       id, logical_grant_id, logical_memory_id, source_revision_id, remote_replica_id,
       owner_user_id, owner_principal_id, team_id,
       team_workspace_id, consent_id, source_owner_policy_id,
       source_owner_policy_version, team_policy_id, team_policy_version,
       workspace_policy_id, workspace_policy_version,
       maximum_fidelity, include_curated_memory,
       fidelity_policy_revision, content_policy_version,
       classifier_version, source_revision, grant_version, lifecycle,
       creator_authority, granted_by_user_id, revoked_at,
       revoked_by_user_id, revocation_reason, personal_deleted_at,
       personal_deleted_by_user_id, personal_deletion_reason,
       retained_by_team_at, retention_reason,
       source_capabilities, activation_representation, mode
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,1,$13,1,
       $14,$15,1,1,$16,1,1,$17,
       'fixture_browser_session',$6,$18,$19,$20,$21,$22,$23,$24,$25,
       array[$26]::shared_memory_representation[],$26,
       'continuous'
     )`,
    [
      memory.shareGrantId,
      fixtureUuid(`memory:${memory.key}:logical-grant`),
      memory.logicalMemoryId,
      sourceRevisionId,
      memory.remoteReplicaId,
      owner.id,
      memory.ownerPrincipalId,
      fixtureTeam.id,
      workspace.id,
      memory.consentId,
      memory.sourceOwnerPolicyId,
      fixtureInfrastructure.teamPolicyId,
      workspacePolicy.policyId,
      maximumFidelity,
      includeCuratedMemory,
      classifierVersion,
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
          : "fixture_active_team_share",
      memory.representation
    ]
  );

  const sanitizedSourcePreviewId = fixtureUuid(
    `memory:${memory.key}:sanitized-preview`
  );
  const classificationResultId = fixtureUuid(
    `memory:${memory.key}:privacy-classification`
  );
  const classificationPayloadBindingHash = fixtureHash(
    `memory:${memory.key}:privacy-classification-payload`
  );
  const classificationFields =
    runtime.shared.extractSharedMemorySemanticClassificationFields([item]);
  const classificationInputFields = classificationFields.map(
    ({ path, text }) => ({ path, text })
  );
  const classificationInputIdentityHash =
    runtime.privacyRepository.classificationInputIdentity({
      actor: { userId: owner.id },
      fields: classificationInputFields
    });
  const orderedInputHash = runtime.shared.privacyClassificationOrderedInputHash(
    classificationInputFields
  );
  const classificationChunk = {
    chunkIndex: 0,
    firstFieldIndex: 0,
    fieldCount: classificationFields.length,
    inputIdentityHash: classificationInputIdentityHash,
    orderedInputHash
  };
  const expectedManifestHash =
    runtime.shared.privacyClassificationExpectedManifestHash({
      semanticPreviewId: sanitizedSourcePreviewId,
      sourcePreviewHash: previewHash,
      sourceArtifactHash: artifactHash,
      sourceManifestHash: manifestHash,
      sourceRevision: 1,
      classifierGenerationId,
      classifierHash,
      effectivePrivacyPolicyHash: contentPolicyHash,
      fieldCount: classificationFields.length,
      chunks: [classificationChunk]
    });
  const resultManifestHash =
    runtime.shared.privacyClassificationResultManifestHash({
      expectedManifestHash,
      chunks: [
        {
          ...classificationChunk,
          classificationResultId,
          classificationPayloadBindingHash
        }
      ]
    });
  const classificationByteCount = classificationFields.reduce(
    (total, field) => total + field.inputByteLength,
    0
  );
  const sourceItemIdentityHash = runtime.sharedMemorySourceItemIdentityHash([
    item
  ]);
  const sanitizedContentHash = sourceContentHash;
  const semanticPayload = {
    schemaVersion: 1,
    semanticPreviewId: sanitizedSourcePreviewId,
    sourcePreviewId: previewId,
    sourceArtifactId: artifactId,
    sourcePreviewRevision: 1,
    sourcePreviewHash: previewHash,
    sourceArtifactHash: artifactHash,
    sourceManifestHash: manifestHash,
    sourceRevision: 1,
    sourceHash,
    logicalMemoryId: memory.logicalMemoryId,
    ownerUserId: owner.id,
    ownerPrincipalId: memory.ownerPrincipalId,
    teamId: fixtureTeam.id,
    teamWorkspaceId: workspace.id,
    representation: memory.representation,
    expectedManifestHash,
    expectedChunkCount: 1,
    resultManifestHash,
    classifierGenerationId,
    classifierVersion,
    classifierHash,
    effectivePrivacyPolicyHash: contentPolicyHash,
    sourceItemIdentityHash,
    sourceItemCount: 1,
    sanitizedContentHash,
    displayTitle: runtime.sharedMemorySanitizedDisplayTitle([item]),
    items: [item],
    embeddingSourceBindings: [
      runtime.sharedMemorySemanticEmbeddingSourceBinding(
        0,
        item,
        item,
        manifest[0]
      )
    ]
  };
  const semanticPayloadBindingHash =
    runtime.sharedMemorySemanticPreviewPayloadBindingHash(semanticPayload);
  await client.query(
    `insert into privacy_classification_results (
       id, owner_user_id, classifier_generation_id, classifier_hash,
       owner_content_fingerprint, input_byte_length, payload_binding_hash,
       span_count, status, ready_at
     ) values ($1,$2,$3,$4,$5,$6,$7,0,'ready',$8)`,
    [
      classificationResultId,
      owner.id,
      classifierGenerationId,
      classifierHash,
      classificationInputIdentityHash,
      classificationByteCount,
      classificationPayloadBindingHash,
      memory.capturedAt
    ]
  );
  await runtime.upsertEncryptedFieldPayloadWithClient(
    client,
    { userId: owner.id },
    runtime.teamProvider,
    {
      sourceTable: "shared_source_semantic_previews",
      sourceId: sanitizedSourcePreviewId,
      sourceColumn: "sanitized_preview",
      plaintext: semanticPayload,
      visibility: "team",
      teamId: fixtureTeam.id,
      teamWorkspaceId: workspace.id,
      rowFamily: "shared_source_semantic_preview",
      scope: {
        teamId: fixtureTeam.id,
        workspaceId: workspace.id,
        objectClass: "shared_source_semantic_preview"
      },
      aad: {
        sourcePreviewId: previewId,
        sourcePreviewHash: previewHash,
        sourceArtifactId: artifactId,
        sourceArtifactHash: artifactHash,
        sourceManifestHash: manifestHash,
        sourceRevision: 1,
        sourceHash,
        logicalMemoryId: memory.logicalMemoryId,
        teamId: fixtureTeam.id,
        teamWorkspaceId: workspace.id,
        representation: memory.representation,
        expectedManifestHash,
        expectedChunkCount: 1,
        resultManifestHash,
        classifierGenerationId,
        classifierVersion,
        classifierHash,
        effectivePrivacyPolicyHash: contentPolicyHash,
        sourceItemIdentityHash,
        sourceItemCount: 1,
        sanitizedContentHash,
        payloadBindingHash: semanticPayloadBindingHash
      }
    }
  );
  await client.query(
    `insert into shared_source_semantic_previews (
       id, source_preview_id, source_artifact_id, source_preview_revision,
       source_preview_hash, source_artifact_hash, source_manifest_hash,
       source_revision, source_hash, logical_memory_id, owner_user_id,
       owner_principal_id, team_id, team_workspace_id, representation,
       expected_manifest_hash, expected_chunk_count, completed_chunk_count,
       result_manifest_hash, classification_field_count,
       classification_byte_count,
       classifier_generation_id, classifier_version, classifier_hash,
       effective_privacy_policy_hash, source_item_identity_hash,
       source_item_count, sanitized_content_hash, payload_binding_hash,
       status, ready_at
     ) values (
       $1,$2,$3,1,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,1,1,$15,$16,$17,
       $18,$19,$20,$21,$22,1,$23,$24,'ready',$25
     )`,
    [
      sanitizedSourcePreviewId,
      previewId,
      artifactId,
      previewHash,
      artifactHash,
      manifestHash,
      sourceHash,
      memory.logicalMemoryId,
      owner.id,
      memory.ownerPrincipalId,
      fixtureTeam.id,
      workspace.id,
      memory.representation,
      expectedManifestHash,
      resultManifestHash,
      classificationFields.length,
      classificationByteCount,
      classifierGenerationId,
      classifierVersion,
      classifierHash,
      contentPolicyHash,
      sourceItemIdentityHash,
      sanitizedContentHash,
      semanticPayloadBindingHash,
      memory.capturedAt
    ]
  );
  await client.query(
    `insert into shared_source_semantic_preview_classification_chunks (
       id, semantic_preview_id, chunk_index, first_field_index, field_count,
       input_identity_hash, ordered_input_hash, classification_result_id,
       classification_payload_binding_hash, status, ready_at
     ) values ($1,$2,0,0,$3,$4,$5,$6,$7,'ready',$8)`,
    [
      fixtureUuid(`memory:${memory.key}:privacy-chunk:0`),
      sanitizedSourcePreviewId,
      classificationFields.length,
      classificationInputIdentityHash,
      orderedInputHash,
      classificationResultId,
      classificationPayloadBindingHash,
      memory.capturedAt
    ]
  );
  const sourceRevisionHash =
    runtime.sharedMemorySanitizedSemanticSourceRevisionHash({
      sourcePreviewId: previewId,
      sourcePreviewHash: previewHash,
      sourceArtifactId: artifactId,
      sourceArtifactHash: artifactHash,
      sourceManifestHash: manifestHash,
      sourceRevision: 1,
      representation: memory.representation,
      sanitizedSourcePreviewId,
      sanitizedContentHash,
      sourceItemIdentityHash,
      sourceItemCount: 1,
      privacyClassifierGenerationId: classifierGenerationId,
      privacyClassifierHash: classifierHash,
      effectivePrivacyPolicyHash: contentPolicyHash
    });
  const teamSourceBinding = runtime.sharedMemorySanitizedSemanticSourceBinding({
    sourceRevision: 1,
    sourceRevisionHash,
    fidelityPolicyRevision: 1,
    fidelityPolicyHash,
    contentPolicyVersion: 1,
    effectivePrivacyPolicyHash: contentPolicyHash,
    privacyClassifierVersion: classifierVersion,
    privacyClassifierHash: classifierHash
  });
  const provenanceHash = runtime.sharedMemorySanitizedSemanticProvenanceHash({
    shareGrantId: memory.shareGrantId,
    consentId: memory.consentId,
    logicalMemoryId: memory.logicalMemoryId,
    representation: memory.representation,
    binding: teamSourceBinding,
    sourcePreviewId: previewId,
    sourcePreviewHash: previewHash,
    sourceArtifactId: artifactId,
    sourceArtifactHash: artifactHash,
    sourceManifestHash: manifestHash,
    sanitizedSourcePreviewId,
    expectedManifestHash,
    expectedChunkCount: 1,
    resultManifestHash,
    sourceItemIdentityHash,
    sourceItemCount: 1,
    semanticPayloadBindingHash,
    privacyClassifierGenerationId: classifierGenerationId,
    privacyClassifierHash: classifierHash,
    effectivePrivacyPolicyHash: contentPolicyHash,
    sanitizedContentHash,
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
       source_artifact_id, sanitized_source_preview_id,
       privacy_classifier_generation_id, privacy_classifier_hash,
       effective_privacy_policy_hash, source_manifest_hash,
       sanitized_content_hash, team_id, team_workspace_id, logical_memory_id,
       source_revision_id, representation, source_revision, source_revision_hash,
       provenance_hash, source_owner_policy_id,
       source_owner_policy_version, team_policy_id, team_policy_version,
       workspace_policy_id, workspace_policy_version,
       fidelity_policy_revision, content_policy_version,
       classifier_version, record_version, state, chunk_count,
       freshness_evaluated_at, available_at, invalidated_at,
       invalidation_reason_code
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,1,$17,$18,
       $19,1,$20,1,$21,1,1,1,$22,1,$23,1,$24,$24,$25,$26
     )`,
    [
      memory.representationId,
      memory.shareGrantId,
      memory.consentId,
      previewId,
      artifactId,
      sanitizedSourcePreviewId,
      classifierGenerationId,
      classifierHash,
      contentPolicyHash,
      manifestHash,
      sanitizedContentHash,
      fixtureTeam.id,
      workspace.id,
      memory.logicalMemoryId,
      sourceRevisionId,
      memory.representation,
      sourceRevisionHash,
      provenanceHash,
      memory.sourceOwnerPolicyId,
      fixtureInfrastructure.teamPolicyId,
      workspacePolicy.policyId,
      classifierVersion,
      revoked ? "invalidated" : "available",
      memory.capturedAt,
      revoked ? memory.capturedAt : null,
      revoked ? "share_revoked" : null
    ]
  );
  const chunkAad = {
    chunkFormatVersion: 1,
    representationId: memory.representationId,
    shareGrantId: memory.shareGrantId,
    teamId: fixtureTeam.id,
    teamWorkspaceId: workspace.id,
    logicalMemoryId: memory.logicalMemoryId,
    consentId: memory.consentId,
    representation: memory.representation,
    chunkIndex: 0,
    chunkCount: 1,
    itemOffset: 0,
    itemCount: 1,
    totalItemCount: 1,
    ...teamSourceBinding,
    sourceContentHash: sanitizedContentHash,
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
  const encryptedChunkHash = createHash("sha256")
    .update(Buffer.from(envelope.ciphertext, "base64"))
    .digest("hex");
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
      encryptedChunkHash,
      envelope.nonce,
      envelope.tag,
      json(envelope.wrappedDek),
      json(envelope.aad),
      envelope.createdAt,
      envelope.reencryptedAt
    ]
  );
  await client.query(
    `insert into team_memory_semantic_items (
       id, representation_id, share_grant_id, team_id, team_workspace_id,
       logical_memory_id, pseudonymous_source_id, source_item_index,
       encrypted_chunk_index, encrypted_chunk_item_index, item_type,
       occurred_at, source_revision, representation_policy_revision,
       content_policy_version, classifier_version, content_hash,
       embedding_state
     ) values ($1,$2,$3,$4,$5,$6,$7,0,0,0,$8,$9,1,1,1,$10,$11,'pending')`,
    [
      fixtureUuid(`memory:${memory.key}:semantic-item:0`),
      memory.representationId,
      memory.shareGrantId,
      fixtureTeam.id,
      workspace.id,
      memory.logicalMemoryId,
      runtime.shared.sharedMemoryGrantScopedSourceId(
        memory.shareGrantId,
        sourceId
      ),
      itemType,
      memory.capturedAt,
      classifierVersion,
      createHash("sha256")
        .update(runtime.composeSharedMemorySemanticText(item), "utf8")
        .digest("hex")
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
      thread.kind === "personal_channel"
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

const seedConversationSourceFixture = async (client, runtime) => {
  const privateKey = fixtureConversationSourcePrivateKey();
  const publicKey = runtime.shared.exportConversationSourceReplicationPublicKey(
    createPublicKey(privateKey)
  );
  for (const source of fixtureConversationSources) {
    const memory = fixtureMemoryRows.find(
      (candidate) => candidate.key === source.memoryKey
    );
    if (!memory)
      throw new Error(`Unknown source fixture memory: ${source.memoryKey}`);
    const owner = fixtureUsers[memory.owner];
    const originKeyId = source.originKeyId;
    const sourceCreatedAt = memory.capturedAt;
    const segmentRows = [];
    let byteCursor = 0;
    let itemCursor = 0;
    let previousContentDigest = null;
    for (const [segmentIndex, records] of source.segments.entries()) {
      const bytes = Buffer.from(
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
        "utf8"
      );
      const plaintextDigest = createHash("sha256").update(bytes).digest("hex");
      const manifest = {
        protocol: runtime.shared.CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
        sourceComponentSchemaVersion: 1,
        sourceComponentId: "main",
        sourceComponentRole: "primary",
        parentSourceComponentId: null,
        contentFraming: "jsonl",
        logicalSourceId: source.logicalSourceId,
        sourceGenerationId: source.sourceGenerationId,
        originKeyId,
        segmentIndex,
        startByteCursor: byteCursor,
        endByteCursor: byteCursor + bytes.byteLength,
        startItemCursor: itemCursor,
        endItemCursor: itemCursor + records.length,
        previousContentDigest,
        plaintextDigest,
        sourceFormat: "codex_rollout_jsonl",
        adapterVersion: "codex-transcript-v1",
        sourceCreatedAt,
        priorGenerationClosure: null
      };
      const signedManifest =
        runtime.shared.signConversationSourceReplicationManifest(
          manifest,
          privateKey
        );
      const contentDigest =
        runtime.shared.calculateConversationSourceReplicationContentDigest(
          signedManifest
        );
      const envelope = await runtime.personalProvider.encrypt({
        plaintext: JSON.stringify({
          signedManifest,
          plaintextBytes: bytes.toString("base64url")
        }),
        scope: {
          tenantId: owner.id,
          objectClass: "conversation_source_segment"
        },
        provenance: {
          rowFamily: "conversation_source_segments",
          sourceId: `${source.artifactId}:${segmentIndex}`
        },
        ciphertextLocation: "conversation_source_segments.encryption_envelope",
        aad: {
          ownerUserId: owner.id,
          logicalSourceId: source.logicalSourceId,
          sourceGenerationId: source.sourceGenerationId,
          segmentIndex,
          contentDigest
        }
      });
      segmentRows.push({
        id: source.segmentIds[segmentIndex],
        manifest,
        signedManifest,
        contentDigest,
        envelope,
        plaintextSize: bytes.byteLength,
        storedSize: Buffer.byteLength(JSON.stringify(envelope), "utf8"),
        ciphertextDigest: createHash("sha256")
          .update(Buffer.from(envelope.ciphertext, "base64"))
          .digest("hex")
      });
      byteCursor = manifest.endByteCursor;
      itemCursor = manifest.endItemCursor;
      previousContentDigest = contentDigest;
    }
    const closedAt = new Date(
      Date.parse(sourceCreatedAt) + 1_000
    ).toISOString();
    const closureManifest = {
      protocol: runtime.shared.CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
      sourceComponentSchemaVersion: 1,
      sourceComponentId: "main",
      sourceComponentRole: "primary",
      parentSourceComponentId: null,
      contentFraming: "jsonl",
      logicalSourceId: source.logicalSourceId,
      sourceGenerationId: source.sourceGenerationId,
      originKeyId,
      segmentCount: segmentRows.length,
      endByteCursor: byteCursor,
      endItemCursor: itemCursor,
      chainHeadDigest: segmentRows.at(-1)?.contentDigest ?? null,
      sourceRootDigest: runtime.shared.calculateConversationSourceRootDigest(
        segmentRows.map((row) => row.contentDigest)
      ),
      sourceCreatedAt,
      closedAt,
      priorGenerationClosure: null
    };
    const signedClosure = runtime.shared.signConversationSourceClosureManifest(
      closureManifest,
      privateKey
    );
    const closureHash =
      runtime.shared.calculateConversationSourceClosureDigest(signedClosure);
    const sourceSetComponents = [
      {
        sourceComponentId: "main",
        sourceComponentRole: "primary",
        parentSourceComponentId: null,
        contentFraming: "jsonl",
        artifactClosureDigest: closureHash
      }
    ];
    const sourceSetClosureManifest = {
      protocol: runtime.shared.CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
      sourceSetClosureVersion: 1,
      sourceComponentSchemaVersion: 1,
      logicalSourceId: source.logicalSourceId,
      sourceGenerationId: source.sourceGenerationId,
      signingComponentId: "main",
      originKeyId,
      components: sourceSetComponents,
      componentSetDigest:
        runtime.shared.calculateConversationSourceComponentSetDigest(
          sourceSetComponents
        ),
      closedAt
    };
    const signedSourceSetClosure =
      runtime.shared.signConversationSourceSetClosureManifest(
        sourceSetClosureManifest,
        privateKey
      );
    const sourceSetClosureHash =
      runtime.shared.calculateConversationSourceSetClosureDigest(
        signedSourceSetClosure
      );
    await client.query(
      `insert into conversation_source_artifacts (
         id, owner_user_id, session_id, logical_source_id,
         source_generation_id, replica_role, source_kind, source_runtime,
         external_session_id, source_fingerprint, artifact_format,
         artifact_format_version, source_adapter_version, lifecycle,
         journal_start_offset, journal_start_line, live_start_offset,
         live_start_line, provider_cursor_offset, provider_cursor_line,
         current_source_length, current_journal_sequence, source_created_at,
         source_modified_at, storage_provider, storage_prefix,
         closure_hash, closure_manifest, closure_signature,
         source_set_closure_hash, source_set_closure_manifest,
         source_set_closure_signature, source_set_finalized_at,
         origin_deployment_id, origin_device_id, origin_key_id,
         origin_public_key, redacted_source_label, finalized_at
       ) values (
         $1,$2,$3,$4,$5,'origin_local','codex','codex',$6,$7,'codex_rollout_jsonl',1,
         'codex-transcript-v1','finalized',0,0,0,0,$8,$9,$8,$10,$11,$11,
         'envelope_db',$12,$13,$14,$15,$16,$17,$18,$19,
         $20,$21,$22,$23,'Fixture Codex session',$19
       )`,
      [
        source.artifactId,
        owner.id,
        memory.sessionId,
        source.logicalSourceId,
        source.sourceGenerationId,
        `${FIXTURE_VERSION}:${source.key}`,
        fixtureHash(`conversation-source:${source.key}:fingerprint`),
        byteCursor,
        itemCursor,
        segmentRows.length - 1,
        sourceCreatedAt,
        `${FIXTURE_VERSION}/${source.key}`,
        closureHash,
        json(signedClosure.manifest),
        signedClosure.signature,
        sourceSetClosureHash,
        json(signedSourceSetClosure.manifest),
        signedSourceSetClosure.signature,
        closedAt,
        fixtureInfrastructure.sourceDeploymentId,
        fixtureUuid(`conversation-source:${source.key}:device`),
        originKeyId,
        publicKey
      ]
    );
    for (const row of segmentRows) {
      await client.query(
        `insert into conversation_source_segments (
           id, artifact_id, segment_index, source_start_offset,
           source_end_offset, source_start_line, source_end_line,
           plaintext_digest, ciphertext_digest, plaintext_size, stored_size,
           storage_key, storage_provider, encryption_envelope, signed_manifest,
           origin_signature, manifest_digest, previous_content_digest,
           content_digest, sealed_at
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'envelope_db',$13,$14,
           $15,$16,$17,$18,$19
         )`,
        [
          row.id,
          source.artifactId,
          row.manifest.segmentIndex,
          row.manifest.startByteCursor,
          row.manifest.endByteCursor,
          row.manifest.startItemCursor,
          row.manifest.endItemCursor,
          row.manifest.plaintextDigest,
          row.ciphertextDigest,
          row.plaintextSize,
          row.storedSize,
          `${source.logicalSourceId}/${source.sourceGenerationId}/${row.manifest.segmentIndex}`,
          json(row.envelope),
          json(row.manifest),
          row.signedManifest.signature,
          runtime.shared.calculateConversationSourceReplicationManifestDigest(
            row.manifest
          ),
          row.manifest.previousContentDigest,
          row.contentDigest,
          sourceCreatedAt
        ]
      );
    }
    const snapshotMaximumOffset =
      source.mode === "snapshot"
        ? segmentRows[source.maximumSegmentIndex].manifest.endByteCursor
        : null;
    await client.query(
      `insert into team_conversation_source_grants (
         id, share_grant_id, artifact_id, logical_source_id,
         source_generation_id, owner_user_id,
         session_id, team_id, team_workspace_id, mode,
         maximum_segment_index, maximum_source_offset, version, lifecycle,
         mutation_id, granted_by_user_id, creator_authority, created_at,
         updated_at, revoked_at, revoked_by_user_id, revocation_reason
       ) values (
         $1,$2,$3,$4,$15,$5,$6,$7,$8,$9,$10,$11,1,$12,$13,$5,
         'fixture_seed',$14,$14,
         case when $12='revoked' then $14::timestamptz else null end,
         case when $12='revoked' then $5::uuid else null end,
         case when $12='revoked' then 'fixture_revocation' else null end
       )`,
      [
        source.id,
        memory.shareGrantId,
        source.artifactId,
        source.logicalSourceId,
        owner.id,
        memory.sessionId,
        fixtureTeam.id,
        fixtureWorkspaces[memory.workspace].id,
        source.mode,
        source.maximumSegmentIndex,
        snapshotMaximumOffset,
        source.lifecycle,
        source.mutationId,
        sourceCreatedAt,
        source.sourceGenerationId
      ]
    );
    await client.query(
      `insert into audit_events (
         id, actor_user_id, owner_user_id, visibility, action, target_table,
         target_id, metadata, created_at
       ) values ($1,$2,$2,'personal',$3,'team_conversation_source_grants',$4,$5,$6)`,
      [
        fixtureUuid(`conversation-source:${source.key}:audit`),
        owner.id,
        source.lifecycle === "revoked"
          ? "team_conversation_source.revoked"
          : "team_conversation_source.granted",
        source.id,
        json({
          fixture: FIXTURE_VERSION,
          teamId: fixtureTeam.id,
          teamWorkspaceId: fixtureWorkspaces[memory.workspace].id,
          shareGrantId: memory.shareGrantId,
          mode: source.mode
        }),
        sourceCreatedAt
      ]
    );
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
  const fixtureCuratedAssertionIds = fixtureMemoryRows
    .map((memory) => memory.curatedAssertionId)
    .filter(Boolean);
  const fixtureCuratedTopicIds = fixtureMemoryRows
    .map((memory) => memory.curatedTopicId)
    .filter(Boolean);
  const fixtureCuratedMemories = fixtureMemoryRows.filter(
    (memory) => memory.representation === "curated_assertions"
  );
  const fixtureUserSessionIds = Object.values(fixtureSessionRows).map(
    (session) => session.id
  );
  const fixtureUserKeys = Object.keys(fixtureUsers);
  const fixtureDeviceCredentialIds = fixtureUserKeys.map(
    (userKey) => fixtureOwnerInfrastructure(userKey).deviceCredentialId
  );
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
         from team_memory_share_grants
        where team_id = $1 or id = any($2::uuid[])`,
      [fixtureTeam.id, fixtureShareGrantIds]
    );
    await client.query(
      `delete from audit_events
        where id = any($1::uuid[])
           or (target_table = 'team_conversation_source_grants'
             and target_id = any($2::uuid[]))`,
      [
        fixtureConversationSources.map((source) =>
          fixtureUuid(`conversation-source:${source.key}:audit`)
        ),
        fixtureConversationSources.map((source) => source.id)
      ]
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
      `create temporary table fixture_reset_privacy_classifications
         on commit drop as
       select distinct chunk.classification_result_id as id
         from shared_source_semantic_preview_classification_chunks chunk
         join shared_source_semantic_previews preview
           on preview.id=chunk.semantic_preview_id
        where preview.source_preview_id in (select id from fixture_reset_shared_previews)
           or preview.logical_memory_id = any($1::uuid[])
       union
       select unnest($2::uuid[])`,
      [
        fixtureLogicalMemoryIds,
        fixtureMemoryRows.map((memory) =>
          fixtureUuid(`memory:${memory.key}:privacy-classification`)
        )
      ]
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
      `delete from collaboration_receipt_states
       where thread_id in (select id from fixture_reset_threads)`
    );
    await client.query(
      `delete from encrypted_field_payloads
       where team_id = $6
          or (source_table = 'collaboration_threads'
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
          ))
          or (source_table = 'shared_source_semantic_previews' and source_id in (
            select id from shared_source_semantic_previews
             where source_preview_id in (select id from fixture_reset_shared_previews)
          ))
          or (source_table = 'privacy_classification_results'
              and source_id in (
                select id from fixture_reset_privacy_classifications
              ))
          or (source_table = 'curated_memory_assertions'
              and source_id = any($1::uuid[]))
          or (source_table = 'curated_memory_topics'
              and source_id = any($2::uuid[]))
          or (source_table = 'curated_memory_sources' and source_id in (
            select id from curated_memory_sources
             where assertion_id = any($1::uuid[])
          ))
          or (source_table = 'conversation_items'
              and source_id = any($3::uuid[]))
          or (source_table = 'memory_events'
              and source_id = any($4::uuid[]))
          or (source_table = 'memory_nodes'
              and source_id = any($5::uuid[]))`,
      [
        fixtureCuratedAssertionIds,
        fixtureCuratedTopicIds,
        fixtureCuratedMemories.map((memory) => memory.conversationItemId),
        fixtureCuratedMemories.map((memory) => memory.eventId),
        fixtureCuratedMemories.flatMap((memory) => [
          memory.leafNodeId,
          memory.nodeId
        ]),
        fixtureTeam.id
      ]
    );
    await client.query(
      `delete from collaboration_messages
       where thread_id in (select id from fixture_reset_threads)`
    );
    await client.query(
      `delete from collaboration_thread_audience_members
       where thread_id in (select id from fixture_reset_threads)`
    );
    await client.query(
      `delete from collaboration_thread_audiences
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
      `update team_memory_share_grants
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
      `delete from shared_source_semantic_previews
       where source_preview_id in (select id from fixture_reset_shared_previews)
          or logical_memory_id = any($1::uuid[])`,
      [fixtureLogicalMemoryIds]
    );
    await client.query(
      `delete from privacy_classification_results
       where id in (select id from fixture_reset_privacy_classifications)`
    );
    await client.query(
      "delete from curated_memory_assertions where id = any($1::uuid[])",
      [fixtureCuratedAssertionIds]
    );
    await client.query(
      "delete from curated_memory_topics where id = any($1::uuid[])",
      [fixtureCuratedTopicIds]
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
      `delete from team_memory_share_grants
        where id in (select id from fixture_reset_share_grants)`
    );
    await client.query(
      `delete from conversation_source_segments
       where artifact_id = any($1::uuid[])`,
      [fixtureConversationSources.map((source) => source.artifactId)]
    );
    await client.query(
      `delete from conversation_source_artifacts
       where id = any($1::uuid[])`,
      [fixtureConversationSources.map((source) => source.artifactId)]
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
      `delete from logical_memory_source_revisions
       where logical_memory_id = any($1::uuid[])`,
      [fixtureLogicalMemoryIds]
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
        fixtureUserKeys.map(
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
  runtime.fixturePrivacy = await ensureFixturePrivacyRuntime(client, runtime);
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
            password_hash = case
              when users.password_hash like '$argon2%' then users.password_hash
              else null
            end,
            disabled_at = excluded.disabled_at,
            disabled_reason = excluded.disabled_reason,
            deleted_at = null,
            deletion_reason = null
        `,
        [
          user.id,
          user.email,
          user.displayName,
          null,
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

    for (const userKey of Object.keys(fixtureUsers)) {
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
          fixtureUuid(`device-instance:${userKey}`),
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
         id, policy_id, team_id, version, maximum_fidelity,
         include_curated_memory, policy_hash, created_by_user_id, effective_at
       ) values ($1, $2, $3, 1, $4, $5, $6, $7, $8)`,
      [
        fixtureInfrastructure.teamPolicyRowId,
        fixtureInfrastructure.teamPolicyId,
        fixtureTeam.id,
        FIXTURE_MAXIMUM_FIDELITY,
        FIXTURE_INCLUDE_CURATED_MEMORY,
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
           maximum_fidelity, include_curated_memory, policy_hash, created_by_user_id,
           effective_at
         ) values (
           $1, $2, $3, $4, 1, $5, $6, $7, $8, $9
         )`,
        [
          policy.id,
          policy.policyId,
          fixtureTeam.id,
          workspace.id,
          FIXTURE_MAXIMUM_FIDELITY,
          FIXTURE_INCLUDE_CURATED_MEMORY,
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
          memory.representation === "curated_assertions"
            ? "[koed encrypted conversation item]"
            : memory.content,
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
          memory.representation === "curated_assertions"
            ? json({ contentEncrypted: true })
            : json(eventPayload),
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
            summary_embedding_revision,
            source_items_json,
            source_event_count,
            session_id,
            personal_deleted_at,
            personal_deleted_by_user_id,
            personal_deletion_reason
          )
          values (
            $1, $2, $2, 'personal', $3, $4, $5, $6, $7, 'codex', 'transcript',
            $8, $9, $10, $11, 1, $14,
            ${deletedColumns ? "now()" : "null"},
            $12,
            $13
          )
        `,
        [
          memory.nodeId,
          owner.id,
          memory.representation === "lcm_rollups" ||
          memory.representation === "curated_assertions"
            ? "rollup"
            : "leaf",
          memory.representation === "lcm_rollups" ||
          memory.representation === "curated_assertions"
            ? 1
            : 0,
          memory.title,
          memory.representation === "curated_assertions"
            ? "[koed encrypted memory node summary]"
            : memory.content,
          memory.content,
          `${memory.idempotencyKey}:memory-node`,
          memory.sourceHash,
          memory.summaryEmbeddingRevision,
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
          deletedColumns?.personalDeletionReason ?? null,
          memory.sessionId
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

      if (memory.representation === "curated_assertions") {
        await client.query(
          `insert into memory_nodes (
             id,owner_user_id,created_by_user_id,visibility,kind,depth,
             title,summary_text,body_text,source_runtime,capture_method,
             idempotency_key,source_hash,summary_embedding_revision,
             source_items_json,source_event_count,session_id
           ) values (
             $1,$2,$2,'personal','leaf',0,$3,$4,$4,'codex','transcript',
             $5,$6,$7,$8::jsonb,1,$9
           )`,
          [
            memory.leafNodeId,
            owner.id,
            `${memory.title} Source Leaf`,
            "[koed encrypted memory node summary]",
            `${memory.idempotencyKey}:curated-leaf-node`,
            `${memory.sourceHash}:curated-leaf-node`,
            fixtureUuid(`memory:${memory.key}:leaf-embedding-revision`),
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
              }
            ]),
            memory.sessionId
          ]
        );
        await client.query(
          `insert into memory_node_sources (
             memory_node_id,memory_event_id,message_id,source_order,source_hash
           ) values ($1,$2,$3,0,$4)`,
          [
            memory.leafNodeId,
            memory.eventId,
            memory.messageId,
            `${memory.sourceHash}:curated-leaf-source`
          ]
        );
        await client.query(
          `insert into memory_node_children (
             parent_memory_node_id,child_memory_node_id,child_order
           ) values ($1,$2,0)`,
          [memory.nodeId, memory.leafNodeId]
        );
        await seedCuratedPersonalMemory(client, runtime, memory);
      }

      await seedSharedMemoryTopology(client, runtime, memory);
    }

    await seedConversationSourceFixture(client, runtime);

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
      left join local_captured_session_logical_memories local_memory
        on local_memory.local_session_id = s.id
      left join team_memory_share_grants tssg
        on tssg.logical_memory_id = local_memory.logical_memory_id
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
    "ciphertext_digest",
    "ciphertext_hash",
    "nonce",
    "tag",
    "wrapped_dek",
    ...(table === "team_memory_semantic_items"
      ? ["content_hash", "embedding_input_hash"]
      : [])
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
                : table === "conversation_source_segments" &&
                    key === "encryption_envelope"
                  ? "<encrypted>"
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
        Object.keys(fixtureUsers).map(
          (key) => fixtureOwnerInfrastructure(key).remoteUserIdentityId
        )
      ]
    ],
    [
      "device_credentials",
      "select * from device_credentials where id = any($1::uuid[])",
      [
        Object.keys(fixtureUsers).map(
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
      `select source.* from memory_node_sources source
        join memory_nodes node on node.id=source.memory_node_id
       where node.source_hash like $1`,
      [`${FIXTURE_SOURCE_HASH_PREFIX}%`]
    ],
    [
      "memory_node_children",
      `select child.* from memory_node_children child
        join memory_nodes parent on parent.id=child.parent_memory_node_id
       where parent.source_hash like $1`,
      [`${FIXTURE_SOURCE_HASH_PREFIX}%`]
    ],
    [
      "curated_memory_topics",
      "select * from curated_memory_topics where id = any($1::uuid[])",
      [fixtureMemoryRows.map((memory) => memory.curatedTopicId).filter(Boolean)]
    ],
    [
      "curated_memory_assertions",
      "select * from curated_memory_assertions where id = any($1::uuid[])",
      [
        fixtureMemoryRows
          .map((memory) => memory.curatedAssertionId)
          .filter(Boolean)
      ]
    ],
    [
      "curated_memory_sources",
      "select * from curated_memory_sources where assertion_id = any($1::uuid[])",
      [
        fixtureMemoryRows
          .map((memory) => memory.curatedAssertionId)
          .filter(Boolean)
      ]
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
      "team_memory_share_grants",
      "select * from team_memory_share_grants where id = any($1::uuid[])",
      [fixtureShareGrantIds]
    ],
    [
      "conversation_source_artifacts",
      "select * from conversation_source_artifacts where id = any($1::uuid[])",
      [fixtureConversationSources.map((source) => source.artifactId)]
    ],
    [
      "conversation_source_segments",
      "select * from conversation_source_segments where artifact_id = any($1::uuid[])",
      [fixtureConversationSources.map((source) => source.artifactId)]
    ],
    [
      "team_conversation_source_grants",
      "select * from team_conversation_source_grants where id = any($1::uuid[])",
      [fixtureConversationSources.map((source) => source.id)]
    ],
    [
      "conversation_source_audit_events",
      `select actor_user_id, owner_user_id, visibility, action, target_table,
              target_id, metadata
         from audit_events
        where target_table = 'team_conversation_source_grants'
          and target_id = any($1::uuid[])`,
      [fixtureConversationSources.map((source) => source.id)]
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
      "team_memory_semantic_items",
      "select * from team_memory_semantic_items where representation_id = any($1::uuid[])",
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
      "collaboration_thread_audiences",
      "select * from collaboration_thread_audiences where thread_id = any($1::uuid[])",
      [fixtureThreadIds]
    ],
    [
      "collaboration_thread_audience_members",
      "select * from collaboration_thread_audience_members where thread_id = any($1::uuid[])",
      [fixtureThreadIds]
    ],
    [
      "collaboration_messages",
      "select * from collaboration_messages where thread_id = any($1::uuid[])",
      [fixtureThreadIds]
    ],
    [
      "collaboration_receipt_states",
      "select * from collaboration_receipt_states where thread_id = any($1::uuid[])",
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
          ))
          or (source_table in ('curated_memory_assertions','curated_memory_topics')
              and source_id = any($3::uuid[]))
          or (source_table = 'curated_memory_sources' and source_id in (
            select id from curated_memory_sources where assertion_id = any($4::uuid[])
          ))
          or (source_table = 'conversation_items' and source_id = any($5::uuid[]))
          or (source_table = 'memory_events' and source_id = any($6::uuid[]))
          or (source_table = 'memory_nodes' and source_id = any($7::uuid[]))`,
      [
        fixtureThreadIds,
        logicalMemoryIds,
        fixtureMemoryRows
          .flatMap((memory) => [
            memory.curatedAssertionId,
            memory.curatedTopicId
          ])
          .filter(Boolean),
        fixtureMemoryRows
          .map((memory) => memory.curatedAssertionId)
          .filter(Boolean),
        fixtureMemoryRows
          .filter((memory) => memory.representation === "curated_assertions")
          .map((memory) => memory.conversationItemId),
        fixtureMemoryRows
          .filter((memory) => memory.representation === "curated_assertions")
          .map((memory) => memory.eventId),
        fixtureMemoryRows
          .filter((memory) => memory.representation === "curated_assertions")
          .flatMap((memory) => [memory.leafNodeId, memory.nodeId])
      ]
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
  snapshot.decryptedConversationSources = [];
  for (const source of fixtureConversationSources) {
    const rows = await client.query(
      `select segment_index, encryption_envelope
         from conversation_source_segments
        where artifact_id = $1
        order by segment_index`,
      [source.artifactId]
    );
    const records = [];
    for (const row of rows.rows) {
      const envelope =
        runtime.shared.parseConversationSourceReplicationSegmentEnvelope(
          JSON.parse(
            await runtime.shared.decryptEnvelopeToUtf8(
              runtime.personalProvider,
              row.encryption_envelope
            )
          )
        );
      records.push({
        segmentIndex: row.segment_index,
        plaintext: Buffer.from(envelope.plaintextBytes, "base64url").toString(
          "utf8"
        )
      });
    }
    snapshot.decryptedConversationSources.push({ key: source.key, records });
  }
  snapshot.decryptedConversationSources.sort((left, right) =>
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
     from team_memory_share_grants
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
  await assertCount(
    client,
    `select count(*)::int as count
       from team_conversation_source_grants
      where id = any($1::uuid[])`,
    [fixtureConversationSources.map((source) => source.id)],
    fixtureConversationSources.length,
    "Fixture independent Conversation Source Access grants"
  );
  const curatedMemory = fixtureMemory("carol-cloud-curated-retrieval");
  await assertCount(
    client,
    `select count(*)::int as count
       from curated_memory_assertions assertion
       join curated_memory_topics topic on topic.id=assertion.topic_id
      where assertion.id=$1 and assertion.owner_user_id=$2
        and assertion.visibility='personal' and assertion.status='current'
        and assertion.suppressed_at is null and assertion.expires_at is null
        and assertion.assertion_text='[koed encrypted curated memory]'
        and topic.title='[koed encrypted curated memory]'`,
    [curatedMemory.curatedAssertionId, fixtureUsers.carol.id],
    1,
    "Fixture protected Curated assertion"
  );
  await assertCount(
    client,
    `select count(*)::int as count
       from audit_events
      where target_table = 'team_conversation_source_grants'
        and target_id = any($1::uuid[])
        and action in (
          'team_conversation_source.granted',
          'team_conversation_source.revoked'
        )`,
    [fixtureConversationSources.map((source) => source.id)],
    fixtureConversationSources.length,
    "Fixture Conversation Source audit events"
  );

  for (const source of fixtureConversationSources) {
    const memory = fixtureMemoryRows.find(
      (candidate) => candidate.key === source.memoryKey
    );
    const actor = { userId: fixtureUsers.carol.id };
    const access =
      await runtime.teamConversationSourceRepository.getTeamConversationSourceAccess(
        actor,
        { shareGrantId: memory.shareGrantId }
      );
    if (source.lifecycle === "revoked") {
      if (access !== null) {
        throw new Error(`${source.key}: revoked exact source was readable`);
      }
      continue;
    }
    if (!access || access.grant.mode !== source.mode) {
      throw new Error(
        `${source.key}: source grant mode or access is incorrect`
      );
    }
    const manifest =
      await runtime.teamConversationSourceRepository.getTeamConversationSourceManifest(
        actor,
        {
          shareGrantId: memory.shareGrantId,
          afterSegmentIndex: -1,
          limit: 100,
          recordAudit: false
        }
      );
    const expectedSegmentCount =
      source.mode === "snapshot"
        ? source.maximumSegmentIndex + 1
        : source.segments.length;
    if (!manifest || manifest.segments.length !== expectedSegmentCount) {
      throw new Error(
        `${source.key}: snapshot/continuous boundary is incorrect`
      );
    }
    for (const segment of manifest.segments) {
      const restored =
        runtime.shared.parseConversationSourceReplicationSegmentEnvelope(
          JSON.parse(
            await runtime.shared.decryptEnvelopeToUtf8(
              runtime.personalProvider,
              segment.encryptionEnvelope
            )
          )
        );
      const exact = Buffer.from(restored.plaintextBytes, "base64url").toString(
        "utf8"
      );
      const expected = `${source.segments[segment.segmentIndex]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`;
      if (exact !== expected) {
        throw new Error(`${source.key}: encrypted exact source bytes drifted`);
      }
    }
  }
  await assertCount(
    client,
    `select count(*)::int as count
       from curated_memory_sources source
      where source.assertion_id=$1
        and source.source_role in ('primary_evidence','supporting_evidence')
        and (
          (source.source_type='conversation_item' and source.conversation_item_id=$2)
          or (source.source_type='memory_event' and source.memory_event_id=$3)
          or (source.source_type='lcm_summary' and source.lcm_node_id=$4)
          or (source.source_type='lcm_summary' and source.lcm_node_id=$5)
        )`,
    [
      curatedMemory.curatedAssertionId,
      curatedMemory.conversationItemId,
      curatedMemory.eventId,
      curatedMemory.leafNodeId,
      curatedMemory.nodeId
    ],
    4,
    "Fixture exact-session Curated direct-source provenance"
  );
  await assertCount(
    client,
    `select count(*)::int as count
       from memory_node_children child
       join memory_nodes rollup on rollup.id=child.parent_memory_node_id
       join memory_nodes leaf on leaf.id=child.child_memory_node_id
      where rollup.id=$1 and leaf.id=$2
        and rollup.session_id=$3 and leaf.session_id=$3
        and rollup.kind='rollup' and leaf.kind='leaf'
        and rollup.source_event_count=1 and leaf.source_event_count=1`,
    [curatedMemory.nodeId, curatedMemory.leafNodeId, curatedMemory.sessionId],
    1,
    "Fixture Curated LCM descendant closure"
  );
  await assertCount(
    client,
    `select count(*)::int as count
       from encrypted_field_payloads
      where invalidated_at is null and source_column='payload'
        and (
          (source_table='curated_memory_assertions' and source_id=$1)
          or (source_table='curated_memory_topics' and source_id=$2)
          or (source_table='curated_memory_sources' and source_id in (
            select id from curated_memory_sources where assertion_id=$1
          ))
        )`,
    [curatedMemory.curatedAssertionId, curatedMemory.curatedTopicId],
    6,
    "Fixture Curated Personal encrypted payload coverage"
  );
  await assertCount(
    client,
    `select count(*)::int as count
       from encrypted_field_payloads
      where invalidated_at is null and visibility='personal'
        and (
          (source_table='conversation_items' and source_id=$1 and source_column='raw_text')
          or (source_table='memory_events' and source_id=$2 and source_column='payload')
          or (source_table='memory_nodes' and source_id=any($3::uuid[])
              and source_column='summary_text')
        )`,
    [
      curatedMemory.conversationItemId,
      curatedMemory.eventId,
      [curatedMemory.leafNodeId, curatedMemory.nodeId]
    ],
    4,
    "Fixture Curated direct-source encrypted payload coverage"
  );
  await assertCount(
    client,
    `select count(*)::int as count
       from conversation_items item
       join memory_events event on event.id=$2 and event.session_id=item.session_id
      where item.id=$1
        and item.raw_text='[koed encrypted conversation item]'
        and event.payload='{"contentEncrypted":true}'::jsonb
        and (select count(*) from memory_nodes node
              where node.id=any($3::uuid[])
                and node.summary_text='[koed encrypted memory node summary]')=2`,
    [
      curatedMemory.conversationItemId,
      curatedMemory.eventId,
      [curatedMemory.leafNodeId, curatedMemory.nodeId]
    ],
    1,
    "Fixture Curated direct-source plaintext markers"
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
    fixtureMemory("carol-cloud-curated-retrieval").shareGrantId,
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
    lcm_rollups: "lcm_rollup",
    curated_assertions: "curated_assertion"
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
        : memory.representation === "curated_assertions"
          ? memory.curatedAssertionId
          : memory.nodeId;
    const expectedSourceId = runtime.shared.sharedMemoryGrantScopedSourceId(
      memory.shareGrantId,
      sourceId
    );
    const expectedContent =
      memory.representation === "memory_events"
        ? { text: memory.content }
        : memory.representation === "curated_assertions"
          ? {
              assertionText: memory.assertionText,
              sourceCount: 4,
              tags: memory.tags,
              topicTitle: memory.title
            }
          : {
              sourceIds: [
                runtime.shared.sharedMemoryGrantScopedSourceId(
                  memory.shareGrantId,
                  memory.eventId
                )
              ],
              summaryText: memory.content,
              lexicalAnchors: [],
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
    if (memory.representation === "curated_assertions") {
      const expanded =
        await runtime.sharedMemoryRepository.readGrantRepresentation(
          { userId: fixtureUsers.alice.id },
          {
            shareGrantId: memory.shareGrantId,
            representation: memory.representation,
            includeExpansionMaterial: true
          }
        );
      const expansionItems = expanded?.items[0]?.content?.expansionItems;
      assertDeepEqual(
        Array.isArray(expansionItems)
          ? expansionItems.map((entry) => entry.itemType)
          : null,
        ["user_message", "user_message", "lcm_leaf", "lcm_rollup"],
        `${memory.title} exact-session Curated expansion types`
      );
      assertDeepEqual(
        Array.isArray(expansionItems)
          ? expansionItems.map((entry) => entry.sourceId)
          : null,
        [
          memory.conversationItemId,
          memory.eventId,
          memory.leafNodeId,
          memory.nodeId
        ].map((id) =>
          runtime.shared.sharedMemoryGrantScopedSourceId(
            memory.shareGrantId,
            id
          )
        ),
        `${memory.title} grant-scoped Curated expansion provenance`
      );
    }
    assertDeepEqual(
      {
        includeCuratedMemory: read.grant.includeCuratedMemory,
        maximumFidelity: read.grant.maximumFidelity,
        consentId: read.grant.consentId,
        id: read.grant.id,
        logicalMemoryId: read.grant.logicalMemoryId,
        ownerPrincipalId: read.grant.ownerPrincipalId,
        teamId: read.grant.teamId,
        teamWorkspaceId: read.grant.teamWorkspaceId
      },
      {
        includeCuratedMemory: memory.representation === "curated_assertions",
        maximumFidelity:
          memory.representation === "curated_assertions"
            ? "memory_events"
            : memory.representation,
        consentId: memory.consentId,
        id: memory.shareGrantId,
        logicalMemoryId: memory.logicalMemoryId,
        ownerPrincipalId: memory.ownerPrincipalId,
        teamId: fixtureTeam.id,
        teamWorkspaceId: fixtureWorkspaces[memory.workspace].id
      },
      `${memory.title} decrypted Shared Memory grant binding`
    );
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
    ["personal_channel"],
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
  const semanticItems = await client.query(
    `select representation_id,share_grant_id,team_workspace_id,
            pseudonymous_source_id,source_item_index,encrypted_chunk_index,
            encrypted_chunk_item_index,item_type,content_hash,embedding_state,
            embedding_model,embedding_dimensions,embedding_version,
            embedding_input_hash,embedded_at,last_error_class
       from team_memory_semantic_items
      where representation_id = any($1::uuid[])
      order by representation_id,source_item_index`,
    [sharedMemories.map((memory) => memory.representationId)]
  );
  if (semanticItems.rows.length !== sharedMemories.length) {
    throw new Error(
      "Fixture Team semantic metadata is missing; reset/rematerialize the fixture before semantic recall"
    );
  }
  for (const memory of sharedMemories) {
    const semantic = semanticItems.rows.find(
      (row) => row.representation_id === memory.representationId
    );
    const canonicalSourceId =
      memory.representation === "memory_events"
        ? memory.eventId
        : memory.representation === "curated_assertions"
          ? memory.curatedAssertionId
          : memory.nodeId;
    assertDeepEqual(
      {
        itemIndex: semantic?.source_item_index,
        chunkIndex: semantic?.encrypted_chunk_index,
        chunkItemIndex: semantic?.encrypted_chunk_item_index,
        pseudonymousSourceId: semantic?.pseudonymous_source_id
      },
      {
        itemIndex: 0,
        chunkIndex: 0,
        chunkItemIndex: 0,
        pseudonymousSourceId: runtime.shared.sharedMemoryGrantScopedSourceId(
          memory.shareGrantId,
          canonicalSourceId
        )
      },
      `${memory.title} semantic routing metadata`
    );
    if (
      !["pending", "processing", "embedded"].includes(semantic?.embedding_state)
    ) {
      throw new Error(
        `${memory.title} semantic embedding is ${semantic?.embedding_state ?? "missing"}${semantic?.last_error_class ? ` (${semantic.last_error_class})` : ""}`
      );
    }
    if (
      semantic.embedding_state === "embedded" &&
      (semantic.embedding_model !== "qwen3-0.6b" ||
        semantic.embedding_dimensions !== 1024 ||
        typeof semantic.embedding_version !== "string" ||
        !/^[a-f0-9]{64}$/.test(semantic.embedding_input_hash ?? "") ||
        !semantic.embedded_at)
    ) {
      throw new Error(
        `${memory.title} embedded semantic item has incomplete model provenance`
      );
    }
    if (
      semantic?.content_hash ===
        runtime.shared.crossIdentitySyncDigest([memory.content]) ||
      JSON.stringify(semantic).includes(canonicalSourceId)
    ) {
      throw new Error(
        `${memory.title} semantic routing metadata exposes source-derived identity`
      );
    }
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
         from (select * from team_memory_representation_chunks where share_grant_id = any($5::uuid[])) row_data), ''),
       coalesce((select string_agg(row_to_json(row_data)::text, E'\n')
         from (select * from team_memory_semantic_items where share_grant_id = any($5::uuid[])) row_data), ''),
       coalesce((select string_agg(row_to_json(row_data)::text, E'\n')
         from (select * from curated_memory_assertions where id = any($6::uuid[])) row_data), ''),
       coalesce((select string_agg(row_to_json(row_data)::text, E'\n')
         from (select * from curated_memory_topics where id = any($7::uuid[])) row_data), ''),
       coalesce((select string_agg(row_to_json(row_data)::text, E'\n')
         from (select * from curated_memory_sources where assertion_id = any($6::uuid[])) row_data), ''),
       coalesce((select string_agg(row_to_json(row_data)::text, E'\n')
         from (select * from encrypted_field_payloads
                where source_table like 'curated_memory_%'
                  and (source_id = any($6::uuid[]) or source_id = any($7::uuid[])
                       or source_id in (select id from curated_memory_sources
                                        where assertion_id = any($6::uuid[])))) row_data), ''),
       coalesce((select string_agg(row_to_json(row_data)::text, E'\n')
         from (select * from conversation_source_segments where artifact_id = any($8::uuid[])) row_data), '')
     ) as raw`,
    [
      fixtureThreadIds,
      fixtureThreadIds,
      fixtureMessages.rows.map((row) => row.id),
      sharedMemories.map((memory) => memory.logicalMemoryId),
      sharedMemories.map((memory) => memory.shareGrantId),
      fixtureMemoryRows
        .map((memory) => memory.curatedAssertionId)
        .filter(Boolean),
      fixtureMemoryRows.map((memory) => memory.curatedTopicId).filter(Boolean),
      fixtureConversationSources.map((source) => source.artifactId)
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
    ...fixtureMemoryRows.flatMap((memory) => [
      memory.title,
      memory.content,
      memory.assertionText
    ]),
    ...fixtureConversationSources.flatMap((source) =>
      source.segments.flatMap((records) =>
        records.map((record) => JSON.stringify(record))
      )
    )
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
      "Independent Conversation Source Access grants preserve exact owner source and enforce sanitized Team-read, snapshot, continuous, revocation, and audit boundaries",
      "Companion discussion history and unread state are deterministic",
      "Collaboration names, topics, bodies, metadata, and provenance have exact encrypted payload coverage",
      "Shared source artifacts, previews, chunks, bindings, and outbox surfaces contain no sensitive plaintext"
    ]
  };
};
