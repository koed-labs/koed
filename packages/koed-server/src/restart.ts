import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { startKoedServer, type KoedServerStartOptions } from "./start.js";
import { stopKoedServer, type KoedServerStopOptions } from "./stop.js";

type SpawnLike = NonNullable<KoedServerStartOptions["spawn"]>;

export interface KoedServerRestartResult {
  ok: boolean;
  state: "healthy" | "starting" | "needs_attention" | "not_configured";
  koedHome: string;
  message: string;
  stoppedPids: number[];
  missingPids: number[];
  startedPid?: number;
  stoppedServices: string[];
  missingServices: string[];
}

export interface KoedServerRestartOptions
  extends KoedServerStartOptions, KoedServerStopOptions {
  waitForExitMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  start?: typeof startKoedServer;
  startCommand?: string;
}

const defaultCheckPid = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const startDetached = ({
  environment = process.env,
  spawn = nodeSpawn as SpawnLike,
  startCommand = process.argv[1]
}: Pick<
  KoedServerRestartOptions,
  "environment" | "spawn" | "startCommand"
>): number => {
  if (!startCommand) {
    throw new Error("Could not resolve koed-server CLI path for restart.");
  }
  const child = spawn(process.execPath, [startCommand, "start"], {
    cwd: environment.KOED_REPO_ROOT ?? process.cwd(),
    detached: true,
    env: environment,
    stdio: "ignore"
  }) as ChildProcess;
  if (!child.pid) {
    throw new Error("Could not start koed-server restart child process.");
  }
  child.unref();
  return child.pid;
};

const waitForPidsToExit = async (
  pids: number[],
  {
    checkPid = defaultCheckPid,
    waitForExitMs = 10_000,
    pollIntervalMs = 250,
    sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  }: Pick<
    KoedServerRestartOptions,
    "checkPid" | "waitForExitMs" | "pollIntervalMs" | "sleep"
  >
): Promise<number[]> => {
  const uniquePids = [...new Set(pids)].filter((pid) => pid > 0);
  const deadline = Date.now() + waitForExitMs;
  let running = uniquePids.filter(checkPid);
  while (running.length > 0 && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    running = uniquePids.filter(checkPid);
  }
  return running;
};

export const restartKoedServer = async (
  options: KoedServerRestartOptions = {}
): Promise<KoedServerRestartResult> => {
  const stop = stopKoedServer(options);
  if (!stop.ok) {
    return {
      ok: false,
      state: "needs_attention",
      koedHome: stop.koedHome,
      message: stop.message,
      stoppedPids: stop.stoppedPids,
      missingPids: stop.missingPids,
      stoppedServices: stop.stoppedServices,
      missingServices: stop.missingServices
    };
  }

  const stillRunning = await waitForPidsToExit(stop.stoppedPids, options);
  if (stillRunning.length > 0) {
    const kill =
      options.kill ??
      ((pid: number, signal: NodeJS.Signals) => {
        process.kill(pid, signal);
      });
    for (const pid of stillRunning) {
      kill(pid, "SIGKILL");
    }
    const runningAfterKill = await waitForPidsToExit(stillRunning, options);
    if (runningAfterKill.length > 0) {
      return {
        ok: false,
        state: "needs_attention",
        koedHome: stop.koedHome,
        message: "Timed out waiting for koed-server processes to stop.",
        stoppedPids: stop.stoppedPids,
        missingPids: [...stop.missingPids, ...runningAfterKill],
        stoppedServices: stop.stoppedServices,
        missingServices: stop.missingServices
      };
    }
  }

  let startedPid: number | undefined;
  if (options.start) {
    await options.start(options);
  } else {
    startedPid = startDetached(options);
  }
  return {
    ok: true,
    state: "starting",
    koedHome: stop.koedHome,
    message: "Koed server restarted.",
    ...(startedPid ? { startedPid } : {}),
    stoppedPids: stop.stoppedPids,
    missingPids: stop.missingPids,
    stoppedServices: stop.stoppedServices,
    missingServices: stop.missingServices
  };
};
