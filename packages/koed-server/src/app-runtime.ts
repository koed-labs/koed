import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  RuntimeOwner,
  RuntimeRequirements,
  VerifiedGeneration
} from "./component-contract.js";
import type { KoedServerPaths } from "./paths.js";
import type { RuntimeArtifactSource } from "./runtime-artifact-source.js";

export type KoedAppRuntimeKind = "source" | "packaged";

export interface KoedAppRuntime {
  kind: KoedAppRuntimeKind;
  artifactSource: RuntimeArtifactSource;
  root: string;
  apiEntry: string;
  workerEntry: string;
  embeddingServiceEntry: string;
  privacyServiceEntry?: string;
  mcpCli: string;
  localAiRuntime: string;
  captureHook: string;
  dbPackageRoot: string;
  missing: string[];
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceCheckoutRoot = resolve(packageRoot, "..", "..");
const isSourceCheckoutControlPlane = (): boolean =>
  existsSync(resolve(sourceCheckoutRoot, "pnpm-workspace.yaml")) &&
  existsSync(resolve(packageRoot, "package.json"));

export const resolveKoedAppRuntimeExecution = (): "source" | "packaged" =>
  isSourceCheckoutControlPlane() ? "source" : "packaged";

export const resolveKoedRuntimeOwner = (): RuntimeOwner => ({
  kind: "standalone",
  installationId: createHash("sha256")
    .update(realpathSync.native(packageRoot))
    .digest("hex")
    .slice(0, 32)
});

export const resolveKoedControlPlaneVersion = (): string => {
  const value: unknown = JSON.parse(
    readFileSync(resolve(packageRoot, "package.json"), "utf8")
  );
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)
  )
    throw new Error("Koed server control-plane version is invalid.");
  return value.version;
};

const sourceRuntime = (
  paths: KoedServerPaths,
  exists: (path: string) => boolean
): KoedAppRuntime => {
  const root = paths.repoRoot;
  const apiEntry = resolve(root, "apps/api/dist/index.js");
  const workerEntry = resolve(root, "apps/worker/dist/index.js");
  const embeddingServiceEntry = resolve(
    root,
    "apps/embedding-service/dist/index.js"
  );
  const privacyServiceEntry = resolve(
    root,
    "apps/privacy-service/dist/index.js"
  );
  const mcpCli = resolve(root, "packages/mcp-server/dist/cli.js");
  const localAiRuntime = resolve(
    root,
    "packages/mcp-server/dist/local-runtime-cli.js"
  );
  const captureHook = resolve(root, "packages/mcp-server/dist/capture-hook.js");
  const dbPackageRoot = resolve(root, "packages/db");
  const required = [
    resolve(root, "scripts/setup-env.mjs"),
    resolve(root, "apps/api/package.json"),
    resolve(root, "apps/worker/package.json"),
    resolve(root, "apps/privacy-service/package.json"),
    resolve(root, "packages/db/package.json"),
    resolve(root, "packages/mcp-server/package.json")
  ];
  return {
    kind: "source",
    artifactSource: "source-checkout",
    root,
    apiEntry,
    workerEntry,
    embeddingServiceEntry,
    privacyServiceEntry,
    mcpCli,
    localAiRuntime,
    captureHook,
    dbPackageRoot,
    missing: required.filter((entry) => !exists(entry))
  };
};

const requiredProcesses: RuntimeRequirements["processes"] = [
  "api",
  "worker",
  "local-ai-runtime",
  "embedding-service"
];
const effectiveRequirements = (
  requirements?: RuntimeRequirements
): RuntimeRequirements =>
  requirements ?? {
    components: ["base"],
    processes: requiredProcesses,
    queue: "bullmq",
    native: [],
    models: []
  };

const packagedRuntime = (
  selection: VerifiedGeneration | undefined,
  requirements: RuntimeRequirements,
  exists: (path: string) => boolean
): KoedAppRuntime => {
  const root = selection?.base.root ?? "";
  const apiEntry = resolve(root, "api/dist/index.js");
  const workerEntry = resolve(root, "worker/dist/index.js");
  const embeddingServiceEntry = resolve(
    root,
    "embedding-service/dist/index.js"
  );
  const privacyServiceEntry = selection?.privacy
    ? resolve(selection.privacy.root, "privacy-service/dist/index.js")
    : undefined;
  const mcpCli = resolve(root, "mcp-server/dist/cli.js");
  const localAiRuntime = resolve(root, "mcp-server/dist/local-runtime-cli.js");
  const captureHook = resolve(root, "mcp-server/dist/capture-hook.js");
  const dbPackageRoot = resolve(root, "node_modules/@koed/db");
  const required = [
    ...(selection ? [] : ["authenticated base generation"]),
    ...(requirements.processes.includes("api") ? [apiEntry] : []),
    ...(requirements.processes.includes("worker") ? [workerEntry] : []),
    ...(requirements.processes.includes("embedding-service")
      ? [embeddingServiceEntry]
      : []),
    ...(requirements.processes.includes("local-ai-runtime")
      ? [mcpCli, localAiRuntime, captureHook]
      : []),
    ...(requirements.components.includes("privacy")
      ? [
          ...(privacyServiceEntry
            ? [privacyServiceEntry]
            : ["authenticated privacy generation"])
        ]
      : []),
    ...(requirements.processes.includes("api") ||
    requirements.processes.includes("worker")
      ? [
          resolve(dbPackageRoot, "dist/index.js"),
          resolve(dbPackageRoot, "dist/connection.js"),
          resolve(dbPackageRoot, "dist/user-api-token-repository.js"),
          resolve(dbPackageRoot, "drizzle/meta/_journal.json")
        ]
      : [])
  ];
  return {
    kind: "packaged",
    artifactSource: "verified-generation",
    root,
    apiEntry,
    workerEntry,
    embeddingServiceEntry,
    ...(privacyServiceEntry ? { privacyServiceEntry } : {}),
    mcpCli,
    localAiRuntime,
    captureHook,
    dbPackageRoot,
    missing: required.filter((entry) =>
      entry.startsWith("authenticated ") ? true : !exists(entry)
    )
  };
};

const rejectUntrustedPackagedOverrides = (
  environment: NodeJS.ProcessEnv
): void => {
  const overrideNames = [
    "KOED_JS_RUNTIME_ROOT",
    "KOED_REPO_ROOT",
    "KOED_PACKAGED_RESOURCES_PATH",
    "KOED_ALLOW_PACKAGED_SOURCE_FALLBACK"
  ];
  const supplied = overrideNames.filter((name) => environment[name]?.trim());
  if (supplied.length > 0) {
    throw new Error(
      `Unsupported packaged runtime override: ${supplied.join(", ")}. Packaged services require a verified generation.`
    );
  }
};

export const resolveKoedAppRuntimeForExecution = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  selection: VerifiedGeneration | undefined,
  requirements: RuntimeRequirements | undefined,
  execution: "source" | "packaged"
): KoedAppRuntime => {
  if (execution === "source") return sourceRuntime(paths, exists);
  rejectUntrustedPackagedOverrides(environment);
  return packagedRuntime(
    selection,
    effectiveRequirements(requirements),
    exists
  );
};

export const resolveKoedAppRuntime = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  selection?: VerifiedGeneration,
  requirements?: RuntimeRequirements
): KoedAppRuntime =>
  resolveKoedAppRuntimeForExecution(
    paths,
    environment,
    exists,
    selection,
    requirements,
    resolveKoedAppRuntimeExecution()
  );

export const assertKoedAppRuntimeAvailable = (
  runtime: KoedAppRuntime,
  paths: KoedServerPaths
): void => {
  if (runtime.missing.length === 0) return;
  if (runtime.kind === "packaged") {
    throw new Error(
      [
        "Packaged Koed JS runtime artifacts are missing.",
        `Missing authenticated runtime files under ${runtime.root || "verified generation"}: ${runtime.missing.join(", ")}.`,
        "Install a compatible signed Koed runtime generation; packaged startup never downloads or uses checkout files."
      ].join(" ")
    );
  }
  void paths;
};
