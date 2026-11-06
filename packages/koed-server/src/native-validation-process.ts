import { spawn } from "node:child_process";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export interface ProbeContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

interface Probe {
  closed: Promise<number | null>;
  lifetime: AbortSignal;
  log: () => string;
}

// Each probe owns its Linux process group. Reap it before removing the private
// socket directory or allowing the caller to release the stopped-runtime lock.
export async function withNativeProbe<T>(
  binary: string,
  args: string[],
  context: ProbeContext,
  action: (probe: Probe) => Promise<T>,
  observeOutput?: (tail: string) => void
): Promise<T> {
  context.signal.throwIfAborted();
  const child = spawn(binary, args, {
    cwd: context.cwd,
    env: context.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  const append = (chunk: string) => {
    output = (output + chunk).slice(-64 * 1024);
    observeOutput?.(output);
  };
  child.stdout.setEncoding("utf8").on("data", append);
  child.stderr.setEncoding("utf8").on("data", append);
  const ended = new AbortController();
  const killGroup = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  };
  let exited = false;
  child.once("error", (error) => {
    append(error.message);
    ended.abort(error);
  });
  child.once("exit", () => {
    // A descendant can hold the output pipes open after the leader exits.
    killGroup();
    exited = true;
    ended.abort(new Error("Native probe exited."));
  });
  const stop = () => {
    if (!exited) killGroup();
  };
  const closed = new Promise<number | null>((done) =>
    child.once("close", done)
  );
  context.signal.addEventListener("abort", stop, { once: true });
  try {
    return await action({
      closed,
      log: () => output,
      lifetime: AbortSignal.any([context.signal, ended.signal])
    });
  } finally {
    context.signal.removeEventListener("abort", stop);
    stop();
    await closed;
  }
}

export async function nativeCommand(
  binary: string,
  args: string[],
  context: ProbeContext
): Promise<string> {
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(10_000)]);
  return withNativeProbe(
    binary,
    args,
    { ...context, signal },
    async (probe) => {
      const code = await probe.closed;
      signal.throwIfAborted();
      if (code !== 0)
        throw new Error(
          probe.log().trim().slice(-1500) || `Exited with code ${code}.`
        );
      return probe.log().trim();
    }
  );
}

function socketRequest(
  socketPath: string,
  path: string,
  signal: AbortSignal,
  body?: string
) {
  return new Promise<{ status: number; body: string }>((done, fail) => {
    const req = request(
      {
        socketPath,
        path,
        signal,
        agent: false,
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : {}
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("error", fail);
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024)
            res.destroy(new Error("Validation response exceeded 1 MiB."));
          else chunks.push(chunk);
        });
        res.on("end", () =>
          done({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    req.on("error", fail);
    req.end(body);
  });
}

export async function requestProbeEmbeddings(
  socket: string,
  inputs: readonly string[],
  signal: AbortSignal
): Promise<unknown> {
  const startup = AbortSignal.any([signal, AbortSignal.timeout(40_000)]);
  for (;;) {
    startup.throwIfAborted();
    try {
      const health = await socketRequest(socket, "/health", startup);
      if (health.status === 200) break;
      if (health.status !== 503)
        throw new Error(
          `Embedding health check returned HTTP ${health.status}.`
        );
    } catch (error) {
      if (
        !["ENOENT", "ECONNREFUSED"].includes(
          (error as NodeJS.ErrnoException).code ?? ""
        )
      )
        throw error;
    }
    await delay(100, undefined, { signal: startup });
  }
  const result = await socketRequest(
    socket,
    "/v1/embeddings",
    signal,
    JSON.stringify({ model: "qualification", input: inputs })
  );
  if (result.status !== 200)
    throw new Error(`Embedding request returned HTTP ${result.status}.`);
  return JSON.parse(result.body);
}
