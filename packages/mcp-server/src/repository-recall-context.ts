import { statSync } from "node:fs";
import path from "node:path";
import {
  discoverProjectMetadata,
  listProjectMetadata,
  listNamedProjects,
  resolveKoedServerPaths
} from "@koed-labs/server";
import {
  repositoryIdentitySchema,
  repositoryRecallContextSchema,
  repositoryScopeId,
  type RepositoryIdentity
} from "@koed/shared";

export const pinRepositoryRecallContext = async <
  Input extends {
    search_domain: string;
    project_id?: string;
    repository_context?: RepositoryIdentity | null;
  }
>(
  input: Input,
  caller: { cwd: string },
  environment: NodeJS.ProcessEnv
): Promise<Input & { repository_context?: RepositoryIdentity | null }> => {
  if (input.search_domain === "global") {
    // Null is an explicit, durable unknown context; retries must not discover the worker cwd.
    if (input.repository_context !== undefined)
      return {
        ...input,
        repository_context:
          input.repository_context === null
            ? null
            : repositoryIdentitySchema.parse(input.repository_context)
      };
    try {
      const pinned = await pinRepositoryRecallContext(
        { ...input, search_domain: "project", repository_context: undefined },
        caller,
        environment
      );
      return {
        ...input,
        repository_context: pinned.repository_context ?? null
      };
    } catch {
      // Global remains available when the caller's checkout cannot be resolved.
      return { ...input, repository_context: null };
    }
  }
  if (input.search_domain !== "project") return input;
  if (input.repository_context === null)
    throw Object.assign(
      new Error("Project recall requires a resolved repository context"),
      { statusCode: 400 }
    );
  if (input.repository_context) {
    const context = repositoryRecallContextSchema.parse(
      input.repository_context
    );
    const scope = repositoryScopeId(context);
    if (
      input.project_id &&
      input.project_id !== scope &&
      input.project_id !== context.root
    )
      throw Object.assign(
        new Error(
          "Project target does not match its pinned repository context"
        ),
        {
          statusCode: 400,
          memoryAnswerTaskErrorCode: "invalid_project_scope",
          retryable: false
        }
      );
    return { ...input, project_id: scope, repository_context: context };
  }
  const paths = resolveKoedServerPaths(environment);
  const named = input.project_id
    ? listNamedProjects(paths).find(
        (project) =>
          project.id === input.project_id ||
          repositoryScopeId(project.repository) === input.project_id
      )
    : undefined;
  if (named)
    return {
      ...input,
      project_id: repositoryScopeId(named.repository),
      repository_context: named.repository
    };
  const target = resolveRequestedProjectRoot(input, caller, environment);
  // A repository scope can be catalogued at several checkouts. Use a live one
  // whose current identity still matches the requested scope.
  const requestedScope = input.project_id?.startsWith("repository:")
    ? input.project_id
    : undefined;
  const roots = [
    ...new Set([
      ...(target ? [target] : []),
      ...(requestedScope ? cataloguedProjectRoots(paths, requestedScope) : [])
    ])
  ].filter(isDirectory);
  const invalid = (message: string) =>
    Object.assign(new Error(message), {
      statusCode: 400,
      memoryAnswerTaskErrorCode: "invalid_project_scope",
      retryable: false
    });
  if (!roots.length)
    throw invalid("Requested Project directory is unavailable");
  let unresolvedReason: string | undefined;
  for (const root of roots) {
    const context = (await discoverProjectMetadata(paths, { cwd: root }))
      .project?.repository;
    if (!context || context.kind === "unresolved" || !context.key) {
      unresolvedReason ??= context?.reason ?? "missing";
      continue;
    }
    if (requestedScope && repositoryScopeId(context) !== requestedScope)
      continue;
    return {
      ...input,
      project_id: repositoryScopeId(context),
      repository_context: context
    };
  }
  throw invalid(
    unresolvedReason
      ? `Project identity is unresolved (${unresolvedReason})`
      : "Project target does not match its pinned repository context"
  );
};

const isDirectory = (root: string) => {
  try {
    return statSync(root).isDirectory();
  } catch {
    return false;
  }
};

/** Catalogued checkout roots for a Local Project id or repository scope, in catalog order. */
const cataloguedProjectRoots = (
  paths: ReturnType<typeof resolveKoedServerPaths>,
  projectId: string
) => [
  ...new Set(
    (listProjectMetadata(paths).projects ?? [])
      .filter(
        (project) =>
          project.localProjectId === projectId ||
          (project.repository?.kind !== "unresolved" &&
            project.repository?.key &&
            repositoryScopeId(project.repository) === projectId)
      )
      .map((project) => project.path.projectRoot ?? project.path.cwd)
  )
];

export const resolveRequestedProjectRoot = (
  input: {
    project_id?: string;
    repository_context?: RepositoryIdentity | null;
  },
  caller: { cwd: string },
  environment: NodeJS.ProcessEnv
): string | undefined => {
  // A named Project has no root and must not inherit a cwd-to-Team mapping.
  if (input.repository_context?.kind === "local_project") return undefined;
  if (input.repository_context?.root) return input.repository_context.root;
  const paths = resolveKoedServerPaths(environment);
  if (
    input.project_id &&
    listNamedProjects(paths).some(
      (project) =>
        project.id === input.project_id ||
        repositoryScopeId(project.repository) === input.project_id
    )
  )
    return undefined;
  let target = input.project_id ?? caller.cwd;
  if (
    input.project_id &&
    !path.isAbsolute(input.project_id) &&
    !path.win32.isAbsolute(input.project_id)
  ) {
    const roots = cataloguedProjectRoots(paths, input.project_id);
    if (
      !roots.length ||
      (roots.length > 1 && !input.project_id.startsWith("repository:"))
    )
      throw Object.assign(
        new Error("Requested Project could not be resolved"),
        {
          statusCode: 400,
          memoryAnswerTaskErrorCode: "invalid_project_scope",
          retryable: false
        }
      );
    target = roots.find(isDirectory) ?? roots[0]!;
  }
  return path.isAbsolute(target) || path.win32.isAbsolute(target)
    ? target
    : path.resolve(target);
};

/** The checkout that selects a Project's route, chosen only after its identity is verified. */
export const resolveVerifiedProjectRoot = async <
  Input extends {
    search_domain: string;
    project_id?: string;
    repository_context?: RepositoryIdentity | null;
  }
>(
  input: Input,
  caller: { cwd: string },
  environment: NodeJS.ProcessEnv
): Promise<{ pinned: Input; projectRoot: string | undefined }> => {
  const pinned = (await pinRepositoryRecallContext(
    input,
    caller,
    environment
  )) as Input;
  return {
    pinned,
    projectRoot:
      pinned.search_domain === "project"
        ? resolveRequestedProjectRoot(pinned, caller, environment)
        : undefined
  };
};
