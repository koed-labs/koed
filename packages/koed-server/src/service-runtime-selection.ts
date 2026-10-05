import { existsSync } from "node:fs";
import type { RuntimeRequirements } from "./component-contract.js";
import type { KoedAppRuntime } from "./app-runtime.js";
import {
  assertKoedAppRuntimeAvailable,
  resolveKoedAppRuntimeForExecution,
  resolveKoedControlPlaneVersion,
  resolveKoedRuntimeOwner
} from "./app-runtime.js";
import type { KoedServerPaths } from "./paths.js";
import {
  pinGenerationForStart,
  readCurrentGenerationForOwner
} from "./generation-lifecycle.js";

export async function resolveVerifiedPackagedRuntime(
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  requirements: RuntimeRequirements,
  exists: (path: string) => boolean = existsSync
): Promise<KoedAppRuntime> {
  let generation;
  try {
    generation = await readCurrentGenerationForOwner(
      paths,
      resolveKoedRuntimeOwner()
    );
  } catch (error) {
    if (error instanceof Error && error.message === "runtime owner mismatch") {
      throw new Error(
        "Packaged runtime owner does not match this standalone control plane. Desktop-managed generations require the validated private Desktop supervisor channel; environment flags cannot assert ownership.",
        { cause: error }
      );
    }
    throw error;
  }
  const controlPlaneVersion = resolveKoedControlPlaneVersion();
  if (generation.productVersion !== controlPlaneVersion) {
    throw new Error(
      `Verified runtime generation ${generation.productVersion} does not match Koed server control plane ${controlPlaneVersion}.`
    );
  }
  const runtime = resolveKoedAppRuntimeForExecution(
    paths,
    environment,
    exists,
    generation,
    requirements,
    "packaged"
  );
  assertKoedAppRuntimeAvailable(runtime, paths);
  return runtime;
}

export async function pinAndResolvePackagedRuntime(
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  requirements: RuntimeRequirements,
  exists: (path: string) => boolean = existsSync
): Promise<{
  runtime: KoedAppRuntime;
  pin: Awaited<ReturnType<typeof pinGenerationForStart>>;
}> {
  let pin: Awaited<ReturnType<typeof pinGenerationForStart>>;
  try {
    pin = await pinGenerationForStart(paths, resolveKoedRuntimeOwner());
  } catch (error) {
    if (error instanceof Error && error.message === "runtime owner mismatch") {
      throw new Error(
        "Packaged runtime owner does not match this standalone control plane. Desktop-managed generations require the validated private Desktop supervisor channel; environment flags cannot assert ownership.",
        { cause: error }
      );
    }
    throw error;
  }
  try {
    const controlPlaneVersion = resolveKoedControlPlaneVersion();
    if (pin.generation.productVersion !== controlPlaneVersion) {
      throw new Error(
        `Verified runtime generation ${pin.generation.productVersion} does not match Koed server control plane ${controlPlaneVersion}.`
      );
    }
    const runtime = resolveKoedAppRuntimeForExecution(
      paths,
      environment,
      exists,
      pin.generation,
      requirements,
      "packaged"
    );
    assertKoedAppRuntimeAvailable(runtime, paths);
    return { runtime, pin };
  } catch (error) {
    await pin.release();
    throw error;
  }
}
