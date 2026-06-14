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
      stdio: "ignore";
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
  void environment;

  const runJson = (args: string[]) =>
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
          timeout: 30_000
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
                (stderr.trim() || "koed-server command failed.")
            });
          }
        }
      );
    });

  const start = () => {
    if (serverProcess && !serverProcess.killed) {
      return {
        ok: true,
        state: "starting",
        message: "koed-server already started."
      };
    }
    if (!existsSync(cliPath)) {
      return missingCliPayload();
    }

    const invocation = createCliInvocation(["start"]);
    serverProcess = spawn(invocation.command, invocation.args, {
      cwd: repoRoot,
      env: invocation.env,
      stdio: "ignore",
      detached: false
    });
    serverProcess.once("exit", () => {
      serverProcess = null;
    });
    return {
      ok: true,
      state: "starting",
      message: "koed-server start requested."
    };
  };

  const stop = () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill("SIGTERM");
    }
  };

  return {
    handlers: {
      status: () => runJson(["status"]),
      doctor: () => runJson(["doctor"]),
      setup_codex: () => runJson(["setup", "codex"]),
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
