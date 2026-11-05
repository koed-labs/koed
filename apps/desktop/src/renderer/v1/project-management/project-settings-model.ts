import type {
  PersonalProjectBatchInput,
  PersonalProjectMembershipExplanation
} from "@koed/shared";
import {
  PERSONAL_PROJECT_INSPECTION_BATCH_SIZE,
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
import { projectErrorMessage } from "./use-organization-review.js";
import {
  projectKinLook,
  projectKinSettings,
  sameAgentLook,
  type AgentLook
} from "../pixelkin/agent-kin.js";

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
  look: AgentLook;
  sources: SettingsSource[];
  selectedSources: Set<string>;
  conversations: SettingsConversation[];
  memberships: Record<string, MembershipDraft>;
  sync: ProjectSyncState | null;
  inspectionError?: string;
};

/** One bounded request at a time, at the same reviewed Project version. */
async function inspectConversations(
  api: PersonalDesktopApi,
  project: DesktopProject,
  candidates: { sessionId: string; title: string; logicalSessionId?: string }[]
): Promise<SettingsConversation[]> {
  const conversations: SettingsConversation[] = [];
  for (
    let offset = 0;
    offset < candidates.length;
    offset += PERSONAL_PROJECT_INSPECTION_BATCH_SIZE
  ) {
    const batch = candidates.slice(
      offset,
      offset + PERSONAL_PROJECT_INSPECTION_BATCH_SIZE
    );
    const result = await api.manageProject!({
      action: "explain_sessions",
      projectId: project.id,
      expectedVersion: project.namedProject!.version,
      sessionIds: batch.map((c) => c.sessionId)
    });
    const explanations = new Map(
      result.explanations?.map((e) => [e.sessionId, e])
    );
    if (
      result.project.projectId !== project.id ||
      result.project.version !== project.namedProject!.version ||
      result.explanations?.length !== batch.length ||
      explanations.size !== batch.length
    )
      throw new Error("Conversation membership changed. Reopen settings.");
    for (const candidate of batch) {
      const explanation = explanations.get(candidate.sessionId);
      if (
        !explanation ||
        (candidate.logicalSessionId &&
          explanation.logicalSessionId !== candidate.logicalSessionId)
      )
        throw new Error("Conversation membership changed. Reopen settings.");
      conversations.push({
        sessionId: candidate.sessionId,
        title: candidate.title,
        explanation
      });
    }
  }
  return conversations;
}

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
  const draft: ProjectSettingsDraft = {
    project,
    name: project.name,
    look: projectKinLook(project.id, project.namedProject.kin),
    sources,
    selectedSources: new Set(
      sources.filter((s) => s.inclusionId).map((s) => s.id)
    ),
    conversations: [],
    memberships: {},
    sync
  };
  const titles = new Map<string, string>();
  for (const thread of projects.flatMap((p) => p.threads)) {
    if (thread.sessionId) titles.set(thread.sessionId, thread.name);
    for (const reference of thread.sourceReferences ?? [])
      titles.set(reference.sessionId, thread.name);
  }
  try {
    draft.conversations = await inspectConversations(
      api,
      project,
      [...sessionIds].map((sessionId) => ({
        sessionId,
        title: titles.get(sessionId) ?? "Conversation"
      }))
    );
  } catch (cause) {
    // Keep the successfully loaded sync review available, without a partial edit draft.
    draft.inspectionError =
      projectErrorMessage(cause) ||
      "Conversation membership could not be loaded.";
  }
  return draft;
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
  const additional = await inspectConversations(
    api,
    draft.project,
    missing.map((candidate) => ({ ...candidate, title: candidate.name }))
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
  if (draft.inspectionError) return [];
  const changes: PersonalProjectBatchInput["changes"] = [];
  const originalLook = projectKinLook(
    draft.project.id,
    draft.project.namedProject?.kin
  );
  if (!sameAgentLook(originalLook, draft.look))
    changes.push({
      action: "set_details",
      name: draft.name.trim(),
      kin: projectKinSettings(draft.look)
    });
  else if (draft.name.trim() !== draft.project.name)
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
