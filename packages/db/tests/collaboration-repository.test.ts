import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID
} from "node:crypto";
import {
  COLLABORATION_CONTRACT_VERSION,
  createLocalTestKeyEnvelopeEncryptionProvider,
  createManagedKmsEnvelopeEncryptionProvider,
  type EnvelopeEncryptionProvider,
  type ManagedKmsKeyring
} from "@koed/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";

import {
  CollaborationIdempotencyConflictError,
  CollaborationStateConflictError,
  CollaborationVersionConflictError,
  collaborationSubscriptionPrincipalHash,
  createCollaborationRepository,
  type CollaborationThreadRecord
} from "../src/collaboration-repository.js";
import { createDbPool } from "../src/connection.js";
import { createCapturedSessionRepository } from "../src/captured-session-repository.js";
import { createEncryptedPayloadRepository } from "../src/encrypted-payload-repository.js";
import { runDbMigrations } from "../src/migrate.js";
import { createTeamAccessRepository } from "../src/team-access-repository.js";

const databaseUrl = process.env.COLLABORATION_TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
const actor = (userId: string) => ({ userId });
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const managedKeyring = (
  keyVersion: number,
  keys: Readonly<Record<number, Buffer>>
): ManagedKmsKeyring => ({
  keyId: "managed-kms:collaboration-test",
  keyVersion,
  wrapDek(input) {
    const key = keys[input.keyVersion];
    if (!key) throw new Error("Unknown managed test key version");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(input.aad);
    const ciphertext = Buffer.concat([
      cipher.update(input.dek),
      cipher.final()
    ]);
    return {
      ciphertext: ciphertext.toString("base64"),
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64")
    };
  },
  unwrapDek(input) {
    const key = keys[input.keyVersion];
    if (!key) throw new Error("Unknown managed test key version");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(input.wrappedDek.nonce, "base64")
    );
    decipher.setAAD(input.aad);
    decipher.setAuthTag(Buffer.from(input.wrappedDek.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(input.wrappedDek.ciphertext, "base64")),
      decipher.final()
    ]);
  },
  status: () => ({
    mode: "managed_kms",
    keyId: "managed-kms:collaboration-test",
    keyVersion,
    status: "available"
  })
});

describeDb("Collaboration repository", () => {
  let pool: pg.Pool;
  let competingPool: pg.Pool;
  let provider: EnvelopeEncryptionProvider;
  let repository: ReturnType<typeof createCollaborationRepository>;
  let competingRepository: ReturnType<typeof createCollaborationRepository>;

  const createUser = async (label: string): Promise<string> => {
    const result = await pool.query<{ id: string }>(
      `insert into users (email,display_name)
       values ($1,$2) returning id`,
      [`collaboration-${label}-${randomUUID()}@example.test`, label]
    );
    return result.rows[0]!.id;
  };

  const createTeamFixture = async () => {
    const ownerUserId = await createUser("Owner");
    const memberUserId = await createUser("Member");
    const secondMemberUserId = await createUser("Second Member");
    const outsiderUserId = await createUser("Outsider");
    const team = await pool.query<{ id: string }>(
      `insert into teams (name,entitlement_status)
       values ($1,'active') returning id`,
      [`Collaboration Team ${randomUUID()}`]
    );
    const teamId = team.rows[0]!.id;
    const workspace = await pool.query<{ id: string }>(
      `insert into team_workspaces (team_id,name)
       values ($1,$2) returning id`,
      [teamId, `Workspace ${randomUUID()}`]
    );
    const teamWorkspaceId = workspace.rows[0]!.id;
    await pool.query(
      `insert into team_memberships (
         team_id,user_id,role,status,accepted_at
       ) values
         ($1,$2,'owner','enabled',now()),
         ($1,$3,'member','enabled',now()),
         ($1,$4,'member','enabled',now())`,
      [teamId, ownerUserId, memberUserId, secondMemberUserId]
    );
    await pool.query(
      `insert into team_workspace_access_grants (
         team_workspace_id,team_id,user_id,access,granted_by_user_id
       ) values
         ($1,$2,$3,'write',$3),
         ($1,$2,$4,'write',$3),
         ($1,$2,$5,'read',$3)`,
      [teamWorkspaceId, teamId, ownerUserId, memberUserId, secondMemberUserId]
    );
    return {
      ownerUserId,
      memberUserId,
      secondMemberUserId,
      outsiderUserId,
      teamId,
      teamWorkspaceId
    };
  };

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
    competingPool = createDbPool({ connectionString: databaseUrl });
    provider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 73).toString("base64")
    );
    repository = createCollaborationRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    competingRepository = createCollaborationRepository(competingPool, {
      envelopeEncryptionProvider: provider
    });
  });

  afterAll(async () => {
    await Promise.all([pool.end(), competingPool.end()]);
  });

  it("materializes Personal Memory only for its current owner", async () => {
    const ownerUserId = await createUser("Personal Memory Owner");
    const outsiderUserId = await createUser("Personal Memory Outsider");
    const sessions = createCapturedSessionRepository(pool);
    const session = await sessions.createCapturedSession(actor(ownerUserId), {
      externalSessionId: `realtime-${randomUUID()}`,
      metadata: { threadName: "Owner-only realtime memory" }
    });

    await expect(
      repository.getPersonalMemoryForRealtime(actor(ownerUserId), {
        sessionId: session.id
      })
    ).resolves.toMatchObject({
      sessionId: session.id,
      title: "Owner-only realtime memory"
    });
    await expect(
      repository.getPersonalMemoryForRealtime(actor(outsiderUserId), {
        sessionId: session.id
      })
    ).resolves.toBeNull();
  });

  it("converges two clients on channel-name and participant-set identities", async () => {
    const personalOwnerUserId = await createUser("Natural Personal Owner");
    const personalKeyA = `personal-name-a:${randomUUID()}`;
    const personalKeyB = `personal-name-b:${randomUUID()}`;
    const [personalA, personalB] = await Promise.all([
      repository.createThread(actor(personalOwnerUserId), {
        kind: "personal_channel",
        idempotencyKey: personalKeyA,
        name: "  Incident   Room  ",
        topic: "Same semantic request"
      }),
      competingRepository.createThread(actor(personalOwnerUserId), {
        kind: "personal_channel",
        idempotencyKey: personalKeyB,
        name: "incident room",
        topic: "Same semantic request"
      })
    ]);
    expect(personalA?.id).toBe(personalB?.id);

    const fixture = await createTeamFixture();
    const [workspaceA, workspaceB] = await Promise.all([
      repository.createThread(actor(fixture.ownerUserId), {
        kind: "workspace_channel",
        idempotencyKey: `workspace-name-a:${randomUUID()}`,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        name: "  Release   Train  ",
        topic: "Same semantic request"
      }),
      competingRepository.createThread(actor(fixture.memberUserId), {
        kind: "workspace_channel",
        idempotencyKey: `workspace-name-b:${randomUUID()}`,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        name: "release train",
        topic: "Same semantic request"
      })
    ]);
    expect(workspaceA?.id).toBe(workspaceB?.id);

    const [dmA, dmB] = await Promise.all([
      repository.createThread(actor(fixture.ownerUserId), {
        kind: "dm",
        idempotencyKey: `dm-pair-a:${randomUUID()}`,
        teamId: fixture.teamId,
        participantUserIds: [fixture.memberUserId]
      }),
      competingRepository.createThread(actor(fixture.memberUserId), {
        kind: "dm",
        idempotencyKey: `dm-pair-b:${randomUUID()}`,
        teamId: fixture.teamId,
        participantUserIds: [fixture.ownerUserId]
      })
    ]);
    expect(dmA?.id).toBe(dmB?.id);

    const [groupA, groupB] = await Promise.all([
      repository.createThread(actor(fixture.ownerUserId), {
        kind: "group_dm",
        idempotencyKey: `group-set-a:${randomUUID()}`,
        teamId: fixture.teamId,
        participantUserIds: [fixture.memberUserId, fixture.secondMemberUserId]
      }),
      competingRepository.createThread(actor(fixture.secondMemberUserId), {
        kind: "group_dm",
        idempotencyKey: `group-set-b:${randomUUID()}`,
        teamId: fixture.teamId,
        participantUserIds: [fixture.memberUserId, fixture.ownerUserId]
      })
    ]);
    expect(groupA?.id).toBe(groupB?.id);

    const identities = await pool.query<{
      id: string;
      logical_id: string;
      participant_count: string;
      outbox_count: string;
    }>(
      `select t.id,
              t.logical_id,
              count(distinct p.user_id)::text as participant_count,
              count(distinct o.id)::text as outbox_count
         from collaboration_threads t
         left join collaboration_participants p on p.thread_id=t.id
         left join collaboration_outbox o
           on o.thread_id=t.id and o.family='thread_lifecycle'
        where t.id=any($1::uuid[])
        group by t.id,t.logical_id`,
      [[personalA!.id, workspaceA!.id, dmA!.id, groupA!.id]]
    );
    expect(new Set(identities.rows.map((row) => row.logical_id)).size).toBe(4);
    expect(
      new Map(
        identities.rows.map((row) => [
          row.id,
          [row.participant_count, row.outbox_count]
        ])
      )
    ).toEqual(
      new Map([
        [personalA!.id, ["0", "1"]],
        [workspaceA!.id, ["0", "1"]],
        [dmA!.id, ["2", "1"]],
        [groupA!.id, ["3", "1"]]
      ])
    );
  });

  it("keeps group-DM participants immutable and denies a disabled participant without substituting another User", async () => {
    const fixture = await createTeamFixture();
    const original = await repository.createThread(actor(fixture.ownerUserId), {
      kind: "group_dm",
      idempotencyKey: `immutable-group:${randomUUID()}`,
      teamId: fixture.teamId,
      participantUserIds: [fixture.memberUserId, fixture.secondMemberUserId]
    });
    const originalMessage = await repository.sendMessage(
      actor(fixture.ownerUserId),
      {
        threadId: original!.id,
        idempotencyKey: `immutable-group-message:${randomUUID()}`,
        bodyText: "Original participant-set history"
      }
    );
    const originalParticipants = [
      fixture.ownerUserId,
      fixture.memberUserId,
      fixture.secondMemberUserId
    ].sort();
    await pool.query(
      `insert into team_memberships (
         team_id,user_id,role,status,accepted_at
       ) values ($1,$2,'member','enabled',now())`,
      [fixture.teamId, fixture.outsiderUserId]
    );
    const distinct = await repository.createThread(actor(fixture.ownerUserId), {
      kind: "group_dm",
      idempotencyKey: `distinct-group:${randomUUID()}`,
      teamId: fixture.teamId,
      participantUserIds: [fixture.secondMemberUserId, fixture.outsiderUserId]
    });

    expect(distinct?.id).not.toBe(original?.id);
    await expect(
      repository.listMessages(actor(fixture.ownerUserId), {
        threadId: distinct!.id
      })
    ).resolves.toMatchObject({ messages: [] });
    await expect(
      repository.getThread(actor(fixture.outsiderUserId), {
        threadId: original!.id
      })
    ).resolves.toBeNull();
    await expect(
      repository.getThread(actor(fixture.memberUserId), {
        threadId: distinct!.id
      })
    ).resolves.toBeNull();

    const channel = await repository.createThread(actor(fixture.ownerUserId), {
      kind: "workspace_channel",
      idempotencyKey: `disabled-user-channel:${randomUUID()}`,
      teamId: fixture.teamId,
      teamWorkspaceId: fixture.teamWorkspaceId,
      name: `disabled-user-${randomUUID()}`
    });
    await expect(
      repository.getThread(actor(fixture.memberUserId), {
        threadId: channel!.id
      })
    ).resolves.toMatchObject({ id: channel!.id });

    await pool.query(`update users set disabled_at=now() where id=$1`, [
      fixture.memberUserId
    ]);

    await expect(
      repository.getThread(actor(fixture.memberUserId), {
        threadId: original!.id
      })
    ).resolves.toBeNull();
    await expect(
      repository.listMessages(actor(fixture.memberUserId), {
        threadId: original!.id
      })
    ).resolves.toBeNull();
    await expect(
      repository.sendMessage(actor(fixture.memberUserId), {
        threadId: original!.id,
        idempotencyKey: `disabled-group-send:${randomUUID()}`,
        bodyText: "Must not be persisted"
      })
    ).resolves.toBeNull();
    await expect(
      repository.getThread(actor(fixture.memberUserId), {
        threadId: channel!.id
      })
    ).resolves.toBeNull();
    await expect(
      repository.getThread(actor(fixture.outsiderUserId), {
        threadId: original!.id
      })
    ).resolves.toBeNull();

    const storedParticipants = await pool.query<{ user_id: string }>(
      `select user_id
         from collaboration_participants
        where thread_id=$1
        order by user_id`,
      [original!.id]
    );
    expect(storedParticipants.rows.map(({ user_id }) => user_id)).toEqual(
      originalParticipants
    );
    await expect(
      repository.listMessages(actor(fixture.ownerUserId), {
        threadId: original!.id
      })
    ).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: originalMessage!.id })]
    });
  });

  it("rejects a two-client idempotency race with divergent logical thread identities", async () => {
    const ownerUserId = await createUser("Logical Identity Owner");
    const idempotencyKey = `logical-thread:${randomUUID()}`;
    const results = await Promise.allSettled([
      repository.createThread(actor(ownerUserId), {
        kind: "personal_channel",
        idempotencyKey,
        name: "First interpretation"
      }),
      competingRepository.createThread(actor(ownerUserId), {
        kind: "personal_channel",
        idempotencyKey,
        name: "Second interpretation"
      })
    ]);
    const fulfilled = results.filter(
      (
        result
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof repository.createThread>>
      > => result.status === "fulfilled"
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(
      CollaborationIdempotencyConflictError
    );
    const winner = fulfilled[0]!.value;
    expect(winner).not.toBeNull();
    if (!winner) throw new Error("Expected one durable thread winner");

    const durable = await pool.query<{
      threads: string;
      logical_ids: string;
      encrypted_names: string;
      outbox_events: string;
    }>(
      `select
         (select count(*)::text
            from collaboration_threads
           where id=$1) as threads,
         (select count(distinct logical_id)::text
            from collaboration_threads
           where id=$1) as logical_ids,
         (select count(*)::text
            from encrypted_field_payloads
           where source_table='collaboration_threads'
             and source_id=$1
             and source_column='name'
             and invalidated_at is null) as encrypted_names,
         (select count(*)::text
            from collaboration_outbox
           where thread_id=$1 and family='thread_lifecycle') as outbox_events`,
      [winner.id]
    );
    expect(durable.rows[0]).toEqual({
      threads: "1",
      logical_ids: "1",
      encrypted_names: "1",
      outbox_events: "1"
    });
  });

  it("keeps Personal notes and channels owner-only, encrypted, idempotent, and replayable", async () => {
    const ownerUserId = await createUser("Personal Owner");
    const outsiderUserId = await createUser("Personal Outsider");
    const concurrentNotes = await Promise.all(
      Array.from({ length: 4 }, () =>
        repository.createThread(actor(ownerUserId), {
          kind: "notes_to_self",
          idempotencyKey: `notes:${randomUUID()}`
        })
      )
    );
    const notes = concurrentNotes[0];
    expect(new Set(concurrentNotes.map((thread) => thread?.id)).size).toBe(1);
    expect(notes).toMatchObject({
      scope: "personal",
      kind: "notes_to_self",
      personalOwnerUserId: ownerUserId,
      participants: [{ userId: ownerUserId }]
    });
    const notesAgain = await repository.createThread(actor(ownerUserId), {
      kind: "notes_to_self",
      idempotencyKey: `notes:${randomUUID()}`
    });
    expect(notesAgain?.id).toBe(notes?.id);

    const channel = await repository.createThread(actor(ownerUserId), {
      kind: "personal_channel",
      idempotencyKey: `personal-channel:${randomUUID()}`,
      name: "Private scratch",
      topic: "Planning notes"
    });
    expect(channel).toMatchObject({
      scope: "personal",
      kind: "personal_channel",
      name: "Private scratch",
      topic: "Planning notes"
    });
    expect(
      await repository.getThread(actor(outsiderUserId), {
        threadId: channel!.id
      })
    ).toBeNull();

    const noteMessages = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        repository.sendMessage(actor(ownerUserId), {
          threadId: notes!.id,
          idempotencyKey: `note-message:${index}:${randomUUID()}`,
          bodyText: `Concurrent private note ${index}`
        })
      )
    );
    expect(noteMessages.every(Boolean)).toBe(true);
    expect(
      new Set(noteMessages.map((message) => message?.threadSequence))
    ).toEqual(new Set([1, 2, 3, 4]));
    expect(
      await repository.listMessages(actor(outsiderUserId), {
        threadId: notes!.id,
        limit: 10
      })
    ).toBeNull();
    expect(
      await repository.advanceReadState(actor(outsiderUserId), {
        threadId: notes!.id,
        messageId: noteMessages[0]!.id
      })
    ).toBeNull();

    const idempotencyKey = `personal-message:${randomUUID()}`;
    const first = await repository.sendMessage(actor(ownerUserId), {
      threadId: channel!.id,
      idempotencyKey,
      bodyText: "Only encrypted storage should contain this message.",
      metadata: { purpose: "test" },
      provenance: { kind: "user", id: randomUUID() }
    });
    const replay = await repository.sendMessage(actor(ownerUserId), {
      threadId: channel!.id,
      idempotencyKey,
      bodyText: "Only encrypted storage should contain this message.",
      metadata: { purpose: "test" },
      provenance: first!.provenance
    });
    expect(replay).toEqual(first);
    await expect(
      repository.sendMessage(actor(ownerUserId), {
        threadId: channel!.id,
        idempotencyKey,
        bodyText: "A conflicting replay must fail.",
        provenance: first!.provenance
      })
    ).rejects.toBeInstanceOf(CollaborationIdempotencyConflictError);

    const stored = await pool.query<{
      body_marker: string;
      payload_count: string;
      outbox_count: string;
    }>(
      `select m.body_marker,
         (select count(*)::text from encrypted_field_payloads p
           where p.source_table='collaboration_messages' and p.source_id=m.id) as payload_count,
         (select count(*)::text from collaboration_outbox o
           where o.message_id=m.id and o.family='message_created') as outbox_count
       from collaboration_messages m where m.id=$1`,
      [first!.id]
    );
    expect(stored.rows[0]).toEqual({
      body_marker: "[koed encrypted collaboration message]",
      payload_count: "3",
      outbox_count: "1"
    });
    expect(JSON.stringify(stored.rows[0])).not.toContain(
      "Only encrypted storage"
    );

    const page = await repository.listMessages(actor(ownerUserId), {
      threadId: channel!.id,
      limit: 10
    });
    expect(page?.messages).toEqual([first]);
    await expect(
      repository.getMessageForRealtime(actor(ownerUserId), {
        threadId: channel!.id,
        messageId: first!.id
      })
    ).resolves.toEqual(first);
    await expect(
      repository.getMessageForRealtime(actor(outsiderUserId), {
        threadId: channel!.id,
        messageId: first!.id
      })
    ).resolves.toBeNull();
    const read = await repository.advanceReadState(actor(ownerUserId), {
      threadId: channel!.id,
      messageId: first!.id
    });
    expect(read).toMatchObject({
      threadId: channel!.id,
      lastReadMessageId: first!.id,
      lastReadSequence: 1
    });
    await expect(
      repository.getReceiptStateForRealtime(actor(ownerUserId), {
        threadId: channel!.id
      })
    ).resolves.toEqual(read);
    await expect(
      repository.getReceiptStateForRealtime(actor(outsiderUserId), {
        threadId: channel!.id
      })
    ).resolves.toBeNull();
    const snapshot = await repository.getAuthorizedSnapshot(
      actor(ownerUserId),
      { scope: "personal" }
    );
    expect(snapshot?.threads.map((thread) => thread.id)).toEqual(
      expect.arrayContaining([notes!.id, channel!.id])
    );
    const events = await repository.replayEvents(actor(ownerUserId), {
      scope: "personal",
      afterCursor: 0,
      limit: 100
    });
    expect(events?.events.some((event) => event.messageId === first!.id)).toBe(
      true
    );

    const archived = await repository.archiveThread(actor(ownerUserId), {
      threadId: channel!.id,
      expectedVersion: channel!.version
    });
    expect(archived).toMatchObject({
      id: channel!.id,
      lifecycle: "archived",
      version: channel!.version + 1
    });
    expect(archived?.archivedAt).not.toBeNull();
    await expect(
      repository.getThread(actor(ownerUserId), { threadId: channel!.id })
    ).resolves.toBeNull();
    await expect(
      repository.getThread(actor(ownerUserId), {
        threadId: channel!.id,
        includeArchived: true
      })
    ).resolves.toMatchObject({ id: channel!.id, lifecycle: "archived" });
    await expect(
      repository.restoreThread(actor(outsiderUserId), {
        threadId: channel!.id,
        expectedVersion: archived!.version
      })
    ).resolves.toBeNull();

    const restored = await repository.restoreThread(actor(ownerUserId), {
      threadId: channel!.id,
      expectedVersion: archived!.version
    });
    expect(restored).toMatchObject({
      id: channel!.id,
      lifecycle: "active",
      archivedAt: null,
      version: archived!.version + 1
    });
  });

  it("keeps encrypted collaboration metadata out of structural and JSON payload records", async () => {
    const fixture = await createTeamFixture();
    const teamAccessRepository = createTeamAccessRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const sentinels = {
      threadName: "plaintext-thread-name-structural-sentinel",
      threadTopic: "plaintext-thread-topic-structural-sentinel",
      workspaceDescription:
        "plaintext-workspace-description-structural-sentinel",
      messagePreview: "plaintext-message-preview-structural-sentinel",
      messageBody: "plaintext-message-body-structural-sentinel",
      messageMetadata: "plaintext-message-metadata-structural-sentinel",
      provenanceKind: "plaintext-provenance-kind-structural-sentinel",
      provenanceId: "plaintext-provenance-id-structural-sentinel",
      provenanceDetails: "plaintext-provenance-details-structural-sentinel",
      editedBody: "plaintext-edited-body-structural-sentinel",
      deletedBody: "plaintext-deleted-body-structural-sentinel",
      threadIdempotency: "plaintext-thread-idempotency-structural-sentinel",
      messageIdempotency: "plaintext-message-idempotency-structural-sentinel",
      requestPayload: "plaintext-request-payload-structural-sentinel"
    } as const;

    const workspace = await teamAccessRepository.createTeamWorkspace(
      actor(fixture.ownerUserId),
      {
        teamId: fixture.teamId,
        name: `Structural classification ${randomUUID()}`,
        description: sentinels.workspaceDescription
      }
    );
    if (!workspace) throw new Error("Expected an authorized Team Workspace");

    const channel = await repository.createThread(actor(fixture.ownerUserId), {
      kind: "workspace_channel",
      idempotencyKey: sentinels.threadIdempotency,
      teamId: fixture.teamId,
      teamWorkspaceId: workspace.id,
      name: sentinels.threadName,
      topic: sentinels.threadTopic
    });
    if (!channel) throw new Error("Expected an authorized Workspace channel");

    const message = await repository.sendMessage(actor(fixture.ownerUserId), {
      threadId: channel.id,
      idempotencyKey: sentinels.messageIdempotency,
      bodyText: sentinels.messageBody,
      metadata: {
        preview: sentinels.messagePreview,
        classification: sentinels.messageMetadata,
        requestPayload: sentinels.requestPayload
      },
      provenance: {
        kind: sentinels.provenanceKind,
        id: sentinels.provenanceId,
        details: { classification: sentinels.provenanceDetails }
      }
    });
    if (!message) throw new Error("Expected an authorized message");

    expect(workspace.description).toBe(sentinels.workspaceDescription);
    expect(channel).toMatchObject({
      name: sentinels.threadName,
      topic: sentinels.threadTopic
    });
    expect(message).toMatchObject({
      bodyText: sentinels.messageBody,
      metadata: {
        preview: sentinels.messagePreview,
        classification: sentinels.messageMetadata,
        requestPayload: sentinels.requestPayload
      },
      provenance: {
        kind: sentinels.provenanceKind,
        id: sentinels.provenanceId,
        details: { classification: sentinels.provenanceDetails }
      }
    });

    const structural = await pool.query<{
      description_marker: string;
      name_marker: string;
      topic_marker: string;
      normalized_name_hash: string;
      body_marker: string;
      metadata_marker: string;
      provenance_kind: string;
      provenance_id: string;
      provenance_marker: string;
      idempotency_key_hash: string;
      request_hash: string;
      edited_body_marker: string | null;
      deleted_body_marker: string | null;
    }>(
      `select w.description_marker,
              t.name_marker,
              t.topic_marker,
              t.normalized_name_hash,
              m.body_marker,
              m.metadata_marker,
              m.provenance_kind,
              m.provenance_id,
              m.provenance_marker,
              m.idempotency_key_hash,
              m.request_hash,
              m.edited_body_marker,
              m.deleted_body_marker
         from team_workspaces w
         join collaboration_threads t on t.team_workspace_id=w.id
         join collaboration_messages m on m.thread_id=t.id
        where w.id=$1 and t.id=$2 and m.id=$3`,
      [workspace.id, channel.id, message.id]
    );
    expect(structural.rows[0]).toMatchObject({
      description_marker: "[koed encrypted team workspace description]",
      name_marker: "[koed encrypted collaboration name]",
      topic_marker: "[koed encrypted collaboration topic]",
      body_marker: "[koed encrypted collaboration message]",
      metadata_marker: "[koed encrypted collaboration metadata]",
      provenance_kind: "encrypted",
      provenance_marker: "[koed encrypted collaboration provenance]",
      edited_body_marker: null,
      deleted_body_marker: null
    });
    for (const opaqueHash of [
      structural.rows[0]!.normalized_name_hash,
      structural.rows[0]!.provenance_id,
      structural.rows[0]!.idempotency_key_hash,
      structural.rows[0]!.request_hash
    ]) {
      expect(opaqueHash).toMatch(/^[0-9a-f]{64}$/);
    }

    const payloads = await pool.query<{
      source_table: string;
      source_column: string;
      record_json: string;
    }>(
      `select source_table,source_column,to_jsonb(p)::text as record_json
         from encrypted_field_payloads p
        where (source_table='team_workspaces' and source_id=$1)
           or (source_table='collaboration_threads' and source_id=$2)
           or (source_table='collaboration_messages' and source_id=$3)
        order by source_table,source_column`,
      [workspace.id, channel.id, message.id]
    );
    expect(
      payloads.rows.map(
        ({ source_table, source_column }) => `${source_table}.${source_column}`
      )
    ).toEqual([
      "collaboration_messages.body",
      "collaboration_messages.metadata",
      "collaboration_messages.provenance",
      "collaboration_threads.name",
      "collaboration_threads.topic",
      "team_workspaces.description"
    ]);

    const storedRecords = await pool.query<{ record_json: string }>(
      `select to_jsonb(w)::text as record_json
         from team_workspaces w where w.id=$1
       union all
       select to_jsonb(t)::text from collaboration_threads t where t.id=$2
       union all
       select to_jsonb(m)::text from collaboration_messages m where m.id=$3
       union all
       select to_jsonb(o)::text from collaboration_outbox o
        where o.thread_id=$2 or o.message_id=$3`,
      [workspace.id, channel.id, message.id]
    );
    const serializedStorage = JSON.stringify([
      ...storedRecords.rows.map((row) => row.record_json),
      ...payloads.rows.map((row) => row.record_json)
    ]);
    for (const plaintext of Object.values(sentinels)) {
      expect(serializedStorage).not.toContain(plaintext);
    }

    const columns = await pool.query<{
      table_name: string;
      column_name: string;
    }>(
      `select table_name,column_name
         from information_schema.columns
        where table_schema='public'
          and table_name in (
            'team_workspaces',
            'collaboration_threads',
            'collaboration_messages'
          )`
    );
    const columnNames = new Set(
      columns.rows.map(
        ({ table_name, column_name }) => `${table_name}.${column_name}`
      )
    );
    for (const forbiddenColumn of [
      "team_workspaces.description",
      "collaboration_threads.name",
      "collaboration_threads.topic",
      "collaboration_messages.preview",
      "collaboration_messages.body",
      "collaboration_messages.metadata",
      "collaboration_messages.provenance",
      "collaboration_messages.edited_body",
      "collaboration_messages.deleted_body",
      "collaboration_messages.idempotency_key",
      "collaboration_messages.request_payload"
    ]) {
      expect(columnNames.has(forbiddenColumn)).toBe(false);
    }
  });

  it("lets one current version win rename, topic, archive, and restore races without extra events", async () => {
    const ownerUserId = await createUser("Version Race Owner");
    const outsiderUserId = await createUser("Version Race Outsider");
    const channel = await repository.createThread(actor(ownerUserId), {
      kind: "personal_channel",
      idempotencyKey: `version-race:${randomUUID()}`,
      name: "version-race",
      topic: "initial"
    });
    if (!channel) throw new Error("Expected a Personal channel");

    const singleWinner = async (
      left: Promise<CollaborationThreadRecord | null>,
      right: Promise<CollaborationThreadRecord | null>
    ): Promise<CollaborationThreadRecord> => {
      const results = await Promise.allSettled([left, right]);
      const fulfilled = results.filter(
        (
          result
        ): result is PromiseFulfilledResult<CollaborationThreadRecord | null> =>
          result.status === "fulfilled"
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(
        CollaborationVersionConflictError
      );
      const winner = fulfilled[0]!.value;
      if (!winner) throw new Error("Expected one authorized version winner");
      return winner;
    };

    const renamed = await singleWinner(
      repository.renameThread(actor(ownerUserId), {
        threadId: channel.id,
        expectedVersion: channel.version,
        name: "winner-alpha"
      }),
      competingRepository.renameThread(actor(ownerUserId), {
        threadId: channel.id,
        expectedVersion: channel.version,
        name: "winner-beta"
      })
    );
    expect(renamed).toMatchObject({ version: 2 });
    expect(["winner-alpha", "winner-beta"]).toContain(renamed?.name);

    const topic = await singleWinner(
      repository.updateThreadTopic(actor(ownerUserId), {
        threadId: channel.id,
        expectedVersion: 2,
        topic: "topic-alpha"
      }),
      competingRepository.updateThreadTopic(actor(ownerUserId), {
        threadId: channel.id,
        expectedVersion: 2,
        topic: "topic-beta"
      })
    );
    expect(topic).toMatchObject({ version: 3 });
    expect(["topic-alpha", "topic-beta"]).toContain(topic?.topic);

    const archived = await singleWinner(
      repository.archiveThread(actor(ownerUserId), {
        threadId: channel.id,
        expectedVersion: 3
      }),
      competingRepository.archiveThread(actor(ownerUserId), {
        threadId: channel.id,
        expectedVersion: 3
      })
    );
    expect(archived).toMatchObject({ version: 4, lifecycle: "archived" });

    const restored = await singleWinner(
      repository.restoreThread(actor(ownerUserId), {
        threadId: channel.id,
        expectedVersion: 4
      }),
      competingRepository.restoreThread(actor(ownerUserId), {
        threadId: channel.id,
        expectedVersion: 4
      })
    );
    expect(restored).toMatchObject({ version: 5, lifecycle: "active" });
    await expect(
      repository.renameThread(actor(outsiderUserId), {
        threadId: channel.id,
        expectedVersion: 5,
        name: "unauthorized"
      })
    ).resolves.toBeNull();

    const durable = await pool.query<{
      version: number;
      lifecycle: string;
      outbox_count: string;
    }>(
      `select t.version,
              t.lifecycle::text as lifecycle,
              count(o.id)::text as outbox_count
         from collaboration_threads t
         left join collaboration_outbox o
           on o.thread_id=t.id and o.family='thread_lifecycle'
        where t.id=$1
        group by t.id,t.version,t.lifecycle`,
      [channel.id]
    );
    expect(durable.rows[0]).toEqual({
      version: 5,
      lifecycle: "active",
      outbox_count: "5"
    });
  });

  it("enforces Team, Workspace, thread, participant, and decrypt authorization", async () => {
    const fixture = await createTeamFixture();
    const otherFixture = await createTeamFixture();
    const channel = await repository.createThread(actor(fixture.ownerUserId), {
      kind: "workspace_channel",
      idempotencyKey: `workspace-channel:${randomUUID()}`,
      teamId: fixture.teamId,
      teamWorkspaceId: fixture.teamWorkspaceId,
      name: "delivery",
      topic: "Team delivery"
    });
    expect(channel).toMatchObject({
      scope: "team",
      kind: "workspace_channel",
      teamId: fixture.teamId,
      teamWorkspaceId: fixture.teamWorkspaceId
    });
    expect(
      await repository.getThread(actor(fixture.outsiderUserId), {
        threadId: channel!.id
      })
    ).toBeNull();
    await expect(
      repository.listThreads(actor(fixture.ownerUserId), {
        scope: "team",
        teamId: fixture.teamId,
        teamWorkspaceId: otherFixture.teamWorkspaceId,
        kinds: ["workspace_channel"]
      })
    ).resolves.toBeNull();

    const dmInputs = [fixture.ownerUserId, fixture.memberUserId];
    const dm = await repository.createThread(actor(fixture.ownerUserId), {
      kind: "dm",
      idempotencyKey: `dm:${randomUUID()}`,
      teamId: fixture.teamId,
      participantUserIds: dmInputs
    });
    const sameDm = await repository.createThread(actor(fixture.memberUserId), {
      kind: "dm",
      idempotencyKey: `dm:${randomUUID()}`,
      teamId: fixture.teamId,
      participantUserIds: [...dmInputs].reverse()
    });
    expect(sameDm?.id).toBe(dm?.id);

    const group = await repository.createThread(actor(fixture.ownerUserId), {
      kind: "group_dm",
      idempotencyKey: `group:${randomUUID()}`,
      teamId: fixture.teamId,
      participantUserIds: [
        fixture.ownerUserId,
        fixture.memberUserId,
        fixture.secondMemberUserId
      ]
    });
    const sameGroup = await repository.createThread(
      actor(fixture.memberUserId),
      {
        kind: "group_dm",
        idempotencyKey: `group:${randomUUID()}`,
        teamId: fixture.teamId,
        participantUserIds: [
          fixture.secondMemberUserId,
          fixture.memberUserId,
          fixture.ownerUserId
        ]
      }
    );
    expect(sameGroup?.id).toBe(group?.id);

    const message = await repository.sendMessage(actor(fixture.memberUserId), {
      threadId: channel!.id,
      idempotencyKey: `team-message:${randomUUID()}`,
      bodyText: "Team encrypted message",
      provenance: { kind: "user", id: randomUUID() }
    });
    expect(message?.threadSequence).toBe(1);
    expect(
      await repository.listMessages(actor(fixture.outsiderUserId), {
        threadId: channel!.id
      })
    ).toBeNull();
    await pool.query(
      `update team_workspace_access_grants
          set disabled_at=now(),access='disabled'
        where team_workspace_id=$1 and user_id=$2`,
      [fixture.teamWorkspaceId, fixture.memberUserId]
    );
    expect(
      await repository.listMessages(actor(fixture.memberUserId), {
        threadId: channel!.id
      })
    ).toBeNull();
    expect(
      await repository.listMessages(actor(fixture.ownerUserId), {
        threadId: channel!.id
      })
    ).toMatchObject({
      messages: [expect.objectContaining({ id: message!.id })]
    });
  });

  it("replays Team lifecycle invalidations after Workspace access is removed", async () => {
    const fixture = await createTeamFixture();
    const channel = await repository.createThread(actor(fixture.ownerUserId), {
      kind: "workspace_channel",
      idempotencyKey: `revocation-channel:${randomUUID()}`,
      teamId: fixture.teamId,
      teamWorkspaceId: fixture.teamWorkspaceId,
      name: "Revocation boundary"
    });
    const highWater = await pool.query<{ cursor: string }>(
      `select coalesce(max(cursor), 0)::text as cursor from collaboration_outbox`
    );
    const mutationId = randomUUID();
    const inserted = await pool.query<{ id: string; cursor: string }>(
      `insert into collaboration_outbox (
         protocol_version,
         family,
         scope,
         team_id,
         team_workspace_id,
         resource_type,
         resource_id,
         actor_principal_id,
         mutation_id,
         replay_until
       ) values (
         1,
         'workspace_lifecycle_access',
         'team',
         $1,
         $2,
         'team_workspace_access',
         $2,
         $3,
         $4,
         now() + interval '30 days'
       ) returning id,cursor::text`,
      [fixture.teamId, fixture.teamWorkspaceId, fixture.ownerUserId, mutationId]
    );
    await pool.query(
      `update team_workspace_access_grants
          set disabled_at=now(),access='disabled'
        where team_workspace_id=$1 and user_id=$2`,
      [fixture.teamWorkspaceId, fixture.memberUserId]
    );
    const protectedMessage = await repository.sendMessage(
      actor(fixture.ownerUserId),
      {
        threadId: channel!.id,
        idempotencyKey: `revoked-workspace-message:${randomUUID()}`,
        bodyText: "Must not enter the removed Workspace reader's replay"
      }
    );

    const replay = await repository.replayEvents(actor(fixture.memberUserId), {
      scope: "team",
      teamId: fixture.teamId,
      afterCursor: Number(highWater.rows[0]!.cursor),
      limit: 100
    });
    expect(replay?.events).toEqual([
      expect.objectContaining({
        id: inserted.rows[0]!.id,
        cursor: Number(inserted.rows[0]!.cursor),
        family: "workspace_lifecycle_access",
        teamWorkspaceId: fixture.teamWorkspaceId
      })
    ]);
    expect(
      replay?.events.some(
        (candidate) => candidate.messageId === protectedMessage!.id
      )
    ).toBe(false);
    await expect(
      repository.getAuthorizedSnapshot(actor(fixture.memberUserId), {
        scope: "team",
        teamId: fixture.teamId
      })
    ).resolves.toMatchObject({ threads: [] });
    await expect(
      repository.getThread(actor(fixture.memberUserId), {
        threadId: channel!.id
      })
    ).resolves.toBeNull();
    await expect(
      repository.replayEvents(actor(fixture.outsiderUserId), {
        scope: "team",
        teamId: fixture.teamId,
        afterCursor: Number(highWater.rows[0]!.cursor),
        limit: 100
      })
    ).resolves.toBeNull();
  });

  it("rewraps Team chat payload DEKs without plaintext fallback", async () => {
    const fixture = await createTeamFixture();
    const keyV1 = randomBytes(32);
    const keyV2 = randomBytes(32);
    const originalProvider = createManagedKmsEnvelopeEncryptionProvider(
      managedKeyring(1, { 1: keyV1, 2: keyV2 })
    );
    const rotatedProvider = createManagedKmsEnvelopeEncryptionProvider(
      managedKeyring(2, { 1: keyV1, 2: keyV2 })
    );
    const unavailableOldKeyProvider =
      createManagedKmsEnvelopeEncryptionProvider(
        managedKeyring(2, { 2: keyV2 })
      );
    const originalRepository = createCollaborationRepository(pool, {
      envelopeEncryptionProvider: originalProvider
    });
    const channel = await originalRepository.createThread(
      actor(fixture.ownerUserId),
      {
        kind: "workspace_channel",
        idempotencyKey: `rewrap-channel:${randomUUID()}`,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        name: "Encrypted rotation channel",
        topic: "Managed KMS rotation topic"
      }
    );
    const message = await originalRepository.sendMessage(
      actor(fixture.ownerUserId),
      {
        threadId: channel!.id,
        idempotencyKey: `rewrap-message:${randomUUID()}`,
        bodyText: "Managed KMS rotation message",
        metadata: { classification: "team" },
        provenance: { kind: "user", id: randomUUID() }
      }
    );
    expect(message).not.toBeNull();

    const before = await pool.query<{
      key_version: number;
      ciphertext: string;
      source_table: string;
    }>(
      `select key_version,ciphertext,source_table
         from encrypted_field_payloads
        where owner_user_id=$1
          and source_table in ('collaboration_threads','collaboration_messages')
          and source_id in ($2,$3)
        order by source_table,source_column`,
      [fixture.ownerUserId, channel!.id, message!.id]
    );
    expect(before.rows.length).toBeGreaterThanOrEqual(5);
    expect(before.rows.every((row) => row.key_version === 1)).toBe(true);
    expect(JSON.stringify(before.rows)).not.toContain(
      "Managed KMS rotation message"
    );

    const unavailableRepository = createCollaborationRepository(pool, {
      envelopeEncryptionProvider: unavailableOldKeyProvider
    });
    await expect(
      unavailableRepository.listMessages(actor(fixture.ownerUserId), {
        threadId: channel!.id,
        limit: 10
      })
    ).rejects.toThrow("managed_kms failed to unwrap DEK");

    const rewrap = await createEncryptedPayloadRepository(
      pool
    ).rewrapEncryptedFieldBatch(rotatedProvider, {
      ownerUserId: fixture.ownerUserId,
      batchSize: 100,
      force: true
    });
    expect(rewrap).toMatchObject({
      failedRows: 0,
      done: true
    });
    expect(rewrap.rewrappedRows).toBeGreaterThanOrEqual(before.rows.length);

    const after = await pool.query<{ key_version: number }>(
      `select key_version
         from encrypted_field_payloads
        where owner_user_id=$1
          and source_table in ('collaboration_threads','collaboration_messages')
          and source_id in ($2,$3)`,
      [fixture.ownerUserId, channel!.id, message!.id]
    );
    expect(after.rows).toHaveLength(before.rows.length);
    expect(after.rows.every((row) => row.key_version === 2)).toBe(true);

    const rotatedRepository = createCollaborationRepository(pool, {
      envelopeEncryptionProvider: rotatedProvider
    });
    await expect(
      rotatedRepository.getThread(actor(fixture.outsiderUserId), {
        threadId: channel!.id
      })
    ).resolves.toBeNull();
    await expect(
      rotatedRepository.listMessages(actor(fixture.outsiderUserId), {
        threadId: channel!.id,
        limit: 10
      })
    ).resolves.toBeNull();
    await expect(
      rotatedRepository.getThread(actor(fixture.ownerUserId), {
        threadId: channel!.id
      })
    ).resolves.toMatchObject({
      name: "Encrypted rotation channel",
      topic: "Managed KMS rotation topic"
    });
    await expect(
      rotatedRepository.listMessages(actor(fixture.ownerUserId), {
        threadId: channel!.id,
        limit: 10
      })
    ).resolves.toMatchObject({
      messages: [
        expect.objectContaining({ bodyText: "Managed KMS rotation message" })
      ]
    });
  });

  it("keeps concurrent message identity, sequence, and outbox commits atomic", async () => {
    const userId = await createUser("Concurrent Owner");
    const channel = await repository.createThread(actor(userId), {
      kind: "personal_channel",
      idempotencyKey: `concurrent-channel:${randomUUID()}`,
      name: "Concurrent"
    });
    const idempotencyKey = `concurrent-message:${randomUUID()}`;
    const provenance = { kind: "user", id: randomUUID() };
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 === 0 ? repository : competingRepository).sendMessage(
          actor(userId),
          {
            threadId: channel!.id,
            idempotencyKey,
            bodyText: "One logical concurrent message",
            provenance
          }
        )
      )
    );
    expect(new Set(results.map((result) => result?.id)).size).toBe(1);
    const counts = await pool.query<{
      messages: string;
      outbox: string;
      latest_sequence: string;
    }>(
      `select
         (select count(*)::text from collaboration_messages where thread_id=$1) as messages,
         (select count(*)::text from collaboration_outbox where thread_id=$1 and family='message_created') as outbox,
         (select (next_sequence - 1)::text from collaboration_threads where id=$1) as latest_sequence`,
      [channel!.id]
    );
    expect(counts.rows[0]).toEqual({
      messages: "1",
      outbox: "1",
      latest_sequence: "1"
    });

    const failingProvider: EnvelopeEncryptionProvider = {
      ...provider,
      encrypt: vi.fn(async () => {
        throw new Error("injected encryption failure");
      })
    };
    const failingRepository = createCollaborationRepository(pool, {
      envelopeEncryptionProvider: failingProvider
    });
    await expect(
      failingRepository.sendMessage(actor(userId), {
        threadId: channel!.id,
        idempotencyKey: `failed-message:${randomUUID()}`,
        bodyText: "Must not commit",
        provenance: { kind: "user", id: randomUUID() }
      })
    ).rejects.toThrow("injected encryption failure");
    const afterFailure = await pool.query<{
      messages: string;
      outbox: string;
      latest_sequence: string;
    }>(
      `select
         (select count(*)::text from collaboration_messages where thread_id=$1) as messages,
         (select count(*)::text from collaboration_outbox where thread_id=$1 and family='message_created') as outbox,
         (select (next_sequence - 1)::text from collaboration_threads where id=$1) as latest_sequence`,
      [channel!.id]
    );
    expect(afterFailure.rows[0]).toEqual(counts.rows[0]);
  });

  it("keeps a two-client read-state race monotonic with one durable state row", async () => {
    const userId = await createUser("Read Race Owner");
    const channel = await repository.createThread(actor(userId), {
      kind: "personal_channel",
      idempotencyKey: `read-race-channel:${randomUUID()}`,
      name: "Read race"
    });
    const messages = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        repository.sendMessage(actor(userId), {
          threadId: channel!.id,
          idempotencyKey: `read-race-message:${index}:${randomUUID()}`,
          bodyText: `Read race message ${index}`
        })
      )
    );
    const low = messages.find((message) => message?.threadSequence === 1)!;
    const high = messages.find((message) => message?.threadSequence === 3)!;

    await Promise.all([
      repository.advanceReadState(actor(userId), {
        threadId: channel!.id,
        messageId: low!.id
      }),
      competingRepository.advanceReadState(actor(userId), {
        threadId: channel!.id,
        messageId: high!.id
      })
    ]);

    const durable = await pool.query<{
      state_rows: string;
      last_read_message_id: string;
      last_read_sequence: string;
      event_count: string;
      unique_mutation_families: string;
    }>(
      `select
         (select count(*)::text
            from collaboration_receipt_states
           where thread_id=$1 and user_id=$2) as state_rows,
         (select last_read_message_id::text
            from collaboration_receipt_states
           where thread_id=$1 and user_id=$2) as last_read_message_id,
         (select last_read_sequence::text
            from collaboration_receipt_states
           where thread_id=$1 and user_id=$2) as last_read_sequence,
         (select count(*)::text
            from collaboration_outbox
           where thread_id=$1 and family='receipt_state_updated') as event_count,
         (select count(distinct (mutation_id,family))::text
            from collaboration_outbox
           where thread_id=$1 and family='receipt_state_updated') as unique_mutation_families`,
      [channel!.id, userId]
    );
    expect(durable.rows[0]).toMatchObject({
      state_rows: "1",
      last_read_message_id: high!.id,
      last_read_sequence: "3"
    });
    expect(Number(durable.rows[0]!.event_count)).toBeGreaterThanOrEqual(1);
    expect(durable.rows[0]!.unique_mutation_families).toBe(
      durable.rows[0]!.event_count
    );
  });

  it("tracks least-complete recipient receipts against immutable message audiences", async () => {
    const fixture = await createTeamFixture();
    const channel = await repository.createThread(actor(fixture.ownerUserId), {
      kind: "workspace_channel",
      idempotencyKey: `receipt-channel:${randomUUID()}`,
      teamId: fixture.teamId,
      teamWorkspaceId: fixture.teamWorkspaceId,
      name: `Receipt channel ${randomUUID()}`
    });
    if (!channel) throw new Error("Expected an authorized Workspace channel");

    const first = await repository.sendMessage(actor(fixture.ownerUserId), {
      threadId: channel.id,
      idempotencyKey: `receipt-first:${randomUUID()}`,
      bodyText: "Receipt state must reflect every original recipient."
    });
    if (!first) throw new Error("Expected the first message");
    expect(first.recipientStatus).toBe("sent");

    await repository.advanceDeliveryState(actor(fixture.memberUserId), {
      threadId: channel.id,
      messageId: first.id
    });
    expect(
      (
        await repository.listMessages(actor(fixture.ownerUserId), {
          threadId: channel.id
        })
      )?.messages[0]?.recipientStatus
    ).toBe("sent");

    await repository.advanceDeliveryState(actor(fixture.secondMemberUserId), {
      threadId: channel.id,
      messageId: first.id
    });
    expect(
      (
        await repository.listMessages(actor(fixture.ownerUserId), {
          threadId: channel.id
        })
      )?.messages[0]?.recipientStatus
    ).toBe("delivered");

    await repository.advanceReadState(actor(fixture.memberUserId), {
      threadId: channel.id,
      messageId: first.id
    });
    expect(
      (
        await repository.listMessages(actor(fixture.ownerUserId), {
          threadId: channel.id
        })
      )?.messages[0]?.recipientStatus
    ).toBe("delivered");

    await pool.query(
      `update team_workspace_access_grants
          set access='disabled', disabled_at=now(), updated_at=now()
        where team_workspace_id=$1 and user_id=$2`,
      [fixture.teamWorkspaceId, fixture.secondMemberUserId]
    );
    const second = await repository.sendMessage(actor(fixture.ownerUserId), {
      threadId: channel.id,
      idempotencyKey: `receipt-second:${randomUUID()}`,
      bodyText: "This audience no longer includes the removed member."
    });
    if (!second) throw new Error("Expected the second message");
    expect(second.recipientStatus).toBe("sent");

    await repository.advanceReadState(actor(fixture.memberUserId), {
      threadId: channel.id,
      messageId: second.id
    });
    const afterMembershipChange = await repository.listMessages(
      actor(fixture.ownerUserId),
      { threadId: channel.id }
    );
    expect(
      afterMembershipChange?.messages.find(
        (message) => message.id === second.id
      )?.recipientStatus
    ).toBe("read");
    expect(
      afterMembershipChange?.messages.find((message) => message.id === first.id)
        ?.recipientStatus
    ).toBe("delivered");

    const audiences = await pool.query<{
      audience_version: number;
      recipient_count: string;
    }>(
      `select message.audience_version,
              count(member.user_id)::text as recipient_count
         from collaboration_messages message
         join collaboration_thread_audience_members member
           on member.thread_id=message.thread_id
          and member.audience_version=message.audience_version
          and member.user_id<>message.sender_principal_id
        where message.id=any($1::uuid[])
        group by message.id,message.audience_version,message.thread_sequence
        order by message.thread_sequence`,
      [[first.id, second.id]]
    );
    expect(audiences.rows).toEqual([
      { audience_version: 1, recipient_count: "2" },
      { audience_version: 2, recipient_count: "1" }
    ]);
  });

  it("computes unread counts from other senders after the acknowledged cursor", async () => {
    const fixture = await createTeamFixture();
    const channel = await repository.createThread(actor(fixture.ownerUserId), {
      kind: "workspace_channel",
      idempotencyKey: `unread-channel:${randomUUID()}`,
      teamId: fixture.teamId,
      teamWorkspaceId: fixture.teamWorkspaceId,
      name: `Unread channel ${randomUUID()}`
    });
    if (!channel) throw new Error("Expected an authorized Workspace channel");

    await repository.sendMessage(actor(fixture.ownerUserId), {
      threadId: channel.id,
      idempotencyKey: `unread-own:${randomUUID()}`,
      bodyText: "My own message is not unread."
    });
    const beforeExternal = await repository.getAuthorizedSnapshot(
      actor(fixture.ownerUserId),
      { scope: "team", teamId: fixture.teamId }
    );
    expect(
      beforeExternal?.threads.find((thread) => thread.id === channel.id)
        ?.unreadCount
    ).toBe(0);

    const firstExternal = await repository.sendMessage(
      actor(fixture.memberUserId),
      {
        threadId: channel.id,
        idempotencyKey: `unread-external-first:${randomUUID()}`,
        bodyText: "This message is unread."
      }
    );
    if (!firstExternal) throw new Error("Expected an external message");
    const read = await repository.advanceReadState(actor(fixture.ownerUserId), {
      threadId: channel.id,
      messageId: firstExternal.id
    });
    if (!read) throw new Error("Expected read state");
    expect(read.unreadCount).toBe(0);

    await repository.sendMessage(actor(fixture.memberUserId), {
      threadId: channel.id,
      idempotencyKey: `unread-external-second:${randomUUID()}`,
      bodyText: "This newer message remains unread."
    });
    const afterExternal = await repository.getAuthorizedSnapshot(
      actor(fixture.ownerUserId),
      { scope: "team", teamId: fixture.teamId }
    );
    expect(
      afterExternal?.threads.find((thread) => thread.id === channel.id)
        ?.unreadCount
    ).toBe(1);
  });

  it("rolls back message, encrypted companions, sequence, and outbox after an outbox failpoint", async () => {
    const userId = await createUser("Outbox Failpoint Owner");
    const channel = await repository.createThread(actor(userId), {
      kind: "personal_channel",
      idempotencyKey: `outbox-failpoint-channel:${randomUUID()}`,
      name: "Outbox failpoint"
    });
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `collaboration_test_fail_outbox_${suffix}`;
    const triggerName = `collaboration_test_fail_outbox_${suffix}`;
    await pool.query(
      `create function ${functionName}() returns trigger
       language plpgsql
       as $trigger$
       begin
         if new.family = 'message_created'
            and new.actor_principal_id = tg_argv[0]::uuid then
           raise exception 'injected failure after outbox insert'
             using errcode = '40001';
         end if;
         return new;
       end
       $trigger$`
    );
    await pool.query(
      `create trigger ${triggerName}
       after insert on collaboration_outbox
       for each row execute function ${functionName}('${userId}')`
    );

    try {
      await expect(
        repository.sendMessage(actor(userId), {
          threadId: channel!.id,
          idempotencyKey: `outbox-failpoint-message:${randomUUID()}`,
          bodyText: "Every durable companion must roll back",
          metadata: { failpoint: "after_outbox_insert" },
          provenance: { kind: "test_failpoint", id: randomUUID() }
        })
      ).rejects.toThrow("injected failure after outbox insert");
    } finally {
      await pool.query(
        `drop trigger if exists ${triggerName} on collaboration_outbox`
      );
      await pool.query(`drop function if exists ${functionName}()`);
    }

    const durable = await pool.query<{
      messages: string;
      encrypted_companions: string;
      message_events: string;
      latest_sequence: string;
    }>(
      `select
         (select count(*)::text
            from collaboration_messages
           where thread_id=$1) as messages,
         (select count(*)::text
            from encrypted_field_payloads p
            join collaboration_messages m on m.id=p.source_id
           where m.thread_id=$1
             and p.source_table='collaboration_messages'
             and p.invalidated_at is null) as encrypted_companions,
         (select count(*)::text
            from collaboration_outbox
           where thread_id=$1 and family='message_created') as message_events,
         (select (next_sequence - 1)::text
            from collaboration_threads
           where id=$1) as latest_sequence`,
      [channel!.id]
    );
    expect(durable.rows[0]).toEqual({
      messages: "0",
      encrypted_companions: "0",
      message_events: "0",
      latest_sequence: "0"
    });
  });

  it("recovers idempotently when commit succeeds but its acknowledgement is lost", async () => {
    const userId = await createUser("Ambiguous Commit Owner");
    const channel = await repository.createThread(actor(userId), {
      kind: "personal_channel",
      idempotencyKey: `ambiguous-channel:${randomUUID()}`,
      name: "Ambiguous commit"
    });
    const ambiguousPool = createDbPool({ connectionString: databaseUrl });
    const originalConnect = ambiguousPool.connect.bind(ambiguousPool);
    let loseNextCommitAcknowledgement = true;
    ambiguousPool.connect = (async () => {
      const client = await originalConnect();
      const originalQuery = client.query.bind(client) as (
        queryText: string,
        values?: unknown[]
      ) => Promise<pg.QueryResult>;
      client.query = (async (queryText: string, values?: unknown[]) => {
        const result = await originalQuery(queryText, values);
        if (
          loseNextCommitAcknowledgement &&
          queryText.trim().toLowerCase() === "commit"
        ) {
          loseNextCommitAcknowledgement = false;
          throw new Error("simulated lost commit acknowledgement");
        }
        return result;
      }) as typeof client.query;
      return client;
    }) as typeof ambiguousPool.connect;
    const ambiguousRepository = createCollaborationRepository(ambiguousPool, {
      envelopeEncryptionProvider: provider
    });
    const idempotencyKey = `ambiguous-message:${randomUUID()}`;
    const provenance = { kind: "ambiguous_commit_test", id: randomUUID() };
    const input = {
      threadId: channel!.id,
      idempotencyKey,
      bodyText: "The committed message must be recovered by retry",
      metadata: { recovery: "idempotent" },
      provenance
    };

    try {
      await expect(
        ambiguousRepository.sendMessage(actor(userId), input)
      ).rejects.toThrow("simulated lost commit acknowledgement");
    } finally {
      await ambiguousPool.end();
    }

    const recovered = await competingRepository.sendMessage(
      actor(userId),
      input
    );
    expect(recovered).toMatchObject({
      threadId: channel!.id,
      threadSequence: 1,
      bodyText: input.bodyText,
      metadata: input.metadata,
      provenance
    });
    const durable = await pool.query<{
      messages: string;
      encrypted_companions: string;
      message_events: string;
      mutation_families: string;
      latest_sequence: string;
    }>(
      `select
         (select count(*)::text
            from collaboration_messages
           where thread_id=$1) as messages,
         (select count(*)::text
            from encrypted_field_payloads
           where source_table='collaboration_messages'
             and source_id=$2
             and invalidated_at is null) as encrypted_companions,
         (select count(*)::text
            from collaboration_outbox
           where thread_id=$1 and family='message_created') as message_events,
         (select count(distinct (mutation_id,family))::text
            from collaboration_outbox
           where thread_id=$1 and family='message_created') as mutation_families,
         (select (next_sequence - 1)::text
            from collaboration_threads
           where id=$1) as latest_sequence`,
      [channel!.id, recovered!.id]
    );
    expect(durable.rows[0]).toEqual({
      messages: "1",
      encrypted_companions: "3",
      message_events: "1",
      mutation_families: "1",
      latest_sequence: "1"
    });
  });

  it("binds subscriptions to principals and advances acknowledgements monotonically", async () => {
    const userId = await createUser("Subscription Owner");
    const channel = await repository.createThread(actor(userId), {
      kind: "personal_channel",
      idempotencyKey: `subscription-channel:${randomUUID()}`,
      name: "Subscription"
    });
    const message = await repository.sendMessage(actor(userId), {
      threadId: channel!.id,
      idempotencyKey: `subscription-message:${randomUUID()}`,
      bodyText: "Subscription event",
      provenance: { kind: "user", id: randomUUID() }
    });
    const replay = await repository.replayEvents(actor(userId), {
      scope: "personal",
      afterCursor: 0,
      limit: 100
    });
    const event = replay!.events.find(
      (candidate) => candidate.messageId === message!.id
    )!;
    const binding = {
      backendIdentityHash: hash(`backend:${randomUUID()}`),
      principalIdHash: collaborationSubscriptionPrincipalHash(userId),
      deviceCredentialId: null,
      clientInstanceHash: hash(`client:${randomUUID()}`),
      subscriptionKeyHash: hash(`subscription:${randomUUID()}`),
      protocolVersion: COLLABORATION_CONTRACT_VERSION
    };
    const subscription = await repository.createSubscription(actor(userId), {
      ...binding,
      scope: "personal",
      snapshotHighWaterCursor: 0,
      expiresAt: new Date(Date.now() + 60_000)
    });
    expect(subscription).not.toBeNull();
    const acknowledged = await repository.acknowledgeSubscription(
      actor(userId),
      {
        ...binding,
        subscriptionId: subscription!.id,
        eventId: event.id,
        cursor: event.cursor
      }
    );
    expect(acknowledged).toMatchObject({
      acknowledgedEventId: event.id,
      acknowledgedCursor: event.cursor
    });
    const lowerAcknowledgement = await repository.acknowledgeSubscription(
      actor(userId),
      {
        ...binding,
        subscriptionId: subscription!.id,
        eventId: event.id,
        cursor: Math.max(0, event.cursor - 1)
      }
    );
    expect(lowerAcknowledgement).toMatchObject({
      acknowledgedEventId: event.id,
      acknowledgedCursor: event.cursor
    });
    await expect(
      repository.acknowledgeSubscription(actor(userId), {
        ...binding,
        subscriptionId: subscription!.id,
        eventId: randomUUID(),
        cursor: event.cursor
      })
    ).rejects.toBeInstanceOf(CollaborationStateConflictError);
    const outsiderUserId = await createUser("Subscription Outsider");
    expect(
      await repository.recoverSubscription(actor(outsiderUserId), {
        ...binding,
        principalIdHash: collaborationSubscriptionPrincipalHash(outsiderUserId),
        scope: "personal",
        subscriptionId: subscription!.id,
        afterCursor: event.cursor,
        expiresAt: new Date(Date.now() + 60_000)
      })
    ).toBeNull();
  });

  it("recovers a Personal scope from a retained replay gap without duplicating logical events", async () => {
    const userId = await createUser("Replay Watermark Owner");
    const channel = await repository.createThread(actor(userId), {
      kind: "personal_channel",
      idempotencyKey: `watermark-channel:${randomUUID()}`,
      name: "Replay watermark"
    });
    const idempotencyKey = `watermark-message:${randomUUID()}`;
    const provenance = { kind: "user", id: randomUUID() };
    const messageInput = {
      threadId: channel!.id,
      idempotencyKey,
      bodyText: "This event will leave a durable replay watermark.",
      provenance
    };
    const message = await repository.sendMessage(actor(userId), messageInput);
    await repository.sendMessage(actor(userId), {
      threadId: channel!.id,
      idempotencyKey: `retained-watermark-message:${randomUUID()}`,
      bodyText: "This newer state remains in the replay window.",
      provenance: { kind: "user", id: randomUUID() }
    });
    const replay = await repository.replayEvents(actor(userId), {
      scope: "personal",
      afterCursor: 0,
      limit: 500
    });
    const expiredEvent = replay!.events.find(
      (event) => event.messageId === message!.id
    )!;
    const scopedHighWater = Math.max(
      ...replay!.events.map((event) => event.cursor)
    );
    const binding = {
      backendIdentityHash: hash(`watermark-backend:${randomUUID()}`),
      principalIdHash: collaborationSubscriptionPrincipalHash(userId),
      deviceCredentialId: null,
      clientInstanceHash: hash(`watermark-client:${randomUUID()}`),
      subscriptionKeyHash: hash(`watermark-subscription:${randomUUID()}`),
      protocolVersion: COLLABORATION_CONTRACT_VERSION
    };
    const subscription = await repository.createSubscription(actor(userId), {
      ...binding,
      scope: "personal",
      snapshotHighWaterCursor: 0,
      expiresAt: new Date(Date.now() + 60_000)
    });

    const otherUserId = await createUser("Unrelated Replay Owner");
    const otherChannel = await repository.createThread(actor(otherUserId), {
      kind: "personal_channel",
      idempotencyKey: `other-watermark-channel:${randomUUID()}`,
      name: "Unrelated replay watermark"
    });
    await repository.sendMessage(actor(otherUserId), {
      threadId: otherChannel!.id,
      idempotencyKey: `other-watermark-message:${randomUUID()}`,
      bodyText: "This scope must not affect the owner's watermarks.",
      provenance: { kind: "user", id: randomUUID() }
    });
    const otherReplay = await repository.replayEvents(actor(otherUserId), {
      scope: "personal",
      afterCursor: 0,
      limit: 500
    });
    const otherHighWater = Math.max(
      ...otherReplay!.events.map((event) => event.cursor)
    );
    expect(otherHighWater).toBeGreaterThan(scopedHighWater);

    await pool.query(
      `update collaboration_outbox
          set occurred_at=now() - interval '2 seconds',
              replay_until=now() - interval '1 second'
        where id=$1`,
      [expiredEvent.id]
    );

    const pruned = await repository.pruneExpiredReplayHistory({
      limit: 10_000
    });
    expect(pruned.deletedEventCount).toBeGreaterThanOrEqual(1);
    const persisted = await pool.query<{
      event_count: string;
      replay_low_water_cursor: string;
      high_water_cursor: string;
    }>(
      `select
         (select count(*)::text
            from collaboration_outbox
           where id=any($1::uuid[])) as event_count,
         replay_low_water_cursor::text,
         high_water_cursor::text
       from collaboration_replay_watermarks
       where scope='personal' and personal_owner_user_id=$2`,
      [[expiredEvent.id], userId]
    );
    expect(persisted.rows[0]).toEqual({
      event_count: "0",
      replay_low_water_cursor: String(expiredEvent.cursor),
      high_water_cursor: String(scopedHighWater)
    });

    const otherBinding = {
      backendIdentityHash: hash(`other-watermark-backend:${randomUUID()}`),
      principalIdHash: collaborationSubscriptionPrincipalHash(otherUserId),
      deviceCredentialId: null,
      clientInstanceHash: hash(`other-watermark-client:${randomUUID()}`),
      subscriptionKeyHash: hash(`other-watermark-subscription:${randomUUID()}`),
      protocolVersion: COLLABORATION_CONTRACT_VERSION
    };
    const otherSubscription = await repository.createSubscription(
      actor(otherUserId),
      {
        ...otherBinding,
        scope: "personal",
        snapshotHighWaterCursor: 0,
        expiresAt: new Date(Date.now() + 60_000)
      }
    );
    await expect(
      repository.recoverSubscription(actor(otherUserId), {
        ...otherBinding,
        scope: "personal",
        subscriptionId: otherSubscription!.id,
        afterCursor: 0,
        expiresAt: new Date(Date.now() + 60_000)
      })
    ).resolves.toMatchObject({
      requiresSnapshot: false,
      subscription: { state: "active" }
    });

    const recovered = await repository.recoverSubscription(actor(userId), {
      ...binding,
      scope: "personal",
      subscriptionId: subscription!.id,
      afterCursor: 0,
      expiresAt: new Date(Date.now() + 60_000)
    });
    expect(recovered).toMatchObject({
      requiresSnapshot: true,
      subscription: { state: "requires_snapshot" }
    });

    const snapshot = await repository.getAuthorizedSnapshot(actor(userId), {
      scope: "personal"
    });
    expect(snapshot).toMatchObject({
      highWaterCursor: scopedHighWater,
      threads: [expect.objectContaining({ id: channel!.id })]
    });
    expect(snapshot!.highWaterCursor).toBeLessThan(otherHighWater);

    const reset = await repository.createSubscription(actor(userId), {
      ...binding,
      scope: "personal",
      snapshotHighWaterCursor: snapshot!.highWaterCursor,
      expiresAt: new Date(Date.now() + 60_000)
    });
    expect(reset).toMatchObject({
      id: subscription!.id,
      state: "active",
      snapshotHighWaterCursor: scopedHighWater
    });
    await expect(
      repository.sendMessage(actor(userId), messageInput)
    ).resolves.toEqual(message);
    const nextMessage = await repository.sendMessage(actor(userId), {
      threadId: channel!.id,
      idempotencyKey: `post-snapshot-message:${randomUUID()}`,
      bodyText: "Only this new logical event should replay.",
      provenance: { kind: "user", id: randomUUID() }
    });
    const afterSnapshot = await repository.replayEvents(actor(userId), {
      scope: "personal",
      afterCursor: snapshot!.highWaterCursor,
      limit: 500
    });
    expect(
      afterSnapshot!.events.filter((event) => event.threadId === channel!.id)
    ).toEqual([
      expect.objectContaining({
        family: "message_created",
        messageId: nextMessage!.id
      })
    ]);
    await expect(
      repository.recoverSubscription(actor(userId), {
        ...binding,
        scope: "personal",
        subscriptionId: subscription!.id,
        afterCursor: snapshot!.highWaterCursor,
        expiresAt: new Date(Date.now() + 60_000)
      })
    ).resolves.toMatchObject({
      requiresSnapshot: false,
      subscription: { state: "active" }
    });
  });

  it("isolates retained replay watermarks by Team and authorization", async () => {
    const fixture = await createTeamFixture();
    const channel = await repository.createThread(actor(fixture.ownerUserId), {
      kind: "workspace_channel",
      idempotencyKey: `team-watermark-channel:${randomUUID()}`,
      teamId: fixture.teamId,
      teamWorkspaceId: fixture.teamWorkspaceId,
      name: "Team replay watermark"
    });
    await repository.sendMessage(actor(fixture.ownerUserId), {
      threadId: channel!.id,
      idempotencyKey: `team-watermark-message:${randomUUID()}`,
      bodyText: "This Team history will be physically pruned.",
      provenance: { kind: "user", id: randomUUID() }
    });
    const teamReplay = await repository.replayEvents(
      actor(fixture.ownerUserId),
      { scope: "team", teamId: fixture.teamId, afterCursor: 0, limit: 500 }
    );
    const expiredTeamEvent = teamReplay!.events.find(
      (event) =>
        event.family === "thread_lifecycle" && event.threadId === channel!.id
    )!;
    const teamHighWater = Math.max(
      ...teamReplay!.events.map((event) => event.cursor)
    );
    const binding = {
      backendIdentityHash: hash(`team-watermark-backend:${randomUUID()}`),
      principalIdHash: collaborationSubscriptionPrincipalHash(
        fixture.ownerUserId
      ),
      deviceCredentialId: null,
      clientInstanceHash: hash(`team-watermark-client:${randomUUID()}`),
      subscriptionKeyHash: hash(`team-watermark-subscription:${randomUUID()}`),
      protocolVersion: COLLABORATION_CONTRACT_VERSION
    };
    const subscription = await repository.createSubscription(
      actor(fixture.ownerUserId),
      {
        ...binding,
        scope: "team",
        teamId: fixture.teamId,
        snapshotHighWaterCursor: 0,
        expiresAt: new Date(Date.now() + 60_000)
      }
    );

    const unrelated = await createTeamFixture();
    const unrelatedChannel = await repository.createThread(
      actor(unrelated.ownerUserId),
      {
        kind: "workspace_channel",
        idempotencyKey: `unrelated-team-channel:${randomUUID()}`,
        teamId: unrelated.teamId,
        teamWorkspaceId: unrelated.teamWorkspaceId,
        name: "Unrelated Team"
      }
    );
    await repository.sendMessage(actor(unrelated.ownerUserId), {
      threadId: unrelatedChannel!.id,
      idempotencyKey: `unrelated-team-message:${randomUUID()}`,
      bodyText: "This Team remains replayable.",
      provenance: { kind: "user", id: randomUUID() }
    });
    const unrelatedBinding = {
      backendIdentityHash: hash(`unrelated-team-backend:${randomUUID()}`),
      principalIdHash: collaborationSubscriptionPrincipalHash(
        unrelated.ownerUserId
      ),
      deviceCredentialId: null,
      clientInstanceHash: hash(`unrelated-team-client:${randomUUID()}`),
      subscriptionKeyHash: hash(`unrelated-team-subscription:${randomUUID()}`),
      protocolVersion: COLLABORATION_CONTRACT_VERSION
    };
    const unrelatedSubscription = await repository.createSubscription(
      actor(unrelated.ownerUserId),
      {
        ...unrelatedBinding,
        scope: "team",
        teamId: unrelated.teamId,
        snapshotHighWaterCursor: 0,
        expiresAt: new Date(Date.now() + 60_000)
      }
    );

    await pool.query(
      `update collaboration_outbox
          set occurred_at=now() - interval '2 seconds',
              replay_until=now() - interval '1 second'
        where id=$1`,
      [expiredTeamEvent.id]
    );
    await repository.pruneExpiredReplayHistory({ limit: 10_000 });
    const persisted = await pool.query<{
      event_count: string;
      replay_low_water_cursor: string;
      high_water_cursor: string;
    }>(
      `select
         (select count(*)::text
            from collaboration_outbox
           where id=any($1::uuid[])) as event_count,
         replay_low_water_cursor::text,
         high_water_cursor::text
       from collaboration_replay_watermarks
       where scope='team' and team_id=$2`,
      [[expiredTeamEvent.id], fixture.teamId]
    );
    expect(persisted.rows[0]).toEqual({
      event_count: "0",
      replay_low_water_cursor: String(expiredTeamEvent.cursor),
      high_water_cursor: String(teamHighWater)
    });
    await expect(
      repository.recoverSubscription(actor(fixture.ownerUserId), {
        ...binding,
        scope: "team",
        teamId: fixture.teamId,
        subscriptionId: subscription!.id,
        afterCursor: 0,
        expiresAt: new Date(Date.now() + 60_000)
      })
    ).resolves.toMatchObject({
      requiresSnapshot: true,
      subscription: { state: "requires_snapshot" }
    });
    await expect(
      repository.recoverSubscription(actor(unrelated.ownerUserId), {
        ...unrelatedBinding,
        scope: "team",
        teamId: unrelated.teamId,
        subscriptionId: unrelatedSubscription!.id,
        afterCursor: 0,
        expiresAt: new Date(Date.now() + 60_000)
      })
    ).resolves.toMatchObject({
      requiresSnapshot: false,
      subscription: { state: "active" }
    });
    await expect(
      repository.recoverSubscription(actor(fixture.outsiderUserId), {
        ...binding,
        principalIdHash: collaborationSubscriptionPrincipalHash(
          fixture.outsiderUserId
        ),
        scope: "team",
        teamId: fixture.teamId,
        subscriptionId: subscription!.id,
        afterCursor: 0,
        expiresAt: new Date(Date.now() + 60_000)
      })
    ).resolves.toBeNull();
    await expect(
      repository.getAuthorizedSnapshot(actor(fixture.ownerUserId), {
        scope: "team",
        teamId: fixture.teamId
      })
    ).resolves.toMatchObject({ highWaterCursor: teamHighWater });
  });
});
