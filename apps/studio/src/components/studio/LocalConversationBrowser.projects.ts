// Node 24's native TypeScript runner requires the source extension here.
// @ts-expect-error -- Next's app compiler does not enable TS extension imports.
import { isSyntheticIndependentProject } from "../../lib/project-identity.ts";

export type LocalConversationProvider = "codex" | "claude-code" | "pi";
export type ProjectProviderFilter = LocalConversationProvider | "all";

type ProjectSource = {
  provider: LocalConversationProvider;
  projectId?: string;
  projectName?: string;
};

type RegisteredProject = {
  id: string;
  name: string;
};

type ManagedConversation = {
  projectId: string | null;
  provider: string;
  state: string;
};

export function hasExplainableProjectAssociation(
  item: ProjectSource,
  registeredProjectIds: ReadonlySet<string>
) {
  return Boolean(
    item.projectId &&
    !isSyntheticIndependentProject(item.projectId, item.projectName) &&
    (registeredProjectIds.has(item.projectId) || item.projectName?.trim())
  );
}

/** Runtime transitions must not remove a saved conversation from navigation. */
export function isListedManagedConversation(state: string): boolean {
  return [
    "running",
    "ready",
    "starting",
    "reconciling",
    "quiesce_requested",
    "quiesced",
    "stopping",
    "stopped",
    "failed",
    "fenced"
  ].includes(state.toLowerCase());
}

/** Derive the sidebar Projects and managed rows, including terminal history. */
export function deriveProjectBrowserView<TManaged extends ManagedConversation>({
  items,
  registeredProjects,
  managedConversations,
  provider,
  normalizeProvider
}: {
  items: ProjectSource[];
  registeredProjects: RegisteredProject[];
  managedConversations: TManaged[];
  provider: ProjectProviderFilter;
  normalizeProvider: (
    value: string | null | undefined
  ) => LocalConversationProvider | null;
}): {
  projects: Array<{ id: string; name: string }>;
  activeManagedConversations: TManaged[];
} {
  const activeManagedConversations = managedConversations.filter((item) => {
    const listed = isListedManagedConversation(item.state);
    return (
      listed &&
      (provider === "all" || normalizeProvider(item.provider) === provider)
    );
  });
  const registeredById = new Map(
    registeredProjects.map((project) => [project.id, project])
  );
  const byId = new Map<string, { id: string; name: string }>();
  for (const item of items) {
    if (provider !== "all" && item.provider !== provider) continue;
    if (!item.projectId) continue;
    const existing = byId.get(item.projectId);
    const name = item.projectName?.trim();
    if (existing) {
      if (name && existing.name === "Project") existing.name = name;
    } else {
      byId.set(item.projectId, { id: item.projectId, name: name || "Project" });
    }
  }
  if (provider !== "all") {
    for (const item of activeManagedConversations) {
      if (!item.projectId) continue;
      const registered = registeredById.get(item.projectId);
      if (registered && !byId.has(item.projectId)) {
        byId.set(item.projectId, {
          id: item.projectId,
          name: registered.name.trim() || "Project"
        });
      }
    }
  }
  for (const project of registeredProjects) {
    if (provider === "all") {
      const existing = byId.get(project.id);
      if (existing) existing.name = project.name.trim() || existing.name;
      else byId.set(project.id, { id: project.id, name: project.name });
    } else {
      const existing = byId.get(project.id);
      if (existing) existing.name = project.name.trim() || existing.name;
    }
  }
  return { projects: Array.from(byId.values()), activeManagedConversations };
}
