import {
  personalInventoryReference,
  personalInventoryConversationKey,
  deduplicatePersonalInventoryConversations,
  type PersonalInventoryGroup
} from "./personal-inventory.js";
type Thread = Parameters<typeof personalInventoryConversationKey>[0] &
  PersonalInventoryGroup["threads"][number];
type Group = Omit<PersonalInventoryGroup, "threads"> & {
  name: string;
  threads: Thread[];
};

/** Explain recorded equality and overlap without using a display label, current
 * directory, or checkout display grouping to infer a historical assignment. */
export const classifyPersonalInventory = (groups: readonly Group[]) => {
  const identities = new Map<
    string,
    { kind: string; key: string; rows: number }
  >();
  const labels = new Map<string, Set<string>>();
  const memberships = new Map<string, Set<string>>();
  const folders = new Map<
    string,
    {
      key: string;
      reference: NonNullable<Group["folder"]>["reference"];
      name: string;
      path: string;
      conversationKeys: Set<string>;
      git: Map<string, Set<string>>;
      standalone: Set<string>;
      unresolved: Set<string>;
    }
  >();
  const unresolved = new Set<string>();
  for (const group of groups) {
    const reference = personalInventoryReference(group);
    const selection = `${reference.kind}:${reference.key}`;
    const identity = identities.get(selection) ?? {
      kind: reference.kind,
      key: reference.key,
      rows: 0
    };
    identity.rows++;
    identities.set(selection, identity);
    const sameLabel = labels.get(group.name) ?? new Set<string>();
    sameLabel.add(selection);
    labels.set(group.name, sameLabel);
    if (reference.kind === "unresolved") unresolved.add(selection);
    const folder =
      reference.kind === "folder" && group.folder
        ? (folders.get(reference.key) ?? {
            key: reference.key,
            reference: group.folder.reference,
            name: group.name,
            path: group.folder.normalizedPath,
            conversationKeys: new Set<string>(),
            git: new Map<string, Set<string>>(),
            standalone: new Set<string>(),
            unresolved: new Set<string>()
          })
        : null;
    for (const thread of deduplicatePersonalInventoryConversations(
      group.threads
    )) {
      const key = personalInventoryConversationKey(thread);
      const selections = memberships.get(key) ?? new Set<string>();
      selections.add(selection);
      memberships.set(key, selections);
      if (!folder) continue;
      folder.conversationKeys.add(key);
      const source = personalInventoryReference({
        id: group.id,
        repository: thread.repositoryAssignment?.effective ?? undefined,
        threads: []
      });
      if (source.kind === "git") {
        const known = folder.git.get(source.key) ?? new Set<string>();
        known.add(key);
        folder.git.set(source.key, known);
      } else if (
        thread.repositoryAssignment?.state === "recorded" &&
        thread.repositoryAssignment.effective?.kind === "non_git_project" &&
        thread.repositoryAssignment.effective.reason === "non_git"
      )
        folder.standalone.add(key);
      else folder.unresolved.add(key);
    }
    if (folder) folders.set(folder.key, folder);
  }
  return {
    equalIdentities: [...identities.values()].filter((entry) => entry.rows > 1),
    equalLabels: [...labels]
      .filter(([, selections]) => selections.size > 1)
      .map(([label, selections]) => ({ label, selections: [...selections] })),
    overlappingViews: [...memberships]
      .filter(([, selections]) => selections.size > 1)
      .map(([conversationKey, selections]) => ({
        conversationKey,
        selections: [...selections]
      })),
    unresolved: [...unresolved],
    folders: [...folders.values()].map((folder) => ({
      key: folder.key,
      reference: folder.reference,
      name: folder.name,
      path: folder.path,
      conversationCount: folder.conversationKeys.size,
      gitSources: [...folder.git].map(([key, conversationKeys]) => ({
        key,
        conversationKeys: [...conversationKeys]
      })),
      standaloneConversationKeys: [...folder.standalone],
      unresolvedConversationKeys: [...folder.unresolved],
      classification: folder.git.size
        ? folder.standalone.size || folder.unresolved.size
          ? ("mixed" as const)
          : ("git_checkout" as const)
        : folder.standalone.size
          ? folder.unresolved.size
            ? ("mixed" as const)
            : ("standalone" as const)
          : ("unresolved" as const)
    }))
  };
};
