import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { RemoteMcpOAuthStore, RemoteMcpOAuthCredential } from "@koed/db";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier
} from "@modelcontextprotocol/server";

export const remoteMcpScopes = [
  "koed:memory:read",
  "koed:capture",
  "koed:local-execution",
  "koed:team:read"
] as const;
export const remoteMcpAccessTokenPrefix = "koed_mcp_access_";
export class DelegatedAuthenticationError extends Error {
  constructor(
    readonly statusCode: 401 | 429 | 503,
    readonly retryAfterMs?: number
  ) {
    super("Delegated access is unavailable");
    this.name = "DelegatedAuthenticationError";
  }
}
const accessTtlMs = 15 * 60_000;
export const remoteMcpGrantTtlMs = 30 * 24 * 60 * 60_000;
const grantTtlMs = remoteMcpGrantTtlMs;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

export interface RemoteMcpDelegatedPrincipal {
  readonly userId: string;
  readonly grantId: string;
  readonly clientId: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  readonly teamBoundaryId?: string | null;
}

export const createRemoteMcpOAuthProvider = (options: {
  store: RemoteMcpOAuthStore;
  resourceUrl: URL;
  consentPath?: string;
  now?: () => Date;
}) => {
  const { store } = options;
  const resource = options.resourceUrl.toString();
  const now = options.now ?? (() => new Date());
  const requireResource = (requested: URL | undefined) => {
    if (!requested || requested.toString() !== resource)
      throw new InvalidRequestError(
        "The resource must identify this MCP Server"
      );
  };
  const requireScopes = (scopes: string[]) => {
    if (
      !scopes.length ||
      scopes.some(
        (scope) => !(remoteMcpScopes as readonly string[]).includes(scope)
      )
    )
      throw new InvalidScopeError("Unsupported delegated scope");
    return [...new Set(scopes)];
  };
  const tokens = (time: Date) => {
    const access = `${remoteMcpAccessTokenPrefix}${secret()}`;
    const refresh = secret();
    const credentials: RemoteMcpOAuthCredential[] = [
      {
        hash: digest(access),
        kind: "access",
        expiresAt: new Date(time.getTime() + accessTtlMs),
        data: { scopes: [] }
      },
      {
        hash: digest(refresh),
        kind: "refresh",
        expiresAt: new Date(time.getTime() + grantTtlMs),
        data: { scopes: [] }
      }
    ];
    return { access, refresh, credentials };
  };
  const resolvePrincipal = async (
    token: string
  ): Promise<RemoteMcpDelegatedPrincipal> => {
    const record = await store.getAccess(digest(token), now());
    if (!record || record.grant.resource !== resource)
      throw new OAuthError(
        OAuthErrorCode.InvalidToken,
        "Invalid delegated access token"
      );
    return Object.freeze({
      userId: record.grant.userId,
      grantId: record.grant.id,
      clientId: record.grant.clientId,
      resource,
      scopes: Object.freeze([...record.scopes]),
      expiresAt: Math.floor(record.expiresAt.getTime() / 1000)
    });
  };
  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token) {
      const principal = await resolvePrincipal(token);
      return {
        token,
        clientId: principal.clientId,
        scopes: [...principal.scopes],
        expiresAt: principal.expiresAt,
        resource: new URL(resource),
        extra: { userId: principal.userId, grantId: principal.grantId }
      };
    }
  };
  const provider: OAuthServerProvider = {
    clientsStore: {
      async getClient(id) {
        return (await store.getClient(id)) as unknown as
          | OAuthClientInformationFull
          | undefined;
      },
      async registerClient(input) {
        if (input.token_endpoint_auth_method !== "none" || input.client_secret)
          throw new InvalidClientMetadataError(
            "Only public PKCE clients are supported"
          );
        for (const uri of input.redirect_uris) {
          const parsed = new URL(uri);
          if (
            parsed.hash ||
            parsed.username ||
            parsed.password ||
            (parsed.protocol !== "https:" &&
              !(
                parsed.protocol === "http:" &&
                ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
              ))
          )
            throw new InvalidClientMetadataError(
              "A secure or loopback redirect URI is required"
            );
        }
        if (
          input.grant_types?.some(
            (grant) => !["authorization_code", "refresh_token"].includes(grant)
          ) ||
          input.response_types?.some((response) => response !== "code")
        )
          throw new InvalidClientMetadataError(
            "Only authorization code and refresh grants are supported"
          );
        if (input.scope) requireScopes(input.scope.split(" "));
        const client = {
          ...input,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(now().getTime() / 1000),
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"]
        };
        await store.registerClient(
          client.client_id,
          client as unknown as Record<string, unknown>
        );
        return client;
      }
    },
    async authorize(client, params, response) {
      requireResource(params.resource);
      const scopes = requireScopes(
        params.scopes?.length ? params.scopes : ["koed:memory:read"]
      );
      if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge))
        throw new InvalidRequestError("Invalid S256 code challenge");
      const requestSecret = secret();
      await store.createRequest(
        digest(requestSecret),
        {
          clientId: client.client_id,
          redirectUri: params.redirectUri,
          resource,
          scopes,
          codeChallenge: params.codeChallenge,
          state: params.state
        },
        new Date(now().getTime() + 10 * 60_000)
      );
      const consent = new URL(
        options.consentPath ?? "/auth/mcp/authorize",
        options.resourceUrl
      );
      consent.searchParams.set("request", requestSecret);
      response.redirect(302, consent.toString());
    },
    async challengeForAuthorizationCode(client, authorizationCode) {
      const record = await store.getCode(
        digest(authorizationCode),
        client.client_id,
        now()
      );
      if (!record?.data.codeChallenge || record.grant.resource !== resource)
        throw new InvalidGrantError("Invalid authorization code");
      return record.data.codeChallenge;
    },
    async exchangeAuthorizationCode(
      client,
      authorizationCode,
      _verifier,
      redirectUri,
      requestedResource
    ) {
      requireResource(requestedResource);
      const time = now();
      const issued = tokens(time);
      const record = await store.exchange({
        kind: "code",
        hash: digest(authorizationCode),
        clientId: client.client_id,
        resource,
        redirectUri,
        credentials: issued.credentials,
        now: time
      });
      if (!record) throw new InvalidGrantError("Invalid authorization code");
      return {
        access_token: issued.access,
        refresh_token: issued.refresh,
        token_type: "Bearer",
        expires_in: Math.min(
          accessTtlMs / 1000,
          Math.floor((record.grant.expiresAt.getTime() - time.getTime()) / 1000)
        ),
        scope: record.scopes.join(" ")
      };
    },
    async exchangeRefreshToken(
      client,
      refreshToken,
      scopes,
      requestedResource
    ) {
      requireResource(requestedResource);
      if (scopes) requireScopes(scopes);
      const time = now();
      const issued = tokens(time);
      const record = await store.exchange({
        kind: "refresh",
        hash: digest(refreshToken),
        clientId: client.client_id,
        resource,
        scopes,
        credentials: issued.credentials,
        now: time
      });
      if (!record) throw new InvalidGrantError("Invalid refresh token");
      return {
        access_token: issued.access,
        refresh_token: issued.refresh,
        token_type: "Bearer",
        expires_in: Math.min(
          accessTtlMs / 1000,
          Math.floor((record.grant.expiresAt.getTime() - time.getTime()) / 1000)
        ),
        scope: record.scopes.join(" ")
      };
    },
    async verifyAccessToken(token) {
      return verifier.verifyAccessToken(token);
    },
    async revokeToken(client, request) {
      await store.revoke(digest(request.token), client.client_id, now());
    }
  };
  return {
    provider,
    verifier,
    resolvePrincipal,
    listConnections: (userId: string, page = 0) =>
      store.listConnections(userId, resource, page * 50),
    updateConnection: (input: {
      userId: string;
      id: string;
      version: number;
      action: "disconnect" | "approve";
    }) => {
      const time = now();
      return store.updateConnection({
        ...input,
        resource,
        now: time,
        expiresAt: new Date(time.getTime() + grantTtlMs)
      });
    },
    pruneExpired: () => store.pruneExpired(now()),
    async getAuthorizationRequest(requestSecret: string) {
      const pending = await store.getRequest(digest(requestSecret), now());
      if (!pending || pending.request.resource !== resource) return null;
      const client = await store.getClient(pending.request.clientId);
      return {
        clientId: pending.request.clientId,
        clientName:
          typeof client?.client_name === "string"
            ? client.client_name
            : pending.request.clientId,
        resource,
        scopes: [...pending.request.scopes],
        expiresAt: pending.expiresAt.toISOString()
      };
    },
    // Only call after existing browser-session authentication and session-bound CSRF validation.
    async completeAuthorization(input: {
      requestSecret: string;
      userId: string;
      approved: boolean;
    }) {
      const time = now();
      const code = secret();
      const request = await store.completeRequest({
        hash: digest(input.requestSecret),
        userId: input.userId,
        approved: input.approved,
        grantId: randomUUID(),
        grantExpiresAt: new Date(time.getTime() + grantTtlMs),
        code: {
          hash: digest(code),
          kind: "code",
          expiresAt: new Date(time.getTime() + 5 * 60_000),
          data: { scopes: [] }
        },
        now: time
      });
      if (!request || request.resource !== resource)
        throw new InvalidGrantError(
          "Expired or consumed authorization request"
        );
      const redirect = new URL(request.redirectUri);
      redirect.searchParams.set(
        input.approved ? "code" : "error",
        input.approved ? code : "access_denied"
      );
      if (request.state !== undefined)
        redirect.searchParams.set("state", request.state);
      return { redirectUrl: redirect.toString() };
    }
  };
};

export type RemoteMcpOAuth = ReturnType<typeof createRemoteMcpOAuthProvider>;
