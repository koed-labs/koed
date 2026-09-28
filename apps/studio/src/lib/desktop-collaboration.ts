import {
  collaborationSnapshotSchema,
  type CollaborationSnapshot
} from "@koed/shared/collaboration";

export type DesktopCollaborationConnectionState =
  | "disconnected"
  | "connecting"
  | "live"
  | "reconnecting"
  | "unavailable"
  | "access_revoked";

export type DesktopCollaborationTeam = {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  unreadCount: number;
  people: Array<{ id: string; displayName: string }>;
  workspaces: Array<{ id: string; name: string }>;
};

export type DesktopCollaborationSnapshot = {
  connection: {
    state: DesktopCollaborationConnectionState;
    backendId: string | null;
    connectedAt: string | null;
    retryAt: string | null;
    reconnectAttempt: number;
    protocolVersion: number;
  };
  teams: DesktopCollaborationTeam[];
};

export type DesktopCollaborationLoadResult =
  | { mode: "desktop"; snapshot: DesktopCollaborationSnapshot }
  | { mode: "preview" }
  | { mode: "unavailable" };

export type DesktopStudioCollaborationSession = {
  mode: "desktop";
  snapshot: CollaborationSnapshot;
  csrfToken: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const connectionStates = new Set<DesktopCollaborationConnectionState>([
  "disconnected",
  "connecting",
  "live",
  "reconnecting",
  "unavailable",
  "access_revoked"
]);

const parseSnapshot = (
  payload: unknown
): DesktopCollaborationSnapshot | null => {
  if (
    !isRecord(payload) ||
    !isRecord(payload.connection) ||
    !Array.isArray(payload.teams)
  ) {
    return null;
  }

  const rawConnection = payload.connection;
  if (
    typeof rawConnection.state !== "string" ||
    !connectionStates.has(
      rawConnection.state as DesktopCollaborationConnectionState
    ) ||
    !(
      typeof rawConnection.backendId === "string" ||
      rawConnection.backendId === null
    ) ||
    !(
      typeof rawConnection.connectedAt === "string" ||
      rawConnection.connectedAt === null
    ) ||
    !(
      typeof rawConnection.retryAt === "string" ||
      rawConnection.retryAt === null
    ) ||
    !Number.isSafeInteger(rawConnection.reconnectAttempt) ||
    (rawConnection.reconnectAttempt as number) < 0 ||
    !Number.isSafeInteger(rawConnection.protocolVersion) ||
    (rawConnection.protocolVersion as number) < 1
  ) {
    return null;
  }

  const teams: DesktopCollaborationTeam[] = [];
  for (const teamValue of payload.teams) {
    if (
      !isRecord(teamValue) ||
      typeof teamValue.id !== "string" ||
      typeof teamValue.name !== "string" ||
      !["owner", "admin", "member"].includes(String(teamValue.role)) ||
      !Number.isSafeInteger(teamValue.unreadCount) ||
      (teamValue.unreadCount as number) < 0 ||
      !Array.isArray(teamValue.people) ||
      !Array.isArray(teamValue.workspaces)
    ) {
      return null;
    }

    const people: DesktopCollaborationTeam["people"] = [];
    for (const person of teamValue.people) {
      if (
        !isRecord(person) ||
        typeof person.id !== "string" ||
        typeof person.displayName !== "string"
      ) {
        return null;
      }
      people.push({ id: person.id, displayName: person.displayName });
    }

    const workspaces: DesktopCollaborationTeam["workspaces"] = [];
    for (const workspace of teamValue.workspaces) {
      if (
        !isRecord(workspace) ||
        typeof workspace.id !== "string" ||
        typeof workspace.name !== "string"
      ) {
        return null;
      }
      workspaces.push({ id: workspace.id, name: workspace.name });
    }

    teams.push({
      id: teamValue.id,
      name: teamValue.name,
      role: teamValue.role as DesktopCollaborationTeam["role"],
      unreadCount: teamValue.unreadCount as number,
      people,
      workspaces
    });
  }

  return {
    connection: {
      state: rawConnection.state as DesktopCollaborationConnectionState,
      backendId: rawConnection.backendId as string | null,
      connectedAt: rawConnection.connectedAt as string | null,
      retryAt: rawConnection.retryAt as string | null,
      reconnectAttempt: rawConnection.reconnectAttempt as number,
      protocolVersion: rawConnection.protocolVersion as number
    },
    // Do not render stale Team navigation for a connection state that is no
    // longer authorized and live, even if a buggy gateway sends old entries.
    teams: rawConnection.state === "live" ? teams : []
  };
};

export async function loadDesktopCollaboration(
  fetcher: typeof fetch = fetch
): Promise<DesktopCollaborationLoadResult> {
  try {
    const response = await fetcher("/studio-api/collaboration/snapshot", {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin"
    });
    if (response.status === 404) return { mode: "preview" };
    if (!response.ok) return { mode: "unavailable" };

    const payload: unknown = await response.json();
    const snapshot = parseSnapshot(payload);
    return snapshot ? { mode: "desktop", snapshot } : { mode: "unavailable" };
  } catch {
    return { mode: "unavailable" };
  }
}

export async function loadDesktopStudioCollaborationSession(
  fetcher: typeof fetch = fetch
): Promise<DesktopStudioCollaborationSession | { mode: "unavailable" | "preview" }> {
  try {
    const response = await fetcher(
      "/studio-api/collaboration/studio-session",
      {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin"
      }
    );
    if (response.status === 404) return { mode: "preview" };
    if (!response.ok) return { mode: "unavailable" };
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { mode: "unavailable" };
    }
    const body = payload as { snapshot?: unknown; csrfToken?: unknown };
    const snapshot = collaborationSnapshotSchema.safeParse(body.snapshot);
    if (!snapshot.success || typeof body.csrfToken !== "string") {
      return { mode: "unavailable" };
    }
    return { mode: "desktop", snapshot: snapshot.data, csrfToken: body.csrfToken };
  } catch {
    return { mode: "unavailable" };
  }
}
