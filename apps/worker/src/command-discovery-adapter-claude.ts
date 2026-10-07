import {
  createCommandDiscoveryAdapter,
  type CommandDiscoveryAdapter,
  type ManagedConversationSlashCommand
} from "./command-discovery-adapter.js";

/** Claude commands remain unverified, bounded, instance-scoped file metadata. */
export const createClaudeCommandDiscoveryAdapter = (
  environment: NodeJS.ProcessEnv = process.env
): CommandDiscoveryAdapter =>
  createCommandDiscoveryAdapter("claude", environment);

export const listClaudeDraftCommands = async (input: {
  aiClientInstanceId: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<ManagedConversationSlashCommand[]> =>
  createClaudeCommandDiscoveryAdapter(input.environment).discoverCommands({
    aiClientInstanceId: input.aiClientInstanceId
  });
