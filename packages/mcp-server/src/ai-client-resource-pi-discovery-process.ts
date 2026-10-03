import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolvePiSdkInstallation } from "./pi-sdk-installation.js";

export type PiDiscoveredResource = {
  kind: "skill" | "extension";
  name: string;
  description?: string;
  path: string;
  source: "user" | "plugin";
  status: "ready" | "disabled" | "unavailable";
};

const piDiscoveryResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    resources: z
      .array(
        z.object({
          kind: z.enum(["skill", "extension"]),
          name: z.string().min(1).max(160),
          description: z.string().max(1_000).optional(),
          path: z.string().min(1).max(4_096),
          source: z.enum(["user", "plugin"]),
          status: z.enum(["ready", "disabled", "unavailable"])
        })
      )
      .max(500)
  }),
  z.object({
    ok: z.literal(false),
    errorCode: z.literal("AiClientPiUnavailable")
  })
]);

export type PiDiscoveryChild = Pick<
  ChildProcess,
  "on" | "once" | "send" | "kill"
>;
export type PiDiscoveryFork = (
  modulePath: string,
  args: string[],
  options: ForkOptions
) => PiDiscoveryChild;

export const discoverPiResourcesInChild = async (input: {
  cwd: string;
  executablePath: string;
  configHome: string | null;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  forkChild?: PiDiscoveryFork;
  resolveInstallation?: typeof resolvePiSdkInstallation;
}): Promise<PiDiscoveredResource[]> => {
  if (input.signal?.aborted) throw new Error("AiClientResourceLeaseLost");
  const timeoutMs = Math.min(
    50_000,
    Math.max(1_000, input.timeoutMs ?? 45_000)
  );
  const childPath = fileURLToPath(
    new URL("./ai-client-resource-pi-discovery-child.js", import.meta.url)
  );
  const installation = (input.resolveInstallation ?? resolvePiSdkInstallation)({
    executablePath: input.executablePath,
    environment: input.environment
  });
  const forkChild = input.forkChild ?? fork;
  let child: PiDiscoveryChild;
  try {
    child = forkChild(childPath, [], {
      cwd: input.cwd,
      env: installation.environment,
      execPath: installation.execPath,
      execArgv: installation.execArgv,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json"
    });
  } catch {
    throw new Error("AiClientPiUnavailable");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let terminalError: Error | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reapTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (reapTimer) clearTimeout(reapTimer);
      input.signal?.removeEventListener("abort", abort);
    };
    const settle = (error?: Error, resources?: PiDiscoveredResource[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(resources ?? []);
    };
    const terminateWithError = (error: Error) => {
      if (settled || terminalError) return;
      terminalError = error;
      const signalled = child.kill("SIGKILL");
      if (!signalled || settled) {
        if (!settled) settle(terminalError);
        return;
      }
      reapTimer = setTimeout(() => settle(terminalError!), 1_000);
    };
    const terminate = (
      code: "AiClientResourceDiscoveryTimedOut" | "AiClientResourceLeaseLost"
    ) => terminateWithError(new Error(code));
    const abort = () => terminate("AiClientResourceLeaseLost");
    timer = setTimeout(
      () => terminate("AiClientResourceDiscoveryTimedOut"),
      timeoutMs
    );
    input.signal?.addEventListener("abort", abort, { once: true });
    child.once("message", (message: unknown) => {
      if (terminalError) return;
      const parsed = piDiscoveryResultSchema.safeParse(message);
      if (!parsed.success || !parsed.data.ok) {
        terminateWithError(new Error("AiClientPiUnavailable"));
        return;
      }
      settle(undefined, parsed.data.resources);
    });
    child.once("error", () =>
      settle(terminalError ?? new Error("AiClientPiUnavailable"))
    );
    child.once("exit", () =>
      settle(terminalError ?? new Error("AiClientPiUnavailable"))
    );
    if (input.signal?.aborted) {
      abort();
      return;
    }
    try {
      child.send({
        cwd: input.cwd,
        sdkEntryPath: installation.sdkEntryPath,
        configHome: input.configHome
      });
    } catch {
      child.kill("SIGKILL");
      settle(new Error("AiClientPiUnavailable"));
    }
  });
};
