import type {
  ComponentState,
  ComponentStatus,
  KoedServerStatus
} from "../../../types.js";
import type { DesktopCommand } from "../../services/desktop-commands.js";

export type SetupStepId =
  | "package"
  | "runtime"
  | "model"
  | "services"
  | "integration"
  | "health";

export type SetupStep = {
  action: {
    command: DesktopCommand;
    label: string;
    requiresConsent: boolean;
  } | null;
  components: readonly {
    label: string;
    status: ComponentStatus;
  }[];
  description: string;
  id: SetupStepId;
  state: ComponentState;
  title: string;
};

const unavailable = (message: string): ComponentStatus => ({
  state: "not_configured",
  message
});

const aggregateState = (
  components: readonly ComponentStatus[]
): ComponentState => {
  if (components.every(({ state }) => state === "healthy")) return "healthy";
  if (components.some(({ state }) => state === "needs_attention")) {
    return "needs_attention";
  }
  if (components.some(({ state }) => state === "starting")) return "starting";
  return "not_configured";
};

const step = (
  definition: Omit<SetupStep, "state"> & {
    components: SetupStep["components"];
  }
): SetupStep => ({
  ...definition,
  state: aggregateState(definition.components.map(({ status }) => status))
});

export const setupStepsFromStatus = (status: KoedServerStatus): SetupStep[] => {
  const serverPackage =
    status.serverPackage ??
    unavailable("Standalone server package status is unavailable.");
  const localAiRuntime =
    status.localAiRuntime ??
    unavailable("Local AI Runtime status is unavailable.");
  const integrationAction =
    status.apiToken.state !== "healthy" ||
    status.mcpServer.state !== "healthy" ||
    localAiRuntime.state !== "healthy"
      ? {
          command: "setup_core" as const,
          label: "Set up Koed core",
          requiresConsent: false
        }
      : null;

  return [
    step({
      id: "package",
      title: "Koed package",
      description: "Install the verified Koed server package used by Desktop.",
      components: [{ label: "Server package", status: serverPackage }],
      action:
        serverPackage.state === "healthy"
          ? null
          : {
              command: "package_install",
              label: "Install package",
              requiresConsent: true
            }
    }),
    step({
      id: "runtime",
      title: "Local runtime",
      description:
        "Prepare the native database and embedding runtime under Koed's local home.",
      components: [{ label: "Native runtime", status: status.database }],
      action:
        status.database.state === "healthy"
          ? null
          : {
              command: "runtime_install",
              label: "Install runtime",
              requiresConsent: true
            }
    }),
    step({
      id: "model",
      title: "Local models",
      description:
        "Install the verified local models used to protect, index, and recall Memory.",
      components: [
        { label: "Embedding Service", status: status.embeddingService }
      ],
      action:
        status.embeddingService.state === "healthy"
          ? null
          : {
              command: "models_install",
              label: "Install model",
              requiresConsent: true
            }
    }),
    step({
      id: "services",
      title: "Database and services",
      description: "Start storage, processing, and the local API.",
      components: [
        { label: "Database", status: status.database },
        { label: "Redis", status: status.redis },
        { label: "Worker queues", status: status.workerQueues },
        { label: "API", status: status.api }
      ],
      action: {
        command: "start",
        label: "Start services",
        requiresConsent: false
      }
    }),
    step({
      id: "integration",
      title: "Koed core integration",
      description: "Prepare local credential and MCP artifacts.",
      components: [
        { label: "API Token", status: status.apiToken },
        { label: "MCP Server", status: status.mcpServer },
        { label: "Local AI Runtime", status: localAiRuntime }
      ],
      action: integrationAction
    }),
    step({
      id: "health",
      title: "Health check",
      description:
        "Verify that capture, recall, and local processing are ready.",
      components: [
        { label: "Last verification", status: status.lastVerification }
      ],
      action: {
        command: "doctor",
        label: "Run diagnostics",
        requiresConsent: false
      }
    })
  ].map((item) =>
    item.state === "healthy" ? { ...item, action: null } : item
  );
};

export const setupIsReady = (status: KoedServerStatus): boolean =>
  setupStepsFromStatus(status).every(({ state }) => state === "healthy");

export const compactHealthSummary = (
  status: KoedServerStatus | null
): {
  label: string;
  state: "checking" | "healthy" | "starting" | "waiting" | "fault";
} => {
  if (!status) return { label: "Checking Koed", state: "checking" };

  const components = status.core
    ? Object.values(status.core.components)
    : [
        status.api,
        status.database,
        status.redis,
        status.workerQueues,
        status.embeddingService,
        ...(status.privacyService ? [status.privacyService] : []),
        ...(status.localAiRuntime ? [status.localAiRuntime] : []),
        status.apiToken,
        status.mcpServer
      ];

  if (components.every(({ state }) => state === "healthy")) {
    return { label: "Koed is ready", state: "healthy" };
  }
  if (components.some(({ state }) => state === "starting")) {
    return { label: "Koed is starting", state: "starting" };
  }
  const faults = components.filter(
    ({ state }) => state === "needs_attention"
  ).length;
  if (faults > 1) {
    return {
      label: `${faults} services need attention`,
      state: "fault"
    };
  }
  return faults === 1
    ? { label: "1 service needs attention", state: "waiting" }
    : { label: "Koed is not ready yet", state: "waiting" };
};
