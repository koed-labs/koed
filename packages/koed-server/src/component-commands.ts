import { existsSync, readdirSync } from "node:fs";
import type {
  ArtifactTarget,
  ComponentId,
  RuntimeIdentity,
  RuntimeOwner,
  VerifiedGeneration
} from "./component-contract.js";
import {
  calculateRuntimeRequirements,
  resolveEffectiveRuntimeConfig
} from "./effective-runtime-config.js";
import type { KoedServerPaths } from "./paths.js";
import type {
  ComponentSource,
  GenerationOrderingEvidence
} from "./component-store.js";
import { resolveKoedAppRuntimeExecution } from "./app-runtime.js";
import {
  readStagedGeneration,
  readGenerationComponentPresence,
  readStoredComponents,
  resolveComponentManifestPinTarget,
  stageComponent,
  stageGeneration
} from "./component-store.js";
import {
  activateGeneration,
  cleanupGenerations,
  readCurrentDesktopGeneration,
  readCurrentGenerationOrderingEvidence,
  readCurrentGeneration
} from "./generation-lifecycle.js";
import type { DesktopRuntimeCapability } from "./desktop-runtime-capability.js";
import { productionComponentManifestCatalog } from "./component-manifest-catalog-data.js";
import { validateManifestCatalog } from "./component-manifest-catalog.js";

export type ComponentState =
  | "required"
  | "installed"
  | "staged"
  | "active"
  | "incompatible"
  | "missing"
  | "not-required";

export interface ComponentStatus {
  components: Record<ComponentId, ComponentState>;
  activeGeneration: string | null;
  activeVersion: string | null;
  required: readonly ComponentId[];
  requiredManifestPinsAvailable: boolean;
}

export interface ComponentCommandContext {
  paths: KoedServerPaths;
  controlPlaneVersion: string;
  target: ArtifactTarget;
  runtime: RuntimeIdentity;
  owner: RuntimeOwner;
  desktopRuntimeCapability?: DesktopRuntimeCapability;
  signal?: AbortSignal;
  progress?: (event: {
    phase: string;
    transferredBytes: number;
    totalBytes?: number;
  }) => void;
  isRunning: boolean;
  environment?: NodeJS.ProcessEnv;
  execution?: "source" | "packaged";
}

const requirementsFor = (context: ComponentCommandContext) =>
  calculateRuntimeRequirements(
    resolveEffectiveRuntimeConfig(
      context.paths,
      context.environment ?? process.env,
      context.execution ?? resolveKoedAppRuntimeExecution()
    )
  );

const requiredManifestPinsAvailable = (
  context: ComponentCommandContext,
  required: readonly ComponentId[]
): boolean => {
  const pinRequired = context.desktopRuntimeCapability
    ? required.filter((component) => component !== "base")
    : required;
  if (pinRequired.length === 0) return true;
  if (!productionComponentManifestCatalog) return false;
  const catalog = validateManifestCatalog(productionComponentManifestCatalog);
  return pinRequired.every((component) => {
    try {
      resolveComponentManifestPinTarget(catalog, {
        component,
        productVersion: context.controlPlaneVersion,
        target: context.target,
        runtime: context.runtime
      });
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith("Component pin catalog version mismatch") ||
          error.message.startsWith(
            "Required component manifest pin is missing"
          ) ||
          error.message.startsWith(
            "Component manifest pin target is ambiguous"
          ))
      )
        return false;
      throw error;
    }
  });
};

const storedGenerations = async (
  context: ComponentCommandContext
): Promise<VerifiedGeneration[]> => {
  if (!existsSync(context.paths.generationsDir)) return [];
  const ids = readdirSync(context.paths.generationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
    .map((entry) => entry.name);
  const generations: VerifiedGeneration[] = [];
  for (const id of ids) {
    try {
      const generation = await readStagedGeneration(context.paths, id);
      if (
        generation.owner.kind === context.owner.kind &&
        generation.owner.installationId === context.owner.installationId
      )
        generations.push(generation);
    } catch {
      // Invalid generations are never treated as installed or cleanup candidates.
    }
  }
  return generations;
};

const readOwnedCurrentGeneration = async (
  context: ComponentCommandContext
): Promise<VerifiedGeneration | GenerationOrderingEvidence | null> => {
  try {
    const evidence = context.desktopRuntimeCapability
      ? null
      : readCurrentGenerationOrderingEvidence(context.paths);
    const generation = context.desktopRuntimeCapability
      ? await readCurrentDesktopGeneration(
          context.paths,
          context.desktopRuntimeCapability
        )
      : evidence!.productVersion === context.controlPlaneVersion
        ? await readCurrentGeneration(context.paths)
        : evidence!;
    return generation.owner.kind === context.owner.kind &&
      generation.owner.installationId === context.owner.installationId
      ? generation
      : null;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "no active runtime generation"
    )
      return null;
    throw error;
  }
};

export async function runComponentStatus(
  context: ComponentCommandContext
): Promise<ComponentStatus> {
  const required = requirementsFor(context).components;
  const active = await readOwnedCurrentGeneration(context);
  const priorPresence =
    active && "kind" in active
      ? readGenerationComponentPresence(context.paths, active.id)
      : [];
  const generations = await storedGenerations(context);
  const installed = await readStoredComponents(context.paths, context.runtime);
  const staged = generations.filter(
    (generation) => generation.id !== active?.id
  );
  const states: Record<ComponentId, ComponentState> = {
    base: "not-required",
    privacy: "not-required"
  };
  for (const component of ["base", "privacy"] as const) {
    if (!required.includes(component)) continue;
    if (active && !("kind" in active) && active[component]) {
      states[component] =
        active.productVersion === context.controlPlaneVersion
          ? "active"
          : "incompatible";
      continue;
    }
    const stored = staged.filter(
      (generation) => generation[component] !== undefined
    );
    states[component] = stored.some(
      (generation) => generation.productVersion === context.controlPlaneVersion
    )
      ? "staged"
      : stored.length > 0
        ? "incompatible"
        : installed.some((entry) => entry.manifest.component === component)
          ? "installed"
          : priorPresence.includes(component)
            ? "incompatible"
            : "missing";
  }
  return {
    components: states,
    activeGeneration: active?.id ?? null,
    activeVersion: active?.productVersion ?? null,
    required,
    requiredManifestPinsAvailable: requiredManifestPinsAvailable(
      context,
      required
    )
  };
}

export async function runComponentInstall(
  context: ComponentCommandContext,
  options: {
    component: ComponentId;
    version?: string;
    source?: ComponentSource;
    stageOnly?: boolean;
  }
): Promise<{ state: "staged" | "active"; generationId?: string }> {
  if (!options.source)
    throw new Error(
      "A manifest-pinned component source is required; provide offline archive and manifest paths or exact-version URLs."
    );
  const version = options.version ?? context.controlPlaneVersion;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("component version must be an exact semantic version.");
  const required = requirementsFor(context).components;
  if (!required.includes(options.component))
    throw new Error(
      `${options.component} component is not required by current runtime configuration.`
    );
  const component = await stageComponent(context.paths, options.source, {
    expectedComponent: options.component,
    expectedVersion: version,
    target: context.target,
    runtime: context.runtime,
    signal: context.signal,
    progress: context.progress
  });
  const selection = await readOwnedCurrentGeneration(context);
  const active = selection && !("kind" in selection) ? selection : null;
  const staged = await storedGenerations(context);
  const installed = await readStoredComponents(context.paths, context.runtime);
  const priorGeneration = staged.find(
    (generation) => generation.productVersion === version
  );
  const otherComponent =
    options.component === "base"
      ? active?.privacy?.manifest.productVersion === version
        ? active.privacy
        : (priorGeneration?.privacy ??
          installed.find(
            (entry) =>
              entry.manifest.component === "privacy" &&
              entry.manifest.productVersion === version
          ))
      : active?.base.kind === "manifest-pinned-component" &&
          active.base.manifest.productVersion === version
        ? active.base
        : ((priorGeneration?.base.kind === "manifest-pinned-component"
            ? priorGeneration.base
            : undefined) ??
          installed.find(
            (entry) =>
              entry.manifest.component === "base" &&
              entry.manifest.productVersion === version
          ));
  if (required.length > 1 && !otherComponent) {
    if (options.component === "base")
      await stageGeneration(context.paths, {
        base: component,
        owner: context.owner
      });
    return { state: "staged" };
  }
  const generation = await stageGeneration(context.paths, {
    base: options.component === "base" ? component : otherComponent!,
    ...(required.includes("privacy")
      ? {
          privacy: options.component === "privacy" ? component : otherComponent
        }
      : {}),
    owner: context.owner
  });
  if (
    version !== context.controlPlaneVersion ||
    options.stageOnly ||
    context.isRunning
  )
    return { state: "staged" };
  const activated = await activateGeneration(
    context.paths,
    generation.id,
    context.owner
  );
  return { state: "active", generationId: activated.id };
}

export async function runComponentActivate(
  context: ComponentCommandContext,
  version: string
): Promise<VerifiedGeneration> {
  if (version !== context.controlPlaneVersion)
    throw new Error(
      "Activation requires a matching control plane version; select the matching control-plane version before rollback activation."
    );
  if (context.isRunning)
    throw new Error(
      "Stop Koed services before activating a component generation."
    );
  const required = requirementsFor(context).components;
  const candidates = (await storedGenerations(context))
    .filter((generation) => generation.productVersion === version)
    .sort((left, right) => right.id.localeCompare(left.id));
  const candidate = candidates.find((generation) =>
    required.every((component) => generation[component] !== undefined)
  );
  if (!candidate)
    throw new Error(
      `No complete staged generation for ${version}; install all required components first.`
    );
  return activateGeneration(
    context.paths,
    candidate.id,
    context.owner,
    context.desktopRuntimeCapability
  );
}

export async function runComponentCleanup(
  context: ComponentCommandContext
): Promise<string[]> {
  return cleanupGenerations(context.paths, 2, context.owner);
}
