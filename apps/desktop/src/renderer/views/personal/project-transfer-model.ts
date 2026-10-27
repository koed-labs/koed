import {
  personalFolderScopeId,
  personalInventoryConversationKey,
  deduplicatePersonalInventoryConversations,
  personalRecallTargetsEqual
} from "@koed/shared/personal-desktop";
import { repositoryScopeId } from "@koed/shared/repository-recall";
import type { PersonalProjectCommand, PersonalProjectRule } from "@koed/shared";
import type { PersonalDesktopProjectThread } from "@koed/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";

type Thread = PersonalDesktopProjectThread;
export type TransferSource = {
  id: string;
  name: string;
  detail: string;
  kind: "repository" | "folder" | "session" | "unresolved";
  threads: Thread[];
  target?: PersonalProjectRule["target"];
  sessionId?: string;
  logicalSessionId?: string;
};
export type TransferInclusion = TransferSource & {
  inclusionId: string;
  removal: "remove_rule" | "remove_inclusion";
};
export type TransferMutation = PersonalProjectCommand extends infer Command
  ? Command extends { action: infer Action }
    ? Action extends
        | "add_repository"
        | "add_folder"
        | "add_session"
        | "remove_rule"
        | "remove_inclusion"
        | "exclude_session"
      ? Omit<Command, "projectId" | "expectedVersion">
      : never
    : never
  : never;

const logicalId = (thread: Thread) =>
  thread.sourceReferences?.find((ref) => ref.sessionId === thread.sessionId)
    ?.logicalSessionId;
const sessionIds = (threads: Thread[]) =>
  new Set(
    threads.flatMap((thread) => [
      personalInventoryConversationKey(thread),
      ...(thread.sessionId ? [thread.sessionId] : []),
      ...(thread.sourceReferences?.map((ref) => ref.sessionId) ?? [])
    ])
  );
const overlaps = (thread: Thread, ids: Set<string>) =>
  ids.has(personalInventoryConversationKey(thread)) ||
  (thread.sessionId !== null && ids.has(thread.sessionId)) ||
  thread.sourceReferences?.some((ref) => ids.has(ref.sessionId));
const uniqueThreads = (threads: Thread[]) =>
  deduplicatePersonalInventoryConversations(
    threads.filter((thread) => thread.sessionId)
  );
const byName = (a: TransferSource, b: TransferSource) =>
  a.name.localeCompare(b.name) || a.detail.localeCompare(b.detail);
const conversation = (thread: Thread): TransferSource => ({
  id: `session:${logicalId(thread) ?? thread.sessionId}`,
  name: thread.name,
  detail: thread.originDevice?.name ?? thread.sourceAiClient ?? "Conversation",
  kind: "session",
  threads: [thread],
  sessionId: thread.sessionId ?? undefined,
  logicalSessionId: logicalId(thread)
});

/** Browse only recorded source inventories. A shared path or provider thread
 * label never establishes Git, Folder, or Conversation identity. */
export function projectTransferSources(projects: readonly DesktopProject[]) {
  const repositories = new Map<string, TransferSource>();
  const folders = new Map<string, TransferSource>();
  const historicalFolders = new Map<string, TransferSource>();
  const allThreads = uniqueThreads(
    projects.flatMap((project) => project.threads)
  );
  for (const project of projects) {
    if (project.namedProject) continue;
    if (project.folder) {
      const id = personalFolderScopeId(project.folder.reference);
      const device = project.threads.find((thread) => thread.originDevice?.name)
        ?.originDevice?.name;
      folders.set(id, {
        id,
        name: project.name,
        detail: `${project.folder.normalizedPath} · ${device ?? project.folder.reference.originatingDeviceId}`,
        kind: "folder",
        target: { kind: "folder", folder: project.folder.reference },
        threads: uniqueThreads([
          ...(folders.get(id)?.threads ?? []),
          ...project.threads
        ])
      });
    } else if (project.repository?.kind === "non_git_project" && project.path) {
      // Retain the existing source group for browsing; a legacy directory
      // identity cannot establish a native Folder rule or future membership.
      const id = `historical-folder:${project.id}`;
      historicalFolders.set(id, {
        id,
        name: project.name,
        detail: `Existing Conversations only · ${project.path} · ${project.repository.originatingDeviceId}`,
        kind: "folder",
        threads: uniqueThreads([
          ...(historicalFolders.get(id)?.threads ?? []),
          ...project.threads
        ])
      });
    } else if (
      project.repository?.kind === "portable_repository" ||
      project.repository?.kind === "device_local_repository"
    ) {
      const id = repositoryScopeId(project.repository);
      repositories.set(id, {
        id,
        name: project.name,
        detail:
          project.repository.anchorDisplay ?? project.path ?? "Git Anchor",
        kind: "repository",
        target: { kind: "repository", repository: project.repository },
        threads: uniqueThreads([
          ...(repositories.get(id)?.threads ?? []),
          ...project.threads
        ])
      });
    }
  }
  const knownFolders = sessionIds(
    [...folders.values()].flatMap((folder) => folder.threads)
  );
  const historicalRows = [...historicalFolders.values()]
    .map((folder) => ({
      ...folder,
      threads: folder.threads.filter(
        (thread) => !overlaps(thread, knownFolders)
      )
    }))
    .filter((folder) => folder.threads.length > 0);
  const folderRows = [...folders.values(), ...historicalRows].sort(byName);
  const repositoryRows = [...repositories.values()].sort(byName);
  const grouped = sessionIds(folderRows.flatMap((folder) => folder.threads));
  const unfiled = allThreads.filter((thread) => !overlaps(thread, grouped));
  const unresolved: TransferSource = {
    id: "unresolved-folders",
    name: "Other Conversations",
    detail: "No recorded Folder",
    kind: "unresolved",
    threads: unfiled
  };
  return {
    repositories: repositoryRows,
    folders: unfiled.length ? [...folderRows, unresolved] : folderRows,
    conversations: allThreads.map(conversation),
    children(source: TransferSource, repository?: TransferSource) {
      if (source.kind !== "repository") {
        const boundary = repository ? sessionIds(repository.threads) : null;
        return source.threads
          .filter((thread) => !boundary || overlaps(thread, boundary))
          .map(conversation)
          .sort(byName);
      }
      const ids = sessionIds(source.threads);
      return [...folderRows, unresolved]
        .map((folder) => ({
          ...folder,
          threads: folder.threads.filter((thread) => overlaps(thread, ids))
        }))
        .filter((folder) => folder.threads.length > 0);
    }
  };
}

export function projectTransferInclusions(
  project: DesktopProject,
  sources: ReturnType<typeof projectTransferSources>
): TransferInclusion[] {
  const rules: TransferInclusion[] = (project.inclusionRules ?? [])
    .filter((rule) => rule.removedAt === null)
    .map((rule) => {
      const source = [...sources.repositories, ...sources.folders].find(
        (candidate) =>
          candidate.target &&
          personalRecallTargetsEqual(candidate.target, rule.target)
      );
      return {
        id: `rule:${rule.inclusionId}`,
        inclusionId: rule.inclusionId,
        removal: "remove_rule",
        name:
          source?.name ??
          (rule.target.kind === "repository"
            ? (rule.target.repository.anchorDisplay ?? "Git Anchor")
            : (rule.folderContext?.normalizedPath ?? "Recorded Folder")),
        detail: source?.detail ?? "Existing + future Conversations",
        kind: rule.target.kind,
        target: rule.target,
        threads: source?.threads ?? []
      };
    });
  const directs = new Map<string, TransferInclusion>();
  for (const membership of project.directInclusions ?? []) {
    if (membership.removedAt !== null) continue;
    const source = sources.conversations.find(
      (row) => row.logicalSessionId === membership.logicalSessionId
    );
    directs.set(membership.inclusionId, {
      ...source,
      id: `direct:${membership.inclusionId}`,
      inclusionId: membership.inclusionId,
      removal: "remove_inclusion",
      kind: "session",
      name: source?.name ?? "Unavailable Conversation",
      detail: source?.detail ?? "Source unavailable on this device",
      threads: source?.threads ?? [],
      logicalSessionId: membership.logicalSessionId
    });
  }
  return [...rules, ...directs.values()];
}

export const hasTransferInclusion = (
  source: TransferSource,
  inclusions: TransferInclusion[]
) =>
  inclusions.some((row) =>
    source.target && row.target
      ? personalRecallTargetsEqual(source.target, row.target)
      : source.kind === "session" &&
        row.kind === "session" &&
        ((source.logicalSessionId &&
          source.logicalSessionId === row.logicalSessionId) ||
          (source.sessionId && source.sessionId === row.sessionId))
  );

export function addTransferSource(
  source: TransferSource
): TransferMutation | null {
  if (source.target?.kind === "repository")
    return { action: "add_repository", repository: source.target.repository };
  if (source.target?.kind === "folder")
    return { action: "add_folder", folder: source.target.folder };
  if (source.kind === "session" && source.sessionId)
    return { action: "add_session", sessionId: source.sessionId };
  return null;
}
