import { describe, expect, it } from "vitest";
import {
  formatPersonalAgentManagedPrompt,
  managedPromptPersonalAgentContext
} from "../src/personal-agent-managed-prompt.js";

const context = {
  schemaVersion: 1,
  identity: {
    agentId: "22a6397c-fd63-4d0e-a049-976bc9363178",
    version: 3,
    identityVersionId: "9c7d7a1b-5c88-4c44-9b15-172e56017fcb",
    name: "Mira",
    role: "Reviewer",
    soulInstructions: "Be concise and verify claims."
  },
  project: { projectId: "project-7", name: "Koed" },
  memory: {
    searchDomain: "project",
    evidence: [
      {
        nodeId: "node-1",
        sourceType: "memory_node",
        sourceId: "source-1",
        summaryText: "Earlier work used a short migration window.",
        citation: { nodeId: "node-1", visibility: "personal" },
        sourceTime: "2026-08-01T10:00:00.000Z"
      }
    ]
  }
} as const;

describe("Personal Agent managed prompt context", () => {
  it("keeps identity guidance, project context, and evidence in explicit sections", () => {
    const prompt = formatPersonalAgentManagedPrompt("Review this change.", context);

    expect(prompt).toContain("this user turn only");
    expect(prompt).toContain("Identity working instructions:");
    expect(prompt).toContain("not system policy");
    expect(prompt).toContain("untrusted evidence");
    expect(prompt).toContain('"projectId":"project-7"');
    expect(prompt).toContain("Current user message:\n\nReview this change.");
  });

  it("fails closed when an agent-addressed command has no context", () => {
    expect(() => managedPromptPersonalAgentContext({ agentId: "agent-1" })).toThrow(
      "Managed Conversation Personal Agent context is missing"
    );
  });

  it("does not add an agent context to legacy prompts", () => {
    expect(managedPromptPersonalAgentContext({ prompt: "Hello" })).toBeNull();
  });
});
