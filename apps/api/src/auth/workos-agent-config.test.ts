import { describe, expect, it } from "vitest";
import { resolveApiServerConfig } from "../server/config.js";

import { workosAgentTestEnvironment } from "../../test-fixtures/workos-agent-auth.js";

describe("WorkOS Agent Registration configuration", () => {
  it("defaults to disabled and enables read-only Personal access explicitly", () => {
    expect(resolveApiServerConfig({}).workos.agentRegistration).toBeUndefined();
    expect(
      resolveApiServerConfig(workosAgentTestEnvironment).workos
        .agentRegistration
    ).toEqual({
      issuer: "https://test-env.authkit.app",
      allowedOrganizationIds: ["org_test"],
      allowedScopes: ["koed:memory:read"],
      requestsPerMinute: 120
    });
  });
  it.each([
    { WORKOS_AGENT_REGISTRATION_ENABLED: "yes" },
    { KOED_REMOTE_MCP_ENABLED: "false" },
    { WORKOS_AUTHKIT_ENABLED: "false" },
    { KOED_DEPLOYMENT_PROFILE: "local_personal" },
    { WORKOS_AGENT_REGISTRATION_FREE_TIER_CONFIRMED: "false" },
    { WORKOS_API_KEY: "" },
    { WORKOS_CLIENT_ID: "" },
    { WORKOS_REDIRECT_URI: "" },
    { WORKOS_AGENT_REGISTRATION_ISSUER_URL: "http://test-env.authkit.app" },
    { WORKOS_AGENT_REGISTRATION_ISSUER_URL: "https://auth.example" },
    {
      WORKOS_AGENT_REGISTRATION_ISSUER_URL: "https://test-env.authkit.app/path"
    },
    {
      WORKOS_AGENT_REGISTRATION_ISSUER_URL:
        "https://user:secret@test-env.authkit.app"
    },
    { WORKOS_AGENT_REGISTRATION_ALLOWED_ORGANIZATIONS: "" },
    { WORKOS_AGENT_REGISTRATION_ALLOWED_ORGANIZATIONS: "*" },
    { WORKOS_AGENT_REGISTRATION_SCOPES: "koed:team:read" },
    { WORKOS_AGENT_REGISTRATION_REQUESTS_PER_MINUTE: "0" },
    { WORKOS_AGENT_REGISTRATION_REQUESTS_PER_MINUTE: "10001" },
    { WORKOS_AGENT_REGISTRATION_REQUESTS_PER_MINUTE: "12junk" }
  ])("rejects an unsafe configuration: %j", (override) => {
    expect(() =>
      resolveApiServerConfig({ ...workosAgentTestEnvironment, ...override })
    ).toThrow();
  });
  it("requires explicit configuration for capture and local execution", () => {
    expect(
      resolveApiServerConfig({
        ...workosAgentTestEnvironment,
        WORKOS_AGENT_REGISTRATION_SCOPES:
          "koed:memory:read,koed:capture,koed:local-execution"
      }).workos.agentRegistration?.allowedScopes
    ).toEqual(["koed:memory:read", "koed:capture", "koed:local-execution"]);
  });
  it("enables Team recall only with an explicit scope ceiling", () => {
    expect(
      resolveApiServerConfig({
        ...workosAgentTestEnvironment,
        WORKOS_AGENT_REGISTRATION_SCOPES: "koed:memory:read,koed:team:read"
      }).workos.agentRegistration?.allowedScopes
    ).toEqual(["koed:memory:read", "koed:team:read"]);
  });
});
