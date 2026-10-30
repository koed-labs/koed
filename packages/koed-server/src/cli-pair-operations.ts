import type { KoedServerCliDependencies } from "./cli-contract.js";
import type { PairOptions } from "./cli-personal-sync.js";
import { deviceRequestCommand as defaultDeviceRequest } from "./personal-device-request.js";
import { createCliServiceContext } from "./cli-service-context.js";
import { printJson, checkCoreSetupNeeded } from "./cli-service-output.js";

export const runPairCommand = async (
  subcommand: "status" | "cancel" | undefined,
  options: PairOptions,
  dependencies: KoedServerCliDependencies
): Promise<number> => {
  const { startDaemon, collectStartupStatus, resolvePaths, stdout, stderr } =
    createCliServiceContext(dependencies);
  const deviceRequestCommand =
    dependencies.deviceRequest ?? defaultDeviceRequest;
  const wantsJson = options.json;
  try {
    const paths = resolvePaths();
    const setupNeeded = checkCoreSetupNeeded(paths);
    if (subcommand === "status" || subcommand === "cancel") {
      const value = await deviceRequestCommand(paths, subcommand);
      if (wantsJson) printJson(stdout, value);
      else stdout.write(`${value.state}\n`);
      return 0;
    }
    if (setupNeeded) {
      stderr.write(`${setupNeeded}\n`);
      return 1;
    }
    let ready = await collectStartupStatus();
    if (!ready.ok) {
      const started = startDaemon();
      if (!started.ok) throw new Error(started.error ?? started.message);
      for (let attempt = 0; attempt < 90 && !ready.ok; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        ready = await collectStartupStatus();
      }
    }
    if (!ready.ok)
      throw new Error(
        "Koed could not start. Run koed doctor for setup guidance."
      );
    const initial = await deviceRequestCommand(
      paths,
      "create",
      options.deviceLabel
    );
    if (wantsJson) printJson(stdout, initial);
    else
      stdout.write(
        initial.link
          ? `Paste this request into Devices → Add device on your existing Koed installation:\n\n${initial.link}\n\nExpires ${initial.expiresAt}. Waiting for approval…\n`
          : `Enrollment is ${initial.state}. Waiting…\n`
      );
    if (options.detach) return 0;
    let previous = initial.state;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const value = await deviceRequestCommand(paths, "status");
      if (value.state !== previous) {
        if (wantsJson) printJson(stdout, value);
        else stdout.write(`${value.state}\n`);
        previous = value.state;
      }
      if (value.state === "connected") return 0;
      if (["failed", "expired", "cancelled"].includes(value.state)) return 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (wantsJson) printJson(stdout, { ok: false, error: message });
    else stderr.write(`${message}\n`);
    return 1;
  }
};
