import type { PreparedCollaborationRemoval } from "../../../collaboration/renderer-client.js";

export type RemovalTarget = {
  name: string;
  place: string;
  pendingMessage?: string;
  doneMessage?: string;
  prepare(): Promise<PreparedCollaborationRemoval>;
  reconcile(): Promise<void>;
};

export type RemovalResult = {
  name: string;
  state: "done" | "failed" | "not attempted";
  reason?: string;
};

export type RemovalState = Readonly<{
  phase: "idle" | "reviewing" | "pending" | "sending" | "complete";
  message: string;
  index: number;
  total: number;
  results: readonly RemovalResult[];
}>;

/** No timer or grant survives the renderer, identity, or backend boundary. */
export class RemovalCoordinator {
  readonly #listeners = new Set<() => void>();
  #state: RemovalState = {
    phase: "idle",
    message: "",
    index: 0,
    total: 0,
    results: []
  };
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #resolveWindow: ((send: boolean) => void) | null = null;
  #lastTargets: readonly RemovalTarget[] = [];

  current = () => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #publish(state: RemovalState) {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
  cancel() {
    this.#generation++;
    this.#lastTargets = [];
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#resolveWindow?.(false);
    this.#resolveWindow = null;
    this.#publish({
      phase: "idle",
      message: "",
      index: 0,
      total: 0,
      results: []
    });
  }
  undo() {
    if (this.#state.phase !== "pending") return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#resolveWindow?.(false);
    this.#resolveWindow = null;
  }
  retryExpired() {
    if (this.#state.phase !== "complete") return;
    const expired = this.#lastTargets.filter((_, index) =>
      this.#state.results[index]?.reason?.startsWith("Approval expired.")
    );
    if (expired.length) void this.start(expired);
  }
  async start(targets: readonly RemovalTarget[]): Promise<void> {
    if (
      this.#state.phase === "reviewing" ||
      this.#state.phase === "pending" ||
      this.#state.phase === "sending"
    )
      return;
    const generation = ++this.#generation;
    this.#lastTargets = targets;
    const results: RemovalResult[] = [];
    for (const [position, target] of targets.entries()) {
      if (generation !== this.#generation) return;
      const index = position + 1;
      this.#publish({
        phase: "reviewing",
        message: `Reviewing ${target.name} · ${index} of ${targets.length}`,
        index,
        total: targets.length,
        results: [...results]
      });
      try {
        const approved = await target.prepare();
        if (generation !== this.#generation) return;
        this.#publish({
          phase: "pending",
          message:
            target.pendingMessage ??
            `Removing ${target.name} from ${target.place}…`,
          index,
          total: targets.length,
          results: [...results]
        });
        const send = await new Promise<boolean>((resolve) => {
          this.#resolveWindow = resolve;
          this.#timer = setTimeout(() => {
            this.#timer = null;
            this.#resolveWindow = null;
            resolve(true);
          }, 5_000);
        });
        if (generation !== this.#generation) return;
        if (!send) {
          results.push({
            name: target.name,
            state: "not attempted",
            reason: "Undone"
          });
          try {
            await target.reconcile();
          } catch {
            /* Cancellation needs no server state change. */
          }
          continue;
        }
        if (
          !Number.isFinite(Date.parse(approved.expiresAt)) ||
          Date.parse(approved.expiresAt) <= Date.now()
        )
          throw new Error(`Approval expired. ${target.name} still has access.`);
        this.#publish({
          phase: "sending",
          message:
            target.pendingMessage ??
            `Removing ${target.name} from ${target.place}…`,
          index,
          total: targets.length,
          results: [...results]
        });
        await approved.execute();
        results.push({ name: target.name, state: "done" });
        try {
          await target.reconcile();
        } catch {
          /* The confirmed receipt remains authoritative. */
        }
      } catch (cause) {
        if (generation !== this.#generation) return;
        const reason =
          cause instanceof Error
            ? cause.message
            : "Outcome unknown. Refresh sharing.";
        results.push({
          name: target.name,
          state: "failed",
          reason: reason.startsWith("Approval expired.")
            ? `Approval expired. ${target.name} still has access.`
            : reason
        });
        try {
          await target.reconcile();
        } catch {
          /* Preserve the unknown outcome. */
        }
      }
    }
    if (generation !== this.#generation) return;
    const last = results.at(-1);
    this.#publish({
      phase: "complete",
      message:
        targets.length === 1 && last?.state === "done"
          ? (targets[0]?.doneMessage ?? `${last.name} no longer has access`)
          : results
              .map(
                (item) =>
                  `${item.name}: ${item.state}${item.reason ? ` (${item.reason})` : ""}`
              )
              .join(" · "),
      index: targets.length,
      total: targets.length,
      results
    });
  }
}
