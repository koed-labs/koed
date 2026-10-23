import type { FastifyRequest } from "fastify";
import type { RemoteMcpDelegatedPrincipal } from "./remote-mcp-oauth.js";

type Scope =
  | "koed:memory:read"
  | "koed:capture"
  | "koed:local-execution"
  | "koed:team:read";

const rules: ReadonlyArray<{
  methods: readonly string[];
  path: RegExp;
  scope: Scope;
}> = [
  {
    methods: ["GET"],
    path: /^\/v1\/(access\/check|capabilities|capture-policy\/effective)$/,
    scope: "koed:memory:read"
  },
  {
    methods: ["GET"],
    path: /^\/v1\/memory\/(local-agent-settings|ai-client-instances|questions(?:\/[^/]+)?|graph\/overview)$/,
    scope: "koed:memory:read"
  },
  {
    methods: ["POST"],
    path: /^\/v1\/memory\/(search|answer)$/,
    scope: "koed:memory:read"
  },
  {
    methods: ["GET", "POST"],
    path: /^\/v1\/memory\/nodes\/[^/]+\/expand$/,
    scope: "koed:memory:read"
  },
  {
    methods: ["POST"],
    path: /^\/v1\/memory\/answer-tasks$/,
    scope: "koed:memory:read"
  },
  {
    methods: ["GET"],
    path: /^\/v1\/memory\/answer-tasks\/[^/]+$/,
    scope: "koed:memory:read"
  },
  {
    methods: ["POST"],
    path: /^\/v1\/memory\/answer-tasks\/[^/]+\/cancel$/,
    scope: "koed:memory:read"
  },
  { methods: ["POST"], path: /^\/v1\/sessions$/, scope: "koed:capture" },
  {
    methods: ["POST"],
    path: /^\/v1\/memory\/(capture-personal-event|conversation-items(?:\/(project|release|release-journal))?|curated\/proposals)$/,
    scope: "koed:capture"
  },
  {
    methods: ["GET"],
    path: /^\/v1\/memory\/conversation-items\/by-stable-identity$/,
    scope: "koed:capture"
  },
  {
    methods: ["GET", "POST", "PUT"],
    path: /^\/v1\/conversation-source-artifacts(?:\/(lookup|generations\/[^/]+(?:\/(components|finalize-source-set))?|[^/]+\/(segments(?:\/[^/]+\/content)?|finalize|successor|cursor)))?$/,
    scope: "koed:capture"
  },
  {
    methods: ["POST"],
    path: /^\/v1\/memory\/answer-tasks\/(claim|[^/]+\/(heartbeat|complete|fail))$/,
    scope: "koed:local-execution"
  },
  {
    methods: ["DELETE"],
    path: /^\/v1\/memory\/answer-tasks\/expired$/,
    scope: "koed:local-execution"
  },
  {
    methods: ["POST"],
    path: /^\/v1\/memory\/(questions\/final|token-usage|lcm\/summary-claims|session-titles\/[^/]+)$/,
    scope: "koed:local-execution"
  },
  {
    methods: ["PUT"],
    path: /^\/v1\/memory\/lcm\/summary-claims\/[^/]+\/renew$/,
    scope: "koed:local-execution"
  },
  {
    methods: ["GET"],
    path: /^\/v1\/memory\/session-titles\/pending$/,
    scope: "koed:local-execution"
  },
  {
    methods: ["POST", "PATCH"],
    path: /^\/v1\/memory\/(lcm\/summaries\/[^/]+|curated\/proposals\/(claim-pending|[^/]+\/review))$/,
    scope: "koed:local-execution"
  },
  {
    methods: ["PUT"],
    path: /^\/v1\/memory\/ai-client-instances\/[^/]+$/,
    scope: "koed:local-execution"
  },
  {
    methods: ["POST"],
    path: /^\/v1\/memory\/ai-client-instances\/[^/]+\/capability-snapshots$/,
    scope: "koed:local-execution"
  },
  {
    methods: ["PUT", "POST"],
    path: /^\/v1\/memory\/ai-client-instances\/[^/]+\/usage\/(account|snapshots|completions)$/,
    scope: "koed:local-execution"
  },
  { methods: ["GET"], path: /^\/v1\/team-context$/, scope: "koed:team:read" },
  {
    methods: ["GET"],
    path: /^\/v1\/team-workspaces\/[^/]+\/context$/,
    scope: "koed:team:read"
  }
];

export const delegatedScopeForRequest = (
  method: string,
  pathname: string
): Scope | undefined =>
  rules.find(
    (rule) => rule.methods.includes(method) && rule.path.test(pathname)
  )?.scope;

export const assertDelegatedRequestScope = (
  principal: RemoteMcpDelegatedPrincipal,
  request: Pick<FastifyRequest, "method" | "url">
): void => {
  const path = new URL(request.url, "http://koed.invalid").pathname;
  const required = delegatedScopeForRequest(request.method, path);
  if (!required || !principal.scopes.includes(required)) {
    throw Object.assign(
      new Error("Delegated credential is not allowed for this operation"),
      { statusCode: 403 }
    );
  }
};
