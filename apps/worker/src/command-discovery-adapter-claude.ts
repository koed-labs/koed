import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeFileCommands,
  checkClaudeCodeAvailability
} from "@koed/mcp-server";
import {
  createCommandDiscoveryAdapter,
  type CommandDiscoveryAdapter,
  type ManagedConversationSlashCommand
} from "./command-discovery-adapter.js";

const ADAPTER_TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 64;
const cache = new Map<
  string,
  { expiresAt: number; commands: ManagedConversationSlashCommand[] }
>();

export const createClaudeCommandDiscoveryAdapter = (): CommandDiscoveryAdapter => ({
  async discoverCommands(): Promise<ManagedConversationSlashCommand[]> {
    const timeout = setTimeout(() => {}, ADAPTER_TIMEOUT_MS);
    try {
      const availability = await checkClaudeCodeAvailability();
      if (!availability.available) {
        return [];
      }
      return claudeFileCommands(process.cwd(), process.env.HOME ?? tmpdir());
    } catch {
      // Fail-closed: all errors return empty array
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
});

export const listClaudeDraftCommands = async (input: {
  aiClientInstanceId: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<ManagedConversationSlashCommand[]> => {
  const env = input.environment ?? process.env;
  const key = input.aiClientInstanceId;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.commands;
  try {
    const home = env.HOME ?? tmpdir();
    const discovered = claudeFileCommands(process.cwd(), home);
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, commands: discovered });
    while (cache.size > MAX_CACHE_ENTRIES)
      cache.delete(cache.keys().next().value!);
    return discovered;
  } catch {
    return [];
  }
};
