import type { KoedServerStatus } from "../../types.js";

export type DesktopCommand =
  | "status"
  | "doctor"
  | "setup_core"
  | "setup_codex"
  | "check_codex"
  | "repair_codex"
  | "remove_codex"
  | "setup_pi"
  | "check_pi"
  | "repair_pi"
  | "remove_pi"
  | "setup_claude"
  | "check_claude"
  | "repair_claude"
  | "remove_claude"
  | "runtime_status"
  | "runtime_install"
  | "models_status"
  | "models_install"
  | "package_status"
  | "package_install"
  | "project_list"
  | "upstream_connect"
  | "start"
  | "start_daemon"
  | "open_external"
  | "reveal_local_project"
  | "open_logs";

const defaultTimeoutMs: Record<DesktopCommand, number> = {
  status: 135_000,
  doctor: 90_000,
  setup_core: 330_000,
  setup_codex: 120_000,
  check_codex: 90_000,
  repair_codex: 120_000,
  remove_codex: 120_000,
  setup_pi: 120_000,
  check_pi: 90_000,
  repair_pi: 120_000,
  remove_pi: 120_000,
  setup_claude: 120_000,
  check_claude: 90_000,
  repair_claude: 120_000,
  remove_claude: 120_000,
  runtime_status: 60_000,
  runtime_install: 600_000,
  models_status: 60_000,
  models_install: 600_000,
  package_status: 60_000,
  package_install: 600_000,
  project_list: 15_000,
  upstream_connect: 120_000,
  start: 180_000,
  start_daemon: 60_000,
  open_external: 15_000,
  reveal_local_project: 15_000,
  open_logs: 15_000
};

export class DesktopCommandError extends Error {
  readonly command: DesktopCommand;

  constructor(command: DesktopCommand, message: string) {
    super(message);
    this.name = "DesktopCommandError";
    this.command = command;
  }
}

export const invokeDesktop = async <Result>(
  command: DesktopCommand,
  args?: Record<string, unknown>,
  timeoutMs = defaultTimeoutMs[command]
): Promise<Result> => {
  const bridge = window.koedDesktop;
  if (!bridge) throw new DesktopCommandError(command, "Desktop unavailable.");

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      bridge.invoke<Result>(command, args),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new DesktopCommandError(
                command,
                `${command} did not finish within ${Math.ceil(timeoutMs / 1_000)} seconds.`
              )
            ),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export type StatusSnapshot = {
  busyCommand: DesktopCommand | null;
  error: string | null;
  revision: number;
  status: KoedServerStatus | null;
};

export class DesktopStatusStore {
  readonly #listeners = new Set<() => void>();
  #snapshot: StatusSnapshot = {
    busyCommand: null,
    error: null,
    revision: 0,
    status: null
  };
  #refresh: Promise<KoedServerStatus | null> | null = null;

  current = (): StatusSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async refresh(): Promise<KoedServerStatus | null> {
    if (this.#refresh) return this.#refresh;
    this.#refresh = this.#runRefresh();
    try {
      return await this.#refresh;
    } finally {
      this.#refresh = null;
    }
  }

  async run<Result>(
    command: DesktopCommand,
    args?: Record<string, unknown>
  ): Promise<Result> {
    if (this.#snapshot.busyCommand) {
      throw new DesktopCommandError(
        command,
        `${this.#snapshot.busyCommand} is already running.`
      );
    }
    this.#replace({ ...this.#snapshot, busyCommand: command, error: null });
    try {
      const result = await invokeDesktop<Result>(command, args);
      if (
        command !== "open_external" &&
        command !== "reveal_local_project" &&
        command !== "open_logs"
      ) {
        await this.refresh();
      }
      return result;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.#replace({ ...this.#snapshot, error: message });
      throw cause;
    } finally {
      this.#replace({ ...this.#snapshot, busyCommand: null });
    }
  }

  async #runRefresh(): Promise<KoedServerStatus | null> {
    try {
      const status = await invokeDesktop<KoedServerStatus>("status");
      this.#replace({
        busyCommand: this.#snapshot.busyCommand,
        error: null,
        revision: this.#snapshot.revision + 1,
        status
      });
      return status;
    } catch (cause) {
      this.#replace({
        ...this.#snapshot,
        error: cause instanceof Error ? cause.message : String(cause)
      });
      return null;
    }
  }

  #replace(snapshot: StatusSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}
