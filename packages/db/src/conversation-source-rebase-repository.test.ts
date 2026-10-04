import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import {
  calculateConversationSourceRootDigest,
  generateConversationSourceReplicationOriginKeyPair,
  signConversationSourceClosureManifest
} from "@koed/shared";
import { createConversationSourceJournalRepository } from "./conversation-source-journal-repository.js";

describe("conversation source verified rebase", () => {
  it("returns the persisted accepted frontier by owner-scoped successor generation", async () => {
    const ownerUserId = randomUUID();
    const sourceGenerationId = randomUUID();
    const proof = {
      parent_artifact_id: randomUUID(),
      parent_source_generation_id: randomUUID(),
      accepted_frontier: {
        offset: 512,
        line: 10,
        fileSize: 512,
        prefixSha256: "a".repeat(64),
        modifiedAt: "2026-08-11T00:02:00.000Z"
      }
    };
    const query = vi.fn(async () => ({ rows: [proof] }));
    const pool = { query } as unknown as pg.Pool;
    const repository = createConversationSourceJournalRepository(pool);

    await expect(
      repository.getConversationSourceRebaseProofBySuccessorGeneration(
        { userId: ownerUserId },
        sourceGenerationId
      )
    ).resolves.toEqual({
      parentArtifactId: proof.parent_artifact_id,
      parentSourceGenerationId: proof.parent_source_generation_id,
      acceptedFrontier: proof.accepted_frontier
    });
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "where proof.owner_user_id = $1"
    );
    expect(query.mock.calls[0]?.[1]).toEqual([ownerUserId, sourceGenerationId]);

    query.mockImplementationOnce(async () => ({ rows: [] }));
    await expect(
      repository.getConversationSourceRebaseProofBySuccessorGeneration(
        { userId: randomUUID() },
        sourceGenerationId
      )
    ).resolves.toBeNull();
  });

  it("rejects an owner request without an active claimed prompt and runner binding", async () => {
    const ownerUserId = randomUUID();
    const artifactId = randomUUID();
    const sourceGenerationId = randomUUID();
    const turnId = randomUUID();
    const key = generateConversationSourceReplicationOriginKeyPair();
    const sourceCreatedAt = new Date("2026-08-11T00:00:00.000Z");
    const closedAt = new Date("2026-08-11T00:01:00.000Z").toISOString();
    const parent = {
      id: artifactId,
      owner_user_id: ownerUserId,
      session_id: randomUUID(),
      logical_source_id: randomUUID(),
      source_generation_id: sourceGenerationId,
      source_component_id: "main",
      source_component_role: "primary",
      parent_source_component_id: null,
      content_framing: "jsonl",
      replica_role: "origin_local",
      source_kind: "codex",
      source_runtime: "codex",
      external_session_id: "provider-thread-1",
      source_fingerprint: "1".repeat(64),
      artifact_format: "codex_rollout_jsonl",
      artifact_format_version: 1,
      source_adapter_version: "codex-app-server-v1",
      lifecycle: "active",
      journal_start_offset: 0,
      journal_start_line: 0,
      live_start_offset: 0,
      live_start_line: 0,
      provider_cursor_offset: 0,
      provider_cursor_line: 0,
      current_source_length: 0,
      current_journal_sequence: -1,
      source_created_at: sourceCreatedAt,
      source_modified_at: null,
      storage_provider: "filesystem",
      storage_prefix: "source-prefix",
      closure_hash: null,
      closure_manifest: null,
      closure_signature: null,
      source_set_closure_hash: null,
      source_set_closure_manifest: null,
      source_set_closure_signature: null,
      source_set_finalized_at: null,
      origin_deployment_id: randomUUID(),
      origin_device_id: randomUUID(),
      origin_key_id: key.originKeyId,
      origin_public_key: key.publicKeyBase64url,
      origin_key_status: "active",
      prior_generation_closure: null,
      redacted_source_label: "Conversation source",
      created_at: sourceCreatedAt,
      updated_at: sourceCreatedAt,
      finalized_at: null
    };
    const signedParentClosure = signConversationSourceClosureManifest(
      {
        protocol: "koed.conversation-source-replication/v1",
        sourceComponentSchemaVersion: 1,
        sourceComponentId: "main",
        sourceComponentRole: "primary",
        parentSourceComponentId: null,
        contentFraming: "jsonl",
        logicalSourceId: parent.logical_source_id,
        sourceGenerationId,
        originKeyId: key.originKeyId,
        segmentCount: 0,
        endByteCursor: 0,
        endItemCursor: 0,
        chainHeadDigest: null,
        sourceRootDigest: calculateConversationSourceRootDigest([]),
        sourceCreatedAt: sourceCreatedAt.toISOString(),
        closedAt,
        priorGenerationClosure: null
      },
      key.privateKey
    );
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from conversation_source_artifacts")) {
        return { rows: [parent] };
      }
      return { rows: [] };
    });
    const client = {
      query,
      release: vi.fn()
    };
    const pool = {
      connect: vi.fn(async () => client)
    } as unknown as pg.Pool;
    const repository = createConversationSourceJournalRepository(pool);

    await expect(
      repository.createConversationSourceRebaseSuccessorGeneration(
        { userId: ownerUserId },
        {
          parentArtifactId: artifactId,
          expectedParentFrontier: {
            sourceGenerationId,
            providerCursorOffset: 0,
            providerCursorLine: 0,
            lastSegmentDigest: null
          },
          successor: {
            sourceGenerationId: randomUUID(),
            sourceFrontier: {
              offset: 100,
              line: 1,
              fileSize: 100,
              prefixSha256: "2".repeat(64),
              modifiedAt: "2026-08-11T00:02:00.000Z"
            },
            sourceCreatedAt: "2026-08-11T00:02:00.000Z",
            originDeploymentId: parent.origin_deployment_id,
            originDeviceId: parent.origin_device_id,
            originKeyId: randomUUID(),
            originPublicKey: key.publicKeyBase64url,
            storageProvider: "filesystem",
            storagePrefix: "next-prefix"
          },
          commandProof: {
            executionId: randomUUID(),
            executionGeneration: 1,
            commandId: randomUUID(),
            clientUserMessageId: randomUUID(),
            providerThreadId: "provider-thread-1",
            providerHistorySha256: "3".repeat(64),
            canonicalHistorySha256: "4".repeat(64),
            turnIds: [turnId],
            turnCount: 1,
            messageCount: 2,
            messages: [
              {
                kind: "user",
                clientUserMessageId: randomUUID(),
                turnId,
                textSha256: "5".repeat(64)
              },
              {
                kind: "assistant",
                turnId,
                textSha256: "6".repeat(64)
              }
            ],
            terminal: true,
            targetPromptAbsent: true
          },
          signedParentClosure
        }
      )
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "conversation_source_rebase_command_invalid"
    });

    const authorizationQuery = query.mock.calls.find((call) =>
      String(call[0]).includes("command.lease_expires_at > now()")
    );
    expect(authorizationQuery).toBeDefined();
    expect(String(authorizationQuery?.[0])).toContain(
      "command.state = 'dispatching'"
    );
    expect(String(authorizationQuery?.[0])).toContain(
      "command.allow_archived_resume = true"
    );
    expect(String(authorizationQuery?.[0])).toContain(
      "execution.provider_thread_id = $6"
    );
    expect(String(authorizationQuery?.[0])).toContain(
      "binding.device_id::text = $9"
    );
    expect(
      query.mock.calls.some((call) =>
        String(call[0]).includes("conversation_items")
      )
    ).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
