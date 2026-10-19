import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  resolveClaudeExecutablePath,
  removeClaude,
  setupClaude
} from "./claude-setup.js";
import { resolveCodexExecutablePath } from "./ai-client-registry.js";
import { resolveKoedServerConfig } from "./config.js";
import { resolveKoedServerPaths } from "./paths.js";
import { removePi, resolvePiSetupExecutable, setupPi } from "./pi-setup.js";
import { isProcessRunning } from "./process-liveness.js";
import {
  configureCodexIntegrationForRemoteBackend,
  removeCodexIntegration,
  type KoedServerSetupOptions
} from "./setup.js";
import {
  inspectClaudeCode,
  inspectCodex,
  inspectPi,
  type KoedServerStatusDependencies
} from "./status.js";

export const HEADLESS_REMOTE_CREDENTIAL_REF =
  "config/remote-mcp-credentials.json";
export type HeadlessRemoteHarness = "codex" | "claude" | "pi";

const backendUrlSchema = z.string().transform((value, context) => {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("invalid backend URL");
    }
    return url.href.replace(/\/$/, "");
  } catch {
    context.addIssue({
      code: "custom",
      message:
        "Remote backend must use HTTPS without credentials, query, or fragment."
    });
    return z.NEVER;
  }
});

const descriptorSchema = z
  .object({
    version: z.literal(1),
    backendUrl: backendUrlSchema,
    credentialRef: z.literal(HEADLESS_REMOTE_CREDENTIAL_REF),
    harnesses: z.array(z.enum(["codex", "claude", "pi"])).min(1),
    futureCaptureOnly: z.literal(true)
  })
  .strict();

export type HeadlessRemoteIntegrationDescriptor = z.infer<
  typeof descriptorSchema
>;

export const headlessRemoteIntegrationPath = (
  environment: NodeJS.ProcessEnv = process.env
): string =>
  resolve(
    resolveKoedServerPaths(environment).configDir,
    "headless-remote.json"
  );

const assertOwnedPath = (path: string, privateFile = false): void => {
  try {
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      (privateFile && !stat.isFile()) ||
      (!privateFile && !stat.isDirectory()) ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (process.platform !== "win32" &&
        (stat.mode & (privateFile ? 0o077 : 0o022)) !== 0)
    ) {
      throw new Error(
        "Headless remote configuration has unsafe ownership or permissions."
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

const assertConfigurationPaths = (environment: NodeJS.ProcessEnv): void => {
  const paths = resolveKoedServerPaths(environment);
  assertOwnedPath(paths.koedHome);
  assertOwnedPath(paths.configDir);
  assertOwnedPath(headlessRemoteIntegrationPath(environment), true);
};

export const readHeadlessRemoteIntegration = (
  environment: NodeJS.ProcessEnv = process.env
): HeadlessRemoteIntegrationDescriptor | null => {
  assertConfigurationPaths(environment);
  const path = headlessRemoteIntegrationPath(environment);
  if (!existsSync(path)) return null;
  return descriptorSchema.parse(JSON.parse(readFileSync(path, "utf8")));
};

export const writeHeadlessRemoteIntegration = (
  environment: NodeJS.ProcessEnv,
  descriptor: HeadlessRemoteIntegrationDescriptor
): void => {
  const parsed = descriptorSchema.parse(descriptor);
  assertConfigurationPaths(environment);
  const paths = resolveKoedServerPaths(environment);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  const target = headlessRemoteIntegrationPath(environment);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original configuration write failure.
    }
    throw error;
  }
};

interface HarnessResult {
  ok: boolean;
}

export interface HeadlessRemoteIntegrationOptions {
  environment?: NodeJS.ProcessEnv;
  harness: HeadlessRemoteHarness;
  consent?: boolean;
  signal?: AbortSignal;
  credentialAvailable?: (reference: string) => boolean;
  codexOptions?: Omit<KoedServerSetupOptions, "environment">;
  setupHarness?: (
    harness: HeadlessRemoteHarness,
    environment: NodeJS.ProcessEnv
  ) => HarnessResult | Promise<HarnessResult>;
  removeHarness?: (
    harness: HeadlessRemoteHarness,
    environment: NodeJS.ProcessEnv
  ) => HarnessResult;
  checkHarness?: (
    harness: HeadlessRemoteHarness,
    environment: NodeJS.ProcessEnv
  ) => boolean | Promise<boolean>;
}

export interface HeadlessRemoteIntegrationResult {
  ok: boolean;
  state:
    | "configured"
    | "needs_attention"
    | "consent_required"
    | "cancelled"
    | "removed";
  harness: HeadlessRemoteHarness;
  futureCaptureOnly: true;
  error?: string;
}

const result = (
  harness: HeadlessRemoteHarness,
  state: HeadlessRemoteIntegrationResult["state"],
  error?: string
): HeadlessRemoteIntegrationResult => ({
  ok: state === "configured" || state === "removed",
  state,
  harness,
  futureCaptureOnly: true,
  ...(error ? { error } : {})
});

const approved = (
  options: HeadlessRemoteIntegrationOptions
): HeadlessRemoteIntegrationResult | null => {
  if (options.signal?.aborted) return result(options.harness, "cancelled");
  if (options.consent !== true)
    return result(options.harness, "consent_required");
  return null;
};

const harnessEnvironment = (
  environment: NodeJS.ProcessEnv,
  descriptor: HeadlessRemoteIntegrationDescriptor
): NodeJS.ProcessEnv => {
  const safe = { ...environment };
  delete safe.MEMORY_API_TOKEN;
  delete safe.CODEX_MEMORY_API_TOKEN;
  return {
    ...safe,
    KOED_HOME: resolveKoedServerPaths(environment).koedHome,
    MEMORY_API_URL: descriptor.backendUrl
  };
};

const inspectHarness = async (
  harness: HeadlessRemoteHarness,
  environment: NodeJS.ProcessEnv
): Promise<boolean> => {
  const paths = resolveKoedServerPaths(environment);
  const dependencies: Required<KoedServerStatusDependencies> = {
    appRuntime: null,
    desktopRuntimeCapability: null,
    fetch: globalThis.fetch.bind(globalThis),
    spawnSync: (command, args, options) =>
      spawnSync(command, args, { ...options, encoding: "utf8" }),
    existsSync,
    readFileSync,
    resolvePiExecutable: resolvePiSetupExecutable,
    resolveClaudeExecutable: resolveClaudeExecutablePath,
    resolveCodexExecutable: resolveCodexExecutablePath,
    checkPid: isProcessRunning,
    now: () => new Date()
  };
  const profile = await (harness === "codex"
    ? inspectCodex(
        environment,
        paths,
        dependencies,
        resolveKoedServerConfig(paths, environment)
          .codexGlobalMemoryGuidanceEnabled
      )
    : harness === "claude"
      ? inspectClaudeCode(environment, paths, dependencies)
      : inspectPi(environment, paths, dependencies));
  return profile.configured === true && profile.state === "healthy";
};

export const setupHeadlessRemoteIntegration = async (
  options: HeadlessRemoteIntegrationOptions & {
    backendUrl: string;
    credentialRef: string;
  }
): Promise<HeadlessRemoteIntegrationResult> => {
  const denied = approved(options);
  if (denied) return denied;
  const environment = options.environment ?? process.env;
  try {
    const previous = readHeadlessRemoteIntegration(environment);
    const descriptor = descriptorSchema.parse({
      version: 1,
      backendUrl: options.backendUrl,
      credentialRef: options.credentialRef,
      harnesses: [
        ...new Set([...(previous?.harnesses ?? []), options.harness])
      ],
      futureCaptureOnly: true
    });
    if (
      previous &&
      (previous.backendUrl !== descriptor.backendUrl ||
        previous.credentialRef !== descriptor.credentialRef)
    ) {
      return result(
        options.harness,
        "needs_attention",
        "Remove the existing remote integration before changing backend."
      );
    }
    if (!options.credentialAvailable?.(descriptor.credentialRef)) {
      return result(
        options.harness,
        "needs_attention",
        "Authenticate the remote backend before integration setup."
      );
    }
    if (options.signal?.aborted) return result(options.harness, "cancelled");
    const childEnvironment = harnessEnvironment(environment, descriptor);
    const configured = await (options.setupHarness
      ? options.setupHarness(options.harness, childEnvironment)
      : options.harness === "codex"
        ? configureCodexIntegrationForRemoteBackend({
            ...options.codexOptions,
            environment: childEnvironment,
            apiUrl: descriptor.backendUrl,
            credentialAvailable: () => true
          })
        : options.harness === "claude"
          ? setupClaude(childEnvironment)
          : setupPi(childEnvironment));
    if (!configured.ok) {
      return result(
        options.harness,
        "needs_attention",
        "AI Client integration setup failed; review the existing harness setup checks."
      );
    }
    writeHeadlessRemoteIntegration(environment, descriptor);
    return result(options.harness, "configured");
  } catch {
    return result(
      options.harness,
      "needs_attention",
      "Remote integration configuration could not be safely updated."
    );
  }
};

export const checkHeadlessRemoteIntegration = async (
  options: Omit<HeadlessRemoteIntegrationOptions, "consent">
): Promise<HeadlessRemoteIntegrationResult> => {
  if (options.signal?.aborted) return result(options.harness, "cancelled");
  const environment = options.environment ?? process.env;
  try {
    const descriptor = readHeadlessRemoteIntegration(environment);
    if (!descriptor?.harnesses.includes(options.harness)) {
      return result(
        options.harness,
        "needs_attention",
        "This AI Client has no registered remote integration."
      );
    }
    if (!options.credentialAvailable?.(descriptor.credentialRef)) {
      return result(
        options.harness,
        "needs_attention",
        "Remote authentication is unavailable."
      );
    }
    if (
      !(await (options.checkHarness ?? inspectHarness)(
        options.harness,
        harnessEnvironment(environment, descriptor)
      ))
    ) {
      return result(
        options.harness,
        "needs_attention",
        "AI Client configuration needs attention."
      );
    }
    return result(options.harness, "configured");
  } catch {
    return result(
      options.harness,
      "needs_attention",
      "Remote integration configuration could not be safely checked."
    );
  }
};

export const removeHeadlessRemoteIntegration = (
  options: HeadlessRemoteIntegrationOptions
): HeadlessRemoteIntegrationResult => {
  const denied = approved(options);
  if (denied) return denied;
  const environment = options.environment ?? process.env;
  try {
    const descriptor = readHeadlessRemoteIntegration(environment);
    if (!descriptor?.harnesses.includes(options.harness))
      return result(options.harness, "removed");
    const childEnvironment = harnessEnvironment(environment, descriptor);
    const removed = options.removeHarness
      ? options.removeHarness(options.harness, childEnvironment)
      : options.harness === "codex"
        ? removeCodexIntegration({
            ...options.codexOptions,
            environment: childEnvironment
          })
        : options.harness === "claude"
          ? removeClaude(childEnvironment)
          : removePi(childEnvironment);
    if (!removed.ok)
      return result(
        options.harness,
        "needs_attention",
        "AI Client integration removal failed; remote configuration was retained."
      );
    const remaining = descriptor.harnesses.filter(
      (harness) => harness !== options.harness
    );
    if (remaining.length) {
      writeHeadlessRemoteIntegration(environment, {
        ...descriptor,
        harnesses: remaining
      });
    } else {
      unlinkSync(headlessRemoteIntegrationPath(environment));
    }
    return result(options.harness, "removed");
  } catch {
    return result(
      options.harness,
      "needs_attention",
      "Remote integration configuration could not be safely removed."
    );
  }
};
