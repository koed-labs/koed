import type { ChildProcess } from "node:child_process";
import {
  existsSync as nodeExistsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  ComponentState,
  ComponentStatus,
  KoedServerStatus
} from "../types.js";
import type { NodeEntrypointInvocation } from "./runtime.js";

export type DesktopCommandHandler = (args?: Record<string, unknown>) => unknown;

export interface KoedServerManagerOptions {
  repoRoot: string;
  cliPath: string;
  environment: NodeJS.ProcessEnv;
  createCliInvocation: (args: string[]) => NodeEntrypointInvocation;
  existsSync: (path: string) => boolean;
  execFile: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      timeout: number;
    },
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => void;
  spawn: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      stdio: "pipe";
      detached: false;
    }
  ) => ChildProcess;
  openExternal: (url: string) => Promise<unknown>;
  openPath?: (path: string) => Promise<string>;
}

export interface KoedServerManager {
  handlers: Record<string, DesktopCommandHandler>;
  stop: () => Promise<unknown>;
}

type DiagnosticStatus = KoedServerStatus & {
  error: string;
  details: Record<string, unknown>;
};

type ServerPackageStatusPayload = {
  ok?: unknown;
  state?: unknown;
  message?: unknown;
  action?: unknown;
  currentVersion?: unknown;
  currentTarget?: unknown;
  errors?: unknown;
};

type ServerPackageInstallPlan =
  | {
      available: true;
      source: string;
      sourceKind: "configured" | "bundled";
      sha256?: string;
      sha256File?: string;
      provenanceFile?: string;
      signatureFile?: string;
      trustedPublicKeyFile?: string;
      trustPolicy?: string;
      requiresNetworkConsent: boolean;
    }
  | {
      available: false;
      sourceKind: "unavailable";
      useBundledFallback: boolean;
      message: string;
      action: string;
    };

const diagnosticComponent = (
  state: ComponentState,
  message: string,
  action?: string
): ComponentStatus => ({
  state,
  message,
  ...(action ? { action } : {})
});

const diagnosticStatus = ({
  state,
  message,
  repoRoot,
  cliPath,
  details
}: {
  state: ComponentState;
  message: string;
  repoRoot: string;
  cliPath: string;
  details?: Record<string, unknown>;
}): DiagnosticStatus => {
  const component = (action?: string): ComponentStatus =>
    diagnosticComponent(state, message, action);
  return {
    ok: false,
    state,
    error: message,
    koedHome: "not available",
    generatedAt: new Date().toISOString(),
    runtimeMode: "developer",
    dependencyMode: "external",
    api: { ...component("Start Koed"), url: "" },
    database: component("Install runtime assets"),
    redis: component(),
    workerQueues: component("Start Koed"),
    embeddingService: component("Install runtime assets"),
    apiToken: { ...component("Run setup"), configured: false },
    mcpServer: component("Run setup"),
    captureHook: component("Run setup"),
    codex: { ...component("Run setup"), configured: false },
    lcmSummaryService: component(),
    upstreamBackends: {
      ...component("Connect Team Backend"),
      registered: 0,
      validated: 0,
      stale: 0,
      failed: 0,
      notChecked: 0
    },
    explorer: { ...component("Start Koed"), url: "" },
    lastVerification: { ...component("Run doctor"), checkedAt: null },
    details: {
      repoRoot,
      cliPath,
      ...details
    }
  } as DiagnosticStatus;
};

const missingCliPayload = (repoRoot: string, cliPath: string) =>
  diagnosticStatus({
    state: "not_configured",
    message:
      "koed-server CLI was not found. Build the checkout with `pnpm --filter @koed/koed-server build`, or launch the packaged app with KOED_REPO_ROOT/KOED_SERVER_CLI pointing at a Koed checkout.",
    repoRoot,
    cliPath
  });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const appendOutputLines = (buffer: string[], chunk: Buffer | string): void => {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    buffer.push(trimmed);
  }
  while (buffer.length > 400) {
    buffer.shift();
  }
};

const withDesktopStartLog = (
  value: unknown,
  outputLines: string[]
): unknown => {
  if (typeof value !== "object" || value === null || outputLines.length === 0) {
    return value;
  }
  return {
    ...value,
    desktopStartLog: outputLines.slice(-120)
  };
};

const resolveKoedHome = (environment: NodeJS.ProcessEnv): string =>
  resolve(environment.KOED_HOME?.trim() || `${homedir()}/.koed`);

const resolveExplorerCredentialPath = (
  environment: NodeJS.ProcessEnv
): string =>
  resolve(resolveKoedHome(environment), "config", "explorer-token.json");

const readExplorerCredential = (
  environment: NodeJS.ProcessEnv
): { ok: true; apiToken: string } | { ok: false; error: string } => {
  const credentialPath = resolveExplorerCredentialPath(environment);
  if (!nodeExistsSync(credentialPath)) {
    return { ok: false, error: "Explorer credential is not provisioned." };
  }
  try {
    const parsed = JSON.parse(readFileSync(credentialPath, "utf8")) as {
      apiToken?: unknown;
    };
    return typeof parsed.apiToken === "string" && parsed.apiToken.trim()
      ? { ok: true, apiToken: parsed.apiToken.trim() }
      : { ok: false, error: "Explorer credential is missing an API Token." };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

const parseCreatedApiToken = (output: string): string | null => {
  const match = /^Token:\s*(\S+)$/m.exec(output);
  return match?.[1] ?? null;
};

const packagedRuntimeManifestPath = (
  environment: NodeJS.ProcessEnv
): string | null => {
  const resourcesPath = environment.KOED_PACKAGED_RESOURCES_PATH?.trim();
  return resourcesPath
    ? resolve(resourcesPath, "koed-runtime", "runtime-asset-manifest.json")
    : null;
};

const runtimeInstallProvider = (
  environment: NodeJS.ProcessEnv,
  existsSync: (path: string) => boolean
): "packaged" | "homebrew" => {
  const manifestPath = packagedRuntimeManifestPath(environment);
  if (manifestPath && existsSync(manifestPath)) return "packaged";
  return "homebrew";
};

const readDesktopPorts = (
  environment: NodeJS.ProcessEnv
): Record<string, string> => {
  const portsPath = resolve(
    resolveKoedHome(environment),
    "config",
    "local-ports.json"
  );
  if (!nodeExistsSync(portsPath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(portsPath, "utf8")) as Record<
      string,
      unknown
    >;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => typeof value === "string" && value.trim())
        .map(([key, value]) => [key, String(value)])
    );
  } catch {
    return {};
  }
};

const firstFileWithSuffix = (root: string, suffix: string): string | null => {
  if (!nodeExistsSync(root)) {
    return null;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(suffix)) {
      return path;
    }
    if (entry.isDirectory()) {
      const nested = firstFileWithSuffix(path, suffix);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
};

const bundledProvenanceForArchive = (archive: string): string | null => {
  const archiveName = archive.split("/").at(-1) ?? "";
  const releaseName = archiveName
    .replace(/^koed-server-/, "koed-server-app-runtime-")
    .replace(/\.tar\.gz$/, ".provenance.json");
  for (const candidate of [
    `${archive}.provenance.json`,
    archive.replace(/\.tar\.gz$/, ".provenance.json"),
    resolve(archive, "..", releaseName)
  ]) {
    if (nodeExistsSync(candidate)) return candidate;
  }
  return null;
};

const bundledServerPackageRoot = (
  environment: NodeJS.ProcessEnv
): string | null => {
  const resourcesPath = environment.KOED_PACKAGED_RESOURCES_PATH?.trim();
  return resourcesPath ? resolve(resourcesPath, "koed-server-package") : null;
};

const resolveServerPackageInstallPlan = (
  environment: NodeJS.ProcessEnv
): ServerPackageInstallPlan => {
  const explicitSource = environment.KOED_SERVER_PACKAGE_SOURCE?.trim();
  const explicitSha256 = environment.KOED_SERVER_PACKAGE_SHA256?.trim();
  const explicitSha256File =
    environment.KOED_SERVER_PACKAGE_SHA256_FILE?.trim();
  const explicitProvenanceFile =
    environment.KOED_SERVER_PACKAGE_PROVENANCE_FILE?.trim();
  const explicitSignatureFile =
    environment.KOED_SERVER_PACKAGE_SIGNATURE_FILE?.trim();
  const explicitTrustedPublicKeyFile =
    environment.KOED_SERVER_PACKAGE_TRUSTED_PUBLIC_KEY_FILE?.trim();
  const explicitTrustPolicy =
    environment.KOED_SERVER_PACKAGE_TRUST_POLICY?.trim();
  if (explicitSource) {
    if (!explicitSha256 && !explicitSha256File) {
      return {
        available: false,
        sourceKind: "unavailable",
        useBundledFallback: false,
        message:
          "koed-server package source is configured, but SHA-256 metadata is missing.",
        action:
          "Set KOED_SERVER_PACKAGE_SHA256 or KOED_SERVER_PACKAGE_SHA256_FILE."
      };
    }
    return {
      available: true,
      source: explicitSource,
      sourceKind: "configured",
      ...(explicitSha256 ? { sha256: explicitSha256 } : {}),
      ...(explicitSha256File ? { sha256File: explicitSha256File } : {}),
      ...(explicitProvenanceFile
        ? { provenanceFile: explicitProvenanceFile }
        : {}),
      ...(explicitSignatureFile
        ? { signatureFile: explicitSignatureFile }
        : {}),
      ...(explicitTrustedPublicKeyFile
        ? { trustedPublicKeyFile: explicitTrustedPublicKeyFile }
        : {}),
      ...(explicitTrustPolicy ? { trustPolicy: explicitTrustPolicy } : {}),
      requiresNetworkConsent: /^https?:\/\//i.test(explicitSource)
    };
  }

  const bundledRoot = bundledServerPackageRoot(environment);
  const bundledArchive = bundledRoot
    ? firstFileWithSuffix(bundledRoot, ".tar.gz")
    : null;
  if (bundledArchive) {
    const bundledSha256File = `${bundledArchive}.sha256`;
    const bundledProvenanceFile =
      bundledProvenanceForArchive(bundledArchive) ?? undefined;
    if (!nodeExistsSync(bundledSha256File)) {
      return {
        available: false,
        sourceKind: "unavailable",
        useBundledFallback: false,
        message:
          "Bundled koed-server package artifact is present, but its SHA-256 file is missing.",
        action:
          "Rebuild Koed Desktop packaging so the standalone package archive and .sha256 file are both included."
      };
    }
    return {
      available: true,
      source: bundledArchive,
      sourceKind: "bundled",
      sha256File: bundledSha256File,
      ...(bundledProvenanceFile
        ? { provenanceFile: bundledProvenanceFile }
        : {}),
      requiresNetworkConsent: false
    };
  }

  return {
    available: false,
    sourceKind: "unavailable",
    useBundledFallback: true,
    message:
      "No standalone koed-server package source is configured or bundled with this Desktop build.",
    action:
      "Continue with the bundled fallback runtime, or configure KOED_SERVER_PACKAGE_SOURCE with SHA-256 metadata."
  };
};

const packageComponent = (
  packageStatus: ServerPackageStatusPayload | null,
  installPlan: ServerPackageInstallPlan
): NonNullable<KoedServerStatus["serverPackage"]> => {
  const state = String(packageStatus?.state ?? "missing");
  const message =
    typeof packageStatus?.message === "string"
      ? packageStatus.message
      : installPlan.available
        ? "Standalone koed-server package can be installed."
        : installPlan.message;
  if (
    packageStatus?.ok === true &&
    (state === "installed" || state === "activated" || state === "cleaned")
  ) {
    const currentVersion =
      typeof packageStatus.currentVersion === "string"
        ? packageStatus.currentVersion
        : undefined;
    return {
      state: "healthy",
      message,
      ...(currentVersion ? { currentVersion } : {}),
      source: "standalone",
      details: {
        currentTarget: packageStatus.currentTarget,
        sourceKind: installPlan.sourceKind
      }
    };
  }
  if (
    state === "missing" &&
    !installPlan.available &&
    installPlan.useBundledFallback
  ) {
    return {
      state: "healthy",
      message:
        "Using the bundled fallback koed-server runtime; a standalone package is optional for this Desktop build.",
      source: "bundled-fallback",
      details: { sourceKind: installPlan.sourceKind }
    };
  }
  if (state === "missing") {
    return {
      state: "not_configured",
      message: installPlan.available ? message : installPlan.message,
      action: installPlan.available
        ? "Install standalone koed-server package"
        : installPlan.action,
      source: "unavailable",
      details: { sourceKind: installPlan.sourceKind }
    };
  }
  return {
    state: "needs_attention",
    message,
    action:
      typeof packageStatus?.action === "string"
        ? packageStatus.action
        : "Run koed-server package status --json for details.",
    source: "unavailable",
    details: {
      sourceKind: installPlan.sourceKind,
      errors: packageStatus?.errors
    }
  };
};

const backendIdFromResult = (value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;
  const backend = (value as { backend?: unknown }).backend;
  if (!backend || typeof backend !== "object") return null;
  const id = (backend as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
};

const activationUrlFromResult = (value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;
  const enrollment = (value as { enrollment?: unknown }).enrollment;
  if (!enrollment || typeof enrollment !== "object") return null;
  const activationUrl = (enrollment as { activationUrl?: unknown })
    .activationUrl;
  return typeof activationUrl === "string" && activationUrl.trim()
    ? activationUrl.trim()
    : null;
};

const resultOk = (value: unknown): boolean =>
  Boolean(value && typeof value === "object" && (value as { ok?: unknown }).ok);

const resultState = (value: unknown): string | null =>
  value &&
  typeof value === "object" &&
  typeof (value as { state?: unknown }).state === "string"
    ? (value as { state: string }).state
    : null;

const pendingEnrollmentBackendIds = (value: unknown): string[] => {
  if (!value || typeof value !== "object") return [];
  const upstreamBackends = (value as { upstreamBackends?: unknown })
    .upstreamBackends;
  if (!upstreamBackends || typeof upstreamBackends !== "object") return [];
  const details = (upstreamBackends as { details?: unknown }).details;
  if (!details || typeof details !== "object") return [];
  const backends = (details as { backends?: unknown }).backends;
  if (!Array.isArray(backends)) return [];
  return backends.flatMap((backend) => {
    if (!backend || typeof backend !== "object") return [];
    const id = (backend as { id?: unknown }).id;
    const credential = (backend as { credential?: unknown }).credential;
    const credentialStatus =
      credential && typeof credential === "object"
        ? (credential as { status?: unknown }).status
        : null;
    return typeof id === "string" && id.trim() && credentialStatus === "unknown"
      ? [id.trim()]
      : [];
  });
};

const bundledLocalDatabaseUrl = (environment: NodeJS.ProcessEnv): string => {
  const ports = readDesktopPorts(environment);
  const user = environment.POSTGRES_USER ?? "koed";
  const password =
    environment.POSTGRES_PASSWORD ??
    environment.KOED_BUNDLED_POSTGRES_PASSWORD ??
    "koed-local-postgres";
  const database = environment.POSTGRES_DB ?? "koed";
  const host = environment.KOED_POSTGRES_HOST ?? "127.0.0.1";
  const port =
    environment.KOED_POSTGRES_PORT ??
    environment.POSTGRES_HOST_PORT ??
    ports.postgres ??
    "15432";
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
};

const validateTeamBackendUrl = (
  value: unknown
): { ok: true; url: string } | { ok: false; error: string } => {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, error: "Team Backend URL is required." };
  }
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol) || !url.hostname) {
      return {
        ok: false,
        error: "Team Backend URL must be an HTTP(S) origin."
      };
    }
    if (url.username || url.password || url.search || url.hash) {
      return {
        ok: false,
        error:
          "Team Backend URL cannot include credentials, a query string, or a fragment."
      };
    }
    return { ok: true, url: url.toString().replace(/\/$/, "") };
  } catch {
    return {
      ok: false,
      error: "Team Backend URL must be a valid HTTP(S) origin."
    };
  }
};

const hasHealthyApi = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || !("api" in value)) {
    return false;
  }
  const api = (value as { api?: unknown }).api;
  return (
    typeof api === "object" &&
    api !== null &&
    "state" in api &&
    (api as { state?: unknown }).state === "healthy"
  );
};

export const createKoedEnvironment = (
  repoRoot: string,
  environment: NodeJS.ProcessEnv,
  options: {
    desktopManagedLocal?: boolean;
    packagedResourcesPath?: string;
  } = {}
): NodeJS.ProcessEnv => {
  const dependencyMode = options.desktopManagedLocal
    ? (environment.KOED_DEPENDENCY_MODE ?? "bundled-local")
    : environment.KOED_DEPENDENCY_MODE;
  return {
    ...environment,
    ...(!options.desktopManagedLocal || environment.KOED_REPO_ROOT?.trim()
      ? { KOED_REPO_ROOT: environment.KOED_REPO_ROOT ?? repoRoot }
      : {}),
    ...(dependencyMode === "bundled-local" && !environment.KOED_AUTO_PORTS
      ? { KOED_AUTO_PORTS: "1" }
      : {}),
    ...(options.desktopManagedLocal
      ? {
          KOED_RUNTIME_MODE: environment.KOED_RUNTIME_MODE ?? "local-personal",
          KOED_DEPENDENCY_MODE: dependencyMode,
          WORK_QUEUE_BACKEND: environment.WORK_QUEUE_BACKEND ?? "local",
          KOED_PACKAGED_DESKTOP: environment.KOED_PACKAGED_DESKTOP ?? "1",
          KOED_PACKAGED_RESOURCES_PATH:
            environment.KOED_PACKAGED_RESOURCES_PATH ??
            options.packagedResourcesPath ??
            repoRoot
        }
      : {})
  };
};

export const createKoedServerManager = ({
  repoRoot,
  cliPath,
  environment,
  createCliInvocation,
  existsSync,
  execFile,
  openExternal,
  openPath
}: KoedServerManagerOptions): KoedServerManager => {
  let serverProcess: ChildProcess | null = null;
  let enrollmentReconciliation: Promise<void> | null = null;
  const startOutputLines: string[] = [];
  void environment;

  const runJson = (args: string[], timeout = 30_000) =>
    new Promise<unknown>((resolvePromise) => {
      if (!existsSync(cliPath)) {
        resolvePromise(missingCliPayload(repoRoot, cliPath));
        return;
      }

      const invocation = createCliInvocation([...args, "--json"]);
      execFile(
        invocation.command,
        invocation.args,
        {
          cwd: repoRoot,
          env: invocation.env,
          timeout
        },
        (error, stdout, stderr) => {
          try {
            resolvePromise(JSON.parse(stdout));
          } catch {
            const message =
              error?.message ??
              (stderr.trim() || stdout.trim() || "koed-server command failed.");
            resolvePromise(
              args[0] === "status"
                ? diagnosticStatus({
                    state: "needs_attention",
                    message,
                    repoRoot,
                    cliPath,
                    details: { stdout: stdout.trim(), stderr: stderr.trim() }
                  })
                : {
                    ok: false,
                    state: "needs_attention",
                    error: message,
                    stdout: stdout.trim(),
                    stderr: stderr.trim()
                  }
            );
          }
        }
      );
    });

  const selectedRuntimeInstallProvider = () =>
    runtimeInstallProvider(environment, existsSync);

  const runRuntimeStatusJson = () =>
    runJson(
      ["runtime", "status", "--provider", selectedRuntimeInstallProvider()],
      60_000
    );

  const runRuntimeInstallJson = async (args?: Record<string, unknown>) => {
    const provider = selectedRuntimeInstallProvider();
    if (provider === "homebrew" && args?.operatorConsented !== true) {
      return {
        ok: false,
        state: "needs_attention",
        provider,
        error:
          "Operator consent is required before Koed Desktop may mutate Homebrew package-manager state.",
        action:
          "Confirm the Homebrew runtime install prompt, then retry runtime install."
      };
    }
    return runJson(
      [
        "runtime",
        "install",
        "--provider",
        provider,
        "--dependency-mode",
        "bundled-local"
      ],
      600_000
    );
  };

  const runModelJson = () =>
    runJson(["models", "status", "--kind", "embedding"], 60_000);

  const runModelInstallJson = () =>
    runJson(["models", "install", "--kind", "embedding"], 600_000);

  const runPackageStatusJson = () => runJson(["package", "status"], 60_000);

  const runPackageInstallJson = async (args?: Record<string, unknown>) => {
    const plan = resolveServerPackageInstallPlan(environment);
    if (!plan.available) {
      return {
        ok: false,
        state: "needs_attention",
        error: plan.message,
        action: plan.action,
        sourceKind: plan.sourceKind
      };
    }
    if (plan.requiresNetworkConsent && args?.operatorConsented !== true) {
      return {
        ok: false,
        state: "needs_attention",
        sourceKind: plan.sourceKind,
        error:
          "Operator consent is required before Koed Desktop may download a standalone koed-server package.",
        action:
          "Confirm the package download prompt, then retry package install."
      };
    }
    return runJson(
      [
        "package",
        "install",
        "--source",
        plan.source,
        ...(plan.sha256 ? ["--sha256", plan.sha256] : []),
        ...(plan.sha256File ? ["--sha256-file", plan.sha256File] : []),
        ...(plan.provenanceFile
          ? ["--provenance-file", plan.provenanceFile]
          : []),
        ...(plan.signatureFile ? ["--signature-file", plan.signatureFile] : []),
        ...(plan.trustedPublicKeyFile
          ? ["--trusted-public-key-file", plan.trustedPublicKeyFile]
          : []),
        ...(plan.trustPolicy ? ["--trust-policy", plan.trustPolicy] : []),
        "--activate"
      ],
      600_000
    );
  };

  const withPackageComponent = async (value: unknown): Promise<unknown> => {
    if (typeof value !== "object" || value === null || !("api" in value)) {
      return value;
    }
    const packageStatus =
      (await runPackageStatusJson()) as ServerPackageStatusPayload | null;
    return {
      ...value,
      serverPackage: packageComponent(
        packageStatus,
        resolveServerPackageInstallPlan(environment)
      )
    };
  };

  const scheduleEnrollmentReconciliation = (current: unknown): void => {
    const backendIds = pendingEnrollmentBackendIds(current);
    if (backendIds.length === 0 || enrollmentReconciliation) {
      return;
    }
    const reconciliation = (async () => {
      for (const backendId of backendIds) {
        await runJson(
          ["upstream", "enroll", "status", "--id", backendId],
          15_000
        );
      }
    })();
    enrollmentReconciliation = reconciliation;
    void reconciliation
      .catch(() => undefined)
      .finally(() => {
        if (enrollmentReconciliation === reconciliation) {
          enrollmentReconciliation = null;
        }
      });
  };

  const statusWithEnrollmentReconciliation = async (): Promise<unknown> => {
    const current = await runJson(["status"], 10_000);
    scheduleEnrollmentReconciliation(current);
    return withPackageComponent(current);
  };

  const pollUntilReady = async () => {
    let latest: unknown = null;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      latest = await runJson(["status"], 10_000);
      if (hasHealthyApi(latest)) {
        await provisionExplorerCredential();
        return withDesktopStartLog(latest, startOutputLines);
      }
      await sleep(1_000);
    }
    return withDesktopStartLog(
      latest ?? {
        ok: false,
        state: "needs_attention",
        error: "Timed out waiting for koed-server status."
      },
      startOutputLines
    );
  };

  const provisionExplorerCredential = (force = false) =>
    new Promise<{ ok: true; apiToken: string } | { ok: false; error: string }>(
      (resolvePromise) => {
        const current = readExplorerCredential(environment);
        if (current.ok && !force) {
          resolvePromise(current);
          return;
        }
        if (environment.KOED_AUTO_PORTS !== "1") {
          resolvePromise(current);
          return;
        }
        if (environment.KOED_PACKAGED_DESKTOP === "1") {
          resolvePromise({
            ok: false,
            error:
              "Explorer credential is not provisioned. Restart Koed so packaged koed-server can create the Desktop API Token without workspace pnpm scripts."
          });
          return;
        }

        execFile(
          "pnpm",
          [
            "api-token:create",
            "--owner-email",
            "desktop@koed.local",
            "--name",
            "Koed Desktop"
          ],
          {
            cwd: repoRoot,
            env: {
              ...environment,
              DATABASE_URL: bundledLocalDatabaseUrl(environment)
            },
            timeout: 120_000
          },
          (error, stdout, stderr) => {
            if (error) {
              resolvePromise({
                ok: false,
                error: stderr.trim() || stdout.trim() || error.message
              });
              return;
            }
            const token = parseCreatedApiToken(stdout);
            if (!token) {
              resolvePromise({
                ok: false,
                error: `Could not parse Koed API Token from output: ${stdout.trim()}`
              });
              return;
            }
            const credentialPath = resolveExplorerCredentialPath(environment);
            mkdirSync(resolve(credentialPath, ".."), { recursive: true });
            writeFileSync(
              credentialPath,
              `${JSON.stringify(
                {
                  apiToken: token,
                  provisionedAt: new Date().toISOString(),
                  source: "environment"
                },
                null,
                2
              )}\n`,
              { mode: 0o600 }
            );
            resolvePromise({ ok: true, apiToken: token });
          }
        );
      }
    );

  const requestDaemonStart = async () => {
    const current = await runJson(["status"], 10_000);
    if (hasHealthyApi(current)) {
      await provisionExplorerCredential();
      return current;
    }

    if (serverProcess && !serverProcess.killed) {
      return {
        ok: true,
        state: "starting",
        message: "Koed server daemon is already starting."
      };
    }
    if (!existsSync(cliPath)) {
      return missingCliPayload(repoRoot, cliPath);
    }

    startOutputLines.length = 0;
    const invocation = createCliInvocation(["start", "--daemon"]);
    appendOutputLines(
      startOutputLines,
      `$ ${invocation.command} ${invocation.args.join(" ")}`
    );
    const result = await runJson(["start", "--daemon"], 45_000);
    if (typeof result === "object" && result !== null) {
      const payload = result as {
        message?: unknown;
        error?: unknown;
        startedPid?: unknown;
      };
      const message =
        typeof payload.message === "string"
          ? payload.message
          : typeof payload.error === "string"
            ? payload.error
            : "koed-server start --daemon completed.";
      appendOutputLines(
        startOutputLines,
        `${message}${payload.startedPid ? ` pid ${payload.startedPid}` : ""}`
      );
    }
    return withDesktopStartLog(result, startOutputLines);
  };

  const start = async () => {
    const result = await requestDaemonStart();
    if (
      typeof result === "object" &&
      result !== null &&
      (result as { ok?: unknown }).ok === false
    ) {
      return result;
    }
    return pollUntilReady();
  };

  const connectTeamBackend = async (args?: Record<string, unknown>) => {
    const parsedUrl = validateTeamBackendUrl(args?.url);
    if (!parsedUrl.ok) {
      return { ok: false, error: parsedUrl.error };
    }
    const registerResult = await runJson(
      [
        "upstream",
        "register",
        "--url",
        parsedUrl.url,
        "--name",
        "Team Backend",
        "--profile",
        "team_self_hosted"
      ],
      45_000
    );
    if (!resultOk(registerResult)) {
      return registerResult;
    }
    const backendId = backendIdFromResult(registerResult);
    if (!backendId) {
      return {
        ok: false,
        error: "Upstream registration did not return a backend id."
      };
    }
    const refreshResult = await runJson(
      ["upstream", "refresh", "--id", backendId],
      45_000
    );
    if (!resultOk(refreshResult)) {
      return refreshResult;
    }
    const policyResult = await runJson(
      [
        "upstream",
        "policy",
        "--id",
        backendId,
        "--team-workspace-read",
        "enabled",
        "--share-grant-management",
        "enabled"
      ],
      45_000
    );
    if (!resultOk(policyResult)) {
      return policyResult;
    }
    const enrollResult = await runJson(
      ["upstream", "enroll", "start", "--id", backendId],
      60_000
    );
    if (!resultOk(enrollResult)) {
      return enrollResult;
    }
    const activationUrl = activationUrlFromResult(enrollResult);
    if (resultState(enrollResult) !== "pending" || !activationUrl) {
      return {
        ok: false,
        backendId,
        error:
          "Team Backend enrollment did not return a new pending browser approval challenge."
      };
    }
    try {
      void openExternal(activationUrl).catch(() => undefined);
    } catch {
      // The approval URL remains available when the platform cannot launch it.
    }
    return {
      ok: true,
      backendId,
      activationUrl,
      browserOpenRequested: true,
      register: registerResult,
      refresh: refreshResult,
      policy: policyResult,
      enrollment: enrollResult,
      message:
        "Team Backend enrollment started. Complete approval in the browser."
    };
  };

  const disconnectTeamBackend = async (args?: Record<string, unknown>) => {
    const backendId =
      typeof args?.backendId === "string" && args.backendId.trim()
        ? args.backendId.trim()
        : null;
    if (backendId) {
      return await runJson(
        ["upstream", "disconnect", "--id", backendId],
        45_000
      );
    }
    const statusResult = await runJson(["status"], 10_000);
    const details =
      statusResult && typeof statusResult === "object"
        ? (statusResult as KoedServerStatus).upstreamBackends?.details
        : undefined;
    const backends = Array.isArray(
      (details as { backends?: unknown } | undefined)?.backends
    )
      ? ((details as { backends: Array<{ id?: unknown }> }).backends ?? [])
      : [];
    const firstBackendId =
      typeof backends[0]?.id === "string" ? backends[0].id : null;
    if (!firstBackendId) {
      return { ok: false, error: "No upstream Team Backend is registered." };
    }
    return await runJson(
      ["upstream", "disconnect", "--id", firstBackendId],
      45_000
    );
  };

  const stop = async () => {
    const result = await runJson(["stop"], 45_000);
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill("SIGTERM");
    }
    serverProcess = null;
    return result;
  };

  return {
    handlers: {
      status: async () =>
        withDesktopStartLog(
          await statusWithEnrollmentReconciliation(),
          startOutputLines
        ),
      doctor: () => runJson(["doctor"], 45_000),
      stop,
      setup_codex: () => runJson(["setup", "codex"], 120_000),
      repair_codex: () => runJson(["repair", "codex"], 120_000),
      runtime_status: () => runRuntimeStatusJson(),
      runtime_install: (args) => runRuntimeInstallJson(args),
      models_status: () => runModelJson(),
      models_install: () => runModelInstallJson(),
      package_status: () => runPackageStatusJson(),
      package_install: (args) => runPackageInstallJson(args),
      project_list: () => runJson(["project", "list"], 10_000),
      personal_sync_status: () => runJson(["personal-sync", "status"], 10_000),
      personal_sync_pause: () =>
        runJson(["personal-sync", "policy", "pause"], 20_000),
      personal_sync_resume: () =>
        runJson(["personal-sync", "policy", "resume"], 20_000),
      personal_sync_retry: () => runJson(["personal-sync", "retry"], 20_000),
      personal_sync_join_request: () =>
        runJson(["personal-sync", "join", "request"], 20_000),
      personal_sync_recovery_guidance: () =>
        runJson(["personal-sync", "recovery", "guidance"], 10_000),
      personal_sync_revoke: (args) => {
        const deviceId =
          typeof args?.deviceId === "string" ? args.deviceId : "";
        if (!deviceId) return { ok: false, error: "deviceId is required." };
        return runJson(
          ["personal-sync", "device", "revoke", "--device-id", deviceId],
          20_000
        );
      },
      explorer_credential: (args) =>
        provisionExplorerCredential(args?.force === true),
      upstream_connect: connectTeamBackend,
      upstream_disconnect: disconnectTeamBackend,
      start,
      start_daemon: requestDaemonStart,
      open_external: async (args) => {
        const url = typeof args?.url === "string" ? args.url : "";
        if (!url) {
          return { ok: false, error: "url is required." };
        }
        await openExternal(url);
        return { ok: true };
      },
      open_logs: async () => {
        const logsDir = resolve(resolveKoedHome(environment), "logs");
        if (openPath) {
          const error = await openPath(logsDir);
          return error ? { ok: false, error } : { ok: true, path: logsDir };
        }
        await openExternal(`file://${logsDir}`);
        return { ok: true, path: logsDir };
      }
    },
    stop
  };
};
