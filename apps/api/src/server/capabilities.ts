import releaseManifest from "@koed/koed/package.json" with { type: "json" };

const koedReleaseVersion = releaseManifest.version;

export const capabilitySchemaVersion = 4;

export const deploymentProfiles = [
  "developer",
  "local_personal",
  "private_vps",
  "team_self_hosted",
  "koed_managed_cloud"
] as const;

export type DeploymentProfile = (typeof deploymentProfiles)[number];

export type DeploymentManagedBy = "operator" | "team_operator" | "koed";
export type RuntimeDependencyMode = "bundled-local" | "external" | "server";
export type CapabilityAvailability = "available" | "partial" | "unavailable";
export type CapabilityAudience = "public" | "authenticated";
export type EnrollmentSetupPath =
  | "local_simple_api_token"
  | "remote_browser_session"
  | "remote_device_enrollment";
export type ApiTokenFallbackScope = "personal_ai_client_only" | "unavailable";
export type CommercialEntitlementStatus =
  | "not_applicable"
  | "not_requested"
  | "active"
  | "grace"
  | "suspended"
  | "revoked";
export type CommercialBillingStatus =
  | "not_applicable"
  | "not_requested"
  | "inactive"
  | "trial"
  | "active"
  | "grace"
  | "pending_provider_update"
  | "expired"
  | "canceled"
  | "over_limit"
  | "suspended"
  | "revoked"
  | "error"
  | "unsupported";
export type CommercialBillingSeatSyncStatus =
  | "synced"
  | "pending_provider_update"
  | "over_limit"
  | "error";

export interface CommercialEntitlementInput {
  teamId: string;
  status: Exclude<
    CommercialEntitlementStatus,
    "not_applicable" | "not_requested"
  >;
  allowsTeamAccess: boolean;
  deniedOperationFamilies: string[];
}

export interface CommercialBillingInput {
  syncStatus: CommercialBillingSeatSyncStatus;
  overLimitAt: string | null;
}

export interface CapabilitiesConfig {
  deploymentProfile: DeploymentProfile;
  runtimeMode: "developer" | "local-personal" | "external";
  dependencyMode: RuntimeDependencyMode;
  workosAuthKitEnabled?: boolean;
  applicationLayerEncryption?: CapabilityAvailability;
  crossIdentitySync?: CapabilityAvailability;
}

export interface CapabilityDescriptor {
  availability: CapabilityAvailability;
  description: string;
  endpoints?: string[];
  requiresAuthentication?: boolean;
}

export interface CapabilitiesResponse {
  product: "koed";
  apiVersion: "v1";
  capabilitySchemaVersion: typeof capabilitySchemaVersion;
  releaseVersion: string;
  audience: CapabilityAudience;
  deployment: {
    profile: DeploymentProfile;
    managedBy: DeploymentManagedBy;
    distribution: "source_available" | "managed_service";
    productBoundary: "koed-server";
  };
  runtime: {
    localEdge: boolean;
    remoteUpstreams: CapabilityAvailability;
    dependencyMode: RuntimeDependencyMode;
  };
  auth: {
    providers: Array<"local" | "workos">;
    session: CapabilityAvailability;
    apiTokens: CapabilityAvailability;
    deviceEnrollment: CapabilityAvailability;
    enrollment: {
      setupPath: EnrollmentSetupPath;
      deviceEnrollment: CapabilityAvailability;
      apiTokenFallback: ApiTokenFallbackScope;
      authenticatedStatusEndpoint: "/v1/capabilities/authenticated";
      mcpAndCaptureHookTarget: "local_koed_server";
      notes: string[];
    };
  };
  memory: {
    personal: CapabilityAvailability;
    teamWorkspaces: CapabilityAvailability;
    shareGrants: CapabilityAvailability;
    crossIdentitySync: CapabilityAvailability;
    memoryInbox: CapabilityAvailability;
  };
  commercial: {
    billingEntitlements: CapabilityAvailability;
    accessSuspension: CapabilityAvailability;
    supportAdmin: CapabilityAvailability;
    stateVocabulary: {
      entitlementStatuses: CommercialEntitlementStatus[];
      billingStatuses: CommercialBillingStatus[];
      billingSeatSyncStatuses: CommercialBillingSeatSyncStatus[];
    };
    entitlement: {
      scope: "none" | "team";
      status: CommercialEntitlementStatus;
      allowsTeamAccess: boolean | null;
      deniedOperationFamilies: string[];
      teamId?: string;
      requiresAuthentication: boolean;
    };
    billing: {
      scope: "none" | "team";
      status: CommercialBillingStatus;
      overLimit: boolean | null;
      seatSyncStatus: CommercialBillingSeatSyncStatus | "not_configured" | null;
      requiresAuthentication: boolean;
    };
    featureGates: Record<
      | "teamWorkspaces"
      | "shareGrants"
      | "memoryInbox"
      | "crossIdentitySync"
      | "hostedOperations"
      | "supportAdmin"
      | "teamLimits",
      {
        capability: string;
        availability: CapabilityAvailability;
        entitlementStatus: CommercialEntitlementStatus;
        billingStatus: CommercialBillingStatus;
        enforcement: "server_side" | "not_applicable";
        requiresAuthentication: boolean;
      }
    >;
  };
  security: {
    applicationLayerEncryption: CapabilityAvailability;
    queryableVectors: CapabilityAvailability;
    objectStorage: CapabilityAvailability;
    deploymentTlsRequired: boolean;
  };
  authenticatedCapabilities: {
    available: boolean;
    endpoint: "/v1/capabilities/authenticated";
  };
  providers: string[];
  capabilities: Record<string, CapabilityDescriptor>;
  notes: string[];
}

const profileAliases: Record<string, DeploymentProfile> = {
  developer: "developer",
  local_personal: "local_personal",
  "local-personal": "local_personal",
  private_vps: "private_vps",
  "private-vps": "private_vps",
  self_hosted: "private_vps",
  "self-hosted": "private_vps",
  team_self_hosted: "team_self_hosted",
  "team-self-hosted": "team_self_hosted",
  koed_managed_cloud: "koed_managed_cloud",
  "koed-managed-cloud": "koed_managed_cloud",
  cloud: "koed_managed_cloud"
};

const runtimeProfile = (
  runtimeMode: CapabilitiesConfig["runtimeMode"]
): DeploymentProfile =>
  runtimeMode === "local-personal" ? "local_personal" : "developer";

export const resolveDeploymentProfile = (
  value: string | undefined,
  runtimeMode: CapabilitiesConfig["runtimeMode"]
): DeploymentProfile => {
  const trimmed = value?.trim().toLowerCase();
  return trimmed
    ? (profileAliases[trimmed] ?? runtimeProfile(runtimeMode))
    : runtimeProfile(runtimeMode);
};

export const resolveRuntimeDependencyMode = (
  value: string | undefined
): RuntimeDependencyMode => {
  if (value === "bundled-local" || value === "external" || value === "server") {
    return value;
  }
  return "external";
};

const managedByForProfile = (
  profile: DeploymentProfile
): DeploymentManagedBy =>
  profile === "koed_managed_cloud"
    ? "koed"
    : profile === "team_self_hosted"
      ? "team_operator"
      : "operator";

const distributionForProfile = (
  profile: DeploymentProfile
): CapabilitiesResponse["deployment"]["distribution"] =>
  profile === "koed_managed_cloud" ? "managed_service" : "source_available";

const hasTeamFoundation = (profile: DeploymentProfile): boolean =>
  profile === "private_vps" ||
  profile === "team_self_hosted" ||
  profile === "koed_managed_cloud";

export const supportsWorkos = (profile: DeploymentProfile): boolean =>
  profile === "team_self_hosted" || profile === "koed_managed_cloud";

const supportsRemoteUpstreams = (profile: DeploymentProfile): boolean =>
  profile === "local_personal" || profile === "developer";

const tlsRequired = (profile: DeploymentProfile): boolean =>
  profile === "private_vps" ||
  profile === "team_self_hosted" ||
  profile === "koed_managed_cloud";

const capabilityProviders = [
  "deployment",
  "operations",
  "auth",
  "clients",
  "memory",
  "teams",
  "commercial",
  "security"
] as const;

const commercialEntitlementStatuses = [
  "not_applicable",
  "not_requested",
  "active",
  "grace",
  "suspended",
  "revoked"
] as const satisfies readonly CommercialEntitlementStatus[];

const commercialBillingStatuses = [
  "not_applicable",
  "not_requested",
  "inactive",
  "trial",
  "active",
  "grace",
  "pending_provider_update",
  "expired",
  "canceled",
  "over_limit",
  "suspended",
  "revoked",
  "error",
  "unsupported"
] as const satisfies readonly CommercialBillingStatus[];

const commercialBillingSeatSyncStatuses = [
  "synced",
  "pending_provider_update",
  "over_limit",
  "error"
] as const satisfies readonly CommercialBillingSeatSyncStatus[];

const descriptor = (
  availability: CapabilityAvailability,
  description: string,
  options: Pick<
    CapabilityDescriptor,
    "endpoints" | "requiresAuthentication"
  > = {}
): CapabilityDescriptor => ({
  availability,
  description,
  ...options
});

const buildCapabilities = (input: {
  memory: CapabilitiesResponse["memory"];
  commercial: CapabilitiesResponse["commercial"];
  security: CapabilitiesResponse["security"];
  auth: CapabilitiesResponse["auth"];
  runtime: CapabilitiesResponse["runtime"];
}): Record<string, CapabilityDescriptor> => ({
  "deployment.profiles": descriptor(
    "available",
    "Versioned deployment profile metadata for this koed-server instance.",
    { endpoints: ["/v1/capabilities"] }
  ),
  "runtime.localEdge": descriptor(
    input.runtime.localEdge ? "available" : "unavailable",
    "Local edge/control-plane behavior for Desktop, MCP Server, and Capture Hook."
  ),
  "runtime.remoteUpstreams": descriptor(
    input.runtime.remoteUpstreams,
    "Registered remote/private/cloud upstream backend routing through local edge."
  ),
  "operations.health": descriptor(
    "available",
    "Coarse unauthenticated health and readiness probes.",
    { endpoints: ["/health", "/ready"] }
  ),
  "operations.status": descriptor("available", "Redacted status surface.", {
    endpoints: ["/self-host/status"]
  }),
  "operations.diagnostics": descriptor(
    "available",
    "Detailed operator diagnostics behind session authentication.",
    {
      endpoints: ["/health/details", "/self-host/diagnostics"],
      requiresAuthentication: true
    }
  ),
  "auth.local": descriptor(
    "available",
    "Local user registration and session-cookie authentication."
  ),
  "auth.workos": descriptor(
    input.auth.providers.includes("workos") ? "partial" : "unavailable",
    "WorkOS/AuthKit browser identity mapping. Koed remains the memory authorization authority."
  ),
  "auth.apiTokens": descriptor(
    input.auth.apiTokens,
    "User-owned AI-client compatibility API Tokens."
  ),
  "auth.deviceEnrollment": descriptor(
    input.auth.deviceEnrollment,
    "Revocable local edge device enrollment credentials.",
    {
      endpoints:
        input.auth.deviceEnrollment === "available"
          ? ["/v1/capabilities/authenticated"]
          : undefined,
      requiresAuthentication: input.auth.deviceEnrollment === "available"
    }
  ),
  "auth.enrollment": descriptor(
    "available",
    "Explorer-first setup path metadata for local auth, browser session auth, and future device enrollment.",
    { endpoints: ["/v1/capabilities", "/v1/capabilities/authenticated"] }
  ),
  "clients.codex": descriptor(
    "available",
    "Codex is the supported AI Client for capture and recall."
  ),
  "clients.electronBackendTarget": descriptor(
    "available",
    "Koed Desktop can target this koed-server-compatible backend."
  ),
  "memory.personal": descriptor(
    input.memory.personal,
    "Personal Memory capture, retrieval, graph, and export."
  ),
  "memory.captureHook": descriptor(
    "available",
    "Supported TypeScript Capture Hook ingestion."
  ),
  "memory.mcpRecall": descriptor(
    "available",
    "MCP recall through memory_answer."
  ),
  "memory.curatedIntake": descriptor(
    "available",
    "Capability-gated Curated Memory proposals through memory_intake_propose.",
    { endpoints: ["/v1/memory/curated/proposals"] }
  ),
  "memory.localLcmSummaries": descriptor(
    "available",
    "Local LCM Summary Service work through the connected AI Client."
  ),
  "memory.teamWorkspaces": descriptor(
    input.memory.teamWorkspaces,
    "Team Workspace memory access through Koed-native authorization."
  ),
  "memory.shareGrants": descriptor(
    input.memory.shareGrants,
    "Captured Session Share Grants for Team Workspace recall."
  ),
  "memory.crossIdentitySync": descriptor(
    input.memory.crossIdentitySync,
    "Policy-aware Cross-Identity Sync preserving logical memory identity."
  ),
  "memory.memoryInbox": descriptor(
    input.memory.memoryInbox,
    "Memory Inbox content ingestion and governed recall."
  ),
  "commercial.billingEntitlements": descriptor(
    input.commercial.billingEntitlements,
    "Billing/license entitlement gates."
  ),
  "commercial.accessSuspension": descriptor(
    input.commercial.accessSuspension,
    "Commercial lifecycle gates that suspend access without deleting Memory."
  ),
  "commercial.supportAdmin": descriptor(
    input.commercial.supportAdmin,
    "Scoped and audited hosted support/admin access."
  ),
  "security.applicationLayerEncryption": descriptor(
    input.security.applicationLayerEncryption,
    "Application-layer memory encryption beyond deployment-level encryption."
  ),
  "security.queryableVectors": descriptor(
    input.security.queryableVectors,
    "Tenant-scoped queryable vector representation inside the trusted backend search boundary. This is sensitive derived data, not zero-knowledge search."
  ),
  "security.objectStorage": descriptor(
    input.security.objectStorage,
    "Managed object storage for future sync packages or Memory Inbox payloads."
  )
});

export const buildCapabilitiesResponse = (
  config: CapabilitiesConfig,
  audience: CapabilityAudience = "public",
  commercialEntitlement?: CommercialEntitlementInput | null,
  commercialBilling?: CommercialBillingInput | null
): CapabilitiesResponse => {
  const teamFoundation = hasTeamFoundation(config.deploymentProfile);
  const workos =
    supportsWorkos(config.deploymentProfile) &&
    config.workosAuthKitEnabled === true;
  const cloud = config.deploymentProfile === "koed_managed_cloud";
  const runtime = {
    localEdge:
      config.deploymentProfile === "local_personal" ||
      config.deploymentProfile === "developer",
    remoteUpstreams: supportsRemoteUpstreams(config.deploymentProfile)
      ? ("partial" as const)
      : ("unavailable" as const),
    dependencyMode: config.dependencyMode
  };
  const auth = {
    providers: workos ? (["local", "workos"] as const) : (["local"] as const),
    session: "available" as const,
    apiTokens: "available" as const,
    deviceEnrollment: supportsDeviceEnrollment(config.deploymentProfile)
      ? ("available" as const)
      : ("unavailable" as const),
    enrollment: buildEnrollmentContract(config.deploymentProfile)
  };
  const memory = {
    personal: "available" as const,
    teamWorkspaces: teamFoundation
      ? ("partial" as const)
      : ("unavailable" as const),
    shareGrants: teamFoundation
      ? ("partial" as const)
      : ("unavailable" as const),
    crossIdentitySync:
      config.crossIdentitySync ??
      (config.applicationLayerEncryption === "unavailable"
        ? ("unavailable" as const)
        : ("available" as const)),
    memoryInbox: "unavailable" as const
  };
  const commercial = {
    billingEntitlements: cloud
      ? ("partial" as const)
      : ("unavailable" as const),
    accessSuspension: teamFoundation
      ? ("available" as const)
      : ("unavailable" as const),
    supportAdmin: cloud ? ("partial" as const) : ("unavailable" as const),
    stateVocabulary: {
      entitlementStatuses: [...commercialEntitlementStatuses],
      billingStatuses: [...commercialBillingStatuses],
      billingSeatSyncStatuses: [...commercialBillingSeatSyncStatuses]
    },
    entitlement: buildCommercialEntitlement(
      teamFoundation,
      audience,
      commercialEntitlement
    ),
    billing: buildCommercialBilling(teamFoundation, audience, commercialBilling)
  };
  const commercialWithFeatureGates = {
    ...commercial,
    featureGates: buildCommercialFeatureGates({
      audience,
      commercial,
      memory,
      cloud
    })
  };
  const security = {
    applicationLayerEncryption:
      config.applicationLayerEncryption ?? ("unavailable" as const),
    queryableVectors: cloud ? ("partial" as const) : ("unavailable" as const),
    objectStorage: cloud ? ("partial" as const) : ("unavailable" as const),
    deploymentTlsRequired: tlsRequired(config.deploymentProfile)
  };

  return {
    product: "koed",
    apiVersion: "v1",
    capabilitySchemaVersion,
    releaseVersion: koedReleaseVersion,
    audience,
    deployment: {
      profile: config.deploymentProfile,
      managedBy: managedByForProfile(config.deploymentProfile),
      distribution: distributionForProfile(config.deploymentProfile),
      productBoundary: "koed-server"
    },
    runtime,
    auth: {
      ...auth,
      providers: [...auth.providers]
    },
    memory,
    commercial: commercialWithFeatureGates,
    security,
    authenticatedCapabilities: {
      available: true,
      endpoint: "/v1/capabilities/authenticated"
    },
    providers: [...capabilityProviders],
    capabilities: buildCapabilities({
      memory,
      commercial: commercialWithFeatureGates,
      security,
      auth: { ...auth, providers: [...auth.providers] },
      runtime
    }),
    notes: [
      "This endpoint describes coarse positive capabilities for the current koed-server instance.",
      "Clients must not infer behavior from hostnames, ports, package names, or environment names.",
      "Unavailable and partial capabilities should disable client surfaces without route probing."
    ]
  };
};

const buildCommercialEntitlement = (
  teamFoundation: boolean,
  audience: CapabilityAudience,
  entitlement?: CommercialEntitlementInput | null
): CapabilitiesResponse["commercial"]["entitlement"] => {
  if (!teamFoundation) {
    return {
      scope: "none",
      status: "not_applicable",
      allowsTeamAccess: null,
      deniedOperationFamilies: [],
      requiresAuthentication: false
    };
  }

  if (!entitlement) {
    return {
      scope: "team",
      status: "not_requested",
      allowsTeamAccess: null,
      deniedOperationFamilies: [],
      requiresAuthentication: audience !== "authenticated"
    };
  }

  return {
    scope: "team",
    teamId: entitlement.teamId,
    status: entitlement.status,
    allowsTeamAccess: entitlement.allowsTeamAccess,
    deniedOperationFamilies: [...entitlement.deniedOperationFamilies],
    requiresAuthentication: true
  };
};

const buildCommercialBilling = (
  teamFoundation: boolean,
  audience: CapabilityAudience,
  billing?: CommercialBillingInput | null
): CapabilitiesResponse["commercial"]["billing"] => {
  if (!teamFoundation) {
    return {
      scope: "none",
      status: "not_applicable",
      overLimit: null,
      seatSyncStatus: null,
      requiresAuthentication: false
    };
  }

  if (!billing) {
    return {
      scope: "team",
      status: "not_requested",
      overLimit: null,
      seatSyncStatus: audience === "authenticated" ? "not_configured" : null,
      requiresAuthentication: audience !== "authenticated"
    };
  }

  return {
    scope: "team",
    status: billingStatusForSeatSync(billing.syncStatus),
    overLimit:
      billing.syncStatus === "over_limit" || billing.overLimitAt !== null,
    seatSyncStatus: billing.syncStatus,
    requiresAuthentication: true
  };
};

const billingStatusForSeatSync = (
  syncStatus: CommercialBillingSeatSyncStatus
): CommercialBillingStatus => {
  if (syncStatus === "over_limit") return "over_limit";
  if (syncStatus === "error") return "error";
  if (syncStatus === "pending_provider_update") {
    return "pending_provider_update";
  }
  return "active";
};

const buildCommercialFeatureGates = (input: {
  audience: CapabilityAudience;
  commercial: Omit<CapabilitiesResponse["commercial"], "featureGates">;
  memory: CapabilitiesResponse["memory"];
  cloud: boolean;
}): CapabilitiesResponse["commercial"]["featureGates"] => {
  const entitlementStatus = input.commercial.entitlement.status;
  const billingStatus = input.commercial.billing.status;
  const requiresAuthentication =
    entitlementStatus !== "not_applicable" &&
    input.audience !== "authenticated";
  const gate = (
    capability: string,
    availability: CapabilityAvailability
  ): CapabilitiesResponse["commercial"]["featureGates"][keyof CapabilitiesResponse["commercial"]["featureGates"]] => ({
    capability,
    availability,
    entitlementStatus,
    billingStatus,
    enforcement:
      availability === "unavailable" && entitlementStatus === "not_applicable"
        ? "not_applicable"
        : "server_side",
    requiresAuthentication
  });

  return {
    teamWorkspaces: gate("memory.teamWorkspaces", input.memory.teamWorkspaces),
    shareGrants: gate("memory.shareGrants", input.memory.shareGrants),
    memoryInbox: gate("memory.memoryInbox", input.memory.memoryInbox),
    crossIdentitySync: gate(
      "memory.crossIdentitySync",
      input.memory.crossIdentitySync
    ),
    hostedOperations: gate(
      "operations.hostedStatus",
      input.cloud ? "partial" : "unavailable"
    ),
    supportAdmin: gate(
      "commercial.supportAdmin",
      input.commercial.supportAdmin
    ),
    teamLimits: gate(
      "commercial.billingEntitlements",
      input.commercial.billingEntitlements
    )
  };
};

const buildEnrollmentContract = (
  profile: DeploymentProfile
): CapabilitiesResponse["auth"]["enrollment"] => {
  if (profile === "local_personal" || profile === "developer") {
    return {
      setupPath: "local_simple_api_token",
      deviceEnrollment: "available",
      apiTokenFallback: "personal_ai_client_only",
      authenticatedStatusEndpoint: "/v1/capabilities/authenticated",
      mcpAndCaptureHookTarget: "local_koed_server",
      notes: [
        "Desktop can use local setup and app-provisioned API Tokens for personal AI-client compatibility.",
        "Device enrollment is available for registered remote/private/cloud upstream backends; it is not required for local-only Personal Memory."
      ]
    };
  }

  return {
    setupPath: "remote_device_enrollment",
    deviceEnrollment: "available",
    apiTokenFallback: "personal_ai_client_only",
    authenticatedStatusEndpoint: "/v1/capabilities/authenticated",
    mcpAndCaptureHookTarget: "local_koed_server",
    notes: [
      "Desktop should authenticate the User through Explorer/browser session auth before Team or cloud setup.",
      "Device enrollment creates revocable local-edge credentials; API Tokens remain personal AI-client compatibility credentials only."
    ]
  };
};

const supportsDeviceEnrollment = (profile: DeploymentProfile): boolean =>
  profile === "local_personal" ||
  profile === "developer" ||
  profile === "private_vps" ||
  profile === "team_self_hosted" ||
  profile === "koed_managed_cloud";
