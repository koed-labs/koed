import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { afterAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import {
  createCollaborationRepository,
  CollaborationStateConflictError
} from "./collaboration-repository.js";

const baseUrl = process.env.HOME_AUTHORITY_TEST_DATABASE_URL;
const databaseName = `koed_collaboration_mentions_${randomUUID().replaceAll("-", "")}`;

describe.skipIf(!baseUrl)("Team message mentions (PostgreSQL)", () => {
  const configured = baseUrl ? new URL(baseUrl) : null;
  const adminUrl = configured ? new URL(configured) : null;
  if (adminUrl) adminUrl.pathname = "/postgres";
  const testUrl = configured ? new URL(configured) : null;
  if (testUrl) testUrl.pathname = `/${databaseName}`;
  const admin = adminUrl
    ? new pg.Client({ connectionString: adminUrl.toString() })
    : null;
  const pool = testUrl
    ? new pg.Pool({ connectionString: testUrl.toString() })
    : null;
  let connected = false;

  afterAll(async () => {
    await pool?.end();
    if (!admin || !connected) return;
    try {
      await admin.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname=$1",
        [databaseName]
      );
      await admin.query(`drop database if exists "${databaseName}"`);
    } finally {
      await admin.end();
    }
  });

  it("persists explicit mentions in encrypted metadata for an unvisited channel member", async () => {
    if (!admin || !pool) throw new Error("Test database URL unavailable");
    await admin.connect();
    connected = true;
    await admin.query(`create database "${databaseName}"`);
    await runDbMigrations(pool);
    const ownerId = randomUUID();
    const senderId = randomUUID();
    const outsiderId = randomUUID();
    const teamId = randomUUID();
    await pool.query(
      "insert into users(id,email,display_name) values($1,$2,'Owner'),($3,$4,'Sender'),($5,$6,'Outsider')",
      [
        ownerId,
        `${ownerId}@mentions.invalid`,
        senderId,
        `${senderId}@mentions.invalid`,
        outsiderId,
        `${outsiderId}@mentions.invalid`
      ]
    );
    await pool.query("insert into teams(id,name) values($1,'Mentions test')", [
      teamId
    ]);
    await pool.query(
      "insert into team_memberships(team_id,user_id,role,status,accepted_at) values($1,$2,'owner','enabled',now()),($1,$3,'member','enabled',now())",
      [teamId, ownerId, senderId]
    );
    const envelopeEncryptionProvider =
      createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64url")
      );
    const teamEnvelopeEncryptionProvider =
      createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64url")
      );
    const repository = createCollaborationRepository(pool, {
      envelopeEncryptionProvider,
      teamEnvelopeEncryptionProvider
    });
    const thread = await repository.ensureTeamGeneralChannel(
      { userId: ownerId },
      teamId
    );
    if (!thread) throw new Error("Team general channel was not created");

    const messageIdempotencyKey = randomUUID();
    const posted = await repository.sendMessage(
      { userId: senderId },
      {
        threadId: thread.id,
        idempotencyKey: messageIdempotencyKey,
        bodyText: "Alice, can you take a look?",
        mentionUserIds: [ownerId]
      }
    );
    expect(posted?.mentionUserIds).toEqual([ownerId]);
    const ownerPage = await repository.listMessages(
      { userId: ownerId },
      { threadId: thread.id, afterSequence: 0, limit: 20 }
    );
    expect(
      ownerPage?.messages.find((message) => message.id === posted?.id)
        ?.mentionUserIds
    ).toEqual([ownerId]);

    await expect(
      repository.sendMessage(
        { userId: senderId },
        {
          threadId: thread.id,
          idempotencyKey: randomUUID(),
          bodyText: "Forged target",
          mentionUserIds: [outsiderId]
        }
      )
    ).rejects.toBeInstanceOf(CollaborationStateConflictError);

    const oldClientSend = {
      threadId: thread.id,
      idempotencyKey: randomUUID(),
      bodyText: "Legacy no-mention retry"
    };
    const accepted = await repository.sendMessage(
      { userId: senderId },
      oldClientSend
    );
    const retried = await repository.sendMessage(
      { userId: senderId },
      { ...oldClientSend, mentionUserIds: [] }
    );
    expect(retried?.id).toBe(accepted?.id);
    expect(retried?.mentionUserIds).toEqual([]);
  });
});
