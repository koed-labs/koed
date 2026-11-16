import type { ControlClient } from "./client.js";
import { ControlOwnerGoneError } from "./connect-or-launch.js";

export async function runControlPlaneCli(
  args: string[],
  dependencies: {
    connect(command: "start" | "stop"): Promise<ControlClient>;
    stdout: Pick<NodeJS.WriteStream, "write">;
    stderr: Pick<NodeJS.WriteStream, "write">;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    stopTimeoutMs?: number;
    allowImplicitStop?: boolean;
    allowAutomaticStart?: boolean;
    offlineStop?: () => { clean: boolean } | undefined;
  }
): Promise<number> {
  const json = args.includes("--json");
  const command = args[0];
  if (command === "restart") {
    if (args.slice(1).some((arg) => arg !== "--json")) {
      const message = "Unsupported control-plane command option";
      if (json)
        dependencies.stdout.write(
          `${JSON.stringify({ ok: false, error: message })}\n`
        );
      else dependencies.stderr.write(`${message}\n`);
      return 1;
    }
    let stopOutput = "";
    const stop = await runControlPlaneCli(
      ["stop", ...(json ? ["--json"] : [])],
      {
        ...dependencies,
        stdout: {
          write: (chunk: string | Uint8Array) => {
            stopOutput += String(chunk);
            return true;
          }
        }
      }
    );
    if (stop !== 0) {
      if (stopOutput) dependencies.stdout.write(stopOutput);
      return stop;
    }
    return runControlPlaneCli(
      ["start", "--daemon", ...(json ? ["--json"] : [])],
      dependencies
    );
  }
  let client: ControlClient | undefined;
  try {
    if (command !== "start" && command !== "stop")
      throw new Error("Unsupported control-plane command");
    if (command === "start" && !args.includes("--daemon"))
      throw new Error(
        "Foreground start is not yet supported by the detached control plane"
      );
    if (
      args
        .slice(1)
        .some(
          (arg) =>
            arg !== "--daemon" &&
            arg !== "--json" &&
            !(
              arg === "--non-explicit" &&
              ((command === "stop" && dependencies.allowImplicitStop) ||
                (command === "start" && dependencies.allowAutomaticStart))
            )
        ) ||
      (command === "stop" && args.includes("--daemon"))
    )
      throw new Error("Unsupported control-plane command option");
    const tryOfflineStop = (): boolean => {
      if (command !== "stop" || args.includes("--non-explicit")) return false;
      const offline = dependencies.offlineStop?.();
      if (!offline) return false;
      if (!offline.clean)
        throw new Error(
          "Stop intent recorded; runtime cleanup remains unconfirmed"
        );
      dependencies.stdout.write(
        json
          ? `${JSON.stringify({ ok: true, state: "stopped", message: "Koed stopped." })}\n`
          : "Koed stopped.\n"
      );
      return true;
    };
    if (tryOfflineStop()) return 0;
    const now = dependencies.now ?? Date.now;
    const deadline = now() + (dependencies.stopTimeoutMs ?? 90_000);
    const bounded = async <T>(promise: Promise<T>): Promise<T> => {
      if (command !== "stop") return promise;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Control-plane stop timed out")),
              Math.max(0, deadline - now())
            );
          })
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    let connectExpired = false;
    const connecting = dependencies.connect(command).then((value) => {
      if (connectExpired) value.close();
      return value;
    });
    try {
      client = await bounded(connecting);
    } catch (error) {
      connectExpired = true;
      if (error instanceof ControlOwnerGoneError && tryOfflineStop()) return 0;
      throw error;
    }
    const status = await bounded(client.request({ action: "status" }, 0));
    if (!status.ok)
      throw new Error(`Control-plane status failed: ${status.code}`);
    let result = await bounded(
      client.request(
        { action: command, explicit: !args.includes("--non-explicit") },
        status.snapshot.revision
      )
    );
    // A stale revision proves the mutation was rejected; only Stop may retry it.
    for (
      let attempt = 0;
      command === "stop" &&
      !result.ok &&
      result.code === "stale_revision" &&
      attempt < 3;
      attempt++
    ) {
      result = await bounded(
        client.request(
          { action: "stop", explicit: !args.includes("--non-explicit") },
          result.snapshot.revision
        )
      );
    }
    if (!result.ok)
      throw new Error(`Control-plane ${command} failed: ${result.code}`);
    if (command === "stop") {
      const sleep =
        dependencies.sleep ??
        ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      while (
        result.snapshot.state !== "stopped" &&
        result.snapshot.state !== "needs_attention" &&
        now() < deadline
      ) {
        await sleep(250);
        result = await bounded(client.request({ action: "status" }, 0));
        if (!result.ok)
          throw new Error(`Control-plane status failed: ${result.code}`);
      }
      if (result.snapshot.state !== "stopped")
        throw new Error(
          "Control-plane stop did not confirm cleanup; Operator attention required"
        );
    }
    const message = command === "start" ? "Koed is starting." : "Koed stopped.";
    dependencies.stdout.write(
      json
        ? `${JSON.stringify({ ok: true, state: result.snapshot.state, message, snapshot: result.snapshot })}\n`
        : `${message}\n`
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json)
      dependencies.stdout.write(
        `${JSON.stringify({ ok: false, error: message })}\n`
      );
    else dependencies.stderr.write(`${message}\n`);
    return 1;
  } finally {
    client?.close();
  }
}
