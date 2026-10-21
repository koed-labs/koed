import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const desktopCliEntrypointRelativePath =
  "app.asar/node_modules/@koed-labs/server/dist/desktop-cli-entrypoint.js";

// This is installation provenance, not a replacement for OS package signing or
// bundle verification. Production callers supply import.meta.url and process
// identity, never argv, a registry record, or a caller-supplied resources path.
export function resolveInstalledDesktopResources(input: {
  moduleUrl: string;
  executable: string;
  platform: NodeJS.Platform;
  electronVersion: string | undefined;
}): { resourcesPath: string; entrypoint: string } {
  if (!input.electronVersion)
    throw new Error("Desktop CLI requires its installed Electron executable");
  const entrypoint = realpathSync(fileURLToPath(input.moduleUrl));
  const resources = resolve(dirname(entrypoint), "../../../../..");
  if (entrypoint !== resolve(resources, desktopCliEntrypointRelativePath)) {
    throw new Error("Desktop CLI must run from its packaged installation");
  }
  const executable = realpathSync(input.executable);
  // electron-builder sanitizes the Linux package name `@koed/desktop` to `@koeddesktop`.
  const matches =
    input.platform === "darwin"
      ? executable === realpathSync(resolve(resources, "../MacOS/Koed"))
      : input.platform === "linux"
        ? executable === realpathSync(resolve(resources, "../@koeddesktop"))
        : false;
  if (!matches) {
    throw new Error("Desktop CLI executable and module installation mismatch");
  }
  return { resourcesPath: realpathSync(resources), entrypoint };
}

const overrideNames = [
  "KOED_PACKAGED_RESOURCES_PATH",
  "KOED_ALLOW_PACKAGED_SOURCE_FALLBACK",
  "KOED_REPO_ROOT",
  "KOED_SERVER_CLI",
  "KOED_NODE_COMMAND",
  "KOED_SERVER_DAEMON_COMMAND",
  "KOED_SERVER_DAEMON_ARGS_JSON"
] as const;

// Mirrors the defaults Desktop applies to its managed local personal instance,
// so a CLI-started supervisor is the same instance Desktop would start.
export function createInstalledDesktopEnvironment(
  source: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const valueOr = (key: string, fallback: string): string =>
    source[key]?.trim() || fallback;
  const environment: NodeJS.ProcessEnv = { ...source };
  for (const name of overrideNames) delete environment[name];
  const dependencyMode = valueOr("KOED_DEPENDENCY_MODE", "bundled-local");
  return {
    ...environment,
    ...(dependencyMode === "bundled-local" && !source.KOED_AUTO_PORTS?.trim()
      ? { KOED_AUTO_PORTS: "1" }
      : {}),
    KOED_RUNTIME_MODE: valueOr("KOED_RUNTIME_MODE", "local-personal"),
    KOED_DEPENDENCY_MODE: dependencyMode,
    KOED_TEAM_COLLABORATION_ENABLED: valueOr(
      "KOED_TEAM_COLLABORATION_ENABLED",
      "false"
    ),
    WORK_QUEUE_BACKEND: valueOr("WORK_QUEUE_BACKEND", "local"),
    KOED_PACKAGED_DESKTOP: "1",
    ELECTRON_RUN_AS_NODE: "1"
  };
}
