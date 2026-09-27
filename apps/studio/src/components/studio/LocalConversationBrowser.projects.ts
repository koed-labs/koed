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

/** Derive the sidebar Projects and active managed rows for the selected client. */
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
    const active = ["running", "ready", "starting"].includes(
      item.state.toLowerCase()
    );
    return (
      active &&
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
