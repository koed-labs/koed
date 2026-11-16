import {
  createInstalledDesktopEnvironment,
  resolveInstalledDesktopResources
} from "./desktop-cli-authority.js";
import { verifyDesktopRuntimeBundle } from "./desktop-runtime-capability.js";
import { resolveKoedHome, resolveKoedServerPaths } from "./paths.js";
import type { KoedServerCliDependencies } from "./cli-contract.js";

export interface InstalledDesktopCliDependencies {
  moduleUrl?: string;
  executable?: string;
  platform?: NodeJS.Platform;
  electronVersion?: string | undefined;
  environment?: NodeJS.ProcessEnv;
  verifyBundle?: typeof verifyDesktopRuntimeBundle;
  runControlPlaneHost?: typeof import("./control-plane/host-entrypoint.js").runInstalledControlPlaneHost;
  runControlPlaneCli?: typeof import("./control-plane/cli.js").runControlPlaneCli;
  agentTeamId?: typeof import("./control-plane/installed-client.js").installedAgentTeamId;
  migrateStoppedLegacyAgent?: typeof import("./control-plane/migrate.js").migrateStoppedLegacyAgent;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  runCli?: (
    args: string[],
    dependencies: KoedServerCliDependencies
  ) => Promise<number>;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

const replaceEnvironment = (
  target: NodeJS.ProcessEnv,
  next: NodeJS.ProcessEnv
): void => {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
};

// Public launcher entry for the CLI shipped inside an installed Koed Desktop.
// Authority comes from this module's real location, the running executable,
// and full bundle verification; nothing in argv or the environment can name
// another resources path or supervisor command.
export async function runInstalledDesktopCli(
  args: string[],
  {
    moduleUrl = import.meta.url,
    executable = process.execPath,
    platform = process.platform,
    electronVersion = process.versions.electron,
    environment = process.env,
    verifyBundle = verifyDesktopRuntimeBundle,
    runControlPlaneHost,
    runControlPlaneCli,
    agentTeamId,
    migrateStoppedLegacyAgent,
    stdout = process.stdout,
    runCli,
    stderr = process.stderr
  }: InstalledDesktopCliDependencies = {}
): Promise<number> {
  let dependencies: KoedServerCliDependencies;
  try {
    const installation = resolveInstalledDesktopResources({
      moduleUrl,
      executable,
      platform,
      electronVersion
    });
    const desktopRuntimeCapability = verifyBundle(installation.resourcesPath);
    replaceEnvironment(
      environment,
      createInstalledDesktopEnvironment(environment)
    );
    dependencies = {
      desktopRuntimeCapability,
      supervisorInvocation: {
        startCommand: installation.entrypoint,
        cwd: resolveKoedHome(environment)
      }
    };
  } catch (error) {
    stderr.write(
      `Koed Desktop CLI could not verify its installation: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
  if (platform === "darwin" && args[0] === "migrate") {
    if (args.length !== 2 || args[1] !== "--confirm-legacy-stopped") {
      stderr.write(
        "Stop the old Desktop and Agent, then run migrate --confirm-legacy-stopped. Do not restart the old installation against this KOED_HOME.\n"
      );
      return 1;
    }
    try {
      const migrate =
        migrateStoppedLegacyAgent ??
        (await import("./control-plane/migrate.js")).migrateStoppedLegacyAgent;
      migrate(resolveKoedServerPaths(environment), true);
      stdout.write(
        "Legacy Agent state imported. Do not restart the old installation against this KOED_HOME.\n"
      );
      return 0;
    } catch (error) {
      stderr.write(
        `Migration failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      return 1;
    }
  }
  if (
    platform === "darwin" &&
    args.length === 1 &&
    args[0] === "__control-plane-agent-eligibility"
  ) {
    const capability = dependencies.desktopRuntimeCapability;
    if (!capability)
      throw new Error("Verified Desktop runtime capability required");
    const resolveTeam =
      agentTeamId ??
      (await import("./control-plane/installed-client.js"))
        .installedAgentTeamId;
    stdout.write(
      `${JSON.stringify({ ok: true, teamId: resolveTeam(capability) })}\n`
    );
    return 0;
  }
  if (platform === "darwin" && args[0] === "__control-plane-desktop-session") {
    const capability = dependencies.desktopRuntimeCapability;
    const invocation = dependencies.supervisorInvocation;
    if (
      args.length !== 2 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        args[1]!
      )
    )
      throw new Error("A valid Desktop session identity is required");
    if (!capability || !invocation || !process.connected || !process.send)
      throw new Error("A Desktop parent IPC connection is required");
    const { openInstalledControlPlane } =
      await import("./control-plane/installed-client.js");
    const { serveDesktopSession } =
      await import("./control-plane/desktop-session.js");
    const client = await openInstalledControlPlane({
      capability,
      environment,
      executable,
      entrypoint: invocation.startCommand
    });
    const sessionResult = await serveDesktopSession(
      client,
      {
        get connected() {
          return Boolean(process.connected && process.send);
        },
        send(message) {
          if (!process.connected || !process.send)
            throw new Error("Desktop parent disconnected");
          process.send(
            message as Parameters<NonNullable<typeof process.send>>[0]
          );
        },
        onMessage(listener) {
          process.on("message", listener);
          return () => process.off("message", listener);
        },
        onDisconnect(listener) {
          process.on("disconnect", listener);
          return () => process.off("disconnect", listener);
        }
      },
      args[1]
    );
    if (process.connected) process.disconnect?.();
    return sessionResult;
  }
  if (args.length === 1 && args[0] === "__control-plane-host") {
    const capability = dependencies.desktopRuntimeCapability;
    if (!capability)
      throw new Error("Verified Desktop runtime capability required");
    const runHost =
      runControlPlaneHost ??
      (await import("./control-plane/host-entrypoint.js"))
        .runInstalledControlPlaneHost;
    return runHost({ capability, environment });
  }
  if (
    platform === "darwin" &&
    (args[0] === "start" ||
      args[0] === "stop" ||
      args[0] === "restart" ||
      args[0] === "__control-plane-stop-implicit" ||
      args[0] === "__control-plane-start-automatic" ||
      args[0] === "__control-plane-start-desktop" ||
      args[0] === "__control-plane-start-agent" ||
      args[0] === "__control-plane-agent-enable" ||
      args[0] === "__control-plane-agent-disable" ||
      args[0] === "__control-plane-agent-status" ||
      args[0] === "__control-plane-startup-status") &&
    !args.includes("--help") &&
    !args.includes("-h")
  ) {
    const capability = dependencies.desktopRuntimeCapability;
    const invocation = dependencies.supervisorInvocation;
    if (!capability || !invocation)
      throw new Error("Verified Desktop runtime capability required");
    const runControl =
      runControlPlaneCli ??
      (await import("./control-plane/cli.js")).runControlPlaneCli;
    const implicit = args[0] === "__control-plane-stop-implicit";
    const automatic = args[0] === "__control-plane-start-automatic";
    const desktopStart =
      args[0] === "__control-plane-start-desktop" ||
      args[0] === "__control-plane-start-agent";
    const agentEnable = args[0] === "__control-plane-agent-enable";
    const agentDisable = args[0] === "__control-plane-agent-disable";
    const startupStatus = args[0] === "__control-plane-startup-status";
    const agentStatus =
      args[0] === "__control-plane-agent-status" || startupStatus;
    const installedClient = await import("./control-plane/installed-client.js");
    return runControl(
      implicit
        ? ["stop", "--non-explicit", ...args.slice(1)]
        : automatic
          ? ["start", "--non-explicit", ...args.slice(1)]
          : desktopStart
            ? ["start", ...args.slice(1)]
            : agentEnable || agentDisable || agentStatus
              ? [
                  agentEnable
                    ? "agent-enable"
                    : agentDisable
                      ? "agent-disable"
                      : "agent-status",
                  ...args.slice(1)
                ]
              : args,
      {
        stdout,
        stderr,
        allowImplicitStop: implicit,
        allowAutomaticStart: automatic,
        allowAgentAvailability: agentEnable || agentDisable || agentStatus,
        persistentStart: args[0] === "start" || args[0] === "restart",
        offlineStop: () =>
          installedClient.tryRecordOfflineStop(environment, capability),
        connect: async (command) =>
          installedClient.openInstalledControlPlane({
            capability,
            environment,
            executable,
            entrypoint: invocation.startCommand,
            launchIfMissing: command !== "stop" && !startupStatus
          })
      }
    );
  }
  const run = runCli ?? (await import("./cli.js")).runKoedServerCli;
  return run(args, dependencies);
}

if (process.argv[1]?.endsWith("desktop-cli-entrypoint.js")) {
  const args = process.argv.slice(2);
  void runInstalledDesktopCli(args).then(
    (exitCode) => {
      // A foreground supervisor leaves no work behind once it returns.
      if (args[0] === "start" && !args.includes("--daemon"))
        process.exit(exitCode);
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
      );
      process.exitCode = 1;
    }
  );
}
