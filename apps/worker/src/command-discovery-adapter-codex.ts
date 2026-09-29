import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCodexAppServerSkills } from "@koed/mcp-server";
import {
  createCommandDiscoveryAdapter,
  environmentForCommandDiscoveryInstance,
  type CommandDiscoveryAdapter,
  type ManagedConversationSlashCommand
} from "./command-discovery-adapter.js";

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 64;
const cache = new Map<
  string,
  { expiresAt: number; commands: ManagedConversationSlashCommand[] }
>();

const liveCommands = (payload: unknown): ManagedConversationSlashCommand[] => {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const entries = Array.isArray(root.skills)
    ? root.skills
    : Array.isArray(root.data)
      ? root.data
      : [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const skill = entry as Record<string, unknown>;
    // Strip leading slash; catalog names are slash-free.
    const name = (typeof skill.name === "string" ? skill.name.trim().replace(/^\//, "") : "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(name)) return [];
    return [
      {
        name: name,
        description:
          typeof skill.description === "string"
            ? skill.description.slice(0, 512)
            : "",
        kind: "skill" as const,
        source: "provider" as const,
        verification: "verified" as const,
        scope: "global" as const
      }
    ];
  });
};

/** Fallback file scan remains separate from draft provider discovery. */
export const createCodexCommandDiscoveryAdapter = (
  environment: NodeJS.ProcessEnv = process.env
): CommandDiscoveryAdapter =>
  createCommandDiscoveryAdapter("codex", environment);

export const listCodexDraftCommands = async (input: {
  aiClientInstanceId: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<ManagedConversationSlashCommand[]> => {
  const env = input.environment ?? process.env;
  const key = input.aiClientInstanceId;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.commands;
  const configured = environmentForCommandDiscoveryInstance("codex", key, env);
  if (!configured) return [];
  let temporaryCwd: string | undefined;
  let discovered: ManagedConversationSlashCommand[] = [];
  try {
    temporaryCwd = await mkdtemp(join(tmpdir(), "koed-codex-draft-"));
    const skills = await listCodexAppServerSkills({
      appServerBinary: configured.CODEX_APP_SERVER_BINARY ?? "codex",
      cwd: temporaryCwd,
      env: configured
    });
    discovered = liveCommands(skills);
  } catch {
    discovered = [];
  } finally {
    if (temporaryCwd)
      await rm(temporaryCwd, { recursive: true, force: true }).catch(
        () => undefined
      );
  }
  const files = await createCommandDiscoveryAdapter("codex", env)
    .discoverCommands({
      aiClientInstanceId: key
    })
    .catch(() => []);
  const merged = [...discovered, ...files].slice(0, 128);
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, commands: merged });
  while (cache.size > MAX_CACHE_ENTRIES)
    cache.delete(cache.keys().next().value!);
  return merged;
};
