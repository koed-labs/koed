import type { Command } from "commander";
import type { KoedServerCliDependencies } from "./cli-contract.js";
import { resolveKoedServerPaths } from "./paths.js";

interface ProjectOptions {
  json?: boolean;
  cwd?: string;
  codex?: boolean;
  localProjectId?: string;
  checkoutId?: string;
  remote?: string;
  reset?: boolean;
  projectRoot?: string;
  teamWorkspaceId?: string;
  backendId?: string;
  upstreamBackendId?: string;
  projectDisplayName?: string;
}

const required = (value: string | undefined, flag: string): string => {
  if (!value) throw new Error(`${flag} is required.`);
  return value;
};

export const registerProjectCommands = (
  program: Command,
  dependencies: KoedServerCliDependencies,
  complete: (code: number) => void
): void => {
  const project = program
    .command("project")
    .description("Manage local Project metadata");
  project.action(() => project.outputHelp());
  const discover = project
    .command("discover")
    .description("Discover and store local Project metadata")
    .option(
      "--cwd <path>",
      "Folder to inspect; defaults to the current directory"
    )
    .option("--codex", "Record Codex as the AI Client source");
  const list = project
    .command("list")
    .description("List discovered local Projects");
  const show = project
    .command("show")
    .description("Show Project metadata for a Folder")
    .option(
      "--cwd <path>",
      "Folder to inspect; defaults to the current directory"
    );
  const forget = project
    .command("forget")
    .description("Forget discovered local Project metadata")
    .option("--local-project-id <id>", "Local Project identifier");
  const anchor = project
    .command("anchor")
    .description("Select or reset a Project Git Anchor")
    .option("--local-project-id <id>", "Local Project identifier")
    .option("--checkout-id <id>", "Expected checkout identifier")
    .option("--remote <name>", "Git remote to select")
    .option("--reset", "Reset the selected remote");
  const team = program
    .command("team")
    .description("Manage local Team Workspace links");
  team.action(() => team.outputHelp());
  const workspace = team
    .command("workspace")
    .description("Manage Project links to Team Workspaces");
  workspace.action(() => workspace.outputHelp());
  const link = workspace
    .command("link")
    .description("Link a Project root to a Team Workspace")
    .option("--project-root <path>", "Local Project root")
    .option("--team-workspace-id <id>", "Team Workspace identifier")
    .option("--backend-id <id>", "Registered backend identifier")
    .option(
      "--upstream-backend-id <id>",
      "Compatibility alias for backend selection"
    )
    .option("--local-project-id <id>", "Local Project identifier")
    .option("--project-display-name <name>", "Local Project display name");
  const links = workspace
    .command("list")
    .description("List local Project links to Team Workspaces");
  const linked = workspace
    .command("show")
    .description("Show the Workspace link for a Project root")
    .option("--project-root <path>", "Local Project root");
  const unlink = workspace
    .command("remove")
    .description("Remove a local Project link to a Team Workspace")
    .option("--project-root <path>", "Local Project root");

  for (const command of [
    discover,
    list,
    show,
    forget,
    anchor,
    link,
    links,
    linked,
    unlink
  ])
    command
      .option("--json", "Emit JSON output")
      .action(async (options: ProjectOptions) => {
        const stdout = dependencies.stdout ?? process.stdout;
        const stderr = dependencies.stderr ?? process.stderr;
        try {
          const paths = (dependencies.resolvePaths ?? resolveKoedServerPaths)();
          let result: { ok: boolean; message: string };
          if (command === discover) {
            const execute =
              dependencies.discoverProjectMetadata ??
              (await import("./project-metadata.js")).discoverProjectMetadata;
            result = await execute(paths, {
              cwd: options.cwd ?? process.cwd(),
              aiClientSource: options.codex ? "codex" : undefined
            });
          } else if (command === list) {
            const execute =
              dependencies.listProjectMetadata ??
              (await import("./project-metadata.js")).listProjectMetadata;
            result = execute(paths);
          } else if (command === show) {
            const execute =
              dependencies.getProjectMetadataForCwd ??
              (await import("./project-metadata.js")).getProjectMetadataForCwd;
            result = execute(paths, options.cwd ?? process.cwd());
          } else if (command === forget) {
            const execute =
              dependencies.forgetProjectMetadata ??
              (await import("./project-metadata.js")).forgetProjectMetadata;
            result = execute(
              paths,
              required(options.localProjectId, "--local-project-id")
            );
          } else if (command === anchor) {
            const { setProjectRepositoryAnchor } =
              await import("./project-metadata.js");
            result = await setProjectRepositoryAnchor(paths, {
              localProjectId: required(
                options.localProjectId,
                "--local-project-id"
              ),
              expectedCheckoutId: required(options.checkoutId, "--checkout-id"),
              remoteName: options.reset
                ? null
                : required(options.remote, "--remote")
            });
          } else if (command === link) {
            const execute =
              dependencies.linkProjectTeamWorkspace ??
              (await import("./project-team-workspace-links.js"))
                .linkProjectTeamWorkspace;
            result = execute(paths, {
              projectRoot: required(options.projectRoot, "--project-root"),
              teamWorkspaceId: required(
                options.teamWorkspaceId,
                "--team-workspace-id"
              ),
              backendId: options.backendId ?? options.upstreamBackendId,
              localProjectId: options.localProjectId,
              projectDisplayName: options.projectDisplayName
            });
          } else if (command === links) {
            const execute =
              dependencies.listProjectTeamWorkspaceLinks ??
              (await import("./project-team-workspace-links.js"))
                .listProjectTeamWorkspaceLinks;
            result = execute(paths);
          } else if (command === linked) {
            const execute =
              dependencies.getProjectTeamWorkspaceLink ??
              (await import("./project-team-workspace-links.js"))
                .getProjectTeamWorkspaceLink;
            result = execute(
              paths,
              required(options.projectRoot, "--project-root")
            );
          } else {
            const execute =
              dependencies.removeProjectTeamWorkspaceLink ??
              (await import("./project-team-workspace-links.js"))
                .removeProjectTeamWorkspaceLink;
            result = execute(
              paths,
              required(options.projectRoot, "--project-root")
            );
          }
          stdout.write(
            options.json
              ? `${JSON.stringify(result, null, 2)}\n`
              : `${result.message}\n`
          );
          complete(result.ok ? 0 : 1);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (options.json)
            stdout.write(
              `${JSON.stringify({ ok: false, error: message }, null, 2)}\n`
            );
          else stderr.write(`${message}\n`);
          complete(1);
        }
      });
};
