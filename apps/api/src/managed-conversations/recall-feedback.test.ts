import { describe, expect, it, vi } from "vitest";
import { personalMemoryAttributionFooter } from "@koed/shared";
import {
  resolveManagedRecallFeedbackTarget,
  verifiedRecallFeedbackAttribution
} from "./recall-feedback.js";

const commandId = "11111111-1111-4111-8111-111111111111";
const nonce = "22222222-2222-4222-8222-222222222222";

const context = {
  schemaVersion: 1 as const,
  status: "available" as const,
  attributionNonce: nonce,
  searchDomain: "global" as const,
  projectId: null,
  evidence: [
    {
      nodeId: "stored-node",
      summaryText: "must not be copied into feedback",
      citation: {},
      visibility: "personal" as const
    }
  ]
};

const answer = (used: boolean, citationNodeIds: string[]) =>
  `Answer\n${personalMemoryAttributionFooter({
    commandId,
    nonce,
    attribution: { used, citationNodeIds }
  })}`;

describe("managed recall feedback attribution", () => {
  it("accepts a valid Memory-used footer with no resolved citations", () => {
    const result = verifiedRecallFeedbackAttribution(
      answer(true, ["not-in-context"]),
      commandId,
      context
    );

    expect(result?.selectedEvidence).toEqual([]);
    expect(result?.sourceReferences).toEqual([]);
    expect(result?.sourceAssociationHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("associates only stored context evidence named by the bound footer", () => {
    const result = verifiedRecallFeedbackAttribution(
      answer(true, ["stored-node"]),
      commandId,
      context
    );

    expect(result?.sourceReferences).toEqual([
      {
        nodeId: "stored-node",
        sourceType: "memory_node",
        sourceId: null,
        sourceChunkIndex: null,
        visibility: "personal",
        teamWorkspaceId: null
      }
    ]);
  });

  it("rejects false, wrong-command, wrong-nonce, and unavailable context", () => {
    expect(
      verifiedRecallFeedbackAttribution(answer(false, []), commandId, context)
    ).toBeNull();
    expect(
      verifiedRecallFeedbackAttribution(
        answer(true, ["stored-node"]),
        "33333333-3333-4333-8333-333333333333",
        context
      )
    ).toBeNull();
    expect(
      verifiedRecallFeedbackAttribution(
        answer(true, ["stored-node"]),
        commandId,
        {
          ...context,
          attributionNonce: "44444444-4444-4444-8444-444444444444"
        }
      )
    ).toBeNull();
    expect(
      verifiedRecallFeedbackAttribution(answer(true, []), commandId, {
        ...context,
        status: "unavailable" as const,
        evidence: []
      })
    ).toBeNull();
  });

  it("requires the owner-visible execution before looking up a persisted answer", async () => {
    const getManagedConversationCommand = vi.fn();
    const target = await resolveManagedRecallFeedbackTarget(
      {
        getManagedConversationExecution: vi.fn().mockResolvedValue(null),
        getManagedConversationCommand
      } as never,
      { userId: "owner" },
      "33333333-3333-4333-8333-333333333333",
      "provider",
      commandId
    );

    expect(target).toBeNull();
    expect(getManagedConversationCommand).not.toHaveBeenCalled();
  });
});
