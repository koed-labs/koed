import { realpathSync } from "node:fs";
import {
  controlHelloSchema,
  LOCAL_CONTROL_PROTOCOL_VERSION
} from "@koed-labs/shared/local-control-protocol";
import type { KoedServerPaths } from "../paths.js";
import { resolveProcessIdentity } from "../supervisor-lock.js";
import {
  assertControlPlaneAdmission,
  type ControlPlaneAdmission
} from "./admission.js";
import {
  publishControlDiscovery,
  removeControlDiscovery
} from "./discovery.js";
import { validateControlHello } from "./handshake.js";
import { serveControlConnection } from "./host-session.js";
import type { HostCore } from "./host-core.js";
import type { ControlTransport } from "./transport.js";

export class ControlHostCleanupError extends AggregateError {
  constructor(startError: unknown, cleanupError: unknown) {
    super([startError, cleanupError], "Control listener cleanup is uncertain");
  }
}

export async function startControlPlaneHost(input: {
  paths: KoedServerPaths;
  admission: ControlPlaneAdmission;
  core: HostCore;
  transport: ControlTransport;
  socketPath: string;
  installationId: string;
  productVersion: string;
  onFatal(error: Error): void;
}): Promise<{ close(): Promise<void> }> {
  const owner = assertControlPlaneAdmission(input.admission, input.paths);
  if (!owner.processIdentity)
    throw new Error("Control-plane process identity unavailable");
  const home = realpathSync(input.paths.koedHome);
  const record = {
    schemaVersion: 1 as const,
    home,
    instanceId: input.admission.instanceId,
    installationId: input.installationId,
    productVersion: input.productVersion,
    socketPath: input.socketPath,
    pid: owner.pid,
    processIdentity: owner.processIdentity
  };
  let active = false;
  const listener = await input.transport.listen(
    input.socketPath,
    (connection) => {
      if (!active) {
        connection.close();
        return;
      }
      serveControlConnection({
        connection,
        core: input.core,
        validateHello(value, peer) {
          const hello = controlHelloSchema.parse(value);
          const identity = resolveProcessIdentity(peer.pid);
          if (!identity) throw new Error("Control peer identity unavailable");
          validateControlHello(
            hello,
            {
              home,
              installationId: record.installationId,
              productVersion: record.productVersion,
              instanceId: record.instanceId,
              pid: peer.pid,
              processIdentity: identity,
              nonce: hello.nonce
            },
            peer
          );
          return {
            protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
            home,
            installationId: record.installationId,
            productVersion: record.productVersion,
            instanceId: record.instanceId,
            pid: owner.pid,
            processIdentity: owner.processIdentity,
            nonce: hello.nonce
          };
        }
      });
    }
  );
  listener.onError((error) => {
    active = false;
    try {
      input.core.stop(false);
      input.onFatal(error);
    } catch (failure) {
      input.onFatal(
        new AggregateError(
          [error, failure],
          "Control listener failed and runtime stop failed"
        )
      );
    }
  });
  try {
    publishControlDiscovery(input.paths, input.admission, record);
    active = true;
  } catch (error) {
    try {
      await listener.close();
    } catch (cleanupError) {
      throw new ControlHostCleanupError(error, cleanupError);
    }
    throw error;
  }
  return {
    async close() {
      if (input.core.status().state !== "stopped")
        throw new Error("Control-plane runtime is not stopped");
      active = false;
      try {
        removeControlDiscovery(input.paths, input.admission, record.instanceId);
      } finally {
        await listener.close();
      }
    }
  };
}
