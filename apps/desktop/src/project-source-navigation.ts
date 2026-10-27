import {
  personalFolderExecutionId,
  personalFolderScopeId,
  personalInventoryConversationKey,
  personalInventoryReference,
  deduplicatePersonalInventoryConversations
} from "@koed/shared/personal-desktop";
import type {
  PersonalFolderObservation,
  PersonalGitContext,
  PersonalFolderReference
} from "@koed/shared";
import type {
  DesktopProject,
  DesktopProjectMetadata
} from "./project-memory-ui.js";

export type ProjectSourceFilter =
  | { kind: "git"; key: string }
  | { kind: "folder"; key: string; gitKey?: string }
  | { kind: "direct" };
export type ProjectSourceInventory = {
  reconciliationPending?: boolean | null;
  projects: DesktopProject[];
  gitSources: DesktopProject[];
  folders: DesktopProject[];
  unresolved: DesktopProject[];
  localCheckouts: DesktopProjectMetadata[];
  localFolders: PersonalFolderObservation[];
};
export type ProjectSourceOption = {
  filter: ProjectSourceFilter;
  label: string;
  context: string;
  count: number;
  children: ProjectSourceOption[];
};
const conversationKey = (thread: DesktopProject["threads"][number]) =>
  personalInventoryConversationKey(thread);
const gitKey = (thread: DesktopProject["threads"][number]) => {
  const source = personalInventoryReference({
    id: thread.projectId,
    repository: thread.repositoryAssignment?.effective ?? undefined,
    threads: []
  });
  return source.kind === "git" ? source.key : null;
};

/** Project threads already carry current membership and exclusions. A source
 * filter only intersects those members with recorded source identities. */
export const filterProjectSourceConversations = (
  project: DesktopProject,
  filter: ProjectSourceFilter | undefined,
  inventory: ProjectSourceInventory
) => {
  if (!filter) return project.threads;
  if (filter.kind === "git")
    return project.threads.filter((thread) => gitKey(thread) === filter.key);
  if (filter.kind === "direct")
    return project.threads.filter((thread) =>
      thread.membershipReasons?.some((reason) => reason.kind === "session")
    );
  const folder = inventory.folders.find(
    (folder) =>
      folder.folder &&
      personalFolderScopeId(folder.folder.reference) === filter.key
  );
  const members = new Set(folder?.threads.map(conversationKey) ?? []);
  return project.threads.filter(
    (thread) =>
      members.has(conversationKey(thread)) &&
      (!filter.gitKey || gitKey(thread) === filter.gitKey)
  );
};

const folderContext = (folder: PersonalFolderReference, path: string) =>
  `${path} · Device ${folder.originatingDeviceId.slice(0, 12)} · Profile ${folder.originatingProfileId.slice(0, 8)} · Directory ${folder.directoryIncarnationId.slice(0, 8)}`;

export const projectSourceOptions = (
  project: DesktopProject,
  inventory: ProjectSourceInventory
): ProjectSourceOption[] => {
  const anchors = new Map<string, PersonalGitContext>();
  const futureAnchors = new Set<string>();
  const folders = new Map<
    string,
    { reference: PersonalFolderReference; path: string }
  >();
  for (const rule of project.inclusionRules ?? []) {
    if (rule.target.kind === "repository") {
      const source = personalInventoryReference({
        id: project.id,
        repository: rule.target.repository,
        threads: []
      });
      if (source.kind === "git") {
        anchors.set(source.key, rule.target.repository);
        futureAnchors.add(source.key);
      }
    } else
      folders.set(personalFolderScopeId(rule.target.folder), {
        reference: rule.target.folder,
        path: rule.folderContext?.normalizedPath ?? "Unavailable Folder"
      });
  }
  for (const thread of project.threads) {
    const source = personalInventoryReference({
      id: thread.projectId,
      repository: thread.repositoryAssignment?.effective ?? undefined,
      threads: []
    });
    if (source.kind === "git") anchors.set(source.key, source.repository);
  }
  const folderOption = (
    key: string,
    folder: PersonalFolderReference,
    path: string,
    anchor?: string
  ): ProjectSourceOption => {
    const filter: ProjectSourceFilter = {
      kind: "folder",
      key,
      ...(anchor ? { gitKey: anchor } : {})
    };
    return {
      filter,
      label: path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Folder",
      context: folderContext(folder, path),
      count: filterProjectSourceConversations(project, filter, inventory)
        .length,
      children: []
    };
  };
  const options: ProjectSourceOption[] = [...anchors].map(([key, anchor]) => ({
    filter: { kind: "git", key },
    label: anchor.anchorDisplay ?? "Git Anchor",
    context: futureAnchors.has(key)
      ? "Git Anchor · Existing + future Conversations"
      : "Recorded context · Individual Conversations only",
    count: filterProjectSourceConversations(
      project,
      { kind: "git", key },
      inventory
    ).length,
    children: inventory.folders.flatMap((folder) => {
      if (!folder.folder) return [];
      const child = folderOption(
        personalFolderScopeId(folder.folder.reference),
        folder.folder.reference,
        folder.folder.normalizedPath,
        key
      );
      return child.count > 0 ? [child] : [];
    })
  }));
  for (const [key, folder] of folders)
    options.push(folderOption(key, folder.reference, folder.path));
  if (
    project.directInclusions?.length ||
    project.threads.some((thread) =>
      thread.membershipReasons?.some((reason) => reason.kind === "session")
    )
  )
    options.push({
      filter: { kind: "direct" },
      label: "Direct Conversations",
      context: "Individual inclusions",
      count: filterProjectSourceConversations(
        project,
        { kind: "direct" },
        inventory
      ).length,
      children: []
    });
  return options;
};

export const projectSourceSearchText = (
  project: DesktopProject,
  inventory: ProjectSourceInventory
) =>
  [
    project.name,
    ...projectSourceOptions(project, inventory).flatMap((source) => [
      source.label,
      source.context,
      ...source.children.flatMap((child) => [child.label, child.context])
    ])
  ].join(" ");

/** Only live native registrations supply executable directories. Project rules
 * select candidates; paths and remote source identities never grant execution. */
export const projectExecutionFolders = (
  project: DesktopProject,
  inventory: ProjectSourceInventory
) => {
  const ownerUserId =
    project.ownerUserId ??
    project.projectReference?.ownerUserId ??
    project.folder?.reference.ownerUserId ??
    inventory.folders.find((folder) => folder.folder)?.folder?.reference
      .ownerUserId;
  if (!ownerUserId) return [];
  return inventory.localFolders.flatMap((local) => {
    const reference = { ...local.identity, ownerUserId };
    const scope = personalFolderScopeId(reference);
    const exact = inventory.folders.find(
      (folder) =>
        folder.folder &&
        personalFolderScopeId(folder.folder.reference) === scope
    );
    const nativeGit = inventory.localCheckouts.filter(
      (metadata) =>
        metadata.repository &&
        (metadata.path.cwd === local.normalizedPath ||
          metadata.path.projectRoot === local.normalizedPath ||
          exact?.threads.some(
            (thread) =>
              thread.repositoryAssignment?.automatic?.checkoutId ===
                metadata.repository?.checkoutId &&
              thread.repositoryAssignment?.automatic?.originatingDeviceId ===
                metadata.repository?.originatingDeviceId
          ))
    );
    const matches = (
      target: NonNullable<DesktopProject["inclusionRules"]>[number]["target"]
    ) => {
      if (target.kind === "folder")
        return personalFolderScopeId(target.folder) === scope;
      const source = personalInventoryReference({
        id: project.id,
        repository: target.repository,
        threads: []
      });
      return (
        source.kind === "git" &&
        nativeGit.some(
          (metadata) =>
            personalInventoryReference({
              id: metadata.localProjectId,
              repository: metadata.repository,
              threads: []
            }).key === source.key
        )
      );
    };
    const targets = project.namedProject
      ? (project.inclusionRules ?? []).map((rule) => rule.target)
      : project.folder
        ? [{ kind: "folder" as const, folder: project.folder.reference }]
        : project.repository &&
            (project.repository.kind === "portable_repository" ||
              project.repository.kind === "device_local_repository")
          ? [{ kind: "repository" as const, repository: project.repository }]
          : [];
    return targets.some(matches)
      ? [
          {
            id: personalFolderExecutionId(reference),
            reference,
            path: local.normalizedPath,
            label: local.normalizedPath
          }
        ]
      : [];
  });
};

export const systemConversationViews = (inventory: ProjectSourceInventory) => {
  const sourceGroups = [
    ...inventory.gitSources,
    ...inventory.unresolved,
    ...inventory.folders
  ];
  const all = deduplicatePersonalInventoryConversations(
    sourceGroups.flatMap((group) => group.threads)
  );
  const members = new Set(
    inventory.projects.flatMap((group) => group.threads.map(conversationKey))
  );
  const independent = new Set(
    sourceGroups
      .filter((group) => group.contextKind === "independent")
      .flatMap((group) => group.threads.map(conversationKey))
  );
  return {
    available: all.filter((thread) => !members.has(conversationKey(thread))),
    independent: all.filter((thread) =>
      independent.has(conversationKey(thread))
    ),
    unresolved: all.filter(
      (thread) =>
        !thread.repositoryAssignment?.effective ||
        thread.repositoryAssignment.effective.kind === "unresolved" ||
        thread.repositoryAssignment.effective.kind === "local_project"
    )
  };
};

/** Transient navigation containers. These are never catalog entries. */
export const systemConversationProjects = (
  inventory: ProjectSourceInventory
): DesktopProject[] => {
  const labels: Record<string, string> = {
    available: "Conversations without a Project",
    independent: "Independent Conversations",
    unresolved: "Unresolved history"
  };
  return Object.entries(systemConversationViews(inventory)).map(
    ([kind, threads]) => ({
      id: `system:${kind}`,
      name: labels[kind]!,
      path: null,
      threads,
      eventCount: threads.reduce((sum, thread) => sum + thread.eventCount, 0),
      catalogued: false,
      discoveredAt: null,
      lastSeenAt: null,
      localProjectId: null,
      branch: null,
      remoteDisplay: null,
      isWorktree: false,
      contextKind: "independent"
    })
  );
};
