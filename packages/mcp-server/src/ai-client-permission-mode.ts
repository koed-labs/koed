import {
  type AiClientCapabilitySupport,
  type SupportedAiClientDriverId
} from "@koed/shared";

export type AiClientPermissionMode =
  | "supervised"
  | "auto_edit"
  | "auto"
  | "full_access";

type CodexPermissionConfiguration = {
  driverId: "codex";
  approvalPolicy: "never" | "on-request" | "untrusted";
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  approvalsReviewer: "user" | "auto_review";
};

type ClaudePermissionConfiguration = {
  driverId: "claude";
  permissionMode: "default" | "acceptEdits" | "auto" | "bypassPermissions";
};

export type AiClientNativePermissionConfiguration =
  | CodexPermissionConfiguration
  | ClaudePermissionConfiguration
  | { driverId: "pi"; permissionMode: AiClientPermissionMode };

export type AiClientPermissionModeMapping = {
  driverId: SupportedAiClientDriverId;
  mode: AiClientPermissionMode;
  support: AiClientCapabilitySupport;
  requiresInteractionBridge: boolean;
  nativeConfiguration: AiClientNativePermissionConfiguration | null;
};

const nativeConfigurations: Readonly<
  Record<
    SupportedAiClientDriverId,
    Partial<
      Record<AiClientPermissionMode, AiClientNativePermissionConfiguration>
    >
  >
> = Object.freeze({
  codex: Object.freeze({
    supervised: Object.freeze({
      driverId: "codex",
      approvalPolicy: "untrusted",
      sandboxMode: "read-only",
      approvalsReviewer: "user"
    }),
    auto_edit: Object.freeze({
      driverId: "codex",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      approvalsReviewer: "user"
    }),
    auto: Object.freeze({
      driverId: "codex",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      approvalsReviewer: "auto_review"
    }),
    full_access: Object.freeze({
      driverId: "codex",
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
      approvalsReviewer: "user"
    })
  }),
  claude: Object.freeze({
    supervised: Object.freeze({
      driverId: "claude",
      permissionMode: "default"
    }),
    auto_edit: Object.freeze({
      driverId: "claude",
      permissionMode: "acceptEdits"
    }),
    auto: Object.freeze({
      driverId: "claude",
      permissionMode: "auto"
    }),
    full_access: Object.freeze({
      driverId: "claude",
      permissionMode: "bypassPermissions"
    })
  }),
  pi: Object.freeze({
    supervised: Object.freeze({ driverId: "pi", permissionMode: "supervised" }),
    auto_edit: Object.freeze({ driverId: "pi", permissionMode: "auto_edit" }),
    auto: Object.freeze({ driverId: "pi", permissionMode: "auto" }),
    full_access: Object.freeze({
      driverId: "pi",
      permissionMode: "full_access"
    })
  })
});

export const aiClientPermissionModeMapping = (input: {
  driverId: SupportedAiClientDriverId;
  mode: AiClientPermissionMode;
}): AiClientPermissionModeMapping => {
  const nativeConfiguration =
    nativeConfigurations[input.driverId][input.mode] ?? null;
  return {
    driverId: input.driverId,
    mode: input.mode,
    support: nativeConfiguration ? "supported" : "unsupported",
    requiresInteractionBridge: Boolean(nativeConfiguration),
    nativeConfiguration
  };
};

export const requireSupportedAiClientPermissionMode = (input: {
  driverId: SupportedAiClientDriverId;
  mode: AiClientPermissionMode;
}): AiClientNativePermissionConfiguration => {
  const mapping = aiClientPermissionModeMapping(input);
  if (mapping.support !== "supported" || !mapping.nativeConfiguration) {
    throw new Error(
      `AI Client permission mode "${input.mode}" is not supported by driver "${input.driverId}".`
    );
  }
  return mapping.nativeConfiguration;
};
