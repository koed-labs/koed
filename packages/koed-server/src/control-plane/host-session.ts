import { dispatchControlRequest } from "./dispatch.js";
import type { AuthenticatedControlPeer } from "./handshake.js";
import type { HostCore } from "./host-core.js";
import type { ControlConnection } from "./transport.js";

const maxPending = 64;

/** A session must be passed an already authenticated native connection. */
export function serveControlConnection(options: {
  connection: ControlConnection;
  core: HostCore;
  validateHello(
    value: unknown,
    peer: AuthenticatedControlPeer
  ): unknown | Promise<unknown>;
}): () => void {
  const { connection, core, validateHello } = options;
  let closed = false;
  let initialized = false;
  let pending = 0;
  let queue = Promise.resolve();
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(helloDeadline);
    connection.close();
  };
  const helloDeadline = setTimeout(close, 10_000);
  const unsubscribeClose = connection.onClose(() => {
    closed = true;
    clearTimeout(helloDeadline);
  });
  const unsubscribeEnd = connection.onEnd(() => {
    void queue.then(close);
  });
  const unsubscribeMessage = connection.onMessage((message) => {
    if (closed) return;
    if (++pending > maxPending) {
      close();
      return;
    }
    queue = queue
      .then(async () => {
        if (closed) return;
        const value: unknown = JSON.parse(message);
        if (!initialized) {
          const serverHello = await validateHello(value, connection.peer);
          if (closed) return;
          initialized = true;
          clearTimeout(helloDeadline);
          await connection.send(JSON.stringify(serverHello));
        } else {
          await connection.send(
            JSON.stringify(dispatchControlRequest(core, value))
          );
        }
      })
      .catch(close)
      .finally(() => {
        pending--;
      });
  });
  return () => {
    unsubscribeMessage();
    unsubscribeClose();
    unsubscribeEnd();
    close();
  };
}
