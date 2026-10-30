import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { KoedServerCliDependencies } from "./cli-contract.js";
import type { ComponentOperation, ComponentOptions } from "./cli-components.js";
import type { ComponentSource } from "./component-store.js";
import { resolveKoedServerPaths } from "./paths.js";
import { discoverActualRuntimeIdentity } from "./component-runtime-identity.js";
import {
  resolveKoedControlPlaneVersion,
  resolveKoedRuntimeOwner
} from "./app-runtime.js";
import { resolveComponentCommandTarget } from "./component-command-target.js";
import { productionComponentManifestCatalog } from "./component-manifest-catalog-data.js";
import * as handlers from "./component-commands.js";

export const runComponentCommand = async (
  operation: ComponentOperation,
  options: ComponentOptions,
  dependencies: KoedServerCliDependencies
): Promise<number> => {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  try {
    if (dependencies.desktopRuntimeCapability)
      throw new Error(
        "Koed Desktop manages components for its bundled runtime. Use Koed Desktop to install or update components."
      );
    const paths = (dependencies.resolvePaths ?? resolveKoedServerPaths)();
    const runtime = discoverActualRuntimeIdentity();
    const target = resolveComponentCommandTarget(
      runtime,
      productionComponentManifestCatalog
    );
    const context = {
      paths,
      controlPlaneVersion: resolveKoedControlPlaneVersion(),
      target,
      runtime,
      owner: resolveKoedRuntimeOwner(),
      isRunning: existsSync(resolve(paths.runDir, "koed-server.lock"))
    };
    let result: unknown;
    switch (operation) {
      case "status":
        result = await handlers.runComponentStatus(context);
        break;
      case "cleanup":
        result = await handlers.runComponentCleanup(context);
        break;
      case "activate": {
        if (!options.version) throw new Error("--version is required.");
        result = await handlers.runComponentActivate(context, options.version);
        break;
      }
      case "install": {
        const component = options.component;
        if (!component) throw new Error("--component is required.");
        if (component !== "base" && component !== "privacy")
          throw new Error("--component must be base or privacy.");
        const variant = options.variant;
        if (
          variant !== undefined &&
          (component !== "privacy" ||
            target.platform !== "linux" ||
            target.architecture !== "x64" ||
            (variant !== "cpu" && variant !== "cuda"))
        )
          throw new Error(
            "--variant must be cpu or cuda for Linux x64 Privacy."
          );
        const hasOffline =
          options.archive !== undefined || options.manifest !== undefined;
        const hasRemote =
          options.archiveUrl !== undefined || options.manifestUrl !== undefined;
        if (hasOffline === hasRemote)
          throw new Error(
            "Provide exactly one complete offline archive/manifest set or exact-version URL set."
          );
        if (
          hasOffline &&
          (options.archive === undefined || options.manifest === undefined)
        )
          throw new Error(
            "Offline install requires --archive and --manifest paths."
          );
        if (
          hasRemote &&
          (options.archiveUrl === undefined ||
            options.manifestUrl === undefined)
        )
          throw new Error(
            "Network install requires --archive-url and --manifest-url."
          );
        const source: ComponentSource = hasOffline
          ? {
              kind: "offline",
              archivePath: options.archive!,
              manifestPath: options.manifest!
            }
          : {
              kind: "remote",
              archiveUrl: options.archiveUrl!,
              manifestUrl: options.manifestUrl!
            };
        result = await handlers.runComponentInstall(context, {
          component,
          ...(variant === "cpu" || variant === "cuda" ? { variant } : {}),
          version: options.version,
          source,
          stageOnly: Boolean(options.stageOnly)
        });
      }
    }
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json)
      stdout.write(
        `${JSON.stringify({ ok: false, error: message }, null, 2)}\n`
      );
    else stderr.write(`${message}\n`);
    return 1;
  }
};
