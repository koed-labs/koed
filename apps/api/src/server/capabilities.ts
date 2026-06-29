import releaseManifest from "@koed/koed/package.json" with { type: "json" };

const koedReleaseVersion = releaseManifest.version;

type CapabilityAvailability = "available" | "partial" | "authenticated";

interface CapabilityDescriptor {
  availability: CapabilityAvailability;
  description: string;
  endpoints?: string[];
}

interface CapabilityProvider {
  id: string;
  getCapabilities(): Record<string, CapabilityDescriptor>;
}

const capabilityProviders: CapabilityProvider[] = [
  {
    id: "operations",
    getCapabilities: () => ({
      "operations.health": {
        availability: "available",
        description: "Coarse unauthenticated health and readiness probes.",
        endpoints: ["/health", "/ready"]
      },
      "operations.status": {
        availability: "available",
        description: "Self-hosted status surface with redacted public status.",
        endpoints: ["/self-host/status"]
      },
      "operations.diagnostics": {
        availability: "authenticated",
        description: "Detailed local operator diagnostics.",
        endpoints: ["/health/details", "/self-host/diagnostics"]
      }
    })
  },
  {
    id: "auth",
    getCapabilities: () => ({
      "auth.localUsers": {
        availability: "available",
        description:
          "Local user registration and session-cookie authentication."
      },
      "auth.apiTokens": {
        availability: "available",
        description: "Personal-memory API Tokens created by local operators."
      }
    })
  },
  {
    id: "clients",
    getCapabilities: () => ({
      "clients.codex": {
        availability: "available",
        description: "Codex is the supported AI Client for capture and recall."
      },
      "clients.electronBackendTarget": {
        availability: "available",
        description: "The Electron app can target this backend API."
      }
    })
  },
  {
    id: "memory",
    getCapabilities: () => ({
      "memory.personal": {
        availability: "available",
        description: "Personal Memory capture, retrieval, graph, and export."
      },
      "memory.captureHook": {
        availability: "available",
        description: "Supported TypeScript Capture Hook ingestion."
      },
      "memory.mcpRecall": {
        availability: "available",
        description: "MCP recall through memory_answer."
      },
      "memory.graph": {
        availability: "available",
        description: "Personal Memory graph inspection."
      },
      "memory.export": {
        availability: "available",
        description: "Personal Memory export."
      },
      "memory.localLcmSummaries": {
        availability: "available",
        description: "Local LCM Summary Service with AI-client synthesis."
      }
    })
  },
  {
    id: "teams",
    getCapabilities: () => ({
      "teams.management": {
        availability: "partial",
        description: "Team and membership storage foundations."
      },
      "teams.workspaces": {
        availability: "partial",
        description: "Team Workspace storage and access-grant foundations."
      }
    })
  }
];

export const selfHostedCapabilities = {
  product: "koed",
  apiVersion: "v1",
  capabilitySchemaVersion: 1,
  releaseVersion: koedReleaseVersion,
  deployment: {
    mode: "self_hosted",
    distribution: "source_available",
    managedBy: "operator"
  },
  auth: {
    modes: ["session_cookie", "api_token"],
    browserSessionSetup: "operator_bootstrap",
    apiTokenBootstrap: "local_operator_script"
  },
  providers: capabilityProviders.map((provider) => provider.id),
  capabilities: Object.freeze(
    capabilityProviders.reduce<Record<string, CapabilityDescriptor>>(
      (capabilities, provider) => ({
        ...capabilities,
        ...provider.getCapabilities()
      }),
      {}
    )
  ),
  notes: [
    "This endpoint describes positive capabilities registered by the current backend instance.",
    "Clients should treat a missing capability as unavailable for this backend."
  ]
} as const;
