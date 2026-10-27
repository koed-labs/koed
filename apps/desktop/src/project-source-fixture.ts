import {
  partitionPersonalInventory,
  personalFolderScopeId,
  repositoryScopeId
} from "@koed/shared/personal-desktop";
import type {
  PersonalFolderObservation,
  PersonalFolderContext,
  PersonalGitContext,
  PersonalProjectRule,
  PersonalDirectMembership,
  RepositoryIdentity
} from "@koed/shared";
import type {
  PersonalDesktopProject,
  PersonalDesktopProjectThread,
  PersonalDesktopProjectMetadata
} from "@koed/shared/personal-desktop";
import { mergeProjectSources } from "./project-memory-ui.js";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Shared synthetic navigation fixture. No active profile, source transcript,
 * sharing credential or filesystem registration is used by this fixture. */
export const createProjectSourceFixture = () => {
  const ownerUserId = uuid(1),
    projectId = uuid(2),
    createdAt = "2026-10-27T10:00:00.000Z";
  const git: PersonalGitContext = {
    kind: "portable_repository",
    key: "gr_koed_fixture",
    root: "/local/koed",
    branch: "main",
    reason: "origin",
    checkoutId: "checkout_local",
    originatingDeviceId: "device_local",
    selectedRemote: "origin",
    anchorDisplay: "example.test/koed"
  };
  const otherGit: PersonalGitContext = {
    ...git,
    key: "gr_other_fixture",
    anchorDisplay: "example.test/research"
  };
  const folder = (
    n: number,
    path: string,
    device = "device_local"
  ): PersonalFolderContext => ({
    reference: {
      ownerUserId,
      folderId: `folder_${n}`,
      originatingDeploymentId: "deployment_fixture",
      originatingDeviceId: device,
      originatingProfileId: `profile_${device}`,
      directoryIncarnationId: `incarnation_${n}`
    },
    normalizedPath: path,
    capturedPath: path
  });
  const first = folder(1, "/local/koed"),
    second = folder(2, "/remote/koed", "device_remote"),
    notes = folder(3, "/local/notes");
  const nonGit: RepositoryIdentity = {
    ...git,
    kind: "non_git_project",
    key: "ng_notes",
    checkoutId: "checkout_notes",
    reason: "non_git",
    root: notes.normalizedPath,
    selectedRemote: null,
    anchorDisplay: null
  };
  const makeThread = (
    n: number,
    repository: RepositoryIdentity | null
  ): PersonalDesktopProjectThread => ({
    id: uuid(1000 + n),
    name: [
      "",
      "Local checkout decision",
      "Remote checkout decision",
      "Excluded Conversation",
      "Direct research decision",
      "Standalone notes",
      "Unresolved Conversation",
      "Independent Conversation"
    ][n]!,
    sessionId: uuid(100 + n),
    sourceThreadId: `provider_${n}`,
    logicalMemoryId: null,
    sourceReferences: [
      {
        sessionId: uuid(100 + n),
        logicalSessionId: uuid(1000 + n),
        logicalMemoryId: null
      }
    ],
    sourceAiClient: "codex",
    projectId:
      repository && repository.kind !== "unresolved"
        ? repositoryScopeId(repository)
        : "unassigned",
    projectName: "Recorded source",
    projectPath: repository?.root ?? null,
    projectAssignmentSource: repository ? "detected" : null,
    repositoryAssignment: {
      state: repository ? "recorded" : "historical_unresolved",
      version: 1,
      automatic: repository,
      override: null,
      effective: repository
    },
    eventCount: 1,
    invalidatedCount: 0,
    latestAt: createdAt,
    sample: "Synthetic source evidence",
    threadKind: "conversation",
    parentThreadId: null,
    parentSessionId: null,
    presentation: null
  });
  const one = makeThread(1, git),
    two = makeThread(2, {
      ...git,
      root: second.normalizedPath,
      checkoutId: "checkout_remote",
      originatingDeviceId: "device_remote"
    }),
    excluded = makeThread(3, git),
    direct = makeThread(4, otherGit),
    note = makeThread(5, nonGit),
    unresolved = makeThread(6, null),
    independent = makeThread(7, {
      ...nonGit,
      key: "ng_independent",
      checkoutId: "checkout_independent",
      root: "/local/independent"
    });
  const group = (
    id: string,
    name: string,
    threads: PersonalDesktopProjectThread[],
    extras: Partial<PersonalDesktopProject> = {}
  ): PersonalDesktopProject => ({
    ownerUserId,
    id,
    name,
    path: null,
    eventCount: threads.length,
    threads,
    ...extras
  });
  const rule = (
    n: number,
    target: PersonalProjectRule["target"]
  ): PersonalProjectRule => ({
    inclusionId: uuid(n),
    projectId,
    target,
    version: 1,
    headRevisionId: uuid(n + 100),
    removedAt: null,
    ...(target.kind === "folder" ? { folderContext: notes } : {})
  });
  const gitRule = rule(10, { kind: "repository", repository: git }),
    folderRule = rule(11, { kind: "folder", folder: notes.reference });
  const inclusion: PersonalDirectMembership = {
    inclusionId: uuid(12),
    projectId,
    logicalSessionId: direct.id,
    sourceReference: null,
    version: 1,
    headRevisionId: uuid(112),
    removedAt: null
  };
  const member = (
    thread: PersonalDesktopProjectThread,
    kind: "repository" | "folder" | "session",
    inclusionId: string
  ) => ({
    ...thread,
    projectId,
    projectName: "Koed",
    projectPath: null,
    namedProjectId: projectId,
    sourceProject: {
      id: thread.projectId,
      name: thread.projectName,
      path: thread.projectPath
    },
    membershipReasons: [{ kind, inclusionId, revisionId: uuid(100) }]
  });
  const named = group(
    projectId,
    "Koed",
    [
      member(one, "repository", gitRule.inclusionId),
      member(two, "repository", gitRule.inclusionId),
      member(direct, "session", inclusion.inclusionId),
      member(note, "folder", folderRule.inclusionId)
    ],
    {
      namedProject: {
        projectId,
        name: "Koed",
        version: 1,
        headRevisionId: uuid(20),
        deletedAt: null,
        createdAt,
        updatedAt: createdAt
      },
      projectReference: { ownerUserId, projectId },
      inclusionRules: [gitRule, folderRule],
      directInclusions: [inclusion]
    }
  );
  const sourceFolder = (
    context: PersonalFolderContext,
    threads: PersonalDesktopProjectThread[]
  ) =>
    group(
      personalFolderScopeId(context.reference),
      context.normalizedPath.split("/").at(-1)!,
      threads.map((thread) => ({
        ...thread,
        folderSelection: context.reference,
        sourceProject: {
          id: thread.projectId,
          name: thread.projectName,
          path: thread.projectPath
        },
        projectId: personalFolderScopeId(context.reference),
        projectName: context.normalizedPath,
        projectPath: context.normalizedPath
      })),
      { folder: context, path: context.normalizedPath }
    );
  const groups = [
    group(repositoryScopeId(git), "koed", [one, two, excluded], {
      repository: git
    }),
    group(repositoryScopeId(otherGit), "research", [direct], {
      repository: otherGit
    }),
    group(repositoryScopeId(nonGit), "notes", [note], { repository: nonGit }),
    group("unassigned", "Unresolved history", [unresolved]),
    group(
      repositoryScopeId(independent.repositoryAssignment!.effective!),
      "Chats",
      [independent],
      { repository: independent.repositoryAssignment!.effective! }
    ),
    sourceFolder(first, [one, excluded, direct]),
    sourceFolder(second, [two]),
    sourceFolder(notes, [note]),
    named
  ];
  const metadata: PersonalDesktopProjectMetadata[] = [
    {
      schemaVersion: 1,
      discoveredAt: createdAt,
      lastSeenAt: createdAt,
      localProjectId: "lp_fixture_local",
      displayName: "koed",
      contextKind: "project",
      repository: git,
      path: { cwd: first.normalizedPath, projectRoot: first.normalizedPath }
    },
    {
      schemaVersion: 1,
      discoveredAt: createdAt,
      lastSeenAt: createdAt,
      localProjectId: "lp_fixture_independent",
      displayName: "Chats",
      contextKind: "independent",
      repository: independent.repositoryAssignment!.effective!,
      path: { cwd: "/local/independent", projectRoot: "/local/independent" }
    }
  ];
  const localFolders: PersonalFolderObservation[] = [first, notes].map(
    (folder) => ({
      identity: {
        folderId: folder.reference.folderId,
        originatingDeploymentId: folder.reference.originatingDeploymentId,
        originatingDeviceId: folder.reference.originatingDeviceId,
        originatingProfileId: folder.reference.originatingProfileId,
        directoryIncarnationId: folder.reference.directoryIncarnationId
      },
      normalizedPath: folder.normalizedPath,
      capturedPath: folder.capturedPath,
      observedAt: createdAt
    })
  );
  const projects = mergeProjectSources(groups, metadata);
  const inventory = {
    ...partitionPersonalInventory(projects),
    localCheckouts: metadata,
    localFolders,
    reconciliationPending: false
  };
  return {
    ownerUserId,
    projectId,
    git,
    otherGit,
    first,
    second,
    notes,
    groups,
    metadata,
    localFolders,
    inventory,
    project: projects.find((group) => group.id === projectId)!,
    threads: { one, two, excluded, direct, note, unresolved, independent }
  };
};
