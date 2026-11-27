import type { ControlClient } from "./client.js";
class OfflineStopCompleted extends Error {}
type UpgradeControlClient = ControlClient & {
  waitForRetirement?(): Promise<void>;
};

async function prepareUpgrade(client: UpgradeControlClient) {
  if (!client.waitForRetirement)
    throw new Error("Upgrade preparation requires the installed Koed CLI");
  const status = await client.request({ action: "status" }, 0);
  if (!status.ok)
    throw new Error(`Control-plane status failed: ${status.code}`);
  if (status.snapshot.state !== "stopped" || status.snapshot.error)
    throw new Error(
      "Stop Koed and confirm runtime cleanup before preparing an upgrade"
    );
  const result = await client.request(
    { action: "retire" },
    status.snapshot.revision
  );
  if (!result.ok)
    throw new Error(`Control-plane retirement failed: ${result.code}`);
  if (
    result.snapshot.state !== "stopped" ||
    !result.snapshot.stopIntent ||
    result.snapshot.error
  )
    throw new Error("Control-plane retirement did not confirm explicit Stop");
  await client.waitForRetirement();
  return result.snapshot;
}

export async function runControlPlaneCli(
  args: string[],
  dependencies: {
    connect(
      command: "start" | "stop" | "prepare-upgrade"
    ): Promise<UpgradeControlClient>;
    stdout: Pick<NodeJS.WriteStream, "write">;
    stderr: Pick<NodeJS.WriteStream, "write">;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    stopTimeoutMs?: number;
    allowImplicitStop?: boolean;
    allowAutomaticStart?: boolean;
    allowAgentAvailability?: boolean;
    persistentStart?: boolean;
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
  let client: UpgradeControlClient | undefined;
  try {
    if (command === "prepare-upgrade") {
      if (args.slice(1).some((arg) => arg !== "--json"))
        throw new Error("Unsupported control-plane command option");
      client = await dependencies.connect(command);
      const snapshot = await prepareUpgrade(client);
      const message =
        "Old Koed Server Control Plane exited. Replace the app before starting Koed again.";
      dependencies.stdout.write(
        json
          ? `${JSON.stringify({ ok: true, snapshot, message })}\n`
          : `${message}\n`
      );
      return 0;
    }
    if (
      command === "agent-enable" ||
      command === "agent-disable" ||
      command === "agent-status"
    ) {
      if (
        !dependencies.allowAgentAvailability ||
        args.slice(1).some((arg) => arg !== "--json")
      )
        throw new Error("Unsupported control-plane command");
      client = await dependencies.connect("start");
      const status = await client.request({ action: "status" }, 0);
      if (!status.ok)
        throw new Error(`Control-plane status failed: ${status.code}`);
      if (command === "agent-status") {
        dependencies.stdout.write(
          json
            ? `${JSON.stringify({ ok: true, snapshot: status.snapshot })}\n`
            : `${status.snapshot.state}\n`
        );
        return 0;
      }
      const result = await client.request(
        command === "agent-enable"
          ? { action: "attach", reason: "background-agent" }
          : { action: "detach", reason: "background-agent", intentional: true },
        status.snapshot.revision
      );
      if (!result.ok)
        throw new Error(`Agent availability failed: ${result.code}`);
      dependencies.stdout.write(
        json
          ? `${JSON.stringify({ ok: true, snapshot: result.snapshot })}\n`
          : "Agent availability updated.\n"
      );
      return 0;
    }
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
    const boundedRequest = async <T>(promise: Promise<T>): Promise<T> => {
      try {
        return await bounded(promise);
      } catch (error) {
        if (tryOfflineStop()) throw new OfflineStopCompleted();
        throw error;
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
      if (tryOfflineStop()) return 0;
      throw error;
    }
    const status = await boundedRequest(
      client.request({ action: "status" }, 0)
    );
    if (!status.ok) {
      if (tryOfflineStop()) return 0;
      throw new Error(`Control-plane status failed: ${status.code}`);
    }
    let result = await boundedRequest(
      client.request(
        command === "start" && dependencies.persistentStart
          ? {
              action: "start",
              explicit: !args.includes("--non-explicit"),
              persistentCli: true
            }
          : { action: command, explicit: !args.includes("--non-explicit") },
        status.snapshot.revision
      )
    );
    // A stale revision proves the request was rejected; never replay uncertain failures.
    for (
      let attempt = 0;
      !result.ok &&
      result.code === "stale_revision" &&
      attempt < 3 &&
      (command === "stop" || !result.snapshot.stopIntent);
      attempt++
    ) {
      result = await boundedRequest(
        client.request(
          command === "start" && dependencies.persistentStart
            ? {
                action: "start",
                explicit: !args.includes("--non-explicit"),
                persistentCli: true
              }
            : { action: command, explicit: !args.includes("--non-explicit") },
          result.snapshot.revision
        )
      );
    }
    if (!result.ok) {
      if (tryOfflineStop()) return 0;
      throw new Error(
        command === "start" &&
          result.snapshot.state === "needs_attention" &&
          result.snapshot.error
          ? result.snapshot.error
          : `Control-plane ${command} failed: ${result.code}`
      );
    }
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
        result = await boundedRequest(client.request({ action: "status" }, 0));
        if (!result.ok) {
          if (tryOfflineStop()) return 0;
          throw new Error(`Control-plane status failed: ${result.code}`);
        }
      }
      if (result.snapshot.state !== "stopped")
        throw new Error(
          "Control-plane stop did not confirm cleanup; Operator attention required"
        );
    }
    const message =
      command === "start"
        ? "Koed is starting."
        : result.snapshot.error
          ? `Koed stopped. ${result.snapshot.error}.`
          : "Koed stopped.";
    dependencies.stdout.write(
      json
        ? `${JSON.stringify({ ok: true, state: result.snapshot.state, message, snapshot: result.snapshot })}\n`
        : `${message}\n`
    );
    return 0;
  } catch (error) {
    if (error instanceof OfflineStopCompleted) return 0;
    const detail = error instanceof Error ? error.message : String(error);
    const message =
      command === "stop" && !args.includes("--non-explicit")
        ? `Stop could not be confirmed and may not have been recorded: ${detail}`
        : detail;
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
