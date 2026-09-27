import { describe, expect, it } from "vitest";
import {
  canSubmitAgentIdentity,
  capabilitiesForModel,
  effortsForModel,
  generatedSoul,
  initialAgentIdentityEditorValues,
  modelLabel,
  modelOptions,
  preferredEffortForModel,
  soulAfterNameOrRoleChange,
  type AgentModelCapability
} from "./agentIdentityEditor";

const capabilities: AgentModelCapability[] = [
  {
    provider: "codex",
    id: "codex/gpt-5.6",
    displayName: "GPT-5.6",
    supportedReasoningEfforts: ["low", "high"]
  },
  {
    provider: "anthropic",
    id: "claude/sonnet",
    supportedReasoningEfforts: ["medium"]
  }
];

describe("agent identity editor", () => {
  it("generates only the initial soul draft", () => {
    const initial = initialAgentIdentityEditorValues({
      initialValues: { name: "Bob", role: "reviewer" }
    });
    expect(initial.soul).toBe(generatedSoul("Bob", "reviewer"));
    expect(
      soulAfterNameOrRoleChange(
        initial.soul,
        initial.soul,
        "Robert",
        "lead reviewer"
      )
    ).toBe(generatedSoul("Robert", "lead reviewer"));
    expect(
      soulAfterNameOrRoleChange(
        "Custom instructions",
        initial.soul,
        "Robert",
        "lead reviewer"
      )
    ).toBe("Custom instructions");
  });

  it("preserves an existing definition soul and avatar", () => {
    const avatar = { seed: 1, spec: {}, image: "data:image/png;base64,avatar" };
    expect(
      initialAgentIdentityEditorValues({
        definition: {
          id: "agent-1",
          ownerId: "you",
          name: "Bob",
          role: "reviewer",
          identity: "Custom soul",
          createdAt: 1,
          avatar
        }
      })
    ).toMatchObject({
      name: "Bob",
      role: "reviewer",
      soul: "Custom soul",
      avatar
    });
  });

  it("preserves template provenance when opening an identity editor", () => {
    const initial = initialAgentIdentityEditorValues({
      initialValues: {
        name: "Bob",
        role: "reviewer",
        soul: "An edited copy",
        sourceTemplateId: "code-reviewer",
        sourceTemplateVersion: 3
      }
    });
    expect(initial).toMatchObject({
      soul: "An edited copy",
      sourceTemplateId: "code-reviewer",
      sourceTemplateVersion: 3
    });
  });

  it("derives model and effort choices only from reported capabilities", () => {
    expect(modelLabel(capabilities[0]!)).toBe("GPT-5.6");
    expect(modelLabel(capabilities[1]!)).toBe("claude/sonnet");
    expect(capabilitiesForModel(capabilities, "codex:codex/gpt-5.6")).toBe(
      capabilities[0]
    );
    expect(effortsForModel(capabilities, "codex:codex/gpt-5.6")).toEqual([
      "low",
      "high"
    ]);
    expect(effortsForModel(capabilities, "missing")).toEqual([]);
    expect(
      preferredEffortForModel(capabilities, "codex:codex/gpt-5.6", "high")
    ).toBe("high");
    expect(
      preferredEffortForModel(capabilities, "codex:codex/gpt-5.6", "max")
    ).toBe("low");
    expect(modelOptions(capabilities, "missing")[0]).toEqual({
      id: "missing",
      label: "missing",
      available: false
    });
  });

  it("validates the fields required before submission", () => {
    expect(
      canSubmitAgentIdentity({ name: " Bob ", role: "reviewer", soul: "soul" })
    ).toBe(true);
    expect(
      canSubmitAgentIdentity({ name: " ", role: "reviewer", soul: "soul" })
    ).toBe(false);
    expect(
      canSubmitAgentIdentity({ name: "Bob", role: "reviewer", soul: " " })
    ).toBe(false);
  });
});
