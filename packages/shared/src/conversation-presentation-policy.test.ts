import { describe, expect, it } from "vitest";

import {
  conversationPresentationPolicyKey,
  decideConversationItemPresentation,
  type ConversationPresentationPolicyRule
} from "./conversation-presentation-policy.js";

const rules = (
  entries: ConversationPresentationPolicyRule[]
): Map<string, ConversationPresentationPolicyRule> =>
  new Map(
    entries.map((rule) => [conversationPresentationPolicyKey(rule), rule])
  );

describe("Conversation Item Presentation policy", () => {
  it("renders an explicitly classified operational item without semantic assumptions", () => {
    const decision = decideConversationItemPresentation({
      sourceKind: "managed_runtime",
      sourceAdapterVersion: "managed-runtime-v1",
      lookupItemTypes: ["file_approval"],
      policyRevision: 7,
      rules: rules([
        {
          sourceKind: "managed_runtime",
          sourceAdapterVersion: "managed-runtime-v1",
          itemType: "file_approval",
          presentationMode: "expanded",
          rendererKind: "approval",
          enabled: true
        }
      ])
    });

    expect(decision).toEqual({
      mode: "expanded",
      renderer: "approval",
      policyKey: "file_approval",
      policyRevision: 7,
      reason: "presentation-policy:file_approval"
    });
  });

  it.each(["reasoning_raw", "unknown_future_record"])(
    "fails closed for %s when no visible rule applies",
    (itemType) => {
      expect(
        decideConversationItemPresentation({
          sourceKind: "codex",
          sourceAdapterVersion: "codex-transcript-v1",
          lookupItemTypes: [itemType],
          policyRevision: 2,
          rules: new Map()
        })
      ).toMatchObject({
        mode: "hidden",
        renderer: "generic",
        policyKey: null
      });
    }
  );

  it("honors role-refined lookup order", () => {
    const policyRules = rules([
      {
        sourceKind: "codex",
        sourceAdapterVersion: "codex-transcript-v1",
        itemType: "developer_message",
        presentationMode: "hidden",
        rendererKind: "generic",
        enabled: true
      },
      {
        sourceKind: "codex",
        sourceAdapterVersion: "codex-transcript-v1",
        itemType: "message",
        presentationMode: "expanded",
        rendererKind: "message",
        enabled: true
      }
    ]);

    expect(
      decideConversationItemPresentation({
        sourceKind: "codex",
        sourceAdapterVersion: "codex-transcript-v1",
        lookupItemTypes: ["developer_message", "message"],
        policyRevision: 4,
        rules: policyRules
      })
    ).toMatchObject({
      mode: "hidden",
      reason: "presentation-policy-hidden:developer_message"
    });
  });
});
