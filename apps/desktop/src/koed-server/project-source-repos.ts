import { discoverProjectMetadata } from "@koed-labs/server";

/** The stored remote identity comes from trusted local Git discovery, never from remote credentials. */
export async function discoverProjectSourceRepos(
  paths: Parameters<typeof discoverProjectMetadata>[0],
  folderPath: string
) {
  const discovered = await discoverProjectMetadata(paths, { cwd: folderPath });
  const remotes = discovered.project?.git?.remotes ?? [];
  return [
    ...new Map(
      remotes
        .filter((remote) => remote.display)
        .map((remote) => [
          remote.display!,
          { name: remote.display!, uri: remote.display! }
        ])
    ).values()
  ];
}
