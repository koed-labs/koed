import { createHash } from "node:crypto";

export const FIXTURE_VERSION = "team-saas-fixture-v1";
export const FIXTURE_SOURCE_HASH_PREFIX = `${FIXTURE_VERSION}:`;

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
  }
};

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
  ["cloud", "alice", "write"],
  ["cloud", "bob", "disabled"],
  ["cloud", "carol", "write"],
  ["cloud", "david", "write"],
  ["ingestion", "alice", "write"],
  ["ingestion", "bob", "read"],
  ["ingestion", "carol", "write"],
  ["ingestion", "david", "write"]
];

export const fixtureMemories = [
  {
    key: "bob-electron-timeline",
    owner: "bob",
    workspace: "electron",
    title: "Workspace Memory Timeline UX",
    content:
      "Bob decided the Electron app should show a Workspace Memory Timeline with captured decisions, contributors, and retained team knowledge as the demo aha moment.",
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
  capturedAt: new Date(Date.UTC(2026, 0, 1, 9, index, 0)).toISOString(),
  sourceHash: `${FIXTURE_SOURCE_HASH_PREFIX}${memory.key}`,
  idempotencyKey: `${FIXTURE_VERSION}:${memory.key}`
}));

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

const json = (value) => JSON.stringify(value);
const fixtureSessionHash = (secret, pepper) =>
  createHash("sha256").update(`${pepper}${secret}`).digest("hex");

export const resetFixture = async (client) => {
  await client.query("begin");
  try {
    await client.query(
      `
        delete from semantic_memory_rebuild_jobs
        where memory_event_id = any($1::uuid[])
           or owner_user_id = any($2::uuid[])
      `,
      [fixtureEventIds, fixtureUserIds]
    );
    await client.query(
      `
        delete from memory_embeddings
        where owner_user_id = any($1::uuid[])
           or source_hash like $2
           or memory_node_id = any($3::uuid[])
           or memory_event_id = any($4::uuid[])
      `,
      [
        fixtureUserIds,
        `${FIXTURE_SOURCE_HASH_PREFIX}%`,
        fixtureNodeIds,
        fixtureEventIds
      ]
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
      "delete from team_session_share_grants where id = any($1::uuid[]) or team_id = $2",
      [fixtureShareGrantIds, fixtureTeam.id]
    );
    await client.query(
      `
        delete from memory_nodes
        where id = any($1::uuid[])
           or owner_user_id = any($2::uuid[])
           or source_hash like $3
      `,
      [fixtureNodeIds, fixtureUserIds, `${FIXTURE_SOURCE_HASH_PREFIX}%`]
    );
    await client.query(
      `
        delete from memory_events
        where id = any($1::uuid[])
           or owner_user_id = any($2::uuid[])
           or source_hash like $3
      `,
      [fixtureEventIds, fixtureUserIds, `${FIXTURE_SOURCE_HASH_PREFIX}%`]
    );
    await client.query(
      `
        delete from conversation_items
        where id = any($1::uuid[])
           or owner_user_id = any($2::uuid[])
           or source_hash like $3
      `,
      [
        fixtureConversationItemIds,
        fixtureUserIds,
        `${FIXTURE_SOURCE_HASH_PREFIX}%`
      ]
    );
    await client.query(
      `
        delete from messages
        where id = any($1::uuid[])
           or owner_user_id = any($2::uuid[])
           or source_hash like $3
      `,
      [fixtureMessageIds, fixtureUserIds, `${FIXTURE_SOURCE_HASH_PREFIX}%`]
    );
    await client.query(
      `
        delete from sessions
        where id = any($1::uuid[])
           or owner_user_id = any($2::uuid[])
           or source_hash like $3
      `,
      [fixtureSessionIds, fixtureUserIds, `${FIXTURE_SOURCE_HASH_PREFIX}%`]
    );
    await client.query(
      "delete from user_sessions where user_id = any($1::uuid[])",
      [fixtureUserIds]
    );
    await client.query(
      "delete from team_workspace_access_grants where team_id = $1 or team_workspace_id = any($2::uuid[])",
      [fixtureTeam.id, fixtureWorkspaceIds]
    );
    await client.query(
      "delete from team_workspaces where id = any($1::uuid[]) or team_id = $2",
      [fixtureWorkspaceIds, fixtureTeam.id]
    );
    await client.query(
      "delete from team_memberships where team_id = $1 or user_id = any($2::uuid[])",
      [fixtureTeam.id, fixtureUserIds]
    );
    await client.query("delete from team_invites where team_id = $1", [
      fixtureTeam.id
    ]);
    await client.query("delete from teams where id = $1", [fixtureTeam.id]);
    await client.query("delete from users where id = any($1::uuid[])", [
      fixtureUserIds
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
};

export const seedFixture = async (client) => {
  await resetFixture(client);
  await client.query("begin");
  try {
    for (const user of Object.values(fixtureUsers)) {
      await client.query(
        `
          insert into users (id, email, display_name, password_hash)
          values ($1, $2, $3, $4)
        `,
        [
          user.id,
          user.email,
          user.displayName,
          `${FIXTURE_VERSION}:password-not-for-login`
        ]
      );
    }

    if (process.env.API_TOKEN_PEPPER?.trim()) {
      for (const [userKey, user] of Object.entries(fixtureUsers)) {
        await client.query(
          `
            insert into user_sessions (user_id, session_hash, expires_at)
            values ($1, $2, now() + interval '30 days')
          `,
          [
            user.id,
            fixtureSessionHash(
              fixtureSessionSecrets[userKey],
              process.env.API_TOKEN_PEPPER
            )
          ]
        );
      }
    }

    await client.query("insert into teams (id, name) values ($1, $2)", [
      fixtureTeam.id,
      fixtureTeam.name
    ]);

    for (const user of Object.values(fixtureUsers)) {
      await client.query(
        `
          insert into team_memberships (
            team_id,
            user_id,
            role,
            status,
            accepted_at
          )
          values ($1, $2, $3, 'enabled', now())
        `,
        [fixtureTeam.id, user.id, user.role]
      );
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
            case when $4::team_workspace_access = 'disabled' then now() else null end,
            case when $4::team_workspace_access = 'disabled' then 'fixture_workspace_removal' else null end
          )
        `,
        [workspace.id, fixtureTeam.id, user.id, access, fixtureUsers.alice.id]
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
            $1, $2, 'personal', $3, 'codex', 'hook', $4, $5, $6, $7,
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
            $1, $2, $3, 'personal', 'user', $4, $5, 'codex', 'hook',
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
            $1, $2, $2, 'personal', 'captured', 'codex', 'hook', $3,
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
            $1, $2, $2, 'personal', 'leaf', 0, $3, $4, $5, 'codex', 'hook',
            $6, $7, $8, 1,
            ${deletedColumns ? "now()" : "null"},
            $9,
            $10
          )
        `,
        [
          memory.nodeId,
          owner.id,
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

      if (memory.shareState !== "private") {
        await client.query(
          `
            insert into team_session_share_grants (
              id,
              owner_user_id,
              session_id,
              team_id,
              team_workspace_id,
              granted_by_user_id,
              revoked_at,
              revoked_by_user_id,
              revocation_reason,
              personal_deleted_at,
              personal_deleted_by_user_id,
              personal_deletion_reason,
              retained_by_team_at,
              retention_reason
            )
            values (
              $1, $2, $3, $4, $5, $6,
              ${memory.shareState === "revoked" ? "now()" : "null"},
              $7,
              $8,
              ${memory.shareState === "personal_deleted_retained" ? "now()" : "null"},
              $9,
              $10,
              ${memory.shareState === "revoked" ? "null" : "now()"},
              $11
            )
          `,
          [
            memory.shareGrantId,
            owner.id,
            memory.sessionId,
            fixtureTeam.id,
            workspace.id,
            owner.id,
            memory.shareState === "revoked" ? owner.id : null,
            memory.shareState === "revoked" ? "fixture_revoked_share" : null,
            memory.shareState === "personal_deleted_retained" ? owner.id : null,
            memory.shareState === "personal_deleted_retained"
              ? "fixture_personal_deleted"
              : null,
            memory.shareState === "personal_deleted_retained"
              ? "fixture_team_retention_after_personal_deletion"
              : memory.shareState === "revoked"
                ? "fixture_revoked_share_not_retained"
                : "fixture_active_team_share"
          ]
        );
      }
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
};

export const teamVisibleMemoryQuery = `
  select distinct
    mn.title,
    mn.summary_text,
    mn.owner_user_id,
    me.id as memory_event_id,
    tssg.team_workspace_id
  from memory_nodes mn
  join memory_node_sources mns on mns.memory_node_id = mn.id
  join memory_events me on me.id = mns.memory_event_id
  join team_session_share_grants tssg on tssg.session_id = me.session_id
  join team_workspace_access_grants twag
    on twag.team_workspace_id = tssg.team_workspace_id
   and twag.team_id = tssg.team_id
  join team_memberships tm
    on tm.team_id = tssg.team_id
   and tm.user_id = twag.user_id
  where twag.user_id = $1
    and tssg.team_workspace_id = $2
    and tssg.team_id = $3
    and tssg.revoked_at is null
    and twag.access in ('read', 'write')
    and twag.disabled_at is null
    and tm.status = 'enabled'
    and mn.visibility = 'personal'
    and me.visibility = 'personal'
    and mn.invalidated_at is null
    and me.invalidated_at is null
  order by mn.title asc
`;

export const listTeamVisibleMemories = async (
  client,
  { userKey, workspaceKey }
) => {
  const result = await client.query(teamVisibleMemoryQuery, [
    fixtureUsers[userKey].id,
    fixtureWorkspaces[workspaceKey].id,
    fixtureTeam.id
  ]);
  return result.rows;
};

export const listTeamVisibleMessages = async (
  client,
  { userKey, workspaceKey }
) => {
  const result = await client.query(
    `
      select distinct
        msg.content,
        msg.id as message_id,
        tssg.team_workspace_id
      from messages msg
      join team_session_share_grants tssg on tssg.session_id = msg.session_id
      join team_workspace_access_grants twag
        on twag.team_workspace_id = tssg.team_workspace_id
       and twag.team_id = tssg.team_id
      join team_memberships tm
        on tm.team_id = tssg.team_id
       and tm.user_id = twag.user_id
      where twag.user_id = $1
        and tssg.team_workspace_id = $2
        and tssg.team_id = $3
        and tssg.revoked_at is null
        and twag.access in ('read', 'write')
        and twag.disabled_at is null
        and tm.status = 'enabled'
        and msg.visibility = 'personal'
        and msg.capture_method = 'hook'
        and msg.invalidated_at is null
      order by msg.content asc
    `,
    [
      fixtureUsers[userKey].id,
      fixtureWorkspaces[workspaceKey].id,
      fixtureTeam.id
    ]
  );
  return result.rows;
};

const titlesFor = (rows) => rows.map((row) => row.title).sort();
const workspaceAccessFor = (workspaceKey, userKey) =>
  fixtureWorkspaceAccess.find(
    ([candidateWorkspace, candidateUser]) =>
      candidateWorkspace === workspaceKey && candidateUser === userKey
  )?.[2] ?? null;
const expectedTeamVisibleTitles = ({ userKey, workspaceKey }) => {
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
    .map((memory) => memory.title)
    .sort();
};
const assertIncludes = (titles, title, label) => {
  if (!titles.includes(title)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(title)} to be visible`
    );
  }
};
const assertExcludes = (titles, title, label) => {
  if (titles.includes(title)) {
    throw new Error(`${label}: expected ${JSON.stringify(title)} to be hidden`);
  }
};
const assertDeepEqual = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
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

export const validateFixture = async (client) => {
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
  if (process.env.API_TOKEN_PEPPER?.trim()) {
    await assertCount(
      client,
      `
        select count(*)::int as count
        from user_sessions
        where user_id = any($1::uuid[])
          and revoked_at is null
          and expires_at > now()
      `,
      [fixtureUserIds],
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

  const electronForCarol = titlesFor(
    await listTeamVisibleMemories(client, {
      userKey: "carol",
      workspaceKey: "electron"
    })
  );
  assertIncludes(
    electronForCarol,
    "Workspace Memory Timeline UX",
    "Electron Team App for Carol"
  );
  assertIncludes(
    electronForCarol,
    "Agent Collaboration Rooms",
    "Electron Team App for Carol"
  );
  assertExcludes(
    electronForCarol,
    "Revoked Electron Experiment",
    "Electron Team App for Carol"
  );
  assertExcludes(
    electronForCarol,
    "Private DevOps Scratchpad",
    "Electron Team App for Carol"
  );

  const cloudForAlice = titlesFor(
    await listTeamVisibleMemories(client, {
      userKey: "alice",
      workspaceKey: "cloud"
    })
  );
  assertIncludes(
    cloudForAlice,
    "Flat User-Owned Memory Model",
    "Cloud Memory Platform for Alice"
  );
  assertIncludes(
    cloudForAlice,
    "Cloud API Superset Contract",
    "Cloud Memory Platform for Alice"
  );
  assertIncludes(
    cloudForAlice,
    "Retained Billing Grace Decision",
    "Cloud Memory Platform for Alice"
  );
  assertIncludes(
    cloudForAlice,
    "Removed Member Deployment Note",
    "Cloud Memory Platform for Alice"
  );
  assertExcludes(
    cloudForAlice,
    "Private Pricing Scratchpad",
    "Cloud Memory Platform for Alice"
  );

  const cloudForBob = titlesFor(
    await listTeamVisibleMemories(client, {
      userKey: "bob",
      workspaceKey: "cloud"
    })
  );
  if (cloudForBob.length !== 0) {
    throw new Error(
      `Cloud Memory Platform for Bob: expected no visible memories after Workspace removal, got ${cloudForBob.join(", ")}`
    );
  }

  const ingestionForBob = titlesFor(
    await listTeamVisibleMemories(client, {
      userKey: "bob",
      workspaceKey: "ingestion"
    })
  );
  assertIncludes(
    ingestionForBob,
    "Provider Fallback Ingestion",
    "Managed Knowledge Ingestion for Bob"
  );
  assertIncludes(
    ingestionForBob,
    "Checksum Dedupe Inventory",
    "Managed Knowledge Ingestion for Bob"
  );
  assertIncludes(
    ingestionForBob,
    "Memory Inbox Product Boundary",
    "Managed Knowledge Ingestion for Bob"
  );
  assertExcludes(
    ingestionForBob,
    "Private Agent Prompt Scratchpad",
    "Managed Knowledge Ingestion for Bob"
  );

  for (const userKey of Object.keys(fixtureUsers)) {
    for (const workspaceKey of Object.keys(fixtureWorkspaces)) {
      const label = `${fixtureWorkspaces[workspaceKey].name} for ${fixtureUsers[userKey].displayName}`;
      const actual = titlesFor(
        await listTeamVisibleMemories(client, { userKey, workspaceKey })
      );
      const expected = expectedTeamVisibleTitles({ userKey, workspaceKey });
      assertDeepEqual(actual, expected, `${label} Team-visible candidates`);
    }
  }

  const electronMessagesForCarol = (
    await listTeamVisibleMessages(client, {
      userKey: "carol",
      workspaceKey: "electron"
    })
  ).map((row) => row.content);
  if (
    !electronMessagesForCarol.some((content) =>
      content.includes("Workspace Memory Timeline")
    )
  ) {
    throw new Error(
      "Electron Team App for Carol: expected hook message timeline rows"
    );
  }

  assertExcludes(
    electronMessagesForCarol,
    fixtureMemory("david-electron-revoked-experiment").content,
    "Electron Team App message timeline for Carol"
  );

  return {
    users: fixtureUserIds.length,
    workspaces: fixtureWorkspaceIds.length,
    memories: fixtureMemoryRows.length,
    checks: [
      "Fixture rows exist before visibility exclusions are checked",
      "Fixture API sessions are available when API_TOKEN_PEPPER is configured",
      "Electron hides revoked and private memories",
      "Electron has hook message rows for graph/timeline checks",
      "Team-visible candidate selection matches the full user and Workspace truth matrix",
      "Team-visible graph sources preserve memory_event and message evidence items",
      "Cloud includes retained Team knowledge after personal deletion",
      "Cloud blocks Bob after Workspace removal",
      "Workspace access removal does not delete Team-retained source rows",
      "Managed Knowledge Ingestion hides private agent prompt scratchpad",
      "API-session-backed fixture users support remote browser validation"
    ]
  };
};
