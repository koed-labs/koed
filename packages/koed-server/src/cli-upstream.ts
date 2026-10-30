import type { Command } from "commander";
import type { KoedServerCliDependencies } from "./cli-contract.js";
import type { UpstreamRoutePolicyUpdate } from "./upstream-registry.js";
import { resolveKoedServerPaths } from "./paths.js";

const policyOptions = [
  ["personal-memory-read", "personalMemoryRead"],
  ["personal-collaboration", "personalCollaboration"],
  ["team-workspace-read", "teamWorkspaceRead"],
  ["share-grant-management", "shareGrantManagement"],
  ["capture-writes", "captureWrites"],
  ["sync", "sync"],
  ["managed-execution", "managedExecution"],
  ["admin", "admin"]
] as const;

interface UpstreamOptions {
  json?: boolean;
  id?: string;
  url?: string;
  name?: string;
  profile?: string;
  memoryAnswers?: boolean;
  enableMemoryAnswers?: boolean;
  sourceOwnerPrincipalId?: string;
}

type PolicyOptions = Partial<Record<(typeof policyOptions)[number][1], string>>;
const required = (value: string | undefined, flag: string): string => {
  if (!value) throw new Error(`${flag} is required.`);
  return value;
};

export const registerUpstreamCommands = (
  program: Command,
  dependencies: KoedServerCliDependencies,
  complete: (code: number) => void
): void => {
  const upstream = program
    .command("upstream")
    .description("Manage upstream backends and enrollment");
  upstream.action(() => upstream.outputHelp());
  const list = upstream
    .command("list")
    .description("List registered upstream backends");
  const register = upstream
    .command("register")
    .description("Register or update an upstream backend")
    .option("--url <url>", "Backend URL")
    .option("--id <id>", "Backend identifier")
    .option("--name <name>", "Display name")
    .option("--profile <profile>", "Deployment profile");
  const refresh = upstream
    .command("refresh")
    .description("Refresh cached upstream capabilities");
  const policy = upstream
    .command("policy")
    .description("Update explicit upstream route policies");
  for (const [flag] of policyOptions)
    policy.option(`--${flag} <state>`, "enabled or disabled");
  const activate = upstream
    .command("activate")
    .description("Select the active upstream backend");
  const remove = upstream
    .command("remove")
    .description("Remove an upstream backend");
  const disconnect = upstream
    .command("disconnect")
    .description("Disable upstream routes and enrollment");
  const enroll = upstream
    .command("enroll")
    .description("Manage upstream enrollment approval");
  enroll.action(() => enroll.outputHelp());
  const start = enroll
    .command("start")
    .description("Start enrollment through explicit browser approval")
    .option(
      "--source-owner-principal-id <id>",
      "Source owner principal identifier"
    )
    .option("--memory-answers", "Request Memory Answer execution")
    .option(
      "--enable-memory-answers",
      "Compatibility alias for --memory-answers"
    );
  const status = enroll
    .command("status")
    .description("Show upstream enrollment state");
  const cancel = enroll
    .command("cancel")
    .description("Cancel enrollment orchestration");
  for (const command of [
    refresh,
    policy,
    activate,
    remove,
    disconnect,
    start,
    status,
    cancel
  ])
    command.option("--id <id>", "Registered backend identifier");

  for (const command of [
    list,
    register,
    refresh,
    policy,
    activate,
    remove,
    disconnect,
    start,
    status,
    cancel
  ])
    command
      .option("--json", "Emit JSON output")
      .action(async (options: UpstreamOptions & PolicyOptions) => {
        const stdout = dependencies.stdout ?? process.stdout;
        const stderr = dependencies.stderr ?? process.stderr;
        try {
          const paths = (dependencies.resolvePaths ?? resolveKoedServerPaths)();
          let result: { ok: boolean; message: string };
          if (command === list) {
            const execute =
              dependencies.listUpstreams ??
              (await import("./upstream-registry.js")).listUpstreamBackends;
            result = execute(paths);
          } else if (command === register) {
            const execute =
              dependencies.registerUpstream ??
              (await import("./upstream-registry.js")).registerUpstreamBackend;
            result = execute(paths, {
              url: required(options.url, "--url"),
              id: options.id,
              displayName: options.name,
              profile: options.profile
            });
          } else {
            const id = required(options.id, "--id");
            if (command === refresh) {
              const execute =
                dependencies.refreshUpstream ??
                (await import("./upstream-registry.js"))
                  .refreshUpstreamBackendCapabilities;
              result = await execute(paths, id);
            } else if (command === policy) {
              const update: UpstreamRoutePolicyUpdate = {};
              for (const [flag, key] of policyOptions) {
                const value = options[key];
                if (!value) continue;
                if (value !== "enabled" && value !== "disabled")
                  throw new Error(`--${flag} must be enabled or disabled.`);
                update[key] = value;
              }
              const execute =
                dependencies.updateUpstreamPolicy ??
                (await import("./upstream-registry.js"))
                  .updateUpstreamBackendRoutePolicy;
              result = execute(paths, id, update);
            } else if (command === activate) {
              const execute =
                dependencies.activateUpstream ??
                (await import("./upstream-registry.js"))
                  .setActiveUpstreamBackend;
              result = execute(paths, id);
            } else if (command === remove) {
              const execute =
                dependencies.removeUpstream ??
                (await import("./upstream-registry.js")).removeUpstreamBackend;
              result = execute(paths, id);
            } else if (command === disconnect) {
              const execute =
                dependencies.disconnectUpstream ??
                (await import("./upstream-enrollment.js"))
                  .disconnectUpstreamBackendEnrollment;
              result = await execute(paths, id);
            } else if (command === start) {
              const execute =
                dependencies.startUpstreamEnroll ??
                (await import("./upstream-enrollment.js"))
                  .startUpstreamEnrollment;
              result = await execute(paths, id, {
                memoryAnswers: Boolean(
                  options.memoryAnswers || options.enableMemoryAnswers
                ),
                sourceOwnerPrincipalId: required(
                  options.sourceOwnerPrincipalId,
                  "--source-owner-principal-id"
                )
              });
            } else if (command === status) {
              const execute =
                dependencies.getUpstreamEnrollStatus ??
                (await import("./upstream-enrollment.js"))
                  .getUpstreamEnrollmentStatus;
              result = await execute(paths, id);
            } else {
              const execute =
                dependencies.cancelUpstreamEnroll ??
                (await import("./upstream-enrollment.js"))
                  .cancelUpstreamEnrollment;
              result = await execute(paths, id);
            }
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
