#!/usr/bin/env node
import { setupCodex } from "./setup.js";
import { collectKoedServerDoctor, collectKoedServerStatus } from "./status.js";
import { startKoedServer } from "./start.js";

const usageText = `Usage: koed-server <command> [options]

Commands:
  start                  Start and supervise local Koed services
  status --json          Print machine-readable local service state
  doctor --json          Print actionable setup/dependency diagnostics
  setup codex --json     Configure the supported Codex integration

Options:
  --json                 Emit JSON output for commands that support it
  --help, -h             Show this help

Environment:
  KOED_HOME              Directory for local Koed config, logs, and runtime state
  KOED_REPO_ROOT         Koed checkout path used by this development build
`;

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];
const wantsHelp = args.includes("--help") || args.includes("-h");
const wantsJson = args.includes("--json");

const printJson = (value: unknown) => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const main = async () => {
  if (wantsHelp || !command) {
    process.stdout.write(usageText);
    return;
  }

  if (command === "status") {
    const status = await collectKoedServerStatus();
    if (wantsJson) {
      printJson(status);
    } else {
      process.stdout.write(`${status.state}\n`);
    }
    process.exitCode = 0;
    return;
  }

  if (command === "doctor") {
    const doctor = await collectKoedServerDoctor();
    if (wantsJson) {
      printJson(doctor);
    } else {
      process.stdout.write(`${doctor.summary}\n`);
    }
    process.exitCode = doctor.ok ? 0 : 1;
    return;
  }

  if (command === "start") {
    await startKoedServer();
    return;
  }

  if (command === "setup" && subcommand === "codex") {
    const result = setupCodex();
    if (wantsJson) {
      printJson(result);
    } else {
      process.stdout.write(
        result.ok
          ? "Codex setup completed.\n"
          : `${result.error ?? "Codex setup failed."}\n`
      );
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  process.stderr.write(`Unknown command.\n\n${usageText}`);
  process.exitCode = 2;
};

main().catch((error) => {
  const payload = {
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  };
  if (wantsJson) {
    printJson(payload);
  } else {
    process.stderr.write(`${payload.error}\n`);
  }
  process.exitCode = 1;
});
