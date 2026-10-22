import {
  createInstalledDesktopEnvironment,
  resolveInstalledDesktopResources
} from "./desktop-cli-authority.js";
import { verifyDesktopRuntimeBundle } from "./desktop-runtime-capability.js";
import { resolveKoedHome } from "./paths.js";
import type { KoedServerCliDependencies } from "./cli-implementation.js";

export interface InstalledDesktopCliDependencies {
  moduleUrl?: string;
  executable?: string;
  platform?: NodeJS.Platform;
  electronVersion?: string | undefined;
  environment?: NodeJS.ProcessEnv;
  verifyBundle?: typeof verifyDesktopRuntimeBundle;
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
  const run =
    runCli ?? (await import("./cli-implementation.js")).runKoedServerCli;
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
