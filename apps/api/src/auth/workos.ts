import { z } from "zod";

export interface WorkosAuthKitConfig {
  apiBaseUrl: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

export interface WorkosAuthKitUser {
  id: string;
  email: string;
  emailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  profile: Record<string, unknown>;
}

export interface WorkosAuthKitAuthentication {
  user: WorkosAuthKitUser;
  organizationId: string | null;
}

export interface WorkosAuthKitClient {
  getAuthorizationUrl(input: { state: string }): string;
  authenticateWithCode(input: {
    code: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<WorkosAuthKitAuthentication>;
}

const required = (value: string | undefined, name: string): string => {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw Object.assign(new Error(`${name} is not configured`), {
      statusCode: 503
    });
  }
  return trimmed;
};

const workosUserSchema = z
  .object({
    id: z.string().min(1),
    email: z.string().email(),
    email_verified: z.boolean().optional(),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional()
  })
  .passthrough();

const workosAuthenticateResponseSchema = z
  .object({
    user: workosUserSchema,
    organization_id: z.string().nullable().optional()
  })
  .passthrough();

const displayNameForWorkosUser = (
  user: Pick<WorkosAuthKitUser, "firstName" | "lastName">
): string | null => {
  const parts = [user.firstName, user.lastName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" ") : null;
};

export const workosDisplayName = displayNameForWorkosUser;

export const createWorkosAuthKitClient = (
  config: WorkosAuthKitConfig,
  requestFetch: typeof fetch = globalThis.fetch.bind(globalThis)
): WorkosAuthKitClient => {
  const apiBaseUrl = config.apiBaseUrl.replace(/\/+$/, "");
  const clientId = () => required(config.clientId, "WORKOS_CLIENT_ID");
  const clientSecret = () => required(config.clientSecret, "WORKOS_API_KEY");
  const redirectUri = () => required(config.redirectUri, "WORKOS_REDIRECT_URI");

  return {
    getAuthorizationUrl(input) {
      const url = new URL("/user_management/authorize", apiBaseUrl);
      url.searchParams.set("client_id", clientId());
      url.searchParams.set("redirect_uri", redirectUri());
      url.searchParams.set("response_type", "code");
      url.searchParams.set("provider", "authkit");
      url.searchParams.set("state", input.state);
      return url.toString();
    },

    async authenticateWithCode(input) {
      const response = await requestFetch(
        `${apiBaseUrl}/user_management/authenticate`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            client_id: clientId(),
            client_secret: clientSecret(),
            grant_type: "authorization_code",
            code: input.code,
            ...(input.ipAddress ? { ip_address: input.ipAddress } : {}),
            ...(input.userAgent ? { user_agent: input.userAgent } : {})
          })
        }
      );

      if (!response.ok) {
        throw Object.assign(new Error("WorkOS authentication failed"), {
          statusCode: 401
        });
      }

      const parsed = workosAuthenticateResponseSchema.parse(
        await response.json()
      );
      const { user } = parsed;
      return {
        user: {
          id: user.id,
          email: user.email,
          emailVerified: user.email_verified ?? false,
          firstName: user.first_name ?? null,
          lastName: user.last_name ?? null,
          profile: {
            id: user.id,
            email: user.email,
            email_verified: user.email_verified ?? false,
            first_name: user.first_name ?? null,
            last_name: user.last_name ?? null
          }
        },
        organizationId: parsed.organization_id ?? null
      };
    }
  };
};
