import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  importNormalizedAttempt,
  normalizedImportPayload,
  normalizedImportThreadId
} from "./ingestion.js";
import type { NormalizedTranscriptItem } from "./atif/index.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const sourceIdentity = (sequence: number, atifIdentity: string): string =>
  `harbor-atif:1.0.0:${sha256(
    JSON.stringify({
      atifIdentity,
      sequence,
      sourceAttemptId: "source-1",
      taskDigest: "sha256:task"
    })
  )}`;
const manifest = {
  inputSha256: "a".repeat(64),
  outputSha256: "b".repeat(64),
  schemaVersion: "ATIF-v1.7",
  allowedFieldCounts: {},
  removedFieldCounts: {},
  redactionCounts: {},
  limitUsage: {
    rawBytes: 1,
    nestingDepth: 1,
    steps: 1,
    nestedValues: 1,
    largestStringBytes: 1,
    allowedTextBytes: 1,
    allowedTextTokens: 1
  },
  cutoffAttested: true,
  rejectionReason: null
};

const item: NormalizedTranscriptItem = {
  adapterName: "harbor-atif",
  adapterVersion: "1.0.0",
  sourceIdentity: sourceIdentity(0, "step:1:message"),
  atifIdentity: "step:1:message",
  sequence: 0,
  stepId: 1,
  timestamp: null,
  type: "agent_message",
  content: "Use the previous experience carefully."
};

describe("normalized experience import", () => {
  it("builds deterministic truthful canonical payloads", () => {
    const externalThreadId = normalizedImportThreadId(
      "sha256:task",
      "source-1"
    );
    const payload = normalizedImportPayload({
      sessionId: "00000000-0000-4000-8000-000000000001",
      externalThreadId,
      projectId: "/benchmark/task-a",
      taskDigest: "sha256:task",
      sourceAttemptId: "source-1",
      sanitizationManifestHash: `sha256:${"c".repeat(64)}`,
      item
    });
    expect(payload).toMatchObject({
      sourceKind: "codex",
      sourceAdapterVersion: "koed-normalized-import-v1",
      sourceTransport: "normalized_import",
      sourceEventType: "agent_message",
      metadata: {
        projectId: "/benchmark/task-a",
        transcriptType: "agent_message",
        normalizedImportProvenance: {
          sourceFormat: "atif",
          sourceSchemaVersion: "ATIF-v1.7",
          sourceProducer: "harbor-codex",
          normalizerAdapter: "harbor-atif",
          normalizerAdapterVersion: "1.0.0",
          sanitizationManifestHash: `sha256:${"c".repeat(64)}`
        }
      }
    });
    expect(payload).not.toHaveProperty("eventTime");
    expect(payload.canonicalItemKey).toMatch(
      /^conversation-item:[a-f0-9]{64}$/
    );
  });

  it("keeps identical payloads from different transcripts distinct", () => {
    const first = normalizedImportPayload({
      sessionId: "00000000-0000-4000-8000-000000000001",
      externalThreadId: normalizedImportThreadId("sha256:task-a", "source-a"),
      projectId: "/benchmark/task-a",
      taskDigest: "sha256:task-a",
      sourceAttemptId: "source-a",
      sanitizationManifestHash: `sha256:${"c".repeat(64)}`,
      item: { ...item, sourceIdentity: "normalized-item-a" }
    });
    const second = normalizedImportPayload({
      sessionId: "00000000-0000-4000-8000-000000000002",
      externalThreadId: normalizedImportThreadId("sha256:task-b", "source-b"),
      projectId: "/benchmark/task-b",
      taskDigest: "sha256:task-b",
      sourceAttemptId: "source-b",
      sanitizationManifestHash: `sha256:${"d".repeat(64)}`,
      item: { ...item, sourceIdentity: "normalized-item-b" }
    });

    expect(first.rawJson).toEqual(second.rawJson);
    expect(first.sourceHash).not.toBe(second.sourceHash);
    expect(first.canonicalItemKey).not.toBe(second.canonicalItemKey);
  });

  it("keeps a tool call identity distinct from a tool result parent link", () => {
    const toolCallId = "call-1";
    const payload = normalizedImportPayload({
      sessionId: "00000000-0000-4000-8000-000000000001",
      externalThreadId: normalizedImportThreadId("sha256:task", "source-1"),
      projectId: "/benchmark/task-a",
      taskDigest: "sha256:task",
      sourceAttemptId: "source-1",
      sanitizationManifestHash: `sha256:${"c".repeat(64)}`,
      item: {
        ...item,
        type: "tool_call",
        content: undefined,
        sourceCallId: toolCallId,
        toolCall: {
          tool_call_id: toolCallId,
          function_name: "exec",
          arguments: { command: "true" }
        }
      }
    });

    expect(payload.rawJson).toEqual({
      type: "normalized_import_item",
      payload: {
        type: "tool_call",
        toolCall: {
          tool_call_id: toolCallId,
          function_name: "exec",
          arguments: { command: "true" }
        }
      }
    });
    expect(payload).not.toHaveProperty("parentExternalItemId");
    expect(payload.metadata).toMatchObject({ toolCallId });
  });

  it("uses the API boundary and projects every returned canonical item", async () => {
    const createSession = vi.fn(async () => ({ session: { id: "session-a" } }));
    const createTrustedNormalizedImport = vi.fn<
      (
        input: Record<string, unknown>
      ) => Promise<{ items: Array<{ id: string }> }>
    >(async () => ({
      items: [{ id: "item-a" }, { id: "item-b" }]
    }));
    const projectConversationItems = vi.fn(async () => ({
      projection: {
        rawItemsScanned: 2,
        rawItemsProjected: 2,
        memoryEventsCreated: 1,
        memoryEventIds: ["event-a"],
        memoryEventScopes: [
          {
            eventId: "event-a",
            visibility: "personal",
            includeInEmbedding: true,
            includeInLcm: true,
            workClass: "live_capture_projection"
          }
        ]
      },
      processing: { compactions: [{ queued: false, inline: true }] }
    }));
    await expect(
      importNormalizedAttempt({
        client: {
          createSession,
          createTrustedNormalizedImport,
          projectConversationItems
        },
        projectId: "/benchmark/task-a",
        projectCwd: "/benchmark/task-a",
        taskDigest: "sha256:task",
        sourceAttemptId: "source-1",
        sanitizationManifest: manifest,
        items: [
          item,
          {
            ...item,
            sequence: 1,
            atifIdentity: "step:2:message",
            stepId: 2,
            sourceIdentity: sourceIdentity(1, "step:2:message")
          }
        ]
      })
    ).resolves.toEqual({
      sessionId: "session-a",
      conversationItemIds: ["item-a", "item-b"],
      projection: {
        rawItemsScanned: 2,
        rawItemsProjected: 2,
        memoryEventsCreated: 1,
        memoryEventIds: ["event-a"],
        dispositions: [
          {
            eventId: "event-a",
            visibility: "personal",
            includeInEmbedding: true,
            includeInLcm: true,
            workClass: "live_capture_projection"
          }
        ],
        scheduledLcmEventIds: ["event-a"]
      }
    });
    expect(createTrustedNormalizedImport).toHaveBeenCalledOnce();
    const trustedImportInput = createTrustedNormalizedImport.mock.calls[0]![0];
    expect(trustedImportInput.attestation).toMatchObject({
      projectId: "/benchmark/task-a",
      sequenceStart: 0
    });
    expect(trustedImportInput.attestation).toHaveProperty(
      "sanitizationManifestHash",
      expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    );
    expect(trustedImportInput.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceAdapterVersion: "koed-normalized-import-v1"
        })
      ])
    );
    expect(projectConversationItems).toHaveBeenCalledWith({
      conversationItemIds: ["item-a", "item-b"],
      limit: 2
    });
  });

  it("fails closed when Projection omits its database-backed dispositions", async () => {
    await expect(
      importNormalizedAttempt({
        client: {
          createSession: vi.fn(async () => ({ session: { id: "session-a" } })),
          createTrustedNormalizedImport: vi.fn(async () => ({
            items: [{ id: "item-a" }]
          })),
          projectConversationItems: vi.fn(async () => ({ ok: true }))
        },
        projectId: "/benchmark/task-a",
        projectCwd: "/benchmark/task-a",
        taskDigest: "sha256:task",
        sourceAttemptId: "source-1",
        sanitizationManifest: manifest,
        items: [item]
      })
    ).rejects.toThrow("structured disposition");
  });

  it("fails closed before the trusted route on forged identity, gaps, or manifest claims", async () => {
    const createTrustedNormalizedImport = vi.fn();
    const base = {
      client: {
        createSession: vi.fn(async () => ({ session: { id: "session-a" } })),
        createTrustedNormalizedImport,
        projectConversationItems: vi.fn()
      },
      projectId: "/benchmark/task-a",
      projectCwd: "/benchmark/task-a",
      taskDigest: "sha256:task",
      sourceAttemptId: "source-1",
      sanitizationManifest: manifest
    };
    await expect(
      importNormalizedAttempt({
        ...base,
        items: [{ ...item, sourceIdentity: "harbor-atif:1.0.0:forged" }]
      })
    ).rejects.toThrow("item order or adapter identity");
    await expect(
      importNormalizedAttempt({ ...base, items: [{ ...item, sequence: 1 }] })
    ).rejects.toThrow("item order or adapter identity");
    await expect(
      importNormalizedAttempt({
        ...base,
        sanitizationManifest: { ...manifest, cutoffAttested: false },
        items: [item]
      })
    ).rejects.toThrow("successful ATIF sanitization manifest");
    expect(createTrustedNormalizedImport).not.toHaveBeenCalled();
  });
});
