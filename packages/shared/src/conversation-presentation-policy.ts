import { z } from "zod";

export const conversationPresentationModeSchema = z.enum([
  "expanded",
  "collapsed",
  "status",
  "hidden"
]);

export const conversationPresentationRendererSchema = z.enum([
  "message",
  "reasoning_summary",
  "tool_call",
  "tool_result",
  "approval",
  "user_input",
  "lifecycle",
  "telemetry",
  "generic"
]);

export const conversationPresentationDecisionSchema = z
  .object({
    mode: conversationPresentationModeSchema,
    renderer: conversationPresentationRendererSchema,
    policyKey: z.string().min(1).max(1_024).nullable(),
    policyRevision: z.number().int().safe().nonnegative(),
    reason: z.string().min(1).max(1_024)
  })
  .strict();

export type ConversationPresentationMode = z.infer<
  typeof conversationPresentationModeSchema
>;
export type ConversationPresentationRenderer = z.infer<
  typeof conversationPresentationRendererSchema
>;
export type ConversationPresentationDecision = z.infer<
  typeof conversationPresentationDecisionSchema
>;

export type ConversationPresentationPolicyRule = {
  sourceKind: string;
  sourceAdapterVersion: string;
  itemType: string;
  presentationMode: ConversationPresentationMode;
  rendererKind: ConversationPresentationRenderer;
  enabled: boolean;
};

export const normalizeConversationPresentationItemType = (
  value: string | null | undefined
): string => value?.trim().toLowerCase() ?? "";

export const conversationPresentationPolicyKey = (input: {
  sourceKind: string;
  sourceAdapterVersion: string;
  itemType: string;
}): string =>
  JSON.stringify([
    input.sourceKind,
    input.sourceAdapterVersion,
    normalizeConversationPresentationItemType(input.itemType)
  ]);

const hiddenDecision = (
  revision: number,
  reason: string
): ConversationPresentationDecision => ({
  mode: "hidden",
  renderer: "generic",
  policyKey: null,
  policyRevision: revision,
  reason
});

export const decideConversationItemPresentation = (input: {
  sourceKind: string;
  sourceAdapterVersion: string;
  lookupItemTypes: Iterable<string | null | undefined>;
  policyRevision: number;
  rules: ReadonlyMap<string, ConversationPresentationPolicyRule>;
}): ConversationPresentationDecision => {
  const itemTypes = [...input.lookupItemTypes]
    .map(normalizeConversationPresentationItemType)
    .filter(Boolean);
  for (const itemType of itemTypes) {
    const key = conversationPresentationPolicyKey({
      sourceKind: input.sourceKind,
      sourceAdapterVersion: input.sourceAdapterVersion,
      itemType
    });
    const rule = input.rules.get(key);
    if (!rule) continue;
    if (!rule.enabled) {
      return hiddenDecision(
        input.policyRevision,
        `presentation-policy-disabled:${itemType}`
      );
    }
    if (rule.presentationMode === "hidden") {
      return hiddenDecision(
        input.policyRevision,
        `presentation-policy-hidden:${itemType}`
      );
    }
    return {
      mode: rule.presentationMode,
      renderer: rule.rendererKind,
      policyKey: itemType,
      policyRevision: input.policyRevision,
      reason: `presentation-policy:${itemType}`
    };
  }
  return hiddenDecision(
    input.policyRevision,
    `presentation-policy-missing:${itemTypes[0] ?? "unknown"}`
  );
};
