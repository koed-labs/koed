import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  collaborationRendererCommandSchema,
  fetchBoundedJsonObject,
  isLoopbackHostname,
  readDesktopLocalCredentialAuthorization,
  PERSONAL_DESKTOP_CONTRACT_VERSION,
  personalDesktopChangeSchema,
  personalDesktopEventsDataSchema,
  personalDesktopProjectsDataSchema,
  personalDesktopRequestSchema,
  personalDesktopResultSchema,
  personalDesktopSessionProjectDataSchema,
  type CollaborationRendererEvent,
  type PersonalDesktopChange,
  type PersonalDesktopRequest,
  type PersonalDesktopResult
} from "@koed/shared";
import {
  installLocalModel,
  resolveKoedServerPaths,
  runPersonalSyncCommand
} from "@koed/koed-server";
import {
  existsSync as nodeExistsSync,
  readFileSync,
  readdirSync
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  ComponentState,
  ComponentStatus,
  DesktopSetupSnapshot,
  DesktopSetupStageId,
  KoedServerStatus
} from "../types.js";
import type { DesktopCommandName } from "../ipc/protocol.js";
import {
  parseManagedConversationResult,
  type ManagedConversationRequest,
  type ManagedConversationResult
} from "../ipc/managed-conversation-protocol.js";
import { createCollaborationLocalTransport } from "../collaboration/local-transport.js";
import { safeExternalUrl } from "../window/external-url.js";
import {
  desktopOnboardingStatePath,
  readDesktopOnboardingComplete,
  writeDesktopOnboardingComplete
} from "../window/onboarding-state.js";
import type { NodeEntrypointInvocation } from "./runtime.js";
import {
  createDesktopSetupWorkflow,
  type DesktopSetupActionResult,
  type DesktopSetupCheck
} from "./setup-workflow.js";
import {
  resolvePersonalDevicePairingPort,
  startPersonalDevicePairingServer,
  type PersonalDevicePairingInvitation,
  type PersonalDevicePairingServer
} from "../personal-device-pairing-server.js";
import {
  decryptPersonalDevicePairingMessage,
  encryptPersonalDevicePairingMessage
} from "../personal-device-pairing-crypto.js";
import { parsePersonalDevicePairingLink } from "../personal-device-pairing-link.js";
import {
  withProtectedJsonFd,
  withProtectedTextFd
} from "../ipc/protected-json-fd.js";
import {
  PERSONAL_DEVICE_PAIRING_PROGRESS_VERSION,
  type PersonalDevicePairingProgress
} from "../ipc/personal-device-pairing-protocol.js";

export interface DesktopCommandContext {
  ownerId: string;
  signal: AbortSignal;
  emitCollaborationEvent: (event: CollaborationRendererEvent) => void;
  emitPersonalDevicePairingProgress?: (
    progress: PersonalDevicePairingProgress
  ) => void;
  emitSetupProgress?: (snapshot: DesktopSetupSnapshot) => void;
}

export type DesktopCommandHandler = (
  args?: Record<string, unknown>,
  context?: DesktopCommandContext
) => unknown;

export type PersonalMemoryDesktopHandler = (
  request: PersonalDesktopRequest
) => Promise<PersonalDesktopResult>;

export type ManagedConversationDesktopHandler = (
  request: ManagedConversationRequest
) => Promise<ManagedConversationResult>;

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
      stdio: ["ignore", "ignore", "ignore", "ipc"];
      detached: false;
    }
  ) => ChildProcess;
  openExternal: (url: string) => Promise<unknown>;
  openPath?: (path: string) => Promise<string>;
  selectRecoveryKitPath?: () => Promise<string | null>;
  collaborationRandom?: () => number;
  collaborationNow?: () => number;
  collaborationSleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  personalMemoryFetch?: typeof fetch;
  startPairingServer?: typeof startPersonalDevicePairingServer;
}

export interface KoedServerManager {
  handlers: Record<DesktopCommandName, DesktopCommandHandler>;
  personalMemory: PersonalMemoryDesktopHandler;
  managedConversation: ManagedConversationDesktopHandler;
  subscribePersonalMemory: (
    listener: (change: PersonalDesktopChange) => void,
    signal: AbortSignal
  ) => Promise<void>;
  resume: () => Promise<unknown>;
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
  message
}: {
  state: ComponentState;
  message: string;
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
    personalDeviceSync: personalDeviceSyncComponent(process.env),
    upstreamBackends: {
      ...component("Connect Team Backend"),
      registered: 0,
      validated: 0,
      stale: 0,
      failed: 0,
      notChecked: 0
    },
    explorer: { ...component("Start Koed"), url: "" },
    lastVerification: { ...component("Run doctor"), checkedAt: null }
  } as DiagnosticStatus;
};

const missingCliPayload = () =>
  diagnosticStatus({
    state: "not_configured",
    message: "Koed's local service is unavailable."
  });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const statusCommandTimeoutMs = 30_000;

const waitForAbortOrDelay = (
  signal: AbortSignal,
  delayMs: number
): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

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
  } catch {
    return { ok: false, error: "Explorer credential could not be read." };
  }
};

type PersonalMemoryErrorCode =
  | "not_ready"
  | "not_found"
  | "request_failed"
  | "invalid_response";

class PersonalMemoryBoundaryError extends Error {
  constructor(
    readonly code: PersonalMemoryErrorCode,
    readonly retryable: boolean
  ) {
    super(code);
    this.name = "PersonalMemoryBoundaryError";
  }
}

const personalMemoryErrorMessage = (code: PersonalMemoryErrorCode): string => {
  if (code === "not_ready") return "Local Personal Memory is not ready.";
  if (code === "not_found") return "The Personal Memory item was not found.";
  if (code === "invalid_response") {
    return "Local Personal Memory returned an invalid response.";
  }
  return "The Local Personal Memory request failed.";
};

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const exactDesktopArgs = (
  value: Record<string, unknown> | undefined,
  allowedKeys: string[]
): Record<string, unknown> => {
  const args = value ?? {};
  const actual = Object.keys(args).sort();
  const expected = [...allowedKeys].sort();
  if (
    actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])
  ) {
    throw new Error("Desktop command arguments are invalid.");
  }
  return args;
};

const optionalExactDesktopArgs = (
  value: Record<string, unknown> | undefined,
  allowedKey: string
): Record<string, unknown> => {
  const keys = Object.keys(value ?? {});
  if (keys.length > 1 || (keys.length === 1 && keys[0] !== allowedKey)) {
    throw new Error("Desktop command arguments are invalid.");
  }
  return value ?? {};
};

const pairingIdArg = (args: Record<string, unknown> | undefined): string => {
  const value = exactDesktopArgs(args, ["id"]).id;
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value)) {
    throw new Error("Pairing invitation is unavailable.");
  }
  return value;
};

const localPersonalMemoryOrigin = (value: unknown): string | null => {
  const root = objectValue(value);
  const api = objectValue(root?.api);
  if (api?.state !== "healthy" || typeof api.url !== "string") return null;
  try {
    const parsed = new URL(api.url);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !isLoopbackHostname(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== "/" && parsed.pathname !== "")
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
};

const personalProjectsData = (payload: Record<string, unknown>) => {
  const projects = Array.isArray(payload.projects) ? payload.projects : null;
  if (!projects) {
    throw new PersonalMemoryBoundaryError("invalid_response", false);
  }
  return personalDesktopProjectsDataSchema.parse({
    projects: projects.map((projectValue) => {
      const project = objectValue(projectValue) ?? {};
      const threads = Array.isArray(project.threads) ? project.threads : [];
      return {
        id: project.id,
        name: project.name,
        path: project.path,
        eventCount: project.eventCount,
        threads: threads.map((threadValue) => {
          const thread = objectValue(threadValue) ?? {};
          return {
            id: thread.id,
            name: thread.name,
            sessionId: thread.sessionId,
            sourceAiClient: thread.sourceAiClient,
            projectId: thread.projectId,
            projectName: thread.projectName,
            projectPath: thread.projectPath,
            projectAssignmentSource: thread.projectAssignmentSource,
            eventCount: thread.eventCount,
            invalidatedCount: thread.invalidatedCount,
            latestAt: thread.latestAt,
            sample: thread.sample
          };
        })
      };
    })
  });
};

const personalEventsData = (payload: Record<string, unknown>) => {
  const events = Array.isArray(payload.events) ? payload.events : null;
  if (!events) {
    throw new PersonalMemoryBoundaryError("invalid_response", false);
  }
  return personalDesktopEventsDataSchema.parse({
    events: events.map((eventValue) => {
      const event = objectValue(eventValue) ?? {};
      const metadata = objectValue(event.metadata);
      return {
        id: event.id,
        actor: event.actor,
        eventType: event.eventType,
        timestamp: event.timestamp,
        sourceEventTime: event.sourceEventTime,
        sourceSequence: event.sourceSequence,
        ...(typeof event.content === "string"
          ? { content: event.content }
          : {}),
        contentPreview: event.contentPreview,
        invalidatedAt: event.invalidatedAt,
        metadata:
          typeof metadata?.toolName === "string"
            ? { toolName: metadata.toolName }
            : {}
      };
    })
  });
};

export const personalMemoryChangeFromSseFrame = (
  frame: string
): PersonalDesktopChange | null => {
  const lines = frame.split(/\r?\n/);
  const eventName =
    lines
      .find((line) => line.startsWith("event:"))
      ?.slice("event:".length)
      .trim() ?? "message";
  if (eventName !== "graph_update") return null;
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data || Buffer.byteLength(data, "utf8") > 256 * 1_024) return null;
  try {
    const payload = objectValue(JSON.parse(data));
    if (!payload) return null;
    const payloadEventRefs = Array.isArray(payload.eventRefs)
      ? payload.eventRefs
      : (payload.table === "memory_events" ||
            payload.table === "messages" ||
            payload.table === "tool_events") &&
          typeof payload.id === "string" &&
          typeof payload.projectId === "string" &&
          typeof payload.threadId === "string"
        ? [
            {
              id: payload.id,
              projectId: payload.projectId,
              threadId: payload.threadId
            }
          ]
        : [];
    const seen = new Set<string>();
    const eventRefs = payloadEventRefs.flatMap((value) => {
      const ref = objectValue(value);
      if (
        typeof ref?.id !== "string" ||
        typeof ref.projectId !== "string" ||
        typeof ref.threadId !== "string" ||
        seen.has(ref.id)
      ) {
        return [];
      }
      seen.add(ref.id);
      return [
        {
          id: ref.id,
          projectId: ref.projectId,
          threadId: ref.threadId
        }
      ];
    });
    const parsed = personalDesktopChangeSchema.safeParse({
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      type: "conversation_events_changed",
      eventRefs
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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
      message: "Standalone koed-server package is ready.",
      ...(currentVersion ? { currentVersion } : {}),
      source: "standalone",
      details: { sourceKind: installPlan.sourceKind }
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
    message: "Standalone koed-server package needs attention.",
    action: "Retry the local service check.",
    source: "unavailable",
    details: { sourceKind: installPlan.sourceKind }
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

const resultMessage = (value: unknown, fallback: string): string => {
  const result = objectValue(value);
  return (
    [result?.error, result?.message, result?.action].find(
      (part): part is string =>
        typeof part === "string" && part.trim().length > 0
    ) ?? fallback
  );
};

const componentHealthy = (value: unknown): boolean =>
  objectValue(value)?.state === "healthy";

const personalDeviceSyncComponent = (
  environment: NodeJS.ProcessEnv
): ComponentStatus => {
  switch (environment.PDS_DESKTOP_SECRET_STORAGE) {
    case "native_os":
      return diagnosticComponent(
        "healthy",
        "Secure device storage is available through the operating system."
      );
    case "windows_dpapi_wsl":
      return diagnosticComponent(
        "healthy",
        "Secure device storage is available through Windows DPAPI."
      );
    default:
      return diagnosticComponent(
        "needs_attention",
        "Personal Device Sync is unavailable because this device has no supported secure storage. Local Memory remains available."
      );
  }
};

export const setupServicesHealthy = (value: unknown): boolean => {
  const status = objectValue(value);
  return [
    status?.api,
    status?.database,
    status?.redis,
    status?.workerQueues,
    status?.embeddingService,
    status?.explorer
  ].every(componentHealthy);
};

export const setupStartupReady = (value: unknown): boolean =>
  setupServicesHealthy(value) && hasHealthyDesktopCredential(value);

export const desktopCodexSetupCommand = (
  status: unknown
): ["repair", "codex"] | ["setup", "codex"] =>
  componentHealthy(objectValue(status)?.apiToken)
    ? ["repair", "codex"]
    : ["setup", "codex"];

const browserActivationUrlFromResult = (value: unknown): string | null => {
  const activationUrl = activationUrlFromResult(value);
  if (!activationUrl) return null;
  try {
    const parsed = new URL(activationUrl);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname &&
      !parsed.username &&
      !parsed.password
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
};

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

const hasHealthyDesktopCredential = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || !("apiToken" in value)) {
    return false;
  }
  const apiToken = (value as { apiToken?: unknown }).apiToken;
  return (
    typeof apiToken === "object" &&
    apiToken !== null &&
    "state" in apiToken &&
    (apiToken as { state?: unknown }).state === "healthy"
  );
};

export const createKoedEnvironment = (
  repoRoot: string,
  environment: NodeJS.ProcessEnv,
  options: {
    desktopManagedLocal?: boolean;
    packagedDesktop?: boolean;
    packagedResourcesPath?: string;
  } = {}
): NodeJS.ProcessEnv => {
  const dependencyMode = options.desktopManagedLocal
    ? (environment.KOED_DEPENDENCY_MODE ?? "bundled-local")
    : environment.KOED_DEPENDENCY_MODE;
  return {
    ...environment,
    ...(!options.packagedDesktop || environment.KOED_REPO_ROOT?.trim()
      ? { KOED_REPO_ROOT: environment.KOED_REPO_ROOT ?? repoRoot }
      : {}),
    ...(dependencyMode === "bundled-local" && !environment.KOED_AUTO_PORTS
      ? { KOED_AUTO_PORTS: "1" }
      : {}),
    ...(options.desktopManagedLocal
      ? {
          KOED_RUNTIME_MODE: environment.KOED_RUNTIME_MODE ?? "local-personal",
          KOED_DEPENDENCY_MODE: dependencyMode,
          KOED_TEAM_COLLABORATION_ENABLED:
            environment.KOED_TEAM_COLLABORATION_ENABLED ?? "true",
          WORK_QUEUE_BACKEND: environment.WORK_QUEUE_BACKEND ?? "local",
          ...(options.packagedDesktop
            ? {
                KOED_PACKAGED_DESKTOP: environment.KOED_PACKAGED_DESKTOP ?? "1",
                KOED_PACKAGED_RESOURCES_PATH:
                  environment.KOED_PACKAGED_RESOURCES_PATH ??
                  options.packagedResourcesPath ??
                  repoRoot
              }
            : {})
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
  spawn,
  openExternal,
  openPath,
  selectRecoveryKitPath,
  personalMemoryFetch = globalThis.fetch,
  startPairingServer = startPersonalDevicePairingServer
}: KoedServerManagerOptions): KoedServerManager => {
  let serverProcess: ChildProcess | null = null;
  let enrollmentReconciliation: Promise<void> | null = null;
  let retainedPersonalApiOrigin: string | null = null;
  let retainedPersonalApiToken: string | null = null;
  let personalApiTokenProvisioning: Promise<
    { ok: true; apiToken: string } | { ok: false; error: string }
  > | null = null;
  let personalDevicePairingServer: PersonalDevicePairingServer | null = null;
  let personalDevicePairingServerStart: Promise<PersonalDevicePairingServer> | null =
    null;
  let personalDevicePairingServerError: string | null = null;
  void environment;

  const runJson = (args: string[], timeout = 30_000) =>
    new Promise<unknown>((resolvePromise) => {
      if (!existsSync(cliPath)) {
        resolvePromise(missingCliPayload());
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
        (_error, stdout) => {
          try {
            resolvePromise(JSON.parse(stdout));
          } catch {
            resolvePromise(
              args[0] === "status"
                ? diagnosticStatus({
                    state: "needs_attention",
                    message: "Koed status could not be read."
                  })
                : {
                    ok: false,
                    state: "needs_attention",
                    error: "Koed operation failed."
                  }
            );
          }
        }
      );
    });

  const createCollaborationTransport = () =>
    createCollaborationLocalTransport({
      openExternal,
      spawnBroker: (sessionToken) => {
        const invocation = createCliInvocation([
          "desktop",
          "collaboration-broker"
        ]);
        return spawn(invocation.command, invocation.args, {
          cwd: repoRoot,
          env: {
            ...invocation.env,
            KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
          },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          detached: false
        }) as never;
      }
    });
  const collaborationTransport = createCollaborationTransport();
  const onboardingStatePath = desktopOnboardingStatePath(
    resolveKoedHome(environment)
  );

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
    if (typeof value !== "object" || value === null) {
      return value;
    }
    const withPersonalDeviceSync = {
      ...value,
      personalDeviceSync: personalDeviceSyncComponent(environment)
    };
    if (!("api" in value)) return withPersonalDeviceSync;
    const packageStatus =
      (await runPackageStatusJson()) as ServerPackageStatusPayload | null;
    return {
      ...withPersonalDeviceSync,
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
    const current = await runJson(["status"], statusCommandTimeoutMs);
    scheduleEnrollmentReconciliation(current);
    return withPackageComponent(current);
  };

  const pollUntilReady = async (attemptLimit = 90) => {
    let latest: unknown = null;
    for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
      latest = await runJson(["status"], statusCommandTimeoutMs);
      if (setupStartupReady(latest)) {
        retainedPersonalApiOrigin = localPersonalMemoryOrigin(latest);
        await provisionExplorerCredential();
        return latest;
      }
      await sleep(1_000);
    }
    return (
      latest ?? {
        ok: false,
        state: "needs_attention",
        error: "Timed out waiting for koed-server status."
      }
    );
  };

  const provisionExplorerCredentialOnce = async () =>
    readExplorerCredential(environment);

  const provisionExplorerCredential = async (force = false) => {
    if (force) retainedPersonalApiToken = null;
    if (retainedPersonalApiToken && !force) {
      return { ok: true as const, apiToken: retainedPersonalApiToken };
    }
    if (personalApiTokenProvisioning) {
      return personalApiTokenProvisioning;
    }
    const provisioning = provisionExplorerCredentialOnce().then((result) => {
      if (result.ok) retainedPersonalApiToken = result.apiToken;
      return result;
    });
    personalApiTokenProvisioning = provisioning;
    try {
      return await provisioning;
    } finally {
      if (personalApiTokenProvisioning === provisioning) {
        personalApiTokenProvisioning = null;
      }
    }
  };

  const personalMemoryAccess = async ({
    refreshOrigin = false,
    refreshToken = false
  }: {
    refreshOrigin?: boolean;
    refreshToken?: boolean;
  } = {}) => {
    if (refreshOrigin) retainedPersonalApiOrigin = null;
    const current = retainedPersonalApiOrigin
      ? null
      : await runJson(["status"], statusCommandTimeoutMs);
    const apiOrigin =
      retainedPersonalApiOrigin ??
      (current ? localPersonalMemoryOrigin(current) : null);
    if (!apiOrigin) {
      throw new PersonalMemoryBoundaryError("not_ready", true);
    }
    retainedPersonalApiOrigin = apiOrigin;
    const credential = await provisionExplorerCredential(refreshToken);
    if (!credential.ok) {
      throw new PersonalMemoryBoundaryError("not_ready", true);
    }
    return { apiOrigin, apiToken: credential.apiToken };
  };

  const personalSyncEnvironment = async (
    overrides: NodeJS.ProcessEnv = {}
  ): Promise<{
    environment: NodeJS.ProcessEnv;
    desktopAuthorization: string;
  }> => {
    const current = retainedPersonalApiOrigin
      ? null
      : await runJson(["status"], statusCommandTimeoutMs);
    const apiOrigin =
      retainedPersonalApiOrigin ??
      (current ? localPersonalMemoryOrigin(current) : null);
    if (!apiOrigin) {
      throw new PersonalMemoryBoundaryError("not_ready", true);
    }
    retainedPersonalApiOrigin = apiOrigin;
    const desktop = readDesktopLocalCredentialAuthorization(
      resolveKoedHome(environment)
    );
    if (!desktop) {
      throw new Error("Koed Desktop local credential is unavailable.");
    }
    return {
      environment: {
        ...environment,
        PDS_CONTROL_URL: apiOrigin,
        ...(environment.PDS_RUNTIME_SECRET_REF?.trim()
          ? { PDS_RUNTIME_SECRET_REF: environment.PDS_RUNTIME_SECRET_REF }
          : {}),
        ...overrides
      },
      desktopAuthorization: desktop.authorization
    };
  };

  const runPersonalSync = async (
    args: string[],
    options: {
      environment?: NodeJS.ProcessEnv;
      desktopAuthorization?: string;
      pairingToken?: string;
      fetch?: typeof globalThis.fetch;
    } = {}
  ) => {
    const defaults =
      options.environment && options.desktopAuthorization === undefined
        ? null
        : await personalSyncEnvironment(options.environment);
    const commandEnvironment =
      options.environment ?? defaults?.environment ?? environment;
    return await runPersonalSyncCommand(
      args,
      resolveKoedServerPaths(commandEnvironment),
      commandEnvironment,
      {
        fetch: options.fetch ?? personalMemoryFetch,
        ...((options.desktopAuthorization ?? defaults?.desktopAuthorization)
          ? {
              desktopAuthorization:
                options.desktopAuthorization ??
                defaults?.desktopAuthorization ??
                undefined
            }
          : {}),
        ...(options.pairingToken ? { pairingToken: options.pairingToken } : {})
      }
    );
  };

  const reconcilePersonalDeviceLocalGroup = async (
    payload: Record<string, unknown>
  ): Promise<string> => {
    const { apiOrigin } = await personalMemoryAccess();
    const desktop = readDesktopLocalCredentialAuthorization(
      resolveKoedHome(environment)
    );
    if (!desktop) {
      throw new Error("Koed Desktop local credential is unavailable.");
    }
    const { response, payload: result } = await fetchBoundedJsonObject(
      personalMemoryFetch,
      new URL("/v1/personal-device-sync/local-group-reconciliation", apiOrigin),
      {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: desktop.authorization,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      },
      { timeoutMs: 30_000, maxBytes: 1_048_576, readErrorBody: true }
    );
    if (
      !response.ok ||
      !result.group ||
      typeof result.local_user_id !== "string"
    ) {
      const message =
        typeof result.error === "string"
          ? result.error
          : "Koed could not persist the local Personal Device Group.";
      throw new Error(message);
    }
    return result.local_user_id;
  };

  const wakePersonalDeviceSyncRuntime = async (): Promise<void> => {
    const { apiOrigin } = await personalMemoryAccess();
    const desktop = readDesktopLocalCredentialAuthorization(
      resolveKoedHome(environment)
    );
    if (!desktop) {
      throw new Error("Koed Desktop local credential is unavailable.");
    }
    const response = await personalMemoryFetch(
      new URL("/v1/personal-device-sync/local-runtime-wake", apiOrigin),
      {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: desktop.authorization
        },
        signal: AbortSignal.timeout(10_000)
      }
    );
    if (!response.ok) {
      throw new Error(
        "Koed could not activate the encrypted Personal Device Sync runtime."
      );
    }
  };

  const withPersonalSyncJsonFd = async <T>(
    payload: Record<string, unknown>,
    operation: (fd: number) => Promise<T>
  ): Promise<T> =>
    await withProtectedJsonFd(
      resolveKoedServerPaths(environment).runDir,
      "pds-ipc",
      payload,
      operation
    );

  const ensurePersonalDevicePairingServer =
    async (): Promise<PersonalDevicePairingServer> => {
      if (personalDevicePairingServer) return personalDevicePairingServer;
      if (personalDevicePairingServerStart)
        return await personalDevicePairingServerStart;
      personalDevicePairingServerStart = startPairingServer({
        port: resolvePersonalDevicePairingPort(environment.KOED_PDS_LAN_PORT),
        forwardControl: async (input) => {
          const { apiOrigin } = await personalMemoryAccess();
          const desktop = readDesktopLocalCredentialAuthorization(
            resolveKoedHome(environment)
          );
          if (!desktop && input.mode === "pairing") {
            throw new Error("Koed Desktop local credential is unavailable.");
          }
          const response = await personalMemoryFetch(
            new URL(input.path, apiOrigin),
            {
              method: input.method,
              redirect: "error",
              headers: {
                accept: "application/json",
                ...input.headers,
                ...(input.mode === "pairing"
                  ? { authorization: desktop!.authorization }
                  : {})
              },
              ...(input.body === undefined ? {} : { body: input.body }),
              signal: AbortSignal.timeout(
                input.mode === "relay" &&
                  input.path === "/v1/personal-device-sync/relay/wake"
                  ? 31 * 60_000
                  : 10_000
              )
            }
          );
          const body = await response.text();
          if (Buffer.byteLength(body, "utf8") > 1_048_576) {
            throw new Error("PDS control response exceeds maximum size.");
          }
          return {
            status: response.status,
            headers: {
              "content-type":
                response.headers.get("content-type") ??
                "application/json; charset=utf-8"
            },
            body
          };
        }
      });
      try {
        personalDevicePairingServer = await personalDevicePairingServerStart;
        personalDevicePairingServerError = null;
        return personalDevicePairingServer;
      } finally {
        personalDevicePairingServerStart = null;
      }
    };

  const personalSyncStatusWithLanRelay = async () => {
    const status = await runPersonalSync(["status"]);
    const groups = Array.isArray(status.groups) ? status.groups : [];
    const invitationGroupIds = Array.isArray(
      status.pairing_invitation_group_ids
    )
      ? status.pairing_invitation_group_ids.filter(
          (groupId): groupId is string => typeof groupId === "string"
        )
      : [];
    if (groups.length === 0 || invitationGroupIds.length === 0) {
      personalDevicePairingServerError = null;
      return status;
    }
    try {
      await ensurePersonalDevicePairingServer();
      personalDevicePairingServerError = null;
      return status;
    } catch {
      personalDevicePairingServerError =
        "Same-network Personal Device relay could not be started.";
      return {
        ...status,
        ok: false,
        state: "needs_attention",
        error: personalDevicePairingServerError
      };
    }
  };

  const pairingExchange = async (
    invitationUrl: URL,
    invitationId: string,
    token: string,
    payload: Record<string, unknown>,
    timeoutMs = 10_000
  ): Promise<Record<string, unknown>> => {
    const encrypted = encryptPersonalDevicePairingMessage(payload, {
      invitationId,
      token,
      direction: "request"
    });
    const response = await personalMemoryFetch(
      new URL(`/v1/pair/${invitationId}/exchange`, invitationUrl.origin),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify(encrypted),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs)
      }
    );
    const responseBody = await response.json();
    if (!response.ok) {
      throw new Error(
        responseBody &&
          typeof responseBody === "object" &&
          !Array.isArray(responseBody) &&
          typeof (responseBody as { error?: unknown }).error === "string"
          ? (responseBody as { error: string }).error
          : "Pairing exchange failed."
      );
    }
    const decrypted = decryptPersonalDevicePairingMessage(responseBody, {
      invitationId,
      token,
      direction: "response"
    });
    if (decrypted.messageId !== encrypted.message_id) {
      throw new Error("Pairing response binding is invalid.");
    }
    return decrypted.value;
  };

  const pairingControlFetch = (
    invitationUrl: URL,
    invitationId: string,
    token: string,
    controlUrl: URL
  ): typeof globalThis.fetch =>
    (async (input: URL | RequestInfo, init?: RequestInit) => {
      const requestedUrl = new URL(
        input instanceof URL
          ? input.toString()
          : typeof input === "string"
            ? input
            : input.url
      );
      const controlPrefix = controlUrl.toString().replace(/\/$/, "");
      if (
        requestedUrl.origin !== controlUrl.origin ||
        !requestedUrl.toString().startsWith(`${controlPrefix}/`)
      ) {
        throw new Error("Pairing control request escaped its invitation.");
      }
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method !== "GET" && method !== "POST") {
        throw new Error("Pairing control method is invalid.");
      }
      const rawBody =
        typeof init?.body === "string"
          ? init.body
          : init?.body === undefined
            ? undefined
            : (() => {
                throw new Error("Pairing control body is invalid.");
              })();
      const headers = new Headers(init?.headers);
      const result = await pairingExchange(invitationUrl, invitationId, token, {
        operation: "control",
        method,
        path: requestedUrl.toString().slice(controlPrefix.length),
        headers: Object.fromEntries(
          ["accept", "content-type"].flatMap((name) => {
            const value = headers.get(name);
            return value ? [[name, value]] : [];
          })
        ),
        ...(rawBody === undefined ? {} : { body: rawBody })
      });
      if (
        typeof result.status !== "number" ||
        typeof result.body !== "string"
      ) {
        throw new Error("Pairing control response is invalid.");
      }
      return new Response(result.body, {
        status: result.status,
        headers:
          result.headers &&
          typeof result.headers === "object" &&
          !Array.isArray(result.headers)
            ? (result.headers as Record<string, string>)
            : { "content-type": "application/json; charset=utf-8" }
      });
    }) as typeof globalThis.fetch;

  const redeemPersonalDevicePairing = async (
    value: unknown,
    deviceLabel: unknown,
    requestId: string,
    onProgress: (progress: PersonalDevicePairingProgress) => void
  ) => {
    const { invitationUrl, token, invitationId } =
      parsePersonalDevicePairingLink(value);
    const invitationPayload = await pairingExchange(
      invitationUrl,
      invitationId,
      token,
      { operation: "invitation" }
    );
    if (
      !invitationPayload ||
      typeof invitationPayload !== "object" ||
      Array.isArray(invitationPayload)
    ) {
      throw new Error("Pairing invitation could not be loaded.");
    }
    const invitation = (invitationPayload as { invitation?: unknown })
      .invitation;
    if (
      !invitation ||
      typeof invitation !== "object" ||
      Array.isArray(invitation)
    ) {
      throw new Error("Pairing invitation is invalid.");
    }
    const typedInvitation =
      invitation as unknown as PersonalDevicePairingInvitation;
    const controlUrl = new URL(typedInvitation.control_url);
    const relayUrl = new URL(typedInvitation.relay_url);
    if (
      typedInvitation.protocol !== "koed/pds-lan-pair/v1" ||
      controlUrl.origin !== invitationUrl.origin ||
      controlUrl.pathname !== `/v1/pair/${invitationId}/exchange` ||
      relayUrl.origin !== invitationUrl.origin ||
      relayUrl.pathname !== "/pds"
    ) {
      throw new Error("Pairing invitation endpoint binding is invalid.");
    }
    const join = await withPersonalSyncJsonFd(
      typedInvitation as unknown as Record<string, unknown>,
      async (fd) =>
        await runPersonalSync(
          [
            "join",
            "request",
            "--group-id",
            typedInvitation.group_id,
            "--invitation-fd",
            String(fd)
          ],
          {
            environment: {
              ...environment,
              PDS_CONTROL_URL: controlUrl.toString(),
              PDS_RUNTIME_SECRET_REF:
                environment.PDS_RUNTIME_SECRET_REF?.trim() || "pds-runtime"
            },
            pairingToken: token,
            fetch: pairingControlFetch(
              invitationUrl,
              invitationId,
              token,
              controlUrl
            )
          }
        )
    );
    const request = join.request;
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("Koed could not create the signed pairing request.");
    }
    const joinPairing =
      join.pairing && typeof join.pairing === "object"
        ? (join.pairing as Record<string, unknown>)
        : null;
    if (
      !joinPairing ||
      typeof joinPairing.shortCode !== "string" ||
      !/^[0-9A-F]{8}$/.test(joinPairing.shortCode)
    ) {
      throw new Error("Koed could not verify the pairing short code.");
    }
    onProgress({
      contractVersion: PERSONAL_DEVICE_PAIRING_PROGRESS_VERSION,
      requestId,
      state: "approval_pending",
      shortCode: joinPairing.shortCode
    });
    const submitted = await pairingExchange(
      invitationUrl,
      invitationId,
      token,
      {
        operation: "request",
        request,
        device_label:
          typeof deviceLabel === "string" && deviceLabel.trim()
            ? deviceLabel.trim().slice(0, 80)
            : "New device"
      },
      10 * 60 * 1_000
    );
    if (submitted.approved !== true) {
      throw new Error("Pairing approval was not completed.");
    }
    const completed = await runPersonalSync(
      [
        "join",
        "complete",
        "--group-id",
        typedInvitation.group_id,
        "--challenge-id",
        typedInvitation.challenge_id
      ],
      {
        environment: {
          ...environment,
          PDS_CONTROL_URL: controlUrl.toString(),
          PDS_RUNTIME_SECRET_REF:
            environment.PDS_RUNTIME_SECRET_REF?.trim() || "pds-runtime"
        },
        pairingToken: token,
        fetch: pairingControlFetch(
          invitationUrl,
          invitationId,
          token,
          controlUrl
        )
      }
    );
    const localGroupReconciliation = completed.localGroupReconciliation;
    if (
      !localGroupReconciliation ||
      typeof localGroupReconciliation !== "object" ||
      Array.isArray(localGroupReconciliation)
    ) {
      throw new Error(
        "Koed could not verify the joining device's local sync state."
      );
    }
    const localUserId = await reconcilePersonalDeviceLocalGroup(
      localGroupReconciliation as Record<string, unknown>
    );
    await runPersonalSync([
      "join",
      "bind-local-user",
      "--group-id",
      typedInvitation.group_id,
      "--user-id",
      localUserId,
      "--challenge-id",
      typedInvitation.challenge_id
    ]);
    await wakePersonalDeviceSyncRuntime();
    const completion = await pairingExchange(
      invitationUrl,
      invitationId,
      token,
      { operation: "complete" }
    );
    if (completion.completed !== true) {
      throw new Error("Pairing invitation was not closed after enrollment.");
    }
    const publicResult = { ...completed };
    delete publicResult.localGroupReconciliation;
    return publicResult;
  };

  const authenticatedPersonalMemoryRequest = async (
    request: (access: { apiOrigin: string; apiToken: string }) => {
      url: URL;
      init: RequestInit;
    },
    maximumResponseBytes: number
  ): Promise<Record<string, unknown>> => {
    const perform = async (options?: {
      refreshOrigin?: boolean;
      refreshToken?: boolean;
    }) => {
      const access = await personalMemoryAccess(options);
      const exactRequest = request(access);
      try {
        return await fetchBoundedJsonObject(
          personalMemoryFetch,
          exactRequest.url,
          {
            ...exactRequest.init,
            redirect: "error",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${access.apiToken}`,
              ...exactRequest.init.headers
            }
          },
          { timeoutMs: 30_000, maxBytes: maximumResponseBytes }
        );
      } catch {
        if (!options?.refreshOrigin) {
          return perform({ ...options, refreshOrigin: true });
        }
        throw new PersonalMemoryBoundaryError("request_failed", true);
      }
    };

    let remote = await perform();
    let response = remote.response;
    if (response.status === 401) {
      retainedPersonalApiToken = null;
      remote = await perform({ refreshOrigin: true, refreshToken: true });
      response = remote.response;
    }
    if (!response.ok) {
      const status = response.status;
      await response.body?.cancel().catch(() => undefined);
      throw new PersonalMemoryBoundaryError(
        status === 404
          ? "not_found"
          : status === 401
            ? "not_ready"
            : "request_failed",
        status === 401 || status === 408 || status === 429 || status >= 500
      );
    }
    return remote.payload;
  };

  const listPersonalProjects = async () =>
    personalProjectsData(
      await authenticatedPersonalMemoryRequest(
        ({ apiOrigin }) => {
          const url = new URL("/v1/memory/graph/threads", apiOrigin);
          url.search = new URLSearchParams({
            limit: "500",
            offset: "0",
            includeInvalidated: "false"
          }).toString();
          return { url, init: { method: "GET" } };
        },
        16 * 1_024 * 1_024
      )
    );

  const managedExecutionFrom = (
    value: unknown
  ): {
    id: string;
    projectId: string;
    state: string;
    executionGeneration: number;
    sessionId: string | null;
    providerThreadId: string | null;
  } | null => {
    const execution = objectValue(value);
    if (
      typeof execution?.id !== "string" ||
      typeof execution.projectId !== "string" ||
      typeof execution.state !== "string" ||
      typeof execution.executionGeneration !== "number"
    ) {
      return null;
    }
    return {
      id: execution.id,
      projectId: execution.projectId,
      state: execution.state,
      executionGeneration: execution.executionGeneration,
      sessionId:
        typeof execution.sessionId === "string" ? execution.sessionId : null,
      providerThreadId:
        typeof execution.providerThreadId === "string"
          ? execution.providerThreadId
          : null
    };
  };

  const listManagedExecutions = async (projectId?: string) => {
    const payload = await authenticatedPersonalMemoryRequest(
      ({ apiOrigin }) => {
        const url = new URL("/v1/managed-conversations", apiOrigin);
        if (projectId) url.searchParams.set("projectId", projectId);
        url.searchParams.set("limit", "500");
        return { url, init: { method: "GET" } };
      },
      2 * 1_024 * 1_024
    );
    if (!Array.isArray(payload.executions)) {
      throw new PersonalMemoryBoundaryError("invalid_response", false);
    }
    return payload.executions
      .map(managedExecutionFrom)
      .filter((value): value is NonNullable<typeof value> => value !== null);
  };

  const getManagedExecution = async (executionId: string) => {
    const payload = await authenticatedPersonalMemoryRequest(
      ({ apiOrigin }) => ({
        url: new URL(
          `/v1/managed-conversations/${encodeURIComponent(executionId)}`,
          apiOrigin
        ),
        init: { method: "GET" }
      }),
      1 * 1_024 * 1_024
    );
    const execution = managedExecutionFrom(payload.execution);
    if (!execution || execution.id !== executionId) {
      throw new PersonalMemoryBoundaryError("invalid_response", false);
    }
    return execution;
  };

  const managedTransferFrom = (
    value: unknown,
    operation: "handoff" | "fork"
  ) => {
    if (value === null) return null;
    const transfer = objectValue(value);
    if (
      typeof transfer?.operationId !== "string" ||
      typeof transfer.state !== "string" ||
      typeof transfer.targetDeviceId !== "string" ||
      typeof transfer.updatedAt !== "string" ||
      (transfer.failureCode !== null &&
        typeof transfer.failureCode !== "string") ||
      (operation === "fork" &&
        transfer.childExecutionId !== null &&
        typeof transfer.childExecutionId !== "string")
    ) {
      throw new PersonalMemoryBoundaryError("invalid_response", false);
    }
    return {
      operation,
      operationId: transfer.operationId,
      state: transfer.state,
      targetDeviceId: transfer.targetDeviceId,
      childExecutionId:
        operation === "fork" && typeof transfer.childExecutionId === "string"
          ? transfer.childExecutionId
          : null,
      failureCode:
        typeof transfer.failureCode === "string" ? transfer.failureCode : null,
      updatedAt: transfer.updatedAt
    };
  };

  const managedConversation: ManagedConversationDesktopHandler = async (
    request
  ) => {
    if (request.operation === "start") {
      const payload = await authenticatedPersonalMemoryRequest(
        ({ apiOrigin }) => ({
          url: new URL("/v1/managed-conversations", apiOrigin),
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              projectId: request.projectId,
              idempotencyKey: request.idempotencyKey
            })
          }
        }),
        1 * 1_024 * 1_024
      );
      const execution = managedExecutionFrom(payload.execution);
      if (!execution) {
        throw new PersonalMemoryBoundaryError("invalid_response", false);
      }
      const ready =
        execution.state === "running" &&
        execution.sessionId &&
        execution.providerThreadId;
      return parseManagedConversationResult({
        operation: "start",
        status: ready ? "ready" : "starting",
        executionId: execution.id,
        ...(ready
          ? {
              conversation: {
                executionId: execution.id,
                projectId: execution.projectId,
                capturedSessionId: execution.sessionId,
                threadId: execution.providerThreadId
              }
            }
          : {})
      });
    }

    if (request.operation === "inspect") {
      const execution = await getManagedExecution(request.executionId);
      const ready =
        execution.state === "running" &&
        execution.sessionId &&
        execution.providerThreadId;
      const failed = ["failed", "fenced", "stopped"].includes(execution.state);
      return parseManagedConversationResult({
        operation: "inspect",
        status: ready
          ? "ready"
          : execution.state === "reconciling"
            ? "reconciling"
            : failed
              ? "failed"
              : "starting",
        executionId: execution.id,
        ...(ready
          ? {
              conversation: {
                executionId: execution.id,
                projectId: execution.projectId,
                capturedSessionId: execution.sessionId,
                threadId: execution.providerThreadId
              }
            }
          : {}),
        ...(failed
          ? {
              message:
                "Codex could not start this Conversation. Start a new Conversation to try again."
            }
          : execution.state === "reconciling"
            ? {
                message:
                  "Koed is reconciling the provider runtime before allowing more prompts."
              }
            : {})
      });
    }

    if (request.operation === "targets") {
      const payload = await authenticatedPersonalMemoryRequest(
        ({ apiOrigin }) => ({
          url: new URL("/v1/managed-conversations/target-devices", apiOrigin),
          init: { method: "GET" }
        }),
        1 * 1_024 * 1_024
      );
      if (!Array.isArray(payload.devices)) {
        throw new PersonalMemoryBoundaryError("invalid_response", false);
      }
      return parseManagedConversationResult({
        operation: "targets",
        devices: payload.devices
      });
    }

    if (request.operation === "transfer_status") {
      const payload = await authenticatedPersonalMemoryRequest(
        ({ apiOrigin }) => ({
          url: new URL(
            `/v1/managed-conversations/${encodeURIComponent(
              request.executionId
            )}/transfers/latest`,
            apiOrigin
          ),
          init: { method: "GET" }
        }),
        1 * 1_024 * 1_024
      );
      return parseManagedConversationResult({
        operation: "transfer_status",
        executionId: request.executionId,
        handoff: managedTransferFrom(payload.handoff, "handoff"),
        fork: managedTransferFrom(payload.fork, "fork")
      });
    }

    if (request.operation === "handoff" || request.operation === "fork") {
      await authenticatedPersonalMemoryRequest(
        ({ apiOrigin }) => ({
          url: new URL(
            `/v1/managed-conversations/${encodeURIComponent(
              request.executionId
            )}/${request.operation === "handoff" ? "handoffs" : "forks"}`,
            apiOrigin
          ),
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              actionGrantId: request.actionGrantId,
              operationId: request.operationId,
              targetDeviceId: request.targetDeviceId,
              ...(request.operation === "fork"
                ? { reason: request.reason }
                : {})
            })
          }
        }),
        1 * 1_024 * 1_024
      );
      return parseManagedConversationResult({
        operation: request.operation,
        status: "queued",
        executionId: request.executionId,
        operationId: request.operationId,
        targetDeviceId: request.targetDeviceId
      });
    }

    const executions = await listManagedExecutions(
      request.operation === "resume" ? request.projectId : undefined
    );
    const execution = executions.find(
      (candidate) =>
        candidate.sessionId === request.capturedSessionId &&
        candidate.providerThreadId === request.threadId
    );
    const conversation = {
      executionId: execution?.id ?? null,
      projectId:
        request.operation === "resume"
          ? request.projectId
          : (execution?.projectId ?? ""),
      capturedSessionId: request.capturedSessionId,
      threadId: request.threadId
    };
    if (request.operation === "resume") {
      return parseManagedConversationResult({
        operation: "resume",
        status:
          execution?.state === "running"
            ? "ready"
            : execution?.state === "reconciling"
              ? "reconciling"
              : "read_only",
        conversation,
        ...(execution?.state === "reconciling"
          ? {
              message:
                "Koed is reconciling the last provider operation. Prompt submission remains disabled."
            }
          : execution?.state === "running"
            ? {}
            : {
                message:
                  "This Captured Session is not owned by a writable local Koed runtime."
              })
      });
    }
    if (!execution || execution.state !== "running") {
      return parseManagedConversationResult({
        operation: "send",
        status: "reconciling",
        conversation,
        idempotencyKey: request.idempotencyKey,
        message:
          "The managed Conversation is not writable. Koed will not submit this prompt automatically."
      });
    }
    await authenticatedPersonalMemoryRequest(
      ({ apiOrigin }) => ({
        url: new URL(
          `/v1/managed-conversations/${encodeURIComponent(execution.id)}/prompts`,
          apiOrigin
        ),
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            executionGeneration: execution.executionGeneration,
            idempotencyKey: request.idempotencyKey,
            prompt: request.prompt
          })
        }
      }),
      1 * 1_024 * 1_024
    );
    return parseManagedConversationResult({
      operation: "send",
      status: "queued",
      conversation,
      idempotencyKey: request.idempotencyKey
    });
  };

  const loadPersonalEventPage = async (
    input: Extract<
      PersonalDesktopRequest,
      { operation: "personal.events.load_page" }
    >["input"]
  ) =>
    personalEventsData(
      await authenticatedPersonalMemoryRequest(
        ({ apiOrigin }) => {
          const url = new URL("/v1/memory/graph/events", apiOrigin);
          url.searchParams.set("projectId", input.projectId);
          url.searchParams.set("threadId", input.threadId);
          url.searchParams.set("limit", String(input.limit));
          url.searchParams.set("includeContent", "true");
          url.searchParams.set("includeInvalidated", "false");
          if (input.cursor) {
            url.searchParams.set("cursorTimestamp", input.cursor.timestamp);
            url.searchParams.set("cursorId", input.cursor.id);
            if (input.cursor.sourceSequence !== null) {
              url.searchParams.set(
                "cursorSourceSequence",
                String(input.cursor.sourceSequence)
              );
            }
          }
          return { url, init: { method: "GET" } };
        },
        32 * 1_024 * 1_024
      )
    );

  const assignPersonalSessionProject = async (
    input: Extract<
      PersonalDesktopRequest,
      { operation: "personal.sessions.assign_project" }
    >["input"]
  ) => {
    const target =
      input.action === "move"
        ? (await listPersonalProjects()).projects.find(
            (project) => project.id === input.targetProjectId
          )
        : null;
    if (input.action === "move" && (!target || target.id === "unassigned")) {
      throw new PersonalMemoryBoundaryError("not_found", false);
    }
    const payload = await authenticatedPersonalMemoryRequest(
      ({ apiOrigin }) => ({
        url: new URL(
          `/v1/memory/graph/sessions/${encodeURIComponent(input.sessionId)}/project`,
          apiOrigin
        ),
        init: {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            input.action === "reset"
              ? { action: "reset" }
              : {
                  action: "move",
                  project: {
                    id: target!.id,
                    name: target!.name,
                    path: target!.path
                  }
                }
          )
        }
      }),
      1 * 1_024 * 1_024
    );
    const session = objectValue(payload.session);
    if (!session || !("project" in session)) {
      throw new PersonalMemoryBoundaryError("invalid_response", false);
    }
    const project =
      session.project === null ? null : objectValue(session.project);
    if (session.project !== null && !project) {
      throw new PersonalMemoryBoundaryError("invalid_response", false);
    }
    return personalDesktopSessionProjectDataSchema.parse({
      projectId: project?.id ?? null
    });
  };

  const personalMemory: PersonalMemoryDesktopHandler = async (value) => {
    const request = personalDesktopRequestSchema.parse(value);
    try {
      const data =
        request.operation === "personal.projects.list"
          ? await listPersonalProjects()
          : request.operation === "personal.events.load_page"
            ? await loadPersonalEventPage(request.input)
            : await assignPersonalSessionProject(request.input);
      return personalDesktopResultSchema.parse({
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        operation: request.operation,
        ok: true,
        data
      });
    } catch (cause) {
      const boundaryError =
        cause instanceof PersonalMemoryBoundaryError
          ? cause
          : new PersonalMemoryBoundaryError("invalid_response", false);
      return personalDesktopResultSchema.parse({
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        operation: request.operation,
        ok: false,
        error: {
          code: boundaryError.code,
          message: personalMemoryErrorMessage(boundaryError.code),
          retryable: boundaryError.retryable
        }
      });
    }
  };

  const subscribePersonalMemory = async (
    listener: (change: PersonalDesktopChange) => void,
    signal: AbortSignal
  ): Promise<void> => {
    while (!signal.aborted) {
      try {
        let access = await personalMemoryAccess();
        const requestStream = (current: typeof access) =>
          personalMemoryFetch(
            new URL("/v1/memory/graph/stream", current.apiOrigin),
            {
              method: "GET",
              redirect: "error",
              signal,
              headers: {
                accept: "text/event-stream",
                authorization: `Bearer ${current.apiToken}`
              }
            }
          );
        let response = await requestStream(access);
        if (response.status === 401) {
          await response.body?.cancel().catch(() => undefined);
          retainedPersonalApiToken = null;
          access = await personalMemoryAccess({
            refreshOrigin: true,
            refreshToken: true
          });
          response = await requestStream(access);
        }
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => undefined);
          throw new PersonalMemoryBoundaryError("request_failed", true);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (Buffer.byteLength(buffer, "utf8") > 1_048_576) {
            await reader.cancel().catch(() => undefined);
            throw new PersonalMemoryBoundaryError("invalid_response", true);
          }
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const change = personalMemoryChangeFromSseFrame(frame);
            if (change) listener(change);
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch {
        if (signal.aborted) break;
      }
      await waitForAbortOrDelay(signal, 1_500);
    }
  };

  const requestDaemonStart = async () => {
    const current = await runJson(["status"], statusCommandTimeoutMs);
    if (hasHealthyApi(current)) {
      retainedPersonalApiOrigin = localPersonalMemoryOrigin(current);
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
      return missingCliPayload();
    }

    const result = await runJson(["start", "--daemon"], 45_000);
    return result;
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
    const ready = await pollUntilReady();
    await personalSyncStatusWithLanRelay().catch(() => undefined);
    return ready;
  };

  const resume = async () => {
    const verificationPath = resolve(
      resolveKoedHome(environment),
      "run",
      "last-verification.json"
    );
    if (!existsSync(verificationPath)) {
      return {
        ok: true,
        state: "not_configured",
        skipped: true,
        message: "Fresh Desktop setup has not been verified yet."
      };
    }
    try {
      const result = await requestDaemonStart();
      if (
        typeof result === "object" &&
        result !== null &&
        (result as { ok?: unknown }).ok === false
      ) {
        return result;
      }
      const ready = await pollUntilReady(30);
      await personalSyncStatusWithLanRelay().catch(() => undefined);
      return ready;
    } catch (error) {
      return {
        ok: false,
        state: "needs_attention",
        message:
          error instanceof Error
            ? error.message
            : "Koed local services could not be resumed."
      };
    }
  };

  const connectTeamBackend = async (
    args?: Record<string, unknown>,
    options: { openBrowser?: boolean } = { openBrowser: true }
  ) => {
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
        "enabled",
        "--sync",
        "enabled",
        "--admin",
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
    if (resultState(enrollResult) === "exchanged") {
      return {
        ok: true,
        state: "exchanged",
        backendId,
        register: registerResult,
        refresh: refreshResult,
        policy: policyResult,
        enrollment: enrollResult,
        message: "Team Backend enrollment is connected."
      };
    }
    const activationUrl = browserActivationUrlFromResult(enrollResult);
    if (resultState(enrollResult) !== "pending" || !activationUrl) {
      return {
        ok: false,
        backendId,
        error:
          "Team Backend enrollment did not return a new pending browser approval challenge."
      };
    }
    if (options.openBrowser !== false) {
      try {
        void openExternal(activationUrl).catch(() => undefined);
      } catch {
        // The approval URL remains available when the platform cannot launch it.
      }
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

  let setupInspection: Promise<
    Record<DesktopSetupStageId, DesktopSetupCheck>
  > | null = null;
  const inspectSetupStages = () => {
    if (setupInspection) return setupInspection;
    setupInspection = Promise.all([
      runPackageStatusJson(),
      runRuntimeStatusJson(),
      runModelJson(),
      statusWithEnrollmentReconciliation()
    ])
      .then(
        ([packageStatus, runtimeStatus, modelStatus, statusValue]): Record<
          DesktopSetupStageId,
          DesktopSetupCheck
        > => {
          const status = objectValue(statusValue);
          const packageStatusComponent = packageComponent(
            objectValue(packageStatus),
            resolveServerPackageInstallPlan(environment)
          );
          const servicesComplete = setupServicesHealthy(status);
          const integrationComplete = [
            status?.apiToken,
            status?.mcpServer,
            status?.captureHook,
            status?.codex,
            status?.lcmSummaryService
          ].every(componentHealthy);
          const verificationComplete = componentHealthy(
            status?.lastVerification
          );
          return {
            package: {
              complete: packageStatusComponent.state === "healthy",
              message:
                packageStatusComponent.state === "healthy"
                  ? "Koed package is ready."
                  : (packageStatusComponent.message ??
                    "Koed package needs attention.")
            },
            runtime: {
              complete:
                resultOk(runtimeStatus) &&
                resultState(runtimeStatus) === "installed",
              message:
                resultState(runtimeStatus) === "installed"
                  ? "Local runtime is ready."
                  : resultMessage(
                      runtimeStatus,
                      "Local runtime needs to be installed."
                    )
            },
            model: {
              complete: resultState(modelStatus) === "installed",
              message:
                resultState(modelStatus) === "installed"
                  ? "Embedding model is verified."
                  : resultMessage(
                      modelStatus,
                      "Embedding model needs to be downloaded."
                    )
            },
            services: {
              complete: servicesComplete,
              message: servicesComplete
                ? "Local services are running."
                : "Local services need to be started."
            },
            integration: {
              complete: integrationComplete,
              message: integrationComplete
                ? "Codex integration is configured."
                : "Codex, MCP, and Capture Hook need to be configured."
            },
            verification: {
              complete: verificationComplete,
              message: verificationComplete
                ? "Setup verification passed."
                : "Setup needs a final verification."
            }
          };
        }
      )
      .finally(() => {
        setupInspection = null;
      });
    return setupInspection;
  };

  const inspectSetupStage = async (
    stage: DesktopSetupStageId
  ): Promise<DesktopSetupCheck> => (await inspectSetupStages())[stage];

  const setupActionResult = (
    value: unknown,
    fallback: string
  ): DesktopSetupActionResult => ({
    ok: resultOk(value),
    message: resultMessage(value, fallback)
  });

  const runSetupStage = async (
    stage: DesktopSetupStageId,
    onProgress: (progress: {
      completedBytes: number | null;
      message: string;
      totalBytes: number | null;
    }) => void
  ): Promise<DesktopSetupActionResult> => {
    switch (stage) {
      case "package": {
        onProgress({
          completedBytes: null,
          message: "Preparing the Koed package…",
          totalBytes: null
        });
        return setupActionResult(
          await runPackageInstallJson({ operatorConsented: true }),
          "Koed package installation failed."
        );
      }
      case "runtime": {
        onProgress({
          completedBytes: null,
          message: "Installing local runtime dependencies…",
          totalBytes: null
        });
        return setupActionResult(
          await runRuntimeInstallJson({ operatorConsented: true }),
          "Local runtime installation failed."
        );
      }
      case "model": {
        const result = await installLocalModel(
          resolveKoedServerPaths(environment),
          "embedding",
          environment,
          {
            fetch: personalMemoryFetch,
            onProgress: (progress) => {
              onProgress({
                completedBytes: progress.completedBytes,
                message:
                  progress.phase === "downloading"
                    ? "Downloading embedding model…"
                    : progress.phase === "verifying"
                      ? "Verifying embedding model…"
                      : "Embedding model verified.",
                totalBytes: progress.totalBytes
              });
            }
          }
        );
        return {
          ok: result.ok,
          message: result.message
        };
      }
      case "services": {
        onProgress({
          completedBytes: null,
          message: "Starting local services…",
          totalBytes: null
        });
        const result = await start();
        return {
          ok: setupServicesHealthy(result),
          message: setupServicesHealthy(result)
            ? "Local services are running."
            : resultMessage(result, "Local services could not be started.")
        };
      }
      case "integration": {
        onProgress({
          completedBytes: null,
          message: "Configuring Codex, MCP, and Capture Hook…",
          totalBytes: null
        });
        const current = objectValue(await statusWithEnrollmentReconciliation());
        return setupActionResult(
          await runJson(desktopCodexSetupCommand(current), 120_000),
          "Codex integration could not be configured."
        );
      }
      case "verification": {
        onProgress({
          completedBytes: null,
          message: "Running final verification…",
          totalBytes: null
        });
        return setupActionResult(
          await runJson(["doctor"], 90_000),
          "Setup verification failed."
        );
      }
    }
  };

  const setupWorkflow = createDesktopSetupWorkflow({
    inspectStage: inspectSetupStage,
    runStage: runSetupStage
  });

  const stop = async () => {
    await collaborationTransport.stop();
    if (personalDevicePairingServer) {
      await personalDevicePairingServer.close();
      personalDevicePairingServer = null;
    }
    const result = await runJson(["stop"], 45_000);
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill("SIGTERM");
    }
    serverProcess = null;
    return result;
  };

  return {
    personalMemory,
    managedConversation,
    subscribePersonalMemory,
    resume,
    handlers: {
      status: statusWithEnrollmentReconciliation,
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
      personal_sync_status: async () => {
        const status = await personalSyncStatusWithLanRelay();
        return personalDevicePairingServerError
          ? {
              ...status,
              ok: false,
              state: "needs_attention",
              error: personalDevicePairingServerError
            }
          : status;
      },
      personal_sync_group_bootstrap: async () => {
        const recoveryKitPath = await selectRecoveryKitPath?.();
        if (!recoveryKitPath) {
          return {
            ok: false,
            state: "cancelled",
            error: "Recovery kit location was not selected."
          };
        }
        const recoveryCode = randomBytes(32).toString("base64url");
        const created = await withProtectedTextFd(
          resolveKoedServerPaths(environment).runDir,
          "pds-recovery-code",
          recoveryCode,
          (passwordFd) =>
            runPersonalSync([
              "group",
              "bootstrap",
              "--recovery-kit",
              recoveryKitPath,
              "--password-fd",
              String(passwordFd)
            ])
        );
        if (!created.ok) return created;
        return {
          ...created,
          recoveryCode,
          recoveryKitPath
        };
      },
      personal_sync_group_activate: async () => {
        await wakePersonalDeviceSyncRuntime();
        return { ok: true, state: "active" };
      },
      personal_sync_pause: (args) =>
        runJson(
          [
            "personal-sync",
            "policy",
            "pause",
            "--group-id",
            String(args?.groupId ?? "")
          ],
          20_000
        ),
      personal_sync_resume: (args) =>
        runJson(
          [
            "personal-sync",
            "policy",
            "resume",
            "--group-id",
            String(args?.groupId ?? "")
          ],
          20_000
        ),
      personal_sync_retry: (args) =>
        runJson(
          ["personal-sync", "retry", "--group-id", String(args?.groupId ?? "")],
          20_000
        ),
      personal_sync_join_request: (args) =>
        runJson(
          [
            "personal-sync",
            "join",
            "request",
            "--group-id",
            String(args?.groupId ?? "")
          ],
          20_000
        ),
      personal_sync_pairing_create: async (args) => {
        const pairingArgs = optionalExactDesktopArgs(args, "groupId");
        const requestedGroupId =
          typeof pairingArgs.groupId === "string"
            ? pairingArgs.groupId.trim()
            : "";
        if (
          requestedGroupId &&
          !/^[\x21-\x7e]{1,240}$/.test(requestedGroupId)
        ) {
          throw new Error("Personal Device Group is invalid.");
        }
        const current = requestedGroupId
          ? null
          : await runPersonalSync(["status"]);
        const groups =
          current && Array.isArray(current.groups) ? current.groups : [];
        const groupId =
          requestedGroupId ||
          (groups.length === 1 &&
          groups[0] &&
          typeof groups[0] === "object" &&
          !Array.isArray(groups[0]) &&
          typeof (groups[0] as { group_id?: unknown }).group_id === "string"
            ? ((groups[0] as { group_id: string }).group_id ?? "")
            : "");
        if (!groupId) {
          return {
            ok: false,
            state: "not_configured",
            error:
              "Set up Personal Device Sync on this device before pairing another device."
          };
        }
        const status = current ?? (await runPersonalSync(["status"]));
        const invitationGroupIds = Array.isArray(
          status.pairing_invitation_group_ids
        )
          ? status.pairing_invitation_group_ids.filter(
              (candidate): candidate is string => typeof candidate === "string"
            )
          : [];
        if (!invitationGroupIds.includes(groupId)) {
          return {
            ok: false,
            state: "authority_host_required",
            error:
              "Create the pairing link on the device that originally set up this Personal Device Group."
          };
        }
        const created = await runPersonalSync([
          "invite",
          "create",
          "--group-id",
          groupId
        ]);
        if (
          !created.invitation ||
          typeof created.invitation !== "object" ||
          Array.isArray(created.invitation)
        ) {
          throw new Error("Koed could not create a pairing invitation.");
        }
        const invitation = created.invitation as Record<string, unknown>;
        const authority = invitation.authority;
        if (
          !authority ||
          typeof authority !== "object" ||
          Array.isArray(authority)
        ) {
          throw new Error("Koed created an invalid pairing invitation.");
        }
        const server = await ensurePersonalDevicePairingServer();
        const view = server.createInvitation({
          group_id: String(invitation.group_id ?? ""),
          challenge_id: String(invitation.challenge_id ?? ""),
          challenge: String(invitation.challenge ?? ""),
          expires_at: String(invitation.expires_at ?? ""),
          browser_subject_id: String(invitation.browser_subject_id ?? ""),
          browser_deployment_id: String(invitation.browser_deployment_id ?? ""),
          authority: {
            key_id: String((authority as Record<string, unknown>).key_id ?? ""),
            public_key: String(
              (authority as Record<string, unknown>).public_key ?? ""
            )
          }
        });
        return { ok: true, state: view.state, pairing: view };
      },
      personal_sync_pairing_wait: async (args, context) => {
        const id = pairingIdArg(args);
        if (!personalDevicePairingServer) {
          throw new Error("Pairing invitation is unavailable.");
        }
        await personalDevicePairingServer.waitForRequest(id, context?.signal);
        const pairing = personalDevicePairingServer.inspect(id)[0];
        return { ok: true, state: pairing?.state ?? "cancelled", pairing };
      },
      personal_sync_pairing_approve: async (args, context) => {
        const id = pairingIdArg(args);
        if (!personalDevicePairingServer) {
          throw new Error("Pairing invitation is unavailable.");
        }
        const request = await personalDevicePairingServer.waitForRequest(id);
        const result = await withPersonalSyncJsonFd(
          { request },
          async (fd) =>
            await runPersonalSync([
              "active-device",
              "approve",
              "--request-fd",
              String(fd)
            ])
        );
        personalDevicePairingServer.approve(id);
        await personalDevicePairingServer.waitForCompletion(
          id,
          context?.signal
        );
        await runPersonalSync(["active-device", "refresh"]);
        await wakePersonalDeviceSyncRuntime();
        return {
          ...result,
          state: "completed",
          pairing: personalDevicePairingServer.inspect(id)[0]
        };
      },
      personal_sync_pairing_cancel: (args) => {
        const id = pairingIdArg(args);
        personalDevicePairingServer?.cancel(id);
        return { ok: true, state: "cancelled" };
      },
      personal_sync_pairing_redeem: async (args, context) => {
        const pairingArgs = exactDesktopArgs(args, [
          "url",
          "deviceLabel",
          "requestId"
        ]);
        if (
          typeof pairingArgs.url !== "string" ||
          typeof pairingArgs.deviceLabel !== "string" ||
          typeof pairingArgs.requestId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            pairingArgs.requestId
          ) ||
          pairingArgs.deviceLabel.length < 1 ||
          pairingArgs.deviceLabel.length > 80 ||
          /[\r\n\0]/.test(pairingArgs.deviceLabel)
        ) {
          throw new Error("Pairing request is invalid.");
        }
        return await redeemPersonalDevicePairing(
          pairingArgs.url,
          pairingArgs.deviceLabel,
          pairingArgs.requestId,
          (progress) => {
            context?.emitPersonalDevicePairingProgress?.(progress);
          }
        );
      },
      personal_sync_recovery_guidance: () =>
        runJson(["personal-sync", "recovery", "guidance"], 10_000),
      personal_sync_revoke: (args) => {
        const deviceId =
          typeof args?.deviceId === "string" ? args.deviceId : "";
        if (!deviceId) return { ok: false, error: "deviceId is required." };
        const groupId = typeof args?.groupId === "string" ? args.groupId : "";
        if (!groupId) return { ok: false, error: "groupId is required." };
        return runJson(
          [
            "personal-sync",
            "device",
            "revoke",
            "--group-id",
            groupId,
            "--device-id",
            deviceId
          ],
          20_000
        );
      },
      upstream_connect: (args) => connectTeamBackend(args),
      collaboration: async (args, context) => {
        const command = collaborationRendererCommandSchema.parse(args);
        if (!context) {
          throw new Error("Collaboration IPC context is required.");
        }
        return await collaborationTransport.request(command, context);
      },
      start,
      start_daemon: requestDaemonStart,
      open_external: async (args) => {
        const url =
          typeof args?.url === "string" ? safeExternalUrl(args.url) : null;
        if (!url) {
          return { ok: false, error: "A supported external URL is required." };
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
      },
      onboarding_status: () => ({
        complete: readDesktopOnboardingComplete(onboardingStatePath)
      }),
      onboarding_complete: () => {
        writeDesktopOnboardingComplete(onboardingStatePath);
        return { complete: true };
      },
      setup_inspect: () => setupWorkflow.inspect(),
      setup_run: (args, context) => {
        if (args?.operatorConsented !== true) {
          throw new Error("Setup requires explicit operator consent.");
        }
        if (!context?.emitSetupProgress) {
          throw new Error("Desktop setup context is required.");
        }
        return setupWorkflow.run(context.emitSetupProgress, context.signal);
      }
    },
    stop
  };
};
