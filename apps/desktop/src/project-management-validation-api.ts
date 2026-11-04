/** Deterministic, isolated data for browser/integration validation. This module
 * is never imported by the packaged application entry. PostgreSQL semantics are
 * independently covered by personal-conversation-organization.test.ts. */
import {
  personalConversationOrganizationInputSchema,
  personalConversationOrganizationResultSchema,
  personalProjectCommandResultSchema,
  personalSourceContextCommandResultSchema
} from "@koed/shared/personal-desktop";
import type {
  PersonalFolderContext,
  PersonalGitContext,
  PersonalNamedProject,
  PersonalProjectExclusion,
  PersonalProjectMembershipExplanation,
  PersonalProjectRule,
  PersonalSourceContextState,
  PersonalSourceCorrectionInput
} from "@koed/shared";
import {
  personalFolderScopeId,
  personalRecallTargetsEqual,
  type PersonalDesktopApi,
  type PersonalDesktopProject,
  type PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
import { repositoryScopeId } from "@koed/shared/repository-recall";

export const validationId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-11-04T12:00:00.000Z";
export const validationOwner = validationId(999);
type Project = {
  meta: PersonalNamedProject;
  rules: PersonalProjectRule[];
  direct: Map<string, { id: string; revision: string }>;
  exclusions: Map<string, PersonalProjectExclusion>;
};
const effective = <T>(assignment: {
  original: T;
  correction: { state: "original" } | { state: "corrected"; value: T };
}) =>
  assignment.correction.state === "original"
    ? assignment.original
    : assignment.correction.value;

export function createProjectManagementValidationApi() {
  let sequence = 1000;
  const next = () => validationId(++sequence);
  const git: PersonalGitContext[] = ["koed", "koed-voice"].map(
    (name, index) => ({
      kind: "portable_repository",
      key: `gr_validation_${index}`,
      root: `/code/${name}`,
      branch: "main",
      reason: "origin",
      checkoutId: `checkout_${index}`,
      originatingDeviceId: "this-mac",
      selectedRemote: "origin",
      anchorDisplay: `github.com/koed-labs/${name}`
    })
  );
  const folders: PersonalFolderContext[] = ["koed-desktop", "koed-voice"].map(
    (name, index) => ({
      reference: {
        ownerUserId: validationOwner,
        folderId: `folder_${index}`,
        originatingDeploymentId: "validation",
        originatingDeviceId: "this-mac",
        originatingProfileId: "personal",
        directoryIncarnationId: `directory_${index}`
      },
      normalizedPath: `/code/${name}`,
      capturedPath: `/code/${name}`
    })
  );
  const names = [
    "A calmer sidebar for Koed",
    "Refine the settings popup",
    "Conversation loading states",
    "Verify the native installer",
    "Explore push-to-talk",
    "Compare recall quality",
    "Review the Android build",
    "Draft November release notes",
    "Notes on personal knowledge"
  ];
  const contexts = new Map<string, PersonalSourceContextState>();
  const threads: PersonalDesktopProjectThread[] = names.map((name, index) => {
    const sessionId = validationId(100 + index),
      voice = index === 4 || index === 6,
      source = voice ? 1 : 0;
    contexts.set(sessionId, {
      sessionId,
      logicalSessionId: validationId(200 + index),
      git: {
        revision: 1,
        original:
          index === 8
            ? { state: "unresolved", reason: "historical_unresolved" }
            : { state: "known", value: git[source]! },
        correction: { state: "original" }
      },
      folder: {
        revision: 1,
        original:
          index === 8
            ? { state: "unresolved", reason: "historical_unresolved" }
            : { state: "known", value: folders[source]! },
        correction: { state: "original" }
      }
    });
    return {
      id: `capture-${index}`,
      sessionId,
      name,
      sourceAiClient:
        index % 3 === 0 ? "codex" : index % 3 === 1 ? "claude-code" : "pi",
      originDevice: { id: "this-mac", name: "This Mac" },
      sourceReferences: [
        {
          sessionId,
          logicalSessionId: validationId(200 + index),
          logicalMemoryId: null
        }
      ],
      projectId: `source-${source}`,
      projectName: voice ? "koed-voice" : "koed",
      projectPath: git[source]!.root,
      capturedCwd: folders[source]!.capturedPath,
      projectAssignmentSource: "detected",
      eventCount: 2,
      invalidatedCount: 0,
      latestAt: new Date(Date.now() - (index + 1) * 120000).toISOString(),
      sample: "Conversation history",
      presentation: null
    };
  });
  for (const [id, context] of contexts)
    contexts.set(
      id,
      personalSourceContextCommandResultSchema.parse({ context }).context
    );
  const projects = new Map<string, Project>();
  const add = (name: string, id = next()) => {
    const p: Project = {
      meta: {
        projectId: id,
        name,
        version: 1,
        headRevisionId: next(),
        deletedAt: null,
        createdAt: at,
        updatedAt: at
      },
      rules: [],
      direct: new Map(),
      exclusions: new Map()
    };
    projects.set(id, p);
    return p;
  };
  const rule = (p: Project, target: PersonalProjectRule["target"]) =>
    p.rules.push({
      inclusionId: next(),
      projectId: p.meta.projectId,
      target,
      version: 1,
      headRevisionId: next(),
      removedAt: null
    });
  const direct = (p: Project, sessionId: string) => {
    if (!p.direct.has(sessionId))
      p.direct.set(sessionId, { id: next(), revision: next() });
  };
  const desktop = add("Desktop experience", validationId(1));
  for (const index of [0, 1, 2, 3, 4])
    direct(desktop, threads[index]!.sessionId!);
  const koed = add("koed", validationId(2));
  rule(koed, { kind: "repository", repository: git[0]! });
  const voice = add("Voice exploration", validationId(3));
  rule(voice, { kind: "folder", folder: folders[1]!.reference });
  const release = add("November release", validationId(4));
  for (const index of [3, 7]) direct(release, threads[index]!.sessionId!);
  const check = (p: Project | undefined, version?: number): Project => {
    if (!p || p.meta.deletedAt)
      throw new Error("Project is no longer available.");
    if (version !== undefined && version !== p.meta.version)
      throw new Error("Project changed. Reopen to review again.");
    return p;
  };
  const bump = (p: Project) => {
    p.meta = { ...p.meta, version: p.meta.version + 1, headRevisionId: next() };
  };
  const explain = (
    p: Project,
    sessionId: string,
    override?: PersonalSourceContextState
  ): PersonalProjectMembershipExplanation => {
    const context = override ?? contexts.get(sessionId);
    if (!context) throw new Error("Conversation unavailable.");
    const g = effective(context.git),
      f = effective(context.folder),
      d = p.direct.get(sessionId);
    const reasons: PersonalProjectMembershipExplanation["reasons"] = d
      ? [{ kind: "session", inclusionId: d.id, revisionId: d.revision }]
      : [];
    for (const r of p.rules)
      if (
        !r.removedAt &&
        (r.target.kind === "folder"
          ? f.state === "known" &&
            personalRecallTargetsEqual(r.target, {
              kind: "folder",
              folder: f.value.reference
            })
          : g.state === "known" &&
            personalRecallTargetsEqual(r.target, {
              kind: "repository",
              repository: g.value
            }))
      )
        reasons.push({
          kind: r.target.kind,
          inclusionId: r.inclusionId,
          revisionId: r.headRevisionId
        });
    const exclusion = p.exclusions.get(sessionId) ?? null;
    return {
      sessionId,
      logicalSessionId: context.logicalSessionId,
      reasons,
      exclusion,
      included: reasons.length > 0 && !exclusion
    };
  };
  const named = (p: Project): PersonalDesktopProject => ({
    id: p.meta.projectId,
    name: p.meta.name,
    path: null,
    eventCount: 0,
    ownerUserId: validationOwner,
    namedProject: structuredClone(p.meta),
    projectReference: {
      ownerUserId: validationOwner,
      projectId: p.meta.projectId
    },
    inclusionRules: structuredClone(p.rules),
    directInclusions: [...p.direct].map(([sessionId, d]) => ({
      inclusionId: d.id,
      projectId: p.meta.projectId,
      logicalSessionId: contexts.get(sessionId)!.logicalSessionId,
      sourceReference: null,
      version: 1,
      headRevisionId: d.revision,
      removedAt: null
    })),
    threads: threads
      .filter((t) => explain(p, t.sessionId!).included)
      .map((t) => ({
        ...t,
        id: `${p.meta.projectId}:${t.id}`,
        namedProjectId: p.meta.projectId,
        projectId: p.meta.projectId,
        projectName: p.meta.name,
        sourceProject: {
          id: t.projectId,
          name: t.projectName,
          path: t.projectPath
        },
        sourceThreadId: t.id,
        membershipReasons: explain(p, t.sessionId!).reasons
      }))
  });
  const inventory = (): PersonalDesktopProject[] => [
    ...[...projects.values()].filter((p) => !p.meta.deletedAt).map(named),
    ...git.map((repository, index) => ({
      id: repositoryScopeId(repository),
      name: index ? "koed-voice" : "koed",
      path: repository.root,
      repository,
      eventCount: 0,
      threads: threads.filter((t) => {
        const g = effective(contexts.get(t.sessionId!)!.git);
        return g.state === "known" && g.value.key === repository.key;
      })
    })),
    ...folders.map((folder) => ({
      id: personalFolderScopeId(folder.reference),
      name: folder.normalizedPath.split("/").pop()!,
      path: folder.normalizedPath,
      folder,
      eventCount: 0,
      threads: threads.filter((t) => {
        const f = effective(contexts.get(t.sessionId!)!.folder);
        return (
          f.state === "known" &&
          f.value.reference.folderId === folder.reference.folderId
        );
      })
    })),
    {
      id: "unassigned",
      name: "Without a Project",
      path: null,
      eventCount: 0,
      threads: threads.filter((t) => {
        const c = contexts.get(t.sessionId!)!;
        return (
          effective(c.git).state !== "known" &&
          effective(c.folder).state !== "known"
        );
      })
    }
  ];
  const correct = (
    context: PersonalSourceContextState,
    input: PersonalSourceCorrectionInput
  ) => {
    if (context[input.axis].revision !== input.expectedVersion)
      throw new Error("Source context changed.");
    const revision = input.expectedVersion + 1;
    if (input.action === "reset")
      context[input.axis] = {
        ...context[input.axis],
        revision,
        correction: { state: "original" }
      } as never;
    else if (input.action === "unresolved")
      context[input.axis] = {
        ...context[input.axis],
        revision,
        correction: {
          state: "corrected",
          revisionId: next(),
          value: { state: "unresolved", reason: "explicit_unresolved" }
        }
      } as never;
    else if (input.action === "set" && input.axis === "git")
      context.git = {
        ...context.git,
        revision,
        correction: {
          state: "corrected",
          revisionId: next(),
          value: { state: "known", value: input.repository }
        }
      };
    else if (input.action === "set" && input.axis === "folder")
      context.folder = {
        ...context.folder,
        revision,
        correction: {
          state: "corrected",
          revisionId: next(),
          value: {
            state: "known",
            value: folders.find(
              (f) => f.reference.folderId === input.folder.folderId
            )!
          }
        }
      };
  };
  const normalizeContexts = () => {
    for (const [id, context] of contexts)
      contexts.set(
        id,
        personalSourceContextCommandResultSchema.parse({ context }).context
      );
  };
  const exclude = (p: Project, sessionId: string) =>
    p.exclusions.set(sessionId, {
      projectId: p.meta.projectId,
      logicalSessionId: contexts.get(sessionId)!.logicalSessionId,
      exclusionId: next(),
      headRevisionId: next(),
      version: 1,
      sourceReference: null,
      clearedAt: null
    });
  const requests = new Map<string, string>();
  const api: PersonalDesktopApi = {
    listProjects: async () => structuredClone(inventory()),
    listNamedProjects: async () =>
      structuredClone(
        [...projects.values()].filter((p) => !p.meta.deletedAt).map(named)
      ),
    listLocalFolders: async () => [],
    listProjectMetadata: async () => [],
    projectStatus: async () => ({ reconciliationPending: false }),
    subscribe: () => () => {},
    updateSessionTitle: async ({ sessionId, title }) => {
      threads.find((t) => t.sessionId === sessionId)!.name = title;
      return { title };
    },
    updateSessionPresentation: async () => {
      throw new Error("Not part of this validation scenario.");
    },
    loadEventPage: async () => [
      {
        id: validationId(501),
        actor: "user",
        eventType: "user_message",
        timestamp: at,
        sourceEventTime: null,
        sourceSequence: 1,
        content:
          "Can we bring the project management features into the sidebar?",
        contentPreview: "",
        invalidatedAt: null,
        metadata: {}
      },
      {
        id: validationId(502),
        actor: "assistant",
        eventType: "agent_message",
        timestamp: at,
        sourceEventTime: null,
        sourceSequence: 2,
        content:
          "The sidebar is ready for review.\n\nThis is the app’s real conversation timeline. Open Project settings or move this Conversation to try the management flow.",
        contentPreview: "",
        invalidatedAt: null,
        metadata: {}
      }
    ],
    createProject: async ({ name, requestId }) => {
      if (requestId && requests.has(requestId))
        return { projectId: requests.get(requestId)! };
      const p = add(name);
      if (requestId) requests.set(requestId, p.meta.projectId);
      return { projectId: p.meta.projectId };
    },
    manageProject: async (input) => {
      const p = check(projects.get(input.projectId), input.expectedVersion);
      if (input.action === "explain_session")
        return personalProjectCommandResultSchema.parse({
          project: p.meta,
          explanation: explain(p, input.sessionId)
        });
      if (
        input.action === "preview_repository" ||
        input.action === "preview_folder"
      ) {
        const target =
          input.action === "preview_folder"
            ? { kind: "folder" as const, folder: input.folder }
            : { kind: "repository" as const, repository: input.repository };
        const candidate = {
          ...p,
          rules: [
            {
              inclusionId: next(),
              headRevisionId: next(),
              version: 1,
              projectId: p.meta.projectId,
              removedAt: null,
              target
            }
          ],
          direct: new Map(),
          exclusions: new Map()
        };
        return {
          project: structuredClone(p.meta),
          preview: {
            target,
            conversations: threads
              .filter((t) => explain(candidate, t.sessionId!).included)
              .map((t) => ({
                sessionId: t.sessionId!,
                logicalSessionId: contexts.get(t.sessionId!)!.logicalSessionId,
                name: t.name
              }))
          }
        };
      }
      const changes =
        input.action === "apply_sources" ? input.changes : [input];
      const before = structuredClone(p);
      try {
        for (const change of changes) {
          if (change.action === "rename") p.meta.name = change.name;
          else if (change.action === "delete") p.meta.deletedAt = at;
          else if (change.action === "add_repository")
            rule(p, { kind: "repository", repository: change.repository });
          else if (change.action === "add_folder")
            rule(p, { kind: "folder", folder: change.folder });
          else if (change.action === "remove_rule")
            p.rules = p.rules.filter(
              (r) => r.inclusionId !== change.inclusionId
            );
          else if (change.action === "remove_inclusion")
            for (const [sid, d] of p.direct) {
              if (d.id === change.inclusionId) p.direct.delete(sid);
            }
          else if (change.action === "exclude_session")
            exclude(p, change.sessionId);
          else if (change.action === "add_session") {
            if (p.exclusions.has(change.sessionId))
              throw new Error("Restore the exclusion first.");
            direct(p, change.sessionId);
          } else if (change.action === "add_back") {
            const e = p.exclusions.get(change.sessionId);
            if (e?.headRevisionId !== change.expectedExclusionRevisionId)
              throw new Error("Exclusion changed.");
            p.exclusions.delete(change.sessionId);
            direct(p, change.sessionId);
          }
          bump(p);
        }
      } catch (error) {
        projects.set(p.meta.projectId, before);
        throw error;
      }
      return { project: structuredClone(p.meta) };
    },
    manageSourceContext: async (input) => {
      normalizeContexts();
      const context = contexts.get(input.sessionId);
      if (!context) throw new Error("Conversation unavailable.");
      if (input.action === "get") return { context: structuredClone(context) };
      if (input.action === "preview") {
        const after = structuredClone(context);
        correct(after, input.correction);
        return {
          context: structuredClone(context),
          preview: {
            reviewId: next(),
            axis: input.correction.axis,
            expectedVersion: input.correction.expectedVersion,
            before: structuredClone(context),
            after,
            projects: [...projects.values()]
              .filter((p) => !p.meta.deletedAt)
              .map((p) => ({
                projectId: p.meta.projectId,
                name: p.meta.name,
                version: p.meta.version,
                beforeReasons: explain(p, input.sessionId).reasons,
                afterReasons: explain(p, input.sessionId, after).reasons,
                beforeIncluded: explain(p, input.sessionId).included,
                afterIncluded: explain(p, input.sessionId, after).included
              }))
          }
        };
      }
      if (input.action !== "organize")
        throw new Error("This fixture uses atomic organization.");
      const edit = personalConversationOrganizationInputSchema.parse(
        input.edit
      );
      if (JSON.stringify(context) !== JSON.stringify(edit.expectedContext))
        throw new Error("Source context changed. Review again.");
      const reviewed = edit.reviewedProjects.map((p) =>
        check(projects.get(p.projectId), p.expectedVersion)
      );
      if (
        edit.corrections.length &&
        reviewed.length !==
          [...projects.values()].filter((p) => !p.meta.deletedAt).length
      )
        throw new Error("Project catalog changed.");
      const snapshot = () => ({
        context: structuredClone(contexts.get(input.sessionId)!),
        projects: reviewed.map((p) => ({
          project: structuredClone(p.meta),
          explanation: explain(p, input.sessionId)
        }))
      });
      const before = snapshot(),
        backup = structuredClone(projects);
      try {
        for (const correction of edit.corrections) correct(context, correction);
        for (const desired of edit.memberships) {
          const p = projects.get(desired.projectId)!,
            exclusion = p.exclusions.get(input.sessionId);
          if (
            exclusion &&
            !desired.excluded &&
            exclusion.headRevisionId !==
              desired.restoreExclusion?.expectedExclusionRevisionId
          )
            throw new Error("Exclusion changed.");
          if (desired.excluded) {
            if (!exclusion) exclude(p, input.sessionId);
          } else p.exclusions.delete(input.sessionId);
          if (desired.direct) direct(p, input.sessionId);
          else p.direct.delete(input.sessionId);
          bump(p);
        }
      } catch (error) {
        contexts.set(input.sessionId, before.context);
        projects.clear();
        for (const [id, p] of backup) projects.set(id, p);
        throw error;
      }
      const organization = personalConversationOrganizationResultSchema.parse({
        before,
        after: snapshot()
      });
      return { context: organization.after.context, organization };
    },
    manageMembershipSync: async (input) => {
      const p = check(projects.get(input.projectId));
      if (input.action !== "list")
        throw new Error("No sync conflicts in this scenario.");
      return {
        state: {
          project: structuredClone(p.meta),
          projectIdentity: p.meta.projectId,
          catalog: {
            entityId: p.meta.projectId,
            entityKind: "project",
            state: "available",
            source: null,
            heads: [
              {
                version: 1,
                project: {
                  ownerUserId: validationOwner,
                  projectId: p.meta.projectId
                },
                entityId: p.meta.projectId,
                revisionId: p.meta.headRevisionId,
                authorDeviceId: "this-mac",
                replaces: [],
                operation: { kind: "set_project", name: p.meta.name }
              }
            ]
          },
          memberships: [...p.exclusions].map(([sessionId, e]) => ({
            entityId: e.exclusionId,
            entityKind: "exclusion",
            state: "available",
            source: {
              ready: true,
              localSessionId: sessionId,
              reference: {
                ownerUserId: validationOwner,
                logicalSessionId: contexts.get(sessionId)!.logicalSessionId,
                originatingDeploymentId: "validation",
                originatingDeviceId: "this-mac"
              }
            },
            heads: [
              {
                version: 1,
                project: {
                  ownerUserId: validationOwner,
                  projectId: p.meta.projectId
                },
                entityId: e.exclusionId,
                revisionId: e.headRevisionId,
                authorDeviceId: "this-mac",
                replaces: [],
                operation: {
                  kind: "exclude",
                  source: {
                    ownerUserId: validationOwner,
                    logicalSessionId: contexts.get(sessionId)!.logicalSessionId,
                    originatingDeploymentId: "validation",
                    originatingDeviceId: "this-mac"
                  }
                }
              }
            ]
          })),
          nextEntityId: null
        }
      };
    }
  };
  return { api, inventory, contexts, projects, threads };
}
