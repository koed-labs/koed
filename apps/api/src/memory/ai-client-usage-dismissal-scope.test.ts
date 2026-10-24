import { describe, expect, it } from "vitest";
import { aiClientUsageDismissalScope } from "./ai-client-usage-dismissal-scope.js";

const binding = {
  instanceId: "codex.default",
  accountIdentityHash: "a".repeat(64),
  profileScopeHash: "profile-a",
  observedAt: "2026-10-24T08:00:00Z"
};

describe("usage dismissal scope projection", () => {
  it("survives a probe timestamp change but changes for owner, profile, or verified account binding", () => {
    const original = aiClientUsageDismissalScope("owner-a", "profile-a", [
      binding
    ]);
    expect(
      aiClientUsageDismissalScope("owner-a", "profile-a", [
        { ...binding, observedAt: "2026-10-24T09:00:00Z" }
      ])
    ).toBe(original);
    expect(
      aiClientUsageDismissalScope("owner-b", "profile-a", [binding])
    ).not.toBe(original);
    expect(
      aiClientUsageDismissalScope("owner-a", "profile-b", [
        { ...binding, profileScopeHash: "profile-b" }
      ])
    ).not.toBe(original);
    expect(
      aiClientUsageDismissalScope("owner-a", "profile-a", [
        { ...binding, accountIdentityHash: "b".repeat(64) }
      ])
    ).not.toBe(original);
    expect(
      aiClientUsageDismissalScope("owner-a", "profile-a", [
        { ...binding, accountIdentityHash: null }
      ])
    ).not.toBe(original);
    expect(original).toMatch(/^[0-9a-f]{64}$/);
    expect(original).not.toContain(binding.accountIdentityHash);
  });
});
