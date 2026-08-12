import type { KoedServerManager } from "../koed-server/manager.js";
import type { PdsSecretBridge } from "../pds-secret-bridge.js";

export interface DesktopQuitCoordinatorOptions {
  readonly getKoedServer: () => Pick<KoedServerManager, "stop"> | null;
  readonly getPdsSecretBridge: () => Pick<PdsSecretBridge, "close"> | null;
  readonly onNormalQuitError?: () => void;
  readonly shutdownTimeoutMs?: number;
}

/**
 * Owns the only service shutdown path used by normal quits and updater
 * installation. The promise is intentionally retained so repeated or
 * concurrent quit requests can never invoke a service twice.
 */
export class DesktopQuitCoordinator {
  private readonly getKoedServer: DesktopQuitCoordinatorOptions["getKoedServer"];
  private readonly getPdsSecretBridge: DesktopQuitCoordinatorOptions["getPdsSecretBridge"];
  private readonly onNormalQuitError: () => void;
  private readonly shutdownTimeoutMs: number;
  private shutdownPromise: Promise<void> | null = null;
  private serverStopCompleted = false;
  private bridgeCloseCompleted = false;
  private serverStopInFlight: Promise<unknown> | null = null;
  private bridgeCloseInFlight: Promise<unknown> | null = null;
  private readonly runtimeResumes = new Set<Promise<void>>();
  private readonly startupTasks = new Set<Promise<unknown>>();
  private startupCanceled = false;
  private normalQuitInFlight = false;
  private normalQuitAllowed = false;
  private updaterQuitAllowed = false;
  private disposed = false;

  constructor(options: DesktopQuitCoordinatorOptions) {
    this.getKoedServer = options.getKoedServer;
    this.getPdsSecretBridge = options.getPdsSecretBridge;
    this.onNormalQuitError = options.onNormalQuitError ?? (() => undefined);
    this.shutdownTimeoutMs = Math.max(1, options.shutdownTimeoutMs ?? 10_000);
  }

  get canStartStartup(): boolean {
    return !this.disposed && !this.startupCanceled;
  }

  cancelStartup(): void {
    this.startupCanceled = true;
  }

  beginRuntimeResume(resume: Promise<unknown>): () => void {
    const settled = resume.then(
      () => undefined,
      () => undefined
    );
    this.runtimeResumes.add(settled);
    return () => this.runtimeResumes.delete(settled);
  }

  trackStartupTask<T>(task: Promise<T>): Promise<T> {
    this.startupTasks.add(task);
    return task;
  }

  completeStartupTask(task: Promise<unknown>): void {
    this.startupTasks.delete(task);
  }

  /**
   * Stop the Koed-owned services exactly once, preserving their required
   * ordering. A bridge close is attempted even if the server stop rejects.
   */
  shutdownServices(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.disposed) {
      return Promise.reject(new Error("Desktop quit coordinator is disposed."));
    }

    this.cancelStartup();
    const operation = this.runShutdown();
    this.shutdownPromise = operation;
    void operation.catch(() => {
      if (this.shutdownPromise === operation) this.shutdownPromise = null;
    });
    return operation;
  }

  /**
   * Prepare a user-approved updater installation. The updater quit guard is
   * set only after both owned services have stopped successfully.
   */
  async prepareForInstall(): Promise<void> {
    await this.shutdownServices();
    this.updaterQuitAllowed = true;
  }

  /**
   * Handle Electron's before-quit event. Normal quits wait for service
   * shutdown once, then allow Electron to continue even if a service failed;
   * updater installation is fail-closed through prepareForInstall().
   */
  handleBeforeQuit(preventDefault: () => void, requestQuit: () => void): void {
    if (this.disposed || this.updaterQuitAllowed || this.normalQuitAllowed) {
      return;
    }

    preventDefault();
    if (this.normalQuitInFlight) return;
    this.normalQuitInFlight = true;

    void this.shutdownServices()
      .catch(() => {
        this.onNormalQuitError();
      })
      .finally(() => {
        this.normalQuitAllowed = true;
        requestQuit();
      });
  }

  dispose(): void {
    this.disposed = true;
    this.normalQuitAllowed = false;
    this.updaterQuitAllowed = false;
  }

  get isUpdaterQuitAllowed(): boolean {
    return this.updaterQuitAllowed;
  }

  private async runShutdown(): Promise<void> {
    let firstError: unknown;
    let serverStop = this.startServerStop();
    const pendingTasks = [...this.runtimeResumes, ...this.startupTasks];
    if (pendingTasks.length > 0) {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(
          () => resolve("timeout"),
          this.shutdownTimeoutMs
        );
      });
      try {
        const settled = await Promise.race([
          Promise.allSettled(pendingTasks).then(() => "settled" as const),
          timeout
        ]);
        if (settled === "timeout") {
          firstError = new Error("Desktop runtime resume did not settle.");
        }
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    }

    if (!serverStop && !this.serverStopCompleted) {
      serverStop = this.startServerStop();
      if (!serverStop && !this.getKoedServer()) {
        this.serverStopCompleted = true;
      }
    }

    if (!this.serverStopCompleted && serverStop) {
      try {
        await this.awaitBounded(serverStop, "Koed Server stop");
        this.serverStopCompleted = true;
      } catch (error) {
        firstError ??= error;
      }
    }

    const bridgeClose = this.startBridgeClose();
    if (!this.bridgeCloseCompleted && bridgeClose) {
      try {
        await this.awaitBounded(bridgeClose, "PDS secret bridge close");
        this.bridgeCloseCompleted = true;
      } catch (error) {
        firstError ??= error;
      }
    }

    if (firstError) throw firstError;
  }

  private startServerStop(): Promise<unknown> | null {
    if (this.serverStopCompleted) return null;
    if (this.serverStopInFlight) return this.serverStopInFlight;
    const server = this.getKoedServer();
    if (!server) return null;
    const operation = server.stop();
    this.serverStopInFlight = operation;
    void operation.then(
      () => {
        if (this.serverStopInFlight === operation) {
          this.serverStopCompleted = true;
          this.serverStopInFlight = null;
        }
      },
      () => {
        if (this.serverStopInFlight === operation)
          this.serverStopInFlight = null;
      }
    );
    return operation;
  }

  private startBridgeClose(): Promise<unknown> | null {
    if (this.bridgeCloseCompleted) return null;
    if (this.bridgeCloseInFlight) return this.bridgeCloseInFlight;
    const bridge = this.getPdsSecretBridge();
    if (!bridge) {
      this.bridgeCloseCompleted = true;
      return null;
    }
    const operation = bridge.close();
    this.bridgeCloseInFlight = operation;
    void operation.then(
      () => {
        if (this.bridgeCloseInFlight === operation) {
          this.bridgeCloseCompleted = true;
          this.bridgeCloseInFlight = null;
        }
      },
      () => {
        if (this.bridgeCloseInFlight === operation)
          this.bridgeCloseInFlight = null;
      }
    );
    return operation;
  }

  private async awaitBounded<T>(task: Promise<T>, label: string): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`${label} did not settle.`)),
        this.shutdownTimeoutMs
      );
    });
    try {
      return await Promise.race([task, timeout]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
}

export const createDesktopQuitCoordinator = (
  options: DesktopQuitCoordinatorOptions
): DesktopQuitCoordinator => new DesktopQuitCoordinator(options);
