import { statSync } from "node:fs";
import path from "node:path";
import {
  discoverProjectMetadata,
  listProjectMetadata,
  resolveKoedServerPaths
} from "@koed-labs/server";
import {
  repositoryRecallContextSchema,
  repositoryScopeId,
  type RepositoryIdentity
} from "@koed/shared";

export const pinRepositoryRecallContext = async <
  Input extends {
    search_domain: string;
    project_id?: string;
    repository_context?: RepositoryIdentity;
  }
>(
  input: Input,
  caller: { cwd: string },
  environment: NodeJS.ProcessEnv
): Promise<Input & { repository_context?: RepositoryIdentity }> => {
  if (input.search_domain !== "project") return input;
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
  const target = resolveRequestedProjectRoot(input, caller, environment);
  try {
    if (!statSync(target).isDirectory())
      throw new Error("Project target is not a directory");
  } catch {
    throw Object.assign(
      new Error("Requested Project directory is unavailable"),
      {
        statusCode: 400,
        memoryAnswerTaskErrorCode: "invalid_project_scope",
        retryable: false
      }
    );
  }
  const context = (await discoverProjectMetadata(paths, { cwd: target }))
    .project?.repository;
  if (!context || context.kind === "unresolved" || !context.key)
    throw Object.assign(
      new Error(
        `Project identity is unresolved (${context?.reason ?? "missing"})`
      ),
      {
        statusCode: 400,
        memoryAnswerTaskErrorCode: "invalid_project_scope",
        retryable: false
      }
    );
  return {
    ...input,
    project_id: repositoryScopeId(context),
    repository_context: context
  };
};

export const resolveRequestedProjectRoot = (
  input: { project_id?: string; repository_context?: RepositoryIdentity },
  caller: { cwd: string },
  environment: NodeJS.ProcessEnv
): string => {
  if (input.repository_context?.root) return input.repository_context.root;
  const paths = resolveKoedServerPaths(environment);
  let target = input.project_id ?? caller.cwd;
  if (
    input.project_id &&
    !path.isAbsolute(input.project_id) &&
    !path.win32.isAbsolute(input.project_id)
  ) {
    const catalogued = (listProjectMetadata(paths).projects ?? []).filter(
      (project) =>
        project.localProjectId === input.project_id ||
        (project.repository?.kind !== "unresolved" &&
          project.repository?.key &&
          repositoryScopeId(project.repository) === input.project_id)
    );
    const roots = new Set(
      catalogued.map((project) => project.path.projectRoot ?? project.path.cwd)
    );
    if (
      !catalogued.length ||
      (roots.size > 1 && !input.project_id.startsWith("repository:"))
    )
      throw Object.assign(
        new Error("Requested Project could not be resolved"),
        {
          statusCode: 400,
          memoryAnswerTaskErrorCode: "invalid_project_scope",
          retryable: false
        }
      );
    target = catalogued[0]!.path.projectRoot ?? catalogued[0]!.path.cwd;
  }
  return path.isAbsolute(target) || path.win32.isAbsolute(target)
    ? target
    : path.resolve(target);
};
