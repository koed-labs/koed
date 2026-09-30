import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { SupportedAiClientDriverId } from "@koed/shared/ai-client-contract";
import {
  environmentForLocalAiClientInstance,
  resolveLocalAiClientInstance
} from "@koed/mcp-server";

export type ManagedConversationSlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  kind: "command" | "skill";
  source: "provider" | "builtin" | "global-file" | "project-file";
  verification?: "verified" | "unverified";
  scope?: "global" | "project";
};

export interface CommandDiscoveryAdapter {
  discoverCommands(args: {
    aiClientInstanceId: string;
    projectRoot?: string;
  }): Promise<ManagedConversationSlashCommand[]>;
}

export type CommandDiscoveryAdapterFactory = (
  driverId: SupportedAiClientDriverId,
  environment?: NodeJS.ProcessEnv
) => CommandDiscoveryAdapter;

type SourceRoot = {
  path: string;
  boundary: string;
  scope: "global" | "project";
  kind: "command" | "skill";
};

type FileCommand = Omit<ManagedConversationSlashCommand, "scope" | "source">;

const MAX_COMMANDS = 128;
const MAX_FILE_BYTES = 64 * 1024;
const DISCOVERY_TIMEOUT_MS = 2_000;
const MAX_SCAN_DEPTH = 4;
const MAX_SCAN_ENTRIES = 256;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_ARGUMENT_HINT_LENGTH = 64;

const within = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..`) && !isAbsolute(pathFromRoot))
  );
};

const frontmatterValue = (source: string, key: string): string | undefined => {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) return undefined;
  const line = match[1]
    .split(/\r?\n/)
    .find((candidate) => new RegExp(`^\\s*${key}\\s*:`).test(candidate));
  if (!line) return undefined;
  const value = line.slice(line.indexOf(":") + 1).trim();
  if (!value || value.startsWith("#")) return undefined;
  const unquoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
      ? value.slice(1, -1)
      : value;
  return unquoted.trim() || undefined;
};

const validName = (value: string): string | null => {
  const name = value.trim().replaceAll("\\", "/");
  if (
    !name ||
    name.length > MAX_NAME_LENGTH ||
    name.startsWith("/") ||
    name.split("/").some((part) => !part || part === "." || part === "..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(name)
  ) {
    return null;
  }
  return name;
};

const commandFromFile = async (
  sourceRoot: string,
  filePath: string,
  kind: SourceRoot["kind"],
  fileName?: string
): Promise<FileCommand | null> => {
  try {
    const resolvedFile = await realpath(filePath);
    if (!within(sourceRoot, resolvedFile)) return null;
    const fileStat = await stat(resolvedFile);
    if (!fileStat.isFile() || fileStat.size > MAX_FILE_BYTES) return null;
    const content = await readFile(resolvedFile, "utf8");
    const rawName =
      fileName ??
      relative(sourceRoot, filePath).slice(0, -extname(filePath).length);
    const name = validName(rawName);
    if (!name) return null;
    const description =
      frontmatterValue(content, "description")?.slice(
        0,
        MAX_DESCRIPTION_LENGTH
      ) ?? "";
    const argumentHint = frontmatterValue(content, "argument-hint")?.slice(
      0,
      MAX_ARGUMENT_HINT_LENGTH
    );
    return {
      name,
      description,
      ...(argumentHint ? { argumentHint } : {}),
      kind,
      verification: "unverified"
    };
  } catch {
    return null;
  }
};

const commandsInRoot = async (
  source: SourceRoot
): Promise<ManagedConversationSlashCommand[]> => {
  let root: string;
  try {
    const boundary = await realpath(source.boundary);
    root = await realpath(source.path);
    if (!within(boundary, root)) return [];
  } catch {
    return [];
  }
  const commands: ManagedConversationSlashCommand[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH || commands.length >= MAX_SCAN_ENTRIES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (commands.length >= MAX_SCAN_ENTRIES) break;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
        continue;
      }
      const isSkill = source.kind === "skill" && entry.name === "SKILL.md";
      if (
        source.kind === "skill"
          ? !isSkill
          : !entry.isFile() || extname(entry.name).toLowerCase() !== ".md"
      )
        continue;
      const rawName = isSkill
        ? relative(root, directory).split(/[\\/]/).join("/")
        : relative(root, path).slice(0, -extname(path).length);
      const command = await commandFromFile(root, path, source.kind, rawName);
      if (command)
        commands.push({
          ...command,
          scope: source.scope,
          source: source.scope === "project" ? "project-file" : "global-file"
        });
    }
  };
  await visit(root, 0);
  return commands;
};

const commandRoots = (
  driverId: SupportedAiClientDriverId,
  environment: NodeJS.ProcessEnv,
  projectRoot?: string
): SourceRoot[] => {
  const home = homedir();
  const configHome =
    driverId === "codex"
      ? environment.CODEX_HOME?.trim() || join(home, ".codex")
      : driverId === "claude"
        ? environment.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude")
        : environment.PI_CODING_AGENT_DIR?.trim() || join(home, ".pi", "agent");
  const roots: SourceRoot[] = [];
  if (driverId === "codex") {
    roots.push({
      path: join(configHome, "prompts"),
      boundary: configHome,
      scope: "global",
      kind: "command"
    });
    if (projectRoot)
      roots.push({
        path: join(projectRoot, ".codex", "prompts"),
        boundary: projectRoot,
        scope: "project",
        kind: "command"
      });
  } else if (driverId === "claude") {
    roots.push(
      {
        path: join(configHome, "commands"),
        boundary: configHome,
        scope: "global",
        kind: "command"
      },
      {
        path: join(configHome, "skills"),
        boundary: configHome,
        scope: "global",
        kind: "skill"
      }
    );
    if (projectRoot)
      roots.push(
        {
          path: join(projectRoot, ".claude", "commands"),
          boundary: projectRoot,
          scope: "project",
          kind: "command"
        },
        {
          path: join(projectRoot, ".claude", "skills"),
          boundary: projectRoot,
          scope: "project",
          kind: "skill"
        }
      );
  } else {
    roots.push(
      {
        path: join(configHome, "prompts"),
        boundary: configHome,
        scope: "global",
        kind: "command"
      },
      {
        path: join(configHome, "skills"),
        boundary: configHome,
        scope: "global",
        kind: "skill"
      }
    );
    if (projectRoot)
      roots.push(
        {
          path: join(projectRoot, ".pi", "prompts"),
          boundary: projectRoot,
          scope: "project",
          kind: "command"
        },
        {
          path: join(projectRoot, ".pi", "skills"),
          boundary: projectRoot,
          scope: "project",
          kind: "skill"
        }
      );
  }
  return roots;
};

export const environmentForCommandDiscoveryInstance = (
  driverId: SupportedAiClientDriverId,
  instanceId: string,
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv | null => {
  try {
    const instance = resolveLocalAiClientInstance({
      instanceId,
      driverId,
      env: environment
    });
    return environmentForLocalAiClientInstance({
      instance,
      driverId,
      env: environment
    });
  } catch {
    return null;
  }
};

export const createCommandDiscoveryAdapter: CommandDiscoveryAdapterFactory = (
  driverId,
  baseEnvironment = process.env
) => ({
  async discoverCommands(args) {
    const discovery = (async (): Promise<ManagedConversationSlashCommand[]> => {
      const environment = environmentForCommandDiscoveryInstance(
        driverId,
        args.aiClientInstanceId,
        baseEnvironment
      );
      if (!environment) return [];
      let verifiedProjectRoot: string | undefined;
      if (args.projectRoot) {
        if (!isAbsolute(args.projectRoot)) return [];
        try {
          verifiedProjectRoot = await realpath(resolve(args.projectRoot));
          if (!(await stat(verifiedProjectRoot)).isDirectory()) return [];
        } catch {
          return [];
        }
      }
      const roots = commandRoots(driverId, environment, verifiedProjectRoot);
      const discovered = await Promise.all(roots.map(commandsInRoot));
      const byName = new Map<string, ManagedConversationSlashCommand>();
      for (const command of discovered.flat()) {
        const key = `${command.kind}:${command.name.toLowerCase()}`;
        const current = byName.get(key);
        if (!current || command.scope === "project") byName.set(key, command);
      }
      return [...byName.values()].slice(0, MAX_COMMANDS);
    })().catch(() => []);
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<ManagedConversationSlashCommand[]>(
      (resolve) => {
        timeout = setTimeout(() => resolve([]), DISCOVERY_TIMEOUT_MS);
        timeout.unref?.();
      }
    );
    return Promise.race([discovery, deadline]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }
});
