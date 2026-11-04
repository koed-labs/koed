import type {
  PersonalProjectBatchInput,
  PersonalProjectMembershipExplanation
} from "@koed/shared";
import {
  personalRecallTargetsEqual,
  type PersonalDesktopApi
} from "@koed/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import {
  projectTransferInclusions,
  projectTransferSources,
  type TransferSource
} from "../../views/personal/project-transfer-model.js";
import {
  directMembership,
  excludedMembership
} from "./conversation-organization.js";

export type ProjectSyncState = Awaited<
  ReturnType<NonNullable<PersonalDesktopApi["manageMembershipSync"]>>
>["state"];
export type SettingsConversation = {
  sessionId: string;
  title: string;
  explanation: PersonalProjectMembershipExplanation;
};
export type SettingsSource = TransferSource & {
  inclusionId?: string;
  previewSessions?: string[];
};
export type MembershipDraft = {
  included: boolean;
  direct: boolean;
  restore: boolean;
};
export type ProjectSettingsDraft = {
  project: DesktopProject;
  name: string;
  sources: SettingsSource[];
  selectedSources: Set<string>;
  conversations: SettingsConversation[];
  memberships: Record<string, MembershipDraft>;
  sync: ProjectSyncState | null;
};

export async function loadProjectSettings(
  api: PersonalDesktopApi,
  project: DesktopProject,
  projects: readonly DesktopProject[]
): Promise<ProjectSettingsDraft> {
  if (!project.namedProject || !api.manageProject)
    throw new Error("Project management is unavailable.");
  let sync: ProjectSyncState | null = null;
  if (api.manageMembershipSync) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const result = await api.manageMembershipSync({
        action: "list",
        projectId: project.id,
        afterEntityId: cursor
      });
      if (result.state.project.version !== project.namedProject.version)
        throw new Error("Project changed. Reopen settings to review it again.");
      sync = sync
        ? {
            ...result.state,
            memberships: [...sync.memberships, ...result.state.memberships]
          }
        : result.state;
      cursor = result.state.nextEntityId ?? undefined;
      if (cursor && seen.has(cursor))
        throw new Error("Project sync history could not be loaded.");
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  const inventory = projectTransferSources(projects);
  const inclusions = projectTransferInclusions(project, inventory).filter(
    (i) => i.target
  );
  const sources: SettingsSource[] = [
    ...inventory.repositories,
    ...inventory.folders
  ]
    .filter((s) => s.target)
    .map((source) => ({
      ...source,
      inclusionId: inclusions.find(
        (i) =>
          i.target &&
          source.target &&
          personalRecallTargetsEqual(i.target, source.target)
      )?.inclusionId
    }));
  for (const inclusion of inclusions)
    if (!sources.some((s) => s.inclusionId === inclusion.inclusionId))
      sources.push(inclusion);
  const sessionIds = new Set(
    project.threads.flatMap((t) => (t.sessionId ? [t.sessionId] : []))
  );
  for (const entity of sync?.memberships ?? [])
    if (entity.entityKind === "exclusion" && entity.source?.localSessionId)
      sessionIds.add(entity.source.localSessionId);
  const conversations = await Promise.all(
    [...sessionIds].map(async (sessionId) => {
      const result = await api.manageProject!({
        action: "explain_session",
        projectId: project.id,
        expectedVersion: project.namedProject!.version,
        sessionId
      });
      if (
        !result.explanation ||
        result.explanation.sessionId !== sessionId ||
        result.project.version !== project.namedProject!.version
      )
        throw new Error("Conversation membership changed. Reopen settings.");
      const thread = projects
        .flatMap((p) => p.threads)
        .find(
          (t) =>
            t.sessionId === sessionId ||
            t.sourceReferences?.some((r) => r.sessionId === sessionId)
        );
      return {
        sessionId,
        title: thread?.name ?? "Conversation",
        explanation: result.explanation
      };
    })
  );
  return {
    project,
    name: project.name,
    sources,
    selectedSources: new Set(
      sources.filter((s) => s.inclusionId).map((s) => s.id)
    ),
    conversations,
    memberships: {},
    sync
  };
}

export function settingsMembership(
  draft: ProjectSettingsDraft,
  row: SettingsConversation
): MembershipDraft {
  const staged = draft.memberships[row.sessionId];
  return staged
    ? {
        ...staged,
        included:
          staged.included &&
          (staged.direct || settingsMatchingSources(draft, row).length > 0)
      }
    : {
        included:
          !excludedMembership(row.explanation) &&
          (directMembership(row.explanation) ||
            settingsMatchingSources(draft, row).length > 0),
        direct: directMembership(row.explanation),
        restore: false
      };
}

export function settingsMatchingSources(
  draft: ProjectSettingsDraft,
  row: SettingsConversation
) {
  return draft.sources.filter(
    (source) =>
      draft.selectedSources.has(source.id) &&
      (source.inclusionId
        ? row.explanation.reasons.some(
            (reason) => reason.inclusionId === source.inclusionId
          )
        : source.previewSessions?.includes(row.sessionId))
  );
}

/** A new source is previewed by the server. Only its matching Conversations are
 * loaded; this does not turn settings into a full-library Conversation picker. */
export async function selectSettingsSource(
  api: PersonalDesktopApi,
  draft: ProjectSettingsDraft,
  sourceId: string,
  selected: boolean
): Promise<ProjectSettingsDraft> {
  const selectedSources = new Set(draft.selectedSources);
  if (!selected) {
    selectedSources.delete(sourceId);
    return { ...draft, selectedSources };
  }
  selectedSources.add(sourceId);
  const source = draft.sources.find((s) => s.id === sourceId);
  if (!source?.target || source.inclusionId || source.previewSessions)
    return { ...draft, selectedSources };
  const base = {
    projectId: draft.project.id,
    expectedVersion: draft.project.namedProject!.version
  };
  const result = await api.manageProject!(
    source.target.kind === "folder"
      ? { ...base, action: "preview_folder", folder: source.target.folder }
      : {
          ...base,
          action: "preview_repository",
          repository: source.target.repository
        }
  );
  if (
    !result.preview ||
    result.project.version !== base.expectedVersion ||
    !personalRecallTargetsEqual(result.preview.target, source.target)
  )
    throw new Error("Source review changed. Reopen settings.");
  const missing = result.preview.conversations.filter(
    (candidate) =>
      !draft.conversations.some((row) => row.sessionId === candidate.sessionId)
  );
  const additional = await Promise.all(
    missing.map(async (candidate) => {
      const membership = await api.manageProject!({
        ...base,
        action: "explain_session",
        sessionId: candidate.sessionId
      });
      if (
        !membership.explanation ||
        membership.explanation.logicalSessionId !==
          candidate.logicalSessionId ||
        membership.project.version !== base.expectedVersion
      )
        throw new Error("Conversation membership changed. Reopen settings.");
      return {
        sessionId: candidate.sessionId,
        title: candidate.name,
        explanation: membership.explanation
      };
    })
  );
  return {
    ...draft,
    selectedSources,
    conversations: [...draft.conversations, ...additional],
    sources: draft.sources.map((s) =>
      s.id === sourceId
        ? {
            ...s,
            previewSessions: result.preview!.conversations.map(
              (c) => c.sessionId
            )
          }
        : s
    )
  };
}

export function settingsChanges(
  draft: ProjectSettingsDraft
): PersonalProjectBatchInput["changes"] {
  const changes: PersonalProjectBatchInput["changes"] = [];
  if (draft.name.trim() !== draft.project.name)
    changes.push({ action: "rename", name: draft.name.trim() });
  for (const source of draft.sources) {
    const selected = draft.selectedSources.has(source.id);
    if (source.inclusionId && !selected)
      changes.push({ action: "remove_rule", inclusionId: source.inclusionId });
    if (!source.inclusionId && selected && source.target)
      changes.push(
        source.target.kind === "folder"
          ? { action: "add_folder", folder: source.target.folder }
          : { action: "add_repository", repository: source.target.repository }
      );
  }
  for (const row of draft.conversations) {
    const change = draft.memberships[row.sessionId];
    if (!change) continue;
    const excluded = excludedMembership(row.explanation),
      exclusion = row.explanation.exclusion;
    if (change.included && excluded) {
      if (!change.restore || !exclusion)
        throw new Error(
          "Review the exclusion before adding this Conversation back."
        );
      changes.push({
        action: "add_back",
        sessionId: row.sessionId,
        exclusionId: exclusion.exclusionId,
        expectedExclusionRevisionId: exclusion.headRevisionId
      });
    } else if (change.direct && !directMembership(row.explanation))
      changes.push({ action: "add_session", sessionId: row.sessionId });
    if (!change.direct && directMembership(row.explanation))
      for (const reason of row.explanation.reasons)
        if (reason.kind === "session")
          changes.push({
            action: "remove_inclusion",
            inclusionId: reason.inclusionId
          });
    if (
      !change.included &&
      (row.explanation.included ||
        settingsMatchingSources(draft, row).length > 0) &&
      (row.explanation.reasons.some((r) => r.kind !== "session") ||
        settingsMatchingSources(draft, row).length > 0)
    )
      changes.push({ action: "exclude_session", sessionId: row.sessionId });
  }
  return changes;
}
