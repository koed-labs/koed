export type ManagedAgentJobMarker = Readonly<{
  id: string;
  agentName: string;
  projectName: string;
  goal: string;
  state: string;
  createdAt: string;
}>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function managedAgentJobMarkers(
  payload: unknown,
  options: {
    messages?: readonly unknown[];
    activeAgentName?: string | null;
    projects?: readonly { id: string; name: string }[];
  } = {}
): ManagedAgentJobMarker[] {
  if (!record(payload) || !Array.isArray(payload.jobs)) return [];
  const namesByJob = new Map<string, string>();
  for (const message of options.messages ?? []) {
    if (
      !record(message) ||
      typeof message.id !== "string" ||
      !record(message.author) ||
      typeof message.author.name !== "string"
    )
      continue;
    const match = /^agent:(.+)$/u.exec(message.id);
    if (match) namesByJob.set(match[1]!, message.author.name);
  }
  const projects = new Map(
    (options.projects ?? []).map((project) => [project.id, project.name])
  );
  const markers: ManagedAgentJobMarker[] = [];
  for (const value of payload.jobs) {
    if (
      !record(value) ||
      typeof value.id !== "string" ||
      typeof value.title !== "string"
    )
      continue;
    const authorName = namesByJob.get(value.id);
    const explicitName =
      typeof value.agentName === "string" ? value.agentName : null;
    const agentName =
      explicitName ??
      authorName ??
      (markers.length === 0 ? (options.activeAgentName ?? null) : null);
    if (!agentName) continue;
    const projectId =
      typeof value.projectId === "string" ? value.projectId : null;
    const projectName =
      typeof value.projectName === "string"
        ? value.projectName
        : projectId
          ? (projects.get(projectId) ?? "Project")
          : "Independent chat";
    const goal =
      typeof value.goalSummary === "string" ? value.goalSummary : value.title;
    const createdAt =
      typeof value.createdAt === "string" ? value.createdAt : "";
    const state =
      typeof value.observedState === "string"
        ? value.observedState
        : typeof value.state === "string"
          ? value.state
          : "unknown";
    markers.push({
      id: value.id,
      agentName,
      projectName,
      goal: goal.trim().slice(0, 160),
      state,
      createdAt
    });
  }
  return markers.slice(0, 20);
}
