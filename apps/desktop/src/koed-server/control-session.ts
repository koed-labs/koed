import type { ChildProcess } from "node:child_process";

export interface DesktopControlSession {
  detach(): Promise<{ ok: boolean; error?: string }>;
  isConnected(): boolean;
  onClose?(listener: () => void): void;
}

/** Owns only a client connection; the detached control plane owns the runtime. */
export function openDesktopControlSession(
  spawnSession: () => ChildProcess
): Promise<DesktopControlSession> {
  return new Promise((resolve, reject) => {
    const child = spawnSession();
    let settled = false;
    let closed = false;
    let closeListener: (() => void) | undefined;
    const markClosed = () => {
      if (closed) return;
      closed = true;
      if (settled) closeListener?.();
      else
        fail(
          new Error("Desktop control session disconnected before attaching")
        );
    };
    child.once("disconnect", markClosed);
    child.once("exit", markClosed);
    const timeout = setTimeout(
      () => fail(new Error("Desktop control session did not attach")),
      120_000
    );
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      reject(error);
    };
    child.once("error", fail);
    child.once("exit", () =>
      fail(new Error("Desktop control session exited before attaching"))
    );
    child.on("message", (value: unknown) => {
      if (settled || !value || typeof value !== "object" || !("type" in value))
        return;
      if (value.type === "error") {
        fail(
          new Error(
            "error" in value && typeof value.error === "string"
              ? value.error
              : "Desktop control session failed to attach"
          )
        );
        return;
      }
      if (value.type !== "ready") return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        isConnected: () => !closed && child.connected,
        onClose(listener) {
          closeListener = listener;
          if (closed) listener();
        },
        detach: () => detach(child)
      });
    });
  });
}

function detach(child: ChildProcess): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!child.connected || !child.send) {
      resolve({ ok: false, error: "Desktop control session disconnected" });
      return;
    }
    let settled = false;
    const finish = (result: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("disconnect", onExit);
      if (!result.ok) child.kill();
      resolve(result);
    };
    const onMessage = (value: unknown) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("type" in value) ||
        value.type !== "detached"
      )
        return;
      finish(
        "ok" in value && value.ok === true
          ? { ok: true }
          : {
              ok: false,
              error:
                "error" in value && typeof value.error === "string"
                  ? value.error
                  : "Desktop control session could not detach"
            }
      );
    };
    const onExit = () =>
      finish({
        ok: false,
        error: "Desktop control session exited before detaching"
      });
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: "Desktop control session detach timed out" });
    }, 10_000);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("disconnect", onExit);
    try {
      child.send({ type: "detach" }, (error) => {
        if (error) finish({ ok: false, error: error.message });
      });
    } catch (error) {
      finish({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}
