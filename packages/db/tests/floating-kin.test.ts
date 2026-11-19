import { randomUUID } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed-labs/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";

import { upsertEncryptedFieldPayloadWithClient } from "../src/encrypted-payload-repository.js";

const databaseUrl = process.env.FLOATING_KIN_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("Floating Kin Personal activity", () => {
  const pool = databaseUrl
    ? createDbPool({ connectionString: databaseUrl })
    : undefined;
  beforeAll(async () => {
    await runDbMigrations(pool!);
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
  });

  it("ranks unsealed owner sessions by source time, excludes approval and historical items, and caps output", async () => {
    const repo = createMemorySourceRepository(pool!);
    const owner = await repo.createUser({
      email: `kin-${randomUUID()}@example.test`
    });
    const other = await repo.createUser({
      email: `kin-${randomUUID()}@example.test`
    });
    const actor = { userId: owner.id };
    const now = Date.now();
    const timestamp = (second: number) =>
      new Date(now - 100_000 + second * 1000).toISOString();
    const capture = async (
      userId: string,
      second: number,
      metadata = {},
      runtime: "codex-cli" | "claude-code" = "codex-cli"
    ) => {
      const claude = runtime === "claude-code";
      const externalSessionId = randomUUID();
      const session = await repo.createCapturedSession(
        { userId },
        {
          externalSessionId,
          sourceRuntime: runtime,
          captureMethod: "api"
        }
      );
      const [item] = await repo.createConversationItems(
        { userId },
        {
          items: [
            {
              sessionId: session.id,
              externalSessionId,
              externalTurnId: "current",
              sourceSequence: 1,
              sourceKind: claude ? "claude-code" : "codex",
              sourceAdapterVersion: claude
                ? "claude-code-transcript-v1"
                : "codex-transcript-v1",
              sourceTransport: "transcript",
              sourceRecordType: claude ? "session_message" : "event_msg",
              sourceEventType: "user_message",
              eventTime: timestamp(second),
              rawJson: claude
                ? {
                    type: "claude_session_message",
                    messageType: "user",
                    contentBlock: { type: "text", text: "secret" }
                  }
                : {
                    type: "event_msg",
                    payload: { type: "user_message", message: "secret" }
                  },
              rawText: "secret",
              sourceHash: randomUUID(),
              idempotencyKey: randomUUID(),
              metadata
            }
          ]
        }
      );
      return { session, item: item! };
    };
    const expected = [];
    for (const second of [6, 5, 4, 3, 2, 1])
      expected.push(
        await capture(
          owner.id,
          second,
          {},
          second === 6 ? "claude-code" : "codex-cli"
        )
      );
    await capture(other.id, 59);
    await capture(owner.id, -3600);
    await capture(owner.id, 58, { approvalReview: true });
    const historical = await capture(owner.id, 57);
    const deleted = await capture(owner.id, 56);
    await pool!.query(
      "update conversation_items set projection_work_class='historical_import_backfill' where id=$1",
      [historical.item.id]
    );
    await pool!.query(
      "update sessions set personal_deleted_at=now() where id=$1",
      [deleted.session.id]
    );
    expect(await repo.getFloatingKinActivity(actor)).toEqual({
      conversations: expected.slice(0, 5).map(({ session }, index) => ({
        sessionId: session.id,
        projectId: null,
        client: index === 0 ? "claude-code" : "codex",
        lastActivityAt: timestamp(6 - index)
      })),
      overflowCount: 1
    });
    const raw = await repo.getFloatingKinEvidence(actor, {
      action: "conversation",
      sessionId: expected[0]!.session.id
    });
    expect(raw.items.map(({ kind, text }) => [kind, text])).toEqual([
      ["conversation_item", "secret"]
    ]);
  });

  it("uses a verified raw turn, omits hidden and foreign content, and falls back to sealed text after completion", async () => {
    const encryption = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 87).toString("base64")
    );
    const repo = createMemorySourceRepository(pool!, {
      envelopeEncryptionProvider: encryption
    });
    const owner = await repo.createUser({
      email: `kin-${randomUUID()}@example.test`
    });
    const other = await repo.createUser({
      email: `kin-${randomUUID()}@example.test`
    });
    const actor = { userId: owner.id };
    const externalSessionId = randomUUID();
    const session = await repo.createCapturedSession(actor, {
      externalSessionId,
      sourceRuntime: "codex-cli",
      captureMethod: "api"
    });
    const add = async (
      type: string,
      text: string,
      sequence: number,
      metadata = {},
      turn = "current"
    ) =>
      repo.createConversationItems(actor, {
        items: [
          {
            sessionId: session.id,
            externalSessionId,
            externalTurnId: turn,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "transcript",
            sourceRecordType: "event_msg",
            sourceEventType: type,
            sourceSequence: sequence,
            eventTime: new Date(
              Date.now() - 60_000 + sequence * 100
            ).toISOString(),
            rawJson: {
              type: "event_msg",
              payload: { type, message: text },
              ignored: "raw secret"
            },
            rawText: text,
            sourceHash: randomUUID(),
            idempotencyKey: randomUUID(),
            metadata
          }
        ]
      });
    await add("user_message", "previous", 1, {}, "previous");
    await add("user_message", "current prompt", 2);
    const [update] = await add("agent_message", "current update", 3);
    await upsertEncryptedFieldPayloadWithClient(pool!, actor, encryption, {
      sourceTable: "conversation_items",
      sourceId: update!.id,
      sourceColumn: "raw_json",
      plaintext: {
        type: "event_msg",
        payload: { type: "agent_message", message: "current update" }
      }
    });
    await pool!.query(
      `update conversation_items set raw_json='{}'::jsonb, raw_text=null,
      metadata = metadata || '{"encryptedConversationItemColumns":["raw_json"]}'::jsonb where id=$1`,
      [update!.id]
    );
    await add("reasoning", "hidden thought", 4);
    await add("agent_message", "approval secret", 5, { approvalReview: true });
    const input = { sessionId: session.id, action: "conversation" as const };
    const raw = await repo.getFloatingKinEvidence(actor, input);
    expect(raw.items.map(({ kind, text }) => [kind, text])).toEqual([
      ["conversation_item", "current prompt"],
      ["conversation_item", "current update"]
    ]);
    expect(
      await repo.getFloatingKinEvidence({ userId: other.id }, input)
    ).toEqual({ items: [], truncated: false });
    const withoutEncryption = createMemorySourceRepository(pool!);
    expect(
      await withoutEncryption.getFloatingKinEvidence(actor, input)
    ).toEqual({
      items: [],
      truncated: true
    });
    expect(
      (
        await repo.getFloatingKinEvidence(actor, {
          ...input,
          action: "project",
          projectId: randomUUID()
        })
      ).items
    ).toEqual([]);
    await add("task_complete", "control", 6);
    await repo.projectPendingConversationItems(actor, { limit: 20 });
    const sealed = await repo.getFloatingKinEvidence(actor, input);
    expect(sealed.items.map(({ kind, text }) => [kind, text])).toEqual(
      expect.arrayContaining([
        ["memory_event", "current prompt"],
        ["memory_event", "current update"]
      ])
    );
    expect(JSON.stringify(sealed)).not.toMatch(
      /raw secret|hidden thought|approval secret|control/
    );
    const project = await repo.createNamedPersonalProject(actor, {
      name: "Kin scope"
    });
    await repo.addPersonalProjectSession(actor, project.projectId, {
      sessionId: session.id,
      expectedVersion: project.version
    });
    expect(
      await repo.getFloatingKinEvidence(actor, {
        ...input,
        action: "project",
        projectId: project.projectId
      })
    ).toEqual(sealed);
    expect(
      await repo.getFloatingKinEvidence(actor, {
        ...input,
        action: "project",
        projectId: randomUUID()
      })
    ).toEqual({ items: [], truncated: false });
    expect(
      (await repo.getFloatingKinActivity(actor)).conversations[0]?.projectId
    ).toBe(project.projectId);
  });
});
