import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  discoverProjectMetadata,
  createGitProjectProbe,
  listProjectMetadata,
  observeCaptureFolder,
  type KoedServerPaths
} from "@koed-labs/server";
import { inspectDeviceIdentityAtKoedHome } from "@koed/shared";
import { repositoryScopeId } from "@koed/shared/repository-recall";
import {
  personalFolderRegistrySchema,
  readAvailablePersonalFolders
} from "@koed/shared/personal-local-folders";

/** Prepare a first launch from a known native checkout, never a history path.
 * An unavailable existing registration requires explicit inspection instead. */
export const prepareLocalExecutionFolder = async (
  paths: KoedServerPaths,
  localProjectId: string,
  environment: NodeJS.ProcessEnv = process.env
) => {
  const device = inspectDeviceIdentityAtKoedHome({
    koedHome: paths.koedHome,
    environment
  });
  if (!device.remoteOperationsAllowed)
    throw new Error("The native device identity is unavailable.");
  const metadata = (listProjectMetadata(paths).projects ?? []).find(
    (entry) => entry.localProjectId === localProjectId
  );
  if (
    !metadata ||
    !metadata.repository ||
    !["portable_repository", "device_local_repository"].includes(
      metadata.repository.kind
    )
  )
    throw new Error("A registered native Git checkout is required.");
  const path = resolve(metadata.path.projectRoot ?? metadata.path.cwd);
  const available = readAvailablePersonalFolders(
    paths.koedHome,
    environment
  ).find((folder) => folder.normalizedPath === path);
  if (available) return available;
  const registryPath = resolve(paths.configDir, "folder-contexts.json");
  const registry = existsSync(registryPath)
    ? personalFolderRegistrySchema.parse(
        JSON.parse(readFileSync(registryPath, "utf8"))
      )
    : null;
  if (registry?.directories.some((entry) => entry.normalizedPath === path))
    throw new Error(
      "This Folder registration is unavailable. Inspect the directory before using it again."
    );
  const expected = repositoryScopeId(metadata.repository);
  const current = (
    await discoverProjectMetadata(
      paths,
      { cwd: path },
      { probeGit: createGitProjectProbe({ ttlMs: 0 }) }
    )
  ).project;
  if (
    !current?.repository ||
    repositoryScopeId(current.repository) !== expected ||
    resolve(current.path.projectRoot ?? current.path.cwd) !== path ||
    (metadata.repository.kind === "portable_repository" &&
      !current.git?.remotes.some(
        (remote) => remote.fingerprint === metadata.repository!.key
      ))
  )
    throw new Error(
      "The checkout changed. Inspect the Project before starting a Conversation."
    );
  const folder = await observeCaptureFolder(paths, path, environment);
  if (!folder) throw new Error("The local Folder could not be verified.");
  return folder;
};
