import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Agent } from "@koed/shared/agent-contract";
import { resolveAgentMention } from "./agent-delegation-intent.js";

const agent = (name: string, chief = false): Agent => ({
  id: randomUUID(),
  ownerUserId: randomUUID(),
  name,
  role: null,
  look: {},
  aiClientInstanceId: "codex.default",
  defaultPermissionMode: "supervised",
  defaultModel: null,
  isChiefOfStaff: chief,
  createdAt: new Date().toISOString()
});

describe("private Helper Agent mention", () => {
  const chief = agent("Chief of Staff", true);
  const quinn = agent("Quinn");
  const nova = agent("Nova");
  it("binds only a leading exact Helper name and keeps the task text", () => {
    expect(
      resolveAgentMention("@Quinn fix lint errors", [chief, quinn, nova])
    ).toEqual({
      kind: "matched",
      agent: quinn,
      task: "fix lint errors"
    });
    expect(
      resolveAgentMention("Please ask @Quinn to fix lint", [chief, quinn])
    ).toEqual({ kind: "none" });
    expect(
      resolveAgentMention("@Chief of Staff do this", [chief, quinn])
    ).toMatchObject({ kind: "invalid" });
  });
  it("rejects unavailable, ambiguous, and empty mentions before any dispatch", () => {
    expect(resolveAgentMention("@Sage write notes", [quinn])).toMatchObject({
      kind: "invalid"
    });
    expect(resolveAgentMention("@Quinn", [quinn])).toMatchObject({
      kind: "invalid"
    });
    expect(
      resolveAgentMention("@Quinn X work", [quinn, agent("Quinn X")])
    ).toMatchObject({ kind: "invalid" });
  });
});
