import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import {
  aiClientResourceCatalogVersion,
  aiClientResourceCatalogSchema,
  type AiClientResource,
  type AiClientResourceCatalog
} from "@koed/shared";
import {
  environmentForLocalAiClientInstance,
  localAiClientInstanceConfigIdentity,
  type LocalAiClientInstanceConfiguration
} from "./ai-client-instance-registry.js";
import { CodexAppServerClient } from "./codex-app-server-runner.js";
import { discoverPiResourcesInChild } from "./ai-client-resource-pi-discovery-process.js";

export type NativeSkillInvocation = {
  resourceId: string;
  provider: "codex" | "claude" | "pi";
  name: string;
  /** Private runner-only path required by Codex's structured skill input. */
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
  source: "user" | "project" | "plugin";
  status: "ready" | "disabled" | "unavailable";
};

const MAX_SKILLS = 500;
const MAX_DESCRIPTION = 1_000;
const CATALOG_TTL_MS = 5 * 60_000;
const NATIVE_READ_DEADLINE_MS = 55_000;

const replaceControlCharacters = (value: string): string =>
  Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? " " : character;
  }).join("");

const statusText = (value: unknown): string =>
  typeof value === "string" ? value.toLowerCase() : "";

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
        path.resolve(input.path)
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
  if (scope.includes("project")) return "project";
  if (scope.includes("plugin")) return "plugin";
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
        return [
          {
            kind: "skill" as const,
            name,
            ...(cleanText(item.description, MAX_DESCRIPTION)
              ? { description: cleanText(item.description, MAX_DESCRIPTION) }
              : {}),
            path: fs.realpathSync(skillPath),
            source: classifyCodexSource(item),
            status:
              item.enabled === false
                ? ("disabled" as const)
                : ("ready" as const)
          }
        ];
      });
    });
  } finally {
    input.signal?.removeEventListener("abort", closeOnAbort);
    client.close();
  }
};

const discoverClaudeSkills = async (input: {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  instance: LocalAiClientInstanceConfiguration;
  signal?: AbortSignal;
}): Promise<DiscoveredNativeSkill[]> => {
  const emptyInput = (async function* () {})();
  const abortController = new AbortController();
  const abortQuery = () => abortController.abort();
  input.signal?.addEventListener("abort", abortQuery, { once: true });
  if (input.signal?.aborted) abortQuery();
  const query = claudeQuery({
    prompt: emptyInput,
    options: {
      cwd: input.cwd,
      env: input.environment,
      pathToClaudeCodeExecutable: input.instance.executablePath,
      settingSources: ["user", "project"],
      persistSession: false,
      abortController,
      strictMcpConfig: true,
      mcpServers: {},
      tools: [],
      allowedTools: [],
      maxTurns: 0
    }
  });
  try {
    const commands = await query.supportedCommands();
    return commands.slice(0, MAX_SKILLS).flatMap((command) => {
      const name = safeSkillName(command.name);
      if (!name) return [];
      // Claude Code's SDK command list is the native source of truth. Its
      // initialized names are invoked later through Options.skills, so paths
      // are intentionally absent and cannot cross the API boundary.
      return [
        {
          kind: "skill" as const,
          name,
          ...(cleanText(command.description, MAX_DESCRIPTION)
            ? { description: cleanText(command.description, MAX_DESCRIPTION) }
            : {}),
          path: `claude-command:${name}`,
          source: "user" as const,
          status: "ready" as const
        }
      ];
    });
  } finally {
    input.signal?.removeEventListener("abort", abortQuery);
    query.close();
  }
};

const configuredResources = (input: {
  values: unknown;
  kind: "plugin" | "mcp_server" | "extension";
  pathPrefix: string;
  statusFor?: (
    value: Record<string, unknown>
  ) => DiscoveredNativeSkill["status"];
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
    const resourceStatusText = statusText(item.status ?? item.state);
    const status =
      input.statusFor?.(item) ??
      (item.enabled === false ||
      item.disabled === true ||
      /disabled|off/u.test(resourceStatusText)
        ? "disabled"
        : /unavailable|error|failed/u.test(resourceStatusText)
          ? "unavailable"
          : "ready");
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
        status
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
  });
};

const discoverConfiguredAiClientResourcesWithinDeadline = async (
  input: DiscoverConfiguredAiClientResourcesInput
): Promise<AiClientResourceCatalog> => {
  if (input.instance.configurationError)
    throw configurationFailure(input.instance);
  if (!/^[0-9a-f-]{36}$/i.test(input.ownerUserId))
    throw new Error("AiClientResourceOwnerInvalid");
  const cwd = projectCwd(input.projectPath);
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
          pathPrefix: "codex-app"
        }),
        ...configuredResources({
          values: servers.servers ?? servers.data ?? servers,
          kind: "mcp_server",
          pathPrefix: "codex-mcp",
          statusFor: (server) => {
            const status = statusText(server.status ?? server.state);
            return /connected|ready|running/.test(status)
              ? "ready"
              : /disabled/.test(status)
                ? "disabled"
                : "unavailable";
          }
        })
      ];
    } catch (error) {
      throw providerFailure("codex", error);
    } finally {
      input.signal?.removeEventListener("abort", closeCodexOnAbort);
      client.close();
    }
  } else if (input.instance.driverId === "claude") {
    const pluginAbortController = new AbortController();
    const abortPluginQuery = () => pluginAbortController.abort();
    input.signal?.addEventListener("abort", abortPluginQuery, { once: true });
    if (input.signal?.aborted) abortPluginQuery();
    const nativeQuery = claudeQuery({
      prompt: (async function* () {})(),
      options: {
        cwd,
        env: environment,
        pathToClaudeCodeExecutable: input.instance.executablePath,
        settingSources: ["user", "project"],
        persistSession: false,
        abortController: pluginAbortController,
        strictMcpConfig: true,
        tools: [],
        allowedTools: [],
        maxTurns: 0
      }
    });
    try {
      const pluginState = await nativeQuery.reloadPlugins();
      otherResources = [
        ...configuredResources({
          values: pluginState.plugins,
          kind: "plugin",
          pathPrefix: "claude-plugin"
        }),
        ...configuredResources({
          values: pluginState.mcpServers,
          kind: "mcp_server",
          pathPrefix: "claude-mcp",
          statusFor: (server) => {
            const status = statusText(server.status);
            return /connected|ready|running/.test(status)
              ? "ready"
              : /disabled/.test(status)
                ? "disabled"
                : "unavailable";
          }
        })
      ];
    } catch (error) {
      throw providerFailure("claude", error);
    } finally {
      input.signal?.removeEventListener("abort", abortPluginQuery);
      nativeQuery.close();
    }
  }
  const resources: AiClientResource[] = [...nativeSkills, ...otherResources]
    .slice(0, MAX_SKILLS)
    .map((skill) => ({
      resourceId: resourceIdFor({
        ownerUserId: input.ownerUserId,
        instance: input.instance,
        hostedInstanceId: input.hostedInstanceId,
        projectId: input.projectId,
        kind: skill.kind,
        name: skill.name,
        path: skill.path
      }),
      kind: skill.kind,
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
      status: skill.status,
      source: skill.source,
      invocation: skill.kind === "skill" ? ("native_skill" as const) : null
    }));
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
    "instance" | "projectPath" | "environment" | "signal"
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
    resources: nativeSkills.map((skill) => ({
      resourceId: resourceIdFor({
        ownerUserId: input.ownerUserId,
        instance: input.instance,
        hostedInstanceId: input.hostedInstanceId,
        projectId: input.projectId,
        kind: skill.kind,
        name: skill.name,
        path: skill.path
      }),
      kind: skill.kind,
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
      status: skill.status,
      source: skill.source,
      invocation: skill.kind === "skill" ? ("native_skill" as const) : null
    }))
  });
  const wanted = new Set(input.selectedResourceIds);
  const found = catalog.resources.filter((resource) =>
    wanted.has(resource.resourceId)
  );
  if (
    found.length !== wanted.size ||
    found.some(
      (resource) => resource.status !== "ready" || resource.kind !== "skill"
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
          path: skill.path
        }) === resource.resourceId
    );
    if (!native) throw new Error("AiClientResourceSelectionStale");
    return {
      resourceId: resource.resourceId,
      provider: input.instance.driverId as NativeSkillInvocation["provider"],
      name: native.name,
      ...(input.instance.driverId === "codex"
        ? { providerPath: native.path }
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
  selectedResourceIds: string[];
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<NativeSkillInvocation[]> =>
  withNativeReadDeadline(input.signal, (signal) =>
    revalidateSelectedNativeSkillsWithinDeadline({ ...input, signal })
  );
