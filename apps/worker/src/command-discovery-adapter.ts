import type { SupportedAiClientDriverId } from "@koed/shared/ai-client-contract";

export type ManagedConversationSlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  kind: "command" | "skill";
  source: "provider";
};

export interface CommandDiscoveryAdapter {
  discoverCommands(args: {
    aiClientDriverId: SupportedAiClientDriverId;
    aiClientInstanceId: string;
    projectId: string;
    cwd?: string;
  }): Promise<ManagedConversationSlashCommand[]>;
}

export type CommandDiscoveryAdapterFactory = (
  driverId: SupportedAiClientDriverId
) => CommandDiscoveryAdapter | null;

export const createCommandDiscoveryAdapter: CommandDiscoveryAdapterFactory = (
  driverId: SupportedAiClientDriverId
): CommandDiscoveryAdapter | null => {
  switch (driverId) {
    case "codex":
      return null; // Phase 4: implement codex adapter
    case "claude":
      return null; // Phase 4: implement claude adapter
    case "pi":
      return null; // Phase 4: implement pi adapter
    default:
      return null;
  }
};
