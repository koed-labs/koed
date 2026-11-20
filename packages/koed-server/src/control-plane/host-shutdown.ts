import type { HostCore } from "./host-core.js";

/**
 * Drives a requested control-plane shutdown to a process exit code.
 *
 * `stopped` closes the host and exits cleanly. `needs_attention` never confirms
 * cleanup, but once no runtime session remains the process must still exit, or
 * SIGTERM would leave an unreachable plane running indefinitely. The persisted
 * unclean marker and the OS-released admission let the next owner recover through
 * dead-owner recovery, which reports needs_attention rather than assuming Stop.
 */
export function createControlPlaneShutdown(input: {
  core: HostCore;
  close(): Promise<void>;
  closeUncertain(): Promise<void>;
  fatal(): Error | undefined;
  log(message: string): void;
  pollMs?: number;
}): { request(): void; done: Promise<number> } {
  let requested = false;
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  const finish = (code: number): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
    resolveDone(code);
  };
  const poll = (): void => {
    if (!input.core.settled()) return;
    let uncertain: boolean;
    try {
      const { state } = input.core.status();
      uncertain = state === "needs_attention";
      if (state !== "stopped" && !uncertain) return;
    } catch (error) {
      uncertain = true;
      input.log(
        `Control-plane status could not be confirmed: ${String(error)}\n`
      );
    }
    if (timer) clearInterval(timer);
    timer = undefined;
    if (uncertain)
      input.log(
        "Control-plane cleanup is uncertain; exiting without confirming Stop. Operator attention required.\n"
      );
    void Promise.resolve()
      .then(() => (uncertain ? input.closeUncertain() : input.close()))
      .then(
        () => finish(uncertain || input.fatal() ? 1 : 0),
        (error: unknown) => {
          input.log(`Control-plane shutdown failed: ${String(error)}\n`);
          finish(1);
        }
      );
  };
  return {
    done,
    request() {
      if (requested) return;
      requested = true;
      try {
        input.core.stop(false);
      } catch (error) {
        input.log(`Control-plane stop failed: ${String(error)}\n`);
      }
      timer = setInterval(poll, input.pollMs ?? 250);
      poll();
    }
  };
}
