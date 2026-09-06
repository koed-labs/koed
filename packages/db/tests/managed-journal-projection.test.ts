import {
  adaptMessages,
  turnBoundaryControl
} from "../../mcp-server/src/claude-transcript-adapter.js";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations,
  verifyManagedJournalTerminal
} from "../src/index.js";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { parsePiSessionJournalBytes } from "../../mcp-server/src/pi-session-parser.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)(
  "managed provider journal Projection in PostgreSQL",
  () => {
    const pool = createDbPool({ connectionString: databaseUrl });
    beforeAll(() => runDbMigrations(pool), 60_000);
    afterAll(() => pool.end());

    it.each([
      ["pi", false, false],
      ["pi", false, true],
      ["pi", true, false],
      ["pi", true, true],
      ["pi", false, "text"],
      ["pi", true, "text"],
      ["claude-code", false, false],
      ["claude-code", false, true],
      ["claude-code", true, false],
      ["claude-code", true, true],
      ["claude-code", false, "text"],
      ["claude-code", true, "text"]
    ] as const)(
      "verifies %s source items with encryption=%s, tampered=%s",
      async (provider, encrypted, tampered) => {
        const repo = createMemorySourceRepository(
          pool,
          encrypted
            ? {
                envelopeEncryptionProvider:
                  createLocalTestKeyEnvelopeEncryptionProvider(
                    Buffer.alloc(32, 19).toString("base64")
                  )
              }
            : {}
        );
        const owner = await repo.createUser({
          email: `journal-${randomUUID()}@example.com`
        });
        const actor = { userId: owner.id };
        const nativeId = randomUUID();
        const session = await repo.createCapturedSession(actor, {
          externalSessionId: nativeId,
          sourceRuntime: provider,
          captureMethod: "api",
          projectId: "/synthetic/journal",
          metadata: { managedConversation: true }
        });
        const timestamp = new Date().toISOString();
        const entries =
          provider === "pi"
            ? [
                {
                  type: "session",
                  version: 3,
                  id: nativeId,
                  cwd: "/synthetic/journal"
                },
                {
                  type: "message",
                  id: "user",
                  parentId: null,
                  timestamp,
                  message: {
                    role: "user",
                    content: [{ type: "text", text: "Synthetic question" }]
                  }
                },
                {
                  type: "message",
                  id: "answer",
                  parentId: "user",
                  timestamp,
                  message: {
                    role: "assistant",
                    content: [
                      { type: "text", text: "Synthetic answer introduction" },
                      { type: "text", text: "Synthetic answer" }
                    ],
                    stopReason: "stop"
                  }
                }
              ]
            : [
                {
                  type: "user",
                  uuid: "user",
                  sessionId: nativeId,
                  timestamp,
                  message: {
                    role: "user",
                    content: [{ type: "text", text: "Synthetic question" }]
                  }
                },
                {
                  type: "assistant",
                  uuid: "answer",
                  sessionId: nativeId,
                  timestamp,
                  message: {
                    role: "assistant",
                    content: [
                      { type: "thinking", thinking: "" },
                      { type: "text", text: "Synthetic answer" }
                    ],
                    stop_reason: "end_turn"
                  }
                }
              ];
        const bytes = Buffer.from(
          entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
        );
        const sourceFingerprint = createHash("sha256")
          .update(nativeId)
          .digest("hex");
        const artifact = await repo.ensureConversationSourceArtifact(actor, {
          sessionId: session.id,
          logicalSourceId: randomUUID(),
          sourceGenerationId: randomUUID(),
          replicaRole: "origin_local",
          sourceKind: provider,
          sourceRuntime: provider,
          externalSessionId: nativeId,
          sourceFingerprint,
          artifactFormat:
            provider === "pi" ? "pi_session_jsonl" : "claude_session_jsonl",
          artifactFormatVersion: 1,
          sourceAdapterVersion:
            provider === "pi" ? "pi-session-v1" : "claude-code-transcript-v1",
          journalStartOffset: 0,
          journalStartLine: 0,
          liveStartOffset: 0,
          liveStartLine: 0,
          currentSourceLength: bytes.length,
          sourceCreatedAt: timestamp,
          storageProvider: "filesystem",
          storagePrefix: randomUUID(),
          originDeploymentId: randomUUID(),
          originDeviceId: randomUUID(),
          originKeyId: randomUUID(),
          originPublicKey: Buffer.alloc(32, 7).toString("base64url"),
          redactedSourceLabel: "Synthetic session"
        });
        await pool.query(
          `update conversation_source_artifacts set provider_cursor_offset = $2, provider_cursor_line = $3 where id = $1`,
          [artifact.id, bytes.length, entries.length]
        );
        const parsed = (
          provider === "pi"
            ? parsePiSessionJournalBytes({
                bytes,
                absoluteStartOffset: 0,
                lineIndexOffset: 0,
                sessionId: session.id,
                externalSessionId: nativeId,
                sourceFingerprint
              }).items
            : adaptMessages({
                messages: entries.map((entry) => ({
                  type: entry.type as "user" | "assistant",
                  uuid: "uuid" in entry ? entry.uuid : "",
                  session_id: nativeId,
                  message: "message" in entry ? entry.message : {},
                  parent_tool_use_id: null,
                  parent_agent_id: null
                })),
                sessionId: nativeId,
                capturedSessionId: session.id,
                cwd: "/synthetic/journal",
                timestamps: new Map(
                  entries.flatMap((entry) =>
                    "uuid" in entry ? [[entry.uuid, timestamp]] : []
                  )
                ),
                observedAt: timestamp,
                minimumMessageIndex: 0,
                componentId: "main"
              })
        )
          .filter((item) => item.projectionStatus === "pending")
          .map((item) => ({ ...item, projectionStatus: "pending" as const }));
        const mismatched = {
          ...parsed[1]!,
          rawJson: {
            ...(parsed[1]!.rawJson as object),
            contentBlock: { type: "text", text: "Unverified replacement" }
          }
        };
        const created = await repo.createConversationItems(actor, {
          items: [
            parsed[0]!,
            tampered === "text"
              ? { ...parsed[1]!, rawText: "Unverified display text" }
              : tampered
                ? mismatched
                : parsed[1]!,
            ...parsed.slice(2),
            ...(provider === "claude-code"
              ? [
                  {
                    ...turnBoundaryControl({
                      signal: {
                        sourceSessionId: nativeId,
                        transcriptPath: "/synthetic/journal/session.jsonl",
                        cwd: "/synthetic/journal"
                      },
                      capturedSessionId: session.id,
                      externalTurnId: "user",
                      frontierOffset: bytes.length,
                      frontierLine: entries.length,
                      sourceSequence: 2999
                    }),
                    projectionStatus: "pending" as const
                  }
                ]
              : [])
          ]
        });
        const before = await pool.query<{ projection_status: string }>(
          `select projection_status from conversation_items where session_id = $1`,
          [session.id]
        );
        expect(
          before.rows.every((row) => row.projection_status === "held")
        ).toBe(true);
        await expect(
          repo.releaseConversationProjectionHold(actor, {
            sessionId: session.id,
            externalTurnId: "user"
          })
        ).rejects.toMatchObject({ code: "managed_turn_not_terminal" });
        const proof = verifyManagedJournalTerminal({
          artifact: { ...artifact, providerCursorOffset: bytes.length },
          sourceOffset: bytes.length,
          bytes
        });
        if (tampered) {
          await expect(
            repo.releaseConversationProjectionHold(actor, {
              sessionId: session.id,
              externalTurnId: "journal",
              verifiedJournal: proof
            })
          ).rejects.toMatchObject({ code: "managed_terminal_journal_invalid" });
          const statuses = await pool.query<{ projection_status: string }>(
            `select projection_status from conversation_items where session_id = $1`,
            [session.id]
          );
          expect(
            statuses.rows.every((row) => row.projection_status === "held")
          ).toBe(true);
          return;
        }
        const released = await repo.releaseConversationProjectionHold(actor, {
          sessionId: session.id,
          externalTurnId: "journal",
          verifiedJournal: proof
        });
        expect(released.conversationItemIds.sort()).toEqual(
          created.map((item) => item.id).sort()
        );
        const after = await pool.query<{
          id: string;
          projection_status: string;
        }>(
          `select id, projection_status from conversation_items where session_id = $1`,
          [session.id]
        );
        expect(
          after.rows.find((row) => row.id === created[1]!.id)?.projection_status
        ).toBe("pending");
        const projection = await repo.projectPendingConversationItems(actor, {
          visibility: "personal",
          conversationItemIds: released.conversationItemIds,
          limit: 100
        });
        expect(projection.rawItemsWaitingForAgentSeal).toBe(0);
        expect(projection.memoryEventsCreated).toBe(2);
        await expect(
          repo.releaseConversationProjectionHold(
            { userId: randomUUID() },
            {
              sessionId: session.id,
              externalTurnId: "journal",
              verifiedJournal: proof
            }
          )
        ).rejects.toMatchObject({ code: "managed_session_not_found" });
      }
    );
  }
);
