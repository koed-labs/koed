import { describe, expect, it } from "vitest";

import {
  personalAgentChatDeliveryStatusSchema,
  personalAgentChatSubmitSchema,
  type PersonalAgentChatLaunchSnapshot
} from "./personal-agent-chat-contract.js";

const firstAgent = "00000000-0000-4000-8000-000000000001";
const secondAgent = "00000000-0000-4000-8000-000000000002";
const device = "00000000-0000-4000-8000-000000000003";

const recipient = (
  agentId: string,
  provider = "codex",
  model = "test-model"
): PersonalAgentChatLaunchSnapshot => ({
  kind: "agent",
  agentId,
  agentVersion: 1,
  provider,
  aiClientInstanceId: `${provider}.default`,
  targetDeviceId: device,
  model,
  reasoningEffort: "high",
  permissionMode: "supervised",
  selectedResourceIds: []
});

const submission = (recipients: PersonalAgentChatLaunchSnapshot[]) => ({
  requestId: "00000000-0000-4000-8000-000000000004",
  text: "Build a page, then review the result.",
  context: {
    projectId: "project-test",
    contextKind: "project",
    targetDeviceId: device
  },
  recipients
});

describe("multi-Agent conversation submission contract", () => {
  it.each([
    ["same provider and model", "codex", "test-model"],
    ["same provider with different models", "codex", "another-model"],
    ["different providers", "claude", "claude-test"]
  ])(
    "accepts distinct Agents using %s without changing recipient order",
    (_, provider, model) => {
      const input = submission([
        recipient(secondAgent, provider, model),
        recipient(firstAgent)
      ]);
      const parsed = personalAgentChatSubmitSchema.parse(input);
      expect(parsed.recipients).toEqual(input.recipients);
      expect(parsed.text).toBe(input.text);
      expect(parsed.requestId).toBe(input.requestId);
    }
  );

  it("rejects invoking one identity twice even through different providers", () => {
    expect(
      personalAgentChatSubmitSchema.safeParse(
        submission([recipient(firstAgent), recipient(firstAgent, "claude")])
      ).success
    ).toBe(false);
  });

  it("preserves an unnamed respondent without adding an Agent identity", () => {
    const generic: PersonalAgentChatLaunchSnapshot = {
      ...recipient(firstAgent),
      kind: "generic",
      agentId: null,
      agentVersion: null
    };
    const parsed = personalAgentChatSubmitSchema.parse(submission([generic]));
    expect(parsed.recipients[0]).toMatchObject({
      kind: "generic",
      agentId: null,
      agentVersion: null
    });
    expect(
      personalAgentChatSubmitSchema.safeParse(
        submission([generic, recipient(firstAgent)])
      ).success
    ).toBe(false);
  });

  it("rejects a batch whose recipients could work on different devices", () => {
    const remote = {
      ...recipient(secondAgent),
      targetDeviceId: "00000000-0000-4000-8000-000000000005"
    };
    expect(
      personalAgentChatSubmitSchema.safeParse(
        submission([recipient(firstAgent), remote])
      ).success
    ).toBe(false);
  });

  it("does not accept raw private context from the composer", () => {
    expect(
      personalAgentChatSubmitSchema.safeParse({
        ...submission([recipient(firstAgent)]),
        personalMemoryContext: { evidence: ["unverified client-supplied text"] }
      }).success
    ).toBe(false);
    expect(
      personalAgentChatSubmitSchema.safeParse({
        ...submission([recipient(firstAgent)]),
        continueWithoutMemory: true
      }).success
    ).toBe(false);
    expect(
      personalAgentChatSubmitSchema.safeParse(
        submission([
          { ...recipient(firstAgent), soulInstructions: "Client override" }
        ] as PersonalAgentChatLaunchSnapshot[])
      ).success
    ).toBe(false);
  });

  it("keeps uncertain delivery distinct from confirmed failure and cancellation", () => {
    expect(
      ["uncertain", "failed", "canceled"].map((status) =>
        personalAgentChatDeliveryStatusSchema.parse(status)
      )
    ).toEqual(["uncertain", "failed", "canceled"]);
  });
});
