export interface StudioCollaborationSettingsSnapshot {
  connection: {
    state:
      | "disconnected"
      | "connecting"
      | "live"
      | "reconnecting"
      | "unavailable"
      | "access_revoked";
    backendId: string | null;
    connectedAt: string | null;
    retryAt: string | null;
    reconnectAttempt: number;
    protocolVersion: number;
  };
  teams: Array<{
    id: string;
    name: string;
    role: "owner" | "admin" | "member";
    unreadCount: number;
    people: Array<{ id: string; displayName: string }>;
    workspaces: Array<{ id: string; name: string }>;
  }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const parseSnapshot = (value: unknown): StudioCollaborationSettingsSnapshot => {
  if (
    !isRecord(value) ||
    !isRecord(value.connection) ||
    !Array.isArray(value.teams)
  )
    throw new Error("Studio could not read the backend connection status.");
  const connection = value.connection;
  if (
    ![
      "disconnected",
      "connecting",
      "live",
      "reconnecting",
      "unavailable",
      "access_revoked"
    ].includes(String(connection.state)) ||
    typeof connection.protocolVersion !== "number" ||
    typeof connection.reconnectAttempt !== "number" ||
    !(
      connection.backendId === null || typeof connection.backendId === "string"
    ) ||
    !(
      connection.connectedAt === null ||
      typeof connection.connectedAt === "string"
    ) ||
    !(connection.retryAt === null || typeof connection.retryAt === "string")
  )
    throw new Error("Studio could not read the backend connection status.");
  return {
    connection: connection as StudioCollaborationSettingsSnapshot["connection"],
    teams: value.teams.map((team) => {
      if (
        !isRecord(team) ||
        typeof team.id !== "string" ||
        typeof team.name !== "string" ||
        !["owner", "admin", "member"].includes(String(team.role)) ||
        typeof team.unreadCount !== "number" ||
        !Array.isArray(team.people) ||
        !Array.isArray(team.workspaces)
      )
        throw new Error("Studio could not read the backend connection status.");
      return {
        id: team.id,
        name: team.name,
        role: team.role as "owner" | "admin" | "member",
        unreadCount: team.unreadCount,
        people: team.people.map((person) => {
          if (
            !isRecord(person) ||
            typeof person.id !== "string" ||
            typeof person.displayName !== "string"
          )
            throw new Error(
              "Studio could not read the backend connection status."
            );
          return { id: person.id, displayName: person.displayName };
        }),
        workspaces: team.workspaces.map((workspace) => {
          if (
            !isRecord(workspace) ||
            typeof workspace.id !== "string" ||
            typeof workspace.name !== "string"
          )
            throw new Error(
              "Studio could not read the backend connection status."
            );
          return { id: workspace.id, name: workspace.name };
        })
      };
    })
  };
};

export class StudioCollaborationSettingsClient {
  private csrfToken: string | null = null;

  async load(): Promise<StudioCollaborationSettingsSnapshot> {
    const response = await fetch("/studio-api/collaboration/session", {
      headers: { accept: "application/json" },
      cache: "no-store"
    });
    const payload: unknown = await readJson(response);
    if (response.status === 404)
      throw new Error("Backend connections are available in Koed Desktop.");
    if (
      !response.ok ||
      !isRecord(payload) ||
      typeof payload.csrfToken !== "string"
    )
      throw new Error("Backend connection settings could not be loaded.");
    this.csrfToken = payload.csrfToken;
    return parseSnapshot(payload);
  }

  async connect(
    remoteUrl: string
  ): Promise<StudioCollaborationSettingsSnapshot> {
    return this.mutate({ action: "connect_backend", remoteUrl });
  }

  async reconnect(): Promise<StudioCollaborationSettingsSnapshot> {
    return this.mutate({ action: "reconnect_backend" });
  }

  async disconnect(): Promise<StudioCollaborationSettingsSnapshot> {
    return this.mutate({ action: "disconnect_backend" });
  }

  private async mutate(
    action:
      | { action: "connect_backend"; remoteUrl: string }
      | { action: "reconnect_backend" }
      | { action: "disconnect_backend" }
  ): Promise<StudioCollaborationSettingsSnapshot> {
    if (!this.csrfToken) await this.load();
    const response = await fetch("/studio-api/collaboration/backend", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-studio-csrf": this.csrfToken ?? ""
      },
      body: JSON.stringify({ ...action, requestId: crypto.randomUUID() }),
      cache: "no-store"
    });
    const payload: unknown = await readJson(response);
    if (isRecord(payload) && isRecord(payload.connection)) {
      const snapshot = parseSnapshot(payload);
      if (!response.ok) {
        const message =
          typeof payload.error === "string"
            ? payload.error
            : "Backend connection could not be updated.";
        throw Object.assign(new Error(message), { snapshot });
      }
      return snapshot;
    }
    if (response.status === 404)
      throw new Error("Backend connections are available in Koed Desktop.");
    if (response.status === 409)
      throw new Error("This backend action was already submitted. Try again.");
    throw new Error("Backend connection could not be updated.");
  }
}
