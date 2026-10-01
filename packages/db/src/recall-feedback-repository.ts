import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import {
  createEncryptedPayloadRepository,
  upsertEncryptedFieldPayloadWithClient
} from "./encrypted-payload-repository.js";
import type { EnvelopeEncryptionProvider } from "@koed/shared";
import type { ActorContext } from "./types.js";

export type RecallFeedbackAnswerKind = "provider" | "agent";
export type RecallFeedbackSourceReference = {
  nodeId: string;
  sourceType: "memory_node" | "memory_event" | "message" | "curated_memory";
  sourceId: string | null;
  sourceChunkIndex: number | null;
  visibility: "personal" | "team";
  teamWorkspaceId: string | null;
};

export type RecallFeedbackRecord = {
  rating: "up" | "down" | null;
  comment: string | null;
  updatedAt: string;
};

export type RecallFeedbackRepository = {
  getRecallFeedback(
    actor: ActorContext,
    input: {
      executionId: string;
      answerKind: RecallFeedbackAnswerKind;
      answerId: string;
    }
  ): Promise<RecallFeedbackRecord | null>;
  putRecallFeedback(
    actor: ActorContext,
    input: {
      executionId: string;
      answerKind: RecallFeedbackAnswerKind;
      answerId: string;
      sourceAssociationHash: string;
      sourceReferences: RecallFeedbackSourceReference[];
      rating?: "up" | "down" | null;
      comment?: string | null;
    }
  ): Promise<RecallFeedbackRecord | null>;
};

export class RecallFeedbackSourceConflictError extends Error {
  statusCode = 409;

  constructor() {
    super("The answer's recalled source association has changed");
    this.name = "RecallFeedbackSourceConflictError";
  }
}

const COMMENT_MARKER = "[koed encrypted recall feedback comment]";
const hashPattern = /^[a-f0-9]{64}$/;

type FeedbackRow = {
  id: string;
  rating: "up" | "down" | null;
  comment_marker: string | null;
  source_association_hash: string;
  updated_at: Date;
};

export const recallFeedbackSourceAssociationHash = (
  references: RecallFeedbackSourceReference[]
): string =>
  createHash("sha256").update(JSON.stringify(references)).digest("hex");

export const createRecallFeedbackRepository = (
  pool: pg.Pool,
  options: { envelopeEncryptionProvider?: EnvelopeEncryptionProvider } = {}
): RecallFeedbackRepository => {
  const encryptedPayloadRepository = createEncryptedPayloadRepository(pool);

  const readComment = async (
    actor: ActorContext,
    feedbackId: string
  ): Promise<string | null> => {
    const provider = options.envelopeEncryptionProvider;
    if (!provider) {
      throw new Error("Envelope encryption provider is required for feedback");
    }
    const payload =
      await encryptedPayloadRepository.decryptAuthorizedEncryptedField(
        actor,
        provider,
        {
          sourceTable: "managed_conversation_recall_feedback",
          sourceId: feedbackId,
          sourceColumn: "comment_marker"
        }
      );
    return typeof payload?.plaintext === "string" ? payload.plaintext : null;
  };

  const mapFeedback = async (
    actor: ActorContext,
    row: FeedbackRow
  ): Promise<RecallFeedbackRecord> => ({
    rating: row.rating,
    comment:
      row.comment_marker === COMMENT_MARKER
        ? await readComment(actor, row.id)
        : null,
    updatedAt: row.updated_at.toISOString()
  });

  return {
    async getRecallFeedback(actor, input) {
      const result = await pool.query<FeedbackRow>(
        `select id, rating, comment_marker, source_association_hash, updated_at
         from managed_conversation_recall_feedback
         where owner_user_id = $1 and execution_id = $2
           and answer_kind = $3 and answer_id = $4
         limit 1`,
        [actor.userId, input.executionId, input.answerKind, input.answerId]
      );
      const row = result.rows[0];
      return row ? mapFeedback(actor, row) : null;
    },

    async putRecallFeedback(actor, input) {
      if (!options.envelopeEncryptionProvider) {
        throw new Error(
          "Envelope encryption provider is required for feedback"
        );
      }
      if (!hashPattern.test(input.sourceAssociationHash)) {
        throw new TypeError("sourceAssociationHash must be a SHA-256 digest");
      }
      if (
        recallFeedbackSourceAssociationHash(input.sourceReferences) !==
        input.sourceAssociationHash
      ) {
        throw new TypeError("source references do not match their hash");
      }

      const client = await pool.connect();
      let committed = false;
      try {
        await client.query("begin");
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [
            `recall-feedback:${actor.userId}:${input.executionId}:${input.answerKind}:${input.answerId}`
          ]
        );
        const currentResult = await client.query<FeedbackRow>(
          `select id, rating, comment_marker, source_association_hash, updated_at
           from managed_conversation_recall_feedback
           where owner_user_id = $1 and execution_id = $2
             and answer_kind = $3 and answer_id = $4
           for update`,
          [actor.userId, input.executionId, input.answerKind, input.answerId]
        );
        const current = currentResult.rows[0] ?? null;
        if (
          current &&
          current.source_association_hash !== input.sourceAssociationHash
        ) {
          throw new RecallFeedbackSourceConflictError();
        }

        const nextRating =
          input.rating === undefined ? (current?.rating ?? null) : input.rating;
        const nextCommentMarker =
          input.comment === undefined
            ? (current?.comment_marker ?? null)
            : input.comment === null
              ? null
              : COMMENT_MARKER;
        if (nextRating === null && nextCommentMarker === null) {
          if (current) {
            await client.query(
              `delete from managed_conversation_recall_feedback
               where id = $1 and owner_user_id = $2`,
              [current.id, actor.userId]
            );
            await client.query(
              `update encrypted_field_payloads
               set invalidated_at = now(), updated_at = now()
               where source_table = 'managed_conversation_recall_feedback'
                 and source_id = $1 and invalidated_at is null`,
              [current.id]
            );
          }
          await client.query("commit");
          committed = true;
          return null;
        }

        const feedbackId = current?.id ?? randomUUID();
        const result = await client.query<FeedbackRow>(
          `insert into managed_conversation_recall_feedback (
             id, owner_user_id, execution_id, answer_kind, answer_id,
             source_association_hash, rating, comment_marker
           ) values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (owner_user_id, execution_id, answer_kind, answer_id)
           do update set rating = excluded.rating,
                         comment_marker = excluded.comment_marker,
                         updated_at = now()
           returning id, rating, comment_marker, source_association_hash, updated_at`,
          [
            feedbackId,
            actor.userId,
            input.executionId,
            input.answerKind,
            input.answerId,
            input.sourceAssociationHash,
            nextRating,
            nextCommentMarker
          ]
        );
        const row = result.rows[0]!;

        if (!current) {
          await upsertEncryptedFieldPayloadWithClient(
            client,
            actor,
            options.envelopeEncryptionProvider,
            {
              sourceTable: "managed_conversation_recall_feedback",
              sourceId: feedbackId,
              sourceColumn: "source_association",
              plaintext: input.sourceReferences,
              visibility: "personal",
              rowFamily: "managed_conversation_recall_feedback",
              scope: {
                tenantId: actor.userId,
                objectClass: "managed_conversation_recall_feedback"
              },
              aad: { feedbackId, executionId: input.executionId }
            }
          );
        }
        if (input.comment !== undefined) {
          if (input.comment === null) {
            await client.query(
              `update encrypted_field_payloads
               set invalidated_at = now(), updated_at = now()
               where source_table = 'managed_conversation_recall_feedback'
                 and source_id = $1 and source_column = 'comment_marker'
                 and invalidated_at is null`,
              [feedbackId]
            );
          } else {
            await upsertEncryptedFieldPayloadWithClient(
              client,
              actor,
              options.envelopeEncryptionProvider,
              {
                sourceTable: "managed_conversation_recall_feedback",
                sourceId: feedbackId,
                sourceColumn: "comment_marker",
                plaintext: input.comment,
                visibility: "personal",
                rowFamily: "managed_conversation_recall_feedback",
                scope: {
                  tenantId: actor.userId,
                  objectClass: "managed_conversation_recall_feedback"
                },
                aad: { feedbackId, executionId: input.executionId }
              }
            );
          }
        }
        await client.query("commit");
        committed = true;
        return mapFeedback(actor, row);
      } catch (error) {
        if (!committed) await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
  };
};
