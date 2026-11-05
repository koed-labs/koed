import type { Command } from "commander";
import type { KoedServerCliDependencies } from "./cli-contract.js";
import { resolveKoedServerPaths } from "./paths.js";
import {
  inspectPeerOnlineCustody,
  UnsupportedPeerOnlinePlatformError
} from "./cli-peer-online-custody.js";

export function registerPeerOnlineCommands(
  program: Command,
  dependencies: KoedServerCliDependencies,
  complete: (code: number) => void
): void {
  const peer = program
    .command("peer-online")
    .description("Inspect local peer-online custody status");
  peer.action(() => peer.outputHelp());
  peer
    .command("status")
    .description("Show local peer-online status")
    .option("--json", "Emit JSON output")
    .action(async (options: { json?: boolean }) => {
      const stdout = dependencies.stdout ?? process.stdout;
      const stderr = dependencies.stderr ?? process.stderr;
      try {
        const root = (dependencies.resolvePaths ?? resolveKoedServerPaths)()
          .koedHome;
        const custody = await inspectPeerOnlineCustody(root);
        const deviceId = custody.deviceId;
        const certificate = custody.certificate ? "present" : "missing";
        const result = {
          ok: true,
          enabled: false,
          identity: deviceId ? "present" : "missing",
          certificate,
          ...(deviceId ? { deviceId } : {}),
          message:
            "Peer online is disabled; trusted membership and initialization are not configured. Sync is not available."
        };
        stdout.write(
          options.json
            ? `${JSON.stringify(result, null, 2)}\n`
            : `${result.message}\nIdentity: ${result.identity}; certificate: ${certificate}${deviceId ? `; device: ${deviceId}` : ""}\n`
        );
        complete(0);
      } catch (error) {
        const message =
          error instanceof UnsupportedPeerOnlinePlatformError
            ? "Peer-online custody inspection requires POSIX ownership; this platform is unsupported."
            : "Unable to inspect peer-online custody; storage may be inaccessible or corrupt.";
        if (options.json)
          stdout.write(
            `${JSON.stringify({ ok: false, error: message }, null, 2)}\n`
          );
        else stderr.write(`${message}\n`);
        complete(1);
      }
    });
}
