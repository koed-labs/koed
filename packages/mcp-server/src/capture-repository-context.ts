import {
  discoverProjectMetadata,
  observeCaptureFolder,
  readSourceFolderObservation,
  readCurrentSourceFolderObservation,
  pinSourceFolderObservation,
  readOrSealSourceFolderContext,
  resolveKoedServerPaths
} from "@koed-labs/server";
import type { RepositoryIdentity } from "@koed-labs/shared";
import { unresolvedHistoricalRepositoryIdentity } from "./historical-repository-context.js";

export const resolveCaptureFolderObservation = async (input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  sourceKind: "codex" | "claude-code" | "pi";
  externalSessionId: string;
  newConversation: boolean;
}) => {
  const paths = resolveKoedServerPaths(input.env);
  const observation = await observeCaptureFolder(paths, input.cwd, input.env);
  const repository = input.newConversation
    ? await resolveCaptureRepositoryIdentity(input)
    : undefined;
  pinSourceFolderObservation(
    paths,
    input,
    observation,
    input.newConversation,
    repository
  );
  return readSourceFolderObservation(paths, input);
};

export const recordedCaptureFolderObservation = (input: {
  sourceKind: "codex" | "claude-code" | "pi";
  externalSessionId: string;
  env: NodeJS.ProcessEnv;
}) => readSourceFolderObservation(resolveKoedServerPaths(input.env), input);

export const currentCaptureFolderObservation = (input: {
  sourceKind: "codex" | "claude-code" | "pi";
  externalSessionId: string;
  env: NodeJS.ProcessEnv;
}) =>
  readCurrentSourceFolderObservation(resolveKoedServerPaths(input.env), input);

export const piCaptureRegistrationContext = (
  externalSessionId: string,
  env: NodeJS.ProcessEnv
) => {
  const context = readOrSealSourceFolderContext(resolveKoedServerPaths(env), {
    sourceKind: "pi",
    externalSessionId
  });
  return {
    folderObservation: context.original ?? undefined,
    currentFolderObservation: context.latest ?? undefined,
    repositoryIdentity:
      context.originalRepository ?? unresolvedHistoricalRepositoryIdentity()
  };
};

/** Resolve an explicit capture target; never substitute the caller's cwd. */
export const resolveCaptureRepositoryIdentity = async (input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<RepositoryIdentity | undefined> =>
  (
    await discoverProjectMetadata(resolveKoedServerPaths(input.env), {
      cwd: input.cwd
    })
  ).project?.repository;
