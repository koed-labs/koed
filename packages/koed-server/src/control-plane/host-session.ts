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
  let desktop: ReturnType<HostCore["openDesktopSession"]> | undefined;
  const releaseDesktop = (intentional: boolean) => {
    const session = desktop;
    session?.close(intentional);
    desktop = undefined;
  };
  const desktopActions = {
    attach() {
      if (desktop) throw new Error("Desktop session already attached");
      desktop = core.openDesktopSession();
    },
    detach(intentional: boolean) {
      if (!desktop) throw new Error("Desktop session is not attached");
      releaseDesktop(intentional);
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(helloDeadline);
    releaseDesktop(false);
    connection.close();
  };
  const helloDeadline = setTimeout(close, 10_000);
  const unsubscribeClose = connection.onClose(() => {
    closed = true;
    clearTimeout(helloDeadline);
    releaseDesktop(false);
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
            JSON.stringify(dispatchControlRequest(core, value, desktopActions))
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
