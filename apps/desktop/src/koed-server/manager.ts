import type { ChildProcess } from "node:child_process";
import {
  existsSync as nodeExistsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  ComponentState,
  ComponentStatus,
  KoedServerStatus
} from "../types.js";
import type { NodeEntrypointInvocation } from "./runtime.js";

export type DesktopCommandHandler = (args?: Record<string, unknown>) => unknown;

export interface KoedServerManagerOptions {
  repoRoot: string;
  cliPath: string;
  environment: NodeJS.ProcessEnv;
  createCliInvocation: (args: string[]) => NodeEntrypointInvocation;
  existsSync: (path: string) => boolean;
  execFile: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      timeout: number;
    },
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => void;
  spawn: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      stdio: "pipe";
      detached: false;
    }
  ) => ChildProcess;
  openExternal: (url: string) => Promise<unknown>;
}

export interface KoedServerManager {
  handlers: Record<string, DesktopCommandHandler>;
  stop: () => void;
}

type DiagnosticStatus = KoedServerStatus & {
  error: string;
  details: Record<string, unknown>;
};

const diagnosticComponent = (
  state: ComponentState,
  message: string,
  action?: string
): ComponentStatus => ({
  state,
  message,
  ...(action ? { action } : {})
});

const diagnosticStatus = ({
  state,
  message,
  repoRoot,
  cliPath,
  details
}: {
  state: ComponentState;
  message: string;
  repoRoot: string;
  cliPath: string;
  details?: Record<string, unknown>;
}): DiagnosticStatus => {
  const component = (action?: string): ComponentStatus =>
    diagnosticComponent(state, message, action);
  return {
    ok: false,
    state,
    error: message,
    koedHome: "not available",
    generatedAt: new Date().toISOString(),
    api: { ...component("Start Koed"), url: "" },
    database: component("Install runtime assets"),
    redis: component(),
    workerQueues: component("Start Koed"),
    embeddingService: component("Install runtime assets"),
    apiToken: { ...component("Run setup"), configured: false },
    mcpServer: component("Run setup"),
    captureHook: component("Run setup"),
    codex: { ...component("Run setup"), configured: false },
    lcmSummaryService: component(),
    explorer: { ...component("Start Koed"), url: "" },
    lastVerification: { ...component("Run doctor"), checkedAt: null },
    details: {
      repoRoot,
      cliPath,
      ...details
    }
  } as DiagnosticStatus;
};

const missingCliPayload = (repoRoot: string, cliPath: string) =>
  diagnosticStatus({
    state: "not_configured",
    message:
      "koed-server CLI was not found. Build the checkout with `pnpm --filter @koed/koed-server build`, or launch the packaged app with KOED_REPO_ROOT/KOED_SERVER_CLI pointing at a Koed checkout.",
    repoRoot,
    cliPath
  });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const appendOutputLines = (buffer: string[], chunk: Buffer | string): void => {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    buffer.push(trimmed);
  }
  while (buffer.length > 400) {
    buffer.shift();
  }
};

const withDesktopStartLog = (
  value: unknown,
  outputLines: string[]
): unknown => {
  if (typeof value !== "object" || value === null || outputLines.length === 0) {
    return value;
  }
  return {
    ...value,
    desktopStartLog: outputLines.slice(-120)
  };
};

const summarizeStartFailure = (
  outputLines: string[],
  fallback: string
): string =>
  [...outputLines]
    .reverse()
    .find(
      (line) =>
        line.includes("failed with exit code") ||
        line.includes("ERR_PNPM") ||
        line.includes("Exit status") ||
        line.endsWith("Failed")
    ) ?? fallback;

const resolveKoedHome = (environment: NodeJS.ProcessEnv): string =>
  resolve(environment.KOED_HOME?.trim() || `${homedir()}/.koed`);

const resolveExplorerCredentialPath = (
  environment: NodeJS.ProcessEnv
): string =>
  resolve(resolveKoedHome(environment), "config", "explorer-token.json");

const readExplorerCredential = (
  environment: NodeJS.ProcessEnv
): { ok: true; apiToken: string } | { ok: false; error: string } => {
  const credentialPath = resolveExplorerCredentialPath(environment);
  if (!nodeExistsSync(credentialPath)) {
    return { ok: false, error: "Explorer credential is not provisioned." };
  }
  try {
    const parsed = JSON.parse(readFileSync(credentialPath, "utf8")) as {
      apiToken?: unknown;
    };
    return typeof parsed.apiToken === "string" && parsed.apiToken.trim()
      ? { ok: true, apiToken: parsed.apiToken.trim() }
      : { ok: false, error: "Explorer credential is missing an API Token." };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

const parseCreatedApiToken = (output: string): string | null => {
  const match = /^Token:\s*(\S+)$/m.exec(output);
  return match?.[1] ?? null;
};

const readDesktopPorts = (
  environment: NodeJS.ProcessEnv
): Record<string, string> => {
  const portsPath = resolve(
    resolveKoedHome(environment),
    "config",
    "local-ports.json"
  );
  if (!nodeExistsSync(portsPath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(portsPath, "utf8")) as Record<
      string,
      unknown
    >;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => typeof value === "string" && value.trim())
        .map(([key, value]) => [key, String(value)])
    );
  } catch {
    return {};
  }
};

const bundledLocalDatabaseUrl = (environment: NodeJS.ProcessEnv): string => {
  const ports = readDesktopPorts(environment);
  const user = environment.POSTGRES_USER ?? "koed";
  const password =
    environment.POSTGRES_PASSWORD ??
    environment.KOED_BUNDLED_POSTGRES_PASSWORD ??
    "koed-local-postgres";
  const database = environment.POSTGRES_DB ?? "koed";
  const host = environment.KOED_POSTGRES_HOST ?? "127.0.0.1";
  const port =
    environment.KOED_POSTGRES_PORT ??
    environment.POSTGRES_HOST_PORT ??
    ports.postgres ??
    "15432";
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
};

const hasHealthyApi = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || !("api" in value)) {
    return false;
  }
  const api = (value as { api?: unknown }).api;
  return (
    typeof api === "object" &&
    api !== null &&
    "state" in api &&
    (api as { state?: unknown }).state === "healthy"
  );
};

export const createKoedEnvironment = (
  repoRoot: string,
  environment: NodeJS.ProcessEnv,
  options: { desktopManagedLocal?: boolean } = {}
): NodeJS.ProcessEnv => ({
  ...environment,
  KOED_REPO_ROOT: environment.KOED_REPO_ROOT ?? repoRoot,
  ...(options.desktopManagedLocal
    ? {
        KOED_RUNTIME_MODE: environment.KOED_RUNTIME_MODE ?? "local-personal",
        KOED_DEPENDENCY_MODE:
          environment.KOED_DEPENDENCY_MODE ?? "bundled-local",
        WORK_QUEUE_BACKEND: environment.WORK_QUEUE_BACKEND ?? "local",
        KOED_AUTO_PORTS: environment.KOED_AUTO_PORTS ?? "1",
        KOED_PACKAGED_DESKTOP: environment.KOED_PACKAGED_DESKTOP ?? "1"
      }
    : {})
});

export const createKoedServerManager = ({
  repoRoot,
  cliPath,
  environment,
  createCliInvocation,
  existsSync,
  execFile,
  spawn,
  openExternal
}: KoedServerManagerOptions): KoedServerManager => {
  let serverProcess: ChildProcess | null = null;
  const startOutputLines: string[] = [];
  void environment;

  const runJson = (args: string[], timeout = 30_000) =>
    new Promise<unknown>((resolvePromise) => {
      if (!existsSync(cliPath)) {
        resolvePromise(missingCliPayload(repoRoot, cliPath));
        return;
      }

      const invocation = createCliInvocation([...args, "--json"]);
      execFile(
        invocation.command,
        invocation.args,
        {
          cwd: repoRoot,
          env: invocation.env,
          timeout
        },
        (error, stdout, stderr) => {
          try {
            resolvePromise(JSON.parse(stdout));
          } catch {
            const message =
              error?.message ??
              (stderr.trim() || stdout.trim() || "koed-server command failed.");
            resolvePromise(
              args[0] === "status"
                ? diagnosticStatus({
                    state: "needs_attention",
                    message,
                    repoRoot,
                    cliPath,
                    details: { stdout: stdout.trim(), stderr: stderr.trim() }
                  })
                : {
                    ok: false,
                    state: "needs_attention",
                    error: message,
                    stdout: stdout.trim(),
                    stderr: stderr.trim()
                  }
            );
          }
        }
      );
    });

  const pollUntilReady = async () => {
    let latest: unknown = null;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      latest = await runJson(["status"], 10_000);
      if (hasHealthyApi(latest)) {
        await provisionExplorerCredential();
        return withDesktopStartLog(latest, startOutputLines);
      }
      await sleep(1_000);
    }
    return withDesktopStartLog(
      latest ?? {
        ok: false,
        state: "needs_attention",
        error: "Timed out waiting for koed-server status."
      },
      startOutputLines
    );
  };

  const provisionExplorerCredential = () =>
    new Promise<{ ok: true; apiToken: string } | { ok: false; error: string }>(
      (resolvePromise) => {
        const current = readExplorerCredential(environment);
        if (current.ok) {
          resolvePromise(current);
          return;
        }
        if (environment.KOED_AUTO_PORTS !== "1") {
          resolvePromise(current);
          return;
        }

        execFile(
          "pnpm",
          [
            "api-token:create",
            "--owner-email",
            "desktop@koed.local",
            "--name",
            "Koed Desktop"
          ],
          {
            cwd: repoRoot,
            env: {
              ...environment,
              DATABASE_URL: bundledLocalDatabaseUrl(environment)
            },
            timeout: 120_000
          },
          (error, stdout, stderr) => {
            if (error) {
              resolvePromise({
                ok: false,
                error: stderr.trim() || stdout.trim() || error.message
              });
              return;
            }
            const token = parseCreatedApiToken(stdout);
            if (!token) {
              resolvePromise({
                ok: false,
                error: `Could not parse Koed API Token from output: ${stdout.trim()}`
              });
              return;
            }
            const credentialPath = resolveExplorerCredentialPath(environment);
            mkdirSync(resolve(credentialPath, ".."), { recursive: true });
            writeFileSync(
              credentialPath,
              `${JSON.stringify(
                {
                  apiToken: token,
                  provisionedAt: new Date().toISOString(),
                  source: "environment"
                },
                null,
                2
              )}\n`,
              { mode: 0o600 }
            );
            resolvePromise({ ok: true, apiToken: token });
          }
        );
      }
    );

  const start = async () => {
    const current = await runJson(["status"], 10_000);
    if (hasHealthyApi(current)) {
      await provisionExplorerCredential();
      return current;
    }

    if (serverProcess && !serverProcess.killed) {
      return pollUntilReady();
    }
    if (!existsSync(cliPath)) {
      return missingCliPayload(repoRoot, cliPath);
    }

    startOutputLines.length = 0;
    const invocation = createCliInvocation(["start"]);
    appendOutputLines(
      startOutputLines,
      `$ ${invocation.command} ${invocation.args.join(" ")}`
    );
    try {
      serverProcess = spawn(invocation.command, invocation.args, {
        cwd: repoRoot,
        env: invocation.env,
        stdio: "pipe",
        detached: false
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendOutputLines(
        startOutputLines,
        `koed-server start failed: ${message}`
      );
      serverProcess = null;
      return withDesktopStartLog(
        {
          ok: false,
          state: "needs_attention",
          error: message
        },
        startOutputLines
      );
    }
    serverProcess.stdout?.on("data", (chunk) => {
      appendOutputLines(startOutputLines, chunk);
    });
    serverProcess.stderr?.on("data", (chunk) => {
      appendOutputLines(startOutputLines, chunk);
    });
    const startExited = new Promise<unknown>((resolveExit) => {
      serverProcess?.once("error", (error) => {
        const message = `koed-server start failed: ${error.message}`;
        appendOutputLines(startOutputLines, message);
        serverProcess = null;
        resolveExit(
          withDesktopStartLog(
            {
              ok: false,
              state: "needs_attention",
              error: message
            },
            startOutputLines
          )
        );
      });
      serverProcess?.once("exit", (code, signal) => {
        const exitSummary = `koed-server start exited with ${
          signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
        }`;
        appendOutputLines(startOutputLines, exitSummary);
        serverProcess = null;
        resolveExit(
          withDesktopStartLog(
            {
              ok: false,
              state: "needs_attention",
              error: summarizeStartFailure(startOutputLines, exitSummary)
            },
            startOutputLines
          )
        );
      });
    });
    return await Promise.race([pollUntilReady(), startExited]);
  };

  const stop = () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill("SIGTERM");
    }
  };

  return {
    handlers: {
      status: async () =>
        withDesktopStartLog(await runJson(["status"]), startOutputLines),
      doctor: () => runJson(["doctor"], 45_000),
      stop: async () => {
        const result = await runJson(["stop"], 45_000);
        if (serverProcess && !serverProcess.killed) {
          serverProcess.kill("SIGTERM");
        }
        serverProcess = null;
        return result;
      },
      setup_codex: () => runJson(["setup", "codex"], 120_000),
      repair_codex: () => runJson(["repair", "codex"], 120_000),
      runtime_install: () =>
        runJson(
          [
            "runtime",
            "install",
            "--provider",
            "homebrew",
            "--dependency-mode",
            "bundled-local"
          ],
          600_000
        ),
      explorer_credential: () => provisionExplorerCredential(),
      start,
      open_external: async (args) => {
        const url = typeof args?.url === "string" ? args.url : "";
        if (!url) {
          return { ok: false, error: "url is required." };
        }
        await openExternal(url);
        return { ok: true };
      }
    },
    stop
  };
};
