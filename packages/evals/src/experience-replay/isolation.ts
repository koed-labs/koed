import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Redis } from "ioredis";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
export const EVAL_DATABASE_PREFIX = "koed_eval_";

export const assertLoopbackUrl = (value: string, label: string): URL => {
  const parsed = new URL(value);
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`${label} must target an exact loopback host`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not carry credentials in its URL`);
  }
  return parsed;
};

export const assertEvalDatabaseUrl = (value: string): URL => {
  const parsed = new URL(value);
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error("PostgreSQL must target an exact loopback host");
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!database.startsWith(EVAL_DATABASE_PREFIX)) {
    throw new Error(`Eval database must start with ${EVAL_DATABASE_PREFIX}`);
  }
  return parsed;
};

export interface TrialRedisHandle {
  url: string;
  pid: number;
  processGroupId: number;
  socketPath: string;
  password: string;
  close(): Promise<void>;
}

const isRunning = (child: ChildProcess): boolean =>
  Boolean(child.pid) && child.exitCode === null && child.signalCode === null;

const waitForStop = async (
  isStopped: () => boolean,
  timeoutMs: number
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (isStopped()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return isStopped();
};

const processGroupExists = (processGroupId: number): boolean => {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const signalProcessGroup = (
  child: ChildProcess,
  processGroupId: number,
  signal: NodeJS.Signals
): void => {
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};

const stopChild = async (
  child: ChildProcess,
  processGroupId: number,
  gracefulTimeoutMs: number
): Promise<void> => {
  const isStopped = (): boolean =>
    !isRunning(child) &&
    (process.platform === "win32" || !processGroupExists(processGroupId));
  if (isStopped()) return;
  signalProcessGroup(child, processGroupId, "SIGTERM");
  if (await waitForStop(isStopped, gracefulTimeoutMs)) return;
  signalProcessGroup(child, processGroupId, "SIGKILL");
  if (!(await waitForStop(isStopped, gracefulTimeoutMs))) {
    throw new Error(
      `Failed to prove isolated Redis process group ${processGroupId} stopped`
    );
  }
};

const redisUrl = (socketPath: string, password: string): string =>
  `redis://default:${password}@localhost/0?path=${encodeURIComponent(socketPath)}`;

const redisClient = (url: string, commandTimeout: number): Redis => {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: commandTimeout,
    commandTimeout,
    retryStrategy: () => null
  });
  client.on("error", () => {
    // Connection failures are observed by the awaited commands below.
  });
  return client;
};

export const startTrialRedis = async ({
  executable = "redis-server",
  startupTimeoutMs = 10_000,
  shutdownTimeoutMs = 2_000
}: {
  executable?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
} = {}): Promise<TrialRedisHandle> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "koed-eval-redis-"));
  await chmod(directory, 0o700);
  const socketPath = path.join(directory, "redis.sock");
  const password = randomBytes(32).toString("hex");
  const child = spawn(
    executable,
    [
      "--port",
      "0",
      "--unixsocket",
      socketPath,
      "--unixsocketperm",
      "700",
      "--requirepass",
      password,
      "--protected-mode",
      "yes",
      "--save",
      "",
      "--appendonly",
      "no",
      "--dir",
      directory,
      "--dbfilename",
      "disabled.rdb"
    ],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe"]
    }
  );
  const stderr: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  let childError: Error | undefined;
  let markStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    markStopped = resolve;
  });
  child.once("error", (error) => {
    childError = error;
    markStopped?.();
  });
  child.once("exit", () => markStopped?.());
  if (!child.pid) {
    await waitForStop(() => childError !== undefined, startupTimeoutMs);
    await rm(directory, { recursive: true, force: true });
    throw new Error(
      `Failed to start isolated Redis${childError ? `: ${childError.message}` : ""}`
    );
  }
  const pid = child.pid;
  const processGroupId = pid;
  const url = redisUrl(socketPath, password);
  const deadline = Date.now() + startupTimeoutMs;
  let ready = false;
  let readinessError: unknown;
  while (Date.now() < deadline) {
    if (!isRunning(child) || childError) break;
    const client = redisClient(url, 250);
    try {
      await client.connect();
      const [pong, serverInfo] = await Promise.all([
        client.ping(),
        client.info("server")
      ]);
      const reportedPid = /^process_id:(\d+)$/m.exec(serverInfo)?.[1];
      ready = pong === "PONG" && reportedPid === String(pid);
      if (!ready) {
        readinessError = new Error(
          `Redis process identity mismatch (expected ${pid}, got ${reportedPid ?? "unknown"})`
        );
      }
      if (ready) break;
    } catch (error) {
      readinessError = error;
    } finally {
      client.disconnect();
    }
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 25)),
      stopped
    ]);
  }
  if (!ready) {
    await stopChild(child, processGroupId, shutdownTimeoutMs);
    await rm(directory, { recursive: true, force: true });
    const detail =
      childError?.message ??
      (readinessError instanceof Error ? readinessError.message : undefined) ??
      Buffer.concat(stderr).toString("utf8").trim();
    throw new Error(
      `Isolated Redis did not become ready${detail ? `: ${detail}` : ""}`
    );
  }
  let cleanup: Promise<void> | undefined;
  return {
    url,
    pid,
    processGroupId,
    socketPath,
    password,
    close() {
      cleanup ??= (async () => {
        // Redis handles SIGTERM as a graceful shutdown. A wedged process gets
        // only the configured grace period before forced termination.
        await stopChild(child, processGroupId, shutdownTimeoutMs);
        await rm(directory, { recursive: true, force: true });
      })();
      return cleanup;
    }
  };
};
