import type { ControlClient } from "./client.js";
import type { DesktopSessionChannel } from "./desktop-session.js";

function statusRequestId(value: unknown): number | undefined {
  if (
    value &&
    typeof value === "object" &&
    Object.keys(value).length === 2 &&
    "type" in value &&
    value.type === "status" &&
    "requestId" in value &&
    typeof value.requestId === "number" &&
    Number.isSafeInteger(value.requestId) &&
    value.requestId > 0
  )
    return value.requestId;
  return undefined;
}

function existingConnection(openExistingClient: () => Promise<ControlClient>) {
  let closed = false;
  let client: ControlClient | undefined;
  let unsubscribe = () => {};
  const forget = () => {
    client = undefined;
    unsubscribe();
    unsubscribe = () => {};
  };
  const reset = () => {
    const previous = client;
    forget();
    previous?.close();
  };
  return {
    async get() {
      if (closed) return undefined;
      if (client) return client;
      const opened = await openExistingClient();
      if (closed) {
        opened.close();
        return undefined;
      }
      client = opened;
      const unsubscribeClose = opened.onClose?.(forget);
      if (unsubscribeClose) {
        if (client === opened) unsubscribe = unsubscribeClose;
        else unsubscribeClose();
      }
      return client;
    },
    reset,
    close() {
      closed = true;
      reset();
    }
  };
}

/** Serve status only. The opener must authenticate and never launch a host. */
export function serveDesktopStatus(
  openExistingClient: () => Promise<ControlClient>,
  channel: DesktopSessionChannel
): Promise<number> {
  if (!channel.connected) return Promise.resolve(1);
  return new Promise((resolve) => {
    const connection = existingConnection(openExistingClient);
    let finished = false;
    let busy = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      unsubscribeMessage();
      unsubscribeDisconnect();
      connection.close();
      resolve(code);
    };
    const respond = async (requestId: number) => {
      const envelope = { type: "status-result", requestId };
      try {
        const client = await connection.get();
        if (finished) return;
        const reply = await client?.request({ action: "status" }, 0);
        return reply?.ok
          ? { ...envelope, ok: true, snapshot: reply.snapshot }
          : { ...envelope, ok: false };
      } catch {
        connection.reset();
        return { ...envelope, ok: false };
      }
    };
    const send = (message: unknown) => {
      try {
        channel.send(message);
      } catch {
        finish(1);
      }
    };
    const unsubscribeMessage = channel.onMessage((value) => {
      const requestId = statusRequestId(value);
      if (finished || busy || requestId === undefined) return;
      busy = true;
      void respond(requestId).then((reply) => {
        busy = false;
        if (!finished && reply) send(reply);
      });
    });
    const unsubscribeDisconnect = channel.onDisconnect(() => finish(0));
    if (channel.connected) send({ type: "status-ready" });
    else finish(0);
  });
}
