import {
  discoverProjectMetadata,
  observeCaptureFolder,
  readSourceFolderObservation,
  readCurrentSourceFolderObservation,
  pinSourceFolderObservation,
  resolveKoedServerPaths
} from "@koed-labs/server";
import type { RepositoryIdentity } from "@koed/shared";

export const resolveCaptureFolderObservation = async (input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  sourceKind: "codex" | "claude-code" | "pi";
  externalSessionId: string;
  newConversation: boolean;
}) => {
  const paths = resolveKoedServerPaths(input.env);
  const observation = await observeCaptureFolder(paths, input.cwd, input.env);
  pinSourceFolderObservation(paths, input, observation, input.newConversation);
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
