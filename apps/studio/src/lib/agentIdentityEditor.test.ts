import { describe, expect, it } from "vitest";
import {
  canSubmitAgentIdentity,
  capabilitiesForModel,
  createAgentIdentityDraftStore,
  effortsForModel,
  generatedSoul,
  initialAgentIdentityEditorValues,
  modelLabel,
  modelOptions,
  preferredEffortForModel,
  readAgentIdentityDraft,
  writeAgentIdentityDraft,
  clearAgentIdentityDraft,
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
  it("round-trips and clears a device-local profile draft", () => {
    const values = {
      name: "Draft Bob",
      role: "reviewer",
      soul: "Keep this private draft",
      avatar: {
        seed: 7,
        spec: { seed: 7 },
        image: "data:image/png;base64,bob"
      },
      preferredModel: "offline:model",
      preferredEffort: "high",
      sourceTemplateId: "reviewer",
      sourceTemplateVersion: 2
    };
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key)
    };

    writeAgentIdentityDraft(storage, "draft", values);
    expect(readAgentIdentityDraft(storage, "draft")).toEqual(values);
    clearAgentIdentityDraft(storage, "draft");
    expect(readAgentIdentityDraft(storage, "draft")).toBeNull();
  });

  it("ignores malformed device-local drafts", () => {
    const storage = {
      getItem: () => "{not-json",
      setItem: () => {},
      removeItem: () => {}
    };
    expect(readAgentIdentityDraft(storage, "draft")).toBeNull();
  });

  it("uses the encrypted Desktop bridge after authenticated scope hydration", async () => {
    const values = {
      name: "Draft Bob",
      role: "reviewer",
      soul: "Saved locally",
      preferredModel: "offline:model",
      preferredEffort: "high",
      sourceTemplateId: null,
      sourceTemplateVersion: null
    };
    const records = new Map<string, string>();
    const calls: string[] = [];
    const bridge = {
      read: async ({
        ownerId,
        executionId
      }: {
        ownerId: string;
        executionId: string;
      }) => {
        calls.push(`read:${ownerId}:${executionId}`);
        return records.get(`${ownerId}:${executionId}`) ?? null;
      },
      write: async ({
        ownerId,
        executionId,
        value
      }: {
        ownerId: string;
        executionId: string;
        value: string;
      }) => {
        calls.push(`write:${ownerId}:${executionId}`);
        records.set(`${ownerId}:${executionId}`, value);
      },
      delete: async ({
        ownerId,
        executionId
      }: {
        ownerId: string;
        executionId: string;
      }) => {
        calls.push(`delete:${ownerId}:${executionId}`);
        records.delete(`${ownerId}:${executionId}`);
      }
    };
    const storage = {
      getItem: () => {
        throw new Error("Desktop bridge should be preferred");
      },
      setItem: () => {
        throw new Error("Desktop bridge should be preferred");
      },
      removeItem: () => {
        throw new Error("Desktop bridge should be preferred");
      }
    };
    const input = {
      scope: { ownerId: "owner-1", backendId: "backend-1" },
      target: "edit:agent-1",
      storage,
      bridge
    };
    const store = createAgentIdentityDraftStore(input)!;
    expect(await store.hydrate()).toBeNull();
    await store.write(values);

    const afterRestart = createAgentIdentityDraftStore(input)!;
    expect(await afterRestart.hydrate()).toEqual(values);
    await afterRestart.clear();
    expect(await afterRestart.hydrate()).toBeNull();
    expect(calls).toEqual([
      "read:owner-1:agent-draft:edit:agent-1",
      "write:owner-1:agent-draft:edit:agent-1",
      "read:owner-1:agent-draft:edit:agent-1",
      "delete:owner-1:agent-draft:edit:agent-1",
      "read:owner-1:agent-draft:edit:agent-1"
    ]);
  });

  it("keeps browser drafts isolated by owner and backend", async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key)
    };
    const first = createAgentIdentityDraftStore({
      scope: { ownerId: "owner-a", backendId: "backend-a" },
      target: "create",
      storage,
      bridge: null
    })!;
    const otherOwner = createAgentIdentityDraftStore({
      scope: { ownerId: "owner-b", backendId: "backend-a" },
      target: "create",
      storage,
      bridge: null
    })!;
    await first.write({
      name: "Bob",
      role: "reviewer",
      soul: "Local only",
      preferredModel: null,
      preferredEffort: null,
      sourceTemplateId: null,
      sourceTemplateVersion: null
    });
    expect(await otherOwner.hydrate()).toBeNull();
    expect(
      await createAgentIdentityDraftStore({
        scope: { ownerId: "owner-a", backendId: "backend-a" },
        target: "create",
        storage,
        bridge: null
      })?.hydrate()
    ).toMatchObject({ name: "Bob" });
  });

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
