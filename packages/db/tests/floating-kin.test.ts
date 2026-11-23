import { randomUUID } from "node:crypto";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  floatingKinEvidenceLimit
} from "@koed-labs/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
              sourceSequence: claude ? 1000 : 1,
              externalItemId: claude ? "main:current:0" : undefined,
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
                    sourceRecord: {
                      uuid: "current",
                      type: "user",
                      message: {
                        role: "user",
                        content: [{ type: "text", text: "secret" }]
                      }
                    },
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
    const foreign = await capture(other.id, 59);
    const old = await capture(owner.id, -3600);
    const approval = await capture(owner.id, 58, { approvalReview: true });
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
    expect(
      await repo.getFloatingKinPreview(actor, {
        sessionId: expected[5]!.session.id
      })
    ).toEqual({
      title: null,
      projectName: null,
      reply: null,
      request: { text: "secret", occurredAt: timestamp(1) }
    });
    for (const { session } of [foreign, old, approval, historical, deleted]) {
      expect(
        await repo.getFloatingKinPreview(actor, { sessionId: session.id })
      ).toBeNull();
    }
    await pool!.query(
      "update conversation_items set observed_at=now() - interval '31 minutes' where id=$1",
      [expected[5]!.item.id]
    );
    expect(
      await repo.getFloatingKinPreview(actor, {
        sessionId: expected[5]!.session.id
      })
    ).toBeNull();
    const raw = await repo.getFloatingKinEvidence(actor, {
      action: "conversation",
      sessionId: expected[0]!.session.id
    });
    expect(raw.items.map(({ kind, text }) => [kind, text])).toEqual([
      ["conversation_item", "secret"]
    ]);
  });

  const claudeTurn = async () => {
    const repo = createMemorySourceRepository(pool!);
    const owner = await repo.createUser({
      email: `kin-${randomUUID()}@example.test`
    });
    const actor = { userId: owner.id };
    const externalSessionId = randomUUID();
    const session = await repo.createCapturedSession(actor, {
      externalSessionId,
      sourceRuntime: "claude-code",
      captureMethod: "api"
    });
    const input = { sessionId: session.id, action: "conversation" as const };
    const now = Date.now();
    const add = async ({
      index = 0,
      completion = false,
      thread = externalSessionId,
      turn = "prompt",
      content = [{ type: "text", text: "first" }],
      withProof = true,
      watcherBlockCount = 0,
      component = "main",
      role = "user",
      message = turn,
      sequence = 1000 + index,
      age = completion ? 1000 : 2000
    }: {
      index?: number;
      completion?: boolean;
      thread?: string;
      turn?: string;
      content?: { type: string; text: string }[];
      withProof?: boolean;
      watcherBlockCount?: number;
      component?: string;
      role?: "user" | "assistant";
      message?: string;
      sequence?: number;
      age?: number;
    } = {}) => {
      return repo.createConversationItems(actor, {
        items: [
          {
            sessionId: session.id,
            externalSessionId,
            externalThreadId: thread,
            externalTurnId: turn,
            externalItemId: completion
              ? `turn:${turn}:completed`
              : `${component}:${message}:${index}`,
            sourceKind: "claude-code",
            sourceAdapterVersion: completion
              ? "claude-code-hook-signal-v1"
              : "claude-code-transcript-v1",
            sourceTransport: completion ? "hook_signal" : "transcript",
            sourceRecordType: completion ? "hook_signal" : "session_message",
            sourceEventType: completion
              ? "turn_completed"
              : content[index]?.type === "tool_result"
                ? "tool_result"
                : role === "user"
                  ? "user_message"
                  : "agent_message",
            sourceSequence: completion ? 2999 : sequence,
            eventTime: new Date(now - age).toISOString(),
            rawJson: completion
              ? { type: "hook_signal", payload: { type: "turn_completed" } }
              : {
                  type: "claude_session_message",
                  contentBlock: content[index],
                  ...(withProof
                    ? index === 0
                      ? {
                          sourceRecord: {
                            uuid: message,
                            type: role,
                            message: { role, content }
                          }
                        }
                      : { sourceRecordReference: message }
                    : { messageType: role, messageUuid: message })
                },
            rawText: completion ? undefined : content[index]?.text,
            sourceHash: randomUUID(),
            idempotencyKey: randomUUID(),
            metadata: {
              sourceComponentId: component,
              ...(watcherBlockCount
                ? { sourceMessageBlockCount: watcherBlockCount }
                : {})
            }
          }
        ]
      });
    };
    return {
      add,
      preview: () =>
        repo.getFloatingKinPreview(actor, { sessionId: session.id }),
      read: (evidenceIds?: string[]) =>
        repo.getFloatingKinEvidence(actor, { ...input, evidenceIds })
    };
  };

  it("closes Claude raw evidence only for a completion in its Projection scope", async () => {
    const { add, read } = await claudeTurn();
    await add();
    const [foreign] = await add({ completion: true, turn: "foreign" });
    await pool!.query(
      "update conversation_items set external_thread_id=$1, external_turn_id='prompt' where id=$2",
      [randomUUID(), foreign!.id]
    );
    await add({ completion: true, turn: "previous" });
    const [otherProject] = await add({
      completion: true,
      turn: "other-project"
    });
    await pool!.query(
      `update conversation_items set external_turn_id='prompt',
      metadata=metadata || '{"projectId":"foreign-project"}'::jsonb where id=$1`,
      [otherProject!.id]
    );
    expect((await read()).items.map(({ text }) => text)).toEqual(["first"]);
    await add({ completion: true });
    expect((await read()).items).toEqual([]);
  });

  it("does not admit a partial initiating Claude message and preserves all eligible blocks once complete", async () => {
    const { add, read, preview } = await claudeTurn();
    const content = [
      { type: "text", text: "first" },
      { type: "tool_result", text: "internal tool output" },
      { type: "text", text: "second" }
    ];
    const [first] = await add({ content });
    await add({ content, index: 2 });
    expect(await preview()).toEqual({
      title: null,
      projectName: null,
      request: null,
      reply: null
    });
    expect((await read()).items).toEqual([]);
    expect((await read([first!.id])).items).toEqual([]);
    await add({ content, index: 1 });
    const { items } = await read();
    expect(items.map(({ text }) => text)).toEqual(["first", "second"]);
    expect((await read(items.map(({ id }) => id))).items).toEqual(items);
  });

  it("uses new live watcher blocks only once the initiating message is complete", async () => {
    const { add, read } = await claudeTurn();
    const content = [
      { type: "text", text: "first" },
      { type: "text", text: "second" }
    ];
    const options = { content, withProof: false, watcherBlockCount: 2 };
    await add({ ...options, index: 1 });
    expect((await read()).items).toEqual([]);
    await add(options);
    const { items } = await read();
    expect(items.map(({ text }) => text)).toEqual(["first", "second"]);
    expect((await read(items.map(({ id }) => id))).items).toEqual(items);
  });

  it("does not cut off initiating Claude blocks at the synthesis byte budget", async () => {
    const { add, read } = await claudeTurn();
    const content = Array.from({ length: 6 }, (_, index) => ({
      type: "text",
      text: String(index).repeat(8100)
    }));
    for (let index = 0; index < content.length; index++)
      await add({ content, index });
    expect(await read()).toEqual({ items: [], truncated: true });
  });

  it("falls back instead of clipping a single oversized initiating Claude block", async () => {
    const { add, read } = await claudeTurn();
    const [prompt] = await add({
      content: [{ type: "text", text: `${"x".repeat(9000)} Final constraint.` }]
    });
    const [update] = await add({
      role: "assistant",
      message: "main-update",
      sequence: 2000,
      age: 1000,
      content: [{ type: "text", text: "Main update" }]
    });
    expect(await read()).toEqual({ items: [], truncated: true });
    expect((await read([prompt!.id, update!.id])).items).toEqual([]);
  });

  it("selects the main Claude component before checking turn continuity", async () => {
    const { add, read } = await claudeTurn();
    const [prompt] = await add();
    const [child] = await add({
      component: "subagent.fixture",
      turn: "child-turn",
      age: 1500,
      content: [{ type: "text", text: "child prompt" }]
    });
    const [update] = await add({
      role: "assistant",
      message: "main-update",
      sequence: 2000,
      age: 1000,
      content: [{ type: "text", text: "main update" }]
    });
    const { items } = await read();
    expect(items.map(({ id, text }) => [id, text])).toEqual([
      [prompt!.id, "first"],
      [update!.id, "main update"]
    ]);
    expect((await read([prompt!.id, child!.id, update!.id])).items).toEqual(
      items
    );
  });

  it("falls back when Claude rows do not prove the initiating message is complete", async () => {
    const { add, read } = await claudeTurn();
    await add({ withProof: false });
    expect((await read()).items).toEqual([]);
  });

  it("finds older sealed Project evidence behind encrypted tool-only turns", async () => {
    const encryption = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 87).toString("base64")
    );
    const repo = createMemorySourceRepository(pool!, {
      envelopeEncryptionProvider: encryption
    });
    const withoutEncryption = createMemorySourceRepository(pool!);
    const owner = await repo.createUser({
      email: `kin-${randomUUID()}@example.test`
    });
    const actor = { userId: owner.id };
    const externalSessionId = randomUUID();
    const session = await repo.createCapturedSession(actor, {
      externalSessionId,
      sourceRuntime: "codex-cli",
      captureMethod: "api"
    });
    const project = await repo.createNamedPersonalProject(actor, {
      name: "Synthetic sealed evidence"
    });
    await repo.addPersonalProjectSession(actor, project.projectId, {
      sessionId: session.id,
      expectedVersion: project.version
    });
    const now = Date.now() - 60_000;
    const item = (
      turn: number,
      type: string,
      payload: Record<string, unknown>,
      rawText?: string
    ) => {
      const sourceSequence = turn * 2 + Number(type === "task_complete");
      const recordType =
        type === "function_call" ? "response_item" : "event_msg";
      return {
        sessionId: session.id,
        externalSessionId,
        externalTurnId: `turn-${turn}`,
        sourceKind: "codex" as const,
        sourceAdapterVersion: "codex-transcript-v1",
        sourceTransport: "transcript" as const,
        sourceRecordType: recordType,
        sourceEventType: type,
        sourceSequence,
        eventTime: new Date(now + sourceSequence * 100).toISOString(),
        rawJson: { type: recordType, payload: { type, ...payload } },
        rawText,
        sourceHash: randomUUID(),
        idempotencyKey: randomUUID()
      };
    };
    const prompt = "Older synthetic prompt";
    const toolTurns = floatingKinEvidenceLimit + 1;
    await repo.createConversationItems(actor, {
      items: [
        item(0, "user_message", { message: prompt }, prompt),
        item(0, "task_complete", {}),
        ...Array.from({ length: toolTurns }, (_, i) => [
          item(
            i + 1,
            "function_call",
            {
              name: "fixture_tool",
              call_id: `fixture-${i}`,
              arguments: '{"fixture":true}'
            },
            '{"fixture":true}'
          ),
          item(i + 1, "task_complete", {})
        ]).flat()
      ]
    });
    vi.stubEnv("KOED_DEPLOYMENT_PROFILE", "koed_managed_cloud");
    try {
      await repo.projectPendingConversationItems(actor, { limit: 100 });
    } finally {
      vi.unstubAllEnvs();
    }
    const { rows } = await pool!.query<{ id: string; encrypted: boolean }>(
      `select id, payload->'contentEncrypted' = 'true'::jsonb as encrypted
       from memory_events where session_id=$1 order by source_event_time desc`,
      [session.id]
    );
    expect(rows).toHaveLength(toolTurns + 1);
    expect(rows.every(({ encrypted }) => encrypted)).toBe(true);
    const input = {
      action: "project" as const,
      sessionId: session.id,
      projectId: project.projectId
    };
    const { items } = await repo.getFloatingKinEvidence(actor, input);
    expect(items.map(({ id, kind, text }) => [id, kind, text])).toEqual([
      [rows.at(-1)!.id, "memory_event", prompt]
    ]);
    expect(
      (await withoutEncryption.getFloatingKinEvidence(actor, input)).items
    ).toEqual([]);
    expect(
      (
        await repo.getFloatingKinEvidence(actor, {
          ...input,
          evidenceIds: [rows[0]!.id, rows.at(-1)!.id]
        })
      ).items
    ).toEqual(items);
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
    const older = await add("user_message", "previous", 1, {}, "previous");
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
    const previewInput = { sessionId: session.id };
    expect(await repo.getFloatingKinPreview(actor, previewInput)).toMatchObject(
      {
        title: null,
        projectName: null,
        request: { text: "current prompt" },
        reply: { text: "current update" }
      }
    );
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
    const revalidate = () =>
      repo.getFloatingKinEvidence(actor, {
        ...input,
        evidenceIds: raw.items.map(({ id }) => id)
      });
    await add("user_message", "u".repeat(280), 6, {}, "newer");
    let lastUpdateId: string | undefined;
    for (let sequence = 10; sequence < 43; sequence++) {
      const [item] = await add(
        "agent_message",
        `newer update ${sequence}`,
        sequence,
        {},
        "newer"
      );
      lastUpdateId = item!.id;
    }
    expect((await revalidate()).items).toEqual(raw.items);
    await add("task_complete", "control", 7);
    expect((await revalidate()).items).toEqual([]);
    await repo.projectPendingConversationItems(actor, { limit: 20 });
    expect((await revalidate()).items).toEqual(raw.items);
    await add("task_complete", "control", 8, {}, "newer");
    await repo.projectPendingConversationItems(actor, { limit: 100 });
    await pool!.query(
      "update conversation_items set event_time=now() - interval '31 minutes' where id=$1",
      [older[0]!.id]
    );
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
    await pool!.query(
      `update sessions set metadata=metadata || $2::jsonb where id=$1`,
      [session.id, JSON.stringify({ threadName: `   ${"t".repeat(300)}   ` })]
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
    expect(await repo.getFloatingKinPreview(actor, previewInput)).toMatchObject(
      {
        title: "t".repeat(240),
        projectName: "Kin scope",
        request: { text: "u".repeat(240) },
        reply: { text: "newer update 42" }
      }
    );
    const sealedIds = sealed.items.map(({ id }) => id);
    expect(
      (
        await repo.getFloatingKinEvidence(actor, {
          ...input,
          action: "project",
          projectId: project.projectId,
          evidenceIds: sealedIds
        })
      ).items
    ).toEqual(sealed.items);
    expect(
      (
        await repo.getFloatingKinEvidence(actor, {
          ...input,
          action: "project",
          projectId: randomUUID(),
          evidenceIds: sealedIds
        })
      ).items
    ).toEqual([]);
    await pool!.query(
      "update conversation_items set memory_excluded_at=now() where id=$1",
      [update!.id]
    );
    expect((await revalidate()).items.map(({ text }) => text)).toEqual([
      "current prompt"
    ]);
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

    const { rowCount } = await pool!.query(
      `update memory_events me set payload=jsonb_set(payload, '{metadata,semanticItemManifest}', (
         select jsonb_agg(case when entry->'sourceIds' ? $1::text
           then jsonb_set(entry, '{includeInLcm}', 'false') else entry end order by ordinality)
         from jsonb_array_elements(payload->'metadata'->'semanticItemManifest') with ordinality entries(entry, ordinality)
       )) where me.include_in_lcm and me.seal_reason is not null and exists (
         select 1 from memory_event_sources ref where ref.memory_event_id=me.id and ref.conversation_item_id=$1::uuid
       )`,
      [lastUpdateId]
    );
    expect(rowCount).toBeGreaterThan(0);
    expect(
      (await repo.getFloatingKinPreview(actor, previewInput))?.reply?.text
    ).toBe("newer update 41");

    const [promptItem] = await add(
      "user_message",
      "sealed prompt",
      50,
      {},
      "unfinished"
    );
    await add("agent_message", "unfinished reply", 51, {}, "unfinished");
    await repo.projectPendingConversationItems(actor, { limit: 20 });
    const { rowCount: invalidatedSeals } = await pool!.query(
      `update memory_events me set include_in_lcm=false
       from memory_event_sources ref where ref.memory_event_id=me.id
         and ref.conversation_item_id=$1 and me.seal_reason is not null`,
      [promptItem!.id]
    );
    expect(invalidatedSeals).toBe(1);
    const unfinished = await repo.getFloatingKinPreview(actor, previewInput);
    expect(unfinished?.request?.text).not.toBe("sealed prompt");
    expect(unfinished?.reply?.text).toBe("unfinished reply");
  });
});
