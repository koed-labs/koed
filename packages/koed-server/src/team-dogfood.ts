import { resolve } from "node:path";
import type { KoedServerPaths } from "./paths.js";
import { resolveActiveIntegrationApiToken } from "./credentials.js";
import { getProjectTeamWorkspaceLink } from "./project-team-workspace-links.js";

export interface TeamDogfoodFetchDeps {
  fetch?: typeof fetch;
}

export interface TeamDogfoodShareResult {
  ok: boolean;
  state: "shared" | "needs_attention";
  message: string;
  projectRoot: string;
  teamWorkspaceId?: string;
  backendId?: string | null;
  sessionId?: string;
  shareGrant?: unknown;
  error?: string;
}

const normalizeApiUrl = (value: string | undefined): string =>
  (value?.trim() || "http://localhost:3300").replace(/\/+$/, "");

const apiUrlFromEnvironment = (
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>
): string =>
  normalizeApiUrl(
    environment.MEMORY_API_URL ??
      environment.KOED_API_URL ??
      repoEnv.MEMORY_API_URL ??
      repoEnv.KOED_API_URL
  );

const sessionCookieFromEnvironment = (
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>
): string | null => {
  const raw =
    environment.KOED_TEAM_SESSION_COOKIE ??
    repoEnv.KOED_TEAM_SESSION_COOKIE ??
    environment.KOED_SESSION_COOKIE ??
    repoEnv.KOED_SESSION_COOKIE;
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith("cm_session=")
    ? trimmed
    : `cm_session=${encodeURIComponent(trimmed)}`;
};

const parseJsonResponse = async (
  response: Response
): Promise<Record<string, unknown>> =>
  (await response.json().catch(() => ({}))) as Record<string, unknown>;

const requestError = (
  fallback: string,
  payload: Record<string, unknown>,
  response: Response
): string =>
  typeof payload.error === "string"
    ? payload.error
    : `${fallback} (${response.status})`;

const sessionIdFromPayload = (
  payload: Record<string, unknown>,
  fallback: string
): string => {
  const session = payload.session;
  const sessionId =
    session && typeof session === "object"
      ? (session as { id?: unknown }).id
      : undefined;
  if (typeof sessionId !== "string") {
    throw new Error(fallback);
  }
  return sessionId;
};

const latestSessionIdForProject = async (input: {
  apiUrl: string;
  apiToken: string;
  projectRoot: string;
  fetch: typeof fetch;
}): Promise<string> => {
  const params = new URLSearchParams({ workspace_id: input.projectRoot });
  const response = await input.fetch(
    `${input.apiUrl}/v1/sessions/latest?${params.toString()}`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.apiToken}`
      }
    }
  );
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(
      requestError(
        "Could not find latest Personal Captured Session",
        payload,
        response
      )
    );
  }
  return sessionIdFromPayload(
    payload,
    "Latest Captured Session response did not include a session id."
  );
};

const verifySessionBelongsToProject = async (input: {
  apiUrl: string;
  apiToken: string;
  projectRoot: string;
  sessionId: string;
  fetch: typeof fetch;
}): Promise<void> => {
  const params = new URLSearchParams({ workspace_id: input.projectRoot });
  const response = await input.fetch(
    `${input.apiUrl}/v1/sessions/${encodeURIComponent(input.sessionId)}?${params.toString()}`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.apiToken}`
      }
    }
  );
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(
      requestError(
        "Selected Captured Session does not belong to mapped Project",
        payload,
        response
      )
    );
  }
  sessionIdFromPayload(
    payload,
    "Selected Captured Session response did not include a session id."
  );
};

export const shareProjectCapturedSession = async (
  paths: KoedServerPaths,
  input: {
    projectRoot: string;
    sessionId?: string;
  },
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>,
  deps: TeamDogfoodFetchDeps = {}
): Promise<TeamDogfoodShareResult> => {
  const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const projectRoot = resolve(input.projectRoot);
  const linkResult = getProjectTeamWorkspaceLink(paths, projectRoot);
  if (!linkResult.link) {
    return {
      ok: false,
      state: "needs_attention",
      projectRoot,
      message: linkResult.message,
      error: linkResult.message
    };
  }

  const apiUrl = apiUrlFromEnvironment(environment, repoEnv);
  const token = resolveActiveIntegrationApiToken(paths, environment, repoEnv);
  const sessionCookie = sessionCookieFromEnvironment(environment, repoEnv);
  if (!sessionCookie) {
    const message =
      "KOED_TEAM_SESSION_COOKIE is required to create a Team Workspace Share Grant. API Tokens cannot manage Team sharing.";
    return {
      ok: false,
      state: "needs_attention",
      projectRoot,
      teamWorkspaceId: linkResult.link.teamWorkspaceId,
      backendId: linkResult.link.backendId,
      message,
      error: message
    };
  }
  if (!token) {
    const message = input.sessionId
      ? "MEMORY_API_TOKEN is required to verify the selected Captured Session belongs to the mapped Project."
      : "MEMORY_API_TOKEN is required to locate the latest Personal Captured Session.";
    return {
      ok: false,
      state: "needs_attention",
      projectRoot,
      teamWorkspaceId: linkResult.link.teamWorkspaceId,
      backendId: linkResult.link.backendId,
      message,
      error: message
    };
  }

  try {
    const sessionId =
      input.sessionId ??
      (await latestSessionIdForProject({
        apiUrl,
        apiToken: token.token,
        projectRoot,
        fetch: fetchImpl
      }));
    await verifySessionBelongsToProject({
      apiUrl,
      apiToken: token.token,
      projectRoot,
      sessionId,
      fetch: fetchImpl
    });
    const response = await fetchImpl(
      `${apiUrl}/v1/team-workspaces/${encodeURIComponent(
        linkResult.link.teamWorkspaceId
      )}/session-share-grants`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          cookie: sessionCookie
        },
        body: JSON.stringify({ sessionId })
      }
    );
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(
        requestError(
          "Could not create Team Workspace Share Grant",
          payload,
          response
        )
      );
    }
    return {
      ok: true,
      state: "shared",
      projectRoot,
      teamWorkspaceId: linkResult.link.teamWorkspaceId,
      backendId: linkResult.link.backendId,
      sessionId,
      shareGrant: payload.shareGrant,
      message: "Captured Session shared to Team Workspace."
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      state: "needs_attention",
      projectRoot,
      teamWorkspaceId: linkResult.link.teamWorkspaceId,
      backendId: linkResult.link.backendId,
      message,
      error: message
    };
  }
};
