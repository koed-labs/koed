export const workosAgentTestEnvironment = {
  NODE_ENV: "test",
  KOED_DEPLOYMENT_PROFILE: "team_self_hosted",
  KOED_REMOTE_MCP_ENABLED: "true",
  KOED_REMOTE_MCP_PUBLIC_URL: "https://memory.example/mcp",
  WORKOS_AUTHKIT_ENABLED: "true",
  WORKOS_API_KEY: "test-only-server-key",
  WORKOS_CLIENT_ID: "client_test",
  WORKOS_REDIRECT_URI: "https://memory.example/auth/workos/callback",
  WORKOS_PROVIDER_ENVIRONMENT: "staging",
  WORKOS_AGENT_REGISTRATION_ENABLED: "true",
  WORKOS_AGENT_REGISTRATION_FREE_TIER_CONFIRMED: "true",
  WORKOS_AGENT_REGISTRATION_ISSUER_URL: "https://test-env.authkit.app",
  WORKOS_AGENT_REGISTRATION_ALLOWED_ORGANIZATIONS: "org_test"
};
