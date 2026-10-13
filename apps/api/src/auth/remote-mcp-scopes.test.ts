import { describe, expect, it } from "vitest";
import { delegatedScopeForRequest } from "./remote-mcp-scopes.js";

describe("delegated operation consent", () => {
  it.each([
    ["GET", "/v1/access/check", "koed:memory:read"],
    ["POST", "/v1/memory/answer-tasks", "koed:memory:read"],
    ["POST", "/v1/memory/answer-tasks/claim", "koed:local-execution"],
    ["POST", "/v1/memory/answer-tasks/task/complete", "koed:local-execution"],
    ["GET", "/v1/memory/answer-tasks/task", "koed:memory:read"],
    [
      "PUT",
      "/v1/memory/lcm/summary-claims/claim/renew",
      "koed:local-execution"
    ],
    ["POST", "/v1/memory/lcm/summaries/node", "koed:local-execution"],
    [
      "PUT",
      "/v1/memory/ai-client-instances/codex.default",
      "koed:local-execution"
    ],
    [
      "POST",
      "/v1/memory/ai-client-instances/codex.default/capability-snapshots",
      "koed:local-execution"
    ],
    ["POST", "/v1/conversation-source-artifacts", "koed:capture"],
    [
      "PUT",
      "/v1/conversation-source-artifacts/artifact/cursor",
      "koed:capture"
    ],
    ["GET", "/v1/team-context", "koed:team:read"]
  ])("maps %s %s to its required consent", (method, path, scope) => {
    expect(delegatedScopeForRequest(method, path)).toBe(scope);
  });

  it.each([
    ["POST", "/v1/historical-imports"],
    ["POST", "/v1/memory/ask/questions/recover-pending"],
    ["POST", "/v1/team-workspaces/workspace/members"],
    ["PUT", "/v1/memory/local-agent-settings/answer"],
    ["POST", "/auth/logout"],
    ["GET", "/v1/device-credentials"]
  ])("denies ungranted operation %s %s", (method, path) => {
    expect(delegatedScopeForRequest(method, path)).toBeUndefined();
  });
});
