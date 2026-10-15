import type { DeploymentProfile } from "../server/capabilities.js";
import { supportsWorkos } from "../server/capabilities.js";
import { remoteMcpScopes } from "./remote-mcp-oauth.js";

export const workosAgentScopes = remoteMcpScopes;

export interface WorkosAgentRegistrationConfig {
  issuer: string;
  allowedOrganizationIds: readonly string[];
  allowedScopes: readonly (typeof workosAgentScopes)[number][];
  requestsPerMinute: number;
}

export const resolveWorkosAgentRegistrationConfig = (
  environment: NodeJS.ProcessEnv,
  prerequisites: {
    remoteMcpEnabled: boolean;
    deploymentProfile: DeploymentProfile;
  }
): WorkosAgentRegistrationConfig | undefined => {
  const enabled = environment.WORKOS_AGENT_REGISTRATION_ENABLED?.trim();
  if (enabled === undefined || enabled === "false") return undefined;
  if (enabled !== "true")
    throw new Error("WORKOS_AGENT_REGISTRATION_ENABLED must be true or false");
  if (
    !prerequisites.remoteMcpEnabled ||
    !supportsWorkos(prerequisites.deploymentProfile) ||
    environment.WORKOS_AUTHKIT_ENABLED !== "true"
  )
    throw new Error(
      "WorkOS Agent Registration requires remote MCP and supported WorkOS AuthKit sign-in"
    );
  if (environment.WORKOS_AGENT_REGISTRATION_FREE_TIER_CONFIRMED !== "true")
    throw new Error(
      "Confirm WorkOS Agent Registration free-tier entitlement before enabling it"
    );
  if (
    !environment.WORKOS_API_KEY?.trim() ||
    !environment.WORKOS_CLIENT_ID?.trim() ||
    !environment.WORKOS_REDIRECT_URI?.trim()
  )
    throw new Error(
      "WorkOS Agent Registration requires the existing AuthKit credentials and callback"
    );
  let issuer: URL;
  try {
    issuer = new URL(environment.WORKOS_AGENT_REGISTRATION_ISSUER_URL ?? "");
  } catch {
    throw new Error(
      "WORKOS_AGENT_REGISTRATION_ISSUER_URL must be a default HTTPS AuthKit origin"
    );
  }
  if (
    issuer.protocol !== "https:" ||
    !issuer.hostname.endsWith(".authkit.app") ||
    issuer.pathname !== "/" ||
    issuer.port ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash
  )
    throw new Error(
      "WORKOS_AGENT_REGISTRATION_ISSUER_URL must be a default HTTPS AuthKit origin"
    );
  const allowedOrganizationIds = [
    ...new Set(
      (environment.WORKOS_AGENT_REGISTRATION_ALLOWED_ORGANIZATIONS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ];
  if (
    !allowedOrganizationIds.length ||
    allowedOrganizationIds.length > 100 ||
    allowedOrganizationIds.some((id) => !/^org_[A-Za-z0-9_]{1,100}$/.test(id))
  )
    throw new Error(
      "Configure 1-100 explicit WorkOS Agent Registration organisation IDs"
    );
  const allowedScopes = [
    ...new Set(
      (environment.WORKOS_AGENT_REGISTRATION_SCOPES ?? "koed:memory:read")
        .split(/[\s,]+/)
        .filter(Boolean)
    )
  ];
  if (
    !allowedScopes.includes("koed:memory:read") ||
    allowedScopes.some(
      (scope) => !(workosAgentScopes as readonly string[]).includes(scope)
    )
  )
    throw new Error(
      "WorkOS Agent Registration scopes must include Personal read and use only supported Koed scopes"
    );
  const budget =
    environment.WORKOS_AGENT_REGISTRATION_REQUESTS_PER_MINUTE ?? "120";
  const requestsPerMinute = Number(budget);
  if (
    !/^\d+$/.test(budget) ||
    !Number.isSafeInteger(requestsPerMinute) ||
    requestsPerMinute < 1 ||
    requestsPerMinute > 10_000
  )
    throw new Error(
      "WorkOS Agent Registration request budget must be 1-10000 per minute"
    );
  return {
    issuer: issuer.origin,
    allowedOrganizationIds,
    allowedScopes:
      allowedScopes as WorkosAgentRegistrationConfig["allowedScopes"],
    requestsPerMinute
  };
};
