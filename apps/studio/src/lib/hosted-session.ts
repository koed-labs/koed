export type HostedAuthProvider = "local" | "workos";

export type HostedUser = {
  id: string;
  email: string;
  displayName: string | null;
};

export type HostedWorkspace = {
  id: string;
  name: string;
  access: "read" | "write";
  lifecycle: string;
};

export type HostedMember = {
  id: string;
  name: string | null;
  status: string;
};

export type HostedTeam = {
  id: string;
  name: string;
  membership: {
    userId: string;
    role: string;
    status: string;
  };
  workspaces: HostedWorkspace[];
  members: HostedMember[];
};

export const selectHostedTeamId = (
  teams: HostedTeam[],
  requestedTeamId: string | null
): string | null =>
  teams.find((team) => team.id === requestedTeamId)?.id ?? teams[0]?.id ?? null;

export type HostedSessionResult =
  | { status: "signed_out"; providers: HostedAuthProvider[] }
  | { status: "authenticated"; user: HostedUser; teams: HostedTeam[] }
  | {
      status: "revoked";
      user: HostedUser;
      providers: HostedAuthProvider[];
      message: string;
    }
  | { status: "session_changed"; message: string }
  | { status: "unavailable"; user?: HostedUser; message: string };

export class HostedRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HostedRequestError";
    this.status = status;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const requestJson = async (
  path: string,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch
): Promise<unknown> => {
  const response = await fetcher(path, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: {
      accept: "application/json",
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init.headers
    }
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message =
      isRecord(body) && typeof body.error === "string"
        ? body.error
        : `Request failed with ${response.status}`;
    throw new HostedRequestError(message, response.status);
  }
  return body;
};

const parseUser = (payload: unknown): HostedUser | null => {
  if (!isRecord(payload) || !isRecord(payload.user)) return null;
  const user = payload.user;
  if (
    typeof user.id !== "string" ||
    typeof user.email !== "string" ||
    !(typeof user.displayName === "string" || user.displayName === null)
  ) {
    return null;
  }
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName
  };
};

const parseProviders = (payload: unknown): HostedAuthProvider[] => {
  if (
    !isRecord(payload) ||
    !isRecord(payload.auth) ||
    !Array.isArray(payload.auth.providers)
  ) {
    return [];
  }
  return payload.auth.providers.filter(
    (provider): provider is HostedAuthProvider =>
      provider === "local" || provider === "workos"
  );
};

const parseTeams = (payload: unknown): HostedTeam[] | null => {
  if (!isRecord(payload) || !Array.isArray(payload.teams)) return null;
  const teams: HostedTeam[] = [];
  for (const item of payload.teams) {
    if (
      !isRecord(item) ||
      !isRecord(item.team) ||
      typeof item.team.id !== "string" ||
      typeof item.team.name !== "string" ||
      !isRecord(item.membership) ||
      typeof item.membership.userId !== "string" ||
      typeof item.membership.role !== "string" ||
      typeof item.membership.status !== "string" ||
      !Array.isArray(item.workspaces) ||
      !Array.isArray(item.members)
    ) {
      return null;
    }
    const workspaces: HostedWorkspace[] = [];
    for (const workspace of item.workspaces) {
      if (
        !isRecord(workspace) ||
        !isRecord(workspace.teamWorkspace) ||
        typeof workspace.teamWorkspace.id !== "string" ||
        typeof workspace.teamWorkspace.name !== "string" ||
        !isRecord(workspace.access) ||
        (workspace.access.access !== "read" &&
          workspace.access.access !== "write") ||
        typeof workspace.teamWorkspace.lifecycle !== "string"
      ) {
        return null;
      }
      workspaces.push({
        id: workspace.teamWorkspace.id,
        name: workspace.teamWorkspace.name,
        access: workspace.access.access,
        lifecycle: workspace.teamWorkspace.lifecycle
      });
    }
    const members: HostedMember[] = [];
    for (const member of item.members) {
      if (
        !isRecord(member) ||
        typeof member.userId !== "string" ||
        !(
          typeof member.displayName === "string" || member.displayName === null
        ) ||
        typeof member.status !== "string"
      ) {
        return null;
      }
      members.push({
        id: member.userId,
        name: member.displayName,
        status: member.status
      });
    }
    teams.push({
      id: item.team.id,
      name: item.team.name,
      membership: {
        userId: item.membership.userId,
        role: item.membership.role,
        status: item.membership.status
      },
      workspaces,
      members
    });
  }
  return teams;
};

export const loadHostedSession = async (
  fetcher: typeof fetch = fetch
): Promise<HostedSessionResult> => {
  let mePayload: unknown;
  try {
    mePayload = await requestJson("/me", {}, fetcher);
  } catch (error) {
    if (error instanceof HostedRequestError && error.status === 401) {
      try {
        const capabilities = await requestJson("/v1/capabilities", {}, fetcher);
        return {
          status: "signed_out",
          providers: parseProviders(capabilities)
        };
      } catch {
        return {
          status: "unavailable",
          message:
            "Studio could not check the available sign-in methods. Retry to connect."
        };
      }
    }
    return {
      status: "unavailable",
      message:
        "Studio could not connect to Koed. Check your connection and retry."
    };
  }

  const user = parseUser(mePayload);
  if (!user) {
    return {
      status: "unavailable",
      message: "Koed returned an invalid session response. Retry to connect."
    };
  }

  try {
    const navigation = await requestJson("/v1/teams/navigation", {}, fetcher);
    if (
      !isRecord(navigation) ||
      !isRecord(navigation.principal) ||
      navigation.principal.id !== user.id
    ) {
      return {
        status: "session_changed",
        message:
          "The signed-in account changed while Team navigation was loading. Refresh to load the current session."
      };
    }
    const teams = parseTeams(navigation);
    if (!teams) {
      return {
        status: "unavailable",
        user,
        message:
          "Koed returned invalid Team navigation. Retry to load it again."
      };
    }
    return { status: "authenticated", user, teams };
  } catch (error) {
    if (
      error instanceof HostedRequestError &&
      (error.status === 401 || error.status === 403)
    ) {
      return {
        status: "revoked",
        user,
        providers: await loadAuthProviders(fetcher),
        message:
          "This session expired or Team access changed. Sign in again to continue."
      };
    }
    return {
      status: "unavailable",
      user,
      message: "Team navigation is temporarily unavailable. Retry to connect."
    };
  }
};

const loadAuthProviders = async (
  fetcher: typeof fetch
): Promise<HostedAuthProvider[]> => {
  try {
    return parseProviders(await requestJson("/v1/capabilities", {}, fetcher));
  } catch {
    return [];
  }
};

export const signInWithLocalSession = async (
  email: string,
  password: string,
  fetcher: typeof fetch = fetch
): Promise<void> => {
  await requestJson(
    "/auth/login",
    { method: "POST", body: JSON.stringify({ email, password }) },
    fetcher
  );
};

export const signInAndLoadHostedSession = async (
  email: string,
  password: string,
  onSessionLoadStart: () => number,
  fetcher: typeof fetch = fetch
): Promise<{ requestSequence: number; result: HostedSessionResult }> => {
  await signInWithLocalSession(email, password, fetcher);
  const requestSequence = onSessionLoadStart();
  const result = await loadHostedSession(fetcher);
  return { requestSequence, result };
};

export const hostedWorkosLoginUrl = (returnTo: string): string =>
  `/auth/workos/login?return_to=${encodeURIComponent(returnTo)}`;
