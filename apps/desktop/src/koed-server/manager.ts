import type { ChildProcess } from "node:child_process";
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

const missingCliPayload = () => ({
  ok: false,
  state: "not_configured",
  error:
    "koed-server build output was not found. Run pnpm --filter @koed/koed-server build."
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
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => ({
  ...environment,
  KOED_REPO_ROOT: environment.KOED_REPO_ROOT ?? repoRoot
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
        resolvePromise(missingCliPayload());
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
            resolvePromise({
              ok: false,
              state: "needs_attention",
              error:
                error?.message ??
                (stderr.trim() ||
                  stdout.trim() ||
                  "koed-server command failed."),
              stdout: stdout.trim(),
              stderr: stderr.trim()
            });
          }
        }
      );
    });

  const pollUntilReady = async () => {
    let latest: unknown = null;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      latest = await runJson(["status"], 10_000);
      if (hasHealthyApi(latest)) {
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

  const start = async () => {
    const current = await runJson(["status"], 10_000);
    if (hasHealthyApi(current)) {
      return current;
    }

    if (serverProcess && !serverProcess.killed) {
      return pollUntilReady();
    }
    if (!existsSync(cliPath)) {
      return missingCliPayload();
    }

    startOutputLines.length = 0;
    const invocation = createCliInvocation(["start"]);
    appendOutputLines(
      startOutputLines,
      `$ ${invocation.command} ${invocation.args.join(" ")}`
    );
    serverProcess = spawn(invocation.command, invocation.args, {
      cwd: repoRoot,
      env: invocation.env,
      stdio: "pipe",
      detached: false
    });
    serverProcess.stdout?.on("data", (chunk) => {
      appendOutputLines(startOutputLines, chunk);
    });
    serverProcess.stderr?.on("data", (chunk) => {
      appendOutputLines(startOutputLines, chunk);
    });
    const startExited = new Promise<unknown>((resolveExit) => {
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
      setup_codex: () => runJson(["setup", "codex"], 120_000),
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
