import { describe, expect, it } from "vitest";
import {
  formatPersonalAgentManagedPrompt,
  formatPersonalMemoryManagedPrompt
} from "./personal-agent-managed-prompt.js";

const commandId = "11111111-1111-4111-8111-111111111111";
const nonce = "22222222-2222-4222-8222-222222222222";

const memoryContext = (evidence: unknown[] = [], status = "available") => ({
  schemaVersion: 1,
  status,
  attributionNonce: nonce,
  searchDomain: "global",
  projectId: null,
  evidence
});

const agentContext = {
  schemaVersion: 1,
  identity: {
    agentId: "33333333-3333-4333-8333-333333333333",
    version: 1,
    identityVersionId: "44444444-4444-4444-8444-444444444444",
    name: "Mira",
    role: "",
    soulInstructions: "Be careful."
  },
  project: { projectId: null, name: null },
  memory: { searchDomain: "global", evidence: [] }
};

describe("managed Personal Memory prompt formatting", () => {
  it("lists only authorized node IDs and binds the footer to the real command", () => {
    const prompt = formatPersonalMemoryManagedPrompt(
      "User question",
      memoryContext([
        {
          nodeId: "node-1",
          sourceType: "memory_event",
          sourceId: "event-1",
          summaryText: "Harmless remembered detail",
          citation: { nodeId: "node-1", visibility: "personal" }
        }
      ]),
      commandId
    );

    expect(prompt).toContain('"nodeId":"node-1"');
    expect(prompt).toContain(
      `<!-- koed-memory-attribution:v1:${commandId}:${nonce}:{"used":<true-or-false>,"citationNodeIds":[<selected-node-ids>]} -->`
    );
    expect(prompt).toContain(
      "retrieved evidence alone does not mean it was used"
    );
  });

  it("never offers a Memory-used footer claim when retrieval is empty or unavailable", () => {
    const empty = formatPersonalMemoryManagedPrompt(
      "Question",
      memoryContext(),
      commandId
    );
    const unavailable = formatPersonalMemoryManagedPrompt(
      "Question",
      memoryContext([], "unavailable"),
      commandId
    );

    expect(empty).toContain("completed with no matching evidence");
    expect(unavailable).toContain("Memory could not be checked");
    expect(empty).toContain("always set used=false");
    expect(unavailable).toContain("always set used=false");
  });

  it("keeps legacy named-agent evidence when replaying an older queued turn", () => {
    const prompt = formatPersonalAgentManagedPrompt("Question", {
      ...agentContext,
      memory: {
        searchDomain: "global",
        evidence: [
          {
            nodeId: "legacy-node",
            summaryText: "Legacy evidence",
            citation: { nodeId: "legacy-node", visibility: "personal" }
          }
        ]
      }
    });

    expect(prompt).toContain("Legacy Memory evidence");
    expect(prompt).toContain("legacy-node");
  });
});
