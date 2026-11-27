import type { RuntimeLifecycleObservation } from "@koed-labs/server";
import {
  controlSnapshotSchema,
  type ControlSnapshot
} from "@koed-labs/shared/local-control-protocol";
import { createLifecycleObserver } from "./lifecycle-observer.js";

const unavailable = (message: string): RuntimeLifecycleObservation => ({
  state: "unavailable",
  epoch: "unavailable",
  message
});

const project = (snapshot: ControlSnapshot): RuntimeLifecycleObservation => {
  // A restart can reuse both the host and runtime bundle. Fence on revision
  // as well; intent-only revisions conservatively invalidate older reads.
  const epoch = `${snapshot.instanceId}:${snapshot.revision}`;
  switch (snapshot.state) {
    case "stopped":
      return { state: "stopped", epoch, message: "Koed is not running." };
    case "ready":
      return { state: "running", epoch, message: "Koed is running." };
    case "starting":
      return { state: "starting", epoch, message: "Koed is starting." };
    case "stopping":
      return { state: "unavailable", epoch, message: "Koed is stopping." };
    case "needs_attention":
      return {
        state: "unavailable",
        epoch,
        message: snapshot.error || "Koed needs attention."
      };
  }
};

export const createDetachedLifecycle = ({
  readStatus,
  onSnapshot
}: {
  readStatus: (timeout: number) => Promise<unknown>;
  onSnapshot: (snapshot: ControlSnapshot) => void;
}) => {
  const unreadable = () =>
    unavailable("Koed control-plane status could not be read.");
  let latest = unreadable();
  const observer = createLifecycleObserver({ observe: () => latest });
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending:
    | Promise<{
        observation: RuntimeLifecycleObservation;
        snapshot?: ControlSnapshot;
      }>
    | undefined;
  const sample = async (timeout: number) => {
    try {
      const reply = await readStatus(timeout);
      if (
        reply &&
        typeof reply === "object" &&
        "ok" in reply &&
        reply.ok === true &&
        "snapshot" in reply
      ) {
        const parsed = controlSnapshotSchema.safeParse(reply.snapshot);
        if (parsed.success) {
          onSnapshot(parsed.data);
          latest = project(parsed.data);
          return { observation: observer.refresh(), snapshot: parsed.data };
        }
      }
    } catch {
      // Unreachable, unauthenticated, and malformed replies cannot establish Stopped.
    }
    latest = unreadable();
    return { observation: observer.refresh() };
  };
  const probe = (timeout = 5_000) =>
    (pending ??= sample(timeout).finally(() => {
      pending = undefined;
    }));
  const refresh = async () => (await probe()).observation;
  return {
    ...observer,
    probe,
    refresh,
    start: () => {
      if (timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), 2_000);
      timer.unref();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    }
  };
};
