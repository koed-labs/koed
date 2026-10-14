import {
  discoverProjectMetadata,
  resolveKoedServerPaths
} from "@koed-labs/server";
import type { RepositoryIdentity } from "@koed/shared";

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
