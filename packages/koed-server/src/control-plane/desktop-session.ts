import type { ControlClient } from "./client.js";

export interface DesktopSessionChannel {
  connected: boolean;
  send(message: unknown): void;
  onMessage(listener: (value: unknown) => void): () => void;
  onDisconnect(listener: () => void): () => void;
}

/** The authenticated connection itself represents Desktop's availability demand. */
export function serveDesktopSession(
  client: ControlClient,
  channel: DesktopSessionChannel
): Promise<number> {
  return new Promise((resolve) => {
    let finished = false;
    let attached = false;
    let detaching = false;
    let unsubscribeMessage = () => {};
    let unsubscribeDisconnect = () => {};
    let unsubscribeClose = () => {};
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      unsubscribeMessage();
      unsubscribeDisconnect();
      unsubscribeClose();
      client.close();
      resolve(code);
    };
    const detach = async () => {
      if (finished || detaching || !attached) return;
      detaching = true;
      try {
        const status = await client.request({ action: "status" }, 0);
        if (!status.ok)
          throw new Error(`Desktop status failed: ${status.code}`);
        const result = await client.request(
          { action: "detach", reason: "desktop-session", intentional: true },
          status.snapshot.revision
        );
        if (!result.ok)
          throw new Error(`Desktop detach failed: ${result.code}`);
        if (!finished) channel.send({ type: "detached", ok: true });
        finish(0);
      } catch (failure) {
        if (!finished) {
          try {
            channel.send({
              type: "detached",
              ok: false,
              error:
                failure instanceof Error ? failure.message : String(failure)
            });
          } catch {
            /* Parent disconnect will also close the session. */
          }
        }
        finish(1);
      }
    };
    unsubscribeMessage = channel.onMessage((value) => {
      if (
        value &&
        typeof value === "object" &&
        "type" in value &&
        value.type === "detach"
      )
        void detach();
    });
    unsubscribeDisconnect = channel.onDisconnect(() => finish(0));
    unsubscribeClose = client.onClose?.(() => finish(1)) ?? (() => {});
    if (finished) return;
    if (!channel.connected) {
      finish(1);
      return;
    }
    void (async () => {
      try {
        const status = await client.request({ action: "status" }, 0);
        if (!status.ok)
          throw new Error(`Desktop status failed: ${status.code}`);
        const result = await client.request(
          { action: "attach", reason: "desktop-session" },
          status.snapshot.revision
        );
        if (!result.ok)
          throw new Error(`Desktop attach failed: ${result.code}`);
        if (finished) return;
        attached = true;
        channel.send({ type: "ready" });
      } catch (failure) {
        if (!finished) {
          try {
            channel.send({
              type: "error",
              error:
                failure instanceof Error ? failure.message : String(failure)
            });
          } catch {
            /* Parent disconnect will also close the session. */
          }
        }
        finish(1);
      }
    })();
  });
}
