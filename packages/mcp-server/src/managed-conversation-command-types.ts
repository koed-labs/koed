export type ManagedConversationProvider = "codex" | "claude" | "pi";
export type ManagedConversationCommandKind = "command" | "skill";
export type ManagedConversationCommandScope = "global" | "project";
export type ManagedConversationCommandSource =
  | "provider"
  | "builtin"
  | "global-file"
  | "project-file";
export type ManagedConversationCommandVerification = "verified" | "unverified";

export type ManagedConversationCommandInvocation =
  | { type: "prompt" }
  | {
      type: "control_action";
      actionId: ManagedConversationControlActionId;
    };

export type ManagedConversationCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  kind: ManagedConversationCommandKind;
  scope: ManagedConversationCommandScope;
  source: ManagedConversationCommandSource;
  verification: ManagedConversationCommandVerification;
  invocation: ManagedConversationCommandInvocation;
};

export type ManagedConversationCommandCatalog = {
  provider: ManagedConversationProvider;
  aiClientInstanceId: string;
  executionGeneration?: number;
  projectId?: string;
  commands: ManagedConversationCommand[];
};

export type ManagedConversationControlActionId = "codex.compact";
export type ManagedConversationControlActionDefinition = {
  id: ManagedConversationControlActionId;
  provider: ManagedConversationProvider;
  commandName: string;
  argumentPolicy: "none";
};

export const MANAGED_CONVERSATION_CONTROL_ACTIONS = {
  "codex.compact": {
    id: "codex.compact",
    provider: "codex",
    commandName: "compact",
    argumentPolicy: "none"
  }
} as const satisfies Record<
  ManagedConversationControlActionId,
  ManagedConversationControlActionDefinition
>;

export type ManagedConversationCommandListing = {
  commands: ManagedConversationCommand[];
  provider: ManagedConversationProvider;
  aiClientInstanceId: string;
  executionGeneration: number;
  projectId?: string;
};

export type ManagedConversationCommandSession = {
  listCommands?(): Promise<ManagedConversationCommand[]>;
  executeControlAction?(
    input: ManagedConversationCommandActionRequest
  ): Promise<ManagedConversationControlActionResult>;
};

export type ManagedConversationDraftCommandListingInput = {
  provider: ManagedConversationProvider;
  aiClientInstanceId: string;
  projectId?: string;
  projectRoot?: string;
};
export type ManagedConversationDraftCommandLister = (
  input: ManagedConversationDraftCommandListingInput
) => Promise<ManagedConversationCommand[]>;

export type ManagedConversationCommandDiscoveryRequest = {
  mode: "draft" | "live";
  aiClientInstanceId: string;
  provider: ManagedConversationProvider;
  executionId?: string;
  executionGeneration?: number;
  projectId?: string;
};
export type ManagedConversationCommandDiscoveryResult =
  | { status: "ok"; listing: ManagedConversationCommandListing }
  | { status: "unavailable" | "unauthorized"; listing: null };

export type ManagedConversationCommandActionRequest = {
  operationId: string;
  actionId: ManagedConversationControlActionId;
  executionGeneration: number;
  arguments: string[];
};
export type ManagedConversationControlActionResult =
  | { status: "accepted" | "already_accepted" | "unknown" }
  | { status: "rejected"; reason: string };
export type ManagedConversationCommandActionResponse =
  ManagedConversationControlActionResult & {
    operationId: string;
    executionGeneration: number;
  };
export type ManagedConversationControlActionState = {
  operationId: string;
  actionId: ManagedConversationControlActionId;
  executionGeneration: number;
  status: "pending" | "accepted" | "unknown" | "rejected";
  reason?: string;
  createdAt: string;
};
