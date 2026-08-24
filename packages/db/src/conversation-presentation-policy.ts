import {
  conversationPresentationPolicyKey,
  type ConversationPresentationPolicyRule
} from "@koed/shared";
import type pg from "pg";

export type ConversationPresentationPolicySnapshot = {
  revision: number;
  rules: Map<string, ConversationPresentationPolicyRule>;
};

export const loadConversationPresentationPolicySnapshot = async (
  client: pg.Pool | pg.PoolClient
): Promise<ConversationPresentationPolicySnapshot> => {
  const [state, rows] = await Promise.all([
    client.query<{ revision: string }>(
      "select revision::text as revision from conversation_presentation_policy_state where id = 1"
    ),
    client.query<{
      source_kind: string;
      source_adapter_version: string;
      item_type: string;
      presentation_mode: ConversationPresentationPolicyRule["presentationMode"];
      renderer_kind: ConversationPresentationPolicyRule["rendererKind"];
      enabled: boolean;
    }>(
      `select source_kind, source_adapter_version, item_type,
              presentation_mode, renderer_kind, enabled
         from conversation_presentation_policy_rules`
    )
  ]);
  return {
    revision: Number(state.rows[0]?.revision ?? 0),
    rules: new Map(
      rows.rows.map((row) => {
        const rule: ConversationPresentationPolicyRule = {
          sourceKind: row.source_kind,
          sourceAdapterVersion: row.source_adapter_version,
          itemType: row.item_type,
          presentationMode: row.presentation_mode,
          rendererKind: row.renderer_kind,
          enabled: row.enabled
        };
        return [conversationPresentationPolicyKey(rule), rule];
      })
    )
  };
};

export const ownerVisibleApprovalPresentationSql = (
  alias: "ci"
): string => `exists (
  select 1
  from conversation_presentation_policy_rules presentation_rule
  where presentation_rule.source_kind = ${alias}.source_kind
    and presentation_rule.source_adapter_version = ${alias}.source_adapter_version
    and presentation_rule.item_type = coalesce(
      ${alias}.metadata #>> '{approvalActivity,kind}',
      case
        when ${alias}.metadata ? 'approvalReviewTranscriptDisplay'
          then 'approval_review_envelope'
        else 'approval_helper_conversation'
      end
    )
    and presentation_rule.enabled = true
    and presentation_rule.presentation_mode <> 'hidden'
    and presentation_rule.renderer_kind = 'approval'
)`;
