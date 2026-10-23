import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import {
  COLLABORATION_CONTRACT_VERSION,
  crossIdentitySyncDeterministicUuid
} from "@koed/shared";
import { upsertEncryptedFieldPayloadWithClient } from "../../../../packages/db/src/encrypted-payload-repository.js";
import type {
  Hq713Actor,
  Hq713Fixture,
  Hq713HttpResponse
} from "./hq713-fixture.js";

export interface Hq713CuratedInput {
  projectId: string;
  scope: "project" | "me" | "unscoped";
  text: string;
  sourceItemIds: string[];
  includeNonConversationSource?: boolean;
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const vector = `[1,${Array(1023).fill(0).join(",")}]`;

/** Canonical owner-owned input only; publication and consent must use HTTP. */
export async function seedHq713CuratedAssertion(
  fixture: Hq713Fixture,
  actor: Hq713Actor,
  input: Hq713CuratedInput
): Promise<{ assertionId: string }> {
  assert.ok(
    input.sourceItemIds.length > 0,
    "Curated input needs direct sources"
  );
  assert.equal(new Set(input.sourceItemIds).size, input.sourceItemIds.length);
  assert.ok(input.text.trim(), "Curated input needs nonempty text");
  const db = fixture.personalDb(actor);
  const sources = await db.query<{ id: string }>(
    `select ci.id from conversation_items ci
       join sessions s on s.id=ci.session_id
      where ci.id=any($1::uuid[]) and s.owner_user_id=$2
        and ci.personal_deleted_at is null and s.personal_deleted_at is null`,
    [input.sourceItemIds, actor.id]
  );
  assert.equal(
    sources.rowCount,
    input.sourceItemIds.length,
    "All Curated direct sources must be active owner Conversation Items"
  );
  const project = await db.query<{ id: string }>(
    "select id from projects where id=$1 and owner_user_id=$2 and lifecycle='active'",
    [input.projectId, actor.id]
  );
  assert.equal(
    project.rowCount,
    1,
    "Curated input Project must be owner active"
  );
  const assertionId = randomUUID();
  await db.query(
    `insert into curated_memory_assertions (
       id,owner_user_id,visibility,assertion_text,normalized_assertion,
       sensitivity,confidence,tags,metadata,status,observed_at,scope,project_id
     ) values ($1,$2,'personal','[koed encrypted curated memory]',$3,
       'normal',95,'{}','{}','current',now(),$4,$5)`,
    [
      assertionId,
      actor.id,
      `encrypted:${randomUUID()}`,
      input.scope,
      input.scope === "project" ? input.projectId : null
    ]
  );
  await upsertEncryptedFieldPayloadWithClient(
    db,
    { userId: actor.id },
    fixture.personalEncryptionProvider,
    {
      sourceTable: "curated_memory_assertions",
      sourceId: assertionId,
      sourceColumn: "payload",
      plaintext: {
        assertionText: input.text,
        normalizedAssertion: input.text.toLowerCase(),
        tags: ["hq713"],
        metadata: {},
        suppressionReason: null
      },
      visibility: "personal",
      rowFamily: "curated_memory",
      aad: { curatedMemoryId: assertionId }
    }
  );
  for (const [index, sourceItemId] of input.sourceItemIds.entries()) {
    await db.query(
      `insert into curated_memory_sources
       (assertion_id,source_type,source_role,conversation_item_id,metadata)
       values ($1,'conversation_item',$2,$3,'{}')`,
      [
        assertionId,
        index === 0 ? "primary_evidence" : "supporting_evidence",
        sourceItemId
      ]
    );
  }
  if (input.includeNonConversationSource) {
    const workItem = await db.query<{ id: string }>(
      `insert into project_work_items
       (owner_user_id,project_id,kind,title,goal,origin,
        creation_payload_hash,created_by)
       values ($1,$2,'todo','HQ-713 non-Conversation source',
        'Prove direct-source exclusion','manual',$3,$1) returning id`,
      [actor.id, input.projectId, digest(randomUUID())]
    );
    assert.ok(workItem.rows[0]?.id);
    await db.query(
      `insert into curated_memory_sources
       (assertion_id,source_type,source_role,project_work_item_id,metadata)
       values ($1,'project_work_item','supporting_evidence',$2,'{}')`,
      [assertionId, workItem.rows[0].id]
    );
  }
  const embeddingId = randomUUID();
  const contentHash = digest(input.text);
  await db.query(
    `insert into memory_embeddings (
       id,curated_memory_assertion_id,owner_user_id,visibility,
       embedding_model,embedding_dimensions,embedding_version,source_hash,
       source_chunk_index,source_chunk_count,source_text,
       canonical_embedding_state,embedding_source_content_hash,
       embedding_input_hash
     ) values ($1,$2,$3,'personal','qwen3-0.6b',1024,'qwen3-0.6b',$4,
       0,1,'[koed encrypted embedding source]','encrypted_payload',$5,$5)`,
    [
      embeddingId,
      assertionId,
      actor.id,
      digest(`${assertionId}:${input.text}`),
      contentHash
    ]
  );
  await upsertEncryptedFieldPayloadWithClient(
    db,
    { userId: actor.id },
    fixture.personalEncryptionProvider,
    {
      sourceTable: "memory_embeddings",
      sourceId: embeddingId,
      sourceColumn: "source_text",
      plaintext: input.text,
      visibility: "personal",
      rowFamily: "memory_embedding",
      aad: { memoryEmbeddingId: embeddingId }
    }
  );
  await db.query(
    `insert into memory_embeddings_1024 (memory_embedding_id,embedding)
     values ($1,$2::vector)`,
    [embeddingId, vector]
  );
  return { assertionId };
}

/** The owner-side private operation and exact Team freeze are both HTTP. */
export async function makeHq713CapturedChatPrivate(
  fixture: Hq713Fixture,
  actor: Hq713Actor,
  input: { sessionId: string; grantId: string; projectId: string }
): Promise<void> {
  const path = `/v1/local-edge/projects/${input.projectId}/project-share-policy/make-private`;
  const body = {
    teamBackendId: fixture.teamBackendId,
    workspaceProjectId: fixture.ids.workspaceProjectId,
    sessionId: input.sessionId
  };
  const requested = await actor.personalEdge.request<{
    state: string;
    withdrawalTarget?: { shareGrantId: string; grantVersion: number };
  }>("POST", path, { body, expectedStatus: 200 });
  assert.equal(
    requested.body.state,
    "freeze_required",
    "Making a shared Conversation private must require Team freeze"
  );
  const target = requested.body.withdrawalTarget;
  assert.ok(target, "Team must identify exact grant freeze target");
  assert.equal(target.shareGrantId, input.grantId);
  const mutationId = randomUUID();
  const commandRequestId = randomUUID();
  const intent = {
    intent: "collaboration.freeze_shared_memory_grant",
    commandRequestId,
    mutationId,
    teamId: fixture.ids.teamId,
    workspaceId: fixture.ids.workspaceId,
    shareGrantId: input.grantId,
    expectedGrantVersion: target.grantVersion
  };
  const { reference } = await fixture.localActionGrant(actor, intent);
  const frozen = await fixture.localCommand(
    actor,
    "collaboration.freeze_shared_memory_grant",
    {
      mutationId,
      teamId: fixture.ids.teamId,
      workspaceId: fixture.ids.workspaceId,
      shareGrantId: input.grantId,
      expectedGrantVersion: target.grantVersion,
      actionGrant: reference
    },
    { requestId: commandRequestId }
  );
  assert.equal(frozen.ok, true);
  const grant = (
    frozen.data as {
      grant: { id: string; lifecycle: string; frozenAt: string | null };
    }
  ).grant;
  assert.equal(grant.id, input.grantId);
  assert.equal(grant.lifecycle, "active");
  assert.ok(grant.frozenAt);
  const personalDb = fixture.personalDb(actor);
  const triggerName = `hq720_private_retry_${randomUUID().replaceAll("-", "")}`;
  await personalDb.query(
    `create function ${triggerName}() returns trigger language plpgsql as $$
       begin raise exception 'Intentional private completion failure'; end $$`
  );
  await personalDb.query(
    `create trigger ${triggerName} before update on sessions
       for each row when (old.project_share_private_pending_at is not null
         and new.project_share_private_pending_at is null)
       execute function ${triggerName}()`
  );
  try {
    await actor.personalEdge.request("POST", path, {
      body,
      expectedStatus: 500
    });
  } finally {
    await personalDb.query(`drop trigger ${triggerName} on sessions`);
    await personalDb.query(`drop function ${triggerName}()`);
  }
  const completed = await actor.personalEdge.request<{ state: string }>(
    "POST",
    path,
    { body, expectedStatus: 200 }
  );
  assert.equal(completed.body.state, "private");
  const after = await fixture.team.db.query<{
    grant_version: number;
    frozen_at: Date | null;
  }>(
    `select grant_version,frozen_at from team_memory_share_grants where id=$1`,
    [input.grantId]
  );
  assert.equal(after.rows[0]?.grant_version, target.grantVersion + 1);
  assert.ok(after.rows[0]?.frozen_at);
}

/** Alice's real owner command must deny Bob's captured Session. */
export async function attemptHq713OtherOwnerShare(
  fixture: Hq713Fixture,
  actor: Hq713Actor,
  input: {
    ownerActor: Hq713Actor;
    sessionId: string;
    workspaceProjectId: string;
    teamWorkspaceId: string;
  }
): Promise<Hq713HttpResponse<Record<string, unknown>>> {
  const logicalMemoryId = crossIdentitySyncDeterministicUuid({
    protocol: "koed.captured-session-sync/v1",
    sourceDeploymentId: input.ownerActor.deploymentId,
    sourceUserId: input.ownerActor.id,
    originSessionId: input.sessionId,
    identity: "logical-memory"
  });
  return actor.personalEdge.request<Record<string, unknown>>(
    "POST",
    "/v1/local-edge/collaboration/command",
    {
      body: {
        command: {
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: randomUUID(),
          command: "collaboration.preview_shared_memory_candidate",
          input: {
            source: {
              kind: "captured_session",
              sessionId: input.sessionId,
              logicalMemoryId
            },
            activationRepresentation: "lcm_leaves",
            mode: "continuous"
          }
        }
      },
      expectedStatus: 200
    }
  );
}
