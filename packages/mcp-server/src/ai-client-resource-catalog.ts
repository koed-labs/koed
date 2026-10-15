import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import {
  aiClientResourceCatalogVersion,
  aiClientResourceCatalogSchema,
  nodeCliInvocation,
  nodeCliProcessEnvironment,
  type AiClientResource,
  type AiClientResourceAvailability,
  type AiClientResourceCatalog,
  type AiClientResourceExecutionSupport
} from "@koed/shared";
import {
  environmentForLocalAiClientInstance,
  localAiClientInstanceConfigIdentity,
  type LocalAiClientInstanceConfiguration
} from "./ai-client-instance-registry.js";
import { scanClaudeManagedSkillRoot } from "./claude-plugin-skill-bridge.js";
import { CodexAppServerClient } from "./codex-app-server-runner.js";
import { discoverPiResourcesInChild } from "./ai-client-resource-pi-discovery-process.js";

const execFileAsync = promisify(execFile);
const MAX_CLAUDE_SKILL_DISCOVERY_BYTES = 4 * 1024 * 1024;

export type NativeSkillInvocation = {
  resourceId: string;
  provider: "codex" | "claude" | "pi";
  name: string;
  /** Private Claude SDK loading boundary for the revalidated Skill. */
  providerKind?: "plugin" | "claude_root";
  /**
   * Private runner-only path for a verified provider-native Skill. Codex uses a
   * Skill file; Claude may use an explicit local Skill root after its isolated
   * execution route is verified.
   */
  providerPath?: string;
};

export type DiscoverConfiguredAiClientResourcesInput = {
  instance: LocalAiClientInstanceConfiguration;
  ownerUserId: string;
  hostedInstanceId: string;
  computerLabel: string | null;
  projectId: string | null;
  /** A server-resolved Project path. Never accept this from the browser. */
  projectPath: string | null;
  /** Registered Project root used to bind catalog IDs across a verified checkout. */
  resourceIdentityProjectPath?: string | null;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
  ttlMs?: number;
  /** Cancels SDK work when the bounded discovery lease deadline is reached. */
  signal?: AbortSignal;
};

type DiscoveredNativeSkill = {
  kind: "skill" | "plugin" | "mcp_server" | "extension";
  name: string;
  description?: string;
  path: string;
  source: AiClientResource["source"];
  availability: AiClientResourceAvailability;
  executionSupport: AiClientResourceExecutionSupport;
  providerKind?: "plugin" | "claude_root";
};

const legacyStatusFor = (
  availability: AiClientResourceAvailability,
  executionSupport: AiClientResourceExecutionSupport
): AiClientResource["status"] => {
  if (availability === "disabled") return "disabled";
  return availability === "available" && executionSupport === "koed_managed"
    ? "ready"
    : "unavailable";
};

const resourceAvailabilityFromProvider = (
  value: Record<string, unknown>,
  fallback: AiClientResourceAvailability
): AiClientResourceAvailability => {
  const text = statusText(
    value.runtimeStatus ?? value.status ?? value.state ?? value.health
  );
  const authStatus = statusText(value.authStatus);
  if (
    value.disabled === true ||
    value.enabled === false ||
    /\b(?:disabled|off)\b/u.test(text)
  )
    return "disabled";
  if (
    value.needsSignIn === true ||
    value.requiresAuth === true ||
    value.authRequired === true ||
    authStatus === "not logged in" ||
    /\b(?:needs? sign in|sign in required|not logged in|not authenticated|authentication required|auth required|unauthorized|needs? auth)\b/u.test(
      text
    )
  )
    return "needs_sign_in";
  if (
    /\b(?:not connected|disconnected|unavailable|error|failed|failure)\b/u.test(
      text
    )
  )
    return "unavailable";
  if (value.callable === true) return "available";
  if (/\b(?:connected|ready|running|active)\b/u.test(text)) return "available";
  if (
    value.enabled === true ||
    value.callable === false ||
    authStatus === "bearer token" ||
    authStatus === "oauth" ||
    text === "starting" ||
    text === "not started" ||
    /\b(?:installed|configured|enabled|pending|starting)\b/u.test(text)
  )
    return "configured";
  return fallback;
};

const isPathWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};

const identityPathFor = (input: {
  source: DiscoveredNativeSkill["source"];
  path: string;
  listingProjectPath: string | null;
}): string => {
  if (input.source === "project" && input.listingProjectPath) {
    const relative = path.relative(input.listingProjectPath, input.path);
    if (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
      return `project:${relative.split(path.sep).join("/")}`;
  }
  return `absolute:${path.resolve(input.path)}`;
};

const MAX_SKILLS = 500;
const MAX_DESCRIPTION = 1_000;
const CATALOG_TTL_MS = 5 * 60_000;
const NATIVE_READ_DEADLINE_MS = 55_000;
const CLAUDE_PLUGIN_LIST_TIMEOUT_MS = 10_000;
const CLAUDE_PLUGIN_LIST_MAX_BYTES = 1_024 * 1_024;
const CLAUDE_SKILL_BRIDGE_CLI_VERSION = "2.1.226";
const CLAUDE_VERSION_TIMEOUT_MS = 5_000;
const MAX_CLAUDE_SKILL_ROOTS = 64;
const MAX_CLAUDE_PLUGIN_MANIFEST_BYTES = 32 * 1_024;

const replaceControlCharacters = (value: string): string =>
  Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? " " : character;
  }).join("");

const statusText = (value: unknown): string =>
  typeof value === "string"
    ? value
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .replace(/[_-]+/g, " ")
        .trim()
    : "";

const withNativeReadDeadline = async <T>(
  externalSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> => {
  if (externalSignal?.aborted) throw new Error("AiClientResourceLeaseLost");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rejectExternalAbort: ((reason: Error) => void) | null = null;
  const abortFromCaller = () => {
    controller.abort();
    rejectExternalAbort?.(new Error("AiClientResourceLeaseLost"));
  };
  externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const interrupted = new Promise<never>((_, reject) => {
    rejectExternalAbort = reject;
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("AiClientResourceDiscoveryTimedOut"));
    }, NATIVE_READ_DEADLINE_MS);
  });
  try {
    return await Promise.race([operation(controller.signal), interrupted]);
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
};

const providerFailure = (provider: string, error: unknown): Error => {
  const text = error instanceof Error ? error.message : "";
  if (
    text === "AiClientResourceDiscoveryTimedOut" ||
    text === "AiClientResourceLeaseLost"
  )
    return new Error(text);
  const normalizedProvider = provider[0]!.toUpperCase() + provider.slice(1);
  const suffix =
    /(?:not logged|not authenticated|sign[ -]?in|authentication required|unauthorized|login required)/iu.test(
      text
    )
      ? "AuthenticationRequired"
      : /(?:unsupported version|unknown method|method not found|not implemented|version.*(?:old|unsupported))/iu.test(
            text
          )
        ? "VersionUnsupported"
        : "Unavailable";
  return new Error(`AiClient${normalizedProvider}${suffix}`);
};

const configurationFailure = (
  instance: LocalAiClientInstanceConfiguration
): Error => {
  const reason = instance.configurationError ?? "";
  return new Error(
    /(?:ENOENT|ENOTDIR)/u.test(reason)
      ? "AiClientExecutableUnavailable"
      : "AiClientConfigurationUnavailable"
  );
};

const cleanText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const cleaned = replaceControlCharacters(value)
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s,;]+[\\/])+[^\s,;]*/g, "[path]")
    .replace(
      /\b(?:bearer\s+)?(?:sk|gh[pousr]|xox[baprs])-[-A-Za-z0-9_]{12,}\b/gi,
      "[redacted]"
    )
    .trim()
    .slice(0, max);
  return cleaned || undefined;
};

const safeSkillName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length > 0 &&
    name.length <= 160 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    name === replaceControlCharacters(name)
    ? name
    : null;
};

const resourceIdFor = (input: {
  ownerUserId: string;
  instance: LocalAiClientInstanceConfiguration;
  hostedInstanceId: string;
  projectId: string | null;
  kind: DiscoveredNativeSkill["kind"];
  name: string;
  path: string;
  source: DiscoveredNativeSkill["source"];
  listingProjectPath: string | null;
  resourceIdentityProjectPath: string | null;
}): string => {
  const identity = localAiClientInstanceConfigIdentity(input.instance);
  const digest = createHash("sha256")
    .update("koed-ai-client-resource-v1\0")
    .update(
      JSON.stringify([
        input.ownerUserId,
        input.instance.driverId,
        input.instance.instanceId,
        input.hostedInstanceId,
        input.projectId,
        identity,
        input.kind,
        input.name,
        input.resourceIdentityProjectPath,
        identityPathFor(input)
      ])
    )
    .digest("hex");
  return `res_${digest}`;
};

const projectCwd = (projectPath: string | null): string => {
  if (projectPath === null) return os.homedir();
  const resolved = fs.realpathSync(projectPath);
  if (!fs.statSync(resolved).isDirectory())
    throw new Error("AiClientResourceProjectUnavailable");
  return resolved;
};

const classifyCodexSource = (
  skill: Record<string, unknown>
): DiscoveredNativeSkill["source"] => {
  const scope =
    typeof skill.scope === "string" ? skill.scope.toLowerCase() : "";
  if (typeof skill.pluginId === "string" && skill.pluginId.trim())
    return "plugin";
  if (scope === "repo" || scope.includes("project")) return "project";
  if (scope === "system") return "builtin";
  if (scope === "admin") return "configured";
  return "user";
};

const discoverCodexSkills = async (input: {
  instance: LocalAiClientInstanceConfiguration;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  signal?: AbortSignal;
}): Promise<DiscoveredNativeSkill[]> => {
  const client = new CodexAppServerClient(
    input.instance.executablePath,
    input.cwd,
    input.environment,
    undefined,
    { requestTimeoutMs: 15_000, closeGraceMs: 1_000 }
  );
  const closeOnAbort = () => {
    void client.close();
  };
  input.signal?.addEventListener("abort", closeOnAbort, { once: true });
  try {
    await client.initialize("koed-resource-catalog");
    const response = await client.listSkills(
      input.cwd === os.homedir() ? [] : [input.cwd]
    );
    const entries = Array.isArray(response.data) ? response.data : [];
    return entries.slice(0, MAX_SKILLS).flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return [];
      const skillEntry = entry as Record<string, unknown>;
      const skills = Array.isArray(skillEntry.skills) ? skillEntry.skills : [];
      return skills.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          return [];
        const item = value as Record<string, unknown>;
        const name = safeSkillName(item.name);
        const skillPath = typeof item.path === "string" ? item.path : "";
        if (!name || !path.isAbsolute(skillPath)) return [];
        const source = classifyCodexSource(item);
        const canonicalSkillPath = fs.realpathSync(skillPath);
        const pathIsScoped =
          source !== "project" || isPathWithin(input.cwd, canonicalSkillPath);
        return [
          {
            kind: "skill" as const,
            name,
            ...(cleanText(item.description, MAX_DESCRIPTION)
              ? { description: cleanText(item.description, MAX_DESCRIPTION) }
              : {}),
            path: canonicalSkillPath,
            source,
            availability: !pathIsScoped
              ? ("unavailable" as const)
              : item.enabled === false
                ? ("disabled" as const)
                : item.enabled === true
                  ? ("available" as const)
                  : ("unknown" as const),
            executionSupport: "koed_managed" as const
          }
        ];
      });
    });
  } finally {
    input.signal?.removeEventListener("abort", closeOnAbort);
    client.close();
  }
};

type ClaudeSkillRoot = {
  name: string;
  path: string;
  providerKind: "plugin" | "claude_root";
  source: AiClientResource["source"];
};

const supportsVerifiedClaudeSkillBridge = async (input: {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  executablePath: string;
  signal?: AbortSignal;
}): Promise<boolean> => {
  try {
    const invocation = nodeCliInvocation(input.executablePath, ["--version"]);
    const result = await execFileAsync(invocation.command, invocation.args, {
      cwd: input.cwd,
      env: nodeCliProcessEnvironment(
        invocation,
        input.environment,
        input.environment
      ),
      timeout: CLAUDE_VERSION_TIMEOUT_MS,
      maxBuffer: 4_096,
      windowsHide: true,
      encoding: "utf8",
      signal: input.signal
    });
    return (
      String(result.stdout).trim().split(/\s/u)[0] ===
      CLAUDE_SKILL_BRIDGE_CLI_VERSION
    );
  } catch {
    return false;
  }
};

const canonicalClaudeConfigRoot = (
  instance: LocalAiClientInstanceConfiguration,
  environment: NodeJS.ProcessEnv
): string | null => {
  const candidate =
    instance.configHome ??
    environment.CLAUDE_CONFIG_DIR ??
    path.join(environment.HOME ?? os.homedir(), ".claude");
  try {
    const info = fs.lstatSync(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) return null;
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
};

const canonicalClaudeProjectRoot = (cwd: string): string | null => {
  const candidate = path.join(cwd, ".claude");
  try {
    const info = fs.lstatSync(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) return null;
    const canonical = fs.realpathSync(candidate);
    return canonical === candidate ? canonical : null;
  } catch {
    return null;
  }
};

type ClaudePluginInventory = {
  roots: ClaudeSkillRoot[];
  resources: DiscoveredNativeSkill[];
};

const readBoundedClaudePluginManifest = (
  pluginRoot: string
): Record<string, unknown> | null => {
  const metadataDirectory = path.join(pluginRoot, ".claude-plugin");
  const manifestPath = path.join(metadataDirectory, "plugin.json");
  let descriptor: number | null = null;
  try {
    const metadataInfo = fs.lstatSync(metadataDirectory);
    if (
      metadataInfo.isSymbolicLink() ||
      !metadataInfo.isDirectory() ||
      fs.realpathSync(metadataDirectory) !== metadataDirectory
    )
      return null;
    const fileInfo = fs.lstatSync(manifestPath);
    if (
      fileInfo.isSymbolicLink() ||
      !fileInfo.isFile() ||
      fileInfo.size > MAX_CLAUDE_PLUGIN_MANIFEST_BYTES ||
      fs.realpathSync(manifestPath) !== manifestPath ||
      !isPathWithin(pluginRoot, manifestPath)
    )
      return null;
    descriptor = fs.openSync(
      manifestPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    );
    const openedInfo = fs.fstatSync(descriptor);
    if (
      !openedInfo.isFile() ||
      openedInfo.dev !== fileInfo.dev ||
      openedInfo.ino !== fileInfo.ino ||
      openedInfo.size > MAX_CLAUDE_PLUGIN_MANIFEST_BYTES
    )
      return null;
    const bytes = Buffer.alloc(MAX_CLAUDE_PLUGIN_MANIFEST_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        length,
        bytes.length - length,
        null
      );
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_CLAUDE_PLUGIN_MANIFEST_BYTES) return null;
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, length)
      )
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
};

const discoverClaudePluginInventory = async (input: {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  executablePath: string;
  signal?: AbortSignal;
}): Promise<ClaudePluginInventory> => {
  try {
    const invocation = nodeCliInvocation(input.executablePath, [
      "plugin",
      "list",
      "--json"
    ]);
    const result = await execFileAsync(invocation.command, invocation.args, {
      cwd: input.cwd,
      env: nodeCliProcessEnvironment(
        invocation,
        input.environment,
        input.environment
      ),
      timeout: CLAUDE_PLUGIN_LIST_TIMEOUT_MS,
      maxBuffer: CLAUDE_PLUGIN_LIST_MAX_BYTES,
      windowsHide: true,
      encoding: "utf8",
      signal: input.signal
    });
    const parsed: unknown = JSON.parse(String(result.stdout));
    const values = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown> | null)?.plugins)
        ? ((parsed as Record<string, unknown>).plugins as unknown[])
        : [];
    const entries = values.flatMap(
      (
        value
      ): Array<{
        root: ClaudeSkillRoot;
        resource: DiscoveredNativeSkill;
      }> => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          return [];
        const record = value as Record<string, unknown>;
        if (typeof record.installPath !== "string") return [];
        try {
          const pluginRoot = fs.realpathSync(record.installPath);
          if (!fs.statSync(pluginRoot).isDirectory()) return [];
          const manifest = readBoundedClaudePluginManifest(pluginRoot);
          const name = safeSkillName(manifest?.name);
          if (!name) return [];
          const root: ClaudeSkillRoot = {
            name,
            path: pluginRoot,
            providerKind: "plugin",
            source: "plugin"
          };
          const availability: AiClientResourceAvailability =
            record.enabled === true
              ? "configured"
              : record.enabled === false
                ? "disabled"
                : "unknown";
          return [
            {
              root,
              resource: {
                kind: "plugin",
                name,
                path: pluginRoot,
                source: "plugin",
                availability,
                executionSupport: "inventory_only"
              }
            }
          ];
        } catch {
          return [];
        }
      }
    );
    const roots = entries
      .filter(({ resource }) => resource.availability === "configured")
      .map(({ root }) => root);
    const counts = new Map<string, number>();
    for (const root of roots)
      counts.set(root.name, (counts.get(root.name) ?? 0) + 1);
    return {
      roots: roots.filter((root) => counts.get(root.name) === 1),
      resources: entries.map(({ resource }) => resource)
    };
  } catch {
    return { roots: [], resources: [] };
  }
};

const rootsForClaudeCommands = (input: {
  commands: readonly { name: string; description?: string }[];
  roots: readonly ClaudeSkillRoot[];
}): DiscoveredNativeSkill[] => {
  const commandCounts = new Map<string, number>();
  for (const command of input.commands)
    commandCounts.set(command.name, (commandCounts.get(command.name) ?? 0) + 1);

  // Validate each native root once and share a strict byte budget across the
  // complete discovery request. Excess roots stay visible as inventory only.
  const scanBudget = { remainingBytes: MAX_CLAUDE_SKILL_DISCOVERY_BYTES };
  const inventoryByRoot = new Map<
    string,
    ReturnType<typeof scanClaudeManagedSkillRoot> | null
  >();

  const inventoryForRoot = (root: ClaudeSkillRoot) => {
    const key = `${root.providerKind}:${root.path}`;
    let inventory = inventoryByRoot.get(key);
    if (inventory === undefined) {
      try {
        inventory = scanClaudeManagedSkillRoot({
          providerKind: root.providerKind,
          providerPath: root.path,
          budget: scanBudget
        });
      } catch {
        inventory = null;
      }
      inventoryByRoot.set(key, inventory);
    }
    return inventory;
  };

  return input.commands
    .slice(0, MAX_SKILLS)
    .flatMap((command): DiscoveredNativeSkill[] => {
      const name = safeSkillName(command.name);
      if (!name) return [];
      const matches = input.roots.filter((root) =>
        name.startsWith(`${root.name}:`)
      );
      if (matches.length === 0) {
        return [
          {
            kind: "skill" as const,
            name,
            ...(cleanText(command.description, MAX_DESCRIPTION)
              ? { description: cleanText(command.description, MAX_DESCRIPTION) }
              : {}),
            path: `claude-command:${name}`,
            source: "configured" as const,
            availability: "available" as const,
            executionSupport: "inventory_only" as const
          }
        ];
      }
      const separator = name.indexOf(":");
      const skillName = separator < 0 ? "" : name.slice(separator + 1);
      if (
        name.indexOf(":") !== name.lastIndexOf(":") ||
        skillName === "" ||
        safeSkillName(skillName) !== skillName
      ) {
        return matches.map((root) => ({
          kind: "skill" as const,
          name,
          ...(cleanText(command.description, MAX_DESCRIPTION)
            ? { description: cleanText(command.description, MAX_DESCRIPTION) }
            : {}),
          path: root.path,
          source: root.source,
          availability: "available" as const,
          executionSupport: "inventory_only" as const
        }));
      }

      const verifiedRoots: ClaudeSkillRoot[] = [];
      const uncertainRoots: ClaudeSkillRoot[] = [];
      for (const root of matches) {
        const inventory = inventoryForRoot(root);
        if (
          inventory === null ||
          inventory.namespace !== name.slice(0, separator)
        ) {
          uncertainRoots.push(root);
        } else if (inventory.skillNames.includes(skillName)) {
          verifiedRoots.push(root);
        }
      }

      const ambiguous =
        verifiedRoots.length !== 1 ||
        uncertainRoots.length > 0 ||
        commandCounts.get(name) !== 1;
      const visibleRoots =
        verifiedRoots.length > 0 ? verifiedRoots : uncertainRoots;
      if (visibleRoots.length === 0) {
        return [
          {
            kind: "skill" as const,
            name,
            ...(cleanText(command.description, MAX_DESCRIPTION)
              ? { description: cleanText(command.description, MAX_DESCRIPTION) }
              : {}),
            path: `claude-command:${name}`,
            source: "configured" as const,
            availability: "available" as const,
            executionSupport: "inventory_only" as const
          }
        ];
      }
      return visibleRoots.map((root) => {
        const uniquelyInvocable = !ambiguous && verifiedRoots[0] === root;
        return {
          kind: "skill" as const,
          name,
          ...(cleanText(command.description, MAX_DESCRIPTION)
            ? { description: cleanText(command.description, MAX_DESCRIPTION) }
            : {}),
          path: root.path,
          source: root.source,
          availability: "available" as const,
          executionSupport: uniquelyInvocable
            ? ("koed_managed" as const)
            : ("inventory_only" as const),
          ...(uniquelyInvocable ? { providerKind: root.providerKind } : {})
        };
      });
    });
};

const discoverClaudeSkills = async (input: {
  cwd: string;
  projectId: string | null;
  environment: NodeJS.ProcessEnv;
  instance: LocalAiClientInstanceConfiguration;
  signal?: AbortSignal;
}): Promise<DiscoveredNativeSkill[]> => {
  const bridgeSupported = await supportsVerifiedClaudeSkillBridge({
    cwd: input.cwd,
    environment: input.environment,
    executablePath: input.instance.executablePath,
    signal: input.signal
  });
  const pluginInventory = await discoverClaudePluginInventory({
    cwd: input.cwd,
    environment: input.environment,
    executablePath: input.instance.executablePath,
    signal: input.signal
  });
  if (!bridgeSupported) return pluginInventory.resources;
  const configRoot = canonicalClaudeConfigRoot(
    input.instance,
    input.environment
  );
  const rawRoots: ClaudeSkillRoot[] = configRoot
    ? [
        {
          name: path.basename(configRoot),
          path: configRoot,
          providerKind: "claude_root",
          source: "user"
        }
      ]
    : [];
  if (input.projectId !== null) {
    const projectRoot = canonicalClaudeProjectRoot(input.cwd);
    if (projectRoot) {
      rawRoots.push({
        name: path.basename(projectRoot),
        path: projectRoot,
        providerKind: "claude_root",
        source: "project"
      });
    }
  }
  const roots = [...rawRoots, ...pluginInventory.roots];
  if (roots.length === 0 || roots.length > MAX_CLAUDE_SKILL_ROOTS)
    return pluginInventory.resources;

  // Discovery is an isolated metadata-only query. Never enable the client's
  // user/project setting sources to learn which Skills the native CLI sees.
  // Keep the empty input pending: immediate EOF can close the SDK query before
  // its supportedCommands control response arrives.
  let releaseEmptyInput!: () => void;
  const emptyInputGate = new Promise<void>((resolve) => {
    releaseEmptyInput = resolve;
  });
  const emptyInput = (async function* () {
    await emptyInputGate;
    yield* [];
  })();
  const abortController = new AbortController();
  const abortQuery = () => {
    abortController.abort();
    releaseEmptyInput();
  };
  input.signal?.addEventListener("abort", abortQuery, { once: true });
  if (input.signal?.aborted) abortQuery();
  let query: ReturnType<typeof claudeQuery> | undefined;
  try {
    query = claudeQuery({
      prompt: emptyInput,
      options: {
        cwd: input.cwd,
        env: input.environment,
        pathToClaudeCodeExecutable: input.instance.executablePath,
        settingSources: [],
        persistSession: false,
        abortController,
        strictMcpConfig: true,
        mcpServers: {},
        plugins: roots.map((root) => ({
          type: "local" as const,
          path: root.path,
          skipMcpDiscovery: true
        })),
        settings: {
          disableAllHooks: true,
          permissions: { ask: ["*"] }
        },
        tools: [],
        allowedTools: [],
        maxTurns: 0
      }
    });
    const commands = await query.supportedCommands();
    releaseEmptyInput();
    const skills = rootsForClaudeCommands({ commands, roots });
    return [...skills, ...pluginInventory.resources].slice(0, MAX_SKILLS);
  } finally {
    releaseEmptyInput();
    input.signal?.removeEventListener("abort", abortQuery);
    query?.close();
  }
};

const configuredResources = (input: {
  values: unknown;
  kind: "plugin" | "mcp_server" | "extension";
  pathPrefix: string;
  fallbackAvailability: AiClientResourceAvailability;
  statusFor?: (value: Record<string, unknown>) => AiClientResourceAvailability;
}): DiscoveredNativeSkill[] => {
  const values = Array.isArray(input.values) ? input.values : [];
  return values.slice(0, MAX_SKILLS).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const name = safeSkillName(item.name ?? item.id ?? item.serverName);
    if (!name) return [];
    const nativePath =
      typeof item.path === "string" && path.isAbsolute(item.path)
        ? item.path
        : `${input.pathPrefix}:${name}`;
    const availability =
      input.statusFor?.(item) ??
      resourceAvailabilityFromProvider(item, input.fallbackAvailability);
    return [
      {
        kind: input.kind,
        name,
        ...(cleanText(item.description, MAX_DESCRIPTION)
          ? { description: cleanText(item.description, MAX_DESCRIPTION) }
          : {}),
        path: nativePath,
        source:
          input.kind === "plugin" ? ("plugin" as const) : ("user" as const),
        availability,
        executionSupport: "inventory_only" as const
      }
    ];
  });
};

const discoverPiSkills = async (input: {
  cwd: string;
  instance: LocalAiClientInstanceConfiguration;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<DiscoveredNativeSkill[]> => {
  return discoverPiResourcesInChild({
    cwd: input.cwd,
    executablePath: input.instance.executablePath,
    configHome: input.instance.configHome ?? null,
    environment: input.environment,
    signal: input.signal
  }).then((resources) =>
    resources.map((resource) => ({
      ...resource,
      availability:
        resource.status === "disabled"
          ? ("disabled" as const)
          : resource.status === "unavailable"
            ? ("unavailable" as const)
            : resource.kind === "skill"
              ? ("available" as const)
              : ("configured" as const),
      executionSupport:
        resource.kind === "skill"
          ? ("koed_managed" as const)
          : ("inventory_only" as const)
    }))
  );
};

const discoverConfiguredAiClientResourcesWithinDeadline = async (
  input: DiscoverConfiguredAiClientResourcesInput
): Promise<AiClientResourceCatalog> => {
  if (input.instance.configurationError)
    throw configurationFailure(input.instance);
  if (!/^[0-9a-f-]{36}$/i.test(input.ownerUserId))
    throw new Error("AiClientResourceOwnerInvalid");
  if (input.projectId === null && input.resourceIdentityProjectPath != null)
    throw new Error("AiClientResourceProjectUnavailable");
  if (input.projectId !== null && input.projectPath === null)
    throw new Error("AiClientResourceProjectUnavailable");
  const cwd = projectCwd(input.projectPath);
  const resourceIdentityProjectPath =
    input.projectId === null
      ? null
      : projectCwd(input.resourceIdentityProjectPath ?? input.projectPath);
  const environment = environmentForLocalAiClientInstance({
    instance: input.instance,
    driverId: input.instance.driverId,
    env: input.environment ?? process.env
  });
  let nativeSkills: DiscoveredNativeSkill[];
  try {
    nativeSkills = await readNativeSkills(input);
  } catch (error) {
    if (
      error instanceof Error &&
      /^AiClient(?:ConfigurationUnavailable|ExecutableUnavailable|ResourceProjectUnavailable|ProviderUnsupported)$/u.test(
        error.message
      )
    )
      throw error;
    throw providerFailure(input.instance.driverId, error);
  }
  let otherResources: DiscoveredNativeSkill[] = [];
  if (input.instance.driverId === "codex") {
    // These are production read methods. Codex's plugin management APIs are
    // intentionally excluded because they are experimental and can mutate state.
    const client = new CodexAppServerClient(
      input.instance.executablePath,
      cwd,
      environment,
      undefined,
      { requestTimeoutMs: 15_000, closeGraceMs: 1_000 }
    );
    const closeCodexOnAbort = () => {
      void client.close();
    };
    input.signal?.addEventListener("abort", closeCodexOnAbort, { once: true });
    try {
      await client.initialize("koed-resource-catalog");
      const [apps, servers] = await Promise.all([
        client.listInstalledApps(),
        client.listMcpServerStatuses()
      ]);
      otherResources = [
        ...configuredResources({
          values: apps.apps ?? apps.data ?? apps,
          kind: "plugin",
          pathPrefix: "codex-app",
          fallbackAvailability: "configured"
        }),
        ...configuredResources({
          values: servers.servers ?? servers.data ?? servers,
          kind: "mcp_server",
          pathPrefix: "codex-mcp",
          fallbackAvailability: "unknown",
          statusFor: (server) => {
            return resourceAvailabilityFromProvider(server, "unknown");
          }
        })
      ];
    } catch (error) {
      throw providerFailure("codex", error);
    } finally {
      input.signal?.removeEventListener("abort", closeCodexOnAbort);
      client.close();
    }
  }
  const resources: AiClientResource[] = [...nativeSkills, ...otherResources]
    .slice(0, MAX_SKILLS)
    .map((skill) => {
      const executionSupport = skill.executionSupport;
      const invocation =
        skill.kind === "skill" && executionSupport === "koed_managed"
          ? ("native_skill" as const)
          : null;
      return {
        resourceId: resourceIdFor({
          ownerUserId: input.ownerUserId,
          instance: input.instance,
          hostedInstanceId: input.hostedInstanceId,
          projectId: input.projectId,
          kind: skill.kind,
          name: skill.name,
          path: skill.path,
          source: skill.source,
          listingProjectPath: input.projectId === null ? null : cwd,
          resourceIdentityProjectPath
        }),
        kind: skill.kind,
        name: skill.name,
        ...(skill.description ? { description: skill.description } : {}),
        status: legacyStatusFor(skill.availability, executionSupport),
        availability: skill.availability,
        executionSupport,
        source: skill.source,
        invocation
      };
    });
  const now = input.now ?? new Date();
  return aiClientResourceCatalogSchema.parse({
    version: aiClientResourceCatalogVersion,
    provider: input.instance.driverId,
    aiClientInstanceId: input.instance.instanceId,
    hostedInstanceId: input.hostedInstanceId,
    computerLabel: input.computerLabel,
    projectId: input.projectId,
    observedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() +
        Math.min(15 * 60_000, Math.max(30_000, input.ttlMs ?? CATALOG_TTL_MS))
    ).toISOString(),
    resources
  });
};

export const discoverConfiguredAiClientResources = (
  input: DiscoverConfiguredAiClientResourcesInput
): Promise<AiClientResourceCatalog> =>
  withNativeReadDeadline(input.signal, (signal) =>
    discoverConfiguredAiClientResourcesWithinDeadline({ ...input, signal })
  );

const readNativeSkills = async (
  input: Pick<
    DiscoverConfiguredAiClientResourcesInput,
    "instance" | "projectPath" | "projectId" | "environment" | "signal"
  >
): Promise<DiscoveredNativeSkill[]> => {
  if (input.instance.configurationError)
    throw configurationFailure(input.instance);
  const cwd = projectCwd(input.projectPath);
  const environment = environmentForLocalAiClientInstance({
    instance: input.instance,
    driverId: input.instance.driverId,
    env: input.environment ?? process.env
  });
  if (input.instance.driverId === "codex")
    return discoverCodexSkills({
      instance: input.instance,
      environment,
      cwd,
      signal: input.signal
    });
  if (input.instance.driverId === "claude")
    return discoverClaudeSkills({
      cwd,
      projectId: input.projectId,
      environment,
      instance: input.instance,
      signal: input.signal
    });
  if (input.instance.driverId === "pi")
    return discoverPiSkills({
      cwd,
      instance: input.instance,
      environment,
      signal: input.signal
    });
  throw new Error("AiClientProviderUnsupported");
};

const revalidateSelectedNativeSkillsWithinDeadline = async (input: {
  instance: LocalAiClientInstanceConfiguration;
  ownerUserId: string;
  hostedInstanceId: string;
  projectId: string | null;
  projectPath: string | null;
  /** Registered Project root used to bind selections across its verified checkout. */
  resourceIdentityProjectPath?: string | null;
  selectedResourceIds: string[];
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<NativeSkillInvocation[]> => {
  if (input.selectedResourceIds.length > 8)
    throw new Error("AiClientResourceSelectionLimitExceeded");
  if (
    new Set(input.selectedResourceIds).size !== input.selectedResourceIds.length
  )
    throw new Error("AiClientResourceSelectionDuplicate");
  if (input.selectedResourceIds.length === 0) return [];
  if (input.instance.configurationError)
    throw configurationFailure(input.instance);
  if (input.projectId === null && input.resourceIdentityProjectPath != null)
    throw new Error("AiClientResourceProjectUnavailable");
  if (input.projectId !== null && input.projectPath === null)
    throw new Error("AiClientResourceProjectUnavailable");
  const listingProjectPath =
    input.projectId === null ? null : projectCwd(input.projectPath);
  const resourceIdentityProjectPath =
    input.projectId === null
      ? null
      : projectCwd(input.resourceIdentityProjectPath ?? input.projectPath);
  let nativeSkills: DiscoveredNativeSkill[];
  try {
    nativeSkills = await readNativeSkills(input);
  } catch (error) {
    if (
      error instanceof Error &&
      /^AiClient(?:ConfigurationUnavailable|ExecutableUnavailable|ResourceProjectUnavailable|ProviderUnsupported)$/u.test(
        error.message
      )
    )
      throw error;
    throw providerFailure(input.instance.driverId, error);
  }
  const catalog = aiClientResourceCatalogSchema.parse({
    version: aiClientResourceCatalogVersion,
    provider: input.instance.driverId,
    aiClientInstanceId: input.instance.instanceId,
    hostedInstanceId: input.hostedInstanceId,
    computerLabel: null,
    projectId: input.projectId,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + CATALOG_TTL_MS).toISOString(),
    resources: nativeSkills.map((skill) => {
      const executionSupport = skill.executionSupport;
      return {
        resourceId: resourceIdFor({
          ownerUserId: input.ownerUserId,
          instance: input.instance,
          hostedInstanceId: input.hostedInstanceId,
          projectId: input.projectId,
          kind: skill.kind,
          name: skill.name,
          path: skill.path,
          source: skill.source,
          listingProjectPath,
          resourceIdentityProjectPath
        }),
        kind: skill.kind,
        name: skill.name,
        ...(skill.description ? { description: skill.description } : {}),
        status: legacyStatusFor(skill.availability, executionSupport),
        availability: skill.availability,
        executionSupport,
        source: skill.source,
        invocation:
          skill.kind === "skill" && executionSupport === "koed_managed"
            ? ("native_skill" as const)
            : null
      };
    })
  });
  const wanted = new Set(input.selectedResourceIds);
  const found = catalog.resources.filter((resource) =>
    wanted.has(resource.resourceId)
  );
  if (
    found.length !== wanted.size ||
    found.some(
      (resource) =>
        resource.status !== "ready" ||
        resource.availability !== "available" ||
        resource.executionSupport !== "koed_managed" ||
        resource.invocation !== "native_skill" ||
        resource.kind !== "skill"
    )
  )
    throw new Error("AiClientResourceSelectionStale");
  return found.map((resource) => {
    const native = nativeSkills.find(
      (skill) =>
        resourceIdFor({
          ownerUserId: input.ownerUserId,
          instance: input.instance,
          hostedInstanceId: input.hostedInstanceId,
          projectId: input.projectId,
          kind: "skill",
          name: skill.name,
          path: skill.path,
          source: skill.source,
          listingProjectPath,
          resourceIdentityProjectPath
        }) === resource.resourceId
    );
    if (!native) throw new Error("AiClientResourceSelectionStale");
    return {
      resourceId: resource.resourceId,
      provider: input.instance.driverId as NativeSkillInvocation["provider"],
      name: native.name,
      ...(input.instance.driverId === "codex" ||
      (input.instance.driverId === "claude" && native.providerKind)
        ? { providerPath: native.path }
        : {}),
      ...(input.instance.driverId === "claude" && native.providerKind
        ? { providerKind: native.providerKind }
        : {})
    };
  });
};

export const revalidateSelectedNativeSkills = (input: {
  instance: LocalAiClientInstanceConfiguration;
  ownerUserId: string;
  hostedInstanceId: string;
  projectId: string | null;
  projectPath: string | null;
  resourceIdentityProjectPath?: string | null;
  selectedResourceIds: string[];
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<NativeSkillInvocation[]> =>
  withNativeReadDeadline(input.signal, (signal) =>
    revalidateSelectedNativeSkillsWithinDeadline({ ...input, signal })
  );
